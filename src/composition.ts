import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Hono } from "hono";
import { type Billing, createBilling } from "./application/billing.js";
import { type CacheEventProcessor, createCacheEventProcessor } from "./application/cacheEvents.js";
import { createMissionEngine, type MissionEngine } from "./application/missions/engine.js";
import { createMissionPurge, type MissionPurge } from "./application/missions/retention.js";
import { createPolarSync, createProvisioner } from "./application/polarSync.js";
import { createScheduleRunner, type ScheduleRunner } from "./application/schedules/runner.js";
import { createSelfService } from "./application/selfService.js";
import { createTenantAdmin, type TenantAdmin } from "./application/tenantAdmin.js";
import type { Config, PolarConfig } from "./config.js";
import type { BillingStore } from "./domain/ports/BillingStore.js";
import type { EmailSender } from "./domain/ports/EmailSender.js";
import {
  CACHE_EVENT_KINDS,
  type EventStore,
  MISSION_EVENT_KINDS,
  type WebhookEventKind,
} from "./domain/ports/EventStore.js";
import type { LlmClient } from "./domain/ports/LlmClient.js";
import type { MissionStore } from "./domain/ports/MissionStore.js";
import type { PolarStore } from "./domain/ports/PolarStore.js";
import type { ScheduleStore } from "./domain/ports/ScheduleStore.js";
import type { SessionAdmin, WebhookTarget } from "./domain/ports/SessionAdmin.js";
import type { TenantStore } from "./domain/ports/TenantStore.js";
import { bearerGuard } from "./infrastructure/auth/bearer.js";
import { createOAuthRoutes } from "./infrastructure/auth/oauth.js";
import { createLoginLimiter } from "./infrastructure/auth/rateLimit.js";
import type { AuthStore } from "./infrastructure/auth/store.js";
import { createPolarClient } from "./infrastructure/billing/polarClient.js";
import { createPolarWebhookRoute } from "./infrastructure/billing/polarWebhook.js";
import { generateDek, wrapDek } from "./infrastructure/crypto/envelope.js";
import { createCloudflareEmailSender } from "./infrastructure/email/cloudflareEmailSender.js";
import { createApp } from "./infrastructure/http/app.js";
import { createOpenRouterClaude } from "./infrastructure/llm/openRouterClaude.js";
import type { Logger } from "./infrastructure/mcp/defineTool.js";
import {
  ADMIN_INSTRUCTIONS,
  OWNER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
} from "./infrastructure/mcp/instructions.js";
import { createMcpServer } from "./infrastructure/mcp/server.js";
import { createAdminTools, createUsageTools } from "./infrastructure/mcp/tools/admin/index.js";
import { createTools } from "./infrastructure/mcp/tools/index.js";
import { missionTenantPort } from "./infrastructure/missions/tenantPort.js";
import { scheduleTenantPort } from "./infrastructure/schedules/tenantPort.js";
import { createOnboardingRoutes } from "./infrastructure/tenants/onboardingRoutes.js";
import { createTenantRegistry, type TenantRegistry } from "./infrastructure/tenants/registry.js";
import type { buildTenantRuntime, MissionWiring } from "./infrastructure/tenants/runtime.js";
import { cacheEventPort } from "./infrastructure/webhooks/cacheEventPort.js";
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
  /** Billing state of paying tenants; without it there is no billing lifecycle. */
  billing?: BillingStore;
  /** Polar links and handled deliveries; used when `config.polar` is set. */
  polar?: PolarStore;
  /** The WAHA webhook inbox; required whenever `WAHA_WEBHOOK_SECRET` is set. */
  events?: EventStore;
  /** Wakes the mission engine when a webhook event is stored. */
  onWebhookEvent?: WahaWebhookDeps["onEvent"];
  /**
   * The mission engine, read lazily (it is composed after the registry it needs). Mission tools
   * act through it: cancel, answer and takeover queue behind its ticks.
   */
  missionEngine?: () => MissionEngine | null;
  /** Scheduled-message rows, deleted with their tenant; schedule tools need missions too. */
  schedules?: ScheduleStore;
  /**
   * The schedule runner, read lazily like the engine: `cancel_scheduled` cancels through it and
   * `restore_tenant` catches up through it.
   */
  scheduleRunner?: () => ScheduleRunner | null;
  /**
   * The retention purge, read lazily (it is composed after the registry it needs):
   * `delete_my_data` deletes the caller's ended missions and schedules through it.
   */
  missionPurge?: () => Pick<MissionPurge, "purgeTenantHistory"> | null;
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
   * Invites and tenant management on (`MULTI_TENANT`, or, when unset, whether any tenant besides
   * the admin's exists at startup). Off: the admin gets the usage tools only and `/invite` 404s.
   */
  multiTenant: boolean;
  /**
   * Points every active tenant's WAHA session at `/webhooks/waha` (webhooks on), one by one;
   * never throws. A no-op when webhooks are off.
   */
  configureWebhooks(): Promise<void>;
  /** The billing lifecycle of paying tenants, when a billing store was given. */
  billing: Billing | null;
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
  if (config.webhookSecret && !deps.events)
    throw new Error("Webhooks need the webhook event store.");
  const webhook: WebhookTarget | null = config.webhookSecret
    ? {
        url: `${config.publicBaseUrl.replace(/\/+$/, "")}${WEBHOOK_PATH}`,
        secret: config.webhookSecret,
      }
    : null;
  const engine = (): MissionEngine | null => deps.missionEngine?.() ?? null;
  const runner = (): ScheduleRunner | null => deps.scheduleRunner?.() ?? null;
  const scheduleStore = deps.schedules;
  const missionWiring: MissionWiring | null = missionsOn
    ? {
        ...(scheduleStore
          ? {
              schedules: {
                store: scheduleStore,
                cancel: (t: string, id: string) => runner()?.cancel(t, id) ?? false,
              },
            }
          : {}),
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
    ...(scheduleStore
      ? {
          schedules: {
            deleteForTenant: (t: string) => scheduleStore.deleteForTenant(t),
            catchUp: async (t: string, now: Date) => runner()?.catchUp(t, now),
          },
        }
      : {}),
    ...(deps.events ? { events: deps.events } : {}),
    newWrappedDek: (tenantId) => wrapDek(config.masterKey, generateDek(), tenantId),
    dataDir: config.dataDir,
    publicBaseUrl: config.publicBaseUrl,
    logger,
    timezone: config.timezone,
    ...(webhook ? { webhook } : {}),
  });
  const selfService = createSelfService({
    tenants,
    auth: store,
    sessions,
    registry,
    history: {
      purgeTenantHistory: (tenantId, now) =>
        deps.missionPurge?.()?.purgeTenantHistory(tenantId, now) ?? { missions: 0, schedules: 0 },
    },
    logger,
  });
  const tools = createTools();
  // Decided once, at startup: a fresh install (only the admin's tenant) is single-owner.
  // Polar billing gives each customer an account, so it turns invites on.
  const multiTenant =
    config.multiTenant ?? (config.polar !== null || tenants.listTenants().length > 1);
  const mcp = createMcpServer({
    tools,
    adminTools: multiTenant ? createAdminTools() : createUsageTools(),
    instructions: SERVER_INSTRUCTIONS,
    adminInstructions: multiTenant ? ADMIN_INSTRUCTIONS : OWNER_INSTRUCTIONS,
    config,
    registry,
    admin,
    selfService,
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
  // Password recovery by email: only with EMAIL_FROM and the Cloudflare credentials set.
  const emailSender = config.email ? createCloudflareEmailSender(config.email) : null;
  const passwordRecovery = emailSender
    ? {
        email: emailSender,
        // Its own limiter, so recovery never spends the login budget; a higher global cap, so
        // requests for made-up emails cannot switch recovery off for everyone.
        limiter: createLoginLimiter({ globalMaxFailures: 1000 }),
      }
    : null;
  const billing = deps.billing
    ? createBilling({ store: deps.billing, tenants, admin, sessions, logger })
    : null;
  const polarWebhook =
    config.polar && deps.polar && billing && emailSender
      ? composePolarWebhook({
          polar: config.polar,
          store: deps.polar,
          billing,
          admin,
          tenants,
          email: emailSender,
          logger,
        })
      : null;
  const app = createApp({
    oauth: createOAuthRoutes({
      store,
      tenants,
      publicBaseUrl: config.publicBaseUrl,
      limiter,
      ...(passwordRecovery ? { forgotUrl: "/forgot" } : {}),
    }),
    onboarding: createOnboardingRoutes({
      tenants,
      auth: store,
      sessions,
      registry,
      cookieSecret,
      publicBaseUrl: config.publicBaseUrl,
      limiter,
      logger,
      cacheRetentionDays: config.cacheRetentionDays,
      invites: multiTenant,
      ...(webhook ? { webhook } : {}),
      ...(passwordRecovery ? { passwordRecovery } : {}),
    }),
    guard: bearerGuard({ store, tenants, publicBaseUrl: config.publicBaseUrl }),
    polarWebhook,
    mcpHandler: mcp.handler,
    registry,
    webhooks:
      webhook && deps.events
        ? createWahaWebhookRoute({
            secret: webhook.secret,
            tenants,
            registry,
            events: deps.events,
            kinds: new Set<WebhookEventKind>([
              ...CACHE_EVENT_KINDS,
              ...(config.missions ? MISSION_EVENT_KINDS : []),
            ]),
            logger,
            ...(deps.onWebhookEvent ? { onEvent: deps.onWebhookEvent } : {}),
          })
        : null,
  });
  const configureWebhooks = async (): Promise<void> => {
    if (webhook) await configureTenantWebhooks({ tenants, sessions, target: webhook, logger });
  };
  return { app, registry, toolCount: tools.length, multiTenant, configureWebhooks, billing };
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
  /** Test seams: the clock, the pacing jitter and the pacing pause (default: real ones). */
  now?: () => Date;
  rand?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The shared retention purge (`composeMissionPurge`); the engine runs it in its tick. */
  purge?: MissionPurge;
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
    now: deps.now ?? (() => new Date()),
    rand: deps.rand ?? Math.random,
    sleep:
      deps.sleep ??
      (async (ms) => {
        await delay(ms);
      }),
    logger: deps.logger,
    ...(deps.purge ? { purge: deps.purge } : {}),
  });
}

/**
 * The message-cache event processor over the composed registry (null without webhooks). Not
 * started: `main.ts` starts its tick and wires `wake()` to the webhook route.
 */
export function composeCacheEventProcessor(deps: {
  config: Config;
  registry: TenantRegistry;
  events: EventStore | undefined;
  logger: Logger;
}): CacheEventProcessor | null {
  if (!deps.config.webhookSecret || !deps.events) return null;
  return createCacheEventProcessor({
    events: deps.events,
    acquire: (tenantId) => {
      const held = deps.registry.acquire(tenantId);
      return held ? { port: cacheEventPort(held.runtime), release: held.release } : null;
    },
    logger: deps.logger,
  });
}

/**
 * The daily retention purge over the registry (mission and schedule history, webhook events and
 * cached message data). It runs whether missions are on or off: with the engine it runs in the
 * engine's tick; without it, `main.ts` calls `start()`.
 */
export function composeMissionPurge(deps: {
  registry: Pick<TenantRegistry, "acquire">;
  tenants: Pick<TenantStore, "listTenants">;
  missions: MissionStore;
  /** Scheduled-message rows: their run log and ended schedules are purged too. */
  schedules?: ScheduleStore;
  events: EventStore | undefined;
  logger: Logger;
  /** `CACHE_RETENTION_DAYS`: cached message data older than this is pruned daily (0 keeps it). */
  cacheRetentionDays?: number;
}): MissionPurge {
  return createMissionPurge({
    missions: deps.missions,
    ...(deps.cacheRetentionDays !== undefined
      ? { cacheRetentionDays: deps.cacheRetentionDays }
      : {}),
    ...(deps.schedules ? { schedules: deps.schedules } : {}),
    ...(deps.events ? { events: deps.events } : {}),
    tenants: deps.tenants,
    acquireLog: (tenantId) => {
      const held = deps.registry.acquire(tenantId);
      return held
        ? {
            log: held.runtime.missionLog,
            scheduleLog: held.runtime.scheduleLog,
            cache: held.runtime.cacheData,
            release: held.release,
          }
        : null;
    },
    logger: deps.logger,
  });
}

/**
 * The scheduled-message runner over the composed registry (null when missions are off). Not
 * started: `main.ts` starts it next to the mission engine.
 */
export function composeScheduleRunner(deps: {
  config: Config;
  registry: TenantRegistry;
  tenants: TenantStore;
  missions: MissionStore;
  schedules: ScheduleStore;
  logger: Logger;
  /** Test seams, as for the mission engine. */
  llm?: LlmClient;
  now?: () => Date;
  rand?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): ScheduleRunner | null {
  const m = deps.config.missions;
  if (!m) return null;
  const now = deps.now ?? (() => new Date());
  const timezone = deps.config.timezone;
  return createScheduleRunner({
    store: deps.schedules,
    missions: deps.missions,
    tenants: deps.tenants,
    acquire: (tenantId) => {
      const held = deps.registry.acquire(tenantId);
      return held
        ? { port: scheduleTenantPort(held.runtime, timezone, now), release: held.release }
        : null;
    },
    llm: deps.llm ?? createOpenRouterClaude({ apiKey: m.openRouterApiKey, model: m.model }),
    model: m.model,
    monthlyBudgetUsd: m.monthlyBudgetUsd,
    limits: m.limits,
    missedAfterMs: m.schedules.missedAfterMinutes * 60_000,
    timezone,
    paced: {
      rand: deps.rand ?? Math.random,
      sleep:
        deps.sleep ??
        (async (ms) => {
          await delay(ms);
        }),
    },
    now,
    logger: deps.logger,
  });
}

/** `POST /webhooks/polar`: Polar subscriptions create accounts and drive the billing lifecycle. */
function composePolarWebhook(q: {
  polar: PolarConfig;
  store: PolarStore;
  billing: Billing;
  admin: TenantAdmin;
  tenants: TenantStore;
  email: EmailSender;
  logger: { info(message: string): void };
}): Hono {
  const client = createPolarClient({ apiUrl: q.polar.apiUrl, accessToken: q.polar.accessToken });
  return createPolarWebhookRoute({
    secret: q.polar.webhookSecret,
    store: q.store,
    logger: q.logger,
    sync: createPolarSync({
      fetchSubscription: (id) => client.getSubscription(id),
      store: q.store,
      billing: q.billing,
      provision: createProvisioner({ admin: q.admin, email: q.email, logger: q.logger }),
      users: {
        tenantExists: (t) => q.tenants.getTenant(t) !== null,
        emailOfTenant: (t) => q.tenants.getUserByTenant(t)?.email ?? null,
        setTenantEmail: (t, email) => {
          const user = q.tenants.getUserByTenant(t);
          return user ? q.tenants.setEmail(user.id, email) : "ok";
        },
      },
      logger: q.logger,
    }),
  });
}
