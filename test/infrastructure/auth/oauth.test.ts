import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Role, TenantStatus } from "../../../src/domain/ports/TenantStore.js";
import { bearerGuard } from "../../../src/infrastructure/auth/bearer.js";
import { createOAuthRoutes } from "../../../src/infrastructure/auth/oauth.js";
import {
  createLoginLimiter,
  normalizeClientKey,
} from "../../../src/infrastructure/auth/rateLimit.js";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";

const BASE = "https://mcp.example.com";
const PASSWORD = "correct horse battery staple";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PRM_URL = `${BASE}/.well-known/oauth-protected-resource`;

type Auth = { clientId: string; scope: string; userId: string; tenantId: string; role: string };

async function setup(opts: { now?: () => number; storeNow?: () => number } = {}) {
  const db = openAuthDatabase(":memory:");
  const store = createAuthStore(db, opts.storeNow);
  const tenants = createSqliteTenantStore(db);
  /** Creates a tenant in `status` with one user whose password is PASSWORD. */
  const addUser = async (
    username: string,
    status: TenantStatus = "active",
    role: Role = "member",
  ) => {
    const tenant = tenants.createTenant({
      displayName: username,
      wahaSession: `t_${username}`,
      wrappedDek: "x",
    });
    tenants.setStatus(tenant.id, status);
    const user = await tenants.createUser({
      tenantId: tenant.id,
      username,
      password: PASSWORD,
      role,
    });
    if (user === "username_taken") throw new Error("unreachable");
    return user;
  };
  const adminUserId = (await addUser("admin", "active", "admin")).id;
  const limiter = createLoginLimiter({ now: opts.now });
  const app = new Hono<{ Variables: { auth: Auth } }>();
  app.route("/", createOAuthRoutes({ store, tenants, publicBaseUrl: BASE, limiter }));
  app.use("/mcp", bearerGuard({ store, tenants, publicBaseUrl: BASE }));
  app.get("/mcp", (c) => c.json(c.get("auth")));

  // Every response body and header seen in a test, to prove the key never leaks.
  const seen: string[] = [];
  const request = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    const body = await res.clone().text();
    seen.push(body, JSON.stringify([...res.headers.entries()]));
    return res;
  };
  return { store, tenants, app, request, seen, adminUserId, addUser };
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

type Ctx = Awaited<ReturnType<typeof setup>>;

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
  password: string,
  headers: Record<string, string> = {},
  username = "admin",
) {
  return ctx.request("/authorize", form({ ...params, username, password }, headers));
}

async function obtainCode(
  ctx: Ctx,
  clientId: string,
  challenge: string,
  username = "admin",
): Promise<string> {
  const res = await login(ctx, authParams(clientId, challenge), PASSWORD, {}, username);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  return location.searchParams.get("code") ?? "";
}

async function exchange(ctx: Ctx, fields: Record<string, string>) {
  return ctx.request("/token", form(fields));
}

describe("oauth metadata", () => {
  it("metadata documents point at PUBLIC_BASE_URL", async () => {
    const ctx = await setup();
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
    const ctx = await setup();
    const res = await register(ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(typeof body.client_id).toBe("string");
    expect(ctx.store.getClient(body.client_id as string)).not.toBeNull();
  });

  it("accepts loopback http redirect URIs", async () => {
    const ctx = await setup();
    for (const uri of ["http://localhost:7777/oauth/callback", "http://127.0.0.1:33418/cb"]) {
      expect((await register(ctx, [uri])).status).toBe(201);
    }
  });

  it("rejects missing, non-https and malformed redirect URIs", async () => {
    const ctx = await setup();
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

  it("caps unbound clients at 50 without pointing to /logout", async () => {
    const ctx = await setup();
    for (let i = 0; i < 50; i++) expect((await register(ctx)).status).toBe(201);
    const res = await register(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).toBe(
      "Client limit reached (50). Unused registrations expire after 1 hour; try again later.",
    );
    expect(ctx.store.countClients()).toBe(50);
  });

  it("lets a new client register once 50 anonymous registrations are over an hour old", async () => {
    let t = 1_800_000_000_000;
    const ctx = await setup({ storeNow: () => t });
    for (let i = 0; i < 50; i++) expect((await register(ctx)).status).toBe(201);
    t += 59 * 60 * 1000;
    expect((await register(ctx)).status).toBe(400);
    t += 2 * 60 * 1000;
    expect((await register(ctx)).status).toBe(201);
    expect(ctx.store.countClients()).toBe(1);
  });

  it("does not count clients bound to a user toward the cap", async () => {
    const ctx = await setup();
    for (let i = 0; i < 50; i++) {
      const clientId = await registeredClient(ctx);
      const code = ctx.store.saveCode({
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: "challenge",
        scope: "mcp",
        resource: null,
        userId: ctx.adminUserId,
      });
      ctx.store.issueTokens(clientId, "mcp", ctx.adminUserId);
      expect(code).not.toBeNull();
    }
    expect((await register(ctx)).status).toBe(201);
    expect(ctx.store.countClients()).toBe(51);
  });

  it("prunes day-old clients without live tokens before checking the cap", async () => {
    let t = 1_800_000_000_000;
    const ctx = await setup({ storeNow: () => t });
    for (let i = 0; i < 50; i++) expect((await register(ctx)).status).toBe(201);
    t += 25 * 3600 * 1000;
    expect((await register(ctx)).status).toBe(201);
    expect(ctx.store.countClients()).toBe(1);
  });
});

describe("authorization code flow", () => {
  it("full flow", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { verifier, challenge } = pkce();
    const params = authParams(clientId, challenge);

    const page = await ctx.request(`/authorize?${new URLSearchParams(params)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const res = await login(ctx, params, PASSWORD);
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
    expect(await guarded.json()).toMatchObject({
      clientId,
      scope: "mcp",
      userId: ctx.adminUserId,
      role: "admin",
    });

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

  it("wrong password → 401 page", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (const [username, password] of [
      ["admin", "wrong-password"],
      ["nobody", PASSWORD],
    ]) {
      const res = await login(ctx, params, password, {}, username);
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("Invalid username or password.");
    }
    const res = await login(ctx, params, "wrong-password");
    const html = await res.text();
    expect(html).toContain("<form");
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain("waha_key");
    expect(html).not.toContain("code=");
    // The consent text must say the client can send, not only read.
    expect(html).toContain("send messages from your number");
    expect(html).not.toMatch(/read-only/i);
  });

  it("login with username/password issues a code bound to the user", async () => {
    const ctx = await setup();
    const member = await ctx.addUser("alice");
    const clientId = await registeredClient(ctx);
    const { verifier, challenge } = pkce();
    const code = await obtainCode(ctx, clientId, challenge, "ALICE");
    const res = await exchange(ctx, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    const tokens = (await res.json()) as { access_token: string };
    const me = await ctx.request("/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(me.status).toBe(200);
    expect((await me.json()) as { userId: string; role: string }).toMatchObject({
      userId: member.id,
      tenantId: member.tenantId,
      role: "member",
    });
    expect(ctx.tenants.getUser(member.id)?.lastLoginAt).not.toBeNull();
  });

  it("user of a pairing tenant cannot log in", async () => {
    const ctx = await setup();
    await ctx.addUser("pending", "pairing");
    await ctx.addUser("gone", "revoked");
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    const pairing = await login(ctx, params, PASSWORD, {}, "pending");
    expect(pairing.status).toBe(403);
    expect(pairing.headers.get("location")).toBeNull();
    expect(await pairing.text()).toContain(
      `This account is not active yet. Finish connecting WhatsApp at ${BASE}/pair.`,
    );
    const revoked = await login(ctx, params, PASSWORD, {}, "gone");
    expect(revoked.status).toBe(403);
    expect(await revoked.text()).toContain("This account is disabled.");
  });

  it("a client removed during login gets the unknown-client page, not the linked one", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const saveCode = ctx.store.saveCode;
    ctx.store.saveCode = (input) => {
      ctx.store.revokeAll();
      return saveCode.call(ctx.store, input);
    };
    const res = await login(ctx, authParams(clientId, challenge), PASSWORD);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Unknown client. Remove the connector and add it again.");
    expect(html).not.toContain("linked to another account");
  });

  it("a client bound to one user refuses another user's login; revoking B leaves A", async () => {
    const ctx = await setup();
    const bob = await ctx.addUser("bob");
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

    const refused = await login(ctx, authParams(clientId, challenge), PASSWORD, {}, "bob");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("location")).toBeNull();
    expect(await refused.text()).toContain(
      "This client is linked to another account. Reconnect from your MCP client.",
    );

    ctx.store.revokeUser(bob.id);
    expect(ctx.store.getClient(clientId)).not.toBeNull();
    const auth = { authorization: `Bearer ${tokens.access_token}` };
    expect((await ctx.request("/mcp", { headers: auth })).status).toBe(200);
    const refreshed = await exchange(ctx, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
  });

  it("wrong code_verifier → invalid_grant", async () => {
    const ctx = await setup();
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
    const ctx = await setup();
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
    const ctx = await setup();
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
    const ctx = await setup();
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
    // Public clients send no credentials, so RFC 6749 §5.2 allows 400 (no WWW-Authenticate needed).
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("invalid_client");

    const json = await ctx.request("/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });
    expect(((await json.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("redirect_uri mismatch at authorize → 400 page, no redirect", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const bad = authParams(clientId, challenge, { redirect_uri: "https://evil.example/cb" });
    const get = await ctx.request(`/authorize?${new URLSearchParams(bad)}`);
    expect(get.status).toBe(400);
    expect(get.headers.get("location")).toBeNull();
    const post = await login(ctx, bad, PASSWORD);
    expect(post.status).toBe(400);
    expect(post.headers.get("location")).toBeNull();
    expect(await post.text()).not.toContain("code=");
  });

  it("unknown client at authorize → 400 page, no redirect", async () => {
    const ctx = await setup();
    const { challenge } = pkce();
    const res = await ctx.request(
      `/authorize?${new URLSearchParams(authParams("nope", challenge))}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("plain code_challenge_method rejected", async () => {
    const ctx = await setup();
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
        await login(ctx, params, PASSWORD),
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
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const res = await login(
      ctx,
      authParams(clientId, challenge, { resource: "https://evil.example/mcp" }),
      PASSWORD,
    );
    expect(res.headers.get("location") ?? "").not.toContain("code=");
  });

  it("escapes reflected values in the login page", async () => {
    const ctx = await setup();
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
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    const ip = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 5; i++) {
      expect((await login(ctx, params, "bad", ip, `intruder-${i}`)).status).toBe(401);
    }
    const blocked = await login(ctx, params, PASSWORD, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("location")).toBeNull();
    // Another client address is not affected.
    expect((await login(ctx, params, PASSWORD, { "x-forwarded-for": "198.51.100.1" })).status).toBe(
      302,
    );
  });

  it("five failures for one username from different addresses block that username", async () => {
    const ctx = await setup();
    await ctx.addUser("carol");
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 5; i++) {
      await login(ctx, params, "bad", { "x-forwarded-for": `198.51.100.${i}` }, "Admin");
    }
    const fresh = { "x-forwarded-for": "192.0.2.50" };
    expect((await login(ctx, params, PASSWORD, fresh)).status).toBe(429);
    expect(
      (await ctx.request("/logout", form({ username: "admin", password: PASSWORD }, fresh))).status,
    ).toBe(429);
    // Other usernames from the same fresh address are not affected.
    expect((await login(ctx, params, PASSWORD, fresh, "carol")).status).toBe(302);
  });

  it("unblocks after the 15 min window", async () => {
    let t = 1_800_000_000_000;
    const ctx = await setup({ now: () => t });
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 5; i++) await login(ctx, params, "bad");
    expect((await login(ctx, params, PASSWORD)).status).toBe(429);
    t += 15 * 60 * 1000 + 1;
    expect((await login(ctx, params, PASSWORD)).status).toBe(302);
  });

  it("success resets counter", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 4; i++) await login(ctx, params, "bad");
    expect((await login(ctx, params, PASSWORD)).status).toBe(302);
    for (let i = 0; i < 4; i++) expect((await login(ctx, params, "bad")).status).toBe(401);
    expect((await login(ctx, params, PASSWORD)).status).toBe(302);
  });

  it("rotating a spoofed leading x-forwarded-for hop does not bypass the limiter", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 5; i++) {
      await login(ctx, params, "bad", { "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` }, `u${i}`);
    }
    const res = await login(ctx, params, PASSWORD, { "x-forwarded-for": "10.9.9.9, 203.0.113.7" });
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

describe("limiter hardening", () => {
  it("normalizes IPv6 to its /64 and IPv4-mapped IPv6 to IPv4", () => {
    expect(normalizeClientKey("2001:db8:1:2:aaaa::1")).toBe(
      normalizeClientKey("2001:db8:1:2::ffff"),
    );
    expect(normalizeClientKey("2001:db8:1:2::1")).not.toBe(normalizeClientKey("2001:db8:1:3::1"));
    expect(normalizeClientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeClientKey("[2001:db8:1:2::1]")).toBe(normalizeClientKey("2001:db8:1:2::9"));
    expect(normalizeClientKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("IPv6 addresses in the same /64 share one counter", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 1; i <= 5; i++) {
      await login(ctx, params, "bad", { "x-forwarded-for": `2001:db8:1:2::${i}` }, `u${i}`);
    }
    const res = await login(ctx, params, PASSWORD, { "x-forwarded-for": "2001:db8:1:2:ffff::99" });
    expect(res.status).toBe(429);
  });

  it("IPv4-mapped IPv6 shares the IPv4 counter", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 5; i++) {
      await login(ctx, params, "bad", { "x-forwarded-for": "::ffff:203.0.113.7" }, `u${i}`);
    }
    const res = await login(ctx, params, PASSWORD, { "x-forwarded-for": "203.0.113.7" });
    expect(res.status).toBe(429);
  });

  it("51st failure across distinct keys blocks a fresh key, login and logout", async () => {
    const ctx = await setup();
    const clientId = await registeredClient(ctx);
    const { challenge } = pkce();
    const params = authParams(clientId, challenge);
    for (let i = 0; i < 50; i++) {
      const res = await login(
        ctx,
        params,
        "bad",
        { "x-forwarded-for": `198.51.100.${i}` },
        `u${i}`,
      );
      expect(res.status).toBe(401);
    }
    const fresh = { "x-forwarded-for": "192.0.2.200" };
    expect((await login(ctx, params, PASSWORD, fresh)).status).toBe(429);
    expect(
      (await ctx.request("/logout", form({ username: "admin", password: PASSWORD }, fresh))).status,
    ).toBe(429);
  });

  it("success does not reset the global budget", () => {
    const limiter = createLoginLimiter({ globalMaxFailures: 3 });
    limiter.recordFailure("a");
    limiter.recordFailure("b");
    limiter.reset("b");
    limiter.recordFailure("c");
    expect(limiter.isBlocked("fresh")).toBe(true);
  });

  it("eviction flood does not unblock a blocked key", () => {
    const limiter = createLoginLimiter({
      maxFailures: 2,
      globalMaxFailures: Number.POSITIVE_INFINITY,
      maxTrackedKeys: 3,
    });
    limiter.recordFailure("victim-of-own-attack");
    limiter.recordFailure("victim-of-own-attack");
    expect(limiter.isBlocked("victim-of-own-attack")).toBe(true);
    for (let i = 0; i < 100; i++) limiter.recordFailure(`flood-${i}`);
    expect(limiter.isBlocked("victim-of-own-attack")).toBe(true);
  });
});

describe("bearer guard and logout", () => {
  it("missing or invalid token → 401 with resource_metadata", async () => {
    const ctx = await setup();
    for (const headers of [{}, { authorization: "Basic x" }]) {
      const res = await ctx.request("/mcp", { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM_URL}"`);
    }
    const invalid = await ctx.request("/mcp", { headers: { authorization: "Bearer nope" } });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`,
    );
  });

  it("token used after logout → 401 with WWW-Authenticate resource_metadata", async () => {
    const ctx = await setup();
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

    const wrong = await ctx.request("/logout", form({ username: "admin", password: "bad" }));
    expect(wrong.status).toBe(401);
    expect((await ctx.request("/mcp", { headers: auth })).status).toBe(200);

    const ok = await ctx.request("/logout", form({ username: "admin", password: PASSWORD }));
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

  it("logout revokes only that user", async () => {
    const ctx = await setup();
    await ctx.addUser("dave");
    const issue = async (username: string) => {
      const clientId = await registeredClient(ctx);
      const { verifier, challenge } = pkce();
      const code = await obtainCode(ctx, clientId, challenge, username);
      const res = await exchange(ctx, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      });
      const { access_token } = (await res.json()) as { access_token: string };
      return { clientId, auth: { authorization: `Bearer ${access_token}` } };
    };
    const admin = await issue("admin");
    const dave = await issue("dave");
    const ok = await ctx.request("/logout", form({ username: "dave", password: PASSWORD }));
    expect(ok.status).toBe(200);
    expect((await ctx.request("/mcp", { headers: dave.auth })).status).toBe(401);
    expect(ctx.store.getClient(dave.clientId)).toBeNull();
    expect((await ctx.request("/mcp", { headers: admin.auth })).status).toBe(200);
    expect(ctx.store.getClient(admin.clientId)).not.toBeNull();
  });

  it("logout is rate limited", async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i++)
      await ctx.request("/logout", form({ username: "admin", password: "bad" }));
    const res = await ctx.request("/logout", form({ username: "admin", password: PASSWORD }));
    expect(res.status).toBe(429);
  });
});

describe("secrecy", () => {
  it("no response body or header contains the password", async () => {
    const ctx = await setup();
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
    for (let i = 0; i < 6; i++) await login(ctx, params, PASSWORD.slice(0, -1));
    await login(ctx, params, PASSWORD);
    const other = { "x-forwarded-for": "198.51.100.2" };
    await ctx.request("/logout");
    await ctx.request("/logout", form({ username: "admin", password: "bad" }, other));
    await ctx.request("/logout", form({ username: "admin", password: PASSWORD }, other));
    expect(ctx.seen.length).toBeGreaterThan(10);
    for (const text of ctx.seen) expect(text).not.toContain(PASSWORD);
  });
});
