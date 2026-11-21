import type { DatabaseSync } from "node:sqlite";
import type { CacheData } from "../../domain/ports/CacheData.js";
import type { TenantCipher } from "../crypto/envelope.js";
import {
  createSqliteMessageStore,
  inTransaction,
  wipeCachedContent,
} from "./sqliteMessageStore.js";

/**
 * Retention and self-service deletion over one tenant's `cache.db` (opened with
 * `openCacheDatabase`). Works whether the message cache is on or off: transcripts, and rows left
 * from a period with the cache on, live in the same file. The database is closed by its opener.
 */
export function createCacheData(db: DatabaseSync, cipher: TenantCipher): CacheData {
  const messages = createSqliteMessageStore(db, cipher);
  return {
    pruneBefore(cutoffMs) {
      // Messages, edits, reactions and votes in the store's own transaction, then transcripts.
      const deleted = messages.prune(Math.floor(cutoffMs / 1000));
      const transcripts = db.prepare("DELETE FROM transcripts WHERE created_at < ?").run(cutoffMs);
      return { messages: deleted, transcripts: Number(transcripts.changes) };
    },
    wipe() {
      return inTransaction(db, () => wipeCachedContent(db));
    },
  };
}
