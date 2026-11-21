/** How many rows a retention prune or a self-service wipe removed. */
export interface CacheDataDeleted {
  /** Cached messages. */
  messages: number;
  /** Stored voice-note transcripts. */
  transcripts: number;
}

/**
 * One tenant's cached message data as a whole (its `cache.db`): cached messages and their
 * coverage, stored edits/deletions, reactions, poll votes, and voice-note transcripts. Mission
 * and schedule content are not part of it (they have their own retention).
 */
export interface CacheData {
  /**
   * Deletes what is older than `cutoffMs` (epoch ms): messages sent before it, edits, reactions
   * and votes from before it, transcripts stored before it. Coverage narrows accordingly.
   */
  pruneBefore(cutoffMs: number): CacheDataDeleted;
  /** Deletes all of it; the account the cache belongs to is kept. */
  wipe(): CacheDataDeleted;
}
