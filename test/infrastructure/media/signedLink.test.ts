import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSignedLinks,
  loadOrCreateMediaSecret,
} from "../../../src/infrastructure/media/signedLink.js";

const secret = new Uint8Array(32).fill(7);
const T0 = 1_800_000_000_000;

describe("createSignedLinks", () => {
  it("round-trips the media id", () => {
    const links = createSignedLinks({ secret, ttlSeconds: 600, now: () => T0 });
    const token = links.sign("bWVkaWEtaWQ");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(links.verify(token)).toBe("bWVkaWEtaWQ");
  });

  it("issue returns the token and its ISO expiry", () => {
    const links = createSignedLinks({ secret, ttlSeconds: 600, now: () => T0 });
    const { token, expiresAt } = links.issue("m1");
    expect(links.verify(token)).toBe("m1");
    expect(expiresAt).toBe(new Date(T0 + 600_000).toISOString());
  });

  it("rejects tampered tokens", () => {
    const links = createSignedLinks({ secret, ttlSeconds: 600, now: () => T0 });
    const token = links.sign("m1");
    const [payload, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ m: "m2", e: T0 / 1000 + 600 })).toString(
      "base64url",
    );
    expect(links.verify(`${forged}.${sig}`)).toBeNull();
    expect(links.verify(`${payload}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(links.verify(`${payload}`)).toBeNull();
    expect(links.verify("")).toBeNull();
    expect(links.verify("a.b.c")).toBeNull();
    const other = createSignedLinks({
      secret: new Uint8Array(32).fill(8),
      ttlSeconds: 600,
      now: () => T0,
    });
    expect(other.verify(token)).toBeNull();
  });

  it("rejects expired tokens (clock + ttl + 1)", () => {
    let now = T0;
    const links = createSignedLinks({ secret, ttlSeconds: 600, now: () => now });
    const token = links.sign("m1");
    now = T0 + 600_000;
    expect(links.verify(token)).toBe("m1");
    now = T0 + 601_000;
    expect(links.verify(token)).toBeNull();
  });
});

describe("loadOrCreateMediaSecret", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("creates 32 random bytes once (mode 0600) and reuses them after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "waha-mcp-secret-"));
    dirs.push(dir);
    const first = loadOrCreateMediaSecret(dir);
    expect(first).toHaveLength(32);
    expect(statSync(join(dir, "media-secret")).mode & 0o777).toBe(0o600);
    const second = loadOrCreateMediaSecret(dir);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    expect(readFileSync(join(dir, "media-secret"))).toHaveLength(32);
  });
});
