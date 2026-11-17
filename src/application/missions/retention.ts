import type { EventStore } from "../../domain/ports/EventStore.js";
import type { MissionLog } from "../../domain/ports/MissionLog.js";
import type { MissionStore } from "../../domain/ports/MissionStore.js";
import type { TenantStore } from "../../domain/ports/TenantStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mission content (log) and row are deleted this long after the mission ends. */
export const MISSION_RETENTION_DAYS = 30;
/** Webhook events (dedupe ids, unhandled payloads) are kept this long after they arrive. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 7;
/** How often `start()` checks whether a purge is due (it runs at most once per day). */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface MissionPurgeDeps {
  missions: Pick<MissionStore, "endedBefore" | "deleteMissions">;
  /** Absent when the webhook inbox does not exist. */
  events?: Pick<EventStore, "prune">;
  tenants: Pick<TenantStore, "listTenants">;
  /** The tenant's sealed mission log; null when it has no runtime (revoked, not active). */
  acquireLog(tenantId: string): { log: Pick<MissionLog, "purgeMissions">; release(): void } | null;
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
}

/**
 * Retention: deletes the sealed log and the row of every mission that ended more than
 * `MISSION_RETENTION_DAYS` ago, and webhook events received more than
 * `WEBHOOK_EVENT_RETENTION_DAYS` ago. A tenant without a runtime (revoked, not active) keeps its
 * old missions until a later purge can reach its log, or until the tenant is deleted. Runs with
 * or without missions configured. Logs counts and tenant ids only.
 */
export function createMissionPurge(deps: MissionPurgeDeps): MissionPurge {
  const { missions, logger } = deps;
  let lastAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const iso = (ms: number): string => new Date(ms).toISOString();

  function purge(now: Date): void {
    const missionCutoff = iso(now.getTime() - MISSION_RETENTION_DAYS * DAY_MS);
    let purged = 0;
    for (const tenant of deps.tenants.listTenants()) {
      try {
        const ids = missions.endedBefore(tenant.id, missionCutoff);
        if (ids.length === 0) continue;
        const held = deps.acquireLog(tenant.id);
        if (!held) continue;
        try {
          held.log.purgeMissions(ids);
        } finally {
          held.release();
        }
        missions.deleteMissions(tenant.id, ids);
        purged += ids.length;
      } catch {
        logger.info(`tenant=${tenant.id} purge=failed`);
      }
    }
    const pruned =
      deps.events?.prune(iso(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS)) ?? 0;
    if (purged > 0 || pruned > 0) logger.info(`missions purge missions=${purged} events=${pruned}`);
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
  };
}
