/**
 * Billing state of a paying tenant. Tenants without a record (the admin, self-hosted installs,
 * invited friends) are not billed and the billing lifecycle never touches them.
 */
export type BillingState = "active" | "past_due" | "suspended";

export interface BillingRecord {
  tenantId: string;
  state: BillingState;
  /** Epoch ms when the tenant entered `state`. */
  since: number;
}

export interface BillingStore {
  get(tenantId: string): BillingRecord | null;
  set(record: BillingRecord): void;
  remove(tenantId: string): void;
  list(): BillingRecord[];
}
