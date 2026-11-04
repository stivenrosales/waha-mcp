import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    // maxmem must cover 128 * N * r bytes (plus slack) for the parameters stored in the hash.
    scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: 256 * n * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });

/** Format: `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Timing-safe. Returns false (never throws) for a malformed stored hash. */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [parts[1], parts[2], parts[3]].map(Number) as [number, number, number];
  // Cap the cost so a corrupted row cannot make a login attempt allocate unbounded memory.
  if (
    ![n, r, p].every(Number.isInteger) ||
    n < 2 ||
    n > 2 ** 20 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  )
    return false;
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await derive(password, salt, n, r, p);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
