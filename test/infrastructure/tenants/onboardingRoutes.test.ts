import { describe, expect, it } from "vitest";
import { createLoginLimiter } from "../../../src/infrastructure/auth/rateLimit.js";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createOnboardingRoutes } from "../../../src/infrastructure/tenants/onboardingRoutes.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../../fakes/FakeSessionAdmin.js";

const BASE = "https://mcp.example.com";
const HOUR = 3600_000;
const PASSWORD = "a long enough password";
const TRUST =
  "The administrator of this server can technically access your WhatsApp data. Only continue if you trust them.";
const USED = "This link was already used.";
const TAKEN = "This WhatsApp number is already connected to another account.";

function setup() {
  let t = 1_800_000_000_000;
  const now = () => t;
  const db = openAuthDatabase(":memory:");
  const auth = createAuthStore(db, now);
  const tenants = createSqliteTenantStore(db, now);
  const sessions = new FakeSessionAdmin();
  const app = createOnboardingRoutes({
    tenants,
    auth,
    sessions,
    cookieSecret: new Uint8Array(32).fill(9),
    publicBaseUrl: BASE,
    limiter: createLoginLimiter({ now }),
    now,
  });

  // Every response body and header, to prove secrets never leak.
  const seen: string[] = [];
  const request = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    seen.push(await res.clone().text(), JSON.stringify([...res.headers.entries()]));
    return res;
  };
  const post = (
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = { origin: BASE },
  ) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });

  const newTenant = (name = "Acme") =>
    tenants.createTenant({
      displayName: name,
      wahaSession: `t_${name.toLowerCase()}`,
      wrappedDek: "x",
    });
  const invite = (name = "Acme") => {
    const tenant = newTenant(name);
    const { token } = tenants.issueLink(tenant.id, "invite", 72 * HOUR);
    return { tenant, token };
  };
  const signUp = (token: string, username = "alice", password = PASSWORD) =>
    post(`/invite/${token}`, { username, password, password_confirm: password });
  /** A tenant whose user signed up through its invite; returns the pairing cookie. */
  const onboarded = async (name = "Acme", username = "alice") => {
    const { tenant, token } = invite(name);
    const res = await signUp(token, username);
    expect(res.status).toBe(303);
    return { tenant, token, cookie: cookieOf(res) };
  };
  const pairPage = (cookie: string) => request("/pair", { headers: { cookie } });

  return {
    app,
    auth,
    tenants,
    sessions,
    seen,
    request,
    post,
    newTenant,
    invite,
    signUp,
    onboarded,
    pairPage,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** The `name=value` part of the pairing Set-Cookie header. */
function cookieOf(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

describe("invite", () => {
  it("shows the sign-up form with the trust sentence and security headers", async () => {
    const ctx = setup();
    const { token } = ctx.invite();
    const res = await ctx.request(`/invite/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(TRUST);
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain(token);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("invite creates the user and moves tenant to pairing", async () => {
    const ctx = setup();
    const { tenant, token } = ctx.invite();
    const res = await ctx.signUp(token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/pair`);
    const user = ctx.tenants.getUserByTenant(tenant.id);
    expect(user).toMatchObject({ username: "alice", role: "member" });
    expect(ctx.tenants.getTenant(tenant.id)?.status).toBe("pairing");
    expect(await ctx.tenants.verifyPassword("alice", PASSWORD)).not.toBeNull();
    const setCookie = res.headers.get("set-cookie") ?? "";
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/pair", "Max-Age=900"]) {
      expect(setCookie).toContain(attr);
    }
  });

  it('second POST of the same invite → "This link was already used."', async () => {
    const ctx = setup();
    const { tenant, token } = ctx.invite();
    expect((await ctx.signUp(token)).status).toBe(303);
    const again = await ctx.signUp(token, "mallory");
    expect(again.status).toBe(410);
    expect(await again.text()).toContain(USED);
    expect((await ctx.request(`/invite/${token}`)).status).toBe(410);
    expect(ctx.tenants.getUserByTenant(tenant.id)?.username).toBe("alice");
  });

  it("two concurrent POSTs of one invite create one user", async () => {
    for (const second of ["bob", "alice"]) {
      const ctx = setup();
      const { tenant, token } = ctx.invite();
      const names = ["alice", second];
      const results = await Promise.all(names.map((name) => ctx.signUp(token, name)));
      expect(results.map((r) => r.status).sort()).toEqual([303, 410]);
      const loser = results.find((r) => r.status === 410) as Response;
      expect(await loser.text()).toContain(USED);
      // Either request may win the race; the tenant holds exactly the winner's user.
      const winner = names[results.findIndex((r) => r.status === 303)];
      expect(ctx.tenants.getUserByTenant(tenant.id)?.username).toBe(winner);
      expect(ctx.tenants.linkState(token, "invite")?.state).toBe("used");
    }
  });

  it("expired invite → 404 page", async () => {
    const ctx = setup();
    const { tenant, token } = ctx.invite();
    ctx.advance(72 * HOUR);
    for (const res of [await ctx.request(`/invite/${token}`), await ctx.signUp(token)]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("This link is invalid or has expired.");
    }
    expect((await ctx.request("/invite/unknown-token")).status).toBe(404);
    expect(ctx.tenants.getUserByTenant(tenant.id)).toBeNull();
  });

  it("password under 12 chars re-renders with an error", async () => {
    const ctx = setup();
    const { tenant, token } = ctx.invite();
    const short = await ctx.signUp(token, "alice", "short-pass1");
    expect(short.status).toBe(400);
    const html = await short.text();
    expect(html).toContain("Password must be at least 12 characters.");
    expect(html).toContain('value="alice"');
    expect(html).not.toContain("short-pass1");
    const mismatch = await ctx.post(`/invite/${token}`, {
      username: "alice",
      password: PASSWORD,
      password_confirm: `${PASSWORD}!`,
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain("Passwords do not match.");
    const badName = await ctx.signUp(token, "no spaces allowed");
    expect(badName.status).toBe(400);
    expect(await badName.text()).toContain(
      "Username must be 3 to 32 letters, digits, dots, dashes or underscores.",
    );
    expect(ctx.tenants.getUserByTenant(tenant.id)).toBeNull();
    expect(ctx.tenants.linkState(token, "invite")?.state).toBe("valid");
  });

  it("a taken username re-renders the form and keeps the link usable", async () => {
    const ctx = setup();
    await ctx.onboarded("First", "alice");
    const { tenant, token } = ctx.invite("Second");
    const res = await ctx.signUp(token, "ALICE");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This username is taken.");
    expect(ctx.tenants.getUserByTenant(tenant.id)).toBeNull();
    expect((await ctx.signUp(token, "bob")).status).toBe(303);
  });

  it("refuses an invite whose tenant is no longer invited", async () => {
    const ctx = setup();
    const { tenant, token } = ctx.invite();
    ctx.tenants.setStatus(tenant.id, "revoked");
    const res = await ctx.signUp(token);
    expect(res.status).toBe(410);
    expect(ctx.tenants.getUserByTenant(tenant.id)).toBeNull();
  });

  it("a tenant revoked during sign-up stays revoked and gets no cookie", async () => {
    const ctx = setup();
    const { tenant, token } = ctx.invite();
    const createUser = ctx.tenants.createUser;
    ctx.tenants.createUser = async (q) => {
      const user = await createUser.call(ctx.tenants, q);
      ctx.tenants.setStatus(tenant.id, "revoked");
      return user;
    };
    const res = await ctx.signUp(token);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("This invite is no longer valid.");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(ctx.tenants.getTenant(tenant.id)?.status).toBe("revoked");
  });

  it("rejects cross-site and origin-less form posts", async () => {
    const ctx = setup();
    const { tenant, token } = ctx.invite();
    const fields = { username: "alice", password: PASSWORD, password_confirm: PASSWORD };
    for (const headers of <Record<string, string>[]>[
      { origin: "https://evil.example" },
      { origin: "null" },
      {},
      { referer: "https://evil.example/page" },
    ]) {
      const res = await ctx.post(`/invite/${token}`, fields, headers);
      expect(res.status).toBe(403);
    }
    expect(ctx.tenants.getUserByTenant(tenant.id)).toBeNull();
    // Without Origin, a same-origin Referer is accepted.
    const ok = await ctx.post(`/invite/${token}`, fields, { referer: `${BASE}/invite/${token}` });
    expect(ok.status).toBe(303);
  });
});

describe("reset", () => {
  it("reset changes the password and revokes old tokens", async () => {
    const ctx = setup();
    const { tenant } = await ctx.onboarded();
    const user = ctx.tenants.getUserByTenant(tenant.id);
    if (!user) throw new Error("unreachable");
    const { clientId } = ctx.auth.registerClient({ redirectUris: ["https://app.example/cb"] });
    const tokens = ctx.auth.issueTokens(clientId, "mcp", user.id);
    const { token } = ctx.tenants.issueLink(tenant.id, "reset", 72 * HOUR);

    const page = await ctx.request(`/reset/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="password"');

    const short = await ctx.post(`/reset/${token}`, {
      password: "short",
      password_confirm: "short",
    });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain("Password must be at least 12 characters.");

    const fresh = "a brand new long password";
    const res = await ctx.post(`/reset/${token}`, { password: fresh, password_confirm: fresh });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Password changed");
    expect(await ctx.tenants.verifyPassword("alice", fresh)).not.toBeNull();
    expect(await ctx.tenants.verifyPassword("alice", PASSWORD)).toBeNull();
    expect(ctx.auth.verifyAccessToken(tokens.accessToken)).toBeNull();
    expect(ctx.auth.rotateRefreshToken(tokens.refreshToken, clientId)).toBeNull();

    const again = await ctx.post(`/reset/${token}`, { password: fresh, password_confirm: fresh });
    expect(again.status).toBe(410);
    expect(await again.text()).toContain(USED);
  });

  it("expired or unknown reset link → 404; an invite token is not a reset token", async () => {
    const ctx = setup();
    const { tenant, token: inviteToken } = await ctx.onboarded();
    const { token } = ctx.tenants.issueLink(tenant.id, "reset", HOUR);
    expect((await ctx.request(`/reset/${inviteToken}`)).status).toBe(404);
    ctx.advance(HOUR);
    const res = await ctx.post(`/reset/${token}`, {
      password: PASSWORD,
      password_confirm: PASSWORD,
    });
    expect(res.status).toBe(404);
  });
});

describe("pair", () => {
  it("without a cookie shows the login form", async () => {
    const ctx = setup();
    const res = await ctx.request("/pair");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
  });

  it("pair shows QR while SCAN_QR_CODE", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "SCAN_QR_CODE");
    const res = await ctx.pairPage(cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<img src="data:image/png;base64,ZmFrZS1xcg=="');
    expect(html).toContain('<meta http-equiv="refresh" content="5">');
    expect(html).toContain(TRUST);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("other pages do not allow data: images", async () => {
    const ctx = setup();
    const { token } = ctx.invite();
    const res = await ctx.request(`/invite/${token}`);
    expect(res.headers.get("content-security-policy")).not.toContain("img-src");
  });

  it("pair WORKING with a free waId → tenant active", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "WORKING");
    ctx.sessions.setMe(tenant.wahaSession, "51999888777@c.us");
    const res = await ctx.pairPage(cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("WhatsApp is connected");
    expect(html).not.toContain("http-equiv");
    expect(ctx.tenants.getTenant(tenant.id)).toMatchObject({
      status: "active",
      waId: "51999888777@c.us",
    });
  });

  it("pair WORKING with a taken waId → session logged out, tenant stays pairing", async () => {
    const ctx = setup();
    const first = await ctx.onboarded("First", "alice");
    ctx.sessions.setState(first.tenant.wahaSession, "WORKING");
    ctx.sessions.setMe(first.tenant.wahaSession, "51999888777@c.us");
    await ctx.pairPage(first.cookie);
    const second = await ctx.onboarded("Second", "bob");
    ctx.sessions.setState(second.tenant.wahaSession, "WORKING");
    ctx.sessions.setMe(second.tenant.wahaSession, "51999888777@c.us");
    const res = await ctx.pairPage(second.cookie);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(TAKEN);
    expect(ctx.sessions.calls).toContain(`logout:${second.tenant.wahaSession}`);
    expect(ctx.sessions.calls).not.toContain(`logout:${first.tenant.wahaSession}`);
    expect(ctx.tenants.getTenant(second.tenant.id)).toMatchObject({
      status: "pairing",
      waId: null,
    });
    expect(ctx.tenants.getTenant(first.tenant.id)?.status).toBe("active");
  });

  it("an active tenant that is WORKING sees the done page", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "WORKING");
    ctx.sessions.setMe(tenant.wahaSession, "51999888777@c.us");
    await ctx.pairPage(cookie);
    const res = await ctx.pairPage(cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("WhatsApp is connected");
    expect(ctx.tenants.getTenant(tenant.id)?.status).toBe("active");
  });

  it("while the session starts or WAHA fails, the page waits and refreshes", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "STARTING");
    const starting = await ctx.pairPage(cookie);
    expect(starting.status).toBe(200);
    expect(await starting.text()).toContain('<meta http-equiv="refresh" content="5">');
    ctx.sessions.state = async () => {
      throw new Error("WAHA at http://waha.internal:3000 with key secret-key failed");
    };
    const down = await ctx.pairPage(cookie);
    expect(down.status).toBe(502);
    const html = await down.text();
    expect(html).toContain('<meta http-equiv="refresh" content="5">');
    expect(html).not.toContain("waha.internal");
    expect(html).not.toContain("secret-key");
  });

  it("logs in with username and password, then shows the status", async () => {
    const ctx = setup();
    const { tenant } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "SCAN_QR_CODE");
    const wrong = await ctx.post("/pair", { username: "alice", password: "wrong password!" });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Invalid username or password.");
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const res = await ctx.post("/pair", { username: "Alice", password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/pair`);
    const page = await ctx.pairPage(cookieOf(res));
    expect(await page.text()).toContain("data:image/png;base64,");
  });

  it("an active tenant can log in to re-pair after a disconnect", async () => {
    const ctx = setup();
    const { tenant } = await ctx.onboarded();
    ctx.tenants.setStatus(tenant.id, "active");
    ctx.sessions.setState(tenant.wahaSession, "SCAN_QR_CODE");
    const res = await ctx.post("/pair", { username: "alice", password: PASSWORD });
    expect(res.status).toBe(303);
    expect(await (await ctx.pairPage(cookieOf(res))).text()).toContain("data:image/png");
  });

  it("revoked tenant: pair login refused and its cookie no longer works", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.tenants.setStatus(tenant.id, "revoked");
    const res = await ctx.post("/pair", { username: "alice", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("This account is disabled.");
    expect(res.headers.get("set-cookie")).toBeNull();
    const page = await ctx.pairPage(cookie);
    expect(await page.text()).toContain('name="password"');
    expect(ctx.sessions.calls).toEqual([]);
  });

  it("pair login is rate limited per username and per address", async () => {
    const ctx = setup();
    await ctx.onboarded();
    for (let i = 0; i < 5; i++) {
      const ip = { origin: BASE, "x-forwarded-for": `198.51.100.${i}` };
      await ctx.post("/pair", { username: "alice", password: "wrong password!" }, ip);
    }
    const blocked = await ctx.post("/pair", { username: "alice", password: PASSWORD });
    expect(blocked.status).toBe(429);
  });

  it("a tampered, expired or orphaned cookie falls back to the login form", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "SCAN_QR_CODE");
    const [name, value] = cookie.split("=");
    const tampered = `${name}=${value?.slice(0, -2)}xx`;
    expect(await (await ctx.pairPage(tampered)).text()).toContain('name="password"');
    expect(await (await ctx.pairPage(cookie)).text()).toContain("data:image/png");
    ctx.advance(15 * 60_000 + 1);
    expect(await (await ctx.pairPage(cookie)).text()).toContain('name="password"');

    const other = await ctx.onboarded("Other", "bob");
    ctx.tenants.deleteTenant(other.tenant.id);
    expect(await (await ctx.pairPage(other.cookie)).text()).toContain('name="password"');
  });

  it("rejects a cross-site pair login", async () => {
    const ctx = setup();
    await ctx.onboarded();
    const res = await ctx.post(
      "/pair",
      { username: "alice", password: PASSWORD },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("secrecy", () => {
  it("pages never contain the WAHA API key, even when WAHA errors carry it", async () => {
    const ctx = setup();
    const { tenant, token, cookie } = await ctx.onboarded();
    const KEY = "waha-api-key-sentinel-0123456789";
    const fail = async () => {
      throw new Error(`GET http://waha:3000/api/sessions failed (X-Api-Key: ${KEY})`);
    };
    await ctx.request(`/invite/${token}`);
    ctx.sessions.state = fail;
    await ctx.pairPage(cookie);
    ctx.sessions.state = async () => "SCAN_QR_CODE";
    ctx.sessions.qr = fail;
    await ctx.pairPage(cookie);
    ctx.sessions.state = async () => "WORKING";
    ctx.sessions.me = fail;
    await ctx.pairPage(cookie);
    ctx.sessions.me = async () => ({ id: "taken@c.us" });
    const other = ctx.newTenant("Other");
    ctx.tenants.setWaId(other.id, "taken@c.us");
    ctx.sessions.logout = fail;
    await ctx.pairPage(cookie);
    await ctx.post("/pair", { username: "alice", password: PASSWORD });
    expect(ctx.tenants.getTenant(tenant.id)?.status).toBe("pairing");
    expect(ctx.seen.length).toBeGreaterThan(8);
    for (const text of ctx.seen) expect(text).not.toContain(KEY);
  });

  it("responses never contain link tokens or passwords", async () => {
    const ctx = setup();
    const { tenant, token, cookie } = await ctx.onboarded();
    await ctx.signUp(token);
    await ctx.post(`/invite/${token}`, {
      username: "x",
      password: "tiny",
      password_confirm: "tiny",
    });
    const reset = ctx.tenants.issueLink(tenant.id, "reset", HOUR);
    await ctx.request(`/reset/${reset.token}`);
    await ctx.post(`/reset/${reset.token}`, { password: "short", password_confirm: "short" });
    await ctx.post("/pair", { username: "alice", password: PASSWORD });
    await ctx.post("/pair", { username: "alice", password: "wrong password!" });
    ctx.sessions.setState(tenant.wahaSession, "SCAN_QR_CODE");
    await ctx.pairPage(cookie);
    expect(ctx.seen.length).toBeGreaterThan(10);
    for (const text of ctx.seen) {
      for (const secret of [token, reset.token, PASSWORD, "wrong password!", "tiny"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
