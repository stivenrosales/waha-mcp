import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteScheduleStore } from "../../../src/infrastructure/schedules/sqliteScheduleStore.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";

const base = {
  tenantId: "t1",
  chatId: "51999@c.us",
  kind: "fixed" as const,
  repeat: "none" as const,
  firstAt: "2026-11-21T15:00:00.000Z",
  nextRunAt: "2026-11-21T15:00:00.000Z" as string | null,
  maxRuns: 1,
  newContact: false,
};

function setup() {
  let clock = "2026-11-20T10:00:00.000Z";
  const db = new DatabaseSync(":memory:");
  createSqliteTenantStore(db);
  const addTenant = (id: string, status: string) =>
    db
      .prepare(
        `INSERT INTO tenants (id, waha_session, display_name, status, wrapped_dek, created_at)
         VALUES (?, ?, ?, ?, 'dek', 0)`,
      )
      .run(id, `s-${id}`, id, status);
  addTenant("t1", "active");
  addTenant("t2", "active");
  const store = createSqliteScheduleStore(db, () => clock);
  return { store, addTenant, setClock: (iso: string) => (clock = iso) };
}

describe("sqliteScheduleStore", () => {
  it("round-trips a created schedule with defaults", () => {
    const { store } = setup();
    const row = store.create({ ...base, repeat: "weekly", maxRuns: 4, newContact: true });
    expect(row.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(row).toEqual({
      ...base,
      id: row.id,
      repeat: "weekly",
      maxRuns: 4,
      newContact: true,
      runsDone: 0,
      state: "active",
      createdAt: "2026-11-20T10:00:00.000Z",
      endedAt: null,
      followUpSince: null,
    });
    expect(store.get("t1", row.id)).toEqual(row);
    expect(store.get("t2", row.id)).toBeNull();
  });

  it("stores the anchor of a follow-up", () => {
    const { store } = setup();
    const row = store.create({ ...base, followUpSince: "2026-11-20T10:00:00.000Z" });
    expect(row.followUpSince).toBe("2026-11-20T10:00:00.000Z");
    expect(store.get("t1", row.id)?.followUpSince).toBe("2026-11-20T10:00:00.000Z");
  });

  it("adds follow_up_since to a schedules table created before follow-ups; old rows read null", () => {
    const db = new DatabaseSync(":memory:");
    createSqliteTenantStore(db);
    db.exec(`CREATE TABLE schedules (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, chat_id TEXT NOT NULL, kind TEXT NOT NULL,
      repeat TEXT NOT NULL, first_at TEXT NOT NULL, next_run_at TEXT,
      runs_done INTEGER NOT NULL DEFAULT 0, max_runs INTEGER NOT NULL,
      new_contact INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT)`);
    db.prepare(
      `INSERT INTO schedules (id, tenant_id, chat_id, kind, repeat, first_at, next_run_at,
         max_runs, new_contact, state, created_at)
       VALUES ('old', 't1', '51999@c.us', 'fixed', 'none', ?, ?, 1, 0, 'active', ?)`,
    ).run(base.firstAt, base.firstAt, "2026-11-19T10:00:00.000Z");
    const store = createSqliteScheduleStore(db);
    expect(store.get("t1", "old")?.followUpSince).toBeNull();
    const next = store.create({ ...base, followUpSince: "2026-11-20T10:00:00.000Z" });
    expect(store.get("t1", next.id)?.followUpSince).toBe("2026-11-20T10:00:00.000Z");
    // Opening it again does not add the column twice.
    expect(() => createSqliteScheduleStore(db)).not.toThrow();
  });

  it("due returns only active rows with a past next_run_at, oldest first, honouring limit", () => {
    const { store } = setup();
    const late = store.create({ ...base, nextRunAt: "2026-11-21T09:00:00.000Z" });
    const early = store.create({ ...base, nextRunAt: "2026-11-21T08:00:00.000Z" });
    store.create({ ...base, nextRunAt: "2026-11-22T08:00:00.000Z" }); // future
    store.create({ ...base, nextRunAt: null });
    const cancelled = store.create({ ...base, nextRunAt: "2026-11-21T07:00:00.000Z" });
    store.update(cancelled.id, { state: "cancelled" });
    const now = "2026-11-21T12:00:00.000Z";
    expect(store.due(now, 10).map((r) => r.id)).toEqual([early.id, late.id]);
    expect(store.due(now, 1).map((r) => r.id)).toEqual([early.id]);
  });

  it("due skips tenants that are not active and the excluded tenants", () => {
    const { store, addTenant } = setup();
    addTenant("t3", "revoked");
    addTenant("t4", "pairing");
    store.create({ ...base, tenantId: "t3", nextRunAt: "2026-11-21T07:00:00.000Z" });
    store.create({ ...base, tenantId: "t4", nextRunAt: "2026-11-21T07:00:00.000Z" });
    store.create({ ...base, tenantId: "t5", nextRunAt: "2026-11-21T07:00:00.000Z" }); // no tenant
    const excluded = store.create({
      ...base,
      tenantId: "t2",
      nextRunAt: "2026-11-21T07:30:00.000Z",
    });
    const ok = store.create({ ...base, nextRunAt: "2026-11-21T08:00:00.000Z" });
    const now = "2026-11-21T12:00:00.000Z";
    expect(store.due(now, 10).map((r) => r.id)).toEqual([excluded.id, ok.id]);
    expect(store.due(now, 10, ["t2"]).map((r) => r.id)).toEqual([ok.id]);
    expect(store.due(now, 10, ["t1", "t2"])).toEqual([]);
  });

  it("claimed returns active rows of active tenants whose run was claimed", () => {
    const { store, addTenant } = setup();
    addTenant("t3", "revoked");
    const stuck = store.create({ ...base, nextRunAt: null });
    store.create({ ...base, tenantId: "t3", nextRunAt: null });
    store.create(base); // waiting
    const cancelled = store.create(base);
    store.update(cancelled.id, { state: "cancelled", nextRunAt: null });
    expect(store.claimed().map((r) => r.id)).toEqual([stuck.id]);
  });

  it("listActive is newest first and excludes done and cancelled; countActive agrees", () => {
    const { store, setClock } = setup();
    const a = store.create(base);
    setClock("2026-11-20T11:00:00.000Z");
    const b = store.create(base);
    setClock("2026-11-20T12:00:00.000Z");
    const c = store.create(base);
    const d = store.create(base);
    store.create({ ...base, tenantId: "t2" });
    store.update(c.id, { state: "done", endedAt: "2026-11-20T12:30:00.000Z" });
    store.update(d.id, { state: "cancelled" });
    expect(store.listActive("t1").map((r) => r.id)).toEqual([b.id, a.id]);
    expect(store.countActive("t1")).toBe(2);
  });

  it("update patches only the given fields", () => {
    const { store } = setup();
    const row = store.create(base);
    store.update(row.id, { runsDone: 1, nextRunAt: null });
    store.update(row.id, {});
    expect(store.get("t1", row.id)).toMatchObject({
      runsDone: 1,
      nextRunAt: null,
      state: "active",
      chatId: base.chatId,
    });
  });

  it("countNewContactToday counts this tenant's new contacts created since day start", () => {
    const { store, setClock } = setup();
    setClock("2026-11-19T23:00:00.000Z");
    store.create({ ...base, newContact: true }); // yesterday
    setClock("2026-11-20T09:00:00.000Z");
    store.create({ ...base, newContact: true });
    store.create({ ...base, newContact: false });
    store.create({ ...base, tenantId: "t2", newContact: true });
    expect(store.countNewContactToday("t1", "2026-11-20T00:00:00.000Z")).toBe(1);
  });

  it("endedBefore and deleteSchedules prune ended schedules of one tenant", () => {
    const { store } = setup();
    const old = store.create(base);
    const recent = store.create(base);
    const active = store.create(base);
    store.update(old.id, { state: "done", endedAt: "2026-10-01T00:00:00.000Z" });
    store.update(recent.id, { state: "cancelled", endedAt: "2026-11-19T00:00:00.000Z" });
    const ids = store.endedBefore("t1", "2026-11-01T00:00:00.000Z");
    expect(ids).toEqual([old.id]);
    expect(store.endedBefore("t2", "2026-11-01T00:00:00.000Z")).toEqual([]);
    store.deleteSchedules("t2", ids);
    expect(store.get("t1", old.id)).not.toBeNull();
    store.deleteSchedules("t1", ids);
    expect(store.get("t1", old.id)).toBeNull();
    expect(store.get("t1", recent.id)).not.toBeNull();
    expect(store.get("t1", active.id)).not.toBeNull();
  });

  it("deleteForTenant leaves other tenants untouched", () => {
    const { store } = setup();
    store.create(base);
    const other = store.create({ ...base, tenantId: "t2" });
    store.deleteForTenant("t1");
    expect(store.listActive("t1")).toEqual([]);
    expect(store.get("t2", other.id)).toEqual(other);
  });
});
