import type { BillingStore } from "../domain/ports/BillingStore.js";
import type { SessionAdmin } from "../domain/ports/SessionAdmin.js";
import type { TenantStore } from "../domain/ports/TenantStore.js";
import type { TenantAdmin } from "./tenantAdmin.js";

const DAY_MS = 86_400_000;
/** After a failed payment the tenant keeps working this long. */
export const GRACE_MS = 3 * DAY_MS;
/** A suspended tenant and its data are deleted this long after the suspension. */
export const SUSPENDED_DELETE_MS = 30 * DAY_MS;
/** How often the worker applies the time-based steps. */
export const BILLING_SWEEP_INTERVAL_MS = 60 * 60_000;

export interface BillingDeps {
  store: BillingStore;
  tenants: Pick<TenantStore, "getTenant" | "getAdmin">;
  admin: Pick<TenantAdmin, "revoke" | "restore" | "purge">;
  sessions: Pick<SessionAdmin, "logout">;
  logger: { info(message: string): void };
  now?: () => number;
}

export interface Billing {
  /** A payment went through: the tenant is billed and in good standing (restored if suspended). */
  paymentSucceeded(tenantId: string): void;
  /** A payment failed: a billed tenant enters the grace period (once; later failures keep it). */
  paymentFailed(tenantId: string): void;
  /** Access ended (subscription canceled or unpaid): suspend now, delete 30 days later. */
  endAccess(tenantId: string): Promise<void>;
  /** Suspends tenants past the grace and deletes those suspended for too long. */
  sweep(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
}

/**
 * What happens to a paying tenant when payments fail: 3 days of grace, then WhatsApp is logged
 * out and the tenant revoked (tools, logins, missions and schedules stop), then after 30 days
 * the tenant and its data are deleted. Tenants with no billing record are never touched.
 */
export function createBilling(deps: BillingDeps): Billing {
  const { store, tenants, admin, sessions, logger } = deps;
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  const isAdmin = (tenantId: string) => tenants.getAdmin()?.tenantId === tenantId;

  async function suspend(tenantId: string, wahaSession: string): Promise<void> {
    let whatsapp: "logged_out" | "failed" = "logged_out";
    try {
      await sessions.logout(wahaSession);
    } catch {
      whatsapp = "failed";
    }
    // A payment may have arrived while WAHA answered: then the tenant stays (it re-pairs at /pair).
    if (store.get(tenantId)?.state !== "past_due") {
      logger.info(`billing suspend tenant=${tenantId} whatsapp=${whatsapp} outcome=skipped_paid`);
      return;
    }
    let outcome = "error";
    try {
      admin.revoke(tenantId);
      store.set({ tenantId, state: "suspended", since: now() });
      outcome = "ok";
    } finally {
      logger.info(`billing suspend tenant=${tenantId} whatsapp=${whatsapp} outcome=${outcome}`);
    }
  }

  async function remove(tenantId: string): Promise<void> {
    let outcome = "error";
    try {
      const result = await admin.purge(tenantId);
      store.remove(tenantId);
      outcome = result.whatsappCleanup === "ok" && result.localCleanup === "ok" ? "ok" : "partial";
    } finally {
      logger.info(`billing delete tenant=${tenantId} outcome=${outcome}`);
    }
  }

  async function sweep(): Promise<void> {
    for (const record of store.list()) {
      const tenant = tenants.getTenant(record.tenantId);
      if (!tenant) {
        store.remove(record.tenantId);
        continue;
      }
      const age = now() - record.since;
      try {
        if (record.state === "past_due" && age >= GRACE_MS)
          await suspend(tenant.id, tenant.wahaSession);
        else if (record.state === "suspended" && tenant.status !== "revoked") {
          // The admin restored it by hand: it is no longer suspended, so it must not be deleted.
          store.set({ tenantId: tenant.id, state: "active", since: now() });
          logger.info(`billing restored_by_admin tenant=${tenant.id}`);
        } else if (
          record.state === "suspended" &&
          age >= SUSPENDED_DELETE_MS &&
          store.get(tenant.id)?.state === "suspended"
        )
          await remove(tenant.id);
      } catch {
        // Logged by the step; the next sweep tries again.
      }
    }
  }

  return {
    paymentSucceeded(tenantId) {
      if (isAdmin(tenantId) || !tenants.getTenant(tenantId)) return;
      const record = store.get(tenantId);
      if (record?.state === "suspended" && tenants.getTenant(tenantId)?.status === "revoked")
        admin.restore(tenantId);
      if (record?.state !== "active") store.set({ tenantId, state: "active", since: now() });
      if (record?.state === "suspended") logger.info(`billing restore tenant=${tenantId}`);
    },
    paymentFailed(tenantId) {
      if (isAdmin(tenantId) || !tenants.getTenant(tenantId)) return;
      const record = store.get(tenantId);
      if (record && record.state !== "active") return;
      store.set({ tenantId, state: "past_due", since: now() });
      logger.info(`billing past_due tenant=${tenantId}`);
    },
    async endAccess(tenantId) {
      const tenant = tenants.getTenant(tenantId);
      if (!tenant || isAdmin(tenantId) || store.get(tenantId)?.state === "suspended") return;
      // Past the grace already, so `suspend` sees the state it expects.
      store.set({ tenantId, state: "past_due", since: now() - GRACE_MS });
      await suspend(tenant.id, tenant.wahaSession);
    },
    sweep() {
      // One sweep at a time: an hourly tick never overlaps a slow WAHA logout.
      running ??= sweep().finally(() => {
        running = null;
      });
      return running;
    },
    start(intervalMs = BILLING_SWEEP_INTERVAL_MS) {
      if (timer) return;
      void this.sweep();
      timer = setInterval(() => void this.sweep(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
