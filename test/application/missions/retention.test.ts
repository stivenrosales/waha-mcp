import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createMissionPurge } from "../../../src/application/missions/retention.js";
import { composeMissionEngine, composeMissionPurge } from "../../../src/composition.js";
import type { Config } from "../../../src/config.js";
import type { TenantStore } from "../../../src/domain/ports/TenantStore.js";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createCacheData } from "../../../src/infrastructure/cache/cacheData.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSealedMissionLog } from "../../../src/infrastructure/missions/sealedMissionLog.js";
import { createSqliteEventStore } from "../../../src/infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "../../../src/infrastructure/missions/sqliteMissionStore.js";
import { createSealedScheduleLog } from "../../../src/infrastructure/schedules/sealedScheduleLog.js";
import { createSqliteScheduleStore } from "../../../src/infrastructure/schedules/sqliteScheduleStore.js";
import type { TenantRegistry } from "../../../src/infrastructure/tenants/registry.js";
import type { TenantRuntime } from "../../../src/infrastructure/tenants/runtime.js";
import { testCipher } from "../../fakes/testCipher.js";

const TENANT = "t1";
const NOW = new Date("2026-11-17T15:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const tenant = {
  id: TENANT,
  wahaSession: "s1",
  displayName: "Stiven",
  status: "active" as const,
  waId: null,
  createdAt: 0,
};

function stores() {
  const authDb = openAuthDatabase(":memory:");
  const missions = createSqliteMissionStore(authDb);
  const events = createSqliteEventStore(authDb);
  const log = createSealedMissionLog(new DatabaseSync(":memory:"), testCipher(TENANT));
  /** An ended mission with content, ended `msAgo` before NOW. */
  const ended = (msAgo: number) => {
    const m = missions.create({
      tenantId: TENANT,
      chatId: "51911111111@c.us",
      newContact: false,
      deadlineAt: NOW.toISOString(),
      expectsFiles: false,
    });
    missions.update(m.id, {
      state: "cancelled",
      endedAt: new Date(NOW.getTime() - msAgo).toISOString(),
    });
    log.append(m.id, { kind: "prompt", at: NOW.toISOString(), body: "secreto" });
    return m.id;
  };
  const event = (eventId: string, msAgo: number) =>
    events.put({
      tenantId: TENANT,
      eventId,
      kind: "message",
      receivedAt: new Date(NOW.getTime() - msAgo).toISOString(),
      payloadSealed: "",
    });
  return { authDb, missions, events, log, ended, event };
}

describe("mission purge", () => {
  it("keeps a mission ended exactly 30 days ago and deletes one ended 30 days + 1 ms ago", () => {
    const s = stores();
    const edge = s.ended(30 * DAY);
    const past = s.ended(30 * DAY + 1);
    createMissionPurge({
      missions: s.missions,
      events: s.events,
      tenants: { listTenants: () => [tenant] },
      acquireLog: () => ({ log: s.log, release() {} }),
      logger: { info() {} },
    }).purge(NOW);
    expect(s.missions.get(TENANT, edge)).not.toBeNull();
    expect(s.log.read(edge)).toHaveLength(1);
    expect(s.missions.get(TENANT, past)).toBeNull();
    expect(s.log.read(past)).toEqual([]);
  });

  it("purges schedule runs 30 days after each run, and ended schedules 30 days after they end", () => {
    const s = stores();
    const schedules = createSqliteScheduleStore(s.authDb);
    const scheduleLog = createSealedScheduleLog(new DatabaseSync(":memory:"), testCipher(TENANT));
    const schedule = (endedMsAgo: number | null) => {
      const row = schedules.create({
        tenantId: TENANT,
        chatId: "51911111111@c.us",
        kind: "fixed",
        repeat: "daily",
        firstAt: NOW.toISOString(),
        nextRunAt: NOW.toISOString(),
        maxRuns: 12,
        newContact: false,
      });
      if (endedMsAgo !== null)
        schedules.update(row.id, {
          state: "done",
          endedAt: new Date(NOW.getTime() - endedMsAgo).toISOString(),
          nextRunAt: null,
        });
      scheduleLog.putContent(row.id, { text: "hola" });
      for (const daysAgo of [31, 30])
        scheduleLog.appendRun(row.id, {
          at: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
          outcome: "sent",
          text: "hola",
        });
      return row.id;
    };
    const active = schedule(null);
    const edge = schedule(30 * DAY);
    const past = schedule(30 * DAY + 1);
    createMissionPurge({
      missions: s.missions,
      schedules,
      tenants: { listTenants: () => [tenant] },
      acquireLog: () => ({ log: s.log, scheduleLog, release() {} }),
      logger: { info() {} },
    }).purge(NOW);
    // Active: kept, only the run older than 30 days is gone.
    expect(schedules.get(TENANT, active)?.state).toBe("active");
    expect(scheduleLog.content(active)).toEqual({ text: "hola" });
    expect(scheduleLog.runs(active, 10).map((r) => r.at)).toEqual([
      new Date(NOW.getTime() - 30 * DAY).toISOString(),
    ]);
    expect(schedules.get(TENANT, edge)).not.toBeNull();
    expect(scheduleLog.content(edge)).toEqual({ text: "hola" });
    expect(schedules.get(TENANT, past)).toBeNull();
    expect(scheduleLog.content(past)).toBeNull();
    expect(scheduleLog.runs(past, 10)).toEqual([]);
  });

  it("keeps a webhook event received exactly 7 days ago and prunes one 7 days + 1 ms old", () => {
    const s = stores();
    s.event("evt_edge", 7 * DAY);
    s.event("evt_past", 7 * DAY + 1);
    createMissionPurge({
      missions: s.missions,
      events: s.events,
      tenants: { listTenants: () => [] },
      acquireLog: () => null,
      logger: { info() {} },
    }).purge(NOW);
    expect(s.events.pending(10).map((e) => e.eventId)).toEqual(["evt_edge"]);
  });

  it("prunes every active tenant's message cache older than cacheRetentionDays, each in its own runtime", () => {
    const s = stores();
    const other = { ...tenant, id: "t2", wahaSession: "s2" };
    const revoked = { ...tenant, id: "t3", wahaSession: "s3" };
    const pruned: { tenantId: string; cutoffMs: number }[] = [];
    const released: string[] = [];
    createMissionPurge({
      missions: s.missions,
      tenants: { listTenants: () => [tenant, other, revoked] },
      // No runtime for a revoked tenant: nothing to prune there until it is restored.
      acquireLog: (tenantId) =>
        tenantId === "t3"
          ? null
          : {
              log: s.log,
              cache: {
                pruneBefore: (cutoffMs) => {
                  pruned.push({ tenantId, cutoffMs });
                  return { messages: 2, transcripts: 1 };
                },
              },
              release: () => released.push(tenantId),
            },
      cacheRetentionDays: 90,
      logger: { info() {} },
    }).purge(NOW);
    const cutoffMs = NOW.getTime() - 90 * DAY;
    expect(pruned).toEqual([
      { tenantId: TENANT, cutoffMs },
      { tenantId: "t2", cutoffMs },
    ]);
    expect(released).toEqual([TENANT, "t2"]);
  });

  it("does not prune the message cache when cacheRetentionDays is 0 (keep forever)", () => {
    const s = stores();
    let acquired = 0;
    createMissionPurge({
      missions: s.missions,
      tenants: { listTenants: () => [tenant] },
      acquireLog: () => {
        acquired += 1;
        return {
          log: s.log,
          cache: {
            pruneBefore: () => {
              throw new Error("must not prune");
            },
          },
          release() {},
        };
      },
      cacheRetentionDays: 0,
      logger: { info() {} },
    }).purge(NOW);
    expect(acquired).toBe(0);
  });

  it("a failing cache prune of one tenant is logged and does not stop the others", () => {
    const s = stores();
    const other = { ...tenant, id: "t2", wahaSession: "s2" };
    const lines: string[] = [];
    const pruned: string[] = [];
    createMissionPurge({
      missions: s.missions,
      tenants: { listTenants: () => [tenant, other] },
      acquireLog: (tenantId) => ({
        log: s.log,
        cache: {
          pruneBefore: () => {
            if (tenantId === TENANT) throw new Error("disk");
            pruned.push(tenantId);
            return { messages: 3, transcripts: 0 };
          },
        },
        release() {},
      }),
      cacheRetentionDays: 90,
      logger: { info: (m) => lines.push(m) },
    }).purge(NOW);
    expect(pruned).toEqual(["t2"]);
    expect(lines).toContain(`tenant=${TENANT} purge=failed`);
    expect(lines).toContain(
      "missions purge missions=0 schedules=0 events=0 cached_messages=3 transcripts=0",
    );
  });

  it("purgeTenantHistory deletes only that tenant's ended missions and keeps its active ones", () => {
    const s = stores();
    const endedNow = s.ended(1);
    const active = s.missions.create({
      tenantId: TENANT,
      chatId: "51922222222@c.us",
      newContact: false,
      deadlineAt: NOW.toISOString(),
      expectsFiles: false,
    });
    s.log.append(active.id, { kind: "prompt", at: NOW.toISOString(), body: "activa" });
    const otherTenant = s.missions.create({
      tenantId: "t2",
      chatId: "51933333333@c.us",
      newContact: false,
      deadlineAt: NOW.toISOString(),
      expectsFiles: false,
    });
    s.missions.update(otherTenant.id, { state: "cancelled", endedAt: NOW.toISOString() });
    const acquired: string[] = [];
    const result = createMissionPurge({
      missions: s.missions,
      tenants: { listTenants: () => [tenant] },
      acquireLog: (tenantId) => {
        acquired.push(tenantId);
        return { log: s.log, release() {} };
      },
      logger: { info() {} },
    }).purgeTenantHistory(TENANT, NOW);
    expect(result).toEqual({ missions: 1, schedules: 0 });
    expect(acquired).toEqual([TENANT]);
    expect(s.missions.get(TENANT, endedNow)).toBeNull();
    expect(s.log.read(endedNow)).toEqual([]);
    expect(s.missions.get(TENANT, active.id)?.state).toBe("active");
    expect(s.log.read(active.id)).toHaveLength(1);
    expect(s.missions.get("t2", otherTenant.id)).not.toBeNull();
  });

  it("composeMissionPurge prunes each runtime's cache.db past CACHE_RETENTION_DAYS and keeps newer rows", () => {
    const s = stores();
    const chat = "51911111111@c.us";
    const nowS = Math.floor(NOW.getTime() / 1000);
    const caches = new Map(
      ["t1", "t2"].map((id) => {
        const db = openCacheDatabase(":memory:");
        const cipher = testCipher(id);
        createSqliteMessageStore(db, cipher).upsertRaw(chat, [
          { id: `${id}_old`, ts: nowS - 90 * 86_400 - 1, raw: { id: `${id}_old` } },
          { id: `${id}_edge`, ts: nowS - 90 * 86_400, raw: { id: `${id}_edge` } },
        ]);
        return [id, { db, cipher }] as const;
      }),
    );
    const registry = {
      acquire: (id: string) => {
        const c = caches.get(id);
        return c
          ? {
              runtime: {
                missionLog: s.log,
                cacheData: createCacheData(c.db, c.cipher),
              } as unknown as TenantRuntime,
              release() {},
            }
          : null;
      },
    } as unknown as TenantRegistry;
    const purge = composeMissionPurge({
      registry,
      tenants: {
        listTenants: () => [tenant, { ...tenant, id: "t2" }],
      } as unknown as TenantStore,
      missions: s.missions,
      events: s.events,
      logger: { info() {} },
      cacheRetentionDays: 90,
    });
    purge.purge(NOW);
    for (const [id, c] of caches)
      expect(
        createSqliteMessageStore(c.db, c.cipher).readRange(chat, { limit: 10, offset: 0 }),
      ).toEqual([{ id: `${id}_edge` }]);
  });

  it("runs even when missions are off: no engine, but start() purges right away", () => {
    const s = stores();
    const old = s.ended(31 * DAY);
    s.event("evt_old", 8 * DAY);
    const config = { missions: undefined } as unknown as Config;
    const registry = {
      acquire: (id: string) =>
        id === TENANT
          ? { runtime: { missionLog: s.log } as unknown as TenantRuntime, release() {} }
          : null,
    } as unknown as TenantRegistry;
    const tenants = { listTenants: () => [tenant] } as unknown as TenantStore;
    const logger = { info() {} };
    expect(
      composeMissionEngine({
        config,
        registry,
        tenants,
        missions: s.missions,
        events: s.events,
        logger,
      }),
    ).toBeNull();
    const purge = composeMissionPurge({
      registry,
      tenants,
      missions: s.missions,
      events: s.events,
      logger,
    });
    purge.start(() => NOW);
    purge.stop();
    expect(s.missions.get(TENANT, old)).toBeNull();
    expect(s.log.read(old)).toEqual([]);
    expect(s.events.pending(10)).toEqual([]);
  });
});
