import { createHmac } from "node:crypto";
import type { Hono } from "hono";
import { createTenantAdmin } from "./application/tenantAdmin.js";
import type { Config } from "./config.js";
import type { SessionAdmin } from "./domain/ports/SessionAdmin.js";
import type { TenantStore } from "./domain/ports/TenantStore.js";
import { bearerGuard } from "./infrastructure/auth/bearer.js";
import { createOAuthRoutes } from "./infrastructure/auth/oauth.js";
import { createLoginLimiter } from "./infrastructure/auth/rateLimit.js";
import type { AuthStore } from "./infrastructure/auth/store.js";
import { generateDek, wrapDek } from "./infrastructure/crypto/envelope.js";
import { createApp } from "./infrastructure/http/app.js";
import type { Logger } from "./infrastructure/mcp/defineTool.js";
import { SERVER_INSTRUCTIONS } from "./infrastructure/mcp/instructions.js";
import { createMcpServer } from "./infrastructure/mcp/server.js";
import { createAdminTools } from "./infrastructure/mcp/tools/admin/index.js";
import { createTools } from "./infrastructure/mcp/tools/index.js";
import { createOnboardingRoutes } from "./infrastructure/tenants/onboardingRoutes.js";
import { createTenantRegistry, type TenantRegistry } from "./infrastructure/tenants/registry.js";
import type { buildTenantRuntime } from "./infrastructure/tenants/runtime.js";

export interface ComposeDeps {
  config: Config;
  /** Auth and tenant stores over the same, already migrated, auth database. */
  store: AuthStore;
  tenants: TenantStore;
  sessions: SessionAdmin;
  mediaSecret: Uint8Array;
  logger: Logger;
  /** Test seams: how a tenant runtime is built, and the media idle timeout of `get_media`. */
  buildRuntime?: typeof buildTenantRuntime;
  mediaIdleTimeoutMs?: number;
}

export interface ComposedApp {
  app: Hono;
  registry: TenantRegistry;
  /** Tools every tenant gets (admin tools excluded). */
  toolCount: number;
}

/**
 * Wires the HTTP app from the stores: one tenant registry, one login limiter shared by the OAuth
 * and onboarding pages, the admin service, and the per-tenant MCP server. Used by `main.ts` and
 * by the end-to-end tests, so both exercise the same wiring.
 */
export function composeApp(deps: ComposeDeps): ComposedApp {
  const { config, store, tenants, sessions, mediaSecret, logger } = deps;
  const limiter = createLoginLimiter();
  const registry = createTenantRegistry({
    config,
    tenants,
    kek: config.masterKey,
    mediaSecret,
    logger,
    ...(deps.buildRuntime ? { build: deps.buildRuntime } : {}),
  });
  const admin = createTenantAdmin({
    tenants,
    auth: store,
    sessions,
    registry,
    newWrappedDek: (tenantId) => wrapDek(config.masterKey, generateDek(), tenantId),
    dataDir: config.dataDir,
    publicBaseUrl: config.publicBaseUrl,
    logger,
  });
  const tools = createTools();
  const mcp = createMcpServer({
    tools,
    adminTools: createAdminTools(),
    instructions: SERVER_INSTRUCTIONS,
    config,
    registry,
    admin,
    logger,
    ...(deps.mediaIdleTimeoutMs !== undefined
      ? { mediaIdleTimeoutMs: deps.mediaIdleTimeoutMs }
      : {}),
  });
  // Same derivation as the upload links' key: a fixed label keeps the pairing cookie's key
  // distinct from every link key.
  const cookieSecret = new Uint8Array(
    createHmac("sha256", mediaSecret).update("pair-cookie").digest(),
  );
  const app = createApp({
    oauth: createOAuthRoutes({ store, tenants, publicBaseUrl: config.publicBaseUrl, limiter }),
    onboarding: createOnboardingRoutes({
      tenants,
      auth: store,
      sessions,
      cookieSecret,
      publicBaseUrl: config.publicBaseUrl,
      limiter,
    }),
    guard: bearerGuard({ store, tenants, publicBaseUrl: config.publicBaseUrl }),
    mcpHandler: mcp.handler,
    registry,
  });
  return { app, registry, toolCount: tools.length };
}
