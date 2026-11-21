import type { CacheEventPort } from "../../application/cacheEvents.js";
import type { TenantRuntime } from "../tenants/runtime.js";

/** The cache event processor's view of one tenant runtime. */
export function cacheEventPort(runtime: TenantRuntime): CacheEventPort {
  return {
    openEvent: (e) =>
      runtime.cipher.openText(e.payloadSealed, `webhook:${e.tenantId}:${e.eventId}`),
    actions: runtime.context.messageActions,
  };
}
