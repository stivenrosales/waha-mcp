import type { DatabaseSync } from "node:sqlite";
import type { BillingRecord, BillingState, BillingStore } from "../../domain/ports/BillingStore.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenant_billing (
  tenant_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'past_due', 'suspended')),
  since INTEGER NOT NULL
);`;

interface Row {
  tenant_id: string;
  state: BillingState;
  since: number;
}

const toRecord = (r: Row): BillingRecord => ({
  tenantId: r.tenant_id,
  state: r.state,
  since: r.since,
});

/** Billing state per tenant, in the auth database next to the tenants table. */
export function createSqliteBillingStore(db: DatabaseSync): BillingStore {
  db.exec(SCHEMA);
  const get = db.prepare("SELECT tenant_id, state, since FROM tenant_billing WHERE tenant_id = ?");
  const upsert = db.prepare(
    `INSERT INTO tenant_billing (tenant_id, state, since) VALUES (?, ?, ?)
     ON CONFLICT (tenant_id) DO UPDATE SET state = excluded.state, since = excluded.since`,
  );
  const del = db.prepare("DELETE FROM tenant_billing WHERE tenant_id = ?");
  const all = db.prepare("SELECT tenant_id, state, since FROM tenant_billing ORDER BY since");
  return {
    get(tenantId) {
      const row = get.get(tenantId) as Row | undefined;
      return row ? toRecord(row) : null;
    },
    set(r) {
      upsert.run(r.tenantId, r.state, r.since);
    },
    remove(tenantId) {
      del.run(tenantId);
    },
    list() {
      return (all.all() as unknown as Row[]).map(toRecord);
    },
  };
}
