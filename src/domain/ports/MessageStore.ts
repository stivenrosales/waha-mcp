/** One raw engine payload, keyed by its WAHA message id, with its timestamp in unix seconds. */
export interface RawMessageRow {
  id: string;
  ts: number;
  raw: unknown;
}

/**
 * What the cache can prove about one chat: it holds every message WAHA had with
 * `ts >= oldestTs` (`null` = from the very first message) as of `lastSyncAt`.
 */
export interface ChatSyncState {
  /** Newest message timestamp seen (unix s); null when the chat had no messages. */
  newestTs: number | null;
  /** Inclusive lower bound of the covered range (unix s); null = the whole history. */
  oldestTs: number | null;
  /** When the head (newest messages) was last synced with WAHA, epoch milliseconds. */
  lastSyncAt: number;
}

/** Local copy of raw chat messages. Reads are NEWEST FIRST, like WAHA. */
export interface MessageStore {
  /** Inserts or replaces (edits, revokes) the raw payloads. */
  upsertRaw(chatId: string, rows: RawMessageRow[]): void;
  /** Raw payloads with `fromTs <= ts <= toTs`, newest first. */
  readRange(
    chatId: string,
    q: { fromTs?: number; toTs?: number; limit: number; offset: number },
  ): unknown[];
  countRange(chatId: string, q: { fromTs?: number; toTs?: number }): number;
  /** Deletes the chat's messages with `ts >= fromTs` whose id is not in `keepIds`. */
  deleteMissing(chatId: string, fromTs: number | undefined, keepIds: string[]): number;
  getSyncState(chatId: string): ChatSyncState | null;
  setSyncState(chatId: string, state: ChatSyncState): void;
  /** The account the cached rows belong to (`<session>|<me.id>`); null when never recorded. */
  getOwner(): string | null;
  /** Wipes every cached message and sync state, then records `owner`. */
  resetForOwner(owner: string): void;
  /** Deletes messages older than `olderThanTs` and narrows coverage accordingly; returns rows deleted. */
  prune(olderThanTs: number): number;
  close(): void;
}
