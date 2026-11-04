import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCachedGateway } from "../../application/cachedMessages.js";
import {
  createTranscriptionService,
  DISABLED_TRANSCRIPTION,
} from "../../application/transcripts.js";
import type { Config } from "../../config.js";
import type { EngineMapper } from "../../domain/message.js";
import type { Tenant } from "../../domain/ports/TenantStore.js";
import { createSqliteMessageStore, openCacheDatabase } from "../cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../cache/sqliteTranscriptStore.js";
import { createTenantCipher } from "../crypto/envelope.js";
import type { Logger, ToolRunContext } from "../mcp/defineTool.js";
import { createMediaHandler } from "../media/mediaRoute.js";
import { createSignedLinks } from "../media/signedLink.js";
import { createOpenAiCompatibleTranscriber } from "../transcription/openaiCompatible.js";
import { createWahaAudioSource } from "../transcription/wahaAudioSource.js";
import { createFsUploadStore } from "../uploads/fsUploadStore.js";
import { createUploadLinks } from "../uploads/uploadLinks.js";
import { createUploadHandler } from "../uploads/uploadRoute.js";
import { createEngineResolver } from "../waha/engines/index.js";
import { createWahaHttpGateway } from "../waha/WahaHttpGateway.js";
import { createWahaHttpSender } from "../waha/WahaHttpSender.js";

/** Expired upload slots are removed when the runtime is built and on this interval. */
const UPLOAD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * What tools of one tenant run against. `mapper` is the lazy engine lookup
 * (`createEngineResolver`), resolved per tool call by `createToolHandler`.
 */
export type TenantToolContext = Omit<ToolRunContext, "mediaIdleTimeoutMs" | "mapper"> & {
  mapper: () => Promise<EngineMapper>;
};

export interface TenantRuntime {
  tenantId: string;
  context: TenantToolContext;
  /** `GET /media/:token` for this tenant's links. */
  media(token: string): Promise<Response>;
  /** `/upload/:token` for this tenant's links. */
  upload(req: Request, token: string): Promise<Response>;
  /** Closes the cache database and stops the upload sweep. Idempotent. */
  close(): void;
}

/**
 * Builds everything one tenant needs: its WAHA session (gateway and sender), the
 * cached gateway and transcripts in `DATA_DIR/tenants/<id>/cache.db`, uploads in
 * `DATA_DIR/tenants/<id>/uploads`, all encrypted with the tenant's DEK, and links
 * bound to the tenant id. The tenant directory is created with mode 0700.
 */
export function buildTenantRuntime(deps: {
  config: Config;
  tenant: Tenant;
  dek: Buffer;
  mediaSecret: Uint8Array;
  logger: Logger;
}): TenantRuntime {
  const { config, tenant, dek, mediaSecret, logger } = deps;
  const session = tenant.wahaSession;
  const dir = join(config.dataDir, "tenants", tenant.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const cipher = createTenantCipher(dek, tenant.id);
  const wahaGateway = createWahaHttpGateway({
    baseUrl: config.wahaApiUrl,
    apiKey: config.wahaApiKey,
    session,
  });
  // Transcripts live in the same file as the message cache (even with the cache off).
  const cacheDb =
    config.cacheEnabled || config.transcription ? openCacheDatabase(join(dir, "cache.db")) : null;
  const messageStore =
    config.cacheEnabled && cacheDb ? createSqliteMessageStore(cacheDb, cipher) : null;
  const gateway = messageStore
    ? createCachedGateway(wahaGateway, messageStore, {
        refreshHours: config.cacheRefreshHours,
        maxAgeDays: config.cacheMaxAgeDays,
        session,
      })
    : wahaGateway;
  const transcription =
    config.transcription && cacheDb
      ? createTranscriptionService({
          gateway,
          audio: createWahaAudioSource(gateway, { maxBytes: config.mediaMaxBytes }),
          store: createSqliteTranscriptStore(cacheDb, cipher),
          transcriber: createOpenAiCompatibleTranscriber(config.transcription),
          session,
          maxSeconds: config.transcription.maxSeconds,
          maxPerCall: config.transcription.maxPerCall,
          logger,
        })
      : DISABLED_TRANSCRIPTION;
  const links = createSignedLinks({
    secret: mediaSecret,
    ttlSeconds: config.mediaLinkTtlSeconds,
    tenantId: tenant.id,
  });
  const uploadLinks = createUploadLinks(mediaSecret, config.uploadTtlSeconds, tenant.id);
  const uploads = createFsUploadStore({
    dir: join(dir, "uploads"),
    ttlSeconds: config.uploadTtlSeconds,
    maxBytes: config.uploadMaxBytes,
    cipher,
  });
  uploads.sweep();
  const sweeper = setInterval(() => uploads.sweep(), UPLOAD_SWEEP_INTERVAL_MS);
  sweeper.unref();

  const sender = createWahaHttpSender({
    baseUrl: config.wahaApiUrl,
    apiKey: config.wahaApiKey,
    session,
  });
  const media = createMediaHandler({ gateway, links, maxBytes: config.mediaMaxBytes, logger });
  const upload = createUploadHandler({
    store: uploads,
    links: uploadLinks,
    maxBytes: config.uploadMaxBytes,
    logger,
  });

  let closed = false;
  return {
    tenantId: tenant.id,
    context: {
      gateway,
      mapper: createEngineResolver(gateway),
      config,
      links,
      transcription,
      sender,
      uploads,
      uploadLinks,
    },
    media,
    upload,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      cacheDb?.close();
    },
  };
}
