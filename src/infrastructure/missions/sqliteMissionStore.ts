import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MissionRow, MissionStore } from "../../domain/ports/MissionStore.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  state TEXT NOT NULL,
  stop_reason TEXT,
  new_contact INTEGER NOT NULL,
  deadline_at TEXT NOT NULL,
  next_wake_at TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  last_agent_at TEXT,
  last_inbound_at TEXT,
  closing_message TEXT,
  expects_files INTEGER NOT NULL DEFAULT 0,
  notice_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS missions_tenant ON missions (tenant_id, state);
CREATE INDEX IF NOT EXISTS missions_due ON missions (state, next_wake_at);
CREATE TABLE IF NOT EXISTS mission_pauses (
  tenant_id TEXT PRIMARY KEY,
  since TEXT NOT NULL
);
`;

interface Raw {
  id: string;
  tenant_id: string;
  chat_id: string;
  state: MissionRow["state"];
  stop_reason: MissionRow["stopReason"];
  new_contact: number;
  deadline_at: string;
  next_wake_at: string | null;
  created_at: string;
  ended_at: string | null;
  sent_count: number;
  reminder_count: number;
  llm_calls: number;
  last_agent_at: string | null;
  last_inbound_at: string | null;
  closing_message: string | null;
  expects_files: number;
  notice_seen: number;
}

const toRow = (r: Raw): MissionRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  chatId: r.chat_id,
  state: r.state,
  stopReason: r.stop_reason,
  newContact: r.new_contact === 1,
  deadlineAt: r.deadline_at,
  nextWakeAt: r.next_wake_at,
  createdAt: r.created_at,
  endedAt: r.ended_at,
  sentCount: Number(r.sent_count),
  reminderCount: Number(r.reminder_count),
  llmCalls: Number(r.llm_calls),
  lastAgentAt: r.last_agent_at,
  lastInboundAt: r.last_inbound_at,
  closingMessage: r.closing_message,
  expectsFiles: r.expects_files === 1,
  noticeSeen: r.notice_seen === 1,
});

/** Patchable field -> column. Booleans are stored as 0/1. */
const COLUMNS: Record<string, { col: string; bool?: true }> = {
  chatId: { col: "chat_id" },
  state: { col: "state" },
  stopReason: { col: "stop_reason" },
  newContact: { col: "new_contact", bool: true },
  deadlineAt: { col: "deadline_at" },
  nextWakeAt: { col: "next_wake_at" },
  createdAt: { col: "created_at" },
  endedAt: { col: "ended_at" },
  sentCount: { col: "sent_count" },
  reminderCount: { col: "reminder_count" },
  llmCalls: { col: "llm_calls" },
  lastAgentAt: { col: "last_agent_at" },
  lastInboundAt: { col: "last_inbound_at" },
  closingMessage: { col: "closing_message" },
  expectsFiles: { col: "expects_files", bool: true },
  noticeSeen: { col: "notice_seen", bool: true },
};

const newId = (): string => randomBytes(16).toString("base64url");

/**
 * Mission metadata in the auth database (the content lives sealed in the tenant's cache
 * database, see `createSealedMissionLog`). The caller owns `db`.
 * @param now ISO clock (injectable for tests).
 */
export function createSqliteMissionStore(
  db: DatabaseSync,
  now: () => string = () => new Date().toISOString(),
): MissionStore {
  db.exec(SCHEMA);
  const all = (sql: string, ...args: (string | number)[]): MissionRow[] =>
    (db.prepare(sql).all(...args) as unknown as Raw[]).map(toRow);

  return {
    create(q) {
      const id = newId();
      db.prepare(
        `INSERT INTO missions (id, tenant_id, chat_id, state, new_contact, deadline_at,
           next_wake_at, created_at, closing_message, expects_files)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        q.tenantId,
        q.chatId,
        q.newContact ? 1 : 0,
        q.deadlineAt,
        q.nextWakeAt ?? null,
        now(),
        q.closingMessage ?? null,
        q.expectsFiles ? 1 : 0,
      );
      return this.get(q.tenantId, id) as MissionRow;
    },
    get(tenantId, id) {
      const r = db
        .prepare("SELECT * FROM missions WHERE tenant_id = ? AND id = ?")
        .get(tenantId, id);
      return r ? toRow(r as unknown as Raw) : null;
    },
    list(tenantId, state) {
      return state
        ? all(
            "SELECT * FROM missions WHERE tenant_id = ? AND state = ? ORDER BY created_at DESC",
            tenantId,
            state,
          )
        : all("SELECT * FROM missions WHERE tenant_id = ? ORDER BY created_at DESC", tenantId);
    },
    update(id, patch) {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const spec = COLUMNS[key];
        if (!spec || value === undefined) continue;
        sets.push(`${spec.col} = ?`);
        args.push(spec.bool ? (value ? 1 : 0) : (value as string | number | null));
      }
      if (sets.length === 0) return;
      db.prepare(`UPDATE missions SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    },
    due(nowIso) {
      return all(
        `SELECT * FROM missions WHERE state = 'active' AND next_wake_at IS NOT NULL
           AND next_wake_at <= ? ORDER BY next_wake_at`,
        nowIso,
      );
    },
    countActive(tenantId) {
      const r = db
        .prepare("SELECT COUNT(*) AS n FROM missions WHERE tenant_id = ? AND state = 'active'")
        .get(tenantId) as { n: number };
      return Number(r.n);
    },
    countNewContactToday(tenantId, dayStartIso) {
      const r = db
        .prepare(
          "SELECT COUNT(*) AS n FROM missions WHERE tenant_id = ? AND new_contact = 1 AND created_at >= ?",
        )
        .get(tenantId, dayStartIso) as { n: number };
      return Number(r.n);
    },
    unseenOutcomes(tenantId) {
      return all(
        "SELECT * FROM missions WHERE tenant_id = ? AND state != 'active' AND notice_seen = 0 ORDER BY ended_at",
        tenantId,
      );
    },
    markSeen(ids) {
      const stmt = db.prepare("UPDATE missions SET notice_seen = 1 WHERE id = ?");
      for (const id of ids) stmt.run(id);
    },
    endedBefore(tenantId, iso) {
      return (
        db
          .prepare(
            "SELECT id FROM missions WHERE tenant_id = ? AND ended_at IS NOT NULL AND ended_at < ?",
          )
          .all(tenantId, iso) as unknown as { id: string }[]
      ).map((r) => r.id);
    },
    dueClosings(nowIso) {
      return all(
        `SELECT * FROM missions WHERE state != 'active' AND next_wake_at IS NOT NULL
           AND next_wake_at <= ? ORDER BY next_wake_at`,
        nowIso,
      );
    },
    setPaused(tenantId, paused, atIso) {
      if (paused)
        db.prepare(
          "INSERT INTO mission_pauses (tenant_id, since) VALUES (?, ?) ON CONFLICT (tenant_id) DO NOTHING",
        ).run(tenantId, atIso);
      else db.prepare("DELETE FROM mission_pauses WHERE tenant_id = ?").run(tenantId);
    },
    pausedTenants() {
      return (
        db.prepare("SELECT tenant_id FROM mission_pauses").all() as unknown as {
          tenant_id: string;
        }[]
      ).map((r) => r.tenant_id);
    },
    deleteForTenant(tenantId) {
      db.prepare("DELETE FROM missions WHERE tenant_id = ?").run(tenantId);
      db.prepare("DELETE FROM mission_pauses WHERE tenant_id = ?").run(tenantId);
    },
  };
}
