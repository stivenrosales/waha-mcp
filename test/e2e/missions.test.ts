import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMissionEngine, type MissionEngine } from "../../src/application/missions/engine.js";
import { createMissionService } from "../../src/application/missions/service.js";
import { DISABLED_TRANSCRIPTION } from "../../src/application/transcripts.js";
import { composeApp } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import { WahaNotFoundError } from "../../src/domain/errors.js";
import type { LlmClient, LlmTurnRequest, LlmTurnResult } from "../../src/domain/ports/LlmClient.js";
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
import { missionTenantPort } from "../../src/infrastructure/missions/tenantPort.js";
import type { TenantRegistry } from "../../src/infrastructure/tenants/registry.js";
import type { buildTenantRuntime } from "../../src/infrastructure/tenants/runtime.js";
import { createSqliteTenantStore } from "../../src/infrastructure/tenants/sqliteTenantStore.js";
import { createFsUploadStore } from "../../src/infrastructure/uploads/fsUploadStore.js";
import { createUploadLinks } from "../../src/infrastructure/uploads/uploadLinks.js";
import { createUploadHandler } from "../../src/infrastructure/uploads/uploadRoute.js";
import { decodeMediaId } from "../../src/infrastructure/waha/engines/gows.js";
import { createEngineResolver } from "../../src/infrastructure/waha/engines/index.js";
import { FakeSessionAdmin } from "../fakes/FakeSessionAdmin.js";
import {
  type InMemoryData,
  InMemoryWahaGateway,
  RecordingSender,
} from "../fakes/InMemoryWahaGateway.js";

/**
 * A whole mission through the real app: `composeApp` (OAuth bearer guard, MCP tools, the signed
 * `/webhooks/waha` route, the mission service wired into each tenant runtime) and the mission
 * engine built exactly as `composeMissionEngine` builds it, except for the test seams: a scripted
 * LLM, a controllable clock (only `Date` is faked; the engine is driven with `tick`), and a
 * `sleep` that records the pacing pause instead of waiting. WAHA is the in-memory gateway and a
 * recording sender per tenant.
 */

const BASE = "http://localhost:3000";
const WAHA_URL = "http://waha-internal:3000";
const MASTER_KEY = Buffer.alloc(32, 7);
const MEDIA_SECRET = new Uint8Array(32).fill(3);
const WEBHOOK_SECRET = "whsec-missions-e2e";
const MODEL = "anthropic/claude-haiku-5.5";

const MEMBER_SESSION = "t_friend";
const OWNER = "51900000009@c.us";
const CHAT = "51911111111@c.us";
const CONTACT = "+51911111111";
/** 10:00 in Lima: outside quiet hours. */
const T0 = new Date("2026-11-17T15:00:00.000Z");
const SEC = 1000;

type Raw = Record<string, unknown>;

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

const block = (b: Record<string, unknown>) => b as unknown as Anthropic.ContentBlock;
let toolSeq = 0;
function reply(text: string | null, tool?: { name: string; input: unknown }): LlmTurnResult {
  return {
    content: [
      ...(text === null ? [] : [block({ type: "text", text, citations: null })]),
      ...(tool ? [block({ type: "tool_use", id: `toolu_${++toolSeq}`, ...tool })] : []),
    ],
    stopReason: tool ? "tool_use" : "end_turn",
    usage,
  };
}

/** Scripted model: each turn answers with the next entry, which may read the request. */
class FakeLlm implements LlmClient {
  requests: LlmTurnRequest[] = [];
  queue: ((q: LlmTurnRequest) => LlmTurnResult)[] = [];
  async turn(q: LlmTurnRequest): Promise<LlmTurnResult> {
    this.requests.push(structuredClone(q));
    const next = this.queue.shift();
    if (!next) throw new Error("no scripted LLM reply");
    return next(q);
  }
}

/** Every block of the last user turn of a request. */
function lastUserBlocks(q: LlmTurnRequest): { type: string; text?: string }[] {
  const user = [...q.messages].reverse().find((m) => m.role === "user");
  if (!user || typeof user.content === "string")
    return user ? [{ type: "text", text: user.content as string }] : [];
  return user.content as { type: string; text?: string }[];
}

/** A GOWS `message.any` payload from the contact (spike §2.2). */
function contactPayload(shortId: string, at: Date, message: Raw, media: Raw | null = null): Raw {
  const text = typeof message.conversation === "string" ? (message.conversation as string) : null;
  return {
    id: `false_${CHAT}_${shortId}`,
    timestamp: Math.floor(at.getTime() / 1000),
    from: CHAT,
    fromMe: false,
    source: "app",
    body: text,
    to: null,
    participant: null,
    hasMedia: media !== null,
    media,
    ack: 2,
    ackName: "DEVICE",
    location: null,
    vCards: [],
    replyTo: null,
    _data: {
      Info: {
        Chat: "51911111111@s.whatsapp.net",
        Sender: "51911111111:3@s.whatsapp.net",
        IsFromMe: false,
        ID: shortId,
        PushName: "Ana",
      },
      Message: message,
    },
  };
}

interface World {
  app: Hono;
  engine: MissionEngine;
  llm: FakeLlm;
  gateway: InMemoryWahaGateway;
  data: InMemoryData;
  sender: RecordingSender;
  member: Client;
  admin: Client;
  memberTenantId: string;
  registry: TenantRegistry;
  /** Moves the fake clock to `T0 + ms`. */
  at(ms: number): Date;
  /** Runs one engine tick at the current fake time, after any wake already queued. */
  tick(): Promise<void>;
  /** POSTs a signed WAHA envelope for the member's session. */
  webhook(payload: Raw): Promise<Response>;
}

const scratchDirs: string[] = [];
const closers: (() => void)[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

async function world(): Promise<World> {
  const dataDir = mkdtempSync(join(tmpdir(), "e2e-missions-"));
  scratchDirs.push(dataDir);
  const config = loadConfig({
    WAHA_API_URL: WAHA_URL,
    WAHA_API_KEY: "k-very-secret-waha-key",
    PUBLIC_BASE_URL: BASE,
    MASTER_KEY: MASTER_KEY.toString("base64"),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "correct horse battery",
    TIMEZONE: "America/Lima",
    DATA_DIR: dataDir,
    OPENROUTER_API_KEY: "or-key",
    WAHA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    MISSIONS_MODEL: MODEL,
  });
  const m = config.missions;
  if (!m) throw new Error("missions must be on");

  // As main.ts: one auth database for auth, tenants, missions and the webhook inbox.
  const authDb = openAuthDatabase(join(dataDir, "auth.db"));
  const store = createAuthStore(authDb);
  const tenants = createSqliteTenantStore(authDb);
  const missions = createSqliteMissionStore(authDb);
  const events = createSqliteEventStore(authDb);

  const seedTenant = (name: string, session: string, userId: string, role: string) => {
    const t = tenants.createTenant({ displayName: name, wahaSession: session, wrappedDek: "x" });
    tenants.setWrappedDek(t.id, wrapDek(MASTER_KEY, generateDek(), t.id));
    tenants.setStatus(t.id, "active");
    authDb
      .prepare(
        "INSERT INTO users (id, tenant_id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 0)",
      )
      .run(userId, t.id, name.toLowerCase(), role);
    const { clientId } = store.registerClient({ redirectUris: ["https://claude.ai/cb"] });
    return { tenant: t, token: store.issueTokens(clientId, "mcp", userId).accessToken };
  };
  const adminSeed = seedTenant("Admin", config.wahaSession, "admin-user", "admin");
  const memberSeed = seedTenant("Friend", MEMBER_SESSION, "member-user", "member");
  expect(tenants.setWaId(memberSeed.tenant.id, OWNER)).toBe("ok");

  // The member's WhatsApp: one earlier message with the contact (a known contact).
  const data: InMemoryData = {
    chats: [
      { id: CHAT, name: null, conversationTimestamp: Math.floor(T0.getTime() / 1000) - 3600 },
    ],
    messages: {
      [CHAT]: [
        contactPayload("3EB0OLD", new Date(T0.getTime() - 3600 * SEC), {
          conversation: "hola de nuevo",
        }),
      ],
    },
    media: {},
  };
  const gateway = new InMemoryWahaGateway(data);
  const sender = new RecordingSender();
  const adminGateway = new InMemoryWahaGateway({});
  const adminSender = new RecordingSender();

  // Same shape as the production `buildTenantRuntime` (cache.db with the sealed mission log, the
  // tenant cipher, and the mission service over the wiring composeApp hands in), except that WAHA
  // is the in-memory gateway and sender of the tenant.
  const buildRuntime: typeof buildTenantRuntime = (b) => {
    const isMember = b.tenant.id === memberSeed.tenant.id;
    const gw = isMember ? gateway : adminGateway;
    const dir = join(b.config.dataDir, "tenants", b.tenant.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cipher = createTenantCipher(b.dek, b.tenant.id);
    const cacheDb = openCacheDatabase(join(dir, "cache.db"));
    const missionLog = createSealedMissionLog(cacheDb, cipher);
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
    const mc = b.config.missions;
    const missionService =
      mc && b.missions
        ? createMissionService({
            ...b.missions,
            tenantId: b.tenant.id,
            log: missionLog,
            limits: mc.limits,
            monthlyBudgetUsd: mc.monthlyBudgetUsd,
            timezone: b.config.timezone,
            lookupLid: (lid) => gw.lookupLid(lid),
            logger: b.logger,
            hasHistory: async (chatId) => {
              try {
                return (await gw.getMessages(chatId, { limit: 1, offset: 0 })).length > 0;
              } catch (error) {
                if (error instanceof WahaNotFoundError) return false;
                throw error;
              }
            },
          })
        : null;
    return {
      tenantId: b.tenant.id,
      context: {
        gateway: gw,
        mapper: createEngineResolver(gw),
        config: b.config,
        links,
        transcription: DISABLED_TRANSCRIPTION,
        sender: isMember ? sender : adminSender,
        uploads,
        uploadLinks,
        missions: missionService,
      },
      media: createMediaHandler({ gateway: gw, links, maxBytes: b.config.mediaMaxBytes }),
      upload: createUploadHandler({
        store: uploads,
        links: uploadLinks,
        maxBytes: b.config.uploadMaxBytes,
      }),
      missionLog,
      cipher,
      close() {
        cacheDb.close();
      },
    };
  };

  // As main.ts: the engine is read lazily by the app and assigned right after composing.
  let engine: MissionEngine | null = null;
  const logger = { info: () => {} };
  const { app, registry } = composeApp({
    config,
    store,
    tenants,
    missions,
    events,
    onWebhookEvent: () => engine?.wake(),
    missionEngine: () => engine,
    sessions: new FakeSessionAdmin(),
    mediaSecret: MEDIA_SECRET,
    logger,
    buildRuntime,
  });
  // As composeMissionEngine, with the clock, randomness and sleep as test seams. The pacing pause
  // is recorded in the sender's call log, so the order typing → pause → send is visible.
  const llm = new FakeLlm();
  engine = createMissionEngine({
    missions,
    events,
    tenants,
    llm,
    model: m.model,
    limits: m.limits,
    monthlyBudgetUsd: m.monthlyBudgetUsd,
    timezone: config.timezone,
    acquire: (tenantId) => {
      const held = registry.acquire(tenantId);
      return held ? { port: missionTenantPort(held.runtime), release: held.release } : null;
    },
    now: () => new Date(),
    rand: () => 0.5,
    // Only the member runs missions in these tests.
    sleep: async (ms) => {
      sender.calls.push({ method: "sleep", args: ms });
    },
    logger,
  });
  const theEngine = engine;
  closers.push(() => {
    theEngine.stop();
    registry.closeAll();
    store.close();
  });

  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (url, init) => app.fetch(new Request(url, init)),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };

  let evt = 0;
  return {
    app,
    engine: theEngine,
    llm,
    gateway,
    data,
    sender,
    member: await connect(memberSeed.token),
    admin: await connect(adminSeed.token),
    memberTenantId: memberSeed.tenant.id,
    registry,
    at(ms) {
      const now = new Date(T0.getTime() + ms);
      vi.setSystemTime(now);
      return now;
    },
    async tick() {
      await theEngine.idle();
      await theEngine.tick(new Date());
      await theEngine.idle();
    },
    async webhook(payload) {
      evt += 1;
      const body = JSON.stringify({
        id: `evt_e2e_${evt}`,
        timestamp: Date.now(),
        event: "message.any",
        session: MEMBER_SESSION,
        metadata: { tenant: memberSeed.tenant.id },
        me: { id: OWNER, pushName: "Friend" },
        payload,
        engine: "GOWS",
      });
      const res = await app.fetch(
        new Request(`${BASE}/webhooks/waha`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-hmac": createHmac("sha512", WEBHOOK_SECRET).update(body).digest("hex"),
            "x-webhook-hmac-algorithm": "sha512",
          },
          body,
        }),
      );
      // The route wakes the engine; let that tick finish before the test goes on.
      await theEngine.idle();
      return res;
    },
  };
}

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}
const sc = (r: ToolResult): Record<string, unknown> => r.structuredContent ?? {};
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

const START = {
  chat_id: CHAT,
  system_prompt: "Eres el asistente de Friend. Pide a Ana la foto de su DNI.",
  objective: "Conseguir la foto del DNI de Ana.",
  done_when: "Ana envía la foto de su DNI.",
  max_duration_minutes: 60,
  expects_files: true,
};

/** Sender calls to one chat (the pacing pauses are kept: they belong to the contact's sends). */
const callsTo = (sender: RecordingSender, chatId: string) =>
  sender.calls.filter((c) => {
    if (c.method === "sleep") return true;
    const a = c.args as { chatId?: string } | string;
    return (typeof a === "string" ? a : a.chatId) === chatId;
  });
const textsTo = (sender: RecordingSender, chatId: string) =>
  sender.calls
    .filter((c) => c.method === "sendText" && (c.args as { chatId: string }).chatId === chatId)
    .map((c) => (c.args as { text: string }).text);

describe("e2e: a mission over the real app", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
  });

  it("runs start → two bubbles → one paced reply → image → finish, then reports it", async () => {
    const w = await world();

    // Start: the opening turn runs on the wake start_mission queues.
    w.llm.queue.push(() => reply("Hola Ana, soy el asistente de Friend."));
    const started = await call(w.member, "start_mission", START);
    expect(started.isError).toBeFalsy();
    const missionId = sc(started).mission_id as string;
    expect(sc(started)).toMatchObject({
      chat_id: CHAT,
      new_contact: false,
      deadline_in_quiet_hours: false,
    });
    await w.engine.idle();
    expect(w.llm.requests).toHaveLength(1);
    expect(w.llm.requests[0]?.system).toBe(START.system_prompt);
    expect(textsTo(w.sender, CHAT)).toEqual(["Hola Ana, soy el asistente de Friend."]);

    // Two bubbles arrive through the signed webhook route; the debounce holds the reply.
    const before = w.sender.calls.length;
    const b1 = w.at(5 * SEC);
    expect((await w.webhook(contactPayload("3EB0B1", b1, { conversation: "hola" }))).status).toBe(
      200,
    );
    const b2 = w.at(8 * SEC);
    expect(
      (await w.webhook(contactPayload("3EB0B2", b2, { conversation: "¿qué necesitas?" }))).status,
    ).toBe(200);
    await w.tick();
    expect(w.llm.requests).toHaveLength(1);

    // After the debounce: one agent turn over both bubbles, one paced reply.
    w.llm.queue.push(() => reply("Necesito una foto de tu DNI, por favor."));
    w.at(30 * SEC);
    await w.tick();
    expect(w.llm.requests).toHaveLength(2);
    expect(
      lastUserBlocks(w.llm.requests[1] as LlmTurnRequest)
        .filter((b) => b.type === "text")
        .map((b) => b.text),
    ).toEqual(["hola", "¿qué necesitas?"]);
    expect(w.sender.calls.slice(before).map((c) => c.method)).toEqual([
      "sendSeen",
      "startTyping",
      "sleep",
      "stopTyping",
      "sendText",
    ]);
    expect(w.sender.calls.slice(before)[0]?.args).toEqual({
      chatId: CHAT,
      messageIds: [`false_${CHAT}_3EB0B1`, `false_${CHAT}_3EB0B2`],
    });
    expect(textsTo(w.sender, CHAT)).toEqual([
      "Hola Ana, soy el asistente de Friend.",
      "Necesito una foto de tu DNI, por favor.",
    ]);

    // An image arrives (WAHA serves it); the model sees it and closes the mission with it.
    const i1 = w.at(60 * SEC);
    const url = `${WAHA_URL}/api/files/dni.jpg`;
    const image = contactPayload(
      "3EB0IMG",
      i1,
      { imageMessage: { mimetype: "image/jpeg", fileLength: 4, caption: "aquí está" } },
      { url, mimetype: "image/jpeg", filename: null, error: null },
    );
    w.data.messages?.[CHAT]?.unshift(image);
    (w.data.media ?? {})[url] = {
      bytes: new Uint8Array([255, 216, 255, 224]),
      mimetype: "image/jpeg",
    };
    expect((await w.webhook(image)).status).toBe(200);
    let seenMediaId: string | null = null;
    w.llm.queue.push((q) => {
      const ref = lastUserBlocks(q)
        .map((b) => /media_id: ([A-Za-z0-9_-]+)/.exec(b.text ?? "")?.[1])
        .find(Boolean);
      seenMediaId = ref ?? null;
      return reply(null, {
        name: "finish_mission",
        input: {
          outcome: "succeeded",
          summary: "Ana envió la foto de su DNI.",
          collected: [{ label: "DNI", media_id: ref }],
        },
      });
    });
    w.at(90 * SEC);
    await w.tick();
    expect(w.llm.requests).toHaveLength(3);
    const imageTurn = lastUserBlocks(w.llm.requests[2] as LlmTurnRequest);
    expect(imageTurn.map((b) => b.type)).toEqual(["image", "text"]);
    expect(seenMediaId).not.toBeNull();
    expect(decodeMediaId(seenMediaId as unknown as string)?.messageId).toBe(
      `false_${CHAT}_3EB0IMG`,
    );

    // The owner gets the Spanish notice in their own chat; the contact gets nothing more.
    expect(textsTo(w.sender, OWNER)).toEqual([
      `✅ Misión con ${CONTACT} cumplida: Ana envió la foto de su DNI.`,
    ]);
    expect(textsTo(w.sender, CHAT)).toHaveLength(2);

    // get_mission: succeeded, the collected media_id, and the usage counters.
    const got = await call(w.member, "get_mission", { mission_id: missionId });
    expect(got.isError).toBeFalsy();
    expect(sc(got)).toMatchObject({
      id: missionId,
      state: "succeeded",
      outcome: "succeeded",
      summary: "Ana envió la foto de su DNI.",
      collected: [{ label: "DNI", media_id: seenMediaId }],
      messages_sent: 2,
      llm_calls: 3,
    });
    expect(textOf(got)).toContain(`media_id ${seenMediaId}`);
    // The collected media id works with get_media.
    const media = await call(w.member, "get_media", { media_id: seenMediaId });
    expect(media.isError).toBeFalsy();

    // The admin sees the member's three calls in get_llm_usage.
    const report = await call(w.admin, "get_llm_usage");
    expect(report.isError).toBeFalsy();
    const rows = sc(report).tenants as { id: string; calls: number; missions: number }[];
    expect(rows).toEqual([
      expect.objectContaining({ id: w.memberTenantId, calls: 3, missions: 1, costUsd: 0.003 }),
    ]);
  });

  it("an owner send_text in the mission chat takes it over: no further agent sends", async () => {
    const w = await world();
    w.llm.queue.push(() => reply("Hola Ana, soy el asistente de Friend."));
    const started = await call(w.member, "start_mission", START);
    const missionId = sc(started).mission_id as string;
    await w.engine.idle();
    expect(textsTo(w.sender, CHAT)).toEqual(["Hola Ana, soy el asistente de Friend."]);

    w.at(10 * SEC);
    const sent = await call(w.member, "send_text", {
      chat_id: CHAT,
      text: "Ana, ya te escribo yo.",
    });
    expect(sent.isError).toBeFalsy();
    await w.engine.idle();
    const got = await call(w.member, "get_mission", { mission_id: missionId });
    expect(sc(got).state).toBe("taken_over");

    // The contact answers; the agent stays silent and the model is not called again.
    const callsBefore = callsTo(w.sender, CHAT).length;
    const r1 = w.at(20 * SEC);
    expect((await w.webhook(contactPayload("3EB0R1", r1, { conversation: "ok" }))).status).toBe(
      200,
    );
    w.at(60 * SEC);
    await w.tick();
    expect(w.llm.requests).toHaveLength(1);
    expect(callsTo(w.sender, CHAT)).toHaveLength(callsBefore);
    expect(textsTo(w.sender, CHAT)).toEqual([
      "Hola Ana, soy el asistente de Friend.",
      "Ana, ya te escribo yo.",
    ]);
  });
});
