import type { DatabaseSync } from "node:sqlite";
import type { PolarStore } from "../../domain/ports/PolarStore.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS polar_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS polar_webhook_deliveries (
  webhook_id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);`;

/** Polar links and handled deliveries, in the auth database. */
export function createSqlitePolarStore(db: DatabaseSync): PolarStore {
  db.exec(SCHEMA);
  const tenantFor = db.prepare(
    "SELECT tenant_id FROM polar_subscriptions WHERE subscription_id = ?",
  );
  const link = db.prepare(
    `INSERT INTO polar_subscriptions (subscription_id, tenant_id, customer_id) VALUES (?, ?, ?)
     ON CONFLICT (subscription_id) DO UPDATE SET tenant_id = excluded.tenant_id`,
  );
  const processed = db.prepare("SELECT 1 FROM polar_webhook_deliveries WHERE webhook_id = ?");
  const mark = db.prepare(
    "INSERT OR IGNORE INTO polar_webhook_deliveries (webhook_id, processed_at) VALUES (?, ?)",
  );
  const prune = db.prepare("DELETE FROM polar_webhook_deliveries WHERE processed_at < ?");
  return {
    tenantFor(id) {
      const row = tenantFor.get(id) as { tenant_id: string } | undefined;
      return row?.tenant_id ?? null;
    },
    link(q) {
      link.run(q.subscriptionId, q.tenantId, q.customerId);
    },
    isProcessed(id) {
      return processed.get(id) !== undefined;
    },
    markProcessed(id, at) {
      mark.run(id, at);
    },
    pruneProcessed(before) {
      prune.run(before);
    },
  };
}
