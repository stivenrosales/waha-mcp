import type { MiddlewareHandler } from "hono";
import type { AuthStore } from "./store.js";

export interface AuthInfo {
  clientId: string;
  scope: string;
}

export type AuthVariables = { auth: AuthInfo };

/**
 * Requires a valid opaque access token in `Authorization: Bearer <token>`.
 * On failure answers 401 with the RFC 9728 `resource_metadata` pointer, which
 * is how MCP clients discover the authorization server.
 */
export function bearerGuard(deps: {
  store: AuthStore;
  publicBaseUrl: string;
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const challenge = `Bearer resource_metadata="${deps.publicBaseUrl}/.well-known/oauth-protected-resource"`;
  return async (c, next) => {
    const match = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(
      c.req.header("authorization") ?? "",
    );
    const auth = match ? deps.store.verifyAccessToken(match[1]) : null;
    if (!auth) {
      c.header("WWW-Authenticate", challenge);
      c.header("Cache-Control", "no-store");
      return c.json({ error: "invalid_token" }, 401);
    }
    c.set("auth", auth);
    await next();
  };
}
