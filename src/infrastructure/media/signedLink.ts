import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SignedLinks {
  /** Token for `/media/<token>`: `base64url(payload).base64url(HMAC-SHA256)`, expiry embedded. */
  sign(mediaId: string): string;
  /** Same as `sign`, plus the ISO 8601 expiry to show the user. */
  issue(mediaId: string): { token: string; expiresAt: string };
  /** The media id when the token is authentic and not expired; otherwise `null`. */
  verify(token: string): string | null;
}

const SECRET_BYTES = 32;
const SECRET_FILE = "media-secret";

export function createSignedLinks(opts: {
  secret: Uint8Array;
  ttlSeconds: number;
  now?: () => number;
}): SignedLinks {
  const now = opts.now ?? Date.now;
  const mac = (payload: string) =>
    createHmac("sha256", opts.secret).update(payload).digest("base64url");

  function issue(mediaId: string) {
    const exp = Math.floor(now() / 1000) + opts.ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ m: mediaId, e: exp })).toString("base64url");
    return { token: `${payload}.${mac(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  return {
    issue,
    sign: (mediaId) => issue(mediaId).token,
    verify(token) {
      const parts = token.split(".");
      if (parts.length !== 2) return null;
      const [payload, sig] = parts as [string, string];
      const expected = Buffer.from(mac(payload));
      const given = Buffer.from(sig);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
        string,
        unknown
      >;
      if (typeof o.m !== "string" || typeof o.e !== "number") return null;
      return now() / 1000 > o.e ? null : o.m;
    },
  };
}

/**
 * 32 random bytes kept in `DATA_DIR/media-secret` (mode 0600), so links issued
 * before a restart keep working until they expire.
 */
export function loadOrCreateMediaSecret(dataDir: string): Uint8Array {
  const file = join(dataDir, SECRET_FILE);
  try {
    const existing = readFileSync(file);
    if (existing.length === SECRET_BYTES) return new Uint8Array(existing);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(SECRET_BYTES);
  writeFileSync(file, secret, { mode: 0o600 });
  return new Uint8Array(secret);
}
