import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ScheduleRow, ScheduleStore } from "../../domain/ports/ScheduleStore.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  repeat TEXT NOT NULL,
  first_at TEXT NOT NULL,
  next_run_at TEXT,
  runs_done INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER NOT NULL,
  new_contact INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS schedules_tenant ON schedules (tenant_id, state);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (state, next_run_at);
`;

interface Raw {
  id: string;
  tenant_id: string;
  chat_id: string;
  kind: ScheduleRow["kind"];
  repeat: ScheduleRow["repeat"];
  first_at: string;
  next_run_at: string | null;
  runs_done: number;
  max_runs: number;
  new_contact: number;
  state: ScheduleRow["state"];
  created_at: string;
  ended_at: string | null;
}

const toRow = (r: Raw): ScheduleRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  chatId: r.chat_id,
  kind: r.kind,
  repeat: r.repeat,
  firstAt: r.first_at,
  nextRunAt: r.next_run_at,
  runsDone: Number(r.runs_done),
  maxRuns: Number(r.max_runs),
  newContact: r.new_contact === 1,
  state: r.state,
  createdAt: r.created_at,
  endedAt: r.ended_at,
});

/** Patchable field -> column. */
const COLUMNS: Record<string, string> = {
  nextRunAt: "next_run_at",
  runsDone: "runs_done",
  state: "state",
  endedAt: "ended_at",
};

const newId = (): string => randomBytes(9).toString("base64url");

/**
 * Schedule metadata in the auth database (message text and run history live sealed in the
 * tenant's cache database, see `createSealedScheduleLog`). The caller owns `db`, which must
 * also hold the `tenants` table (`createSqliteTenantStore`): due runs skip inactive tenants.
 * @param now ISO clock (injectable for tests).
 */
export function createSqliteScheduleStore(
  db: DatabaseSync,
  now: () => string = () => new Date().toISOString(),
): ScheduleStore {
  db.exec(SCHEMA);
  const all = (sql: string, ...args: (string | number)[]): ScheduleRow[] =>
    (db.prepare(sql).all(...args) as unknown as Raw[]).map(toRow);

  return {
    create(q) {
      const id = newId();
      db.prepare(
        `INSERT INTO schedules (id, tenant_id, chat_id, kind, repeat, first_at, next_run_at,
           max_runs, new_contact, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        id,
        q.tenantId,
        q.chatId,
        q.kind,
        q.repeat,
        q.firstAt,
        q.nextRunAt,
        q.maxRuns,
        q.newContact ? 1 : 0,
        now(),
      );
      return this.get(q.tenantId, id) as ScheduleRow;
    },
    get(tenantId, id) {
      const r = db
        .prepare("SELECT * FROM schedules WHERE tenant_id = ? AND id = ?")
        .get(tenantId, id);
      return r ? toRow(r as unknown as Raw) : null;
    },
    listActive(tenantId) {
      return all(
        "SELECT * FROM schedules WHERE tenant_id = ? AND state = 'active' ORDER BY created_at DESC, rowid DESC",
        tenantId,
      );
    },
    countActive(tenantId) {
      const r = db
        .prepare("SELECT COUNT(*) AS n FROM schedules WHERE tenant_id = ? AND state = 'active'")
        .get(tenantId) as { n: number };
      return Number(r.n);
    },
    due(nowIso, limit, excludeTenantIds = []) {
      const excluded = excludeTenantIds.map(() => "?").join(", ");
      return all(
        `SELECT s.* FROM schedules s JOIN tenants t ON t.id = s.tenant_id
         WHERE s.state = 'active' AND t.status = 'active' AND s.next_run_at IS NOT NULL
           AND s.next_run_at <= ?${excluded ? ` AND s.tenant_id NOT IN (${excluded})` : ""}
         ORDER BY s.next_run_at LIMIT ?`,
        nowIso,
        ...excludeTenantIds,
        limit,
      );
    },
    claimed() {
      return all(
        `SELECT s.* FROM schedules s JOIN tenants t ON t.id = s.tenant_id
         WHERE s.state = 'active' AND t.status = 'active' AND s.next_run_at IS NULL
         ORDER BY s.created_at, s.rowid`,
      );
    },
    update(id, patch) {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const col = COLUMNS[key];
        if (!col || value === undefined) continue;
        sets.push(`${col} = ?`);
        args.push(value as string | number | null);
      }
      if (sets.length === 0) return;
      db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    },
    countNewContactToday(tenantId, dayStartIso) {
      const r = db
        .prepare(
          "SELECT COUNT(*) AS n FROM schedules WHERE tenant_id = ? AND new_contact = 1 AND created_at >= ?",
        )
        .get(tenantId, dayStartIso) as { n: number };
      return Number(r.n);
    },
    endedBefore(tenantId, iso) {
      return (
        db
          .prepare(
            "SELECT id FROM schedules WHERE tenant_id = ? AND ended_at IS NOT NULL AND ended_at < ?",
          )
          .all(tenantId, iso) as unknown as { id: string }[]
      ).map((r) => r.id);
    },
    deleteSchedules(tenantId, ids) {
      const stmt = db.prepare("DELETE FROM schedules WHERE tenant_id = ? AND id = ?");
      for (const id of ids) stmt.run(tenantId, id);
    },
    deleteForTenant(tenantId) {
      db.prepare("DELETE FROM schedules WHERE tenant_id = ?").run(tenantId);
    },
  };
}
