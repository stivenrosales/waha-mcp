import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { withMessageActions } from "../../application/actionsGateway.js";
import { createCachedGateway } from "../../application/cachedMessages.js";
import { createMessageActions, type MessageActions } from "../../application/messageActions.js";
import { ownerChatId } from "../../application/missions/notify.js";
import {
  createMissionService,
  type MissionServiceDeps,
} from "../../application/missions/service.js";
import { createOwnerCheck } from "../../application/ownerCheck.js";
import { createScheduleService } from "../../application/schedules/service.js";
import {
  createTranscriptionService,
  DISABLED_TRANSCRIPTION,
} from "../../application/transcripts.js";
import type { Config } from "../../config.js";
import { WahaNotFoundError } from "../../domain/errors.js";
import type { EngineMapper } from "../../domain/message.js";
import type { ScheduleLog } from "../../domain/ports/ScheduleLog.js";
import type { ScheduleStore } from "../../domain/ports/ScheduleStore.js";
import type { Tenant } from "../../domain/ports/TenantStore.js";
import type { TranscriptStore } from "../../domain/ports/TranscriptStore.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import { createSqliteMessageActionStore } from "../cache/sqliteMessageActionStore.js";
import { createSqliteMessageStore, openCacheDatabase } from "../cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../cache/sqliteTranscriptStore.js";
import { createTenantCipher, type TenantCipher } from "../crypto/envelope.js";
import type { Logger, ToolRunContext } from "../mcp/defineTool.js";
import { createMediaHandler } from "../media/mediaRoute.js";
import { createSignedLinks } from "../media/signedLink.js";
import { createSealedMissionLog, type MissionLog } from "../missions/sealedMissionLog.js";
import { createSealedScheduleLog } from "../schedules/sealedScheduleLog.js";
import {
  createOpenAiCompatibleTranscriber,
  type TranscriptionUsage,
} from "../transcription/openaiCompatible.js";
import { createWahaAudioSource } from "../transcription/wahaAudioSource.js";
import { createFsUploadStore } from "../uploads/fsUploadStore.js";
import { createUploadLinks } from "../uploads/uploadLinks.js";
import { createUploadHandler } from "../uploads/uploadRoute.js";
import { createEngineResolver } from "../waha/engines/index.js";
import { createWahaHttpGateway } from "../waha/WahaHttpGateway.js";
import { createWahaHttpSender } from "../waha/WahaHttpSender.js";

/** What every tenant's schedule service shares: the schedule store and the runner's cancel. */
export interface ScheduleWiring {
  store: ScheduleStore;
  /** A run already in its typing pause then sends nothing. */
  cancel(tenantId: string, id: string): boolean;
}

/**
 * What every tenant's mission service shares (the server-wide stores and the engine), and the
 * schedule wiring (scheduled messages exist only with missions).
 */
export type MissionWiring = Pick<MissionServiceDeps, "store" | "tenants" | "engine" | "now"> & {
  schedules?: ScheduleWiring;
};

/** Expired upload slots are removed when the runtime is built and on this interval. */
const UPLOAD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Tenant ids become a directory name: one plain path segment, nothing else. */
const TENANT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * What tools of one tenant run against. `mapper` is the lazy engine lookup
 * (`createEngineResolver`), resolved per tool call by `createToolHandler`.
 */
export type TenantToolContext = Omit<ToolRunContext, "mediaIdleTimeoutMs" | "mapper" | "admin"> & {
  mapper: () => Promise<EngineMapper>;
};

export interface TenantRuntime {
  tenantId: string;
  context: TenantToolContext;
  /** `GET /media/:token` for this tenant's links. */
  media(token: string): Promise<Response>;
  /** `/upload/:token` for this tenant's links. */
  upload(req: Request, token: string): Promise<Response>;
  /** Sealed mission content of this tenant (`cache.db`). */
  missionLog: MissionLog;
  /** Sealed scheduled-message content and run history of this tenant (`cache.db`). */
  scheduleLog: ScheduleLog;
  /** This tenant's data cipher (e.g. to seal received webhook payloads). */
  cipher: TenantCipher;
  /** Closes the cache database and stops the upload sweep. Idempotent. */
  close(): void;
}

/**
 * Builds everything one tenant needs: its WAHA session (gateway and sender), the
 * cached gateway and transcripts in `DATA_DIR/tenants/<id>/cache.db`, uploads in
 * `DATA_DIR/tenants/<id>/uploads`, all encrypted with the tenant's DEK, and links
 * bound to the tenant id. The tenant directory is created with mode 0700.
 */
/**
 * Wraps the usage recorder so a failed write (e.g. a locked database) only logs a line naming
 * the tenant: accounting must never cost a tenant its transcript, and the error text may carry
 * provider details.
 */
export function guardUsageRecorder(
  record: ((usage: TranscriptionUsage) => void) | undefined,
  logger: Logger,
  tenantId: string,
): (usage: TranscriptionUsage) => void {
  return (usage) => {
    if (!record) return;
    try {
      record(usage);
    } catch {
      logger.info(`tenant=${tenantId} transcription usage not recorded`);
    }
  };
}

/**
 * The tenant's mission and schedule services over its gateway and sealed logs; both null without
 * `config.missions` or the wiring. Exported for the end-to-end tests' runtime seam.
 */
export function buildTenantServices(deps: {
  config: Config;
  tenant: Tenant;
  gateway: WahaGateway;
  missionLog: MissionLog;
  scheduleLog: ScheduleLog;
  logger: Logger;
  wiring?: MissionWiring;
}): Pick<TenantToolContext, "missions" | "schedules"> {
  const { config, tenant, gateway, wiring } = deps;
  const missionsConfig = config.missions;
  if (!missionsConfig || !wiring) return { missions: null, schedules: null };
  const lookupLid = (lid: string) => gateway.lookupLid(lid);
  const hasHistory = async (chatId: string): Promise<boolean> => {
    try {
      return (await gateway.getMessages(chatId, { limit: 1, offset: 0 })).length > 0;
    } catch (error) {
      // WAHA has never seen this chat: a new contact.
      if (error instanceof WahaNotFoundError) return false;
      throw error;
    }
  };
  const { schedules: scheduleWiring, ...missionWiring } = wiring;
  return {
    missions: createMissionService({
      ...missionWiring,
      ...(scheduleWiring ? { schedules: scheduleWiring.store } : {}),
      tenantId: tenant.id,
      log: deps.missionLog,
      limits: missionsConfig.limits,
      monthlyBudgetUsd: missionsConfig.monthlyBudgetUsd,
      timezone: config.timezone,
      lookupLid,
      logger: deps.logger,
      hasHistory,
    }),
    schedules: scheduleWiring
      ? createScheduleService({
          tenantId: tenant.id,
          store: scheduleWiring.store,
          log: deps.scheduleLog,
          missions: wiring.store,
          cancel: scheduleWiring.cancel,
          limits: missionsConfig.schedules,
          missionLimits: missionsConfig.limits,
          timezone: config.timezone,
          now: wiring.now,
          ownerChatId: ownerChatId(tenant.waId),
          hasHistory,
          lookupLid,
        })
      : null,
  };
}

/**
 * The read path and the message actions of one tenant over its `cache.db`: WAHA → message-actions
 * decorator → message cache (when `cache` is set). Edits and revokes are applied below the cache,
 * so every refresh, backfill and fallback stores and returns the rewritten payload. The action
 * store and the transcript store are always built (cache on or off), and one owner check is shared
 * by the decorator, the cache and the actions. The engine resolver is built once over WAHA.
 * Exported for the end-to-end tests' runtime seam.
 */
export function wireMessageActions(deps: {
  wahaGateway: WahaGateway;
  db: DatabaseSync;
  cipher: TenantCipher;
  session: string;
  cache: { refreshHours: number; maxAgeDays: number; now?: () => number } | null;
}): {
  gateway: WahaGateway;
  mapper: () => Promise<EngineMapper>;
  messageActions: MessageActions;
  transcripts: TranscriptStore;
} {
  const { wahaGateway, db, cipher, session, cache } = deps;
  const mapper = createEngineResolver(wahaGateway);
  const transcripts = createSqliteTranscriptStore(db, cipher);
  const store = createSqliteMessageActionStore(db, cipher);
  const ensureOwner = createOwnerCheck(wahaGateway, transcripts, session);
  const actionsGateway = withMessageActions(wahaGateway, { store, mapper, ensureOwner });
  const messageStore = cache ? createSqliteMessageStore(db, cipher) : null;
  const gateway = messageStore
    ? createCachedGateway(actionsGateway, messageStore, {
        refreshHours: cache?.refreshHours ?? 0,
        maxAgeDays: cache?.maxAgeDays ?? 0,
        session,
        ensureOwner,
        ...(cache?.now ? { now: cache.now } : {}),
      })
    : actionsGateway;
  const messageActions = createMessageActions({
    store,
    messages: messageStore,
    transcripts,
    mapper,
    ensureOwner,
  });
  return { gateway, mapper, messageActions, transcripts };
}

export function buildTenantRuntime(deps: {
  config: Config;
  tenant: Tenant;
  dek: Buffer;
  mediaSecret: Uint8Array;
  logger: Logger;
  /** Stores one paid transcription for this tenant (the registry writes it to the central store). */
  recordUsage?: (usage: TranscriptionUsage) => void;
  /** Mission stores and engine; the tools get no mission service without it or `config.missions`. */
  missions?: MissionWiring;
}): TenantRuntime {
  const { config, tenant, dek, mediaSecret, logger } = deps;
  if (!TENANT_ID.test(tenant.id)) throw new Error("Invalid tenant id.");
  const session = tenant.wahaSession;
  const dir = join(config.dataDir, "tenants", tenant.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mode` only applies to directories mkdir creates; an existing one is tightened here.
  chmodSync(dir, 0o700);

  const cipher = createTenantCipher(dek, tenant.id);
  const wahaGateway = createWahaHttpGateway({
    baseUrl: config.wahaApiUrl,
    apiKey: config.wahaApiKey,
    session,
  });
  // Transcripts live in the same file as the message cache (even with the cache off).
  // The mission log needs it too, so it is always open.
  const cacheDb = openCacheDatabase(join(dir, "cache.db"));
  // Anything that fails after the database is open must not leak its handle (or the sweep
  // timer): the registry would rebuild, and leak again, on every later acquire.
  let sweeper: ReturnType<typeof setInterval> | undefined;
  try {
    const { gateway, mapper, messageActions, transcripts } = wireMessageActions({
      wahaGateway,
      db: cacheDb,
      cipher,
      session,
      cache: config.cacheEnabled
        ? { refreshHours: config.cacheRefreshHours, maxAgeDays: config.cacheMaxAgeDays }
        : null,
    });
    const transcription = config.transcription
      ? createTranscriptionService({
          gateway,
          audio: createWahaAudioSource(gateway, { maxBytes: config.mediaMaxBytes }),
          store: transcripts,
          transcriber: createOpenAiCompatibleTranscriber({
            ...config.transcription,
            onUsage: guardUsageRecorder(deps.recordUsage, logger, tenant.id),
          }),
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
    sweeper = setInterval(() => uploads.sweep(), UPLOAD_SWEEP_INTERVAL_MS);
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

    const missionLog = createSealedMissionLog(cacheDb, cipher);
    const scheduleLog = createSealedScheduleLog(cacheDb, cipher);
    const { missions, schedules } = buildTenantServices({
      config,
      tenant,
      gateway,
      missionLog,
      scheduleLog,
      logger,
      ...(deps.missions ? { wiring: deps.missions } : {}),
    });

    let closed = false;
    return {
      tenantId: tenant.id,
      context: {
        gateway,
        mapper,
        config,
        links,
        transcription,
        sender,
        uploads,
        uploadLinks,
        missions,
        schedules,
        messageActions,
      },
      media,
      upload,
      missionLog,
      scheduleLog,
      cipher,
      close() {
        if (closed) return;
        closed = true;
        clearInterval(sweeper);
        cacheDb.close();
      },
    };
  } catch (error) {
    if (sweeper) clearInterval(sweeper);
    cacheDb.close();
    throw error;
  }
}
