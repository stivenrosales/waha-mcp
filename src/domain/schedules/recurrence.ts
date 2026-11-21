import { InvalidInputError } from "../errors.js";

export type ScheduleRepeat = "none" | "daily" | "weekly" | "monthly" | "yearly";

interface LocalFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const FORMAT_HINT = "Use the format YYYY-MM-DD HH:mm, e.g. 2026-12-05 09:00.";
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

function localFields(at: Date, tz: string): LocalFields {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function wallAsUtc(f: LocalFields): number {
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute);
}

/** Instant whose wall clock in `tz` reads `f` (guess as UTC, correct by the zone offset twice). */
function toInstant(f: LocalFields, tz: string): Date {
  const wall = wallAsUtc(f);
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    const seen = wallAsUtc(localFields(new Date(instant), tz));
    instant -= seen - wall;
  }
  return new Date(instant);
}

export function parseLocalDateTime(text: string, tz: string): Date {
  const match = LOCAL_PATTERN.exec(text.trim());
  if (!match) throw new InvalidInputError(FORMAT_HINT);
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const check = new Date(Date.UTC(year, month - 1, day));
  const valid =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    hour < 24 &&
    minute < 60;
  if (!valid) throw new InvalidInputError(FORMAT_HINT);
  return toInstant({ year, month, day, hour, minute }, tz);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The `index`-th occurrence (0 = `first`), always derived from `first`, never from the previous run. */
export function occurrenceAt(first: Date, repeat: ScheduleRepeat, index: number, tz: string): Date {
  if (repeat === "none" || index === 0) return first;
  const base = localFields(first, tz);
  if (repeat === "daily" || repeat === "weekly") {
    const shifted = new Date(
      Date.UTC(base.year, base.month - 1, base.day + index * (repeat === "weekly" ? 7 : 1)),
    );
    return toInstant(
      {
        ...base,
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
      },
      tz,
    );
  }
  const monthIndex = base.month - 1 + (repeat === "monthly" ? index : index * 12);
  const year = base.year + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const day = Math.min(base.day, daysInMonth(year, month));
  return toInstant({ ...base, year, month, day }, tz);
}

export function formatLocal(at: Date, tz: string): string {
  const f = localFields(at, tz);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)}`;
}
