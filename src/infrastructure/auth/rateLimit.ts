import type { Context } from "hono";

export interface LoginLimiter {
  isBlocked(key: string): boolean;
  recordFailure(key: string): void;
  reset(key: string): void;
}

/** Upper bound on tracked addresses, so a flood of distinct keys cannot grow memory unbounded. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * In-memory sliding-window limiter for failed logins. A key is blocked once it
 * has `maxFailures` failures inside the last `windowMs`.
 */
export function createLoginLimiter(
  opts: { maxFailures?: number; windowMs?: number; now?: () => number } = {},
): LoginLimiter {
  const maxFailures = opts.maxFailures ?? 5;
  const windowMs = opts.windowMs ?? 900_000;
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();

  const recent = (key: string): number[] => {
    const cutoff = now() - windowMs;
    const kept = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  };

  const evictIfFull = (): void => {
    if (failures.size < MAX_TRACKED_KEYS) return;
    for (const key of [...failures.keys()]) recent(key);
    // Still full: drop the oldest-inserted entries.
    for (const key of failures.keys()) {
      if (failures.size < MAX_TRACKED_KEYS) break;
      failures.delete(key);
    }
  };

  return {
    isBlocked: (key) => recent(key).length >= maxFailures,
    recordFailure(key) {
      const list = recent(key);
      if (list.length === 0) evictIfFull();
      list.push(now());
      failures.set(key, list.slice(-maxFailures));
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

/**
 * Rate-limit key for a request: the LAST `x-forwarded-for` hop, which is the
 * one appended by the trusted reverse proxy (Traefik). Earlier hops are
 * client-controlled and must not be trusted. Falls back to the socket address.
 */
export function clientKey(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    const last = hops.at(-1);
    if (last) return last;
  }
  type Bindings = { incoming?: { socket?: { remoteAddress?: string } } };
  const env = c.env as (Bindings & { server?: Bindings }) | undefined;
  const incoming = env?.server?.incoming ?? env?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}
