import type { DatabaseSync } from "node:sqlite";
import type { ScheduleContent, ScheduleLog, ScheduleRun } from "../../domain/ports/ScheduleLog.js";
import type { TenantCipher } from "../crypto/envelope.js";

export type { ScheduleContent, ScheduleLog, ScheduleRun };

// `at` stays in plaintext (it is only a timestamp) so old runs can be purged without opening them.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedule_content (
  schedule_id TEXT PRIMARY KEY,
  sealed TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_runs (
  schedule_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  sealed TEXT NOT NULL,
  PRIMARY KEY (schedule_id, seq)
);
`;

const contentAad = (id: string): string => `schedule:${id}:content`;
const runAad = (id: string, seq: number): string => `schedule:${id}:${seq}`;

export function createSealedScheduleLog(db: DatabaseSync, cipher: TenantCipher): ScheduleLog {
  db.exec(SCHEMA);
  return {
    putContent(scheduleId, c) {
      db.prepare(
        `INSERT INTO schedule_content (schedule_id, sealed) VALUES (?, ?)
           ON CONFLICT (schedule_id) DO UPDATE SET sealed = excluded.sealed`,
      ).run(scheduleId, cipher.sealText(JSON.stringify(c), contentAad(scheduleId)));
    },
    content(scheduleId) {
      const r = db
        .prepare("SELECT sealed FROM schedule_content WHERE schedule_id = ?")
        .get(scheduleId) as { sealed: string } | undefined;
      return r
        ? (JSON.parse(cipher.openText(r.sealed, contentAad(scheduleId))) as ScheduleContent)
        : null;
    },
    appendRun(scheduleId, run) {
      // Sealing needs the seq, so compute it and insert in one immediate transaction.
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM schedule_runs WHERE schedule_id = ?")
          .get(scheduleId) as { n: number };
        const seq = Number(r.n);
        const { at, ...rest } = run;
        db.prepare(
          "INSERT INTO schedule_runs (schedule_id, seq, at, sealed) VALUES (?, ?, ?, ?)",
        ).run(scheduleId, seq, at, cipher.sealText(JSON.stringify(rest), runAad(scheduleId, seq)));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    runs(scheduleId, limit) {
      const rows = db
        .prepare(
          "SELECT seq, at, sealed FROM schedule_runs WHERE schedule_id = ? ORDER BY seq DESC LIMIT ?",
        )
        .all(scheduleId, limit) as unknown as { seq: number; at: string; sealed: string }[];
      return rows.map((r) => ({
        at: r.at,
        ...(JSON.parse(cipher.openText(r.sealed, runAad(scheduleId, Number(r.seq)))) as Omit<
          ScheduleRun,
          "at"
        >),
      }));
    },
    purgeRunsBefore(iso) {
      db.prepare("DELETE FROM schedule_runs WHERE at < ?").run(iso);
    },
    deleteSchedules(ids) {
      const content = db.prepare("DELETE FROM schedule_content WHERE schedule_id = ?");
      const runs = db.prepare("DELETE FROM schedule_runs WHERE schedule_id = ?");
      for (const id of ids) {
        content.run(id);
        runs.run(id);
      }
    },
  };
}
