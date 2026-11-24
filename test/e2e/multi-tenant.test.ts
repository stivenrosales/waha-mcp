import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DISABLED_TRANSCRIPTION } from "../../src/application/transcripts.js";
import { composeApp } from "../../src/composition.js";
import { type Config, loadConfig } from "../../src/config.js";
import type { EventStore } from "../../src/domain/ports/EventStore.js";
import type { TenantStore } from "../../src/domain/ports/TenantStore.js";
import { createAuthStore, openAuthDatabase } from "../../src/infrastructure/auth/store.js";
import { createCacheData } from "../../src/infrastructure/cache/cacheData.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../../src/infrastructure/cache/sqliteTranscriptStore.js";
import { createTenantCipher, type TenantCipher } from "../../src/infrastructure/crypto/envelope.js";
import {
  ADMIN_INSTRUCTIONS,
  OWNER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
} from "../../src/infrastructure/mcp/instructions.js";
import { createMediaHandler } from "../../src/infrastructure/media/mediaRoute.js";
import { MEDIA_GONE } from "../../src/infrastructure/media/resolveMedia.js";
import { createSignedLinks } from "../../src/infrastructure/media/signedLink.js";
import { createSqliteEventStore } from "../../src/infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "../../src/infrastructure/missions/sqliteMissionStore.js";
import { migrateToMultiTenant } from "../../src/infrastructure/tenants/migrate.js";
import type { TenantRegistry } from "../../src/infrastructure/tenants/registry.js";
import {
  type buildTenantRuntime,
  type TenantRuntime,
  wireMessageActions,
} from "../../src/infrastructure/tenants/runtime.js";
import { createSqliteTenantStore } from "../../src/infrastructure/tenants/sqliteTenantStore.js";
import { createFsUploadStore } from "../../src/infrastructure/uploads/fsUploadStore.js";
import { createUploadLinks } from "../../src/infrastructure/uploads/uploadLinks.js";
import { createUploadHandler } from "../../src/infrastructure/uploads/uploadRoute.js";
import { createEngineResolver } from "../../src/infrastructure/waha/engines/index.js";
import { FakeSessionAdmin } from "../fakes/FakeSessionAdmin.js";
import {
  type InMemoryData,
  InMemoryWahaGateway,
  RecordingSender,
  rawText,
} from "../fakes/InMemoryWahaGateway.js";

/**
 * Cross-tenant isolation through the real composition (`composeApp`): OAuth login with username
 * and password, the invite → pair onboarding, the admin tools, the per-tenant MCP server and the
 * `/media` and `/upload` routes. Each tenant runtime gets its own in-memory WAHA and sender, so a
 * test can prove which tenant's WhatsApp a call reached.
 */

const BASE = "http://localhost:3000";
const WAHA_URL = "http://waha-internal:3000";
const REDIRECT = "https://claude.ai/cb";
const ADMIN_PASSWORD = "correct horse battery";
const ADMIN_WA = "51900000001@c.us";
const MEDIA_SECRET = new Uint8Array(32).fill(3);
const TRUST_NOTICE =
  "Tus mensajes se guardan cifrados con una llave propia de tu cuenta y puedes borrarlos cuando quieras.";

type Raw = Record<string, unknown>;
const fixture = (path: string): Raw[] =>
  JSON.parse(readFileSync(`test/fixtures/${path}`, "utf8")) as Raw[];

const GROUP = "100000000000001953@g.us";
const DIRECT = "10000000000001@lid";
const A_CHAT = "51911111111@c.us";
const B_CHAT = "51922222222@c.us";

function withFileUrls(raws: Raw[], prefix: string): Raw[] {
  return raws.map((r, i) => {
    const media = r.media as Raw | null;
    return media ? { ...r, media: { ...media, url: `${WAHA_URL}/api/files/${prefix}-${i}` } } : r;
  });
}

/** Alice: a direct chat with media (index 2 is a 50-byte PDF) and a text chat. */
function aliceData(): InMemoryData {
  return {
    chats: [
      { id: DIRECT, name: null, conversationTimestamp: 1793317814 },
      { id: A_CHAT, name: null, conversationTimestamp: 1793286000 },
    ],
    contacts: [{ id: A_CHAT, name: "Alice friend" }],
    messages: {
      [DIRECT]: withFileUrls(fixture("gows-direct/messages-media-download.json"), "a"),
      [A_CHAT]: [rawText("A1", 1793286000, "alice secret", { chat: A_CHAT, sender: A_CHAT })],
    },
    media: {
      [`${WAHA_URL}/api/files/a-2`]: {
        bytes: new Uint8Array(50).fill(65),
        mimetype: "application/pdf",
      },
    },
    me: { id: "51911110000@c.us", lid: null },
  };
}

/** Bob: a group chat with media (index 2 is a large image) and a text chat. */
function bobData(): InMemoryData {
  return {
    chats: [{ id: B_CHAT, name: null, conversationTimestamp: 1793286500 }],
    contacts: [{ id: B_CHAT, name: "Bob friend" }],
    messages: {
      [GROUP]: withFileUrls(fixture("gows/messages-media-download.json"), "b"),
      [B_CHAT]: [rawText("B1", 1793286500, "bob note", { chat: B_CHAT, sender: B_CHAT })],
    },
    media: {
      [`${WAHA_URL}/api/files/b-2`]: {
        bytes: new Uint8Array(5000).fill(66),
        mimetype: "image/jpeg",
      },
    },
    me: { id: "51922220000@c.us", lid: null },
  };
}

const DATA: Record<string, () => InMemoryData> = {
  Alice: aliceData,
  Bob: bobData,
  Carol: () => ({
    chats: [{ id: "51933333333@c.us", name: null, conversationTimestamp: 1793287000 }],
    contacts: [{ id: "51933333333@c.us", name: "Carol friend" }],
  }),
};

interface Fakes {
  gateway: InMemoryWahaGateway;
  sender: RecordingSender;
  /** The `cache.db` of the tenant's latest runtime, and the tenant's cipher. */
  db?: DatabaseSync;
  cipher?: TenantCipher;
}

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-tenants-"));
  scratchDirs.push(dir);
  return dir;
};
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.unstubAllGlobals();
});
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const configFor = (dataDir: string, extra: Record<string, string> = {}): Config =>
  loadConfig({
    WAHA_API_URL: WAHA_URL,
    WAHA_API_KEY: "k-very-secret-waha-key",
    PUBLIC_BASE_URL: BASE,
    MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD,
    WAHA_SESSION: "default",
    TIMEZONE: "America/Lima",
    MEDIA_INLINE_MAX_BYTES: "1000",
    DATA_DIR: dataDir,
    ...extra,
  });

interface World {
  app: Hono;
  events: EventStore;
  configureWebhooks: () => Promise<void>;
  tenants: TenantStore;
  sessions: FakeSessionAdmin;
  registry: TenantRegistry;
  /** Per-tenant WAHA fakes, keyed by display name (created on the first runtime build). */
  fakes: Map<string, Fakes>;
  admin: Client;
  /** `ComposedApp.multiTenant` of this world. */
  multiTenant: boolean;
  /**
   * A second app composed over the same stores (a restart with other variables), with the
   * admin logged in to it.
   */
  restart(
    extra: Record<string, string>,
  ): Promise<{ app: Hono; multiTenant: boolean; admin: Client }>;
}

/**
 * Same shape as the production `buildTenantRuntime` (per-tenant links, uploads under
 * `DATA_DIR/tenants/<id>/uploads` sealed with the tenant's DEK), except that WAHA is an in-memory
 * gateway and sender owned by the tenant.
 */
function buildWith(fakes: Map<string, Fakes>): typeof buildTenantRuntime {
  return (b) => {
    let f = fakes.get(b.tenant.displayName);
    if (!f) {
      f = {
        gateway: new InMemoryWahaGateway(DATA[b.tenant.displayName]?.() ?? {}),
        sender: new RecordingSender(),
      };
      fakes.set(b.tenant.displayName, f);
    }
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
      cipher: createTenantCipher(b.dek, b.tenant.id),
    });
    // One `cache.db` per runtime, as production: message actions and cache data share it.
    const db = openCacheDatabase(":memory:");
    const cipher = createTenantCipher(b.dek, b.tenant.id);
    f.db = db;
    f.cipher = cipher;
    return {
      tenantId: b.tenant.id,
      context: {
        gateway: f.gateway,
        mapper: createEngineResolver(f.gateway),
        config: b.config,
        links,
        transcription: DISABLED_TRANSCRIPTION,
        sender: f.sender,
        uploads,
        uploadLinks,
        missions: null,
        schedules: null,
        messageActions: wireMessageActions({
          wahaGateway: f.gateway,
          db,
          cipher,
          session: b.tenant.wahaSession,
          cache: null,
        }).messageActions,
      },
      media: createMediaHandler({ gateway: f.gateway, links, maxBytes: b.config.mediaMaxBytes }),
      upload: createUploadHandler({
        store: uploads,
        links: uploadLinks,
        maxBytes: b.config.uploadMaxBytes,
      }),
      missionLog: {} as TenantRuntime["missionLog"],
      scheduleLog: {} as TenantRuntime["scheduleLog"],
      cipher,
      cacheData: createCacheData(db, cipher),
      close() {
        db.close();
      },
    };
  };
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields).toString(),
});

const request = (app: Hono, path: string, init?: RequestInit) =>
  app.fetch(new Request(path.startsWith("http") ? path : `${BASE}${path}`, init));

/** Dynamic registration, `/authorize` with username + password, then the PKCE code exchange. */
async function oauthLogin(
  app: Hono,
  username: string,
  password: string,
): Promise<{ status: number; token: string | null; page: string }> {
  const reg = await request(app, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "e2e" }),
  });
  expect(reg.status).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const res = await request(
    app,
    "/authorize",
    form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      resource: `${BASE}/mcp`,
      username,
      password,
    }),
  );
  if (res.status !== 302) return { status: res.status, token: null, page: await res.text() };
  const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const tokenRes = await request(
    app,
    "/token",
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    }),
  );
  expect(tokenRes.status).toBe(200);
  const { access_token: token } = (await tokenRes.json()) as { access_token: string };
  return { status: 302, token, page: "" };
}

async function connect(app: Hono, token: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

interface ToolResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
const sc = (r: ToolResult): Record<string, unknown> => r.structuredContent ?? {};
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const linkOf = (r: ToolResult) =>
  /(http:\/\/localhost:3000\/media\/[A-Za-z0-9_.-]+)/.exec(textOf(r))?.[1] as string;

/** A raw `tools/list` POST to /mcp with this bearer token (no MCP client retry logic). */
const rawMcp = (app: Hono, token: string) =>
  request(app, "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

/**
 * Admin tenant #1 seeded by the real migration (FakeSessionAdmin), then the composed app.
 * Multi-tenant unless `extra` sets `MULTI_TENANT` (a fresh install is single-owner by default).
 */
async function world(extra: Record<string, string> = {}): Promise<World> {
  const dataDir = scratch();
  const config = configFor(dataDir, { CACHE_ENABLED: "false", MULTI_TENANT: "true", ...extra });
  const authDb = openAuthDatabase(join(dataDir, "auth.db"));
  const store = createAuthStore(authDb);
  const tenants = createSqliteTenantStore(authDb);
  const sessions = new FakeSessionAdmin();
  sessions.setState("default", "WORKING");
  sessions.setMe("default", ADMIN_WA);
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
  const fakes = new Map<string, Fakes>();
  const events = createSqliteEventStore(authDb);
  const compose = (cfg: Config) =>
    composeApp({
      config: cfg,
      store,
      tenants,
      missions: createSqliteMissionStore(authDb),
      events,
      sessions,
      mediaSecret: MEDIA_SECRET,
      logger: { info: () => {} },
      buildRuntime: buildWith(fakes),
      mediaIdleTimeoutMs: 50,
    });
  const loginAdmin = async (app: Hono): Promise<Client> => {
    const login = await oauthLogin(app, "admin", ADMIN_PASSWORD);
    expect(login.status).toBe(302);
    return connect(app, login.token as string);
  };
  const { app, registry, configureWebhooks, multiTenant } = compose(config);
  const registries = [registry];
  closers.push(() => {
    for (const r of registries) r.closeAll();
    store.close();
  });
  const admin = await loginAdmin(app);
  const restart = async (more: Record<string, string>) => {
    const again = compose(configFor(dataDir, { CACHE_ENABLED: "false", ...more }));
    registries.push(again.registry);
    return { app: again.app, multiTenant: again.multiTenant, admin: await loginAdmin(again.app) };
  };
  return {
    app,
    events,
    configureWebhooks,
    tenants,
    sessions,
    registry,
    fakes,
    admin,
    multiTenant,
    restart,
  };
}

interface Member {
  tenantId: string;
  username: string;
  password: string;
  client: Client;
  token: string;
}

/**
 * The full onboarding of a new tenant: `create_invite` by the admin, the invite page (username +
 * password, same-origin POST), `/pair` with the pairing cookie (QR while SCAN_QR_CODE, then
 * WORKING), and an OAuth login as the new user. `checks` asserts every intermediate state.
 */
async function onboard(
  w: World,
  displayName: string,
  waId: string,
  checks = false,
): Promise<Member> {
  const invite = await call(w.admin, "create_invite", { display_name: displayName });
  expect(invite.isError).toBeFalsy();
  const { tenantId, url } = sc(invite) as { tenantId: string; url: string };
  expect(url).toMatch(new RegExp(`^${BASE}/invite/[A-Za-z0-9_-]+$`));
  const tenant = w.tenants.getTenant(tenantId);
  expect(tenant?.status).toBe("invited");
  const session = tenant?.wahaSession as string;
  expect(session).toMatch(/^t_[a-z2-7]{10}$/);
  expect(w.sessions.calls).toContain(`create:${session}`);

  const page = await request(w.app, url);
  expect(page.status).toBe(200);
  if (checks) expect(await page.text()).toContain(TRUST_NOTICE);

  const username = displayName.toLowerCase();
  const password = `${displayName} long password 1`;
  const signup = await request(
    w.app,
    url,
    form({ username, password, password_confirm: password }, { origin: BASE }),
  );
  expect(signup.status).toBe(303);
  expect(signup.headers.get("location")).toBe(`${BASE}/pair`);
  expect(w.tenants.getTenant(tenantId)?.status).toBe("pairing");
  const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0] as string;
  expect(cookie).toMatch(/^waha_pair=/);

  if (checks) {
    // Single use: a second sign-up through the same link is refused.
    const again = await request(
      w.app,
      url,
      form({ username: "other", password, password_confirm: password }, { origin: BASE }),
    );
    expect(again.status).toBe(410);
    // Not active yet: OAuth login is refused until WhatsApp is paired.
    const early = await oauthLogin(w.app, username, password);
    expect(early.status).toBe(403);
    expect(early.page).toContain(`${BASE}/pair`);
  }

  w.sessions.setState(session, "SCAN_QR_CODE");
  const qr = await request(w.app, "/pair", { headers: { cookie } });
  expect(qr.status).toBe(200);
  const qrPage = await qr.text();
  expect(qrPage).toContain("data:image/png;base64,ZmFrZS1xcg==");
  if (checks) expect(qrPage).toContain(TRUST_NOTICE);
  expect(w.tenants.getTenant(tenantId)?.status).toBe("pairing");

  w.sessions.setState(session, "WORKING");
  w.sessions.setMe(session, waId);
  const done = await request(w.app, "/pair", { headers: { cookie } });
  expect(done.status).toBe(200);
  expect(w.tenants.getTenant(tenantId)).toMatchObject({ status: "active", waId });

  const login = await oauthLogin(w.app, username, password);
  expect(login.status).toBe(302);
  const token = login.token as string;
  return { tenantId, username, password, token, client: await connect(w.app, token) };
}

async function mediaIds(client: Client, chatId: string): Promise<string[]> {
  const r = await call(client, "get_messages", { chat_id: chatId, limit: 200 });
  const messages = (sc(r).messages ?? []) as { attachment: { mediaId: string | null } | null }[];
  return messages.filter((m) => m.attachment !== null).map((m) => m.attachment?.mediaId as string);
}

/** Rewrites the `t` claim of a link token, keeping its signature. */
function retarget(link: string, tenantId: string): string {
  const token = link.split("/").pop() as string;
  const [payload, sig] = token.split(".") as [string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Raw;
  const forged = Buffer.from(JSON.stringify({ ...claims, t: tenantId })).toString("base64url");
  return `${link.slice(0, link.length - token.length)}${forged}.${sig}`;
}

const ADMIN_TOOLS = [
  "create_invite",
  "delete_tenant",
  "list_tenants",
  "reset_password",
  "restore_tenant",
  "revoke_tenant",
];

describe("e2e: tenant isolation through the composed app", () => {
  it("onboards a new tenant: invite → pair → OAuth login → list_chats of its own WhatsApp", async () => {
    const w = await world();
    const carol = await onboard(w, "Carol", "51933330000@c.us", true);
    const chats = await call(carol.client, "list_chats");
    expect(chats.isError).toBeFalsy();
    const ids = (sc(chats).chats as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(["51933333333@c.us"]);
    // The admin sees the new tenant as active.
    const listed = sc(await call(w.admin, "list_tenants")) as {
      tenants: { id: string; status: string }[];
    };
    expect(listed.tenants.find((t) => t.id === carol.tenantId)?.status).toBe("active");
  });

  it("only the admin gets the admin tools; a member's direct call of list_tenants fails", async () => {
    const w = await world();
    const bob = await onboard(w, "Bob", "51922220000@c.us");
    const adminTools = (await w.admin.listTools()).tools.map((t) => t.name);
    const memberTools = (await bob.client.listTools()).tools.map((t) => t.name);
    for (const name of ADMIN_TOOLS) {
      expect(adminTools).toContain(name);
      expect(memberTools).not.toContain(name);
    }
    let outcome: string;
    try {
      const r = await call(bob.client, "list_tenants");
      outcome = r.isError ? `error: ${textOf(r)}` : `ok: ${textOf(r)}`;
    } catch (error) {
      outcome = `error: ${String(error)}`;
    }
    expect(outcome).toMatch(/^error:/);
    expect(outcome).not.toContain("Bob");
    expect(outcome).not.toContain(bob.tenantId);
  });

  it("member B cannot read A's chats, messages or media by id; only B's WAHA is ever called", async () => {
    const w = await world();
    const alice = await onboard(w, "Alice", "51911110000@c.us");
    const bob = await onboard(w, "Bob", "51922220000@c.us");
    const aGateway = w.fakes.get("Alice")?.gateway as InMemoryWahaGateway;
    const bGateway = w.fakes.get("Bob")?.gateway as InMemoryWahaGateway;

    const aliceMedia = await mediaIds(alice.client, DIRECT);
    const pdf = aliceMedia[2] as string;
    expect(pdf).toBeTruthy();
    const aliceMessage = (
      sc(await call(alice.client, "get_messages", { chat_id: A_CHAT })).messages as { id: string }[]
    )[0]?.id as string;
    const aCalls = aGateway.calls.length;

    // list_chats: B sees its own chats only.
    const bChats = (sc(await call(bob.client, "list_chats")).chats as { id: string }[]).map(
      (c) => c.id,
    );
    expect(bChats).toEqual([B_CHAT]);

    // get_messages with A's chat id: B's WAHA has no such chat, nothing of A's comes back.
    for (const chat of [A_CHAT, DIRECT]) {
      const r = await call(bob.client, "get_messages", { chat_id: chat });
      expect(r.isError).toBeFalsy();
      expect(sc(r).messages).toEqual([]);
      expect(JSON.stringify(r)).not.toContain("alice secret");
    }

    // get_thread with A's message id: not found in B's WAHA.
    const thread = await call(bob.client, "get_thread", {
      chat_id: A_CHAT,
      message_id: aliceMessage,
    });
    expect(thread.isError).toBe(true);
    expect(textOf(thread)).toMatch(/not found/i);

    // get_media with A's media id: B's WAHA does not have that message.
    const media = await call(bob.client, "get_media", { media_id: pdf });
    expect(linkOf(media)).toBeUndefined();
    expect(media.content.some((c) => c.type === "image")).toBe(false);
    expect(textOf(media)).toBe(MEDIA_GONE);

    // search_messages for A's text: nothing.
    const search = await call(bob.client, "search_messages", { query: "alice secret" });
    expect(sc(search)).toMatchObject({ totalMatches: 0, hits: [] });

    expect(aGateway.calls.length).toBe(aCalls);
    expect(aGateway.bodyReads.size).toBe(0);
    expect(bGateway.calls.some((c) => c.method === "getMessages")).toBe(true);
    expect(bGateway.calls.filter((c) => c.method === "getMessage").map((c) => c.args[0])).toEqual([
      DIRECT,
    ]);
  });

  it("A's media link works for A, and 404s (like any bad link) when its tenant claim names B", async () => {
    const w = await world();
    const alice = await onboard(w, "Alice", "51911110000@c.us");
    const bob = await onboard(w, "Bob", "51922220000@c.us");
    const pdf = (await mediaIds(alice.client, DIRECT))[2] as string;
    const link = linkOf(await call(alice.client, "get_media", { media_id: pdf }));
    expect(link).toBeDefined();

    // Valid for A, even with B active next to it.
    const ok = await request(w.app, link);
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array(50).fill(65));

    const forged = retarget(link, bob.tenantId);
    expect(forged).not.toBe(link);
    const tampered = await request(w.app, forged);
    const unknown = await request(w.app, `${BASE}/media/not.valid`);
    expect(tampered.status).toBe(404);
    // Uniform: same status and body as a link that names no tenant at all.
    expect(await tampered.text()).toBe(await unknown.text());
    // The edited token dies at the signature check: B's WAHA is not even asked.
    const aGateway = w.fakes.get("Alice")?.gateway as InMemoryWahaGateway;
    const bGateway = w.fakes.get("Bob")?.gateway as InMemoryWahaGateway;
    expect(bGateway.calls.filter((c) => c.method === "getMessage")).toEqual([]);

    // A correctly signed token for tenant B carrying A's media id: routed to B's runtime, which
    // looks the id up in B's WhatsApp only and finds nothing.
    const bLinks = createSignedLinks({
      secret: MEDIA_SECRET,
      ttlSeconds: 60,
      tenantId: bob.tenantId,
    });
    const aCalls = aGateway.calls.length;
    const aReads = new Map(aGateway.bodyReads);
    const resigned = await request(w.app, `${BASE}/media/${bLinks.sign(pdf)}`);
    expect(resigned.status).toBe(404);
    expect(await resigned.text()).toBe(
      await (await request(w.app, `${BASE}/media/not.valid`)).text(),
    );
    // Exactly one lookup, in B's gateway, for A's chat (the chat half of A's media id).
    expect(bGateway.calls.filter((c) => c.method === "getMessage").map((c) => c.args[0])).toEqual([
      DIRECT,
    ]);
    expect(aGateway.calls.length).toBe(aCalls);
    expect(aGateway.bodyReads).toEqual(aReads);

    // The same for A's upload links: edited claim, then a correctly signed B token for A's slot.
    const slot = sc(await call(alice.client, "create_upload_link", { filename: "a.txt" })) as {
      upload_id: string;
      upload_url: string;
    };
    const forgedUpload = retarget(slot.upload_url, bob.tenantId);
    expect((await request(w.app, forgedUpload, { method: "PUT", body: "x" })).status).toBe(404);
    const bUploadLinks = createUploadLinks(MEDIA_SECRET, 60, bob.tenantId);
    const resignedUpload = `${BASE}/upload/${bUploadLinks.sign(slot.upload_id)}`;
    expect((await request(w.app, resignedUpload)).status).toBe(404);
    expect((await request(w.app, resignedUpload, { method: "PUT", body: "x" })).status).toBe(404);
    // A's slot was not touched by B's runtime: still empty, and A's own link fills it once.
    expect((await request(w.app, slot.upload_url, { method: "PUT", body: "x" })).status).toBe(200);
  });

  it("B's send tools reach only B's sender, even with A's chat, media and upload ids", async () => {
    const w = await world();
    const alice = await onboard(w, "Alice", "51911110000@c.us");
    const bob = await onboard(w, "Bob", "51922220000@c.us");
    const aFakes = w.fakes.get("Alice") as Fakes;
    const bFakes = w.fakes.get("Bob") as Fakes;
    const pdf = (await mediaIds(alice.client, DIRECT))[2] as string;
    const aliceUpload = sc(
      await call(alice.client, "create_upload_link", { filename: "a.pdf" }),
    ) as {
      upload_id: string;
      upload_url: string;
    };
    expect(
      (await request(w.app, aliceUpload.upload_url, { method: "PUT", body: "%PDF" })).status,
    ).toBe(200);
    const aCalls = aFakes.gateway.calls.length;

    const text = await call(bob.client, "send_text", { chat_id: A_CHAT, text: "hola" });
    expect(text.isError).toBeFalsy();
    expect(
      await call(bob.client, "send_location", { chat_id: A_CHAT, latitude: 1, longitude: 2 }),
    ).not.toHaveProperty("isError", true);

    const forward = await call(bob.client, "send_media", { chat_id: A_CHAT, media_id: pdf });
    expect(forward.isError).toBe(true);
    // A's media id is unknown to B's WAHA (B's gateway looked it up, A's was not asked).
    expect(textOf(forward)).toContain(MEDIA_GONE);
    expect(
      bFakes.gateway.calls.filter((c) => c.method === "getMessage").map((c) => c.args[0]),
    ).toEqual([DIRECT]);
    const reuse = await call(bob.client, "send_media", {
      chat_id: A_CHAT,
      upload_id: aliceUpload.upload_id,
    });
    expect(reuse.isError).toBe(true);
    // B's upload store has no such slot.
    expect(textOf(reuse)).toContain(
      "This upload was already sent or has expired. Create a new upload link.",
    );

    expect(bFakes.sender.calls.map((c) => c.method)).toEqual(["sendText", "sendLocation"]);
    expect(aFakes.sender.calls).toEqual([]);
    expect(aFakes.gateway.calls.length).toBe(aCalls);
    // A's upload is untouched and still sendable by A.
    const own = await call(alice.client, "send_media", {
      chat_id: A_CHAT,
      upload_id: aliceUpload.upload_id,
    });
    expect(own.isError).toBeFalsy();
    expect(aFakes.sender.calls.map((c) => c.method)).toEqual(["sendFile"]);
  });

  it("revoke_tenant(B): B's next /mcp call is 401 and its media and upload links 404; A is unaffected", async () => {
    const w = await world();
    const alice = await onboard(w, "Alice", "51911110000@c.us");
    const bob = await onboard(w, "Bob", "51922220000@c.us");
    const bobImage = (await mediaIds(bob.client, GROUP))[2] as string;
    const bobLink = linkOf(await call(bob.client, "get_media", { media_id: bobImage }));
    expect((await request(w.app, bobLink)).status).toBe(200);
    const bobUpload = sc(await call(bob.client, "create_upload_link", { filename: "b.txt" })) as {
      upload_url: string;
    };
    expect((await request(w.app, bobUpload.upload_url)).status).toBe(200);
    const alicePdf = (await mediaIds(alice.client, DIRECT))[2] as string;
    const aliceLink = linkOf(await call(alice.client, "get_media", { media_id: alicePdf }));
    expect((await rawMcp(w.app, bob.token)).status).toBe(200);

    const revoked = await call(w.admin, "revoke_tenant", { tenant_id: bob.tenantId });
    expect(revoked.isError).toBeFalsy();

    // Mid-session: the already connected client's next call fails, and the raw POST is 401.
    await expect(bob.client.listTools()).rejects.toThrow();
    const res = await rawMcp(w.app, bob.token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    expect((await request(w.app, bobLink)).status).toBe(404);
    expect((await request(w.app, bobUpload.upload_url)).status).toBe(404);
    expect((await request(w.app, bobUpload.upload_url, { method: "PUT", body: "x" })).status).toBe(
      404,
    );
    // And B cannot sign in again.
    expect((await oauthLogin(w.app, bob.username, bob.password)).status).toBe(403);

    // A keeps working.
    expect((await call(alice.client, "list_chats")).isError).toBeFalsy();
    expect((await request(w.app, aliceLink)).status).toBe(200);
  });
});

describe("e2e: self-service deletion and unlink are scoped to the caller", () => {
  /** Seeds one cached message and one transcript into the tenant's runtime `cache.db`. */
  function seed(f: Fakes | undefined, chatId: string, id: string): void {
    if (!f?.db || !f.cipher) throw new Error("runtime not built yet");
    createSqliteMessageStore(f.db, f.cipher).upsertRaw(chatId, [
      { id, ts: Math.floor(Date.now() / 1000), raw: { id, body: "secreto" } },
    ]);
    createSqliteTranscriptStore(f.db, f.cipher).put(chatId, id, "nota de voz");
  }
  const cached = (f: Fakes | undefined, chatId: string) => {
    if (!f?.db || !f.cipher) throw new Error("runtime not built yet");
    return {
      messages: createSqliteMessageStore(f.db, f.cipher).countRange(chatId, {}),
      transcripts: Number(
        (f.db.prepare("SELECT COUNT(*) AS n FROM transcripts").get() as { n: number }).n,
      ),
    };
  };

  it("delete_my_data wipes only the caller's cache; another tenant's data survives", async () => {
    const w = await world();
    const alice = await onboard(w, "Alice", "51911110000@c.us");
    const bob = await onboard(w, "Bob", "51922220000@c.us");
    seed(w.fakes.get("Alice"), A_CHAT, "true_A_1");
    seed(w.fakes.get("Bob"), B_CHAT, "true_B_1");

    const refused = await call(alice.client, "delete_my_data", { confirm: false });
    expect(refused.isError).toBe(true);
    expect(cached(w.fakes.get("Alice"), A_CHAT)).toEqual({ messages: 1, transcripts: 1 });

    const done = await call(alice.client, "delete_my_data", { confirm: true });
    expect(done.isError).toBeFalsy();
    expect(sc(done)).toMatchObject({ messages: 1, transcripts: 1 });
    expect(cached(w.fakes.get("Alice"), A_CHAT)).toEqual({ messages: 0, transcripts: 0 });
    expect(cached(w.fakes.get("Bob"), B_CHAT)).toEqual({ messages: 1, transcripts: 1 });
    // Deleting data is not signing out: both keep working.
    expect((await call(alice.client, "list_chats")).isError).toBeFalsy();
    expect((await call(bob.client, "list_chats")).isError).toBeFalsy();
  });

  it("unlink_account logs out only the caller's WhatsApp and tokens; the other tenant is unaffected", async () => {
    const w = await world();
    const alice = await onboard(w, "Alice", "51911110000@c.us");
    const bob = await onboard(w, "Bob", "51922220000@c.us");
    const aliceSession = w.tenants.getTenant(alice.tenantId)?.wahaSession as string;
    const bobSession = w.tenants.getTenant(bob.tenantId)?.wahaSession as string;
    seed(w.fakes.get("Alice"), A_CHAT, "true_A_1");

    const done = await call(bob.client, "unlink_account", { confirm: true });
    expect(done.isError).toBeFalsy();
    expect(sc(done)).toEqual({ whatsapp: "logged_out", signedOut: true });
    expect(w.sessions.calls).toContain(`logout:${bobSession}`);
    expect(w.sessions.calls).not.toContain(`logout:${aliceSession}`);
    expect((await rawMcp(w.app, bob.token)).status).toBe(401);
    // Bob's account stays active: he can sign in again (e.g. at /pair to re-link WhatsApp).
    expect(w.tenants.getTenant(bob.tenantId)?.status).toBe("active");
    expect((await oauthLogin(w.app, bob.username, bob.password)).status).toBe(302);

    expect((await rawMcp(w.app, alice.token)).status).toBe(200);
    expect((await call(alice.client, "list_chats")).isError).toBeFalsy();
    expect(cached(w.fakes.get("Alice"), A_CHAT)).toEqual({ messages: 1, transcripts: 1 });
  });
});

const TENANT_TOOLS = [
  "create_invite",
  "delete_tenant",
  "list_tenants",
  "reset_password",
  "restore_tenant",
  "revoke_tenant",
];
const USAGE_TOOLS = ["get_llm_usage", "get_tool_usage", "get_transcription_usage"];
const INVALID_LINK = "Enlace no válido";

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

describe("e2e: single-owner by default (MULTI_TENANT)", () => {
  it("a fresh install with MULTI_TENANT unset serves the owner only: usage tools, no invites", async () => {
    const w = await world({ MULTI_TENANT: "" });
    expect(w.multiTenant).toBe(false);
    const names = await toolNames(w.admin);
    for (const name of USAGE_TOOLS) expect(names).toContain(name);
    for (const name of TENANT_TOOLS) expect(names).not.toContain(name);
    expect(names).toContain("list_chats");
    expect(w.admin.getInstructions()).toBe(`${SERVER_INSTRUCTIONS}\n\n${OWNER_INSTRUCTIONS}`);
    await expect(call(w.admin, "create_invite", { display_name: "Alice" })).rejects.toThrow(
      "Tool create_invite not found",
    );
    expect(w.tenants.listTenants()).toHaveLength(1);

    // An invite link that exists in the store (left from a multi-tenant period) is refused.
    const tenant = w.tenants.createTenant({
      displayName: "Alice",
      wahaSession: "t_aaaaaaaaaa",
      wrappedDek: "pending",
    });
    const { token } = w.tenants.issueLink(tenant.id, "invite", 60_000);
    const page = await request(w.app, `/invite/${token}`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain(INVALID_LINK);
    const password = "Alice long password 1";
    const signup = await request(
      w.app,
      `/invite/${token}`,
      form({ username: "alice", password, password_confirm: password }, { origin: BASE }),
    );
    expect(signup.status).toBe(404);
    expect(await signup.text()).toContain(INVALID_LINK);
    expect(w.tenants.getTenant(tenant.id)?.status).toBe("invited");
    expect(w.tenants.getUserByTenant(tenant.id)).toBeNull();
    expect(w.tenants.linkState(token, "invite")?.state).toBe("valid");
  });

  it("MULTI_TENANT=true on a fresh install lists the tenant tools and their instructions", async () => {
    const w = await world({ MULTI_TENANT: "true" });
    expect(w.multiTenant).toBe(true);
    const names = await toolNames(w.admin);
    for (const name of [...USAGE_TOOLS, ...TENANT_TOOLS]) expect(names).toContain(name);
    expect(w.admin.getInstructions()).toBe(`${SERVER_INSTRUCTIONS}\n\n${ADMIN_INSTRUCTIONS}`);
  });

  it("MULTI_TENANT unset keeps a server that already has members multi-tenant", async () => {
    const w = await world({ MULTI_TENANT: "true" });
    await onboard(w, "Alice", "51911110000@c.us");
    const again = await w.restart({});
    expect(again.multiTenant).toBe(true);
    const names = await toolNames(again.admin);
    for (const name of TENANT_TOOLS) expect(names).toContain(name);
    const invite = await call(again.admin, "create_invite", { display_name: "Bob" });
    expect(invite.isError).toBeFalsy();
    const { url } = sc(invite) as { url: string };
    expect((await request(again.app, url)).status).toBe(200);
  });

  it("MULTI_TENANT=false forces single-owner on a server with members; members keep working", async () => {
    const w = await world({ MULTI_TENANT: "true" });
    const alice = await onboard(w, "Alice", "51911110000@c.us");
    const again = await w.restart({ MULTI_TENANT: "false" });
    expect(again.multiTenant).toBe(false);
    const names = await toolNames(again.admin);
    for (const name of TENANT_TOOLS) expect(names).not.toContain(name);
    for (const name of USAGE_TOOLS) expect(names).toContain(name);
    const member = await connect(again.app, alice.token);
    const chats = await call(member, "list_chats");
    expect(chats.isError).toBeFalsy();
    expect(textOf(chats)).toContain("Alice friend");
  });
});

describe("e2e: WAHA webhooks for missions", () => {
  const SECRET = "whsec-e2e-secret";
  const MISSIONS = { OPENROUTER_API_KEY: "or-key", WAHA_WEBHOOK_SECRET: SECRET };
  const signed = (body: string, key = SECRET): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-hmac": createHmac("sha512", key).update(body).digest("hex"),
    },
    body,
  });
  const envelope = (adminTenantId: string) =>
    JSON.stringify({
      id: "evt_e2e_1",
      timestamp: Date.now(),
      event: "message.any",
      session: "default",
      metadata: { tenant: adminTenantId },
      payload: { id: "m1", from: A_CHAT, fromMe: false, source: "app", body: "hola" },
    });

  it("without missions the route is not mounted (404) and the app works as before", async () => {
    const w = await world();
    const adminId = w.tenants.getAdmin()?.tenantId as string;
    const res = await request(w.app, "/webhooks/waha", signed(envelope(adminId)));
    expect(res.status).toBe(404);
    expect(w.events.pending(10)).toHaveLength(0);
    await w.configureWebhooks();
    expect(w.sessions.calls.some((c) => c.startsWith("configureWebhook:"))).toBe(false);
    expect((await request(w.app, "/health")).status).toBe(200);
    const chats = await call(w.admin, "list_chats");
    expect(chats.isError).toBeFalsy();
  });

  it("with only the secret the route exists and startup configures WAHA (no missions)", async () => {
    const w = await world({ WAHA_WEBHOOK_SECRET: SECRET });
    const adminId = w.tenants.getAdmin()?.tenantId as string;
    const body = JSON.stringify({
      id: "evt_e2e_status",
      timestamp: Date.now(),
      event: "message.revoked",
      session: "default",
      metadata: { tenant: adminId },
      payload: { revokedMessageId: "3EB0AAAA" },
    });
    expect((await request(w.app, "/webhooks/waha", signed(body, "wrong"))).status).toBe(401);
    expect((await request(w.app, "/webhooks/waha", signed(body))).status).toBe(200);
    expect(w.events.pending(10).map((e) => [e.eventId, e.kind])).toEqual([
      ["evt_e2e_status", "message.revoked"],
    ]);
    await w.configureWebhooks();
    expect(w.sessions.calls.filter((c) => c.startsWith("configureWebhook:"))).toEqual([
      "configureWebhook:default",
    ]);
    expect(w.sessions.webhooks.get("default")).toEqual({
      url: `${BASE}/webhooks/waha`,
      secret: SECRET,
    });
  });

  it("with missions a signed event for an active tenant is stored once; startup configures WAHA", async () => {
    const w = await world(MISSIONS);
    const adminId = w.tenants.getAdmin()?.tenantId as string;
    const body = envelope(adminId);
    expect((await request(w.app, "/webhooks/waha", signed(body, "wrong"))).status).toBe(401);
    expect((await request(w.app, "/webhooks/waha", signed(body))).status).toBe(200);
    expect((await request(w.app, "/webhooks/waha", signed(body))).status).toBe(200);
    const stored = w.events.pending(10);
    expect(stored.map((e) => [e.tenantId, e.eventId, e.kind])).toEqual([
      [adminId, "evt_e2e_1", "message"],
    ]);
    expect(stored[0]?.payloadSealed).not.toContain("hola");

    await w.configureWebhooks();
    expect(w.sessions.calls.filter((c) => c.startsWith("configureWebhook:"))).toEqual([
      "configureWebhook:default",
    ]);
    expect(w.sessions.webhooks.get("default")).toEqual({
      url: `${BASE}/webhooks/waha`,
      secret: SECRET,
    });
    // The rest of the app is unaffected.
    expect((await call(w.admin, "list_chats")).isError).toBeFalsy();
  });
});

describe("e2e: a 0.3.0 DATA_DIR keeps its message cache", () => {
  const CHAT = "51999000111@c.us";

  /** Minimal WAHA for the real runtime: session, me, and no new messages for the chat. */
  function fakeWaha(calls: string[]) {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    return async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.pathname);
      if (url.origin !== WAHA_URL) return new Response("unexpected", { status: 599 });
      if (url.pathname === "/api/sessions/default")
        return json({
          name: "default",
          status: "WORKING",
          engine: { engine: "GOWS" },
          me: { id: ADMIN_WA },
        });
      if (url.pathname === "/api/sessions/default/me") return json({ id: ADMIN_WA });
      if (url.pathname === `/api/default/chats/${encodeURIComponent(CHAT)}/messages`)
        return json([]);
      return new Response("not found", { status: 404 });
    };
  }

  it("migration and the admin's first tool call keep the cached rows (0.3.0 owner `<session>|<meId>`)", async () => {
    const dataDir = scratch();
    // As 0.3.0 left it: plaintext rows and the owner identity `${WAHA_SESSION}|${meId}`.
    const now = Math.floor(Date.now() / 1000);
    const legacy = openCacheDatabase(join(dataDir, "cache.db"));
    const insert = legacy.prepare(
      "INSERT INTO messages (chat_id, id, ts, raw) VALUES (?, ?, ?, ?)",
    );
    const texts = ["primer mensaje", "segundo mensaje", "tercer mensaje"];
    texts.forEach((text, i) => {
      const raw = rawText(`L${i}`, now - 3600 * (i + 1), text, { chat: CHAT, sender: CHAT });
      insert.run(CHAT, raw.id as string, raw.timestamp as number, JSON.stringify(raw));
    });
    legacy.prepare("INSERT INTO meta (key, value) VALUES ('owner', ?)").run(`default|${ADMIN_WA}`);
    legacy.close();

    const config = configFor(dataDir, { CACHE_ENABLED: "true" });
    const authDb = openAuthDatabase(join(dataDir, "auth.db"));
    const store = createAuthStore(authDb);
    const tenants = createSqliteTenantStore(authDb);
    const sessions = new FakeSessionAdmin();
    sessions.setMe("default", ADMIN_WA);
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
    const adminTenant = tenants.getTenant(tenants.getAdmin()?.tenantId as string);
    expect(adminTenant?.wahaSession).toBe("default");
    const cacheFile = join(dataDir, "tenants", adminTenant?.id as string, "cache.db");
    const inspect = () => {
      const db = new DatabaseSync(cacheFile, { readOnly: true });
      try {
        const count = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
        const owner = (
          db.prepare("SELECT value FROM meta WHERE key = 'owner'").get() as { value: string }
        ).value;
        return { count, owner };
      } finally {
        db.close();
      }
    };
    expect(inspect()).toEqual({ count: 3, owner: `default|${ADMIN_WA}` });

    // The real tenant runtime (cache + HTTP gateway) against a fake WAHA.
    const wahaCalls: string[] = [];
    vi.stubGlobal("fetch", fakeWaha(wahaCalls));
    const { app, registry } = composeApp({
      config,
      store,
      tenants,
      missions: createSqliteMissionStore(authDb),
      sessions,
      mediaSecret: MEDIA_SECRET,
      logger: { info: () => {} },
    });
    closers.push(() => {
      registry.closeAll();
      store.close();
    });
    const login = await oauthLogin(app, "admin", ADMIN_PASSWORD);
    expect(login.status).toBe(302);
    const admin = await connect(app, login.token as string);

    const r = await call(admin, "get_messages", { chat_id: CHAT });
    expect(r.isError).toBeFalsy();
    const got = (sc(r).messages as { text: string | null }[]).map((m) => m.text);
    // WAHA returned nothing for the chat: these come from the migrated cache.
    expect(got).toEqual(texts);
    expect(wahaCalls).toContain("/api/sessions/default/me");

    registry.closeAll();
    expect(inspect()).toEqual({ count: 3, owner: `default|${ADMIN_WA}` });
  });
});
