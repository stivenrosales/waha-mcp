import type { EmailSender } from "../domain/ports/EmailSender.js";
import type { PolarStore } from "../domain/ports/PolarStore.js";
import type { Billing } from "./billing.js";
import type { TenantAdmin } from "./tenantAdmin.js";

export type PolarStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"
  | "trial_ended";

/** The parts of a Polar subscription this server acts on. */
export interface PolarSubscription {
  id: string;
  status: PolarStatus;
  customerId: string;
  customerEmail: string;
}

const GOOD: ReadonlySet<PolarStatus> = new Set(["trialing", "active"]);
const ENDED: ReadonlySet<PolarStatus> = new Set([
  "canceled",
  "unpaid",
  "incomplete_expired",
  "trial_ended",
]);

export interface PolarSyncDeps {
  /** Current state from the Polar API: events can arrive out of order, so they are not trusted. */
  fetchSubscription(id: string): Promise<PolarSubscription>;
  store: Pick<PolarStore, "tenantFor" | "tenantForCustomer" | "link">;
  billing: Pick<Billing, "paymentSucceeded" | "paymentFailed" | "endAccess">;
  /** Creates the customer's account and emails the invite; returns the tenant id. */
  provision(q: { email: string }): Promise<string>;
  users: {
    tenantExists(tenantId: string): boolean;
    emailOfTenant(tenantId: string): string | null;
    setTenantEmail(tenantId: string, email: string): "ok" | "taken";
  };
  logger: { info(message: string): void };
}

export interface PolarSync {
  /** Applies the subscription's current Polar state to its account. */
  handle(subscriptionId: string): Promise<void>;
}

/**
 * Maps a Polar subscription to the billing lifecycle: `trialing`/`active` keep the account in
 * good standing (creating it the first time), `past_due` starts the grace period, and the ended
 * states end access now. Unknown subscriptions in a bad state never create an account.
 */
export function createPolarSync(deps: PolarSyncDeps): PolarSync {
  const { store, billing, logger } = deps;
  return {
    async handle(subscriptionId) {
      const sub = await deps.fetchSubscription(subscriptionId);
      const existing = (id: string | null) => (id && deps.users.tenantExists(id) ? id : null);
      let tenantId = existing(store.tenantFor(sub.id));
      const email = sub.customerEmail.trim().toLowerCase();
      if (GOOD.has(sub.status)) {
        if (!tenantId) {
          // A returning customer (new subscription after a cancel) gets their account back.
          tenantId = existing(store.tenantForCustomer(sub.customerId));
          if (!tenantId) {
            tenantId = await deps.provision({ email });
            logger.info(`polar provision subscription=${sub.id} tenant=${tenantId}`);
          }
          store.link({ subscriptionId: sub.id, tenantId, customerId: sub.customerId });
        }
        billing.paymentSucceeded(tenantId);
        // The account's user gets the customer's email for recovery, unless they chose one.
        if (
          email &&
          deps.users.emailOfTenant(tenantId) === null &&
          deps.users.setTenantEmail(tenantId, email) === "taken"
        )
          logger.info(`polar email not set tenant=${tenantId} reason=taken`);
        return;
      }
      if (!tenantId) {
        logger.info(`polar ignore subscription=${sub.id} status=${sub.status} reason=no_account`);
        return;
      }
      if (sub.status === "past_due") billing.paymentFailed(tenantId);
      else if (ENDED.has(sub.status)) await billing.endAccess(tenantId);
      else logger.info(`polar ignore subscription=${sub.id} status=${sub.status}`);
    },
  };
}

/** More new accounts than this per hour are refused, so a flood of checkouts cannot mint sessions. */
export const MAX_PROVISIONS_PER_HOUR = 20;

export class ProvisionCapError extends Error {
  constructor() {
    super("Too many new accounts this hour; Polar will redeliver the event.");
    this.name = "ProvisionCapError";
  }
}

export function createProvisioner(deps: {
  admin: Pick<TenantAdmin, "createInvite">;
  email: EmailSender;
  logger: { info(message: string): void };
  now?: () => number;
  maxPerHour?: number;
}): (q: { email: string }) => Promise<string> {
  const now = deps.now ?? Date.now;
  const max = deps.maxPerHour ?? MAX_PROVISIONS_PER_HOUR;
  const recent: number[] = [];
  return async ({ email }) => {
    const t = now();
    while (recent.length && (recent[0] as number) <= t - 3_600_000) recent.shift();
    if (recent.length >= max) throw new ProvisionCapError();
    const invite = await deps.admin.createInvite({ displayName: email });
    // Counted only once the account exists: failed attempts (WAHA down) do not spend the cap.
    recent.push(t);
    try {
      await deps.email.send(inviteEmail(email, invite.url));
    } catch {
      // The account exists; the admin can resend the invite (create_invite with its tenant id).
      deps.logger.info(`polar invite email failed tenant=${invite.tenantId}`);
    }
    return invite.tenantId;
  };
}

function inviteEmail(to: string, url: string) {
  const text = `¡Gracias por suscribirte a Zenbox!\n\nPara crear tu cuenta y vincular tu WhatsApp, abre este enlace. Vale 72 horas y se usa una sola vez:\n${url}\n\nSi no fuiste tú, ignora este correo.`;
  const html = `<p>¡Gracias por suscribirte a Zenbox!</p><p>Para crear tu cuenta y vincular tu WhatsApp, abre este enlace. Vale 72 horas y se usa una sola vez:</p><p><a href="${url}">${url}</a></p><p>Si no fuiste tú, ignora este correo.</p>`;
  return { to, subject: "Crea tu cuenta de Zenbox", text, html };
}
