import { describe, expect, it } from "vitest";
import { isSingleEmoji } from "../../src/application/emoji.js";

describe("isSingleEmoji", () => {
  it.each(["👍", "❤️", "👍🏽", "🇵🇪", "👨‍👩‍👧"])("accepts %s", (s) => {
    expect(isSingleEmoji(s)).toBe(true);
  });
  it.each(["ok", "👍👍", "a👍", " ", "", "1"])("rejects %j", (s) => {
    expect(isSingleEmoji(s)).toBe(false);
  });
});
