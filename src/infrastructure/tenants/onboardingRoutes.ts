import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DEFAULT_CACHE_RETENTION_DAYS, EMAIL_PATTERN } from "../../config.js";
import { EmailSendError } from "../../domain/errors.js";
import type { EmailSender, OutgoingEmail } from "../../domain/ports/EmailSender.js";
import type { SessionAdmin, WebhookTarget } from "../../domain/ports/SessionAdmin.js";
import type { LinkKind, Tenant, TenantStore, User } from "../../domain/ports/TenantStore.js";
import { USERNAME_PATTERN, USERNAME_RULE } from "../../domain/username.js";
import { authenticateLogin } from "../auth/login.js";
import { escapeHtml, HTML_SECURITY_HEADERS, messagePage } from "../auth/loginPage.js";
import { clientKey, type LoginLimiter } from "../auth/rateLimit.js";
import type { AuthStore } from "../auth/store.js";
import type { Logger } from "../mcp/defineTool.js";
import {
  forgotPage,
  invitePage,
  PAIR_POLL_HASH,
  PRIVACY_PATH,
  pairDonePage,
  pairLoginPage,
  pairQrPage,
  pairTakenPage,
  pairWaitPage,
  privacyPage,
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

const LINK_USED = "Este enlace ya se usó.";
/** A reset link sent by email is valid this long (admin-issued links last 72 h). */
const RECOVERY_LINK_TTL_MS = 60 * 60_000;
const FORGOT_SENT =
  "Si hay una cuenta con ese correo, te enviamos un enlace para elegir una contraseña nueva. Revisa también la carpeta de spam.";

/**
 * The internal username of an account created from its email: the part before the @, cut to
 * the allowed characters and length; `suffixed` adds a random 4-digit tail for collisions.
 */
function usernameFromEmail(email: string, suffixed = false): string {
  let base = (email.split("@")[0] ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 26);
  if (base.length < 3) base = `${base}user`.slice(0, 26);
  return suffixed ? `${base}-${randomInt(1000, 10000)}` : base;
}

/** The password-recovery email, plain text plus a minimal HTML copy. */
function resetEmail(username: string, to: string, url: string): OutgoingEmail {
  const text = `Hola ${username}:\n\nPara elegir una contraseña nueva, abre este enlace. Vale 1 hora y se usa una sola vez:\n${url}\n\nSi no lo pediste, ignora este correo: tu contraseña no cambia.`;
  const html = `<p>Hola ${escapeHtml(username)}:</p><p>Para elegir una contraseña nueva, abre este enlace. Vale 1 hora y se usa una sola vez:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>Si no lo pediste, ignora este correo: tu contraseña no cambia.</p>`;
  return { to, subject: "Restablece tu contraseña de Zenbox", text, html };
}
const INVITE_GONE = "Esta invitación ya no es válida.";
const LINK_INVALID = "Este enlace no es válido o ya venció.";
const NUMBER_TAKEN = "Este número de WhatsApp ya está conectado a otra cuenta.";

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
  /** False on a single-owner server: every `/invite/:token` answers 404 (default true). */
  invites?: boolean;
  now?: () => number;
  /** The missions webhook a session gets before it is (re)started; absent when missions are off. */
  webhook?: WebhookTarget;
  logger?: Logger;
  /** `CACHE_RETENTION_DAYS`, stated on the privacy page; default 90. */
  cacheRetentionDays?: number;
  /** Password recovery by email (`/forgot`); absent when email is off. Its own limiter. */
  passwordRecovery?: { email: EmailSender; limiter: LoginLimiter };
}): Hono {
  const { tenants, auth, sessions, registry, limiter } = deps;
  const now = deps.now ?? Date.now;
  const base = deps.publicBaseUrl;
  const baseOrigin = new URL(base).origin;
  const app = new Hono();
  const recovery = deps.passwordRecovery;
  const forgotUrl = recovery ? "/forgot" : undefined;

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
        // Pair pages also run the background check: its script hash, and fetches of themselves.
        const base = HTML_SECURITY_HEADERS["Content-Security-Policy"].replace(
          "script-src ",
          `script-src 'sha256-${PAIR_POLL_HASH}' `,
        );
        c.header("Content-Security-Policy", `${base}; connect-src 'self'; img-src data:`);
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
        "Solicitud bloqueada",
        "Este formulario debe enviarse desde la página de este servidor. Recarga la página e inténtalo de nuevo.",
      ),
      403,
    );

  const readForm = async (c: Context) => new URLSearchParams(await c.req.text());

  /** The error for a chosen password, or null when it is acceptable. */
  const passwordError = (form: URLSearchParams): string | null => {
    const password = form.get("password") ?? "";
    if (password.length < MIN_PASSWORD) return "La contraseña debe tener al menos 12 caracteres.";
    if (password.length > MAX_PASSWORD) return "La contraseña es demasiado larga.";
    if (password !== form.get("password_confirm")) return "Las contraseñas no coinciden.";
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
      return { response: html(messagePage("Enlace no válido", LINK_INVALID), 404) };
    }
    if (link.state === "used")
      return { response: html(messagePage("Enlace ya usado", LINK_USED), 410) };
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

  const invitesOn = deps.invites ?? true;
  const invitesOff = (html: Html): Response =>
    html(messagePage("Enlace no válido", LINK_INVALID), 404);

  app.get("/invite/:token", (c) => {
    const html = page(c);
    if (!invitesOn) return invitesOff(html);
    const link = linkProblem(html, c.req.param("token"), "invite");
    return "response" in link ? link.response : html(invitePage({ askEmail: Boolean(recovery) }));
  });

  app.post("/invite/:token", limitBody, async (c) => {
    const html = page(c);
    if (!invitesOn) return invitesOff(html);
    if (!sameOrigin(c)) return crossSite(html);
    const token = c.req.param("token");
    const link = linkProblem(html, token, "invite");
    if ("response" in link) return link.response;
    const { tenantId } = link;
    const used = () => html(messagePage("Enlace ya usado", LINK_USED), 410);
    if (tenants.getTenant(tenantId)?.status !== "invited") return used();

    const form = await readForm(c);
    // With email on, people sign up with their email (the username is made from it and never
    // shown); without it, they choose a username.
    const email = recovery ? (form.get("email") ?? "").trim().toLowerCase() : "";
    const retry = (error: string) =>
      html(
        invitePage({
          username: form.get("username") ?? "",
          email,
          error,
          askEmail: Boolean(recovery),
        }),
        400,
      );
    if (recovery) {
      if (!email) return retry("Escribe tu correo.");
      if (email.length > 254 || !EMAIL_PATTERN.test(email))
        return retry("Ese correo no es válido.");
      if (tenants.getUserByEmail(email)) return retry("Ese correo ya está en uso.");
    } else if (!USERNAME_PATTERN.test(form.get("username") ?? "")) {
      return retry(`Username must be ${USERNAME_RULE}.`);
    }
    const problem = passwordError(form);
    if (problem) return retry(problem);
    const username = recovery ? usernameFromEmail(email) : (form.get("username") ?? "");

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
    // A username made from an email that someone already has gets a random suffix instead.
    for (let i = 0; recovery && user === "username_taken" && i < 5; i++) {
      if (tenants.getUserByTenant(tenantId)) return used();
      try {
        user = await tenants.createUser({
          tenantId,
          username: usernameFromEmail(email, true),
          password: form.get("password") ?? "",
          role: "member",
        });
      } catch (error) {
        // A concurrent submit of this same invite won the users.tenant_id race meanwhile.
        if (tenants.getUserByTenant(tenantId)) return used();
        throw error;
      }
    }
    if (user === "username_taken") {
      // A concurrent sign-up with the same username won the race for this very tenant.
      return tenants.getUserByTenant(tenantId) ? used() : retry("Ese usuario ya está en uso.");
    }
    // Checked above; a concurrent sign-up taking the same email meanwhile leaves this one without.
    if (email) tenants.setEmail(user.id, email);
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
      return html(messagePage("Invitación no válida", INVITE_GONE), 410);
    }
    setPairCookie(c, user.id);
    return c.redirect(`${base}/pair`, 303);
  });

  // --- Forgot: email a reset link (only with email on) ---

  app.get("/forgot", (c) => {
    if (!recovery) return c.notFound();
    return page(c)(forgotPage());
  });

  app.post("/forgot", limitBody, async (c) => {
    if (!recovery) return c.notFound();
    const html = page(c);
    if (!sameOrigin(c)) return crossSite(html);
    const email = ((await readForm(c)).get("email") ?? "").trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || email.length > 254)
      return html(forgotPage({ email, error: "Ese correo no es válido." }), 400);
    // Every request counts, found or not: the limit bounds both mail volume and probing.
    const keys = [clientKey(c), `email:${email}`];
    if (keys.some((k) => recovery.limiter.isBlocked(k)))
      return html(
        messagePage("Demasiados intentos", "Demasiadas solicitudes. Inténtalo más tarde."),
        429,
      );
    recovery.limiter.recordFailure(keys);
    const user = tenants.getUserByEmail(email);
    if (user) {
      const { token } = tenants.issueLink(user.tenantId, "reset", RECOVERY_LINK_TTL_MS);
      // Not awaited: the answer and its timing must not reveal whether the account exists.
      void recovery.email
        .send(resetEmail(user.username, email, `${base}/reset/${token}`))
        .catch((error: unknown) => {
          const kind = error instanceof EmailSendError ? error.kind : "failed";
          deps.logger?.info(`forgot email failed tenant=${user.tenantId} kind=${kind}`);
        });
    }
    return html(messagePage("Revisa tu correo", FORGOT_SENT));
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
    if (!user) return html(messagePage("Enlace no válido", LINK_INVALID), 404);
    if (!tenants.consumeLink(token, "reset")) {
      return html(messagePage("Enlace ya usado", LINK_USED), 410);
    }
    await tenants.setPassword(user.id, form.get("password") ?? "");
    auth.revokeUser(user.id);
    return html(
      messagePage(
        "Contraseña cambiada",
        "Tu contraseña se cambió y se cerró la sesión en todas las aplicaciones conectadas. Vuelve a iniciar sesión desde tu cliente MCP.",
      ),
    );
  });

  // --- Pair: link WhatsApp by scanning the session's QR ---

  /**
   * Best effort, before a (re)start: a stopped session takes its new config without an extra
   * restart. A failure must not block pairing (startup configures it again); only the tenant id
   * is logged.
   */
  const configureWebhook = async (tenant: Tenant): Promise<void> => {
    if (!deps.webhook) return;
    try {
      await sessions.configureWebhook(tenant.wahaSession, deps.webhook);
    } catch {
      deps.logger?.info(`webhook configure tenant=${tenant.id} outcome=failed`);
    }
  };

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
      } else if (state === "STOPPED") {
        await configureWebhook(tenant);
        await sessions.start(name);
      } else if (state === "FAILED") {
        // WAHA fails a session whose QR nobody scanned in time (e.g. an invite opened days
        // later). It still counts as running, so only restart (stop + start) revives it;
        // the next refresh shows a fresh QR.
        await configureWebhook(tenant);
        await sessions.restart(name);
      }
      return html(pairWaitPage("Conectando", "Preparando tu sesión de WhatsApp…"));
    } catch {
      // Never echo the error: it may name the WAHA URL.
      return html(
        pairWaitPage(
          "WhatsApp no disponible",
          "No se puede conectar con WhatsApp en este momento.",
        ),
        502,
      );
    }
  };

  app.get(PRIVACY_PATH, (c) =>
    page(c)(
      privacyPage({ cacheRetentionDays: deps.cacheRetentionDays ?? DEFAULT_CACHE_RETENTION_DAYS }),
    ),
  );

  app.get("/pair", async (c) => {
    const html = page(c, { qr: true });
    const session = pairingSession(c);
    if (!session) return html(pairLoginPage({ forgotUrl }));
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
        messagePage("Demasiados intentos", "Demasiados intentos fallidos. Inténtalo más tarde."),
        429,
      );
    }
    if (user === "invalid") {
      return html(
        pairLoginPage({ username, error: "Usuario o contraseña incorrectos.", forgotUrl }),
        401,
      );
    }
    const status = tenants.getTenant(user.tenantId)?.status;
    if (status === undefined || !PAIRABLE.has(status)) {
      return html(pairLoginPage({ username, error: "Esta cuenta está desactivada." }), 403);
    }
    setPairCookie(c, user.id);
    return c.redirect(`${base}/pair`, 303);
  });

  return app;
}
