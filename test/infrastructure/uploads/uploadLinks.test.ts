import { describe, expect, it } from "vitest";
import { createSignedLinks } from "../../../src/infrastructure/media/signedLink.js";
import { createUploadLinks } from "../../../src/infrastructure/uploads/uploadLinks.js";

const secret = new Uint8Array(32).fill(7);

describe("createUploadLinks", () => {
  it("round-trips an upload id", () => {
    const links = createUploadLinks(secret, 900, "A");
    expect(links.verify(links.sign("abc"))).toBe("abc");
  });

  it("does not verify an upload token for another tenant", () => {
    const token = createUploadLinks(secret, 900, "A").sign("abc");
    expect(createUploadLinks(secret, 900, "B").verify(token)).toBeNull();
  });

  it("issues tokens that media links reject, and the other way round", () => {
    const uploads = createUploadLinks(secret, 900, "A");
    const media = createSignedLinks({ secret, ttlSeconds: 900, tenantId: "A" });
    expect(media.verify(uploads.sign("abc"))).toBeNull();
    expect(uploads.verify(media.sign("abc"))).toBeNull();
  });
});
