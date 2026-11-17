import type { MissionLimits } from "./limits.js";
import type { MissionSnapshot } from "./mission.js";

const BASE_MS = 1500;
const PER_CHAR_MS = 50;
const JITTER = 0.25;
const MIN_MS = 2000;
const MAX_MS = 15000;

export function typingDelayMs(text: string, rand: () => number): number {
  const base = BASE_MS + PER_CHAR_MS * text.length;
  const factor = 1 + (rand() * 2 - 1) * JITTER;
  return Math.min(MAX_MS, Math.max(MIN_MS, Math.round(base * factor)));
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

function localParts(at: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

function isQuietHour(hour: number, limits: MissionLimits): boolean {
  const { quietStartHour: start, quietEndHour: end } = limits;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

export function inQuietHours(at: Date, tz: string, limits: MissionLimits): boolean {
  return isQuietHour(localParts(at, tz).hour, limits);
}

/** UTC instant for a wall-clock time (minutes/seconds zero) in `tz`. */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  tz: string,
  near: Date,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour);
  const offsetAt = (instant: Date) => {
    const p = localParts(instant, tz);
    const floored = Math.floor(instant.getTime() / 3_600_000) * 3_600_000;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour) - floored;
  };
  const first = new Date(wall - offsetAt(near));
  return new Date(wall - offsetAt(first));
}

export function nextAllowedInitiatedSend(at: Date, tz: string, limits: MissionLimits): Date {
  const p = localParts(at, tz);
  if (!isQuietHour(p.hour, limits)) return at;
  // Same local day when we are after midnight but before the end hour; otherwise the next day.
  const dayShift = p.hour >= limits.quietEndHour ? 1 : 0;
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + dayShift));
  return zonedInstant(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    limits.quietEndHour,
    tz,
    at,
  );
}

export function reminderDue(m: MissionSnapshot, now: Date, limits: MissionLimits): boolean {
  if (m.state !== "active" || m.lastAgentAt === null) return false;
  const lastAgent = Date.parse(m.lastAgentAt);
  if (m.lastInboundAt !== null && Date.parse(m.lastInboundAt) >= lastAgent) return false;
  const cap = m.newContact ? limits.maxRemindersNewContact : limits.maxReminders;
  if (m.reminderCount >= cap) return false;
  const lastNudge = Math.max(lastAgent, m.lastReminderAt ? Date.parse(m.lastReminderAt) : 0);
  return now.getTime() - lastNudge >= limits.reminderGapMs;
}
