import { Hono, type MiddlewareHandler } from "hono";
import type { AuthInfo, AuthVariables } from "../auth/bearer.js";
import { ICON_SVG } from "./icon.js";

const ICON_HEADERS = {
  "content-type": "image/svg+xml",
  "cache-control": "public, max-age=86400",
  "x-content-type-options": "nosniff",
};

export interface CreateAppDeps {
  /** OAuth routes (metadata, register, authorize, token, logout). */
  oauth: Hono;
  /** `bearerGuard`: sets `c.get("auth")` or answers 401. */
  guard: MiddlewareHandler<{ Variables: AuthVariables }>;
  mcpHandler: (req: Request, opts: { authInfo: AuthInfo }) => Promise<Response>;
  /** Serves `/media/:token`; the signed token is its own credential. */
  media: (token: string) => Promise<Response>;
}

/**
 * - `GET /health`: no auth (container healthcheck).
 * - `GET /favicon.svg`, `GET /icon.svg`: the mascot icon, no auth.
 * - OAuth routes, mounted at the root.
 * - `ALL /mcp`: behind the bearer guard; the verified client is passed as `authInfo`.
 * - `GET /media/:token`: signed, short-lived media links.
 */
export function createApp(deps: CreateAppDeps): Hono {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/health", (c) => c.json({ status: "ok" }));
  for (const path of ["/favicon.svg", "/icon.svg"]) {
    app.get(path, () => new Response(ICON_SVG, { headers: ICON_HEADERS }));
  }
  app.route("/", deps.oauth);
  app.all("/mcp", deps.guard, (c) => deps.mcpHandler(c.req.raw, { authInfo: c.get("auth") }));
  app.get("/media/:token", (c) => deps.media(c.req.param("token")));

  return app as unknown as Hono;
}
