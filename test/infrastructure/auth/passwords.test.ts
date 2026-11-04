import { describe, expect, it } from "vitest";
import { hashPassword, verifyPasswordHash } from "../../../src/infrastructure/auth/passwords.js";

describe("passwords", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPasswordHash("correct horse battery", hash)).toBe(true);
    expect(await verifyPasswordHash("wrong horse battery", hash)).toBe(false);
  });

  it("two hashes of one password differ", async () => {
    expect(await hashPassword("same-password-123")).not.toBe(
      await hashPassword("same-password-123"),
    );
  });

  it("returns false, not throw, for a malformed stored hash", async () => {
    for (const bad of ["", "nope", "scrypt$x$8$1$aa$bb", "scrypt$16384$8$1$AAAA", "md5$1$2$3$4$5"])
      expect(await verifyPasswordHash("whatever-password", bad)).toBe(false);
  });
});
