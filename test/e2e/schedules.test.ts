import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRunner } from "../../src/application/schedules/runner.js";
import { DISABLED_TRANSCRIPTION } from "../../src/application/transcripts.js";
import { composeApp, composeScheduleRunner } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import type { LlmClient } from "../../src/domain/ports/LlmClient.js";
import { createAuthStore, openAuthDatabase } from "../../src/infrastructure/auth/store.js";
import { openCacheDatabase } from "../../src/infrastructure/cache/sqliteMessageStore.js";
import {
  createTenantCipher,
  generateDek,
  wrapDek,
} from "../../src/infrastructure/crypto/envelope.js";
import { createMediaHandler } from "../../src/infrastructure/media/mediaRoute.js";
import { createSignedLinks } from "../../src/infrastructure/media/signedLink.js";
import { createSealedMissionLog } from "../../src/infrastructure/missions/sealedMissionLog.js";
import { createSqliteEventStore } from "../../src/infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "../../src/infrastructure/missions/sqliteMissionStore.js";
import { createSealedScheduleLog } from "../../src/infrastructure/schedules/sealedScheduleLog.js";
import { createSqliteScheduleStore } from "../../src/infrastructure/schedules/sqliteScheduleStore.js";
import {
  type buildTenantRuntime,
  buildTenantServices,
} from "../../src/infrastructure/tenants/runtime.js";
import { createSqliteTenantStore } from "../../src/infrastructure/tenants/sqliteTenantStore.js";
import { createFsUploadStore } from "../../src/infrastructure/uploads/fsUploadStore.js";
import { createUploadLinks } from "../../src/infrastructure/uploads/uploadLinks.js";
import { createUploadHandler } from "../../src/infrastructure/uploads/uploadRoute.js";
import { createEngineResolver } from "../../src/infrastructure/waha/engines/index.js";
import { FakeSessionAdmin } from "../fakes/FakeSessionAdmin.js";
import { InMemoryWahaGateway, RecordingSender, rawText } from "../fakes/InMemoryWahaGateway.js";

/**
 * A scheduled message through the real app: `composeApp` (bearer guard, MCP tools, the schedule
 * service built by the production `buildTenantServices`) and the runner from the real
 * `composeScheduleRunner`. Only `Date` is faked; ticks are driven by hand. WAHA is the in-memory
 * gateway and a recording sender.
 */

const BASE = "http://localhost:3000";
const MASTER_KEY = Buffer.alloc(32, 7);
const MEMBER_SESSION = "t_friend";
const OWNER = "51900000009@c.us";
const CHAT = "51911111111@c.us";
/** 10:00 in Lima: outside quiet hours. */
const T0 = new Date("2026-11-17T15:00:00.000Z");
const MIN = 60_000;

const noLlm: LlmClient = {
  turn: async () => {
    throw new Error("fixed schedules never call the model");
  },
};

const scratchDirs: string[] = [];
const closers: (() => void)[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), "e2e-schedules-"));
  scratchDirs.push(dataDir);
  const config = loadConfig({
    WAHA_API_URL: "http://waha-internal:3000",
    WAHA_API_KEY: "k-very-secret-waha-key",
    PUBLIC_BASE_URL: BASE,
    MASTER_KEY: MASTER_KEY.toString("base64"),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "correct horse battery",
    TIMEZONE: "America/Lima",
    DATA_DIR: dataDir,
    OPENROUTER_API_KEY: "or-key",
    WAHA_WEBHOOK_SECRET: "whsec-schedules-e2e",
  });

  // As main.ts: one auth database for auth, tenants, missions, schedules and the webhook inbox.
  const authDb = openAuthDatabase(join(dataDir, "auth.db"));
  const store = createAuthStore(authDb);
  const tenants = createSqliteTenantStore(authDb);
  const missions = createSqliteMissionStore(authDb);
  const schedules = createSqliteScheduleStore(authDb);
  const events = createSqliteEventStore(authDb);

  const t = tenants.createTenant({
    displayName: "Friend",
    wahaSession: MEMBER_SESSION,
    wrappedDek: "x",
  });
  tenants.setWrappedDek(t.id, wrapDek(MASTER_KEY, generateDek(), t.id));
  tenants.setStatus(t.id, "active");
  expect(tenants.setWaId(t.id, OWNER)).toBe("ok");
  authDb
    .prepare(
      "INSERT INTO users (id, tenant_id, username, password_hash, role, created_at) VALUES ('u1', ?, 'friend', 'unused', 'member', 0)",
    )
    .run(t.id);
  const { clientId } = store.registerClient({ redirectUris: ["https://claude.ai/cb"] });
  const token = store.issueTokens(clientId, "mcp", "u1").accessToken;

  // A known contact: one earlier message in the chat.
  const gateway = new InMemoryWahaGateway({
    messages: {
      [CHAT]: [
        rawText("3EB0OLD", Math.floor(T0.getTime() / 1000) - 3600, "hola", {
          chat: CHAT,
          sender: CHAT,
        }),
      ],
    },
  });
  const sender = new RecordingSender();

  // The production runtime with WAHA swapped for the in-memory gateway and sender; the mission
  // and schedule services come from the same `buildTenantServices` the real runtime uses.
  const buildRuntime: typeof buildTenantRuntime = (b) => {
    const dir = join(b.config.dataDir, "tenants", b.tenant.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cipher = createTenantCipher(b.dek, b.tenant.id);
    const cacheDb = openCacheDatabase(join(dir, "cache.db"));
    const missionLog = createSealedMissionLog(cacheDb, cipher);
    const scheduleLog = createSealedScheduleLog(cacheDb, cipher);
    const links = createSignedLinks({
      secret: b.mediaSecret,
      ttlSeconds: b.config.mediaLinkTtlSeconds,
      tenantId: b.tenant.id,
    });
    const uploadLinks = createUploadLinks(b.mediaSecret, b.config.uploadTtlSeconds, b.tenant.id);
    const uploads = createFsUploadStore({
      dir: join(dir, "uploads"),
      ttlSeconds: b.config.uploadTtlSeconds,
      maxBytes: b.config.uploadMaxBytes,
      cipher,
    });
    return {
      tenantId: b.tenant.id,
      context: {
        gateway,
        mapper: createEngineResolver(gateway),
        config: b.config,
        links,
        transcription: DISABLED_TRANSCRIPTION,
        sender,
        uploads,
        uploadLinks,
        ...buildTenantServices({
          config: b.config,
          tenant: b.tenant,
          gateway,
          missionLog,
          scheduleLog,
          logger: b.logger,
          ...(b.missions ? { wiring: b.missions } : {}),
        }),
      },
      media: createMediaHandler({
        gateway,
        links,
        maxBytes: b.config.mediaMaxBytes,
        logger: b.logger,
      }),
      upload: createUploadHandler({
        store: uploads,
        links: uploadLinks,
        maxBytes: b.config.uploadMaxBytes,
        logger: b.logger,
      }),
      missionLog,
      scheduleLog,
      cipher,
      close() {
        cacheDb.close();
      },
    };
  };

  // As main.ts: the runner is read lazily by the app and assigned right after composing.
  let runner: ScheduleRunner | null = null;
  const logger = { info: () => {} };
  const { app, registry } = composeApp({
    config,
    store,
    tenants,
    missions,
    events,
    schedules,
    scheduleRunner: () => runner,
    sessions: new FakeSessionAdmin(),
    mediaSecret: new Uint8Array(32).fill(3),
    logger,
    buildRuntime,
  });
  runner = composeScheduleRunner({
    config,
    registry,
    tenants,
    missions,
    schedules,
    logger,
    llm: noLlm,
    rand: () => 0.5,
    sleep: async (ms) => {
      sender.calls.push({ method: "sleep", args: ms });
    },
  });
  if (!runner) throw new Error("missions must be on");
  const theRunner = runner;
  closers.push(() => {
    theRunner.stop();
    registry.closeAll();
    store.close();
  });

  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: async (url, init) => app.fetch(new Request(url, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return {
    client,
    sender,
    runner: theRunner,
    at(ms: number) {
      vi.setSystemTime(new Date(T0.getTime() + ms));
    },
    async tick() {
      await theRunner.idle();
      await theRunner.tick(new Date());
      await theRunner.idle();
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    },
  };
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const textsTo = (sender: RecordingSender, chatId: string) =>
  sender.calls
    .filter((c) => c.method === "sendText" && (c.args as { chatId: string }).chatId === chatId)
    .map((c) => (c.args as { text: string }).text);

describe("e2e: a scheduled message over the real app", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
  });

  it("schedules a fixed message, sends it when due, and list_scheduled shows it sent", async () => {
    const w = await world();
    const scheduled = await w.call("schedule_message", {
      chat_id: CHAT,
      kind: "fixed",
      text: "Hola Ana, **recuerda** la reunión",
      at: "2026-11-17 10:01",
      repeat: "daily",
      max_runs: 2,
    });
    expect(scheduled.isError).toBeFalsy();
    const id = scheduled.structuredContent?.schedule_id as string;
    expect(textOf(scheduled)).toContain(`Scheduled message ${id} to ${CHAT}`);
    expect(textOf(scheduled)).toContain("2026-11-17 10:01 (America/Lima)");

    // Not due yet: nothing is sent.
    await w.tick();
    expect(textsTo(w.sender, CHAT)).toEqual([]);

    w.at(MIN);
    await w.tick();
    expect(textsTo(w.sender, CHAT)).toEqual(["Hola Ana, *recuerda* la reunión"]);
    // Paced: typing pause before the send.
    expect(w.sender.calls.some((c) => c.method === "sleep")).toBe(true);
    // A successful fixed run sends the owner no note.
    expect(textsTo(w.sender, OWNER)).toEqual([]);

    const listed = await w.call("list_scheduled");
    expect(textOf(listed)).toContain("2026-11-17 10:01 sent");
    const [entry] = (listed.structuredContent?.schedules ?? []) as Record<string, unknown>[];
    expect(entry).toMatchObject({
      id,
      runs_done: 1,
      remaining_runs: 1,
      next_run_at: "2026-11-18T15:01:00.000Z",
      last_runs: [{ outcome: "sent" }],
    });
  });

  it("cancel_scheduled stops a schedule before it runs", async () => {
    const w = await world();
    const scheduled = await w.call("schedule_message", {
      chat_id: CHAT,
      kind: "fixed",
      text: "Hola",
      at: "2026-11-17 10:01",
    });
    const id = scheduled.structuredContent?.schedule_id as string;
    const cancelled = await w.call("cancel_scheduled", { schedule_id: id });
    expect(cancelled.structuredContent).toEqual({ schedule_id: id, state: "cancelled" });
    w.at(MIN);
    await w.tick();
    expect(textsTo(w.sender, CHAT)).toEqual([]);
    expect(textOf(await w.call("list_scheduled"))).toBe("No scheduled messages.");
  });
});
