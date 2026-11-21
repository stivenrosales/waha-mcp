import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import type { Tenant } from "../../../src/domain/ports/TenantStore.js";
import { createSqliteMessageActionStore } from "../../../src/infrastructure/cache/sqliteMessageActionStore.js";
import { openCacheDatabase } from "../../../src/infrastructure/cache/sqliteMessageStore.js";
import { generateDek } from "../../../src/infrastructure/crypto/envelope.js";
import {
  buildTenantRuntime,
  guardUsageRecorder,
  wireMessageActions,
} from "../../../src/infrastructure/tenants/runtime.js";
import { getEngineMapper } from "../../../src/infrastructure/waha/engines/index.js";
import { InMemoryWahaGateway, rawText } from "../../fakes/InMemoryWahaGateway.js";
import { testCipher } from "../../fakes/testCipher.js";

/** Every cache database the runtime opens, so tests can check it was closed. */
const opened = vi.hoisted(() => [] as DatabaseSync[]);
vi.mock("../../../src/infrastructure/cache/sqliteMessageStore.js", async (importOriginal) => {
  const mod =
    await importOriginal<
      typeof import("../../../src/infrastructure/cache/sqliteMessageStore.js")
    >();
  return {
    ...mod,
    openCacheDatabase: (p: string) => {
      const db = mod.openCacheDatabase(p);
      opened.push(db);
      return db;
    },
  };
});

const SECRET = new Uint8Array(32).fill(4);

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-runtime-"));
  scratchDirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllGlobals();
  opened.splice(0);
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const configFor = (dataDir: string, env: Record<string, string> = {}) =>
  loadConfig({
    ...env,
    WAHA_API_URL: "http://waha:3000",
    WAHA_API_KEY: "k-secret",
    PUBLIC_BASE_URL: "https://mcp.example.com",
    MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "correct horse battery",
    DATA_DIR: dataDir,
  });

const tenant = (id: string): Tenant => ({
  id,
  wahaSession: "t_abcdefghij",
  displayName: "Acme",
  status: "active",
  waId: null,
  createdAt: 0,
});

const build = (dataDir: string, id: string) =>
  buildTenantRuntime({
    config: configFor(dataDir),
    tenant: tenant(id),
    dek: generateDek(),
    mediaSecret: SECRET,
    logger: { info: () => {} },
  });

describe("buildTenantRuntime", () => {
  it("creates the tenant directory 0700 with its cache and uploads", () => {
    const dataDir = scratch();
    const runtime = build(dataDir, "tid1");
    const dir = path.join(dataDir, "tenants", "tid1");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(dir, "cache.db"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "uploads"))).toBe(true);
    expect(runtime.tenantId).toBe("tid1");
    runtime.missionLog.append("m1", { kind: "prompt", at: "2026-11-17T10:00:00.000Z", body: "hi" });
    expect(runtime.missionLog.read("m1")).toHaveLength(1);
    runtime.scheduleLog.putContent("s1", { text: "hi" });
    expect(runtime.scheduleLog.content("s1")).toEqual({ text: "hi" });
    // The tenant cipher is exposed (the webhook route seals payloads with it).
    expect(runtime.cipher.openText(runtime.cipher.sealText("x", "a"), "a")).toBe("x");
    const token = runtime.context.links.sign("m1");
    expect(runtime.context.links.verify(token)).toBe("m1");
    runtime.close();
    expect(opened[0]?.isOpen).toBe(false);
  });

  it("tightens an existing tenant directory to 0700", () => {
    const dataDir = scratch();
    const dir = path.join(dataDir, "tenants", "tid1");
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    build(dataDir, "tid1").close();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("closes the cache database when a later step of the build fails", () => {
    const dataDir = scratch();
    const dir = path.join(dataDir, "tenants", "tid1");
    fs.mkdirSync(dir, { recursive: true });
    // A file where the uploads directory should be: the upload store cannot be created.
    fs.writeFileSync(path.join(dir, "uploads"), "");
    expect(() => build(dataDir, "tid1")).toThrow();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.isOpen).toBe(false);
  });

  it("refuses a tenant id that is not a plain path segment", () => {
    const dataDir = scratch();
    for (const id of ["../x", "a/b", "", "."]) {
      expect(() => build(dataDir, id)).toThrow("Invalid tenant id.");
    }
    expect(fs.existsSync(path.join(dataDir, "x"))).toBe(false);
    expect(opened).toHaveLength(0);
  });
});

describe("guardUsageRecorder", () => {
  it("passes usage through to the recorder", () => {
    const seen: unknown[] = [];
    const onUsage = guardUsageRecorder((u) => seen.push(u), { info: () => {} }, "abc");
    onUsage({ seconds: 2, costUsd: 0.001 });
    expect(seen).toEqual([{ seconds: 2, costUsd: 0.001 }]);
  });

  it("a failing usage write only logs a line naming the tenant", () => {
    const lines: string[] = [];
    const onUsage = guardUsageRecorder(
      () => {
        throw new Error("database is locked https://openrouter.ai sk-or-x");
      },
      { info: (m) => lines.push(m) },
      "abc",
    );
    expect(() => onUsage({ seconds: 1, costUsd: 0.1 })).not.toThrow();
    expect(lines).toEqual(["tenant=abc transcription usage not recorded"]);
  });

  it("is a no-op without a recorder", () => {
    expect(() =>
      guardUsageRecorder(undefined, { info: () => {} }, "abc")({ seconds: null, costUsd: null }),
    ).not.toThrow();
  });
});

const CHAT = "100000000000009@g.us";
const SESSION = "t_abcdefghij";

/** WAHA over HTTP for one GOWS session that keeps serving the original text of every message. */
function fakeWahaFetch(messages: unknown[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === `/api/sessions/${SESSION}`)
      return json({ engine: { engine: "GOWS" }, status: "WORKING" });
    if (url.pathname === `/api/sessions/${SESSION}/me`) return json({ id: "51000000002@c.us" });
    if (url.pathname === `/api/${SESSION}/chats/${encodeURIComponent(CHAT)}/messages`)
      return json(messages);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

describe("message actions wiring", () => {
  it.each([
    ["on", "true"],
    ["off", "false"],
  ])(
    "a revoke via context.messageActions is reflected by context.gateway.getMessages (cache %s)",
    async (_, cache) => {
      vi.stubGlobal("fetch", fakeWahaFetch([rawText("R1", 1_000, "secret words")]));
      const runtime = buildTenantRuntime({
        config: configFor(scratch(), { CACHE_ENABLED: cache }),
        tenant: tenant("tid1"),
        dek: generateDek(),
        mediaSecret: SECRET,
        logger: { info: () => {} },
      });
      try {
        const { gateway, messageActions } = runtime.context;
        expect(JSON.stringify(await gateway.getMessages(CHAT, { limit: 10, offset: 0 }))).toContain(
          "secret words",
        );
        await messageActions.applyRevoke("R1", 2_000);
        const page = await gateway.getMessages(CHAT, { limit: 10, offset: 0 });
        expect(getEngineMapper("GOWS").message(page[0]).type).toBe("deleted");
        expect(JSON.stringify(page)).not.toContain("secret");
      } finally {
        runtime.close();
      }
    },
  );

  it("with the cache and transcription off, a new owner wipes old reactions, votes and overrides", async () => {
    const db = openCacheDatabase(":memory:");
    const cipher = testCipher();
    const store = createSqliteMessageActionStore(db, cipher);
    db.prepare("INSERT INTO meta (key, value) VALUES ('owner', ?)").run(`${SESSION}|old@c.us`);
    store.putOverride("R1", { kind: "revoked", at: 1 });
    store.putReaction({ messageId: "R1", reactor: "a@lid", emoji: "👍", ts: 1 });
    store.putVote({ pollId: "P", voter: "a@lid", options: ["x"], ts: 1 });
    const waha = new InMemoryWahaGateway({
      messages: { [CHAT]: [rawText("R1", 1_000, "visible")] },
      me: { id: "new@c.us", lid: null },
    });
    const wired = wireMessageActions({
      wahaGateway: waha,
      db,
      cipher,
      session: SESSION,
      cache: null,
    });
    const page = await wired.gateway.getMessages(CHAT, { limit: 10, offset: 0 });
    expect(getEngineMapper("GOWS").message(page[0]).text).toBe("visible");
    expect(store.overrides(["R1"]).size).toBe(0);
    expect(store.reactions(["R1"]).size).toBe(0);
    expect(store.votes("P").votes).toEqual([]);
    expect(await wired.messageActions.pollVotes("P")).toEqual({ votes: [], failed: 0 });
  });

  it("a new owner also wipes the old store before the first write", async () => {
    const db = openCacheDatabase(":memory:");
    const cipher = testCipher();
    const store = createSqliteMessageActionStore(db, cipher);
    db.prepare("INSERT INTO meta (key, value) VALUES ('owner', ?)").run(`${SESSION}|old@c.us`);
    store.putReaction({ messageId: "OLD", reactor: "a@lid", emoji: "👍", ts: 1 });
    const waha = new InMemoryWahaGateway({ me: { id: "new@c.us", lid: null } });
    const wired = wireMessageActions({
      wahaGateway: waha,
      db,
      cipher,
      session: SESSION,
      cache: null,
    });
    await wired.messageActions.applyReaction({
      messageId: "NEW",
      reactor: "b@lid",
      emoji: "🔥",
      ts: 2,
    });
    expect(store.reactions(["OLD", "NEW"])).toEqual(
      new Map([["NEW", [{ emoji: "🔥", by: "b@lid" }]]]),
    );
  });
});
