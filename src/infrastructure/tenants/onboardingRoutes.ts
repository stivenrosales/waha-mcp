import { createHmac, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SessionAdmin } from "../../domain/ports/SessionAdmin.js";
import type { LinkKind, Tenant, TenantStore, User } from "../../domain/ports/TenantStore.js";
import { USERNAME_PATTERN, USERNAME_RULE } from "../../domain/username.js";
import { authenticateLogin } from "../auth/login.js";
import { HTML_SECURITY_HEADERS, messagePage } from "../auth/loginPage.js";
import type { LoginLimiter } from "../auth/rateLimit.js";
import type { AuthStore } from "../auth/store.js";
import {
  invitePage,
  pairDonePage,
  pairLoginPage,
  pairQrPage,
  pairTakenPage,
  pairWaitPage,
  resetPage,
} from "./onboardingPages.js";

const MAX_BODY_BYTES = 16 * 1024;
const MIN_PASSWORD = 12;
/** Upper bound so a huge password cannot make scrypt hash megabytes. */
const MAX_PASSWORD = 1024;
const PAIR_COOKIE = "waha_pair";
const PAIR_COOKIE_TTL_MS = 15 * 60_000;
const QR_MIMETYPE = /^image\/(png|jpeg)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const LINK_USED = "This link was already used.";
const INVITE_GONE = "This invite is no longer valid.";
const LINK_INVALID = "This link is invalid or has expired.";
const NUMBER_TAKEN = "This WhatsApp number is already connected to another account.";

/** Statuses whose user may open the pairing page. */
const PAIRABLE = new Set(["pairing", "active"]);

type Html = (body: string, status?: ContentfulStatusCode) => Response;

/**
 * Invite sign-up, password reset and WhatsApp pairing pages.
 *
 * CSRF: every POST must carry an `Origin` (or, without it, a `Referer`) whose origin is
 * PUBLIC_BASE_URL. These pages send `Referrer-Policy: same-origin` so that browsers report the
 * real origin on their own form posts (with `no-referrer` they send `Origin: null`).
 */
export function createOnboardingRoutes(deps: {
  tenants: TenantStore;
  auth: AuthStore;
  sessions: SessionAdmin;
  /** Drops a tenant's cached runtime, so the next request re-checks the paired account. */
  registry: { evict(tenantId: string): void };
  cookieSecret: Uint8Array;
  publicBaseUrl: string;
  limiter: LoginLimiter;
  now?: () => number;
}): Hono {
  const { tenants, auth, sessions, registry, limiter } = deps;
  const now = deps.now ?? Date.now;
  const base = deps.publicBaseUrl;
  const baseOrigin = new URL(base).origin;
  const app = new Hono();

  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.text("Request body too large.", 413),
  });

  const page =
    (c: Context, opts: { qr?: boolean } = {}): Html =>
    (body, status = 200) => {
      for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) c.header(name, value);
      c.header("Referrer-Policy", "same-origin");
      if (opts.qr) {
        c.header(
          "Content-Security-Policy",
          `${HTML_SECURITY_HEADERS["Content-Security-Policy"]}; img-src data:`,
        );
      }
      return c.html(body, status);
    };

  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header("origin");
    if (origin !== undefined) return origin === baseOrigin;
    const referer = c.req.header("referer");
    return referer !== undefined && URL.canParse(referer) && new URL(referer).origin === baseOrigin;
  };

  const crossSite = (html: Html) =>
    html(
      messagePage(
        "Request blocked",
        "This form must be sent from this server's own page. Reload the page and try again.",
      ),
      403,
    );

  const readForm = async (c: Context) => new URLSearchParams(await c.req.text());

  /** The error for a chosen password, or null when it is acceptable. */
  const passwordError = (form: URLSearchParams): string | null => {
    const password = form.get("password") ?? "";
    if (password.length < MIN_PASSWORD) return "Password must be at least 12 characters.";
    if (password.length > MAX_PASSWORD) return "Password is too long.";
    if (password !== form.get("password_confirm")) return "Passwords do not match.";
    return null;
  };

  /** Rejects an unknown, expired or used link with its page; null when the link is usable. */
  const linkProblem = (
    html: Html,
    token: string,
    kind: LinkKind,
  ): { response: Response } | { tenantId: string } => {
    const link = tenants.linkState(token, kind);
    if (!link || link.state === "expired") {
      return { response: html(messagePage("Link not valid", LINK_INVALID), 404) };
    }
    if (link.state === "used") return { response: html(messagePage("Link used", LINK_USED), 410) };
    return { tenantId: link.tenantId };
  };

  // --- Pairing cookie: HMAC-SHA256 over base64url(JSON { u: userId, e: expiry ms }) ---

  const sign = (payload: string): string =>
    createHmac("sha256", deps.cookieSecret).update(`pair:${payload}`).digest("base64url");

  const setPairCookie = (c: Context, userId: string): void => {
    const payload = Buffer.from(
      JSON.stringify({ u: userId, e: now() + PAIR_COOKIE_TTL_MS }),
    ).toString("base64url");
    c.header(
      "Set-Cookie",
      `${PAIR_COOKIE}=${payload}.${sign(payload)}; Max-Age=${PAIR_COOKIE_TTL_MS / 1000}; Path=/pair; HttpOnly; Secure; SameSite=Strict`,
    );
  };

  /** The user and tenant of a valid, unexpired pairing cookie whose tenant may still pair. */
  const pairingSession = (c: Context): { user: User; tenant: Tenant } | null => {
    const value = getCookie(c, PAIR_COOKIE);
    if (!value) return null;
    const [payload, mac] = value.split(".");
    if (!payload || !mac) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const { u, e } = (claims ?? {}) as { u?: unknown; e?: unknown };
    if (typeof u !== "string" || typeof e !== "number" || e <= now()) return null;
    const user = tenants.getUser(u);
    const tenant = user ? tenants.getTenant(user.tenantId) : null;
    if (!user || !tenant || !PAIRABLE.has(tenant.status)) return null;
    return { user, tenant };
  };

  // --- Invite: choose username and password ---

  app.get("/invite/:token", (c) => {
    const html = page(c);
    const link = linkProblem(html, c.req.param("token"), "invite");
    return "response" in link ? link.response : html(invitePage());
  });

  app.post("/invite/:token", limitBody, async (c) => {
    const html = page(c);
    if (!sameOrigin(c)) return crossSite(html);
    const token = c.req.param("token");
    const link = linkProblem(html, token, "invite");
    if ("response" in link) return link.response;
    const { tenantId } = link;
    const used = () => html(messagePage("Link used", LINK_USED), 410);
    if (tenants.getTenant(tenantId)?.status !== "invited") return used();

    const form = await readForm(c);
    const username = form.get("username") ?? "";
    const retry = (error: string) => html(invitePage({ username, error }), 400);
    if (!USERNAME_PATTERN.test(username)) {
      return retry(`Username must be ${USERNAME_RULE}.`);
    }
    const problem = passwordError(form);
    if (problem) return retry(problem);

    // users.tenant_id is UNIQUE: of two concurrent sign-ups exactly one insert succeeds, so the
    // user is created before the link is consumed and a taken username leaves the link usable.
    let user: User | "username_taken";
    try {
      user = await tenants.createUser({
        tenantId,
        username,
        password: form.get("password") ?? "",
        role: "member",
      });
    } catch (error) {
      if (tenants.getUserByTenant(tenantId)) return used();
      throw error;
    }
    if (user === "username_taken") {
      // A concurrent sign-up with the same username won the race for this very tenant.
      return tenants.getUserByTenant(tenantId) ? used() : retry("This username is taken.");
    }
    // The UNIQUE insert above made this request the single winner, so consumeLink fails only when
    // the link expired during hashing (the user exists by then: finish the sign-up) or when the
    // link was removed or re-issued meanwhile (stop: the admin replaced it).
    // Crash window: a crash between createUser and here leaves a user on an "invited" tenant with
    // an unused link; retrying the link answers "already used" and the admin re-invites.
    if (
      !tenants.consumeLink(token, "invite") &&
      tenants.linkState(token, "invite")?.state !== "expired"
    ) {
      return used();
    }
    // Conditional: the tenant may have been revoked while the password was hashed.
    if (!tenants.transitionStatus(tenantId, "invited", "pairing")) {
      return html(messagePage("Invite not valid", INVITE_GONE), 410);
    }
    setPairCookie(c, user.id);
    return c.redirect(`${base}/pair`, 303);
  });

  // --- Reset: choose a new password ---

  app.get("/reset/:token", (c) => {
    const html = page(c);
    const link = linkProblem(html, c.req.param("token"), "reset");
    return "response" in link ? link.response : html(resetPage());
  });

  app.post("/reset/:token", limitBody, async (c) => {
    const html = page(c);
    if (!sameOrigin(c)) return crossSite(html);
    const token = c.req.param("token");
    const link = linkProblem(html, token, "reset");
    if ("response" in link) return link.response;
    const form = await readForm(c);
    const problem = passwordError(form);
    if (problem) return html(resetPage({ error: problem }), 400);
    const user = tenants.getUserByTenant(link.tenantId);
    if (!user) return html(messagePage("Link not valid", LINK_INVALID), 404);
    if (!tenants.consumeLink(token, "reset")) {
      return html(messagePage("Link used", LINK_USED), 410);
    }
    await tenants.setPassword(user.id, form.get("password") ?? "");
    auth.revokeUser(user.id);
    return html(
      messagePage(
        "Password changed",
        "Your password was changed and every connected app was signed out. Sign in again from your MCP client.",
      ),
    );
  });

  // --- Pair: link WhatsApp by scanning the session's QR ---

  const pairStatus = async (html: Html, user: User, tenant: Tenant): Promise<Response> => {
    const name = tenant.wahaSession;
    try {
      const state = await sessions.state(name);
      if (state === "SCAN_QR_CODE") {
        const qr = await sessions.qr(name);
        if (qr && QR_MIMETYPE.test(qr.mimetype) && BASE64.test(qr.base64)) {
          return html(
            pairQrPage({
              dataUri: `data:${qr.mimetype};base64,${qr.base64}`,
              showTrustNotice: user.role === "member",
            }),
          );
        }
      } else if (state === "WORKING") {
        const me = await sessions.me(name);
        if (me) {
          const previous = tenants.getTenant(tenant.id)?.waId ?? null;
          if (tenants.setWaId(tenant.id, me.id) === "taken") {
            await sessions.logout(name);
            return html(pairTakenPage(NUMBER_TAKEN), 409);
          }
          // A different phone: the cached runtime still serves the old account's cache.
          if (previous !== null && previous !== me.id) registry.evict(tenant.id);
          const current = tenants.getTenant(tenant.id)?.status;
          if (current === "pairing") tenants.setStatus(tenant.id, "active");
          return html(pairDonePage(`${base}/mcp`));
        }
      } else if (state === "STOPPED" || state === "FAILED") {
        return html(
          pairWaitPage(
            "WhatsApp session not running",
            "Your WhatsApp session is not running. Ask the administrator to restart it.",
          ),
        );
      }
      return html(pairWaitPage("Connecting", "Preparing your WhatsApp session…"));
    } catch {
      // Never echo the error: it may name the WAHA URL.
      return html(
        pairWaitPage("WhatsApp unavailable", "WhatsApp is not reachable right now."),
        502,
      );
    }
  };

  app.get("/pair", async (c) => {
    const html = page(c, { qr: true });
    const session = pairingSession(c);
    if (!session) return html(pairLoginPage());
    return pairStatus(html, session.user, session.tenant);
  });

  app.post("/pair", limitBody, async (c) => {
    const html = page(c, { qr: true });
    if (!sameOrigin(c)) return crossSite(html);
    const form = await readForm(c);
    const username = form.get("username") ?? "";
    const user = await authenticateLogin(c, form, { tenants, limiter });
    if (user === "blocked") {
      return html(
        messagePage("Too many attempts", "Too many failed attempts. Try again later."),
        429,
      );
    }
    if (user === "invalid") {
      return html(pairLoginPage({ username, error: "Invalid username or password." }), 401);
    }
    const status = tenants.getTenant(user.tenantId)?.status;
    if (status === undefined || !PAIRABLE.has(status)) {
      return html(pairLoginPage({ username, error: "This account is disabled." }), 403);
    }
    setPairCookie(c, user.id);
    return c.redirect(`${base}/pair`, 303);
  });

  return app;
}
