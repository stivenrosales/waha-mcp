import { createHmac, timingSafeEqual } from "node:crypto";

/** Deliveries older or newer than this are refused (replay window). */
const TOLERANCE_SECONDS = 5 * 60;

export interface WebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Standard Webhooks verification (https://www.standardwebhooks.com): HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the base64 key after `whsec_`, compared in constant time
 * against each `v1,<base64>` entry of the signature header.
 */
export function verifyStandardWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  nowMs: number = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
