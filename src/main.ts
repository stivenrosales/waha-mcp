import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { MissionEngine } from "./application/missions/engine.js";
import { composeApp, composeMissionEngine } from "./composition.js";
import { loadConfig } from "./config.js";
import { createAuthStore, openAuthDatabase } from "./infrastructure/auth/store.js";
import { loadOrCreateMediaSecret } from "./infrastructure/media/signedLink.js";
import { createSqliteEventStore } from "./infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "./infrastructure/missions/sqliteMissionStore.js";
import { migrateToMultiTenant } from "./infrastructure/tenants/migrate.js";
import { createSqliteTenantStore } from "./infrastructure/tenants/sqliteTenantStore.js";
import { createWahaSessionAdmin } from "./infrastructure/waha/WahaSessionAdmin.js";

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
  const events = config.missions ? createSqliteEventStore(authDb) : undefined;
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
  const { app, registry, toolCount, configureWebhooks } = composeApp({
    config,
    store,
    tenants,
    missions,
    ...(events ? { events } : {}),
    onWebhookEvent: () => missionEngine?.wake(),
    sessions,
    mediaSecret,
    logger,
  });
  missionEngine = composeMissionEngine({ config, registry, tenants, missions, events, logger });
  // Migrations are done: process stored events and due missions every 5 s.
  missionEngine?.start();

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
    `waha-mcp listening on :${config.port} | engine: ${engine} | public URL: ${config.publicBaseUrl} | tenants: ${tenants.listTenants().length} | tools: ${toolCount} | message cache: ${config.cacheEnabled ? "on" : "off"} | transcription: ${config.transcription ? "on" : "off"} | missions: ${config.missions ? "on" : "off"}`,
  );
  if (engine !== "GOWS" && !engine.startsWith("unknown")) {
    console.warn(`Engine ${engine} is not supported (GOWS only); tools will report this.`);
  }
  // Missions: point active tenants' sessions at /webhooks/waha in the background (best effort,
  // one tenant at a time, never fatal; a no-op when missions are off).
  void configureWebhooks().catch(() => {});

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down.`);
    missionEngine?.stop();
    const finish = (): void => {
      registry.closeAll();
      store.close();
      process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Fatal error.");
  process.exit(1);
});
