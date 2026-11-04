import { describe, expect, it } from "vitest";
import { isSessionNotWorking } from "../../../src/infrastructure/waha/sessionState.js";

/** Body captured from a live WAHA 2026.9.2 (GOWS) for a session waiting for its QR scan. */
const LIVE_BODY = {
  error: "Session status is not as expected. Try again later or restart the session",
  session: "t_zzvalidate",
  status: "SCAN_QR_CODE",
  expected: ["WORKING"],
};

describe("isSessionNotWorking", () => {
  it("recognises the 422 body WAHA sends for a session that is not WORKING", () => {
    expect(isSessionNotWorking(422, LIVE_BODY)).toBe(true);
  });

  it("falls back to the text in `error` when `expected` is missing", () => {
    const { expected: _expected, ...withoutExpected } = LIVE_BODY;
    expect(isSessionNotWorking(422, withoutExpected)).toBe(true);
  });

  it("still accepts the text in `message`", () => {
    expect(isSessionNotWorking(422, { message: LIVE_BODY.error })).toBe(true);
  });

  it("ignores a 422 that expects another state (the QR endpoint), and other statuses", () => {
    expect(isSessionNotWorking(422, { ...LIVE_BODY, expected: ["SCAN_QR_CODE"] })).toBe(false);
    expect(isSessionNotWorking(400, LIVE_BODY)).toBe(false);
  });
});
