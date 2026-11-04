/**
 * True when a WAHA error body says the session is not in the expected `WORKING` state.
 * WAHA answers HTTP 422 with e.g. `{ "message": "Session status is not as expected. Try again
 * later or restart the session", "session": "default", "status": "SCAN_QR_CODE",
 * "expected": ["WORKING"] }`.
 */
export function isSessionNotWorking(status: number, body: unknown): boolean {
  if (status !== 422 || typeof body !== "object" || body === null) return false;
  const o = body as Record<string, unknown>;
  if (Array.isArray(o.expected) && o.expected.includes("WORKING")) return true;
  return typeof o.message === "string" && o.message.includes("Session status is not as expected");
}
