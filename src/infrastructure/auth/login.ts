import type { Context } from "hono";
import type { TenantStore, User } from "../../domain/ports/TenantStore.js";
import { type LoginLimiter, loginLimitKeys } from "./rateLimit.js";

/**
 * Checks a sign-in form (email or username, and password) against the limiter (per address and
 * per identifier) and the
 * tenant store. A failure counts once globally and once per key; a success clears both keys'
 * counters (never the global budget). Tenant status is the caller's concern.
 */
export async function authenticateLogin(
  c: Context,
  form: URLSearchParams,
  deps: { tenants: TenantStore; limiter: LoginLimiter },
): Promise<"blocked" | "invalid" | User> {
  const identifier = (form.get("username") ?? "").trim();
  const keys = loginLimitKeys(c, identifier);
  if (keys.some((k) => deps.limiter.isBlocked(k))) return "blocked";
  // An email signs in as its account's username; an unknown email still runs the (dummy) hash,
  // so the answer and its timing do not tell which emails have accounts.
  const username = identifier.includes("@")
    ? (deps.tenants.getUserByEmail(identifier)?.username ?? identifier)
    : identifier;
  const user = await deps.tenants.verifyPassword(username, form.get("password") ?? "");
  if (!user) {
    deps.limiter.recordFailure(keys);
    return "invalid";
  }
  for (const k of keys) deps.limiter.reset(k);
  return user;
}
