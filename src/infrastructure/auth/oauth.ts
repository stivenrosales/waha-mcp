import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTML_SECURITY_HEADERS, loginPage, logoutPage, messagePage } from "./loginPage.js";
import { clientKey, type LoginLimiter } from "./rateLimit.js";
import type { AuthStore } from "./store.js";

export const MAX_CLIENTS = 50;
const GRANTED_SCOPE = "mcp";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_STATE_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 200;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** RFC 6749 scope: space-separated tokens of printable ASCII except `"` and `\`. */
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/;

const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant-time comparison that does not leak length either. */
const safeEqual = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH || !URL.canParse(uri)) return false;
  const url = new URL(uri);
  if (uri.includes("#") || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
}

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  resource: string | null;
  /** The original parameters, carried through the login form and re-validated on POST. */
  echo: Record<string, string>;
}

type Validation =
  | { ok: true; request: AuthorizeRequest }
  /** The redirect URI cannot be trusted: show an error page, never redirect. */
  | { ok: false; page: string }
  /** Client and redirect URI are valid: report the error back to the client. */
  | { ok: false; redirect: string };

export function createOAuthRoutes(deps: {
  store: AuthStore;
  wahaApiKey: string;
  publicBaseUrl: string;
  limiter: LoginLimiter;
}): Hono {
  const { store, limiter } = deps;
  const base = deps.publicBaseUrl;
  const resourceUrl = `${base}/mcp`;
  const app = new Hono();

  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: "invalid_request", error_description: "Request body too large." }, 413),
  });

  const keyMatches = (candidate: string | null): boolean =>
    candidate !== null && safeEqual(candidate, deps.wahaApiKey);

  const isOwnResource = (value: string): boolean =>
    URL.canParse(value) &&
    [resourceUrl, base].includes(stripTrailingSlashes(new URL(value).toString()));

  const html = (c: Context, body: string, status: ContentfulStatusCode = 200) => {
    for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) c.header(name, value);
    return c.html(body, status);
  };

  const oauthError = (
    c: Context,
    error: string,
    description: string,
    status: ContentfulStatusCode = 400,
  ) => {
    c.header("Cache-Control", "no-store");
    return c.json({ error, error_description: description }, status);
  };

  const errorRedirect = (
    redirectUri: string,
    state: string | undefined,
    error: string,
    description: string,
  ) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state !== undefined) url.searchParams.set("state", state);
    return url.toString();
  };

  const validateAuthorize = (source: URLSearchParams): Validation => {
    for (const name of AUTHORIZE_PARAMS) {
      if (source.getAll(name).length > 1)
        return { ok: false, page: `Duplicate parameter: ${name}.` };
    }
    const get = (name: string): string | undefined => source.get(name) ?? undefined;
    const clientId = get("client_id");
    const client = clientId ? store.getClient(clientId) : null;
    if (!clientId || !client) {
      return { ok: false, page: "Unknown client. Remove the connector and add it again." };
    }
    const redirectUri = get("redirect_uri");
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { ok: false, page: "The redirect_uri is not registered for this client." };
    }
    const state = get("state");
    if (state !== undefined && state.length > MAX_STATE_LENGTH) {
      return { ok: false, page: "The state parameter is too long." };
    }
    const fail = (error: string, description: string): Validation => ({
      ok: false,
      redirect: errorRedirect(redirectUri, state, error, description),
    });
    if (get("response_type") !== "code") {
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    }
    const codeChallenge = get("code_challenge");
    if (!codeChallenge || !S256_CHALLENGE.test(codeChallenge)) {
      return fail("invalid_request", "A valid S256 code_challenge is required.");
    }
    if (get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "Only code_challenge_method=S256 is supported.");
    }
    const scope = get("scope");
    if (scope !== undefined && scope !== "" && (scope.length > 1000 || !SCOPE.test(scope))) {
      return fail("invalid_scope", "Malformed scope.");
    }
    const resource = get("resource");
    if (resource !== undefined && !isOwnResource(resource)) {
      return fail("invalid_target", "Unknown resource.");
    }
    const echo: Record<string, string> = {};
    for (const name of AUTHORIZE_PARAMS) {
      const value = get(name);
      if (value !== undefined) echo[name] = value;
    }
    return {
      ok: true,
      request: { clientId, redirectUri, state, codeChallenge, resource: resource ?? null, echo },
    };
  };

  const renderLogin = (
    c: Context,
    request: AuthorizeRequest,
    status: ContentfulStatusCode,
    error?: string,
  ) =>
    html(
      c,
      loginPage({ params: request.echo, redirectHost: new URL(request.redirectUri).host, error }),
      status,
    );

  const rejectAuthorize = (c: Context, result: Exclude<Validation, { ok: true }>) =>
    "page" in result
      ? html(c, messagePage("Authorization error", result.page), 400)
      : c.redirect(result.redirect, 302);

  const tooManyAttempts = (c: Context) =>
    html(c, messagePage("Too many attempts", "Too many failed attempts. Try again later."), 429);

  // --- Discovery (RFC 9728, RFC 8414) ---

  const protectedResource = (c: Context) =>
    c.json({ resource: resourceUrl, authorization_servers: [base] });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  // --- Dynamic Client Registration (RFC 7591), public clients only ---

  app.post("/register", limitBody, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, "invalid_client_metadata", "Body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return oauthError(c, "invalid_client_metadata", "Body must be a JSON object.");
    }
    const meta = body as Record<string, unknown>;
    const uris = meta.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > MAX_REDIRECT_URIS ||
      !uris.every(isAllowedRedirectUri)
    ) {
      return oauthError(
        c,
        "invalid_redirect_uri",
        "redirect_uris must list 1 to 10 https URIs (http only for localhost), without fragments.",
      );
    }
    const clientName = meta.client_name;
    if (
      clientName !== undefined &&
      (typeof clientName !== "string" || clientName.length > MAX_CLIENT_NAME_LENGTH)
    ) {
      return oauthError(c, "invalid_client_metadata", "client_name must be a short string.");
    }
    if (store.countClients() >= MAX_CLIENTS) {
      return oauthError(
        c,
        "invalid_client_metadata",
        `Client limit reached (${MAX_CLIENTS}). Log out at ${base}/logout to reset all clients.`,
      );
    }
    const redirectUris = [...new Set(uris as string[])];
    const { clientId } = store.registerClient({ redirectUris, clientName });
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(clientName !== undefined ? { client_name: clientName } : {}),
      },
      201,
    );
  });

  // --- Authorization endpoint with WAHA-key login ---

  app.get("/authorize", (c) => {
    const result = validateAuthorize(new URL(c.req.url).searchParams);
    if (!result.ok) return rejectAuthorize(c, result);
    return renderLogin(c, result.request, 200);
  });

  app.post("/authorize", limitBody, async (c) => {
    const form = new URLSearchParams(await c.req.text());
    const result = validateAuthorize(form);
    if (!result.ok) return rejectAuthorize(c, result);
    const { request } = result;

    const key = clientKey(c);
    if (limiter.isBlocked(key)) return tooManyAttempts(c);
    if (!keyMatches(form.get("waha_key"))) {
      limiter.recordFailure(key);
      return renderLogin(c, request, 401, "Invalid key. Try again.");
    }
    limiter.reset(key);

    const code = store.saveCode({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: GRANTED_SCOPE,
      resource: request.resource,
    });
    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state !== undefined) url.searchParams.set("state", request.state);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(url.toString(), 302);
  });

  // --- Token endpoint (RFC 6749 + PKCE) ---

  app.post("/token", limitBody, async (c) => {
    const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      return oauthError(c, "invalid_request", "Use application/x-www-form-urlencoded.");
    }
    const form = new URLSearchParams(await c.req.text());
    for (const name of new Set(form.keys())) {
      if (form.getAll(name).length > 1) {
        return oauthError(c, "invalid_request", `Duplicate parameter: ${name}.`);
      }
    }
    const get = (name: string): string | undefined => form.get(name) || undefined;
    const grantType = get("grant_type");
    if (!grantType) return oauthError(c, "invalid_request", "grant_type is required.");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return oauthError(c, "unsupported_grant_type", "Unsupported grant_type.");
    }

    const clientId = get("client_id");
    const resource = get("resource");
    if (resource !== undefined && !isOwnResource(resource)) {
      return oauthError(c, "invalid_target", "Unknown resource.");
    }

    const tokenResponse = (t: { accessToken: string; refreshToken: string; expiresIn: number }) => {
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      return c.json({
        access_token: t.accessToken,
        token_type: "Bearer",
        expires_in: t.expiresIn,
        refresh_token: t.refreshToken,
        scope: GRANTED_SCOPE,
      });
    };

    if (grantType === "authorization_code") {
      const code = get("code");
      const verifier = get("code_verifier");
      const redirectUri = get("redirect_uri");
      if (!code || !verifier || !clientId || !redirectUri) {
        return oauthError(
          c,
          "invalid_request",
          "code, code_verifier, client_id and redirect_uri are required.",
        );
      }
      if (!store.getClient(clientId)) return oauthError(c, "invalid_client", "Unknown client.");
      if (!CODE_VERIFIER.test(verifier)) {
        return oauthError(c, "invalid_request", "Malformed code_verifier.");
      }
      // Consumed before any further check: a failed exchange burns the code.
      const data = store.consumeCode(code);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        !data ||
        data.clientId !== clientId ||
        data.redirectUri !== redirectUri ||
        !safeEqual(challenge, data.codeChallenge)
      ) {
        return oauthError(c, "invalid_grant", "Invalid, expired or mismatched authorization code.");
      }
      return tokenResponse(store.issueTokens(clientId, data.scope));
    }

    const refreshToken = get("refresh_token");
    if (!refreshToken || !clientId) {
      return oauthError(c, "invalid_request", "refresh_token and client_id are required.");
    }
    if (!store.getClient(clientId)) return oauthError(c, "invalid_client", "Unknown client.");
    const rotated = store.rotateRefreshToken(refreshToken, clientId);
    if (!rotated) return oauthError(c, "invalid_grant", "Invalid or expired refresh token.");
    return tokenResponse(rotated);
  });

  // --- Logout: revokes every client and token ---

  app.get("/logout", (c) => html(c, logoutPage()));

  app.post("/logout", limitBody, async (c) => {
    const form = new URLSearchParams(await c.req.text());
    const key = clientKey(c);
    if (limiter.isBlocked(key)) return tooManyAttempts(c);
    if (!keyMatches(form.get("waha_key"))) {
      limiter.recordFailure(key);
      return html(c, logoutPage({ error: "Invalid key. Try again." }), 401);
    }
    limiter.reset(key);
    store.revokeAll();
    return html(
      c,
      messagePage(
        "Logged out",
        "All tokens and clients were revoked. Connected apps must sign in again.",
      ),
    );
  });

  return app;
}
