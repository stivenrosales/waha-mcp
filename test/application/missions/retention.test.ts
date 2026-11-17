import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createMissionPurge } from "../../../src/application/missions/retention.js";
import { composeMissionEngine, composeMissionPurge } from "../../../src/composition.js";
import type { Config } from "../../../src/config.js";
import type { TenantStore } from "../../../src/domain/ports/TenantStore.js";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSealedMissionLog } from "../../../src/infrastructure/missions/sealedMissionLog.js";
import { createSqliteEventStore } from "../../../src/infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "../../../src/infrastructure/missions/sqliteMissionStore.js";
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
