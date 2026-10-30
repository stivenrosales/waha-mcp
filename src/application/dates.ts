import { InvalidInputError } from "../domain/errors.js";

/** A formatter that reads wall-clock fields of an instant in `timezone` (IANA name). */
export function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new InvalidInputError(
      `Invalid timezone "${timezone}". Use an IANA name such as "America/Lima".`,
    );
  }
}

export function zoneParts(fmt: Intl.DateTimeFormat, ms: number): Record<string, number> {
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  return p;
}

/** Offset (ms) of the formatter's timezone from UTC at the instant `ms`. */
function offsetAt(fmt: Intl.DateTimeFormat, ms: number): number {
  const p = zoneParts(fmt, ms);
  const asUtc = Date.UTC(
    p.year ?? 0,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    (p.hour ?? 0) % 24,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant whose local wall-clock reading equals `wallMs` read as UTC fields (DST-safe). */
function wallToInstant(fmt: Intl.DateTimeFormat, wallMs: number): number {
  let ms = wallMs - offsetAt(fmt, wallMs);
  ms = wallMs - offsetAt(fmt, ms);
  return ms;
}

/** The instant at which local midnight of y-m-d happens in the timezone (DST-safe). */
export function localMidnight(fmt: Intl.DateTimeFormat, y: number, mo: number, d: number): number {
  return wallToInstant(fmt, Date.UTC(y, mo - 1, d));
}

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function realDate(y: number, mo: number, d: number): boolean {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Reads one range bound into epoch milliseconds.
 * - `YYYY-MM-DD`: local midnight in `timezone` for "start"; the last second of that local day for "end".
 * - ISO date-time with `Z` or an offset: taken as-is.
 * - ISO date-time without offset: read in `timezone`.
 * Anything else throws InvalidInputError.
 */
export function parseRangeBound(
  value: string,
  timezone: string,
  edge: "start" | "end",
  label = "date",
): number {
  const fail = () =>
    new InvalidInputError(
      `"${label}" must be an ISO 8601 date (YYYY-MM-DD) or date-time, got "${value}".`,
    );
  const text = value.trim();
  const fmt = zoneFormatter(timezone);

  const bare = BARE_DATE.exec(text);
  if (bare) {
    const [y, mo, d] = [Number(bare[1]), Number(bare[2]), Number(bare[3])];
    if (!realDate(y, mo, d)) throw fail();
    if (edge === "start") return localMidnight(fmt, y, mo, d);
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    return (
      localMidnight(fmt, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) - 1000
    );
  }

  const dt = DATE_TIME.exec(text);
  if (!dt) throw fail();
  const [y, mo, d] = [Number(dt[1]), Number(dt[2]), Number(dt[3])];
  if (!realDate(y, mo, d) || Number(dt[4]) > 23 || Number(dt[5]) > 59 || Number(dt[6] ?? 0) > 59)
    throw fail();
  const iso = text.replace(" ", "T");
  if (dt[7] !== undefined) {
    const ms = Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isNaN(ms)) throw fail();
    return ms;
  }
  const wall = Date.parse(`${iso}Z`);
  if (Number.isNaN(wall)) throw fail();
  return wallToInstant(fmt, wall);
}

/** Both bounds of an optional range, in epoch ms; rejects a range whose start is after its end. */
export function parseRange(
  q: { from?: string; to?: string },
  timezone: string,
): { from?: number; to?: number } {
  const from =
    q.from === undefined ? undefined : parseRangeBound(q.from, timezone, "start", "from");
  const to = q.to === undefined ? undefined : parseRangeBound(q.to, timezone, "end", "to");
  if (from !== undefined && to !== undefined && from > to)
    throw new InvalidInputError('"from" must not be later than "to".');
  return { from, to };
}
