import { InvalidInputError } from "../domain/errors.js";
import type { CacheData } from "../domain/ports/CacheData.js";
import type { SessionAdmin } from "../domain/ports/SessionAdmin.js";
import type { TenantStore } from "../domain/ports/TenantStore.js";

/** What `delete_my_data` removed. */
export interface DataDeletionReport {
  /** Cached messages (their edits, reactions and poll votes went with them). */
  messages: number;
  /** Stored voice-note transcripts. */
  transcripts: number;
  /** Ended missions, row and sealed content. */
  missions: number;
  /** Ended scheduled messages, row, content and run history. */
  schedules: number;
}

/** What `unlink_account` did. */
export interface UnlinkReport {
  /** "failed" when WAHA could not log the session out (the phone can still remove it). */
  whatsapp: "logged_out" | "failed";
  /** Every OAuth client and token of the tenant's user was revoked. */
  signedOut: true;
}

/** Self-service actions of one tenant, bound to the caller (never a tenant id argument). */
export interface SelfService {
  /** Deletes the tenant's cached message data and its ended missions and schedules. */
  deleteMyData(): Promise<DataDeletionReport>;
  /** Logs the tenant's WhatsApp session out, signs out every connected client, drops the runtime. */
  unlink(): Promise<UnlinkReport>;
}

export interface SelfServiceDeps {
  tenants: Pick<TenantStore, "getTenant" | "getUserByTenant">;
  auth: { revokeUser(userId: string): void };
  sessions: Pick<SessionAdmin, "logout">;
  registry: { evict(tenantId: string): void };
  /** Ended missions and schedules (the retention purge's per-tenant step); absent when not wired. */
  history?: {
    purgeTenantHistory(tenantId: string, now: Date): { missions: number; schedules: number };
  };
  /** Tenant ids, counts and outcomes only; never content or error text. */
  logger: { info(message: string): void };
  now?: () => Date;
}

/**
 * The self-service actions every tenant gets. `forTenant` binds them to one tenant: the MCP server
 * passes the tenant id of the authenticated token and the `cache.db` of that same request's
 * runtime, so a caller can only ever reach its own data, session and user.
 */
export function createSelfService(deps: SelfServiceDeps): {
  forTenant(tenantId: string, data: Pick<CacheData, "wipe">): SelfService;
} {
  const { tenants, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const requireTenant = (tenantId: string) => {
    const tenant = tenants.getTenant(tenantId);
    if (!tenant) throw new InvalidInputError("Account not found.");
    return tenant;
  };

  return {
    forTenant(tenantId, data) {
      return {
        async deleteMyData() {
          requireTenant(tenantId);
          try {
            const cached = data.wipe();
            const history = deps.history?.purgeTenantHistory(tenantId, now()) ?? {
              missions: 0,
              schedules: 0,
            };
            const report = { ...cached, ...history };
            logger.info(
              `self delete_my_data tenant=${tenantId} messages=${report.messages} transcripts=${report.transcripts} missions=${report.missions} schedules=${report.schedules} outcome=ok`,
            );
            return report;
          } catch (error) {
            logger.info(`self delete_my_data tenant=${tenantId} outcome=error`);
            throw error;
          }
        },

        async unlink() {
          const tenant = requireTenant(tenantId);
          let whatsapp: UnlinkReport["whatsapp"] = "logged_out";
          try {
            await deps.sessions.logout(tenant.wahaSession);
          } catch {
            // Never the error text: it may name the WAHA URL.
            whatsapp = "failed";
          }
          const user = tenants.getUserByTenant(tenant.id);
          if (user) deps.auth.revokeUser(user.id);
          deps.registry.evict(tenant.id);
          logger.info(`self unlink_account tenant=${tenant.id} whatsapp=${whatsapp} outcome=ok`);
          return { whatsapp, signedOut: true };
        },
      };
    },
  };
}
