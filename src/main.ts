import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { CacheEventProcessor } from "./application/cacheEvents.js";
import type { MissionEngine } from "./application/missions/engine.js";
import type { MissionPurge } from "./application/missions/retention.js";
import type { ScheduleRunner } from "./application/schedules/runner.js";
import {
  composeApp,
  composeCacheEventProcessor,
  composeMissionEngine,
  composeMissionPurge,
  composeScheduleRunner,
} from "./composition.js";
import { loadConfig } from "./config.js";
import { CACHE_EVENT_KINDS } from "./domain/ports/EventStore.js";
import { createAuthStore, openAuthDatabase } from "./infrastructure/auth/store.js";
import { createSqliteBillingStore } from "./infrastructure/billing/sqliteBillingStore.js";
import { loadOrCreateMediaSecret } from "./infrastructure/media/signedLink.js";
import { createSqliteEventStore } from "./infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "./infrastructure/missions/sqliteMissionStore.js";
import { createSqliteScheduleStore } from "./infrastructure/schedules/sqliteScheduleStore.js";
import { migrateToMultiTenant } from "./infrastructure/tenants/migrate.js";
import { createSqliteTenantStore } from "./infrastructure/tenants/sqliteTenantStore.js";
import { createWahaSessionAdmin } from "./infrastructure/waha/WahaSessionAdmin.js";

/**
 * Longest wait on SIGTERM for a running mission turn or scheduled run (an LLM call plus a paced
 * send).
 */
const MISSION_DRAIN_MS = 20_000;
/** How often the schedule runner looks for due scheduled messages. */
const SCHEDULE_TICK_MS = 5_000;

/** The only file that reads `process.env`. */
async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid configuration.");
    process.exit(1);
  }

  const logger = { info: (message: string) => console.log(message) };

  mkdirSync(config.dataDir, { recursive: true });
  const authDb = openAuthDatabase(join(config.dataDir, "auth.db"));
  const store = createAuthStore(authDb);
  const tenants = createSqliteTenantStore(authDb);
  const missions = createSqliteMissionStore(authDb);
  // Like the mission store: always opened, so purge and tenant deletion reach existing rows.
  const schedules = createSqliteScheduleStore(authDb);
  // Always opened, also with missions off: the purge and tenant deletion still reach rows left
  // from a period when missions were on.
  const events = createSqliteEventStore(authDb);
  const billingStore = createSqliteBillingStore(authDb);
  const sessions = createWahaSessionAdmin({
    baseUrl: config.wahaApiUrl,
    apiKey: config.wahaApiKey,
  });
  try {
    // Fails fast when MASTER_KEY does not open the stored tenant keys, before any key, cache file
    // or row is changed. Opening the stores above already ran their schema setup: it only adds
    // missing tables and columns (and drops pre-0.4.0 codes and tokens, revoked here anyway).
    await migrateToMultiTenant({
      authDb,
      tenants,
      auth: store,
      config,
      kek: config.masterKey,
      dataDir: config.dataDir,
      sessions,
      logger,
    });
  } catch (error) {
    store.close();
    throw error;
  }
  if (store.syncApiKey(config.wahaApiKey)) logger.info("API key changed — all sessions revoked");

  const mediaSecret = loadOrCreateMediaSecret(config.dataDir);
  // Assigned right after composing (it needs the registry); a webhook before then is picked up
  // by the first tick.
  let missionEngine: MissionEngine | null = null;
  let scheduleRunner: ScheduleRunner | null = null;
  let cacheEvents: CacheEventProcessor | null = null;
  let retentionPurge: MissionPurge | null = null;
  const { app, registry, toolCount, multiTenant, configureWebhooks, billing } = composeApp({
    config,
    store,
    tenants,
    missions,
    billing: billingStore,
    events,
    // Cache kinds wake the cache processor, mission kinds the engine (a no-op when missions are off).
    onWebhookEvent: ({ kind }) => {
      if ((CACHE_EVENT_KINDS as readonly string[]).includes(kind)) cacheEvents?.wake();
      else missionEngine?.wake();
    },
    missionEngine: () => missionEngine,
    schedules,
    scheduleRunner: () => scheduleRunner,
    missionPurge: () => retentionPurge,
    sessions,
    mediaSecret,
    logger,
  });
  const purge = composeMissionPurge({
    registry,
    tenants,
    missions,
    schedules,
    events,
    logger,
    cacheRetentionDays: config.cacheRetentionDays,
  });
  retentionPurge = purge;
  missionEngine = composeMissionEngine({
    config,
    registry,
    tenants,
    missions,
    events,
    logger,
    purge,
  });
  // Migrations are done: process stored events and due missions every 5 s (the engine also runs
  // the daily retention purge, which also prunes cached message data past CACHE_RETENTION_DAYS). With missions off, the purge runs on its own.
  // Scheduled messages need missions (quiet hours, pause state, budget): only with the engine.
  scheduleRunner = missionEngine
    ? composeScheduleRunner({ config, registry, tenants, missions, schedules, logger })
    : null;
  if (missionEngine) missionEngine.start();
  else purge.start(() => new Date());
  scheduleRunner?.start(SCHEDULE_TICK_MS);
  cacheEvents = composeCacheEventProcessor({ config, registry, events, logger });
  cacheEvents?.start(SCHEDULE_TICK_MS);
  // Paying tenants: suspends after the grace period and deletes long-suspended ones (hourly).
  billing?.start();

  const server = serve({ fetch: app.fetch, port: config.port });

  // Startup log: never the API key, the master key or the WAHA URL. A non-GOWS engine does not
  // stop the server; tools report the unsupported engine themselves.
  let engine = "unknown (WAHA not reachable)";
  const adminUser = tenants.getAdmin();
  const held = adminUser ? registry.acquire(adminUser.tenantId) : null;
  try {
    if (held) engine = (await held.runtime.context.gateway.getSession()).engine;
  } catch {
    // WAHA may not be up yet; the engine resolver retries on the first tool call.
  } finally {
    held?.release();
  }
  console.log(
    `waha-mcp listening on :${config.port} | engine: ${engine} | public URL: ${config.publicBaseUrl} | mode: ${multiTenant ? "multi-tenant" : "single-owner"} | tenants: ${tenants.listTenants().length} | tools: ${toolCount} | message cache: ${config.cacheEnabled ? "on" : "off"} | transcription: ${config.transcription ? "on" : "off"} | email: ${config.email ? "on" : "off"} | missions: ${config.missions ? "on" : "off"}`,
  );
  if (engine !== "GOWS" && !engine.startsWith("unknown")) {
    console.warn(`Engine ${engine} is not supported (GOWS only); tools will report this.`);
  }
  // Webhooks: point active tenants' sessions at /webhooks/waha in the background (best effort,
  // one tenant at a time, never fatal; a no-op when WAHA_WEBHOOK_SECRET is unset).
  void configureWebhooks().catch(() => {});

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down.`);
    // No new turn, LLM call or send starts after stop(); the one in flight (LLM call, paced send,
    // logging its sent id) gets up to MISSION_DRAIN_MS before the stores close under it.
    missionEngine?.stop();
    scheduleRunner?.stop();
    cacheEvents?.stop();
    billing?.stop();
    purge.stop();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      registry.closeAll();
      store.close();
      process.exit(0);
    };
    const drained = Promise.race([
      Promise.all([missionEngine?.idle(), scheduleRunner?.idle(), cacheEvents?.idle()]),
      new Promise<void>((resolve) => setTimeout(resolve, MISSION_DRAIN_MS).unref()),
    ]);
    void drained.then(() => {
      server.close(finish);
      setTimeout(finish, 5000).unref();
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Fatal error.");
  process.exit(1);
});
