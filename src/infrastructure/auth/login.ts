import type { Context } from "hono";
import type { TenantStore, User } from "../../domain/ports/TenantStore.js";
import { type LoginLimiter, loginLimitKeys } from "./rateLimit.js";

/**
 * Checks a username/password form against the limiter (per address and per username) and the
 * tenant store. A failure counts once globally and once per key; a success clears both keys'
 * counters (never the global budget). Tenant status is the caller's concern.
 */
export async function authenticateLogin(
  c: Context,
  form: URLSearchParams,
  deps: { tenants: TenantStore; limiter: LoginLimiter },
): Promise<"blocked" | "invalid" | User> {
  const keys = loginLimitKeys(c, form.get("username") ?? "");
  if (keys.some((k) => deps.limiter.isBlocked(k))) return "blocked";
  const user = await deps.tenants.verifyPassword(
    form.get("username") ?? "",
    form.get("password") ?? "",
  );
  if (!user) {
    deps.limiter.recordFailure(keys);
    return "invalid";
  }
  for (const k of keys) deps.limiter.reset(k);
  return user;
}
