import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStandardWebhook } from "../../../src/infrastructure/billing/standardWebhooks.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = 1_800_000_000_000;
const sign = (id: string, ts: string, body: string, key = KEY) =>
  `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
const headers = (over: Record<string, string> = {}) => ({
  id: "msg_1",
  timestamp: String(NOW / 1000),
  signature: sign("msg_1", String(NOW / 1000), "{}"),
  ...over,
});

describe("verifyStandardWebhook", () => {
  it("accepts a correctly signed, recent delivery", () => {
    expect(verifyStandardWebhook(SECRET, headers(), "{}", NOW)).toBe(true);
  });

  it("accepts when any of several space-separated signatures matches", () => {
    const h = headers({ signature: `v1,AAAA ${sign("msg_1", String(NOW / 1000), "{}")}` });
    expect(verifyStandardWebhook(SECRET, h, "{}", NOW)).toBe(true);
  });

  it("rejects a tampered body, a wrong key, or a missing header", () => {
    expect(verifyStandardWebhook(SECRET, headers(), '{"x":1}', NOW)).toBe(false);
    const other = headers({
      signature: sign("msg_1", String(NOW / 1000), "{}", Buffer.from("x".repeat(32))),
    });
    expect(verifyStandardWebhook(SECRET, other, "{}", NOW)).toBe(false);
    expect(verifyStandardWebhook(SECRET, { ...headers(), signature: undefined }, "{}", NOW)).toBe(
      false,
    );
    expect(verifyStandardWebhook(SECRET, headers({ signature: "garbage" }), "{}", NOW)).toBe(false);
  });

  it("rejects deliveries older or newer than 5 minutes", () => {
    const ts = String(NOW / 1000 - 301);
    expect(
      verifyStandardWebhook(
        SECRET,
        headers({ timestamp: ts, signature: sign("msg_1", ts, "{}") }),
        "{}",
        NOW,
      ),
    ).toBe(false);
    const future = String(NOW / 1000 + 301);
    expect(
      verifyStandardWebhook(
        SECRET,
        headers({ timestamp: future, signature: sign("msg_1", future, "{}") }),
        "{}",
        NOW,
      ),
    ).toBe(false);
  });
});
