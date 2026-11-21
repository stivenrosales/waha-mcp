import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { CacheEventProcessor } from "../../src/application/cacheEvents.js";
import { DISABLED_TRANSCRIPTION } from "../../src/application/transcripts.js";
import { composeApp, composeCacheEventProcessor } from "../../src/composition.js";
import { loadConfig } from "../../src/config.js";
import type { EventStore } from "../../src/domain/ports/EventStore.js";
import { createAuthStore, openAuthDatabase } from "../../src/infrastructure/auth/store.js";
import { openCacheDatabase } from "../../src/infrastructure/cache/sqliteMessageStore.js";
import { createTenantCipher } from "../../src/infrastructure/crypto/envelope.js";
import { createMediaHandler } from "../../src/infrastructure/media/mediaRoute.js";
import { createSignedLinks } from "../../src/infrastructure/media/signedLink.js";
import { createSqliteEventStore } from "../../src/infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "../../src/infrastructure/missions/sqliteMissionStore.js";
import { migrateToMultiTenant } from "../../src/infrastructure/tenants/migrate.js";
import type { buildTenantRuntime } from "../../src/infrastructure/tenants/runtime.js";
import { wireMessageActions } from "../../src/infrastructure/tenants/runtime.js";
import { createSqliteTenantStore } from "../../src/infrastructure/tenants/sqliteTenantStore.js";
import { createFsUploadStore } from "../../src/infrastructure/uploads/fsUploadStore.js";
import { createUploadLinks } from "../../src/infrastructure/uploads/uploadLinks.js";
import { createUploadHandler } from "../../src/infrastructure/uploads/uploadRoute.js";
import { FakeSessionAdmin } from "../fakes/FakeSessionAdmin.js";
import { InMemoryWahaGateway, RecordingSender, rawText } from "../fakes/InMemoryWahaGateway.js";

/**
 * Webhooks on, missions off: a signed edit/deletion/reaction event is stored by the real route and
 * applied by the real cache event processor, and the MCP tools show the result.
 */

const BASE = "http://localhost:3000";
const SECRET = "whsec-cache-e2e";
const PASSWORD = "correct horse battery";
const CHAT = "51911111111@c.us";
const SEC_TEXT = "the quiet launch codeword";

const scratchDirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

interface ToolResult {
  structuredContent?: Record<string, unknown>;
  content: { text?: string }[];
  isError?: boolean;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
  (await c.callTool({ name, arguments: args })) as unknown as ToolResult;

async function world(opts: { cache?: boolean } = {}) {
  const sender = new RecordingSender();
  const dataDir = mkdtempSync(join(tmpdir(), "e2e-cache-events-"));
  scratchDirs.push(dataDir);
  const config = loadConfig({
    WAHA_API_URL: "http://waha-internal:3000",
    WAHA_API_KEY: "k-very-secret-waha-key",
    PUBLIC_BASE_URL: BASE,
    MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: PASSWORD,
    WAHA_SESSION: "default",
    TIMEZONE: "America/Lima",
    DATA_DIR: dataDir,
    WAHA_WEBHOOK_SECRET: SECRET,
  });
  expect(config.missions).toBeNull();
  const authDb = openAuthDatabase(join(dataDir, "auth.db"));
  const store = createAuthStore(authDb);
  const tenants = createSqliteTenantStore(authDb);
  const sessions = new FakeSessionAdmin();
  sessions.setState("default", "WORKING");
  sessions.setMe("default", "51900000001@c.us");
  await migrateToMultiTenant({
    authDb,
    tenants,
    auth: store,
    config,
    kek: config.masterKey,
    dataDir,
    sessions,
    logger: { info: () => {} },
  });
  const gateway = new InMemoryWahaGateway({
    chats: [{ id: CHAT, name: null, conversationTimestamp: 1793286000 }],
    messages: {
      [CHAT]: [rawText("3EB0AAAA", 1793286000, SEC_TEXT, { chat: CHAT, sender: CHAT })],
    },
    me: { id: "51900000001@c.us", lid: null },
  });
  const buildRuntime: typeof buildTenantRuntime = (b) => {
    const cipher = createTenantCipher(b.dek, b.tenant.id);
    const links = createSignedLinks({
      secret: b.mediaSecret,
      ttlSeconds: b.config.mediaLinkTtlSeconds,
      tenantId: b.tenant.id,
    });
    const uploadLinks = createUploadLinks(b.mediaSecret, b.config.uploadTtlSeconds, b.tenant.id);
    const uploads = createFsUploadStore({
      dir: join(b.config.dataDir, "tenants", b.tenant.id, "uploads"),
      ttlSeconds: b.config.uploadTtlSeconds,
      maxBytes: b.config.uploadMaxBytes,
      cipher,
    });
    // As production: tools read through the cached, action-aware gateway of this wiring.
    const wired = wireMessageActions({
      wahaGateway: gateway,
      db: openCacheDatabase(":memory:"),
      cipher,
      session: b.tenant.wahaSession,
      cache: opts.cache === false ? null : { refreshHours: 48, maxAgeDays: 0 },
    });
    return {
      tenantId: b.tenant.id,
      context: {
        gateway: wired.gateway,
        mapper: wired.mapper,
        config: b.config,
        links,
        transcription: DISABLED_TRANSCRIPTION,
        sender,
        uploads,
        uploadLinks,
        missions: null,
        schedules: null,
        messageActions: wired.messageActions,
      },
      media: createMediaHandler({ gateway, links, maxBytes: b.config.mediaMaxBytes }),
      upload: createUploadHandler({
        store: uploads,
        links: uploadLinks,
        maxBytes: b.config.uploadMaxBytes,
      }),
      missionLog: {} as never,
      scheduleLog: {} as never,
      cipher,
      close() {},
    };
  };
  const events: EventStore = createSqliteEventStore(authDb);
  let processor: CacheEventProcessor | null = null;
  const { app, registry } = composeApp({
    config,
    store,
    tenants,
    missions: createSqliteMissionStore(authDb),
    events,
    onWebhookEvent: () => processor?.wake(),
    sessions,
    mediaSecret: new Uint8Array(32).fill(3),
    logger: { info: () => {} },
    buildRuntime,
  });
  processor = composeCacheEventProcessor({ config, registry, events, logger: { info: () => {} } });
  if (!processor) throw new Error("webhooks must be on");
  const theProcessor = processor;
  closers.push(() => {
    theProcessor.stop();
    registry.closeAll();
    store.close();
  });
  const adminId = tenants.getAdmin()?.tenantId as string;
  return { app, events, processor: theProcessor, adminId, store, sender };
}

const request = (app: Hono, path: string, init?: RequestInit) =>
  app.fetch(new Request(`${BASE}${path}`, init));
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function login(app: Hono): Promise<Client> {
  const reg = await request(app, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"], client_name: "e2e" }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const auth = await request(
    app,
    "/authorize",
    form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://claude.ai/cb",
      state: "s",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "mcp",
      resource: `${BASE}/mcp`,
      username: "admin",
      password: PASSWORD,
    }),
  );
  const code = new URL(auth.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const tokenRes = await request(
    app,
    "/token",
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: "https://claude.ai/cb",
    }),
  );
  const { access_token: token } = (await tokenRes.json()) as { access_token: string };
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: async (url, init) => app.fetch(new Request(url, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

let evt = 0;
async function webhook(w: Awaited<ReturnType<typeof world>>, event: string, payload: object) {
  evt += 1;
  const body = JSON.stringify({
    id: `evt_cache_${evt}`,
    timestamp: Date.now(),
    event,
    session: "default",
    metadata: { tenant: w.adminId },
    payload,
  });
  const res = await request(w.app, "/webhooks/waha", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-hmac": createHmac("sha512", SECRET).update(body).digest("hex"),
    },
    body,
  });
  expect(res.status).toBe(200);
  await w.processor.idle();
}

interface Msg {
  id: string;
  type: string;
  text: string | null;
  reactions?: { emoji: string; by: string }[];
}
const messages = async (c: Client) =>
  ((await call(c, "get_messages", { chat_id: CHAT })).structuredContent?.messages ?? []) as Msg[];

describe("e2e: webhooks keep the message cache in sync", () => {
  it("a signed revoke shows the message as deleted and search stops finding it", async () => {
    const w = await world();
    const client = await login(w.app);
    expect((await messages(client))[0]?.text).toBe(SEC_TEXT);
    const hit = await call(client, "search_messages", { query: "quiet launch", chat_id: CHAT });
    expect(JSON.stringify(hit.structuredContent)).toContain("3EB0AAAA");

    await webhook(w, "message.revoked", { revokedMessageId: "3EB0AAAA", before: null });
    await w.processor.tick();

    const [msg] = await messages(client);
    expect(msg).toMatchObject({ type: "deleted", text: null });
    const after = await call(client, "search_messages", { query: "quiet launch", chat_id: CHAT });
    expect(JSON.stringify(after.structuredContent)).not.toContain("3EB0AAAA");
    expect(w.events.pending(10)).toHaveLength(0);
  });

  it("a signed reaction shows on the message", async () => {
    const w = await world();
    const client = await login(w.app);
    await messages(client);
    await webhook(w, "message.reaction", {
      id: "r1",
      timestamp: 1793286100,
      from: CHAT,
      fromMe: false,
      reaction: { text: "🔥", messageId: `false_${CHAT}_3EB0AAAA` },
    });
    const [msg] = await messages(client);
    expect(msg?.reactions).toEqual([{ emoji: "🔥", by: CHAT }]);
  });

  describe.each([true, false])("delete_message (cache %s)", (cache) => {
    it("deletes for everyone, then reads show it deleted and search finds nothing", async () => {
      const w = await world({ cache });
      const client = await login(w.app);
      expect((await messages(client))[0]?.text).toBe(SEC_TEXT);

      const r = await call(client, "delete_message", { message_id: `true_${CHAT}_3EB0AAAA` });
      expect(r.isError).toBeFalsy();
      expect(r.content[0]?.text).toContain("This cannot be undone.");
      expect(w.sender.calls).toEqual([
        {
          method: "deleteMessage",
          args: { chatId: CHAT, messageId: `true_${CHAT}_3EB0AAAA` },
        },
      ]);

      expect((await messages(client))[0]).toMatchObject({ type: "deleted", text: null });
      const hit = await call(client, "search_messages", { query: "quiet launch", chat_id: CHAT });
      expect(JSON.stringify(hit.structuredContent)).not.toContain("3EB0AAAA");
    });
  });
});
