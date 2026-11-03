import { describe, expect, it } from "vitest";
import { createSignedLinks } from "../../../src/infrastructure/media/signedLink.js";
import { createUploadLinks } from "../../../src/infrastructure/uploads/uploadLinks.js";

const secret = new Uint8Array(32).fill(7);

describe("createUploadLinks", () => {
  it("round-trips an upload id", () => {
    const links = createUploadLinks(secret, 900);
    expect(links.verify(links.sign("abc"))).toBe("abc");
  });

  it("issues tokens that media links reject, and the other way round", () => {
    const uploads = createUploadLinks(secret, 900);
    const media = createSignedLinks({ secret, ttlSeconds: 900 });
    expect(media.verify(uploads.sign("abc"))).toBeNull();
    expect(uploads.verify(media.sign("abc"))).toBeNull();
  });
});
