import { describe, expect, it } from "vitest";
import type { NewMission } from "../../../src/domain/ports/MissionStore.js";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteMissionStore } from "../../../src/infrastructure/missions/sqliteMissionStore.js";

const base: NewMission = {
  tenantId: "t1",
  chatId: "5491100000000@c.us",
  newContact: false,
  deadlineAt: "2026-11-20T00:00:00.000Z",
  expectsFiles: false,
};

function setup(at = "2026-11-17T10:00:00.000Z") {
  const store = createSqliteMissionStore(openAuthDatabase(":memory:"), () => at);
  return store;
}

describe("sqliteMissionStore", () => {
  it("creates an active mission with defaults and reads it back per tenant", () => {
    const store = setup();
    const m = store.create({ ...base, newContact: true, expectsFiles: true });
    expect(m).toMatchObject({
      tenantId: "t1",
      state: "active",
      stopReason: null,
      newContact: true,
      expectsFiles: true,
      noticeSeen: false,
      sentCount: 0,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
    expect(m.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(store.get("t1", m.id)).toEqual(m);
    expect(store.get("other", m.id)).toBeNull();
  });

  it("update patches fields, including booleans and nulls", () => {
    const store = setup();
    const m = store.create({ ...base, nextWakeAt: "2026-11-17T11:00:00.000Z" });
    store.update(m.id, { sentCount: 2, noticeSeen: true, nextWakeAt: null, lastAgentAt: "x" });
    expect(store.get("t1", m.id)).toMatchObject({
      sentCount: 2,
      noticeSeen: true,
      nextWakeAt: null,
      lastAgentAt: "x",
    });
  });

  it("due returns only active missions whose wake time has passed", () => {
    const store = setup();
    const past = store.create({ ...base, nextWakeAt: "2026-11-17T09:00:00.000Z" });
    store.create({ ...base, nextWakeAt: "2026-11-17T12:00:00.000Z" });
    store.create({ ...base, nextWakeAt: null });
    const ended = store.create({ ...base, nextWakeAt: "2026-11-17T08:00:00.000Z" });
    store.update(ended.id, { state: "cancelled" });
    expect(store.due("2026-11-17T10:00:00.000Z").map((m) => m.id)).toEqual([past.id]);
  });

  it("countActive ignores terminal missions and other tenants", () => {
    const store = setup();
    store.create(base);
    const done = store.create(base);
    store.create({ ...base, tenantId: "t2" });
    store.update(done.id, { state: "succeeded" });
    expect(store.countActive("t1")).toBe(1);
  });

  it("countNewContactToday counts new-contact missions from the day start", () => {
    const early = createSqliteMissionStore(
      openAuthDatabase(":memory:"),
      () => "2026-11-16T10:00:00.000Z",
    );
    early.create({ ...base, newContact: true });
    expect(early.countNewContactToday("t1", "2026-11-17T00:00:00.000Z")).toBe(0);
    const store = setup();
    store.create({ ...base, newContact: true });
    store.create(base);
    expect(store.countNewContactToday("t1", "2026-11-17T00:00:00.000Z")).toBe(1);
  });

  it("unseenOutcomes lists terminal unseen missions until markSeen", () => {
    const store = setup();
    const a = store.create(base);
    const b = store.create(base);
    store.create(base);
    store.update(a.id, { state: "failed", endedAt: "2026-11-17T10:00:00.000Z" });
    store.update(b.id, { state: "expired", endedAt: "2026-11-17T10:01:00.000Z" });
    expect(store.unseenOutcomes("t1").map((m) => m.id)).toEqual([a.id, b.id]);
    store.markSeen([a.id]);
    expect(store.unseenOutcomes("t1").map((m) => m.id)).toEqual([b.id]);
  });

  it("list filters by state; endedBefore and deleteForTenant are tenant-scoped", () => {
    const store = setup();
    const a = store.create(base);
    const b = store.create(base);
    const other = store.create({ ...base, tenantId: "t2" });
    store.update(a.id, { state: "cancelled", endedAt: "2026-11-01T00:00:00.000Z" });
    store.update(b.id, { state: "cancelled", endedAt: "2026-11-16T00:00:00.000Z" });
    expect(store.list("t1", "active")).toEqual([]);
    expect(store.list("t1")).toHaveLength(2);
    expect(store.endedBefore("t1", "2026-11-10T00:00:00.000Z")).toEqual([a.id]);
    store.deleteForTenant("t1");
    expect(store.list("t1")).toEqual([]);
    expect(store.get("t2", other.id)).not.toBeNull();
  });

  it("deleteMissions removes only the given tenant's given missions", () => {
    const store = setup();
    const a = store.create(base);
    const b = store.create(base);
    const other = store.create({ ...base, tenantId: "t2" });
    store.deleteMissions("t1", [a.id, other.id]);
    expect(store.get("t1", a.id)).toBeNull();
    expect(store.get("t1", b.id)).not.toBeNull();
    expect(store.get("t2", other.id)).not.toBeNull();
  });

  it("keeps a tenant's reach-out pause across store instances until it is lifted", () => {
    const db = openAuthDatabase(":memory:");
    const store = createSqliteMissionStore(db);
    store.setPaused("t1", true, "2026-11-17T10:00:00.000Z");
    store.setPaused("t1", true, "2026-11-17T11:00:00.000Z");
    store.setPaused("t2", true, "2026-11-17T10:00:00.000Z");
    const reopened = createSqliteMissionStore(db);
    expect(reopened.pausedTenants().sort()).toEqual(["t1", "t2"]);
    reopened.setPaused("t1", false, "2026-11-17T12:00:00.000Z");
    expect(reopened.pausedTenants()).toEqual(["t2"]);
    reopened.deleteForTenant("t2");
    expect(reopened.pausedTenants()).toEqual([]);
  });

  it("dueClosings returns ended missions with a due wake (postponed closing lines)", () => {
    const store = setup();
    const a = store.create(base);
    const b = store.create(base);
    const c = store.create({ ...base, nextWakeAt: "2026-11-17T09:00:00.000Z" });
    store.update(a.id, { state: "expired", nextWakeAt: "2026-11-17T09:00:00.000Z" });
    store.update(b.id, { state: "cancelled", nextWakeAt: "2026-11-18T09:00:00.000Z" });
    expect(store.dueClosings("2026-11-17T10:00:00.000Z").map((m) => m.id)).toEqual([a.id]);
    expect(store.due("2026-11-17T10:00:00.000Z").map((m) => m.id)).toEqual([c.id]);
  });
});
