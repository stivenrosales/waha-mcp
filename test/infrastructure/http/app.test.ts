import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { TenantAdmin } from "../../../src/application/tenantAdmin.js";
import { DISABLED_TRANSCRIPTION } from "../../../src/application/transcripts.js";
import { loadConfig } from "../../../src/config.js";
import type { AuthInfo } from "../../../src/infrastructure/auth/bearer.js";
import { FONT_PATH } from "../../../src/infrastructure/auth/loginPage.js";
import { createApp } from "../../../src/infrastructure/http/app.js";
import { createMcpServer } from "../../../src/infrastructure/mcp/server.js";
import { createSignedLinks } from "../../../src/infrastructure/media/signedLink.js";
import type { TenantRegistry } from "../../../src/infrastructure/tenants/registry.js";
import type { TenantRuntime } from "../../../src/infrastructure/tenants/runtime.js";

const SECRET = new Uint8Array(32).fill(5);
const BASE = "http://localhost:3000";

const config = loadConfig({
  WAHA_API_URL: "http://waha:3000",
  WAHA_API_KEY: "k",
  PUBLIC_BASE_URL: BASE,
  MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery",
});

/** A registry over fixed runtimes that counts unreleased acquires per tenant. */
function fakeRegistry(runtimes: Record<string, TenantRuntime>) {
  const held: Record<string, number> = {};
  const registry: Pick<TenantRegistry, "acquire"> = {
    acquire(tenantId) {
      const runtime = runtimes[tenantId];
      if (!runtime) return null;
      held[tenantId] = (held[tenantId] ?? 0) + 1;
      let released = false;
      return {
        runtime,
        release() {
          if (released) return;
          released = true;
          held[tenantId] = (held[tenantId] ?? 0) - 1;
        },
      };
    },
  };
  return { registry, held };
}

/** Runtime whose media/upload verify with its own tenant's links and stream a two-chunk body. */
function runtimeFor(tenantId: string): TenantRuntime {
  const links = createSignedLinks({ secret: SECRET, ttlSeconds: 60, tenantId });
  const notFound = () =>
    new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  const streamed = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("ab"));
          c.enqueue(new TextEncoder().encode("cd"));
          c.close();
        },
      }),
    );
  return {
    tenantId,
    context: {} as TenantRuntime["context"],
    media: async (token) => (links.verify(token) === null ? notFound() : streamed()),
    upload: async (_req, token) => (links.verify(token) === null ? notFound() : streamed()),
    close() {},
  };
}

function appWith(runtimes: Record<string, TenantRuntime>) {
  const { registry, held } = fakeRegistry(runtimes);
  const app = createApp({
    oauth: new Hono(),
    onboarding: new Hono().get("/pair", (c) => c.text("pair page")),
    guard: async (_c, next) => next(),
    mcpHandler: async () => new Response("unused"),
    registry,
  });
  return { app, held };
}

const sign = (tenantId: string, id = "m1") =>
  createSignedLinks({ secret: SECRET, ttlSeconds: 60, tenantId }).sign(id);

describe("createApp tenant routing", () => {
  it("serves /media and /upload through the token's tenant and releases after the body ends", async () => {
    const { app, held } = appWith({ a: runtimeFor("a") });
    for (const path of [`/media/${sign("a")}`, `/upload/${sign("a")}`]) {
      const res = await app.fetch(new Request(`${BASE}${path}`));
      expect(res.status).toBe(200);
      // Still held while the body has not been read.
      expect(held.a).toBe(1);
      expect(await res.text()).toBe("abcd");
      expect(held.a).toBe(0);
    }
  });

  it("releases when the client cancels a streamed body", async () => {
    const { app, held } = appWith({ a: runtimeFor("a") });
    const res = await app.fetch(new Request(`${BASE}/media/${sign("a")}`));
    expect(held.a).toBe(1);
    await res.body?.cancel();
    expect(held.a).toBe(0);
  });

  it("answers one identical 404 for an unknown tenant, an inactive tenant and a bad signature", async () => {
    const { app, held } = appWith({ a: runtimeFor("a") });
    const forged = `${sign("a").split(".")[0]}.${"x".repeat(43)}`;
    const cases = [
      `/media/${sign("ghost")}`, // tenant unknown to the registry (or not active)
      `/media/${forged}`, // right tenant, bad signature
      "/media/not-a-token", // no tenant at all
      `/upload/${sign("ghost")}`,
      `/upload/${forged}`,
    ];
    const answers = [];
    for (const path of cases) {
      const res = await app.fetch(new Request(`${BASE}${path}`));
      answers.push({
        status: res.status,
        body: await res.text(),
        headers: [...res.headers.entries()],
      });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]?.status).toBe(404);
    expect(held.a).toBe(0);
  });

  it("mounts the onboarding routes at the root", async () => {
    const { app } = appWith({});
    expect(await (await app.fetch(new Request(`${BASE}/pair`))).text()).toBe("pair page");
  });

  it("serves the page font with long-lived caching and no auth", async () => {
    const { app } = appWith({});
    const res = await app.fetch(new Request(`${BASE}${FONT_PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
  });
});

describe("createMcpServer tenant runtime", () => {
  const auth = (tenantId: string): AuthInfo => ({
    clientId: "c",
    scope: "mcp",
    userId: "u",
    tenantId,
    role: "member",
  });
  const init = () =>
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer t",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    });
  const runtime: TenantRuntime = {
    ...runtimeFor("a"),
    context: {
      config,
      transcription: DISABLED_TRANSCRIPTION,
    } as unknown as TenantRuntime["context"],
  };

  it("answers 401 invalid_token like the guard when the tenant cannot be served", async () => {
    const { registry } = fakeRegistry({});
    const mcp = createMcpServer({
      tools: [],
      adminTools: [],
      instructions: "x",
      config,
      registry,
      admin: {} as TenantAdmin,
    });
    const res = await mcp.handler(init(), { authInfo: auth("gone") });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
  });

  it("holds the runtime until the response body is done", async () => {
    const { registry, held } = fakeRegistry({ a: runtime });
    const mcp = createMcpServer({
      tools: [],
      adminTools: [],
      instructions: "x",
      config,
      registry,
      admin: {} as TenantAdmin,
    });
    const res = await mcp.handler(init(), { authInfo: auth("a") });
    expect(res.status).toBe(200);
    expect(held.a).toBe(1);
    expect(await res.text()).toContain("waha-mcp");
    expect(held.a).toBe(0);
  });
});
