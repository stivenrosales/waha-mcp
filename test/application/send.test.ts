import { describe, expect, it } from "vitest";
import {
  assertMentions,
  assertTextLength,
  MAX_TEXT_CHARS,
  pickMediaKind,
} from "../../src/application/send.js";
import { InvalidInputError } from "../../src/domain/errors.js";

describe("assertMentions", () => {
  it("accepts mentions whose number appears as @number in the text", () => {
    expect(() => assertMentions("hola @51999 y @12345", ["51999@c.us", "12345@lid"])).not.toThrow();
    expect(() => assertMentions("sin menciones", [])).not.toThrow();
  });

  it("rejects a mention missing from the text", () => {
    expect(() => assertMentions("hola @51999", ["51888@c.us"])).toThrow(InvalidInputError);
    expect(() => assertMentions("hola @51999", ["51888@c.us"])).toThrow(
      "Mention @51888 is not in the text.",
    );
    expect(() => assertMentions("hola @519990", ["51999@c.us"])).toThrow(InvalidInputError);
  });
});

describe("assertTextLength", () => {
  it("allows up to WhatsApp's limit and rejects longer text", () => {
    expect(MAX_TEXT_CHARS).toBe(65536);
    expect(() => assertTextLength("x".repeat(65536))).not.toThrow();
    expect(() => assertTextLength("x".repeat(65537))).toThrow(InvalidInputError);
  });
});

describe("pickMediaKind", () => {
  it("picks the WhatsApp message kind from the mimetype", () => {
    expect(pickMediaKind("image/jpeg", "auto")).toBe("image");
    expect(pickMediaKind("image/png", "auto")).toBe("image");
    expect(pickMediaKind("image/svg+xml", "auto")).toBe("document");
    expect(pickMediaKind("image/gif", "auto")).toBe("video");
    expect(pickMediaKind("video/mp4", "auto")).toBe("video");
    expect(pickMediaKind("audio/ogg; codecs=opus", "auto")).toBe("voice");
    expect(pickMediaKind("application/pdf", "auto")).toBe("document");
    expect(pickMediaKind("application/octet-stream", "auto")).toBe("document");
  });

  it("honors an explicit choice", () => {
    expect(pickMediaKind("image/png", "document")).toBe("document");
    expect(pickMediaKind("audio/mpeg", "document")).toBe("document");
  });
});
