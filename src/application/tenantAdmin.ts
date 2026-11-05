import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { InvalidInputError } from "../domain/errors.js";
import type { SessionAdmin, SessionState } from "../domain/ports/SessionAdmin.js";
import type { TenantStatus, TenantStore } from "../domain/ports/TenantStore.js";
import { localMidnight, parseRange, zoneFormatter, zoneParts } from "./dates.js";

/** Invite and reset links live 72 hours. */
export const LINK_TTL_MS = 72 * 3600_000;

const ADMIN_TENANT_MESSAGE = "The admin tenant cannot be revoked, restored or deleted.";
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export interface TenantOverview {
  id: string;
  displayName: string;
  status: TenantStatus;
  whatsapp: SessionState;
  createdAt: string;
  lastLoginAt: string | null;
  isAdmin: boolean;
}

export interface UsageTotals {
  count: number;
  seconds: number;
  costUsd: number;
  /** Transcriptions whose provider reported no cost: `costUsd` does not include them. */
  rowsWithoutCost: number;
}

export interface TranscriptionUsageReport {
  /** ISO instants, both inclusive. */
  from: string;
  to: string;
  /** Most expensive first; `displayName` is null for a tenant deleted since. */
  tenants: Array<{ id: string; displayName: string | null } & UsageTotals>;
  total: UsageTotals;
}

export interface TenantAdmin {
  /** Exactly one of `displayName` (new tenant) or `tenantId` (re-issue for a tenant with no user). */
  createInvite(q: {
    displayName?: string;
    tenantId?: string;
  }): Promise<{ tenantId: string; url: string; expiresAt: string }>;
  listTenants(): Promise<TenantOverview[]>;
  revoke(tenantId: string): void;
  /** Returns the status the tenant is in afterwards. */
  restore(tenantId: string): TenantStatus;
  resetPassword(tenantId: string): { url: string; expiresAt: string };
  /**
   * Deletes the tenant for good. `whatsappCleanup` is "failed" when WAHA could not be told to
   * log out and remove the session; `localCleanup` is "failed" when the runtime eviction or the
   * data directory removal threw. The row and key are gone in every case. When either failed,
   * `wahaSession` names the WAHA session so the admin can clean it up by hand.
   */
  delete(
    tenantId: string,
    confirmDisplayName: string,
  ): Promise<{
    whatsappCleanup: "ok" | "failed";
    localCleanup: "ok" | "failed";
    wahaSession?: string;
  }>;
  /** Paid transcriptions per tenant; the range defaults to the current month in `timezone`. */
  transcriptionUsage(q: {
    from?: string;
    to?: string;
    tenantId?: string;
  }): Promise<TranscriptionUsageReport>;
}

export interface TenantAdminDeps {
  tenants: TenantStore;
  auth: { revokeUser(userId: string): void };
  sessions: SessionAdmin;
  registry: { evict(id: string): void };
  /** Wraps a fresh data key for the tenant (keeps crypto out of the application layer). */
  newWrappedDek(tenantId: string): string;
  dataDir: string;
  publicBaseUrl: string;
  logger: { info(message: string): void };
  /** IANA zone for usage ranges (`TIMEZONE`); defaults to UTC. */
  timezone?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

const newSessionName = (): string => {
  let suffix = "";
  for (let i = 0; i < 10; i++) suffix += BASE32[randomInt(BASE32.length)];
  return `t_${suffix}`;
};

export function createTenantAdmin(deps: TenantAdminDeps): TenantAdmin {
  const { tenants, auth, sessions, registry, logger } = deps;
  const base = deps.publicBaseUrl.replace(/\/+$/, "");
  const iso = (ms: number): string => new Date(ms).toISOString();

  /** Runs `fn`, logging `admin <tool> tenant=<id> outcome=<ok|error>` (never arguments or secrets). */
  async function audited<T>(
    tool: string,
    tenantId: () => string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn();
      logger.info(`admin ${tool} tenant=${tenantId()} outcome=ok`);
      return result;
    } catch (error) {
      logger.info(`admin ${tool} tenant=${tenantId()} outcome=error`);
      throw error;
    }
  }

  const requireTenant = (tenantId: string) => {
    const tenant = tenants.getTenant(tenantId);
    if (!tenant) throw new InvalidInputError("Tenant not found.");
    return tenant;
  };

  /** Never log (or touch the filesystem with) a caller-supplied id that is not id-shaped. */
  const isSafeId = (tenantId: string): boolean => TENANT_ID_PATTERN.test(tenantId);
  const assertSafeId = (tenantId: string): void => {
    if (!isSafeId(tenantId)) throw new InvalidInputError("Invalid tenant id.");
  };

  const assertNotAdmin = (tenantId: string): void => {
    if (tenants.getAdmin()?.tenantId === tenantId)
      throw new InvalidInputError(ADMIN_TENANT_MESSAGE);
  };

  const linkResult = (tenantId: string, kind: "invite" | "reset") => {
    const { token, expiresAt } = tenants.issueLink(tenantId, kind, LINK_TTL_MS);
    return { url: `${base}/${kind}/${token}`, expiresAt: iso(expiresAt) };
  };

  return {
    createInvite(q) {
      let id = q.tenantId ?? "-";
      return audited(
        "create_invite",
        () => id,
        async () => {
          const hasName = q.displayName !== undefined;
          const hasId = q.tenantId !== undefined;
          if (hasName === hasId)
            throw new InvalidInputError("Provide exactly one of display_name or tenant_id.");
          if (hasId) {
            const tenant = requireTenant(q.tenantId as string);
            if (tenants.getUserByTenant(tenant.id))
              throw new InvalidInputError("This tenant already has a user; use reset_password.");
            if (tenant.status === "revoked")
              throw new InvalidInputError("This tenant is revoked; restore it first.");
            return { tenantId: tenant.id, ...linkResult(tenant.id, "invite") };
          }
          const displayName = (q.displayName as string).trim();
          if (!displayName) throw new InvalidInputError("display_name must not be empty.");
          const wahaSession = newSessionName();
          // The wrapped DEK is bound to the tenant id, which only exists after the insert.
          const tenant = tenants.createTenant({ displayName, wahaSession, wrappedDek: "pending" });
          id = tenant.id;
          try {
            tenants.setWrappedDek(tenant.id, deps.newWrappedDek(tenant.id));
            await sessions.create(wahaSession);
          } catch (error) {
            tenants.deleteTenant(tenant.id);
            // The session may exist even if create threw (e.g. a timeout); never mask `error`.
            await sessions.remove(wahaSession).catch(() => {});
            throw error;
          }
          return { tenantId: tenant.id, ...linkResult(tenant.id, "invite") };
        },
      );
    },

    async transcriptionUsage(q) {
      const timezone = deps.timezone ?? "UTC";
      const now = (deps.now ?? Date.now)();
      const range = parseRange({ from: q.from, to: q.to }, timezone);
      let from = range.from;
      if (from === undefined) {
        const fmt = zoneFormatter(timezone);
        const p = zoneParts(fmt, now);
        from = localMidnight(fmt, p.year ?? 1970, p.month ?? 1, 1);
      }
      // A bound is read to the second: count everything inside its last second.
      const to = range.to === undefined ? now : range.to + 999;
      if (from > to) throw new InvalidInputError('"from" must not be later than "to".');
      const rows = tenants.transcriptionUsage({
        fromIso: new Date(from).toISOString(),
        toIso: new Date(to).toISOString(),
        ...(q.tenantId ? { tenantId: q.tenantId } : {}),
      });
      const total: UsageTotals = { count: 0, seconds: 0, costUsd: 0, rowsWithoutCost: 0 };
      for (const r of rows) {
        total.count += r.count;
        total.seconds += r.seconds;
        total.costUsd += r.costUsd;
        total.rowsWithoutCost += r.rowsWithoutCost;
      }
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        tenants: rows.map(({ tenantId, ...totals }) => ({
          id: tenantId,
          displayName: tenants.getTenant(tenantId)?.displayName ?? null,
          ...totals,
        })),
        total,
      };
    },

    async listTenants() {
      const adminTenantId = tenants.getAdmin()?.tenantId;
      return Promise.all(
        tenants.listTenants().map(async (tenant) => {
          const whatsapp = await sessions
            .state(tenant.wahaSession)
            .catch((): SessionState => "UNKNOWN");
          const lastLogin = tenants.getUserByTenant(tenant.id)?.lastLoginAt ?? null;
          return {
            id: tenant.id,
            displayName: tenant.displayName,
            status: tenant.status,
            whatsapp,
            createdAt: iso(tenant.createdAt),
            lastLoginAt: lastLogin === null ? null : iso(lastLogin),
            isAdmin: tenant.id === adminTenantId,
          };
        }),
      );
    },

    revoke(tenantId) {
      let outcome = "error";
      try {
        assertSafeId(tenantId);
        assertNotAdmin(tenantId);
        const tenant = requireTenant(tenantId);
        if (tenant.status !== "revoked") tenants.setStatus(tenantId, "revoked");
        const user = tenants.getUserByTenant(tenantId);
        if (user) auth.revokeUser(user.id);
        registry.evict(tenantId);
        outcome = "ok";
      } finally {
        logger.info(
          `admin revoke_tenant tenant=${isSafeId(tenantId) ? tenantId : "-"} outcome=${outcome}`,
        );
      }
    },

    restore(tenantId) {
      let outcome = "error";
      try {
        assertSafeId(tenantId);
        assertNotAdmin(tenantId);
        const tenant = requireTenant(tenantId);
        let status: TenantStatus = tenant.status;
        if (tenant.status === "revoked") {
          // Resume where onboarding stopped: no user yet -> invited; user but no paired
          // WhatsApp -> pairing; fully onboarded -> active.
          const next: TenantStatus = !tenants.getUserByTenant(tenantId)
            ? "invited"
            : tenant.waId
              ? "active"
              : "pairing";
          tenants.transitionStatus(tenantId, "revoked", next);
          status = tenants.getTenant(tenantId)?.status ?? next;
        }
        outcome = "ok";
        return status;
      } finally {
        logger.info(
          `admin restore_tenant tenant=${isSafeId(tenantId) ? tenantId : "-"} outcome=${outcome}`,
        );
      }
    },

    resetPassword(tenantId) {
      let outcome = "error";
      try {
        assertSafeId(tenantId);
        const tenant = requireTenant(tenantId);
        if (!tenants.getUserByTenant(tenant.id))
          throw new InvalidInputError(
            "This tenant has no user yet; use create_invite with tenant_id.",
          );
        const result = linkResult(tenant.id, "reset");
        outcome = "ok";
        return result;
      } finally {
        logger.info(
          `admin reset_password tenant=${isSafeId(tenantId) ? tenantId : "-"} outcome=${outcome}`,
        );
      }
    },

    delete(tenantId, confirmDisplayName) {
      return audited(
        "delete_tenant",
        () => (isSafeId(tenantId) ? tenantId : "-"),
        async () => {
          assertSafeId(tenantId);
          assertNotAdmin(tenantId);
          const tenant = requireTenant(tenantId);
          if (confirmDisplayName !== tenant.displayName)
            throw new InvalidInputError(
              "confirm_display_name does not match the tenant's display name; nothing was deleted.",
            );
          const user = tenants.getUserByTenant(tenant.id);

          // Row + wrapped DEK first: from here on the tenant's data is unrecoverable.
          tenants.deleteTenant(tenant.id);

          /** Runs one cleanup step; a failure is logged (never its error text) and reported. */
          const step = async (name: string, fn: () => unknown): Promise<"ok" | "failed"> => {
            try {
              await fn();
              return "ok";
            } catch {
              logger.info(
                `admin delete_tenant tenant=${tenant.id} session=${tenant.wahaSession} step=${name} outcome=failed`,
              );
              return "failed";
            }
          };
          const worst = (...r: ("ok" | "failed")[]) => (r.includes("failed") ? "failed" : "ok");

          const revoked = await step("revoke_user", () => user && auth.revokeUser(user.id));
          const evicted = await step("evict", () => registry.evict(tenant.id));
          const whatsappCleanup = worst(
            await step("waha_logout", () => sessions.logout(tenant.wahaSession)),
            await step("waha_remove", () => sessions.remove(tenant.wahaSession)),
          );
          const removed = await step("remove_data_dir", () =>
            fs.rmSync(path.join(deps.dataDir, "tenants", tenant.id), {
              recursive: true,
              force: true,
            }),
          );
          const localCleanup = worst(revoked, evicted, removed);
          return whatsappCleanup === "ok" && localCleanup === "ok"
            ? { whatsappCleanup, localCleanup }
            : { whatsappCleanup, localCleanup, wahaSession: tenant.wahaSession };
        },
      );
    },
  };
}
