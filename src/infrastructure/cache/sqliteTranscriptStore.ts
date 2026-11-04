import type { DatabaseSync } from "node:sqlite";
import type { TranscriptStore } from "../../domain/ports/TranscriptStore.js";
import { isSealedText, type TenantCipher } from "../crypto/envelope.js";
import { readCacheOwner, resetCacheForOwner } from "./sqliteMessageStore.js";

/**
 * Transcripts in the `transcripts` table of `cache.db` (open it with `openCacheDatabase`). Used
 * even when the message cache is off. The database is closed by whoever opened it.
 */
export function createSqliteTranscriptStore(
  db: DatabaseSync,
  cipher: TenantCipher,
  now: () => number = Date.now,
): TranscriptStore {
  const select = db.prepare("SELECT text FROM transcripts WHERE chat_id = ? AND message_id = ?");
  const upsert = db.prepare(
    `INSERT INTO transcripts (chat_id, message_id, text, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (chat_id, message_id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
  );
  const aad = (chatId: string, messageId: string) =>
    `transcripts:${chatId.length}:${chatId}:${messageId}`;
  return {
    get(chatId, messageId) {
      const row = select.get(chatId, messageId) as { text: string } | undefined;
      if (!row) return null;
      // A value that is not sealed text predates encryption: read it as plaintext.
      return isSealedText(row.text) ? cipher.openText(row.text, aad(chatId, messageId)) : row.text;
    },
    put(chatId, messageId, text) {
      upsert.run(chatId, messageId, cipher.sealText(text, aad(chatId, messageId)), now());
    },
    getOwner: () => readCacheOwner(db),
    resetForOwner: (owner) => resetCacheForOwner(db, owner),
  };
}
