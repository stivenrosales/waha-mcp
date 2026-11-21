/** Events the mission engine consumes: `message.any` (stored as `message`) and `session.status`. */
export type MissionEventKind = "message" | "session.status";
/** Events that keep the message cache in sync; values are WAHA's event names. */
export type CacheEventKind =
  | "message.edited"
  | "message.revoked"
  | "message.reaction"
  | "poll.vote"
  | "poll.vote.failed";
/** What a stored WAHA webhook event is about. */
export type WebhookEventKind = MissionEventKind | CacheEventKind;

export const MISSION_EVENT_KINDS: readonly MissionEventKind[] = ["message", "session.status"];
export const CACHE_EVENT_KINDS: readonly CacheEventKind[] = [
  "message.edited",
  "message.revoked",
  "message.reaction",
  "poll.vote",
  "poll.vote.failed",
];

/** One received webhook event waiting for (or already handled by) the mission engine. */
export interface StoredEvent {
  /** Store-assigned, increasing in arrival order. */
  id: number;
  tenantId: string;
  /** WAHA's envelope id (`evt_…`), unique per tenant. */
  eventId: string;
  kind: WebhookEventKind;
  /** ISO instant the server received it. */
  receivedAt: string;
  /** The raw webhook body, sealed with the tenant's cipher (AAD `webhook:<tenantId>:<eventId>`). */
  payloadSealed: string;
}

/** Durable inbox of WAHA webhook events (the mission engine consumes it). */
export interface EventStore {
  /** "duplicate" (and no change) when this tenant already has an event with this id. */
  put(q: Omit<StoredEvent, "id">): "stored" | "duplicate";
  /** Events not yet marked done, oldest first; only the given kinds, or every kind when omitted. */
  pending(limit: number, kinds?: readonly WebhookEventKind[]): StoredEvent[];
  /** Marks the event handled and drops its sealed payload; the id is kept for dedupe. */
  markDone(id: number): void;
  /**
   * Deletes events received before `beforeIso`, done or not (retention: past it a redelivery is
   * no longer deduped). Returns how many were deleted.
   */
  prune(beforeIso: string): number;
  /** Deletes every event of the tenant (tenant deletion). */
  deleteForTenant(tenantId: string): void;
}
