import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { createCachedGateway } from "../../src/application/cachedMessages.js";
import {
  createTranscriptionService,
  type TranscriptionService,
} from "../../src/application/transcripts.js";
import { loadConfig } from "../../src/config.js";
import { WahaAuthError } from "../../src/domain/errors.js";
import { bearerGuard } from "../../src/infrastructure/auth/bearer.js";
import { createOAuthRoutes } from "../../src/infrastructure/auth/oauth.js";
import { createLoginLimiter } from "../../src/infrastructure/auth/rateLimit.js";
import { createAuthStore } from "../../src/infrastructure/auth/store.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../../src/infrastructure/cache/sqliteTranscriptStore.js";
import { createApp } from "../../src/infrastructure/http/app.js";
import { SERVER_INSTRUCTIONS } from "../../src/infrastructure/mcp/instructions.js";
import { createMcpServer } from "../../src/infrastructure/mcp/server.js";
import { createTools } from "../../src/infrastructure/mcp/tools/index.js";
import { createMediaHandler } from "../../src/infrastructure/media/mediaRoute.js";
import { createSignedLinks } from "../../src/infrastructure/media/signedLink.js";
import { createOpenAiCompatibleTranscriber } from "../../src/infrastructure/transcription/openaiCompatible.js";
import { createWahaAudioSource } from "../../src/infrastructure/transcription/wahaAudioSource.js";
import {
  type InMemoryData,
  InMemoryWahaGateway,
  rawText,
  rawVoice,
} from "../fakes/InMemoryWahaGateway.js";

/**
 * End to end: the official MCP client talks to `createApp` (OAuth bearer guard,
 * stateless MCP handler, signed media links) through an in-process fetch. WAHA is
 * the in-memory gateway backed by the real scrubbed GOWS fixtures.
 */

const BASE = "http://localhost:3000";
const WAHA_URL = "http://waha-internal:3000";
const KEY = "k-very-secret-waha-key";
const INLINE_MAX = 1000;
const MAX_BYTES = 5000;
/** Idle timeout for media bodies; production uses 30 s. */
const IDLE_MS = 50;

type Raw = Record<string, unknown>;
const fixture = (path: string): Raw[] =>
  JSON.parse(readFileSync(`test/fixtures/${path}`, "utf8")) as Raw[];

const GROUP = "100000000000001953@g.us";
const DIRECT = "10000000000001@lid";

/** Fixtures carry a scrubbed `<url>`; give every media message its own WAHA file path. */
function withFileUrls(raws: Raw[], prefix: string): Raw[] {
  return raws.map((r, i) => {
    const media = r.media as Raw | null;
    return media ? { ...r, media: { ...media, url: `${WAHA_URL}/api/files/${prefix}-${i}` } } : r;
  });
}

/** Removes `fileLength` so the message itself does not declare a size. */
function withoutFileLength(raw: Raw): Raw {
  const copy = structuredClone(raw) as {
    _data: { Message: Record<string, Record<string, unknown>> };
  };
  for (const content of Object.values(copy._data.Message)) delete content.fileLength;
  return copy as unknown as Raw;
}

const groupMedia = withFileUrls(fixture("gows/messages-media-download.json"), "g").map((r, i) =>
  i === 3 ? withoutFileLength(r) : r,
);
const directMedia = withFileUrls(fixture("gows-direct/messages-media-download.json"), "d");
const groupText = fixture("gows/messages-text-download.json");

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

function baseData(): InMemoryData {
  return {
    groups: fixture("gows/groups.json"),
    groupDetails: { [GROUP]: JSON.parse(readFileSync("test/fixtures/gows/group.json", "utf8")) },
    chats: [
      { id: DIRECT, name: null, conversationTimestamp: 1793317814 },
      { id: "51999000111@c.us", name: null, conversationTimestamp: 1793286000 },
      { id: GROUP, name: "Group", conversationTimestamp: 1793373071 },
      { id: "123@newsletter", name: "News" },
    ],
    contacts: [{ id: "51999000111@c.us", name: "Ana", pushname: "ana" }],
    lids: { "10000000000002@lid": "51999000333@c.us" },
    messages: {
      // Newest first, as WAHA returns them (the two fixture files interleave in time).
      [GROUP]: [...groupMedia, ...groupText].sort(
        (a, b) => Number(b.timestamp) - Number(a.timestamp),
      ),
      [DIRECT]: directMedia,
      // 2026-10-29T15:00:00Z = 10:00 in Lima.
      "51999000111@c.us": [
        rawText("S1", 1793286000, "hola", { chat: "51999000111@c.us", sender: "51999000111@c.us" }),
      ],
    },
    media: {
      // group: 0 sticker (small), 1 sticker (gone), 2 image (large), 3 image (small)
      [`${WAHA_URL}/api/files/g-0`]: { bytes: bytes(100), mimetype: "image/webp" },
      [`${WAHA_URL}/api/files/g-2`]: { bytes: bytes(INLINE_MAX + 1), mimetype: "image/jpeg" },
      // 3: small image whose size nobody declares (no Content-Length, no fileLength)
      [`${WAHA_URL}/api/files/g-3`]: { bytes: bytes(10), mimetype: "image/jpeg", length: null },
      // direct: 0 sticker declaring 10 bytes but sending 3000 (lying Content-Length)
      [`${WAHA_URL}/api/files/d-0`]: { bytes: bytes(3000), mimetype: "image/webp", length: 10 },
      // direct: 2 is a PDF document
      [`${WAHA_URL}/api/files/d-2`]: { bytes: bytes(50, 37), mimetype: "application/pdf" },
      // direct: 4 is a PDF declared above MEDIA_MAX_BYTES
      [`${WAHA_URL}/api/files/d-4`]: { bytes: bytes(MAX_BYTES + 1), mimetype: "application/pdf" },
      // direct: 5 is an image (link-sized) that sends one chunk and then stalls
      [`${WAHA_URL}/api/files/d-5`]: {
        bytes: bytes(3000),
        mimetype: "image/jpeg",
        stallAfter: 1024,
      },
      // direct: 6 is a small (inline-sized) image that stalls before sending anything
      [`${WAHA_URL}/api/files/d-6`]: { bytes: bytes(500), mimetype: "image/jpeg", stallAfter: 0 },
      // direct: 7 is audio with no declared length that turns out to exceed MEDIA_MAX_BYTES
      [`${WAHA_URL}/api/files/d-7`]: {
        bytes: bytes(MAX_BYTES + 2000),
        mimetype: "audio/ogg; codecs=opus",
        length: null,
      },
    },
  };
}

interface Setup {
  app: Hono;
  token: string;
  gateway: InMemoryWahaGateway;
}

/** Every e2e test runs twice: CACHE_ENABLED=false (today's path) and with the message cache. */
let cacheOn = false;

function setup(
  data: InMemoryData = baseData(),
  gateway = new InMemoryWahaGateway(data),
  transcription?: (
    served: InMemoryWahaGateway | ReturnType<typeof createCachedGateway>,
  ) => TranscriptionService,
): Setup {
  const served = cacheOn
    ? createCachedGateway(gateway, createSqliteMessageStore(openCacheDatabase(":memory:")), {
        refreshHours: 48,
        maxAgeDays: 0,
        session: "default",
      })
    : gateway;
  const config = loadConfig({
    WAHA_API_URL: WAHA_URL,
    WAHA_API_KEY: KEY,
    PUBLIC_BASE_URL: BASE,
    TIMEZONE: "America/Lima",
    MEDIA_INLINE_MAX_BYTES: String(INLINE_MAX),
    MEDIA_MAX_BYTES: String(MAX_BYTES),
  });
  const store = createAuthStore(":memory:");
  const links = createSignedLinks({
    secret: new Uint8Array(32).fill(3),
    ttlSeconds: config.mediaLinkTtlSeconds,
  });
  const mcp = createMcpServer({
    tools: createTools(),
    instructions: SERVER_INSTRUCTIONS,
    gateway: served,
    config,
    links,
    mediaIdleTimeoutMs: IDLE_MS,
    ...(transcription ? { transcription: transcription(served) } : {}),
  });
  const app = createApp({
    oauth: createOAuthRoutes({
      store,
      wahaApiKey: KEY,
      publicBaseUrl: BASE,
      limiter: createLoginLimiter(),
    }),
    guard: bearerGuard({ store, publicBaseUrl: BASE }),
    mcpHandler: mcp.handler,
    media: createMediaHandler({
      gateway: served,
      links,
      maxBytes: config.mediaMaxBytes,
      idleTimeoutMs: IDLE_MS,
    }),
  });
  const { clientId } = store.registerClient({ redirectUris: ["https://claude.ai/cb"] });
  const { accessToken } = store.issueTokens(clientId, "mcp");
  return { app, token: accessToken, gateway };
}

async function connect(s: Setup): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (url, init) => s.app.fetch(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
  });
  await client.connect(transport);
  return client;
}

interface ToolResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

const sc = (r: ToolResult): Record<string, unknown> => r.structuredContent ?? {};
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const linkOf = (r: ToolResult) =>
  /(http:\/\/localhost:3000\/media\/[A-Za-z0-9_.-]+)/.exec(textOf(r))?.[1] as string;
const fileUrl = (name: string) => `${WAHA_URL}/api/files/${name}`;

async function mediaIds(client: Client, chatId: string): Promise<(string | null)[]> {
  const r = await call(client, "get_messages", { chat_id: chatId, limit: 200 });
  const messages = sc(r).messages as {
    id: string;
    attachment: { mediaId: string | null } | null;
  }[];
  // Only messages with an attachment: index i is the i-th media message, newest first.
  return messages.filter((m) => m.attachment !== null).map((m) => m.attachment?.mediaId ?? null);
}

for (const cache of [false, true])
  describe(`e2e: MCP client against createApp (message cache ${cache ? "on" : "off"})`, () => {
    beforeAll(() => {
      cacheOn = cache;
    });

    it("lists exactly the thirteen tools, all readOnlyHint true, none named like send/delete/edit", async () => {
      const client = await connect(setup());
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "get_activity_digest",
          "get_chat_stats",
          "get_contact",
          "get_group_info",
          "get_media",
          "get_messages",
          "get_thread",
          "list_chats",
          "list_groups",
          "list_pending_replies",
          "list_shared_files",
          "search_messages",
          "transcribe_audio",
        ].sort(),
      );
      for (const t of tools) {
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.name).not.toMatch(/send|delete|edit|update|create|write|post|remove|set/i);
      }
    });

    it("list_pending_replies returns who waits for the owner, with coverage", async () => {
      const client = await connect(setup());
      const r = await call(client, "list_pending_replies", { since: "2026-10-01T00:00:00Z" });
      expect(r.isError).toBeFalsy();
      const pending = sc(r).pending as {
        chatId: string;
        name: string;
        reason: string;
        unansweredCount: number;
        waitingSince: string;
        lastMessages: { from: string; text: string | null }[];
      }[];
      // DIRECT's newest messages are the owner's (answered); Ana's "hola" is waiting.
      expect(pending.map((p) => p.chatId)).toEqual(["51999000111@c.us"]);
      expect(pending[0]).toMatchObject({
        name: "Ana",
        reason: "last-message-from-them",
        unansweredCount: 1,
        waitingSince: "2026-10-29T15:00:00.000Z",
      });
      expect(pending[0]?.lastMessages[0]?.text).toBe("hola");
      const coverage = sc(r).coverage as {
        chatsScanned: number;
        failedChats: string[];
        notes: string[];
      };
      expect(coverage.chatsScanned).toBe(2);
      expect(coverage.failedChats).toEqual([]);
      expect(textOf(r)).toContain("Coverage: 2 chats scanned");
      expect(textOf(r)).toContain("51999000111@c.us");
      // No group chatter unless asked for.
      const groups = await call(client, "list_pending_replies", {
        since: "2026-10-01T00:00:00Z",
        scope: "groups",
      });
      expect(sc(groups).pending).toEqual([]);
      expect(sc(groups).scope).toBe("groups");
    });

    it("search_messages finds messages across scope and in one chat, with coverage", async () => {
      const client = await connect(setup());
      const range = { from: "2026-10-01T00:00:00Z" };
      const direct = await call(client, "search_messages", { query: "HOLA", ...range });
      expect(direct.isError).toBeFalsy();
      const hits = sc(direct).hits as { chatId: string; chatName: string; snippet: string }[];
      expect(hits).toEqual([
        expect.objectContaining({ chatId: "51999000111@c.us", chatName: "Ana", snippet: "hola" }),
      ]);
      expect(sc(direct)).toMatchObject({ scope: "direct", totalMatches: 1 });
      expect(textOf(direct)).toContain("Coverage:");
      // Fixture group texts are scrubbed placeholders; only scope/chat_id reaches them.
      expect(
        sc(await call(client, "search_messages", { query: "redacted-1176", ...range }))
          .hits as unknown[],
      ).toEqual([]);
      const all = await call(client, "search_messages", {
        query: "redacted-1176",
        scope: "all",
        ...range,
      });
      expect((sc(all).hits as { chatId: string }[]).map((h) => h.chatId)).toEqual([GROUP]);
      const one = await call(client, "search_messages", {
        query: "redacted-1176",
        chat_id: GROUP,
        ...range,
      });
      expect(sc(one)).toMatchObject({ scope: null, totalMatches: 1 });
      const short = await call(client, "search_messages", { query: " a " });
      expect(short.isError).toBe(true);
      expect(textOf(short)).toContain('"query" must be between 2 and 200');
    });

    it("get_thread returns the window, the reply chain and a clear not-found error", async () => {
      const client = await connect(setup());
      const group = await call(client, "get_messages", { chat_id: GROUP, limit: 200 });
      const messages = sc(group).messages as { id: string; text: string | null }[];
      const anchor = messages.find((m) => m.text === "<redacted-1176>");
      const r = await call(client, "get_thread", {
        chat_id: GROUP,
        message_id: anchor?.id,
        before: 1,
        after: 1,
      });
      expect(r.isError).toBeFalsy();
      const t = sc(r) as {
        anchor: { id: string; replyToId: string | null };
        before: unknown[];
        after: { id: string }[];
        coverage: { missingAncestors: string[] };
      };
      expect(t.anchor.id).toBe(anchor?.id);
      expect(t.before).toHaveLength(1);
      expect(t.after).toHaveLength(1);
      // Its parent is not in the stored history, so the chain is empty and the gap is reported.
      expect(sc(r).replyChain).toEqual([]);
      expect(t.coverage.missingAncestors).toEqual([t.anchor.replyToId]);
      const missing = await call(client, "get_thread", { chat_id: GROUP, message_id: "nope" });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("message not found in the recent history");
      const bad = await call(client, "get_thread", { chat_id: GROUP, message_id: "x", before: 99 });
      expect(bad.isError).toBe(true);
    });

    it("list_shared_files lists media of one chat and across scope, with coverage", async () => {
      const client = await connect(setup());
      const range = { from: "2026-10-01T00:00:00Z" };
      const docs = await call(client, "list_shared_files", {
        chat_id: DIRECT,
        kind: "document",
        ...range,
      });
      expect(docs.isError).toBeFalsy();
      const items = sc(docs).items as {
        kind: string;
        chatId: string;
        mediaId: string | null;
        filename: string | null;
      }[];
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.kind === "document" && i.chatId === DIRECT)).toBe(true);
      expect(items.every((i) => typeof i.mediaId === "string")).toBe(true);
      expect(textOf(docs)).toContain("Coverage:");
      // The media_id is usable with get_media.
      const media = await call(client, "get_media", { media_id: items[0]?.mediaId });
      expect(media.isError).toBeFalsy();
      const all = await call(client, "list_shared_files", { scope: "all", ...range });
      expect(sc(all).scope).toBe("all");
      const chats = new Set((sc(all).items as { chatId: string }[]).map((i) => i.chatId));
      expect(chats).toEqual(new Set([GROUP, DIRECT]));
      const bad = await call(client, "list_shared_files", { limit: 500 });
      expect(bad.isError).toBe(true);
    });

    it("get_contact resolves by phone, by lid and by name, and refuses bad input", async () => {
      const client = await connect(setup());
      const phone = await call(client, "get_contact", { phone: "+51 999 000 111" });
      expect(phone.isError).toBeFalsy();
      expect(sc(phone)).toMatchObject({
        match: "unique",
        contact: {
          id: "51999000111@c.us",
          name: "Ana",
          pushname: "ana",
          lastInteraction: "2026-10-29T15:00:00.000Z",
        },
      });
      const byLid = await call(client, "get_contact", { contact_id: "10000000000002@lid" });
      expect(sc(byLid)).toMatchObject({
        match: "unique",
        contact: { id: "51999000333@c.us", lid: "10000000000002@lid" },
      });
      const groups = (sc(byLid).contact as { groupsInCommon: { id: string }[] }).groupsInCommon;
      expect(groups.length).toBeGreaterThan(0);
      const ana = await call(client, "get_contact", { name: "ANA" });
      expect(sc(ana)).toMatchObject({ match: "unique", contact: { id: "51999000111@c.us" } });
      const none = await call(client, "get_contact", { name: "zzzz" });
      expect(sc(none)).toMatchObject({ match: "none", contact: null });
      const two = await call(client, "get_contact", { name: "ana", phone: "51999000111" });
      expect(two.isError).toBe(true);
      expect(textOf(two)).toContain("exactly one");
    });

    it("list_pending_replies maps domain errors", async () => {
      const client = await connect(setup());
      const bad = await call(client, "list_pending_replies", { since: "ayer" });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('"since" must be an ISO 8601 date');
    });

    it("get_activity_digest buckets a day in the server timezone and reports awaiting replies", async () => {
      const client = await connect(setup());
      const r = await call(client, "get_activity_digest", { date: "2026-10-29" });
      expect(r.isError).toBeFalsy();
      expect(sc(r)).toMatchObject({
        from: "2026-10-29T05:00:00.000Z",
        to: "2026-10-30T04:59:59.000Z",
        timezone: "America/Lima",
        scope: "direct",
      });
      const chats = sc(r).chats as {
        chatId: string;
        messageCount: number;
        lastFrom: string;
        awaitingReply: boolean;
        messages: { type: string }[];
      }[];
      const direct = chats.find((c) => c.chatId === DIRECT);
      // 3 messages on the 29th in Lima; the one of the 28th is out.
      expect(direct).toMatchObject({ messageCount: 3, lastFrom: "me", awaitingReply: false });
      expect(direct?.messages.map((m) => m.type)).toEqual(["document", "sticker", "sticker"]);
      expect(chats.find((c) => c.chatId === "51999000111@c.us")).toMatchObject({
        messageCount: 1,
        awaitingReply: true,
      });
      expect(chats.some((c) => c.chatId === GROUP)).toBe(false);
      expect(textOf(r)).toContain("AWAITING YOUR REPLY");
      expect(textOf(r)).toContain("Coverage:");
      const all = await call(client, "get_activity_digest", { date: "2026-10-29", scope: "all" });
      const group = (sc(all).chats as { chatId: string; messageCount: number }[]).find(
        (c) => c.chatId === GROUP,
      );
      expect(group?.messageCount).toBe(1);
      const utc = await call(client, "get_activity_digest", {
        date: "2026-10-29",
        timezone: "UTC",
      });
      expect(sc(utc).from).toBe("2026-10-29T00:00:00.000Z");
      const bad = await call(client, "get_activity_digest", { date: "mañana" });
      expect(bad.isError).toBe(true);
    });

    it("declares the mascot icon in serverInfo and serves it at /favicon.svg", async () => {
      const s = setup();
      const client = await connect(s);
      const icons = client.getServerVersion()?.icons ?? [];
      expect(icons).toHaveLength(1);
      expect(icons[0]?.mimeType).toBe("image/svg+xml");
      expect(icons[0]?.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
      for (const path of ["/favicon.svg", "/icon.svg"]) {
        const res = await s.app.fetch(new Request(`${BASE}${path}`));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/svg+xml");
        expect(await res.text()).toContain("<svg");
      }
    });

    it("serves /health without auth and rejects /mcp without a token (401)", async () => {
      const { app } = setup();
      expect((await app.fetch(new Request(`${BASE}/health`))).status).toBe(200);
      const res = await app.fetch(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    });

    it("list_groups returns structuredContent groups", async () => {
      const client = await connect(setup());
      const r = await call(client, "list_groups");
      expect(r.isError).toBeFalsy();
      const groups = sc(r).groups as { id: string; name: string }[];
      expect(groups).toHaveLength(20);
      expect(groups.every((g) => g.id.endsWith("@g.us"))).toBe(true);
      const filtered = await call(client, "list_groups", { name_contains: groups[0]?.name });
      expect((sc(filtered).groups as unknown[]).length).toBeGreaterThanOrEqual(1);
    });

    it("list_chats returns only direct chats with resolved names", async () => {
      const client = await connect(setup());
      const r = await call(client, "list_chats");
      const chats = sc(r).chats as { id: string; name: string | null }[];
      expect(chats.map((c) => c.id)).toEqual([DIRECT, "51999000111@c.us"]);
      expect(chats[1]?.name).toBe("Ana");
      expect(sc(r).namesResolved).toBe(true);
      expect(textOf(r)).toContain("Ana");
    });

    it("list_chats surfaces namesResolved: false as a note", async () => {
      class NoContacts extends InMemoryWahaGateway {
        override async listContacts(): Promise<unknown[]> {
          throw new Error("contacts down");
        }
      }
      const data = baseData();
      const client = await connect(setup(data, new NoContacts(data)));
      const r = await call(client, "list_chats");
      expect(r.isError).toBeFalsy();
      expect(sc(r).namesResolved).toBe(false);
      expect(typeof sc(r).note).toBe("string");
      expect(textOf(r)).toContain(sc(r).note as string);
    });

    it("get_group_info returns participants and refuses non-group ids with an actionable error", async () => {
      const client = await connect(setup());
      const r = await call(client, "get_group_info", { group_id: GROUP });
      expect(r.isError).toBeFalsy();
      expect((sc(r).participants as unknown[]).length).toBe(972);
      const bad = await call(client, "get_group_info", { group_id: DIRECT });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toBe(
        "get_group_info only works with group ids (…@g.us); use get_messages / get_chat_stats for direct chats.",
      );
    });

    it("get_messages returns normalized messages and nextCursor", async () => {
      const client = await connect(setup());
      const first = await call(client, "get_messages", { chat_id: GROUP, limit: 4 });
      expect(first.isError).toBeFalsy();
      const messages = sc(first).messages as { id: string; type: string }[];
      expect(messages).toHaveLength(4);
      expect(messages[0]?.type).toBe("text"); // the newest group message
      // The coverage note says when the page came from the local cache, and only then.
      expect(textOf(first).includes("Read from the local message cache")).toBe(cache);
      const cursor = sc(first).nextCursor as string;
      expect(typeof cursor).toBe("string");
      const second = await call(client, "get_messages", { chat_id: GROUP, limit: 4, cursor });
      const rest = sc(second).messages as { id: string }[];
      expect(rest).toHaveLength(4);
      expect(rest.map((m) => m.id)).not.toContain(messages[0]?.id);
      const other = await call(client, "get_messages", { chat_id: DIRECT, limit: 4, cursor });
      expect(other.isError).toBe(true);
      expect(textOf(other)).toContain("different chat");
    });

    it("get_chat_stats uses TIMEZONE default and per-call timezone override", async () => {
      const client = await connect(setup());
      const hourOf = (r: ToolResult) =>
        (sc(r).perHour as { hour: number; messages: number }[]).find((h) => h.messages > 0)?.hour;
      const lima = await call(client, "get_chat_stats", { chat_id: "51999000111@c.us" });
      expect(lima.isError).toBeFalsy();
      expect(sc(lima).timezone).toBe("America/Lima");
      expect(hourOf(lima)).toBe(10);
      expect(sc(lima).silentMembers).toEqual([]);
      expect(textOf(lima)).toContain((sc(lima).coverage as { note: string }).note);
      const utc = await call(client, "get_chat_stats", {
        chat_id: "51999000111@c.us",
        timezone: "UTC",
      });
      expect(sc(utc).timezone).toBe("UTC");
      expect(hourOf(utc)).toBe(15);
      const group = await call(client, "get_chat_stats", { chat_id: GROUP });
      expect(sc(group).totalMessages).toBe(10);
      expect((sc(group).silentMembers as unknown[]).length).toBeGreaterThan(900);
    });

    it("get_chat_stats exposes responseTimes and coverage.ignoredGaps", async () => {
      const client = await connect(setup());
      const r = await call(client, "get_chat_stats", { chat_id: "51999000111@c.us" });
      expect(Array.isArray(sc(r).responseTimes)).toBe(true);
      expect(typeof (sc(r).coverage as { ignoredGaps: number }).ignoredGaps).toBe("number");
    });

    it("transcribe_audio says transcription is not configured, without an error or a provider call", async () => {
      const s = setup();
      const client = await connect(s);
      const [mediaId] = await mediaIds(client, DIRECT);
      const r = await call(client, "transcribe_audio", { media_id: mediaId });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe(
        "Transcription is not configured on this server (set TRANSCRIPTION_API_URL, TRANSCRIPTION_API_KEY, TRANSCRIPTION_MODEL).",
      );
      expect(sc(r)).toEqual({ transcript: null, cached: false });
      const messages = sc(await call(client, "get_messages", { chat_id: DIRECT, limit: 200 }))
        .messages as { type: string; transcript: string | null }[];
      const voice = messages.filter((m) => m.type === "voice");
      expect(voice.length).toBeGreaterThan(0);
      for (const m of voice) expect(m.transcript).toBeNull();
      expect(s.gateway.count("getMessage")).toBe(0);
    });

    it("with transcription on, voice notes carry transcripts across tools, paid once", async () => {
      const ANA = "51999000111@c.us";
      const SPOKEN = "Nos vemos mañana en la oficina";
      const data = baseData();
      const voice = rawVoice("V1", 1793286060, {
        url: fileUrl("ana-v1"),
        chat: ANA,
        sender: ANA,
        seconds: 4,
      });
      data.messages = { ...data.messages, [ANA]: [voice, ...(data.messages?.[ANA] ?? [])] };
      data.media = {
        ...data.media,
        [fileUrl("ana-v1")]: { bytes: bytes(300, 9), mimetype: "audio/ogg; codecs=opus" },
      };
      const providerCalls: Request[] = [];
      const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        providerCalls.push(new Request(input, init));
        return new Response(JSON.stringify({ text: SPOKEN }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const s = setup(data, undefined, (served) =>
        createTranscriptionService({
          gateway: served,
          audio: createWahaAudioSource(served, { maxBytes: MAX_BYTES, idleTimeoutMs: IDLE_MS }),
          store: createSqliteTranscriptStore(openCacheDatabase(":memory:")),
          transcriber: createOpenAiCompatibleTranscriber({
            apiUrl: "https://stt.example/v1",
            apiKey: "stt-secret",
            model: "whisper",
            language: null,
            fetch: providerFetch,
          }),
          session: "default",
          maxSeconds: 300,
          maxPerCall: 20,
        }),
      );
      const client = await connect(s);

      const got = await call(client, "get_messages", { chat_id: ANA });
      const [first] = sc(got).messages as { id: string; type: string; transcript: string | null }[];
      expect(first).toMatchObject({ type: "voice", transcript: SPOKEN });
      expect(textOf(got)).toContain(SPOKEN);
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0]?.url).toBe("https://stt.example/v1/audio/transcriptions");

      const pending = await call(client, "list_pending_replies", { since: "2026-10-01T00:00:00Z" });
      const ana = (
        sc(pending).pending as {
          chatId: string;
          lastMessages: { type: string; transcript: string | null }[];
        }[]
      ).find((p) => p.chatId === ANA);
      expect(ana?.lastMessages.at(-1)).toMatchObject({ type: "voice", transcript: SPOKEN });

      const digest = await call(client, "get_activity_digest", { date: "2026-10-29" });
      const chat = (
        sc(digest).chats as { chatId: string; messages: { transcript: string | null }[] }[]
      ).find((c) => c.chatId === ANA);
      expect(chat?.messages.map((m) => m.transcript)).toContain(SPOKEN);

      const thread = await call(client, "get_thread", { chat_id: ANA, message_id: first?.id });
      expect((sc(thread).anchor as { transcript: string | null }).transcript).toBe(SPOKEN);

      const found = await call(client, "search_messages", {
        query: "OFICINA",
        from: "2026-10-01T00:00:00Z",
      });
      expect(sc(found).hits).toEqual([expect.objectContaining({ chatId: ANA, snippet: SPOKEN })]);

      const voiceId = (sc(got).messages as { attachment: { mediaId: string } | null }[])[0]
        ?.attachment?.mediaId;
      const onDemand = await call(client, "transcribe_audio", { media_id: voiceId });
      expect(onDemand.isError).toBeFalsy();
      expect(sc(onDemand)).toEqual({ transcript: SPOKEN, cached: true });
      expect(textOf(onDemand)).toContain(SPOKEN);

      expect(providerCalls).toHaveLength(1);
      expect(JSON.stringify([got, pending, digest, thread, found, onDemand])).not.toContain(
        "stt-secret",
      );
    });

    it("lists the three prompts and each names the tools to call", async () => {
      const client = await connect(setup());
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name).sort()).toEqual([
        "daily-review",
        "group-summary",
        "pending-to-todoist",
      ]);
      const text = async (name: string, args: Record<string, string>) => {
        const r = await client.getPrompt({ name, arguments: args });
        return r.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
      };
      const daily = await text("daily-review", { date: "2026-10-29" });
      expect(daily).toContain("2026-10-29");
      expect(daily.indexOf("get_activity_digest")).toBeGreaterThan(-1);
      expect(daily.indexOf("list_pending_replies")).toBeGreaterThan(
        daily.indexOf("get_activity_digest"),
      );
      expect(daily).toContain("get_thread");
      expect(await text("daily-review", {})).toMatch(/\d{4}-\d{2}-\d{2}/);
      const todo = await text("pending-to-todoist", { since: "2026-10-01" });
      expect(todo).toContain("list_pending_replies");
      expect(todo).toContain("2026-10-01");
      expect(todo).toContain("Todoist tools available in this client");
      expect(todo).toContain("ASK me to confirm");
      expect(todo).toContain("Do not create anything before I answer");
      const group = await text("group-summary", { group_id: GROUP });
      for (const tool of ["get_group_info", "get_chat_stats", "get_messages"])
        expect(group).toContain(tool);
      expect(group).toContain(GROUP);
    });

    it("rejects invalid prompt arguments", async () => {
      const client = await connect(setup());
      await expect(
        client.getPrompt({ name: "daily-review", arguments: { date: "30/10/2026" } }),
      ).rejects.toThrow();
      await expect(
        client.getPrompt({ name: "daily-review", arguments: { timezone: "Mars/Base" } }),
      ).rejects.toThrow();
      await expect(client.getPrompt({ name: "group-summary", arguments: {} })).rejects.toThrow();
      await expect(
        client.getPrompt({ name: "group-summary", arguments: { group_id: "ana@c.us" } }),
      ).rejects.toThrow();
      await expect(
        client.getPrompt({ name: "pending-to-todoist", arguments: { since: "yesterday" } }),
      ).rejects.toThrow();
    });

    it("get_media inlines a small sticker as image content", async () => {
      const client = await connect(setup());
      const [sticker] = await mediaIds(client, GROUP);
      const r = await call(client, "get_media", { media_id: sticker });
      expect(r.isError).toBeFalsy();
      expect(r.content[0]).toEqual({
        type: "image",
        data: Buffer.from(bytes(100)).toString("base64"),
        mimeType: "image/webp",
      });
    });

    it("get_media returns a signed link for a large image and a document; the link serves the bytes", async () => {
      const s = setup();
      const client = await connect(s);
      const image = (await mediaIds(client, GROUP))[2];
      const pdf = (await mediaIds(client, DIRECT))[2];
      for (const [id, file, mimetype, size] of [
        [image, "g-2", "image/jpeg", INLINE_MAX + 1],
        [pdf, "d-2", "application/pdf", 50],
      ] as const) {
        const r = await call(client, "get_media", { media_id: id });
        expect(r.isError).toBeFalsy();
        expect(r.content.every((c) => c.type === "text")).toBe(true);
        // Inline vs link is decided from the declared size: the body was never read.
        expect(s.gateway.bodyReads.get(fileUrl(file)) ?? 0).toBe(0);
        const text = textOf(r);
        const link = /(http:\/\/localhost:3000\/media\/[A-Za-z0-9_.-]+)/.exec(text)?.[1];
        expect(link).toBeDefined();
        expect(text).toMatch(/expires/i);
        const res = await s.app.fetch(new Request(link as string));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(mimetype);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("content-disposition")).toBeTruthy();
        expect((await res.arrayBuffer()).byteLength).toBe(size);
      }
    });

    it("get_media links media of unknown size without reading its body", async () => {
      const s = setup();
      const client = await connect(s);
      const unknown = (await mediaIds(client, GROUP))[3];
      const r = await call(client, "get_media", { media_id: unknown });
      expect(r.isError).toBeFalsy();
      expect(r.content[0]?.type).toBe("text");
      expect(linkOf(r)).toBeDefined();
      expect(textOf(r)).toContain("unknown size");
      expect(s.gateway.bodyReads.get(fileUrl("g-3")) ?? 0).toBe(0);
    });

    it("refuses with 413 a file declared above MEDIA_MAX_BYTES without reading it", async () => {
      const s = setup();
      const client = await connect(s);
      const big = (await mediaIds(client, DIRECT))[4];
      const res = await s.app.fetch(
        new Request(linkOf(await call(client, "get_media", { media_id: big }))),
      );
      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toMatch(/too large/i);
      expect(s.gateway.bodyReads.get(fileUrl("d-4")) ?? 0).toBe(0);
    });

    it("aborts the stream when WAHA sends more than its Content-Length declared", async () => {
      const s = setup();
      const client = await connect(s);
      const liar = (await mediaIds(client, DIRECT))[0];
      // Declared 10 bytes (would inline), but more arrive: never inlined, served as a link.
      const r = await call(client, "get_media", { media_id: liar });
      expect(r.content[0]?.type).toBe("text");
      const res = await s.app.fetch(new Request(linkOf(r)));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("10");
      await expect(res.arrayBuffer()).rejects.toThrow();
    });

    it("aborts a stream of unknown length once it exceeds MEDIA_MAX_BYTES", async () => {
      const s = setup();
      const client = await connect(s);
      const audio = (await mediaIds(client, DIRECT))[7];
      const res = await s.app.fetch(
        new Request(linkOf(await call(client, "get_media", { media_id: audio }))),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBeNull();
      await expect(res.arrayBuffer()).rejects.toThrow();
      // 7000 bytes in 1 KiB chunks: draining it takes 8 pulls; the cap stops earlier.
      expect(s.gateway.bodyReads.get(fileUrl("d-7"))).toBeLessThan(8);
    });

    it("errors a /media response whose WAHA body stalls, and cancels the upstream body", async () => {
      const s = setup();
      const client = await connect(s);
      const stalled = (await mediaIds(client, DIRECT))[5];
      const r = await call(client, "get_media", { media_id: stalled });
      const res = await s.app.fetch(new Request(linkOf(r)));
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow();
      expect(s.gateway.cancelled.has(fileUrl("d-5"))).toBe(true);
    });

    it("get_media reports a stalled inline read as an error instead of hanging", async () => {
      const s = setup();
      const client = await connect(s);
      const stalled = (await mediaIds(client, DIRECT))[6];
      const r = await call(client, "get_media", { media_id: stalled });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe("WAHA did not finish sending the file. Try again later.");
      expect(s.gateway.cancelled.has(fileUrl("d-6"))).toBe(true);
    });

    it("cancels the upstream body and answers 502 when the response cannot be built", async () => {
      const data = baseData();
      const direct = data.messages?.[DIRECT] as Raw[];
      // A mimetype with CR/LF is an invalid header value: building the Response throws.
      direct[1] = {
        ...direct[1],
        media: { ...(direct[1]?.media as Raw), mimetype: "image/webp\r\nX-Evil: 1" },
      };
      (data.media as Record<string, unknown>)[fileUrl("d-1")] = {
        bytes: bytes(2000),
        mimetype: "image/webp",
      };
      const s = setup(data);
      const client = await connect(s);
      const id = (await mediaIds(client, DIRECT))[1];
      const link = linkOf(await call(client, "get_media", { media_id: id }));
      s.gateway.cancelled.clear();
      const res = await s.app.fetch(new Request(link));
      expect(res.status).toBe(502);
      expect(await res.text()).toBe("Could not load this file from WAHA right now.");
      expect(s.gateway.cancelled.has(fileUrl("d-1"))).toBe(true);
    });

    it("media links answer 404 for tampered tokens and for files gone from WAHA", async () => {
      const s = setup();
      expect((await s.app.fetch(new Request(`${BASE}/media/not.valid`))).status).toBe(404);
      const links = createSignedLinks({ secret: new Uint8Array(32).fill(3), ttlSeconds: 60 });
      const client = await connect(s);
      const gone = (await mediaIds(client, GROUP))[1] as string;
      expect((await s.app.fetch(new Request(`${BASE}/media/${links.sign(gone)}`))).status).toBe(
        404,
      );
    });

    it("get_media reports unavailable media without isError", async () => {
      const client = await connect(setup());
      const gone = (await mediaIds(client, GROUP))[1];
      const r = await call(client, "get_media", { media_id: gone });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe("This file is no longer available on WAHA.");
      const bad = await call(client, "get_media", { media_id: "not-a-media-id" });
      expect(bad.isError).toBe(true);
    });

    it("WAHA auth failure surfaces the actionable message and no key", async () => {
      const client = await connect(setup({ ...baseData(), failWith: new WahaAuthError() }));
      for (const [name, args] of [
        ["list_groups", {}],
        ["get_messages", { chat_id: GROUP }],
      ] as const) {
        const r = await call(client, name, args);
        expect(r.isError).toBe(true);
        expect(textOf(r)).toBe("WAHA rejected the server's API key — check WAHA_API_KEY.");
        expect(JSON.stringify(r)).not.toContain(KEY);
        expect(JSON.stringify(r)).not.toContain("waha-internal");
      }
    });

    it("non-GOWS engines get the UnsupportedEngineError message, resolved once", async () => {
      const s = setup({ ...baseData(), engine: "WEBJS" });
      const client = await connect(s);
      for (const name of ["list_groups", "list_chats"]) {
        const r = await call(client, name);
        expect(r.isError).toBe(true);
        expect(textOf(r)).toBe('Unsupported WAHA engine "WEBJS". Only GOWS is supported.');
      }
      // A permanent engine mismatch is cached too.
      expect(s.gateway.count("getSession")).toBe(1);
      const ok = setup();
      const okClient = await connect(ok);
      await call(okClient, "list_groups");
      await call(okClient, "list_chats");
      expect(ok.gateway.count("getSession")).toBe(1);
    });
  });
