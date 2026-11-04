const NOT_AS_EXPECTED = "Session status is not as expected";

/**
 * True when a WAHA error body says the session is not in the expected `WORKING` state.
 * Verified against WAHA 2026.9.2 (GOWS), which answers HTTP 422 with
 * `{ "error": "Session status is not as expected. Try again later or restart the session",
 * "session": "t_x", "status": "SCAN_QR_CODE", "expected": ["WORKING"] }`.
 * When `expected` is present it decides; the text (in `error` or `message`) is only a fallback,
 * because the QR endpoint sends the same text with `expected: ["SCAN_QR_CODE"]`.
 */
export function isSessionNotWorking(status: number, body: unknown): boolean {
  if (status !== 422 || typeof body !== "object" || body === null) return false;
  const o = body as Record<string, unknown>;
  if (Array.isArray(o.expected)) return o.expected.includes("WORKING");
  return [o.error, o.message].some((v) => typeof v === "string" && v.includes(NOT_AS_EXPECTED));
}
