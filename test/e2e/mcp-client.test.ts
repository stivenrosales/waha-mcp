import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { WahaAuthError } from "../../src/domain/errors.js";
import { bearerGuard } from "../../src/infrastructure/auth/bearer.js";
import { createOAuthRoutes } from "../../src/infrastructure/auth/oauth.js";
import { createLoginLimiter } from "../../src/infrastructure/auth/rateLimit.js";
import { createAuthStore } from "../../src/infrastructure/auth/store.js";
import { createApp } from "../../src/infrastructure/http/app.js";
import { SERVER_INSTRUCTIONS } from "../../src/infrastructure/mcp/instructions.js";
import { createMcpServer } from "../../src/infrastructure/mcp/server.js";
import { createTools } from "../../src/infrastructure/mcp/tools/index.js";
import { createMediaHandler } from "../../src/infrastructure/media/mediaRoute.js";
import { createSignedLinks } from "../../src/infrastructure/media/signedLink.js";
import { type InMemoryData, InMemoryWahaGateway, rawText } from "../fakes/InMemoryWahaGateway.js";

/**
 * End to end: the official MCP client talks to `createApp` (OAuth bearer guard,
 * stateless MCP handler, signed media links) through an in-process fetch. WAHA is
 * the in-memory gateway backed by the real scrubbed GOWS fixtures.
 */

const BASE = "http://localhost:3000";
const WAHA_URL = "http://waha-internal:3000";
const KEY = "k-very-secret-waha-key";
const INLINE_MAX = 1000;

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

const groupMedia = withFileUrls(fixture("gows/messages-media-download.json"), "g");
const directMedia = withFileUrls(fixture("gows-direct/messages-media-download.json"), "d");
const groupText = fixture("gows/messages-text-download.json");

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

function baseData(): InMemoryData {
  return {
    groups: fixture("gows/groups.json"),
    groupDetails: { [GROUP]: JSON.parse(readFileSync("test/fixtures/gows/group.json", "utf8")) },
    chats: [
      { id: DIRECT, name: null, conversationTimestamp: 1793317814 },
      { id: "51999000111@c.us", name: null, conversationTimestamp: 1793000000 },
      { id: GROUP, name: "Group", conversationTimestamp: 1793373071 },
      { id: "123@newsletter", name: "News" },
    ],
    contacts: [{ id: "51999000111@c.us", name: "Ana", pushname: "ana" }],
    messages: {
      [GROUP]: [...groupMedia, ...groupText],
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
      // direct: 2 is a PDF document
      [`${WAHA_URL}/api/files/d-2`]: { bytes: bytes(50, 37), mimetype: "application/pdf" },
    },
  };
}

interface Setup {
  app: Hono;
  token: string;
  gateway: InMemoryWahaGateway;
}

function setup(data: InMemoryData = baseData(), gateway = new InMemoryWahaGateway(data)): Setup {
  const config = loadConfig({
    WAHA_API_URL: WAHA_URL,
    WAHA_API_KEY: KEY,
    PUBLIC_BASE_URL: BASE,
    TIMEZONE: "America/Lima",
    MEDIA_INLINE_MAX_BYTES: String(INLINE_MAX),
  });
  const store = createAuthStore(":memory:");
  const links = createSignedLinks({
    secret: new Uint8Array(32).fill(3),
    ttlSeconds: config.mediaLinkTtlSeconds,
  });
  const mcp = createMcpServer({
    tools: createTools(),
    instructions: SERVER_INSTRUCTIONS,
    gateway,
    config,
    links,
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
    media: createMediaHandler({ gateway, links }),
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

async function mediaIds(client: Client, chatId: string): Promise<(string | null)[]> {
  const r = await call(client, "get_messages", { chat_id: chatId, limit: 200 });
  const messages = sc(r).messages as {
    id: string;
    attachment: { mediaId: string | null } | null;
  }[];
  return messages.map((m) => m.attachment?.mediaId ?? null);
}

describe("e2e: MCP client against createApp", () => {
  it("lists exactly the six tools, all readOnlyHint true, none named like send/delete/edit", async () => {
    const client = await connect(setup());
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "get_chat_stats",
        "get_group_info",
        "get_media",
        "get_messages",
        "list_chats",
        "list_groups",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.name).not.toMatch(/send|delete|edit|update|create|write|post|remove|set/i);
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
    expect(messages[0]?.type).toBe("sticker");
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
    for (const [id, mimetype, size] of [
      [image, "image/jpeg", INLINE_MAX + 1],
      [pdf, "application/pdf", 50],
    ] as const) {
      const r = await call(client, "get_media", { media_id: id });
      expect(r.isError).toBeFalsy();
      expect(r.content.every((c) => c.type === "text")).toBe(true);
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

  it("media links answer 404 for tampered tokens and for files gone from WAHA", async () => {
    const s = setup();
    expect((await s.app.fetch(new Request(`${BASE}/media/not.valid`))).status).toBe(404);
    const links = createSignedLinks({ secret: new Uint8Array(32).fill(3), ttlSeconds: 60 });
    const client = await connect(s);
    const gone = (await mediaIds(client, GROUP))[1] as string;
    expect((await s.app.fetch(new Request(`${BASE}/media/${links.sign(gone)}`))).status).toBe(404);
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
    const ok = setup();
    const okClient = await connect(ok);
    await call(okClient, "list_groups");
    await call(okClient, "list_chats");
    expect(ok.gateway.count("getSession")).toBe(1);
  });
});
