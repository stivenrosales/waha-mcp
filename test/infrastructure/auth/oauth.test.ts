import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { bearerGuard } from "../../../src/infrastructure/auth/bearer.js";
import { createOAuthRoutes } from "../../../src/infrastructure/auth/oauth.js";
import { createLoginLimiter } from "../../../src/infrastructure/auth/rateLimit.js";
import { createAuthStore } from "../../../src/infrastructure/auth/store.js";

const BASE = "https://mcp.example.com";
const KEY = "waha-secret-key-0123456789";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PRM_URL = `${BASE}/.well-known/oauth-protected-resource`;

type Auth = { clientId: string; scope: string };

function setup(opts: { now?: () => number } = {}) {
  const store = createAuthStore(":memory:");
  const limiter = createLoginLimiter({ now: opts.now });
  const app = new Hono<{ Variables: { auth: Auth } }>();
  app.route("/", createOAuthRoutes({ store, wahaApiKey: KEY, publicBaseUrl: BASE, limiter }));
  app.use("/mcp", bearerGuard({ store, publicBaseUrl: BASE }));
  app.get("/mcp", (c) => c.json(c.get("auth")));

  // Every response body and header seen in a test, to prove the key never leaks.
  const seen: string[] = [];
  const request = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    const body = await res.clone().text();
    seen.push(body, JSON.stringify([...res.headers.entries()]));
    return res;
  };
  return { store, app, request, seen };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields).toString(),
});

type Ctx = ReturnType<typeof setup>;

async function register(ctx: Ctx, redirectUris: unknown = [REDIRECT]) {
  return ctx.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: "Test client" }),
  });
}

async function registeredClient(ctx: Ctx): Promise<string> {
  const res = await register(ctx);
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authParams = (clientId: string, challenge: string, extra: Record<string, string> = {}) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  state: "xyz-state",
  code_challenge: challenge,
  code_challenge_method: "S256",
  scope: "mcp",
  resource: `${BASE}/mcp`,
  ...extra,
});

async function login(
  ctx: Ctx,
  params: Record<string, string>,
  key: string,
  headers: Record<string, string> = {},
) {
  return ctx.request("/authorize", form({ ...params, waha_key: key }, headers));
}

async function obtainCode(ctx: Ctx, clientId: string, challenge: string): Promise<string> {
  const res = await login(ctx, authParams(clientId, challenge), KEY);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  return location.searchParams.get("code") ?? "";
}

async function exchange(ctx: Ctx, fields: Record<string, string>) {
  return ctx.request("/token", form(fields));
}

describe("oauth metadata", () => {
  it("metadata documents point at PUBLIC_BASE_URL", async () => {
    const ctx = setup();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await ctx.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: `${BASE}/mcp`,
        authorization_servers: [BASE],
      });
    }
    const res = await ctx.request("/.well-known/oauth-authorization-server");
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(meta).not.toHaveProperty("revocation_endpoint");
  });
});

describe("dynamic client registration", () => {
  it("registers a public client", async () => {
    const ctx = setup();
    const res = await register(ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(typeof body.client_id).toBe("string");
    expect(ctx.store.getClient(body.client_id as string)).not.toBeNull();
  });

  it("accepts loopback http redirect URIs", async () => {
    const ctx = setup();
    for (const uri of ["http://localhost:7777/oauth/callback", "http://127.0.0.1:33418/cb"]) {
      expect((await register(ctx, [uri])).status).toBe(201);
    }
  });

  it("rejects missing, non-https and malformed redirect URIs", async () => {
    const ctx = setup();
    for (const uris of [
      null,
      [],
      ["http://evil.example/cb"],
      ["javascript:alert(1)"],
      ["not a url"],
      ["https://app.example/cb#frag"],
    ]) {
      const res = await register(ctx, uris);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
    expect(ctx.store.countClients()).toBe(0);
  });

  it("caps registered clients at 50 until logout", async () => {
    const ctx = setup();
    for (let i = 0; i < 50; i++) expect((await register(ctx)).status).toBe(201);
    const res = await register(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).toMatch(/limit/i);
    expect(body.error_description).toMatch(/logout/i);
    expect(ctx.store.countClients()).toBe(50);
  });
});

describe("authorization code flow", () => {
  it("full flow", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { verifier, challenge } = pkce();
    const params = authParams(clientId, challenge);

    const page = await ctx.request(`/authorize?${new URLSearchParams(params)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const res = await login(ctx, params, KEY);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("xyz-state");
    const code = location.searchParams.get("code") ?? "";
    expect(code).not.toBe("");

    const tokenRes = await exchange(ctx, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    expect(tokens).toMatchObject({ token_type: "Bearer" });
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");

    const guarded = await ctx.request("/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(guarded.status).toBe(200);
    expect(await guarded.json()).toEqual({ clientId, scope: "mcp" });

    const refreshed = await exchange(ctx, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token as string,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Record<string, unknown>;
    expect(next.access_token).not.toBe(tokens.access_token);
    const reused = await exchange(ctx, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token as string,
      client_id: clientId,
    });
    expect(((await reused.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("wrong key re-renders login with error and no code", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const res = await login(ctx, authParams(clientId, challenge), "wrong-key");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("<form");
    expect(html).toMatch(/invalid key/i);
    expect(html).not.toContain("code=");
  });

  it("wrong code_verifier → invalid_grant", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const code = await obtainCode(ctx, clientId, challenge);
    const res = await exchange(ctx, {
      grant_type: "authorization_code",
      code,
      code_verifier: pkce().verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("reused code → invalid_grant", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { verifier, challenge } = pkce();
    const code = await obtainCode(ctx, clientId, challenge);
    const fields = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    };
    expect((await exchange(ctx, fields)).status).toBe(200);
    const res = await exchange(ctx, fields);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("code bound to its client and redirect_uri at /token", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const otherId = await registeredClient(ctx);
    for (const override of [{ client_id: otherId }, { redirect_uri: `${REDIRECT}/other` }]) {
      const { verifier, challenge } = pkce();
      const code = await obtainCode(ctx, clientId, challenge);
      const res = await exchange(ctx, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        ...override,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    }
  });

  it("token endpoint errors follow RFC 6749", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const cases: [Record<string, string>, string][] = [
      [{}, "invalid_request"],
      [{ grant_type: "password", client_id: clientId }, "unsupported_grant_type"],
      [{ grant_type: "authorization_code", client_id: clientId }, "invalid_request"],
      [{ grant_type: "refresh_token", client_id: clientId }, "invalid_request"],
    ];
    for (const [fields, error] of cases) {
      const res = await exchange(ctx, fields);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    const unknown = await exchange(ctx, {
      grant_type: "refresh_token",
      refresh_token: "x",
      client_id: "nope",
    });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: string }).error).toBe("invalid_client");

    const json = await ctx.request("/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });
    expect(((await json.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("redirect_uri mismatch at authorize → 400 page, no redirect", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const bad = authParams(clientId, challenge, { redirect_uri: "https://evil.example/cb" });
    const get = await ctx.request(`/authorize?${new URLSearchParams(bad)}`);
    expect(get.status).toBe(400);
    expect(get.headers.get("location")).toBeNull();
    const post = await login(ctx, bad, KEY);
    expect(post.status).toBe(400);
    expect(post.headers.get("location")).toBeNull();
    expect(await post.text()).not.toContain("code=");
  });

  it("unknown client at authorize → 400 page, no redirect", async () => {
    const ctx = setup();
    const { challenge } = pkce();
    const res = await ctx.request(
      `/authorize?${new URLSearchParams(authParams("nope", challenge))}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("plain code_challenge_method rejected", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    for (const extra of <Record<string, string>[]>[
      { code_challenge_method: "plain" },
      { code_challenge_method: "" },
      { code_challenge: "" },
      { response_type: "token" },
    ]) {
      const params = authParams(clientId, challenge, extra);
      for (const res of [
        await ctx.request(`/authorize?${new URLSearchParams(params)}`),
        await login(ctx, params, KEY),
      ]) {
        // Client and redirect_uri are valid, so the error goes back to the client.
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get("location") ?? "");
        expect(location.searchParams.get("code")).toBeNull();
        expect(location.searchParams.get("error")).toMatch(
          /invalid_request|unsupported_response_type/,
        );
        expect(location.searchParams.get("state")).toBe("xyz-state");
      }
    }
  });

  it("re-validates every original parameter on POST", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const res = await login(
      ctx,
      authParams(clientId, challenge, { resource: "https://evil.example/mcp" }),
      KEY,
    );
    expect(res.headers.get("location") ?? "").not.toContain("code=");
  });

  it("escapes reflected values in the login page", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge, { state: '"><script>alert(1)</script>' });
    const html = await (await ctx.request(`/authorize?${new URLSearchParams(params)}`)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("login rate limit", () => {
  it("sixth failed login within 15 min → 429 even with the right key", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    const ip = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 5; i++) expect((await login(ctx, params, "bad", ip)).status).toBe(401);
    const blocked = await login(ctx, params, KEY, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("location")).toBeNull();
    // Another client address is not affected.
    expect((await login(ctx, params, KEY, { "x-forwarded-for": "198.51.100.1" })).status).toBe(302);
  });

  it("unblocks after the 15 min window", async () => {
    let t = 1_800_000_000_000;
    const ctx = setup({ now: () => t });
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 5; i++) await login(ctx, params, "bad");
    expect((await login(ctx, params, KEY)).status).toBe(429);
    t += 15 * 60 * 1000 + 1;
    expect((await login(ctx, params, KEY)).status).toBe(302);
  });

  it("success resets counter", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 4; i++) await login(ctx, params, "bad");
    expect((await login(ctx, params, KEY)).status).toBe(302);
    for (let i = 0; i < 4; i++) expect((await login(ctx, params, "bad")).status).toBe(401);
    expect((await login(ctx, params, KEY)).status).toBe(302);
  });

  it("rotating a spoofed leading x-forwarded-for hop does not bypass the limiter", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 5; i++) {
      await login(ctx, params, "bad", { "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` });
    }
    const res = await login(ctx, params, KEY, { "x-forwarded-for": "10.9.9.9, 203.0.113.7" });
    expect(res.status).toBe(429);
  });

  it("limiter counts failures per key within the window", () => {
    let t = 0;
    const limiter = createLoginLimiter({ maxFailures: 2, windowMs: 1000, now: () => t });
    limiter.recordFailure("a");
    expect(limiter.isBlocked("a")).toBe(false);
    limiter.recordFailure("a");
    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.isBlocked("b")).toBe(false);
    t = 1001;
    expect(limiter.isBlocked("a")).toBe(false);
    limiter.recordFailure("a");
    limiter.recordFailure("a");
    limiter.reset("a");
    expect(limiter.isBlocked("a")).toBe(false);
  });
});

describe("bearer guard and logout", () => {
  it("missing or invalid token → 401 with resource_metadata", async () => {
    const ctx = setup();
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Basic x" }]) {
      const res = await ctx.request("/mcp", { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM_URL}"`);
    }
  });

  it("token used after logout → 401 with WWW-Authenticate resource_metadata", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { verifier, challenge } = pkce();
    const code = await obtainCode(ctx, clientId, challenge);
    const tokens = (await (
      await exchange(ctx, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      })
    ).json()) as { access_token: string; refresh_token: string };
    const auth = { authorization: `Bearer ${tokens.access_token}` };
    expect((await ctx.request("/mcp", { headers: auth })).status).toBe(200);

    const page = await ctx.request("/logout");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<form");

    const wrong = await ctx.request("/logout", form({ waha_key: "bad" }));
    expect(wrong.status).toBe(401);
    expect((await ctx.request("/mcp", { headers: auth })).status).toBe(200);

    const ok = await ctx.request("/logout", form({ waha_key: KEY }));
    expect(ok.status).toBe(200);

    const after = await ctx.request("/mcp", { headers: auth });
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain(`resource_metadata="${PRM_URL}"`);
    expect(ctx.store.getClient(clientId)).toBeNull();
    const refresh = await exchange(ctx, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refresh.status).not.toBe(200);
  });

  it("logout is rate limited", async () => {
    const ctx = setup();
    for (let i = 0; i < 5; i++) await ctx.request("/logout", form({ waha_key: "bad" }));
    const res = await ctx.request("/logout", form({ waha_key: KEY }));
    expect(res.status).toBe(429);
  });
});

describe("secrecy", () => {
  it("no response body or header contains the WAHA key", async () => {
    const ctx = setup();
    const clientId = await registeredClient(ctx);
    const { verifier, challenge } = pkce();
    const params = authParams(clientId, challenge);
    await ctx.request(`/authorize?${new URLSearchParams(params)}`);
    await login(ctx, params, "bad");
    const code = await obtainCode(ctx, clientId, challenge);
    await exchange(ctx, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    for (let i = 0; i < 6; i++) await login(ctx, params, KEY.slice(0, -1));
    await login(ctx, params, KEY);
    const other = { "x-forwarded-for": "198.51.100.2" };
    await ctx.request("/logout");
    await ctx.request("/logout", form({ waha_key: "bad" }, other));
    await ctx.request("/logout", form({ waha_key: KEY }, other));
    expect(ctx.seen.length).toBeGreaterThan(10);
    for (const text of ctx.seen) expect(text).not.toContain(KEY);
  });
});
