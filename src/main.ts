import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createCachedGateway } from "./application/cachedMessages.js";
import { loadConfig } from "./config.js";
import { bearerGuard } from "./infrastructure/auth/bearer.js";
import { createOAuthRoutes } from "./infrastructure/auth/oauth.js";
import { createLoginLimiter } from "./infrastructure/auth/rateLimit.js";
import { createAuthStore } from "./infrastructure/auth/store.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "./infrastructure/cache/sqliteMessageStore.js";
import { createApp } from "./infrastructure/http/app.js";
import { SERVER_INSTRUCTIONS } from "./infrastructure/mcp/instructions.js";
import { createMcpServer } from "./infrastructure/mcp/server.js";
import { createTools } from "./infrastructure/mcp/tools/index.js";
import { createMediaHandler } from "./infrastructure/media/mediaRoute.js";
import { createSignedLinks, loadOrCreateMediaSecret } from "./infrastructure/media/signedLink.js";
import { createWahaHttpGateway } from "./infrastructure/waha/WahaHttpGateway.js";

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

  const wahaGateway = createWahaHttpGateway({
    baseUrl: config.wahaApiUrl,
    apiKey: config.wahaApiKey,
    session: config.wahaSession,
  });
  mkdirSync(config.dataDir, { recursive: true });
  const store = createAuthStore(join(config.dataDir, "auth.db"));
  // The message cache is a copy of conversations at rest; logout does not clear it.
  const messageStore = config.cacheEnabled
    ? createSqliteMessageStore(openCacheDatabase(join(config.dataDir, "cache.db")))
    : null;
  const gateway = messageStore
    ? createCachedGateway(wahaGateway, messageStore, {
        refreshHours: config.cacheRefreshHours,
        maxAgeDays: config.cacheMaxAgeDays,
      })
    : wahaGateway;
  if (store.syncApiKey(config.wahaApiKey)) logger.info("API key changed — all sessions revoked");
  const links = createSignedLinks({
    secret: loadOrCreateMediaSecret(config.dataDir),
    ttlSeconds: config.mediaLinkTtlSeconds,
  });
  const tools = createTools();
  const mcp = createMcpServer({
    tools,
    instructions: SERVER_INSTRUCTIONS,
    gateway,
    config,
    links,
    logger,
  });
  const app = createApp({
    oauth: createOAuthRoutes({
      store,
      wahaApiKey: config.wahaApiKey,
      publicBaseUrl: config.publicBaseUrl,
      limiter: createLoginLimiter(),
    }),
    guard: bearerGuard({ store, publicBaseUrl: config.publicBaseUrl }),
    mcpHandler: mcp.handler,
    media: createMediaHandler({
      gateway,
      links,
      maxBytes: config.mediaMaxBytes,
      logger,
    }),
  });

  const server = serve({ fetch: app.fetch, port: config.port });

  // Startup log: never the API key or the WAHA URL. A non-GOWS engine does not
  // stop the server; tools report the unsupported engine themselves.
  let engine = "unknown (WAHA not reachable)";
  try {
    engine = (await gateway.getSession()).engine;
  } catch {
    // WAHA may not be up yet; the engine resolver retries on the first tool call.
  }
  console.log(
    `waha-mcp listening on :${config.port} | engine: ${engine} | session: ${config.wahaSession} | public URL: ${config.publicBaseUrl} | tools: ${tools.length} | message cache: ${config.cacheEnabled ? "on" : "off"}`,
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
      store.close();
      messageStore?.close();
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
