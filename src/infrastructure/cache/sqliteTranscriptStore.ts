import type { DatabaseSync } from "node:sqlite";
import type { TranscriptStore } from "../../domain/ports/TranscriptStore.js";
import { readCacheOwner, resetCacheForOwner } from "./sqliteMessageStore.js";

/**
 * Transcripts in the `transcripts` table of `cache.db` (open it with `openCacheDatabase`). Used
 * even when the message cache is off. The database is closed by whoever opened it.
 */
export function createSqliteTranscriptStore(
  db: DatabaseSync,
  now: () => number = Date.now,
): TranscriptStore {
  const select = db.prepare("SELECT text FROM transcripts WHERE chat_id = ? AND message_id = ?");
  const upsert = db.prepare(
    `INSERT INTO transcripts (chat_id, message_id, text, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (chat_id, message_id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
  );
  return {
    get(chatId, messageId) {
      const row = select.get(chatId, messageId) as { text: string } | undefined;
      return row?.text ?? null;
    },
    put(chatId, messageId, text) {
      upsert.run(chatId, messageId, text, now());
    },
    getOwner: () => readCacheOwner(db),
    resetForOwner: (owner) => resetCacheForOwner(db, owner),
  };
}
