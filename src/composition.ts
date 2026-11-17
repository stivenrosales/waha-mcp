import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Hono } from "hono";
import { createMissionEngine, type MissionEngine } from "./application/missions/engine.js";
import { createTenantAdmin } from "./application/tenantAdmin.js";
import type { Config } from "./config.js";
import type { EventStore } from "./domain/ports/EventStore.js";
import type { LlmClient } from "./domain/ports/LlmClient.js";
import type { MissionStore } from "./domain/ports/MissionStore.js";
import type { SessionAdmin, WebhookTarget } from "./domain/ports/SessionAdmin.js";
import type { TenantStore } from "./domain/ports/TenantStore.js";
import { bearerGuard } from "./infrastructure/auth/bearer.js";
import { createOAuthRoutes } from "./infrastructure/auth/oauth.js";
import { createLoginLimiter } from "./infrastructure/auth/rateLimit.js";
import type { AuthStore } from "./infrastructure/auth/store.js";
import { generateDek, wrapDek } from "./infrastructure/crypto/envelope.js";
import { createApp } from "./infrastructure/http/app.js";
import { createOpenRouterClaude } from "./infrastructure/llm/openRouterClaude.js";
import type { Logger } from "./infrastructure/mcp/defineTool.js";
import { SERVER_INSTRUCTIONS } from "./infrastructure/mcp/instructions.js";
import { createMcpServer } from "./infrastructure/mcp/server.js";
import { createAdminTools } from "./infrastructure/mcp/tools/admin/index.js";
import { createTools } from "./infrastructure/mcp/tools/index.js";
import { missionTenantPort } from "./infrastructure/missions/tenantPort.js";
import { createOnboardingRoutes } from "./infrastructure/tenants/onboardingRoutes.js";
import { createTenantRegistry, type TenantRegistry } from "./infrastructure/tenants/registry.js";
import type { buildTenantRuntime, MissionWiring } from "./infrastructure/tenants/runtime.js";
import {
  configureTenantWebhooks,
  createWahaWebhookRoute,
  type WahaWebhookDeps,
  WEBHOOK_PATH,
} from "./infrastructure/webhooks/wahaWebhook.js";

export interface ComposeDeps {
  config: Config;
  /** Auth and tenant stores over the same, already migrated, auth database. */
  store: AuthStore;
  tenants: TenantStore;
  /** Mission rows, deleted with their tenant. */
  missions: MissionStore;
  /** The WAHA webhook inbox; required for the webhook route when missions are on. */
  events?: EventStore;
  /** Wakes the mission engine when a webhook event is stored. */
  onWebhookEvent?: WahaWebhookDeps["onEvent"];
  /**
   * The mission engine, read lazily (it is composed after the registry it needs). Mission tools
   * act through it: cancel, answer and takeover queue behind its ticks.
   */
  missionEngine?: () => MissionEngine | null;
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
  /**
   * Points every active tenant's WAHA session at `/webhooks/waha` (missions on), one by one;
   * never throws. A no-op when missions are off.
   */
  configureWebhooks(): Promise<void>;
}

/**
 * Wires the HTTP app from the stores: one tenant registry, one login limiter shared by the OAuth
 * and onboarding pages, the admin service, and the per-tenant MCP server. Used by `main.ts` and
 * by the end-to-end tests, so both exercise the same wiring.
 */
export function composeApp(deps: ComposeDeps): ComposedApp {
  const { config, store, tenants, missions, sessions, mediaSecret, logger } = deps;
  const limiter = createLoginLimiter();
  const missionsOn = config.missions;
  if (missionsOn && !deps.events) throw new Error("Missions need the webhook event store.");
  const webhook: WebhookTarget | null = missionsOn
    ? {
        url: `${config.publicBaseUrl.replace(/\/+$/, "")}${WEBHOOK_PATH}`,
        secret: missionsOn.webhookSecret,
      }
    : null;
  const engine = (): MissionEngine | null => deps.missionEngine?.() ?? null;
  const missionWiring: MissionWiring | null = missionsOn
    ? {
        store: missions,
        tenants,
        engine: {
          cancel: async (t, id) => (await engine()?.cancel(t, id)) ?? false,
          answer: async (t, id, text) => (await engine()?.answer(t, id, text)) ?? false,
          takeOver: async (t, id) => (await engine()?.takeOver(t, id)) ?? false,
          wake: () => engine()?.wake(),
        },
        now: () => new Date(),
      }
    : null;
  const registry = createTenantRegistry({
    config,
    tenants,
    kek: config.masterKey,
    mediaSecret,
    logger,
    ...(deps.buildRuntime ? { build: deps.buildRuntime } : {}),
    ...(missionWiring ? { missions: missionWiring } : {}),
  });
  const admin = createTenantAdmin({
    tenants,
    auth: store,
    sessions,
    registry,
    missions,
    ...(deps.events ? { events: deps.events } : {}),
    newWrappedDek: (tenantId) => wrapDek(config.masterKey, generateDek(), tenantId),
    dataDir: config.dataDir,
    publicBaseUrl: config.publicBaseUrl,
    logger,
    timezone: config.timezone,
    ...(webhook ? { webhook } : {}),
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
    recordToolCall: (tenantId, call) =>
      tenants.recordToolCall({ tenantId, at: new Date().toISOString(), ...call }),
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
      registry,
      cookieSecret,
      publicBaseUrl: config.publicBaseUrl,
      limiter,
      logger,
      ...(webhook ? { webhook } : {}),
    }),
    guard: bearerGuard({ store, tenants, publicBaseUrl: config.publicBaseUrl }),
    mcpHandler: mcp.handler,
    registry,
    webhooks:
      missionsOn && deps.events
        ? createWahaWebhookRoute({
            secret: missionsOn.webhookSecret,
            tenants,
            registry,
            events: deps.events,
            logger,
            ...(deps.onWebhookEvent ? { onEvent: deps.onWebhookEvent } : {}),
          })
        : null,
  });
  const configureWebhooks = async (): Promise<void> => {
    if (webhook) await configureTenantWebhooks({ tenants, sessions, target: webhook, logger });
  };
  return { app, registry, toolCount: tools.length, configureWebhooks };
}

/**
 * The mission engine over the composed registry (null when missions are off). Not started:
 * `main.ts` starts its tick after migrations and wires `wake()` to the webhook route.
 */
export function composeMissionEngine(deps: {
  config: Config;
  registry: TenantRegistry;
  tenants: TenantStore;
  missions: MissionStore;
  events: EventStore | undefined;
  logger: Logger;
  /** Test seam; defaults to OpenRouter with `config.missions`. */
  llm?: LlmClient;
}): MissionEngine | null {
  const m = deps.config.missions;
  if (!m || !deps.events) return null;
  return createMissionEngine({
    missions: deps.missions,
    events: deps.events,
    tenants: deps.tenants,
    llm: deps.llm ?? createOpenRouterClaude({ apiKey: m.openRouterApiKey, model: m.model }),
    model: m.model,
    limits: m.limits,
    monthlyBudgetUsd: m.monthlyBudgetUsd,
    timezone: deps.config.timezone,
    acquire: (tenantId) => {
      const held = deps.registry.acquire(tenantId);
      return held ? { port: missionTenantPort(held.runtime), release: held.release } : null;
    },
    now: () => new Date(),
    rand: Math.random,
    sleep: async (ms) => {
      await delay(ms);
    },
    logger: deps.logger,
  });
}
