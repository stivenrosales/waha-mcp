import { isIP } from "node:net";
import type { Context } from "hono";

export interface LoginLimiter {
  isBlocked(key: string): boolean;
  recordFailure(key: string): void;
  reset(key: string): void;
}

/**
 * In-memory sliding-window limiter for failed logins. A key is blocked once it
 * has `maxFailures` failures inside the last `windowMs`. Every key is blocked
 * while the global budget (`globalMaxFailures` failures across all keys in the
 * window) is exhausted: single-owner server, so locking everyone out briefly is
 * acceptable. `reset` clears one key's counter, never the global budget.
 */
export function createLoginLimiter(
  opts: {
    maxFailures?: number;
    windowMs?: number;
    globalMaxFailures?: number;
    /** Upper bound on tracked keys, so a flood of distinct keys cannot grow memory unbounded. */
    maxTrackedKeys?: number;
    now?: () => number;
  } = {},
): LoginLimiter {
  const maxFailures = opts.maxFailures ?? 5;
  const windowMs = opts.windowMs ?? 900_000;
  const globalMaxFailures = opts.globalMaxFailures ?? 50;
  const maxTrackedKeys = opts.maxTrackedKeys ?? 10_000;
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();
  let globalFailures: number[] = [];

  const cutoff = (): number => now() - windowMs;

  const recent = (key: string): number[] => {
    const kept = (failures.get(key) ?? []).filter((t) => t > cutoff());
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  };

  const globalCount = (): number => {
    const limit = cutoff();
    globalFailures = globalFailures.filter((t) => t > limit);
    return globalFailures.length;
  };

  /** Makes room for one new key. Blocked keys are never evicted before their window ends. */
  const makeRoom = (): void => {
    if (failures.size < maxTrackedKeys) return;
    for (const key of [...failures.keys()]) recent(key);
    for (const [key, list] of failures) {
      if (failures.size < maxTrackedKeys) break;
      if (list.length < maxFailures) failures.delete(key);
    }
    // If every tracked key is blocked the map may exceed the cap; the global
    // budget bounds how many failures (hence keys) can accumulate per window.
  };

  return {
    isBlocked: (key) => globalCount() >= globalMaxFailures || recent(key).length >= maxFailures,
    recordFailure(key) {
      globalCount();
      globalFailures.push(now());
      globalFailures = globalFailures.slice(-Math.max(globalMaxFailures, 1));
      const list = recent(key);
      if (list.length === 0) makeRoom();
      list.push(now());
      failures.set(key, list.slice(-maxFailures));
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

/**
 * Normalizes an address into a rate-limit key: IPv4-mapped IPv6 becomes IPv4,
 * and IPv6 collapses to its /64, since one subscriber usually owns a whole /64.
 * Anything that is not an IP address is returned trimmed.
 */
export function normalizeClientKey(raw: string): string {
  let value = raw.trim().replace(/^\[|\]$/g, "");
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return mapped[1];
  if (isIP(value) !== 6) return value;
  const groups = expandIPv6(value);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : value;
}

/** Expands an IPv6 address into 8 lowercase hextets (embedded IPv4 tail supported). */
function expandIPv6(address: string): string[] | null {
  let text = address.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (text.includes("::") ? missing < 0 : missing !== 0) return null;
  const groups = [...left, ...Array(text.includes("::") ? missing : 0).fill("0"), ...right];
  return groups.map((g) => Number.parseInt(g, 16).toString(16));
}

/**
 * Rate-limit key for a request: the LAST `x-forwarded-for` hop, which is the
 * one appended by the trusted reverse proxy (Traefik). Earlier hops are
 * client-controlled and must not be trusted. Falls back to the socket address.
 * The address is normalized with `normalizeClientKey`.
 */
export function clientKey(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    const last = hops.at(-1);
    if (last) return normalizeClientKey(last);
  }
  type Bindings = { incoming?: { socket?: { remoteAddress?: string } } };
  const env = c.env as (Bindings & { server?: Bindings }) | undefined;
  const incoming = env?.server?.incoming ?? env?.incoming;
  const address = incoming?.socket?.remoteAddress;
  return address ? normalizeClientKey(address) : "unknown";
}
