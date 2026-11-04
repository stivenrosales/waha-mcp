import type { Config } from "../../config.js";
import type { Tenant, TenantStore } from "../../domain/ports/TenantStore.js";
import { unwrapDek } from "../crypto/envelope.js";
import type { Logger } from "../mcp/defineTool.js";
import { buildTenantRuntime, type TenantRuntime } from "./runtime.js";

export interface TenantRegistry {
  /**
   * Null when the tenant does not exist or is not active. Caller must call release().
   * A runtime build that throws (e.g. disk errors) propagates and registers nothing.
   */
  acquire(tenantId: string): { runtime: TenantRuntime; release(): void } | null;
  evict(tenantId: string): void;
  /**
   * Shutdown only: closes every live runtime at once, including runtimes still held by
   * an unreleased acquire (their later `release()` is a no-op).
   */
  closeAll(): void;
}

const DEFAULT_MAX_OPEN = 32;

interface Entry {
  runtime: TenantRuntime;
  /** Unreleased acquires. */
  refs: number;
  /** Out of the LRU; closed as soon as `refs` reaches 0 (unless acquired again first). */
  evicted: boolean;
  closed: boolean;
}

/**
 * Lazily builds one runtime per active tenant and keeps at most `maxOpen` of them in an
 * LRU (each holds an open SQLite handle). There is never more than one live runtime per
 * tenant: an evicted runtime that is still held is closed on its last release, and an
 * acquire before that revives it (back into the LRU) instead of building a second one.
 */
export function createTenantRegistry(deps: {
  config: Config;
  tenants: TenantStore;
  kek: Buffer;
  mediaSecret: Uint8Array;
  logger: Logger;
  maxOpen?: number /* default 32 */;
  build?: typeof buildTenantRuntime;
}): TenantRegistry {
  const maxOpen = Math.max(1, deps.maxOpen ?? DEFAULT_MAX_OPEN);
  const build = deps.build ?? buildTenantRuntime;
  /** Every live runtime: cached ones and evicted ones still held. */
  const live = new Map<string, Entry>();
  /** Cached runtimes, least recently acquired first. */
  const lru = new Map<string, Entry>();

  function close(tenantId: string, entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (live.get(tenantId) === entry) live.delete(tenantId);
    entry.runtime.close();
  }

  function evictEntry(tenantId: string, entry: Entry): void {
    if (lru.get(tenantId) === entry) lru.delete(tenantId);
    entry.evicted = true;
    if (entry.refs === 0) close(tenantId, entry);
  }

  function open(tenant: Tenant): Entry | null {
    const tenantId = tenant.id;
    const wrapped = deps.tenants.getWrappedDek(tenantId);
    let dek: Buffer;
    try {
      if (wrapped === null) throw new Error("missing");
      dek = unwrapDek(deps.kek, wrapped, tenantId);
    } catch {
      // Never the wrapped value, the key or the error text: only which tenant failed.
      deps.logger.info(`tenant=${tenantId} runtime=unavailable reason=dek-unwrap-failed`);
      return null;
    }
    const runtime = build({
      config: deps.config,
      tenant,
      dek,
      mediaSecret: deps.mediaSecret,
      logger: deps.logger,
    });
    const entry: Entry = { runtime, refs: 0, evicted: false, closed: false };
    live.set(tenantId, entry);
    return entry;
  }

  return {
    acquire(tenantId) {
      const tenant = deps.tenants.getTenant(tenantId);
      if (tenant?.status !== "active") {
        // Revoked (or deleted) while cached: drop the runtime so its data stops being served.
        const cached = live.get(tenantId);
        if (cached && !cached.evicted) evictEntry(tenantId, cached);
        return null;
      }
      let entry = live.get(tenantId) ?? null;
      if (entry) {
        entry.evicted = false;
        lru.delete(tenantId);
        lru.set(tenantId, entry);
      } else {
        entry = open(tenant);
        if (!entry) return null;
        lru.set(tenantId, entry);
      }
      entry.refs += 1;
      for (const [oldestId, oldest] of lru) {
        if (lru.size <= maxOpen) break;
        evictEntry(oldestId, oldest);
      }

      const held = entry;
      let released = false;
      return {
        runtime: held.runtime,
        release() {
          if (released) return;
          released = true;
          held.refs -= 1;
          if (held.evicted && held.refs === 0) close(tenantId, held);
        },
      };
    },

    evict(tenantId) {
      const entry = live.get(tenantId);
      if (entry && !entry.evicted) evictEntry(tenantId, entry);
    },

    closeAll() {
      for (const [tenantId, entry] of [...live]) {
        entry.evicted = true;
        close(tenantId, entry);
      }
      lru.clear();
    },
  };
}
