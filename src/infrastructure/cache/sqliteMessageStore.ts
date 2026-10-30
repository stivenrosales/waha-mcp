import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatSyncState,
  MessageStore,
  RawMessageRow,
} from "../../domain/ports/MessageStore.js";

/**
 * `cache.db` schema. Other cache tables (e.g. voice-note transcripts keyed by chat id and
 * message id) can live in the same file: add them here and open stores on the same database.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  chat_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_id, ts);
CREATE TABLE IF NOT EXISTS chat_sync (
  chat_id TEXT PRIMARY KEY,
  newest_ts INTEGER,
  oldest_ts INTEGER,
  last_sync_at INTEGER NOT NULL
);
`;

/**
 * Opens (creating if needed) the message cache database: WAL, 5 s busy timeout, and the
 * file plus its WAL side files readable only by the owner (they hold conversations).
 */
export function openCacheDatabase(dbPath: string): DatabaseSync {
  const onDisk = dbPath !== ":memory:";
  if (onDisk) {
    // Create the file 0600 before SQLite does; SQLite gives -wal/-shm the same mode.
    closeSync(openSync(dbPath, "a", 0o600));
    chmodSync(dbPath, 0o600);
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  if (onDisk)
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
      if (existsSync(file)) chmodSync(file, 0o600);
  return db;
}

/** Builds the WHERE clause shared by reads and counts. */
function rangeWhere(q: { fromTs?: number; toTs?: number }): { sql: string; args: number[] } {
  let sql = "chat_id = ?";
  const args: number[] = [];
  if (q.fromTs !== undefined) {
    sql += " AND ts >= ?";
    args.push(q.fromTs);
  }
  if (q.toTs !== undefined) {
    sql += " AND ts <= ?";
    args.push(q.toTs);
  }
  return { sql, args };
}

export function createSqliteMessageStore(db: DatabaseSync): MessageStore {
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  // ON CONFLICT ... DO UPDATE keeps the rowid, which orders messages that share a second
  // in the order WAHA returned them.
  const upsert = db.prepare(
    `INSERT INTO messages (chat_id, id, ts, raw) VALUES (?, ?, ?, ?)
     ON CONFLICT (chat_id, id) DO UPDATE SET ts = excluded.ts, raw = excluded.raw`,
  );

  return {
    upsertRaw(chatId, rows: RawMessageRow[]) {
      if (rows.length === 0) return;
      transaction(() => {
        for (const r of rows) upsert.run(chatId, r.id, r.ts, JSON.stringify(r.raw));
      });
    },

    readRange(chatId, q) {
      const { sql, args } = rangeWhere(q);
      const rows = db
        .prepare(
          `SELECT raw FROM messages WHERE ${sql} ORDER BY ts DESC, rowid ASC LIMIT ? OFFSET ?`,
        )
        .all(chatId, ...args, q.limit, q.offset) as { raw: string }[];
      return rows.map((r) => JSON.parse(r.raw) as unknown);
    },

    countRange(chatId, q) {
      const { sql, args } = rangeWhere(q);
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${sql}`)
        .get(chatId, ...args) as { n: number };
      return Number(row.n);
    },

    deleteMissing(chatId, fromTs, keepIds) {
      const { sql, args } = rangeWhere({ fromTs });
      const result = db
        .prepare(`DELETE FROM messages WHERE ${sql} AND id NOT IN (SELECT value FROM json_each(?))`)
        .run(chatId, ...args, JSON.stringify(keepIds));
      return Number(result.changes);
    },

    getSyncState(chatId) {
      const row = db
        .prepare("SELECT newest_ts, oldest_ts, last_sync_at FROM chat_sync WHERE chat_id = ?")
        .get(chatId) as
        | { newest_ts: number | null; oldest_ts: number | null; last_sync_at: number }
        | undefined;
      if (!row) return null;
      return {
        newestTs: row.newest_ts === null ? null : Number(row.newest_ts),
        oldestTs: row.oldest_ts === null ? null : Number(row.oldest_ts),
        lastSyncAt: Number(row.last_sync_at),
      } satisfies ChatSyncState;
    },

    setSyncState(chatId, s) {
      db.prepare(
        `INSERT INTO chat_sync (chat_id, newest_ts, oldest_ts, last_sync_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET newest_ts = excluded.newest_ts,
           oldest_ts = excluded.oldest_ts, last_sync_at = excluded.last_sync_at`,
      ).run(chatId, s.newestTs, s.oldestTs, s.lastSyncAt);
    },

    prune(olderThanTs) {
      return transaction(() => {
        // The pruned span is no longer covered: a later read of it goes back to WAHA.
        db.prepare(
          "UPDATE chat_sync SET oldest_ts = ? WHERE oldest_ts IS NULL OR oldest_ts < ?",
        ).run(olderThanTs, olderThanTs);
        const result = db.prepare("DELETE FROM messages WHERE ts < ?").run(olderThanTs);
        return Number(result.changes);
      });
    },

    close() {
      db.close();
    },
  };
}
