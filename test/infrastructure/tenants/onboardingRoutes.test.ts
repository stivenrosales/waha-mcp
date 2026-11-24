import { describe, expect, it } from "vitest";
import type { EmailSender, OutgoingEmail } from "../../../src/domain/ports/EmailSender.js";
import { createLoginLimiter } from "../../../src/infrastructure/auth/rateLimit.js";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createOnboardingRoutes } from "../../../src/infrastructure/tenants/onboardingRoutes.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../../fakes/FakeSessionAdmin.js";

const BASE = "https://mcp.example.com";
const HOUR = 3600_000;
const PASSWORD = "a long enough password";
const TRUST =
  "El administrador de este servidor puede acceder técnicamente a tus datos de WhatsApp. Continúa solo si confías en quien lo administra.";
const PRIVACY_LINK = '<a href="/privacidad">Cómo se tratan tus datos</a>';
const USED = "Este enlace ya se usó.";
const TAKEN = "Este número de WhatsApp ya está conectado a otra cuenta.";

function setup(
  opts: {
    webhook?: { url: string; secret: string };
    cacheRetentionDays?: number;
    email?: EmailSender;
  } = {},
) {
  let t = 1_800_000_000_000;
  const now = () => t;
  const db = openAuthDatabase(":memory:");
  const auth = createAuthStore(db, now);
  const tenants = createSqliteTenantStore(db, now);
  const sessions = new FakeSessionAdmin();
  const evicted: string[] = [];
  const app = createOnboardingRoutes({
    tenants,
    auth,
    sessions,
    registry: { evict: (id) => void evicted.push(id) },
    cookieSecret: new Uint8Array(32).fill(9),
    publicBaseUrl: BASE,
    limiter: createLoginLimiter({ now }),
    now,
    ...(opts.webhook ? { webhook: opts.webhook } : {}),
    ...(opts.cacheRetentionDays !== undefined
      ? { cacheRetentionDays: opts.cacheRetentionDays }
      : {}),
    ...(opts.email
      ? { passwordRecovery: { email: opts.email, limiter: createLoginLimiter({ now }) } }
      : {}),
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
  /** Sends both a username and an email: the form uses the email when email is on. */
  const signUp = (token: string, username = "alice", password = PASSWORD) =>
    post(`/invite/${token}`, {
      username,
      email: `${username}@example.com`,
      password,
      password_confirm: password,
    });
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
    evicted,
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
    expect(html).toContain(PRIVACY_LINK);
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

  it('second POST of the same invite → "Este enlace ya se usó."', async () => {
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
      expect(await res.text()).toContain("Este enlace no es válido o ya venció.");
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
    expect(html).toContain("La contraseña debe tener al menos 12 caracteres.");
    expect(html).toContain('value="alice"');
    expect(html).not.toContain("short-pass1");
    const mismatch = await ctx.post(`/invite/${token}`, {
      username: "alice",
      password: PASSWORD,
      password_confirm: `${PASSWORD}!`,
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain("Las contraseñas no coinciden.");
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
    expect(await res.text()).toContain("Ese usuario ya está en uso.");
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
    expect(await res.text()).toContain("Esta invitación ya no es válida.");
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
    expect(await short.text()).toContain("La contraseña debe tener al menos 12 caracteres.");

    const fresh = "a brand new long password";
    const res = await ctx.post(`/reset/${token}`, { password: fresh, password_confirm: fresh });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Contraseña cambiada");
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
    expect(html).toContain(PRIVACY_LINK);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  // WAHA still counts a FAILED session as running: /start is a no-op there, only /restart
  // stops and starts it.
  for (const [stopped, action] of [
    ["STOPPED", "start"],
    ["FAILED", "restart"],
  ] as const) {
    it(`pair ${action}s a ${stopped} session and waits for its QR`, async () => {
      const ctx = setup();
      const { tenant, cookie } = await ctx.onboarded();
      ctx.sessions.setState(tenant.wahaSession, stopped);
      const res = await ctx.pairPage(cookie);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(ctx.sessions.calls).toContain(`${action}:${tenant.wahaSession}`);
      const other = action === "start" ? "restart" : "start";
      expect(ctx.sessions.calls).not.toContain(`${other}:${tenant.wahaSession}`);
      expect(html).toContain("Preparando tu sesión de WhatsApp…");
      expect(html).toContain('<meta http-equiv="refresh" content="5">');
      expect(html).not.toContain("Pide al administrador");
      expect(await ctx.sessions.state(tenant.wahaSession)).toBe("STARTING");
    });
  }

  it("pair configures the missions webhook before starting a session, when missions are on", async () => {
    const webhook = { url: `${BASE}/webhooks/waha`, secret: "whsec-1" };
    for (const [stopped, action] of [
      ["STOPPED", "start"],
      ["FAILED", "restart"],
    ] as const) {
      const ctx = setup({ webhook });
      const { tenant, cookie } = await ctx.onboarded();
      ctx.sessions.setState(tenant.wahaSession, stopped);
      expect((await ctx.pairPage(cookie)).status).toBe(200);
      const calls = ctx.sessions.calls.filter((c) => !c.startsWith("state:"));
      expect(calls).toEqual([
        `configureWebhook:${tenant.wahaSession}`,
        `${action}:${tenant.wahaSession}`,
      ]);
      expect(ctx.sessions.webhooks.get(tenant.wahaSession)).toEqual(webhook);
    }
    // Missions off: nothing to configure.
    const off = setup();
    const { tenant, cookie } = await off.onboarded();
    off.sessions.setState(tenant.wahaSession, "STOPPED");
    await off.pairPage(cookie);
    expect(off.sessions.calls).not.toContain(`configureWebhook:${tenant.wahaSession}`);
  });

  it("pair still starts the session when configuring the webhook fails", async () => {
    const ctx = setup({ webhook: { url: `${BASE}/webhooks/waha`, secret: "whsec-1" } });
    ctx.sessions.configureWebhook = async () => {
      throw new Error("WAHA down");
    };
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "STOPPED");
    const res = await ctx.pairPage(cookie);
    expect(res.status).toBe(200);
    expect(ctx.sessions.calls).toContain(`start:${tenant.wahaSession}`);
  });

  it("pair does not restart a session that is already starting", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "STARTING");
    await ctx.pairPage(cookie);
    expect(ctx.sessions.calls).not.toContain(`start:${tenant.wahaSession}`);
    expect(ctx.sessions.calls).not.toContain(`restart:${tenant.wahaSession}`);
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
    expect(html).toContain("Tu WhatsApp está conectado");
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

  it("pairing a different phone evicts the tenant's runtime; the same phone does not", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "WORKING");
    ctx.sessions.setMe(tenant.wahaSession, "51999888777@c.us");
    await ctx.pairPage(cookie);
    // First pairing: no previous phone, nothing cached to drop.
    expect(ctx.evicted).toEqual([]);
    await ctx.pairPage(cookie);
    expect(ctx.evicted).toEqual([]);
    ctx.sessions.setMe(tenant.wahaSession, "51911222333@c.us");
    const res = await ctx.pairPage(cookie);
    expect(res.status).toBe(200);
    expect(ctx.tenants.getTenant(tenant.id)?.waId).toBe("51911222333@c.us");
    expect(ctx.evicted).toEqual([tenant.id]);
  });

  it("an active tenant that is WORKING sees the done page", async () => {
    const ctx = setup();
    const { tenant, cookie } = await ctx.onboarded();
    ctx.sessions.setState(tenant.wahaSession, "WORKING");
    ctx.sessions.setMe(tenant.wahaSession, "51999888777@c.us");
    await ctx.pairPage(cookie);
    const res = await ctx.pairPage(cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Tu WhatsApp está conectado");
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
    expect(await wrong.text()).toContain("Usuario o contraseña incorrectos.");
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
    expect(await res.text()).toContain("Esta cuenta está desactivada.");
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

describe("privacy", () => {
  it("explains, without a session, who can see the tenant's data", async () => {
    const ctx = setup();
    const res = await ctx.request("/privacidad");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Cómo se tratan tus datos</h1>");
    expect(html).toContain("no tiene cifrado de extremo a extremo");
    expect(html).toContain("puede acceder técnicamente a tus datos");
    expect(html).toContain("servicio de transcripción");
    expect(html).toContain("Nunca el contenido de tus mensajes");
    expect(html).toContain("Dispositivos vinculados");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("explains missions: who receives the conversations, retention and the admin promise", async () => {
    const ctx = setup();
    const html = await (await ctx.request("/privacidad")).text();
    expect(html).toContain("<h2>Misiones</h2>");
    expect(html).toContain("OpenRouter");
    expect(html).toContain("Anthropic");
    expect(html).toContain("30 días");
    expect(html).toContain("El administrador no accede al contenido de las misiones");
    // Honest about the two exceptions: suspended accounts, and metadata without encryption.
    expect(html).toContain("Si tu cuenta está suspendida, se guardan hasta que la reactiven");
    expect(html).toContain("se guardan sin ese cifrado");
    // The existing sections stay.
    expect(html).toContain("<h2>Qué se guarda</h2>");
    expect(html).toContain("<h2>Cómo salir</h2>");
  });

  it("explains the automatic deletion (90 days by default) and how to delete your data or unlink", async () => {
    const ctx = setup();
    const html = await (await ctx.request("/privacidad")).text();
    expect(html).toContain("<h2>Cuánto tiempo se guarda</h2>");
    expect(html).toContain(
      "Los mensajes guardados, sus ediciones, reacciones y votos, y las transcripciones se borran solos a los 90 días",
    );
    expect(html).toContain("<code>delete_my_data</code>");
    expect(html).toContain("<code>unlink_account</code>");
    expect(html).toContain("solo actúan sobre tu cuenta");
  });

  it("states the configured retention, or that it is kept until you delete it", async () => {
    const thirty = setup({ cacheRetentionDays: 30 });
    expect(await (await thirty.request("/privacidad")).text()).toContain(
      "las transcripciones se borran solos a los 30 días",
    );
    const forever = setup({ cacheRetentionDays: 0 });
    const html = await (await forever.request("/privacidad")).text();
    expect(html).toContain(
      "Este servidor no borra automáticamente los mensajes guardados ni las transcripciones",
    );
    expect(html).not.toContain("se borran solos a los");
  });
});

describe("invite email", () => {
  const signUpWith = (ctx: ReturnType<typeof setup>, token: string, email: string) =>
    ctx.post(`/invite/${token}`, { email, password: PASSWORD, password_confirm: PASSWORD });
  const withEmail = () => setup({ email: { send: async () => {} } });

  it("the invite page has no email field when email is off", async () => {
    const ctx = setup();
    const { token } = ctx.invite();
    const body = await (await ctx.request(`/invite/${token}`)).text();
    expect(body).not.toContain('name="email"');
    expect(body).toContain('name="username"');
  });

  it("with email on, the invite page asks for the email instead of a username", async () => {
    const ctx = withEmail();
    const { token } = ctx.invite();
    const body = await (await ctx.request(`/invite/${token}`)).text();
    expect(body).toMatch(/<input id="email" name="email" type="email"[^>]*required/);
    expect(body).not.toContain('name="username"');
  });

  it("creates the user from the email, lowercased, with a username made from it", async () => {
    const ctx = withEmail();
    const { tenant, token } = ctx.invite();
    expect((await signUpWith(ctx, token, " Alice.Perez@Example.com ")).status).toBe(303);
    const user = ctx.tenants.getUserByTenant(tenant.id);
    expect(user?.email).toBe("alice.perez@example.com");
    expect(user?.username).toBe("alice.perez");
    expect(await ctx.tenants.verifyPassword("alice.perez", PASSWORD)).not.toBeNull();
  });

  it("gives a second person with the same name before the @ a different username", async () => {
    const ctx = withEmail();
    const first = ctx.invite("Acme");
    await signUpWith(ctx, first.token, "ana@one.com");
    const second = ctx.invite("Beta");
    expect((await signUpWith(ctx, second.token, "ana@two.com")).status).toBe(303);
    expect(ctx.tenants.getUserByTenant(second.tenant.id)?.username).toMatch(/^ana-\d{4}$/);
  });

  it("requires a valid email that no other account uses, and keeps the link usable", async () => {
    const ctx = withEmail();
    const { tenant, token } = ctx.invite();
    const missing = await signUpWith(ctx, token, "");
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("Escribe tu correo.");
    const invalid = await signUpWith(ctx, token, "not-an-email");
    expect(await invalid.text()).toContain("Ese correo no es válido.");
    expect(ctx.tenants.getUserByTenant(tenant.id)).toBeNull();
    const other = ctx.invite("Beta");
    await signUpWith(ctx, other.token, "taken@example.com");
    const taken = await signUpWith(ctx, token, "TAKEN@example.com");
    expect(await taken.text()).toContain("Ese correo ya está en uso.");
    expect((await signUpWith(ctx, token, "free@example.com")).status).toBe(303);
  });

  it("a double submit whose name before the @ is taken answers used, not an error", async () => {
    for (let run = 0; run < 5; run++) {
      const ctx = withEmail();
      const first = ctx.invite("Acme");
      await signUpWith(ctx, first.token, "alice@one.com");
      const { tenant, token } = ctx.invite("Beta");
      const results = await Promise.all([
        signUpWith(ctx, token, "alice@two.com"),
        signUpWith(ctx, token, "alice@two.com"),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([303, 410]);
      expect(ctx.tenants.getUserByTenant(tenant.id)?.username).toMatch(/^alice-\d{4}$/);
    }
  });

  it("without email, still signs up with a username", async () => {
    const ctx = setup();
    const { tenant, token } = ctx.invite();
    expect((await ctx.signUp(token)).status).toBe(303);
    expect(ctx.tenants.getUserByTenant(tenant.id)?.email).toBeNull();
  });
});

describe("forgot password", () => {
  const SENT =
    "Si hay una cuenta con ese correo, te enviamos un enlace para elegir una contraseña nueva.";
  const outbox = () => {
    const sent: OutgoingEmail[] = [];
    const sender: EmailSender = {
      send: async (m) => {
        sent.push(m);
      },
    };
    return { sent, sender };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const withEmail = async (sender: EmailSender) => {
    const ctx = setup({ email: sender });
    const { tenant } = await ctx.onboarded();
    const user = ctx.tenants.getUserByTenant(tenant.id) as { id: string };
    ctx.tenants.setEmail(user.id, "alice@example.com");
    return { ctx, tenant, user };
  };

  it("is not offered when email is off", async () => {
    const ctx = setup();
    expect((await ctx.request("/forgot")).status).toBe(404);
    expect((await ctx.post("/forgot", { email: "a@b.co" })).status).toBe(404);
    expect(await (await ctx.request("/pair")).text()).not.toContain("/forgot");
  });

  it("the pair sign-in page links to it when email is on", async () => {
    const { sender } = outbox();
    const ctx = setup({ email: sender });
    expect(await (await ctx.request("/pair")).text()).toContain('href="/forgot"');
    expect(await (await ctx.request("/forgot")).text()).toContain('name="email"');
  });

  it("emails a 1-hour reset link that sets a new password", async () => {
    const { sent, sender } = outbox();
    const { ctx, tenant } = await withEmail(sender);
    const res = await ctx.post("/forgot", { email: " Alice@Example.com " });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SENT);
    await flush();
    expect(sent).toHaveLength(1);
    const mail = sent[0] as OutgoingEmail;
    expect(mail.to).toBe("alice@example.com");
    expect(mail.subject).toBe("Restablece tu contraseña de Zenbox");
    const url = /https:\/\/mcp\.example\.com\/reset\/[A-Za-z0-9_-]+/.exec(mail.text)?.[0] as string;
    expect(mail.text).toContain("alice");
    expect(mail.html).toContain(url);
    const token = url.slice(url.lastIndexOf("/") + 1);
    expect(ctx.tenants.peekLink(token, "reset")).toEqual({ tenantId: tenant.id });
    ctx.advance(HOUR + 1);
    expect(ctx.tenants.peekLink(token, "reset")).toBeNull();
  });

  it("answers the same for an unknown email and sends nothing", async () => {
    const { sent, sender } = outbox();
    const { ctx } = await withEmail(sender);
    const res = await ctx.post("/forgot", { email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SENT);
    await flush();
    expect(sent).toEqual([]);
  });

  it("answers the same when the email provider fails", async () => {
    const { ctx } = await withEmail({
      send: async () => {
        throw new Error("provider down");
      },
    });
    const res = await ctx.post("/forgot", { email: "alice@example.com" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SENT);
  });

  it("refuses cross-site posts and rate-limits repeated requests", async () => {
    const { sent, sender } = outbox();
    const { ctx } = await withEmail(sender);
    expect(
      (
        await ctx.post(
          "/forgot",
          { email: "alice@example.com" },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    for (let i = 0; i < 5; i++) await ctx.post("/forgot", { email: "alice@example.com" });
    const blocked = await ctx.post("/forgot", { email: "alice@example.com" });
    expect(blocked.status).toBe(429);
    await flush();
    expect(sent).toHaveLength(5);
  });
});
