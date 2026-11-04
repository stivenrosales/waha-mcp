import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createTenantCipher,
  DecryptionError,
  generateDek,
  isSealedText,
  parseMasterKey,
  unwrapDek,
  wrapDek,
} from "../../../src/infrastructure/crypto/envelope.js";

const dek = generateDek();

describe("createTenantCipher", () => {
  it("roundtrips text and bytes", () => {
    const cipher = createTenantCipher(dek, "t1");
    expect(cipher.openText(cipher.sealText("hola 👋", "msg:1"), "msg:1")).toBe("hola 👋");
    const data = randomBytes(100);
    expect(cipher.open(cipher.seal(data, "media:1"), "media:1").equals(data)).toBe(true);
    expect(cipher.openText(cipher.sealText("", "k"), "k")).toBe("");
  });

  it('sealText output starts with "v1." and differs on each call', () => {
    const cipher = createTenantCipher(dek, "t1");
    const a = cipher.sealText("same", "k");
    const b = cipher.sealText("same", "k");
    expect(a.startsWith("v1.")).toBe(true);
    expect(isSealedText(a)).toBe(true);
    expect(isSealedText("plain text")).toBe(false);
    expect(isSealedText("v1. del contrato")).toBe(false);
    expect(isSealedText("v1.abc")).toBe(false);
    expect(a).not.toBe(b);
  });

  it("seal lays out nonce(12) | ciphertext | tag(16)", () => {
    const sealed = createTenantCipher(dek, "t1").seal(Buffer.alloc(5), "k");
    expect(sealed.length).toBe(12 + 5 + 16);
  });

  it("open with a different aad throws DecryptionError", () => {
    const cipher = createTenantCipher(dek, "t1");
    expect(() => cipher.openText(cipher.sealText("x", "a"), "b")).toThrow(DecryptionError);
    expect(() => cipher.open(cipher.seal(Buffer.from("x"), "a"), "b")).toThrow(DecryptionError);
  });

  it("open with another tenant's cipher (same DEK, other tenantId) throws DecryptionError", () => {
    const sealed = createTenantCipher(dek, "t1").sealText("x", "k");
    expect(() => createTenantCipher(dek, "t2").openText(sealed, "k")).toThrow(DecryptionError);
  });

  it("a flipped ciphertext byte throws DecryptionError", () => {
    const cipher = createTenantCipher(dek, "t1");
    const sealed = cipher.seal(Buffer.from("secret"), "k");
    sealed[14] = (sealed[14] ?? 0) ^ 1;
    expect(() => cipher.open(sealed, "k")).toThrow(DecryptionError);
  });

  it("tenant ids that differ only by a ':' split cannot open each other's values", () => {
    const sealed = createTenantCipher(dek, "a:b").sealText("x", "c");
    expect(() => createTenantCipher(dek, "a").openText(sealed, "b:c")).toThrow(DecryptionError);
    const sealedOther = createTenantCipher(dek, "a").sealText("x", "b:c");
    expect(() => createTenantCipher(dek, "a:b").openText(sealedOther, "c")).toThrow(
      DecryptionError,
    );
  });

  it("a tenant cipher cannot open a wrapped DEK and vice versa", () => {
    const kek = randomBytes(32);
    const wrapped = wrapDek(kek, dek, "legacy");
    expect(() => createTenantCipher(kek, "legacy").openText(wrapped, "legacy")).toThrow(
      DecryptionError,
    );
    const value = createTenantCipher(kek, "legacy").sealText("x", "legacy");
    expect(() => unwrapDek(kek, value, "legacy")).toThrow(DecryptionError);
  });

  it("a tampered tag or nonce throws DecryptionError", () => {
    const cipher = createTenantCipher(dek, "t1");
    for (const flip of ["nonce", "tag"] as const) {
      const sealed = cipher.seal(Buffer.from("abc"), "k");
      const i = flip === "nonce" ? 0 : sealed.length - 1;
      sealed[i] = (sealed[i] ?? 0) ^ 1;
      expect(() => cipher.open(sealed, "k")).toThrow(DecryptionError);
    }
  });

  it("a truncated v1. text throws DecryptionError", () => {
    const cipher = createTenantCipher(dek, "t1");
    const text = cipher.sealText("hello world", "k");
    expect(() => cipher.openText(text.slice(0, -4), "k")).toThrow(DecryptionError);
    expect(() => cipher.openText("v1.", "k")).toThrow(DecryptionError);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => createTenantCipher(randomBytes(16), "t1")).toThrow("DEK must be 32 bytes.");
    expect(() => wrapDek(randomBytes(16), dek, "t1")).toThrow("KEK must be 32 bytes.");
    expect(() => wrapDek(randomBytes(32), randomBytes(16), "t1")).toThrow("DEK must be 32 bytes.");
    expect(() => unwrapDek(randomBytes(16), "v1.x", "t1")).toThrow("KEK must be 32 bytes.");
  });

  it("rejects malformed sealed input with DecryptionError", () => {
    const cipher = createTenantCipher(dek, "t1");
    expect(() => cipher.open(Buffer.alloc(10), "k")).toThrow(DecryptionError);
    expect(() => cipher.openText("not-sealed", "k")).toThrow(DecryptionError);
  });
});

describe("wrapDek / unwrapDek", () => {
  it("roundtrips the DEK for the same tenant", () => {
    const kek = randomBytes(32);
    expect(unwrapDek(kek, wrapDek(kek, dek, "t1"), "t1").equals(dek)).toBe(true);
  });

  it("unwrapDek with the wrong KEK throws DecryptionError", () => {
    const wrapped = wrapDek(randomBytes(32), dek, "t1");
    expect(() => unwrapDek(randomBytes(32), wrapped, "t1")).toThrow(DecryptionError);
  });

  it("unwrapDek for another tenant throws DecryptionError", () => {
    const kek = randomBytes(32);
    expect(() => unwrapDek(kek, wrapDek(kek, dek, "t1"), "t2")).toThrow(DecryptionError);
  });
});

describe("generateDek", () => {
  it("returns 32 random bytes", () => {
    expect(dek.length).toBe(32);
    expect(generateDek().equals(dek)).toBe(false);
  });
});

describe("parseMasterKey", () => {
  const message = "MASTER_KEY must be 32 bytes encoded in base64.";

  it("accepts 32 bytes", () => {
    const key = randomBytes(32);
    expect(parseMasterKey(key.toString("base64")).equals(key)).toBe(true);
  });

  it("rejects 31 and 33 bytes and non-base64", () => {
    expect(() => parseMasterKey(randomBytes(31).toString("base64"))).toThrow(message);
    expect(() => parseMasterKey(randomBytes(33).toString("base64"))).toThrow(message);
    expect(() => parseMasterKey("not base64 !!!")).toThrow(message);
    expect(() => parseMasterKey("")).toThrow(message);
  });
});
