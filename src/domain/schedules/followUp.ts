const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The longest follow-up window: 30 days. */
export const MAX_REPLY_WINDOW_MS = 30 * DAY_MS;

/**
 * A follow-up window, `"48h"` or `"3d"` (case-insensitive, surrounding spaces ignored), in
 * milliseconds; null when it is malformed or outside 1 hour – 30 days.
 */
export function parseReplyWindow(input: string): number | null {
  const m = /^([1-9]\d{0,3})([hd])$/i.exec(input.trim());
  if (!m) return null;
  const ms = Number(m[1]) * (m[2]?.toLowerCase() === "d" ? DAY_MS : HOUR_MS);
  return ms <= MAX_REPLY_WINDOW_MS ? ms : null;
}

/** A window in its shortest exact form: whole days as `"3d"`, otherwise hours (`"36h"`). */
export function formatReplyWindow(ms: number): string {
  return ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${Math.round(ms / HOUR_MS)}h`;
}
