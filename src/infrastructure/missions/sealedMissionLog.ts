import type { DatabaseSync } from "node:sqlite";
import type { TenantCipher } from "../crypto/envelope.js";

export type MissionLogKind =
  | "prompt"
  | "spec"
  | "message"
  | "notice"
  | "question"
  | "answer"
  | "summary"
  | "collected";

export interface MissionLogEntry {
  kind: MissionLogKind;
  /** ISO timestamp. */
  at: string;
  body: unknown;
}

/** Mission content of one tenant, sealed per entry in its `cache.db`. */
export interface MissionLog {
  append(missionId: string, entry: MissionLogEntry): void;
  read(missionId: string): MissionLogEntry[];
  /** Removes the content of the given missions (ids from `MissionStore.endedBefore`). */
  purgeMissions(missionIds: string[]): void;
  deleteAll(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_log (
  mission_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sealed TEXT NOT NULL,
  PRIMARY KEY (mission_id, seq)
);
`;

const aad = (missionId: string, seq: number): string => `mission:${missionId}:${seq}`;

export function createSealedMissionLog(db: DatabaseSync, cipher: TenantCipher): MissionLog {
  db.exec(SCHEMA);
  return {
    append(missionId, entry) {
      // seq is computed in the INSERT's own statement; sealing needs it first, so do both in one
      // immediate transaction.
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mission_log WHERE mission_id = ?")
          .get(missionId) as { n: number };
        const seq = Number(r.n);
        const sealed = cipher.sealText(
          JSON.stringify({ at: entry.at, body: entry.body }),
          aad(missionId, seq),
        );
        db.prepare(
          "INSERT INTO mission_log (mission_id, seq, kind, sealed) VALUES (?, ?, ?, ?)",
        ).run(missionId, seq, entry.kind, sealed);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    read(missionId) {
      const rows = db
        .prepare("SELECT seq, kind, sealed FROM mission_log WHERE mission_id = ? ORDER BY seq")
        .all(missionId) as unknown as { seq: number; kind: MissionLogKind; sealed: string }[];
      return rows.map((r) => {
        const { at, body } = JSON.parse(
          cipher.openText(r.sealed, aad(missionId, Number(r.seq))),
        ) as {
          at: string;
          body: unknown;
        };
        return { kind: r.kind, at, body };
      });
    },
    purgeMissions(missionIds) {
      const stmt = db.prepare("DELETE FROM mission_log WHERE mission_id = ?");
      for (const id of missionIds) stmt.run(id);
    },
    deleteAll() {
      db.exec("DELETE FROM mission_log");
    },
  };
}
