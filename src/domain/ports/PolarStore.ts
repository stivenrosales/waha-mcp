/** Which tenant each Polar subscription created, and which webhook deliveries were handled. */
export interface PolarStore {
  tenantFor(subscriptionId: string): string | null;
  link(q: { subscriptionId: string; tenantId: string; customerId: string }): void;
  /** True when the delivery with this `webhook-id` was already handled. */
  isProcessed(webhookId: string): boolean;
  markProcessed(webhookId: string, atMs: number): void;
  /** Drops delivery ids older than `beforeMs` (Polar stops retrying long before). */
  pruneProcessed(beforeMs: number): void;
}
