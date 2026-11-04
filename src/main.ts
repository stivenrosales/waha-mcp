import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { composeApp } from "./composition.js";
import { loadConfig } from "./config.js";
import { createAuthStore, openAuthDatabase } from "./infrastructure/auth/store.js";
import { loadOrCreateMediaSecret } from "./infrastructure/media/signedLink.js";
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
  const sessions = createWahaSessionAdmin({
    baseUrl: config.wahaApiUrl,
    apiKey: config.wahaApiKey,
  });
  try {
    // Fails fast (nothing written) when MASTER_KEY does not open the stored tenant keys.
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
  const { app, registry, toolCount } = composeApp({
    config,
    store,
    tenants,
    sessions,
    mediaSecret,
    logger,
  });

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
    `waha-mcp listening on :${config.port} | engine: ${engine} | public URL: ${config.publicBaseUrl} | tenants: ${tenants.listTenants().length} | tools: ${toolCount} | message cache: ${config.cacheEnabled ? "on" : "off"} | transcription: ${config.transcription ? "on" : "off"}`,
  );
  if (engine !== "GOWS" && !engine.startsWith("unknown")) {
    console.warn(`Engine ${engine} is not supported (GOWS only); tools will report this.`);
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down.`);
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
