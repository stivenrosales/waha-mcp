import type { DatabaseSync } from "node:sqlite";
import type { EventStore, StoredEvent, WebhookEventKind } from "../../domain/ports/EventStore.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_sealed TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (tenant_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_pending ON webhook_events (done_at, id);
`;

interface Raw {
  id: number;
  tenant_id: string;
  event_id: string;
  kind: WebhookEventKind;
  received_at: string;
  payload_sealed: string;
}

/**
 * The WAHA webhook inbox in the auth database: one row per (tenant, WAHA event id), so a
 * redelivered event is a no-op. Payloads arrive already sealed with the tenant's cipher; a done
 * event keeps its row (for dedupe) but not its payload. The caller owns `db`.
 * @param now ISO clock for `done_at` (injectable for tests).
 */
export function createSqliteEventStore(
  db: DatabaseSync,
  now: () => string = () => new Date().toISOString(),
): EventStore {
  db.exec(SCHEMA);
  return {
    put(q) {
      const r = db
        .prepare(
          `INSERT INTO webhook_events (tenant_id, event_id, kind, received_at, payload_sealed)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, event_id) DO NOTHING`,
        )
        .run(q.tenantId, q.eventId, q.kind, q.receivedAt, q.payloadSealed);
      return Number(r.changes) === 1 ? "stored" : "duplicate";
    },
    pending(limit) {
      const rows = db
        .prepare(
          `SELECT id, tenant_id, event_id, kind, received_at, payload_sealed FROM webhook_events
           WHERE done_at IS NULL ORDER BY id LIMIT ?`,
        )
        .all(Math.max(0, Math.floor(limit))) as unknown as Raw[];
      return rows.map(
        (r): StoredEvent => ({
          id: Number(r.id),
          tenantId: r.tenant_id,
          eventId: r.event_id,
          kind: r.kind,
          receivedAt: r.received_at,
          payloadSealed: r.payload_sealed,
        }),
      );
    },
    markDone(id) {
      db.prepare(
        "UPDATE webhook_events SET done_at = ?, payload_sealed = '' WHERE id = ? AND done_at IS NULL",
      ).run(now(), id);
    },
  };
}
