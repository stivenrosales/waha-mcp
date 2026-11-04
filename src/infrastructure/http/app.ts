import { Hono, type MiddlewareHandler } from "hono";
import type { AuthInfo, AuthVariables } from "../auth/bearer.js";
import { peekLinkTenant } from "../media/signedLink.js";
import type { TenantRegistry } from "../tenants/registry.js";
import type { TenantRuntime } from "../tenants/runtime.js";
import { ICON_SVG } from "./icon.js";
import { releaseWhenDone } from "./releaseWhenDone.js";

const ICON_HEADERS = {
  "content-type": "image/svg+xml",
  "cache-control": "public, max-age=86400",
  "x-content-type-options": "nosniff",
};

/**
 * The one 404 of `/media` and `/upload`, identical to the handlers' own: an unknown tenant, an
 * inactive tenant and a bad signature cannot be told apart (no tenant-existence oracle).
 */
const notFound = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });

export interface CreateAppDeps {
  /** OAuth routes (metadata, register, authorize, token, logout). */
  oauth: Hono;
  /** Invite, reset and pairing pages. */
  onboarding: Hono;
  /** `bearerGuard`: sets `c.get("auth")` or answers 401. */
  guard: MiddlewareHandler<{ Variables: AuthVariables }>;
  mcpHandler: (req: Request, opts: { authInfo: AuthInfo }) => Promise<Response>;
  /** Resolves the tenant named by a signed link to its runtime. */
  registry: Pick<TenantRegistry, "acquire">;
}

/**
 * - `GET /health`: no auth (container healthcheck).
 * - `GET /favicon.svg`, `GET /icon.svg`: the mascot icon, no auth.
 * - OAuth and onboarding routes, mounted at the root (a PUBLIC_BASE_URL with a path is unsupported).
 * - `ALL /mcp`: behind the bearer guard; the verified client is passed as `authInfo`.
 * - `GET /media/:token`: signed, short-lived media links.
 * - `GET|PUT|POST /upload/:token`: signed, single-use upload links.
 *
 * Links carry their tenant id: the route acquires that tenant's runtime, whose handler verifies
 * the signature with that tenant's keys, and releases it when the response body is done.
 */
export function createApp(deps: CreateAppDeps): Hono {
  const app = new Hono<{ Variables: AuthVariables }>();

  const withTenantOf = async (
    token: string,
    req: Request | null,
    serve: (runtime: TenantRuntime) => Promise<Response>,
  ): Promise<Response> => {
    const tenantId = peekLinkTenant(token);
    const held = tenantId === null ? null : deps.registry.acquire(tenantId);
    if (!held) {
      await req?.body?.cancel().catch(() => {});
      return notFound();
    }
    let response: Response;
    try {
      response = await serve(held.runtime);
    } catch (error) {
      held.release();
      throw error;
    }
    return releaseWhenDone(response, held.release);
  };

  app.get("/health", (c) => c.json({ status: "ok" }));
  for (const path of ["/favicon.svg", "/icon.svg"]) {
    app.get(path, () => new Response(ICON_SVG, { headers: ICON_HEADERS }));
  }
  app.route("/", deps.oauth);
  app.route("/", deps.onboarding);
  app.all("/mcp", deps.guard, (c) => deps.mcpHandler(c.req.raw, { authInfo: c.get("auth") }));
  app.get("/media/:token", (c) => {
    const token = c.req.param("token");
    return withTenantOf(token, null, (runtime) => runtime.media(token));
  });
  app.on(["GET", "PUT", "POST"], "/upload/:token", (c) => {
    const token = c.req.param("token");
    return withTenantOf(token, c.req.raw, (runtime) => runtime.upload(c.req.raw, token));
  });

  return app as unknown as Hono;
}
