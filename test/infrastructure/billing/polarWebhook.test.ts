import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProvisionCapError } from "../../../src/application/polarSync.js";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createPolarClient } from "../../../src/infrastructure/billing/polarClient.js";
import { createPolarWebhookRoute } from "../../../src/infrastructure/billing/polarWebhook.js";
import { createSqlitePolarStore } from "../../../src/infrastructure/billing/sqlitePolarStore.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = 1_800_000_000_000;

function delivery(body: unknown, id = "msg_1", key = KEY) {
  const raw = JSON.stringify(body);
  const ts = String(NOW / 1000);
  const sig = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64")}`;
  return {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": sig,
      "content-type": "application/json",
    },
    body: raw,
  };
}

function setup(handle: (id: string) => Promise<void> = async () => {}) {
  const handled: string[] = [];
  const logs: string[] = [];
  const store = createSqlitePolarStore(openAuthDatabase(":memory:"));
  const app = createPolarWebhookRoute({
    secret: SECRET,
    store,
    sync: {
      handle: async (id) => {
        handled.push(id);
        await handle(id);
      },
    },
    logger: { info: (m) => void logs.push(m) },
    now: () => NOW,
  });
  return { app, handled, logs, store };
}

const event = (type: string, id = "sub_1") => ({
  type,
  timestamp: "2026-11-23T00:00:00Z",
  data: { id },
});

describe("POST /webhooks/polar", () => {
  it("handles a signed subscription event and answers 202", async () => {
    const s = setup();
    const res = await s.app.request("/webhooks/polar", delivery(event("subscription.active")));
    expect(res.status).toBe(202);
    expect(s.handled).toEqual(["sub_1"]);
    expect(s.store.isProcessed("msg_1")).toBe(true);
  });

  it("refuses a bad signature with 403 and handles nothing", async () => {
    const s = setup();
    const res = await s.app.request(
      "/webhooks/polar",
      delivery(event("subscription.active"), "msg_1", Buffer.from("x".repeat(32))),
    );
    expect(res.status).toBe(403);
    expect(s.handled).toEqual([]);
    expect(s.store.isProcessed("msg_1")).toBe(false);
  });

  it("handles a redelivered webhook-id only once", async () => {
    const s = setup();
    await s.app.request("/webhooks/polar", delivery(event("subscription.active")));
    const again = await s.app.request("/webhooks/polar", delivery(event("subscription.active")));
    expect(again.status).toBe(202);
    expect(s.handled).toEqual(["sub_1"]);
  });

  it("accepts and ignores events that are not about subscriptions", async () => {
    const s = setup();
    const res = await s.app.request(
      "/webhooks/polar",
      delivery({ type: "order.paid", data: { id: "ord_1" } }),
    );
    expect(res.status).toBe(202);
    expect(s.handled).toEqual([]);
  });

  it("answers 429 over the account cap and 500 on failure, so Polar redelivers", async () => {
    const capped = setup(async () => {
      throw new ProvisionCapError();
    });
    expect(
      (await capped.app.request("/webhooks/polar", delivery(event("subscription.created")))).status,
    ).toBe(429);
    expect(capped.store.isProcessed("msg_1")).toBe(false);
    const failing = setup(async () => {
      throw new Error("polar api down");
    });
    expect(
      (await failing.app.request("/webhooks/polar", delivery(event("subscription.created"))))
        .status,
    ).toBe(500);
    expect(failing.logs.join("\n")).not.toContain("polar api down");
  });

  it("handles deliveries one at a time", async () => {
    let active = 0;
    let max = 0;
    const s = setup(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await Promise.all([
      s.app.request("/webhooks/polar", delivery(event("subscription.active", "sub_1"), "m1")),
      s.app.request("/webhooks/polar", delivery(event("subscription.active", "sub_2"), "m2")),
    ]);
    expect(max).toBe(1);
  });
});

describe("Polar API client", () => {
  it("reads a subscription with the bearer token and maps its fields", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createPolarClient({
      apiUrl: "https://sandbox-api.polar.sh",
      accessToken: "polar_oat_x",
      fetch: async (url, init) => {
        seen.push({ url: String(url), init: init as RequestInit });
        return new Response(
          JSON.stringify({
            id: "sub_1",
            status: "trialing",
            customer_id: "cus_1",
            customer: { email: "a@b.co" },
          }),
          { status: 200 },
        );
      },
    });
    expect(await client.getSubscription("sub_1")).toEqual({
      id: "sub_1",
      status: "trialing",
      customerId: "cus_1",
      customerEmail: "a@b.co",
    });
    const call = seen[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("https://sandbox-api.polar.sh/v1/subscriptions/sub_1");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer polar_oat_x");
    expect(call.init.redirect).toBe("error");
  });

  it("throws a fixed error on HTTP errors and unknown shapes", async () => {
    const bad = createPolarClient({
      apiUrl: "https://api.polar.sh",
      accessToken: "t",
      fetch: async () => new Response("no", { status: 401 }),
    });
    await expect(bad.getSubscription("sub_1")).rejects.toThrow(
      "Polar API request failed (status 401).",
    );
    const odd = createPolarClient({
      apiUrl: "https://api.polar.sh",
      accessToken: "t",
      fetch: async () =>
        new Response(JSON.stringify({ id: "sub_1", status: "active" }), { status: 200 }),
    });
    await expect(odd.getSubscription("sub_1")).rejects.toThrow(
      "Polar API returned an unexpected subscription.",
    );
  });
});
