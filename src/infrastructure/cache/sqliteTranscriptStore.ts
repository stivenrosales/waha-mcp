import type { DatabaseSync } from "node:sqlite";
import { shortMessageId } from "../../domain/messageId.js";
import type { TranscriptStore } from "../../domain/ports/TranscriptStore.js";
import { isSealedText, type TenantCipher } from "../crypto/envelope.js";
import {
  readCacheOwner,
  resetCacheForOwner,
  shortIdPrefilter,
  transcriptAad,
} from "./sqliteMessageStore.js";

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
  const aad = transcriptAad;
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
    deleteByShortId(shortId) {
      const { sql, args } = shortIdPrefilter("message_id", shortId);
      const rows = db
        .prepare(`SELECT chat_id, message_id FROM transcripts WHERE ${sql}`)
        .all(...args) as { chat_id: string; message_id: string }[];
      const del = db.prepare("DELETE FROM transcripts WHERE chat_id = ? AND message_id = ?");
      for (const r of rows)
        if (shortMessageId(r.message_id) === shortId) del.run(r.chat_id, r.message_id);
    },
    getOwner: () => readCacheOwner(db),
    resetForOwner: (owner) => resetCacheForOwner(db, owner),
  };
}
