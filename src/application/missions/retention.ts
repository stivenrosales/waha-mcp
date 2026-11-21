import type { CacheData } from "../../domain/ports/CacheData.js";
import type { EventStore } from "../../domain/ports/EventStore.js";
import type { MissionLog } from "../../domain/ports/MissionLog.js";
import type { MissionStore } from "../../domain/ports/MissionStore.js";
import type { ScheduleLog } from "../../domain/ports/ScheduleLog.js";
import type { ScheduleStore } from "../../domain/ports/ScheduleStore.js";
import type { TenantStore } from "../../domain/ports/TenantStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Mission content (log) and row are deleted this long after the mission ends; so are a scheduled
 * message's row and content after it ends, and each of its run-log entries after that run.
 */
export const MISSION_RETENTION_DAYS = 30;
/** Webhook events (dedupe ids, unhandled payloads) are kept this long after they arrive. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 7;
/** How often `start()` checks whether a purge is due (it runs at most once per day). */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface MissionPurgeDeps {
  missions: Pick<MissionStore, "endedBefore" | "deleteMissions">;
  /** Scheduled-message rows; absent when they are not wired. */
  schedules?: Pick<ScheduleStore, "endedBefore" | "deleteSchedules" | "countActive">;
  /** Absent when the webhook inbox does not exist. */
  events?: Pick<EventStore, "prune">;
  tenants: Pick<TenantStore, "listTenants">;
  /**
   * The tenant's sealed mission and schedule logs and its cached message data; null when it has
   * no runtime (revoked, not active).
   */
  acquireLog(tenantId: string): {
    log: Pick<MissionLog, "purgeMissions">;
    scheduleLog?: Pick<ScheduleLog, "purgeRunsBefore" | "deleteSchedules">;
    cache?: Pick<CacheData, "pruneBefore">;
    release(): void;
  } | null;
  /**
   * Cached message data (messages, edits, reactions, votes, transcripts) older than this many
   * days is pruned in every active tenant (`CACHE_RETENTION_DAYS`); 0 or absent keeps it.
   */
  cacheRetentionDays?: number;
  logger: { info(message: string): void };
}

export interface MissionPurge {
  /** Purges now, whatever the last run. */
  purge(now: Date): void;
  /** Purges when it has not run in this process yet, or ran 24 h or more before `now`. */
  runIfDue(now: Date): void;
  /** Without the mission engine: `runIfDue` now and then every hour, until `stop()`. */
  start(now: () => Date): void;
  stop(): void;
  /**
   * Self-service deletion: deletes every ended mission and ended scheduled message of this one
   * tenant (rows and sealed content) and the run history of its active schedules. Active
   * missions and schedules are kept. Throws when a store or log fails.
   */
  purgeTenantHistory(tenantId: string, now: Date): { missions: number; schedules: number };
}

interface Purged {
  missions: number;
  schedules: number;
  messages: number;
  transcripts: number;
}

/**
 * Retention: deletes the sealed log and the row of every mission that ended more than
 * `MISSION_RETENTION_DAYS` ago, webhook events received more than
 * `WEBHOOK_EVENT_RETENTION_DAYS` ago, and cached message data older than `cacheRetentionDays`.
 * A tenant without a runtime (revoked, not active) keeps its old missions and cache until a
 * later purge can reach them, or until the tenant is deleted. Runs with or without missions
 * configured. Logs counts and tenant ids only.
 */
export function createMissionPurge(deps: MissionPurgeDeps): MissionPurge {
  const { missions, logger } = deps;
  const cacheDays = deps.cacheRetentionDays ?? 0;
  let lastAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const iso = (ms: number): string => new Date(ms).toISOString();

  /**
   * One tenant: missions and schedules that ended before `cutoff`, schedule runs before it, and
   * (with `cacheCutoffMs`) cached message data before that. Null when there was nothing to do,
   * or no runtime to do it in.
   */
  function purgeTenant(
    tenantId: string,
    cutoff: string,
    now: Date,
    cacheCutoffMs: number | null,
  ): Purged | null {
    const { schedules } = deps;
    const ids = missions.endedBefore(tenantId, cutoff);
    const scheduleIds = schedules?.endedBefore(tenantId, cutoff) ?? [];
    // Active schedules and recently ended ones may still hold run entries past the cutoff.
    const hasSchedules =
      schedules !== undefined &&
      (schedules.countActive(tenantId) > 0 ||
        schedules.endedBefore(tenantId, now.toISOString()).length > 0);
    if (ids.length === 0 && !hasSchedules && cacheCutoffMs === null) return null;
    const held = deps.acquireLog(tenantId);
    if (!held) return null;
    let cached = { messages: 0, transcripts: 0 };
    try {
      if (ids.length > 0) held.log.purgeMissions(ids);
      held.scheduleLog?.purgeRunsBefore(cutoff);
      if (scheduleIds.length > 0) held.scheduleLog?.deleteSchedules(scheduleIds);
      if (cacheCutoffMs !== null && held.cache) cached = held.cache.pruneBefore(cacheCutoffMs);
    } finally {
      held.release();
    }
    if (ids.length > 0) missions.deleteMissions(tenantId, ids);
    let purgedSchedules = 0;
    if (held.scheduleLog && scheduleIds.length > 0) {
      schedules?.deleteSchedules(tenantId, scheduleIds);
      purgedSchedules = scheduleIds.length;
    }
    return { missions: ids.length, schedules: purgedSchedules, ...cached };
  }

  function purge(now: Date): void {
    const cutoff = iso(now.getTime() - MISSION_RETENTION_DAYS * DAY_MS);
    const cacheCutoffMs = cacheDays > 0 ? now.getTime() - cacheDays * DAY_MS : null;
    const total: Purged = { missions: 0, schedules: 0, messages: 0, transcripts: 0 };
    for (const tenant of deps.tenants.listTenants()) {
      try {
        const purged = purgeTenant(tenant.id, cutoff, now, cacheCutoffMs);
        if (!purged) continue;
        total.missions += purged.missions;
        total.schedules += purged.schedules;
        total.messages += purged.messages;
        total.transcripts += purged.transcripts;
      } catch {
        logger.info(`tenant=${tenant.id} purge=failed`);
      }
    }
    const pruned =
      deps.events?.prune(iso(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS)) ?? 0;
    const counts = [total.missions, total.schedules, pruned, total.messages, total.transcripts];
    if (counts.some((n) => n > 0)) {
      const cache =
        cacheCutoffMs === null
          ? ""
          : ` cached_messages=${total.messages} transcripts=${total.transcripts}`;
      logger.info(
        `missions purge missions=${total.missions} schedules=${total.schedules} events=${pruned}${cache}`,
      );
    }
  }

  function runIfDue(now: Date): void {
    if (lastAt !== null && now.getTime() - lastAt < DAY_MS) return;
    lastAt = now.getTime();
    try {
      purge(now);
    } catch {
      logger.info("missions purge=failed");
    }
  }

  return {
    purge,
    runIfDue,
    start(now) {
      if (timer) return;
      runIfDue(now());
      timer = setInterval(() => runIfDue(now()), CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    purgeTenantHistory(tenantId, now) {
      // Just past `now`: a mission that ended at this very instant is history too.
      const purged = purgeTenant(tenantId, iso(now.getTime() + 1), now, null);
      return { missions: purged?.missions ?? 0, schedules: purged?.schedules ?? 0 };
    },
  };
}
