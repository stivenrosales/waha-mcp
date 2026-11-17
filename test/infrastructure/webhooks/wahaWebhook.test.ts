import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Tenant, TenantStatus } from "../../../src/domain/ports/TenantStore.js";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import type { TenantCipher } from "../../../src/infrastructure/crypto/envelope.js";
import { createSqliteEventStore } from "../../../src/infrastructure/missions/sqliteEventStore.js";
import {
  configureTenantWebhooks,
  createWahaWebhookRoute,
  WEBHOOK_PATH,
} from "../../../src/infrastructure/webhooks/wahaWebhook.js";
import { FakeSessionAdmin } from "../../fakes/FakeSessionAdmin.js";
import { testCipher } from "../../fakes/testCipher.js";

const SECRET = "whsec-very-secret-value";
const NOW = 1_794_925_889_000;
const MINUTE = 60_000;

const tenant = (id: string, session: string, status: TenantStatus = "active"): Tenant => ({
  id,
  wahaSession: session,
  displayName: id,
  status,
  waId: null,
  createdAt: 0,
});

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_01JX0000000000000000000001",
    timestamp: NOW,
    event: "message.any",
    session: "t_alice",
    metadata: { tenant: "t1" },
    me: { id: "51900000001@c.us", pushName: "Alice" },
    payload: {
      id: "false_51900000002@c.us_3EB0AAAA",
      timestamp: NOW / 1000,
      from: "51900000002@c.us",
      fromMe: false,
      source: "app",
      body: "hola secreto",
      hasMedia: false,
      _data: { Info: { Chat: "51900000002@c.us" }, Message: { conversation: "hola secreto" } },
    },
    engine: "GOWS",
    ...over,
  };
}

const sign = (body: string, key = SECRET) => createHmac("sha512", key).update(body).digest("hex");

function setup(opts: { maxBodyBytes?: number; onEvent?: () => void | Promise<void> } = {}) {
  const tenants = [tenant("t1", "t_alice"), tenant("t2", "t_bob", "revoked")];
  const ciphers: Record<string, TenantCipher> = { t1: testCipher("t1"), t2: testCipher("t2") };
  const db = openAuthDatabase(":memory:");
  const events = createSqliteEventStore(db);
  const logs: string[] = [];
  const woken: { tenantId: string; kind: string }[] = [];
  let held = 0;
  const route = createWahaWebhookRoute({
    secret: SECRET,
    tenants: {
      getTenantBySession: (s) => tenants.find((t) => t.wahaSession === s) ?? null,
    },
    registry: {
      acquire(tenantId) {
        const t = tenants.find((x) => x.id === tenantId);
        const cipher = ciphers[tenantId];
        if (t?.status !== "active" || !cipher) return null;
        held += 1;
        return {
          runtime: { cipher },
          release: () => {
            held -= 1;
          },
        };
      },
    },
    events,
    logger: { info: (m) => void logs.push(m) },
    onEvent:
      opts.onEvent ??
      ((e) => {
        woken.push(e);
      }),
    now: () => NOW,
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  });
  const post = (body: string, headers: Record<string, string | null> = {}) => {
    const h: Record<string, string> = { "content-type": "application/json" };
    const signature = "x-webhook-hmac" in headers ? headers["x-webhook-hmac"] : sign(body);
    if (signature) h["x-webhook-hmac"] = signature;
    h["x-webhook-hmac-algorithm"] = "sha512";
    return route.request(WEBHOOK_PATH, { method: "POST", headers: h, body });
  };
  const send = (env: Record<string, unknown>) => post(JSON.stringify(env));
  return {
    db,
    events,
    logs,
    woken,
    ciphers,
    post,
    send,
    held: () => held,
    stored: () => events.pending(100),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("WAHA webhook route", () => {
  it("answers 401 and stores nothing for a missing or bad signature", async () => {
    const ctx = setup();
    const body = JSON.stringify(envelope());
    const missing = await ctx.post(body, { "x-webhook-hmac": null });
    expect(missing.status).toBe(401);
    const wrongKey = await ctx.post(body, { "x-webhook-hmac": sign(body, "other-secret") });
    expect(wrongKey.status).toBe(401);
    const otherBody = await ctx.post(body, { "x-webhook-hmac": sign(`${body} `) });
    expect(otherBody.status).toBe(401);
    const short = await ctx.post(body, { "x-webhook-hmac": "abcd" });
    expect(short.status).toBe(401);
    expect(ctx.stored()).toHaveLength(0);
    expect(ctx.woken).toHaveLength(0);
  });

  it("stores a valid message event sealed for its tenant, answers 200 and wakes the engine", async () => {
    const ctx = setup();
    const body = JSON.stringify(envelope());
    const res = await ctx.post(body);
    expect(res.status).toBe(200);
    const [row, ...rest] = ctx.stored();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      tenantId: "t1",
      eventId: "evt_01JX0000000000000000000001",
      kind: "message",
      receivedAt: new Date(NOW).toISOString(),
    });
    // Sealed at rest: the stored text never holds the message, and only this AAD opens it.
    expect(row?.payloadSealed).not.toContain("hola");
    const opened = ctx.ciphers.t1?.openText(
      row?.payloadSealed as string,
      "webhook:t1:evt_01JX0000000000000000000001",
    );
    expect(opened).toBe(body);
    expect(() =>
      ctx.ciphers.t1?.openText(row?.payloadSealed as string, "webhook:t1:evt_other"),
    ).toThrow();
    await flush();
    expect(ctx.woken).toEqual([{ tenantId: "t1", kind: "message" }]);
    expect(ctx.held()).toBe(0);
  });

  it("stores the same event once and wakes the engine once", async () => {
    const ctx = setup();
    const body = JSON.stringify(envelope());
    expect((await ctx.post(body)).status).toBe(200);
    expect((await ctx.post(body)).status).toBe(200);
    expect(ctx.stored()).toHaveLength(1);
    await flush();
    expect(ctx.woken).toHaveLength(1);
  });

  it("stores session.status events with their own kind", async () => {
    const ctx = setup();
    const res = await ctx.send(
      envelope({
        id: "evt_status",
        event: "session.status",
        payload: { name: "t_alice", status: "WORKING", statuses: [] },
      }),
    );
    expect(res.status).toBe(200);
    expect(ctx.stored().map((e) => e.kind)).toEqual(["session.status"]);
  });

  it("answers 200 and stores nothing for an unknown session, without telling it apart", async () => {
    const ctx = setup();
    const known = await ctx.send(envelope());
    const unknown = await ctx.send(envelope({ id: "evt_x", session: "t_nobody" }));
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe(await known.text());
    expect(ctx.stored().map((e) => e.eventId)).toEqual(["evt_01JX0000000000000000000001"]);
  });

  it("answers 200 and stores nothing for a tenant that is not active", async () => {
    const ctx = setup();
    const res = await ctx.send(envelope({ session: "t_bob", metadata: { tenant: "t2" } }));
    expect(res.status).toBe(200);
    expect(ctx.stored()).toHaveLength(0);
  });

  it("answers 200 and stores nothing for events missions do not use", async () => {
    const ctx = setup();
    for (const event of ["message", "message.ack", "message.reaction", "presence.update"]) {
      const res = await ctx.send(envelope({ id: `evt_${event}`, event }));
      expect(res.status).toBe(200);
    }
    expect(ctx.stored()).toHaveLength(0);
  });

  it("answers 200 and stores nothing when metadata.tenant names another tenant", async () => {
    const ctx = setup();
    const res = await ctx.send(envelope({ metadata: { tenant: "t2" } }));
    expect(res.status).toBe(200);
    expect(ctx.stored()).toHaveLength(0);
    // Without metadata (a session configured elsewhere) the session alone routes it.
    await ctx.send(envelope({ id: "evt_nometa", metadata: null }));
    expect(ctx.stored().map((e) => e.eventId)).toEqual(["evt_nometa"]);
  });

  it("answers 200 and stores nothing for stale, future or malformed envelopes", async () => {
    const ctx = setup();
    const cases = [
      envelope({ id: "evt_old", timestamp: NOW - 10 * MINUTE - 1 }),
      envelope({ id: "evt_future", timestamp: NOW + 2 * MINUTE + 1 }),
      envelope({ id: "evt_nots", timestamp: "soon" }),
      envelope({ id: "" }),
      envelope({ id: 42 }),
      envelope({ session: 7 }),
    ];
    for (const env of cases) expect((await ctx.send(env)).status).toBe(200);
    expect((await ctx.post("not json")).status).toBe(200);
    expect((await ctx.post("[]")).status).toBe(200);
    expect(ctx.stored()).toHaveLength(0);
    // The window edges are accepted.
    await ctx.send(envelope({ id: "evt_edge_old", timestamp: NOW - 10 * MINUTE }));
    await ctx.send(envelope({ id: "evt_edge_new", timestamp: NOW + 2 * MINUTE }));
    expect(ctx.stored().map((e) => e.eventId)).toEqual(["evt_edge_old", "evt_edge_new"]);
  });

  it("answers 413 and stores nothing for a body over the size limit", async () => {
    const ctx = setup({ maxBodyBytes: 2048 });
    const body = JSON.stringify(envelope({ padding: "x".repeat(4096) }));
    const res = await ctx.post(body);
    expect(res.status).toBe(413);
    expect(ctx.stored()).toHaveLength(0);
  });

  it("has a default size limit that fits media events but not megabytes", async () => {
    const ctx = setup();
    const media = JSON.stringify(envelope({ padding: "x".repeat(100_000) }));
    expect((await ctx.post(media)).status).toBe(200);
    const huge = JSON.stringify(envelope({ id: "evt_huge", padding: "x".repeat(300_000) }));
    expect((await ctx.post(huge)).status).toBe(413);
    expect(ctx.stored()).toHaveLength(1);
  });

  it("still answers 200 when the engine callback throws or rejects, logging no content", async () => {
    for (const onEvent of [
      () => {
        throw new Error("boom hola secreto");
      },
      () => Promise.reject(new Error("boom hola secreto")),
    ]) {
      const ctx = setup({ onEvent });
      const res = await ctx.send(envelope());
      expect(res.status).toBe(200);
      await flush();
      expect(ctx.stored()).toHaveLength(1);
      expect(ctx.logs.some((l) => l.includes("webhook") && l.includes("failed"))).toBe(true);
      for (const line of ctx.logs) {
        expect(line).not.toContain("hola");
        expect(line).not.toContain(SECRET);
      }
    }
  });

  it("never logs bodies, signatures or the secret", async () => {
    const ctx = setup();
    const body = JSON.stringify(envelope());
    await ctx.post(body, { "x-webhook-hmac": sign(body, "wrong") });
    await ctx.post(body);
    await ctx.send(envelope({ id: "evt_x", session: "t_nobody" }));
    for (const line of ctx.logs) {
      expect(line).not.toContain("hola");
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(sign(body));
    }
  });
});

describe("configureTenantWebhooks", () => {
  const target = { url: "https://mcp.example.com/webhooks/waha", secret: SECRET };

  it("configures every active tenant's session, one after another", async () => {
    const sessions = new FakeSessionAdmin();
    const logs: string[] = [];
    await configureTenantWebhooks({
      tenants: {
        listTenants: () => [
          tenant("t1", "t_a"),
          tenant("t2", "t_b", "pairing"),
          tenant("t3", "t_c", "revoked"),
          tenant("t4", "t_d", "invited"),
          tenant("t5", "t_e"),
        ],
      },
      sessions,
      target,
      logger: { info: (m) => void logs.push(m) },
    });
    expect(sessions.calls).toEqual(["configureWebhook:t_a", "configureWebhook:t_e"]);
    expect(sessions.webhooks.get("t_a")).toEqual(target);
    for (const line of logs) expect(line).not.toContain(SECRET);
  });

  it("logs a failing tenant and goes on with the rest, never throwing", async () => {
    const sessions = new FakeSessionAdmin();
    const order: string[] = [];
    vi.spyOn(sessions, "configureWebhook").mockImplementation(async (name) => {
      order.push(`begin:${name}`);
      await flush();
      order.push(`end:${name}`);
      if (name === "t_a") throw new Error(`WAHA said ${SECRET}`);
    });
    const logs: string[] = [];
    await expect(
      configureTenantWebhooks({
        tenants: { listTenants: () => [tenant("t1", "t_a"), tenant("t2", "t_b")] },
        sessions,
        target,
        logger: { info: (m) => void logs.push(m) },
      }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(["begin:t_a", "end:t_a", "begin:t_b", "end:t_b"]);
    expect(logs.some((l) => l.includes("tenant=t1") && l.includes("failed"))).toBe(true);
    for (const line of logs) expect(line).not.toContain(SECRET);
  });
});
