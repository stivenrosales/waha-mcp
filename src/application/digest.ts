import { InvalidInputError } from "../domain/errors.js";
import type { EngineMapper } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import {
  assessWaiting,
  type CompactMessage,
  identityOf,
  isConversational,
  toCompact,
} from "./compact.js";
import { type Coverage, scanChats } from "./fanout.js";
import type { ChatScope } from "./groups.js";
import type { FanoutDeps } from "./pending.js";

const MAX_MESSAGES = 30;
const MIN_MESSAGES = 5;
/** Total compact messages across all chats, so the answer fits a client's context. */
export const TOTAL_MESSAGE_BUDGET = 1500;
const OLD_DAY_MS = 7 * 86_400_000;

export interface DigestChat {
  chatId: string;
  name: string;
  isGroup: boolean;
  messageCount: number;
  lastFrom: string;
  awaitingReply: boolean;
  /** The newest 30 messages of the range, oldest first. */
  messages: CompactMessage[];
  /** Messages of the range not included in `messages`. */
  messagesOmitted: number;
}

export interface ActivityDigest {
  from: string;
  to: string;
  timezone: string;
  scope: ChatScope;
  chats: DigestChat[];
  coverage: Coverage;
}

function formatter(timezone: string): Intl.DateTimeFormat {
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

function parts(fmt: Intl.DateTimeFormat, ms: number): Record<string, number> {
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  return p;
}

/** Offset (ms) of `timezone` from UTC at the instant `ms`. */
function offsetAt(fmt: Intl.DateTimeFormat, ms: number): number {
  const p = parts(fmt, ms);
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

/** The instant at which local midnight of y-m-d happens in the timezone (DST-safe). */
function localMidnight(fmt: Intl.DateTimeFormat, y: number, mo: number, d: number): number {
  const guess = Date.UTC(y, mo - 1, d);
  let ms = guess - offsetAt(fmt, guess);
  ms = guess - offsetAt(fmt, ms);
  return ms;
}

function dayRange(date: string, fmt: Intl.DateTimeFormat): { from: number; to: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [y, mo, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (
    !match ||
    real.getUTCFullYear() !== y ||
    real.getUTCMonth() !== mo - 1 ||
    real.getUTCDate() !== d
  )
    throw new InvalidInputError(
      `"date" must be a real calendar date as YYYY-MM-DD, got "${date}".`,
    );
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const start = localMidnight(fmt, y, mo, d);
  const end = localMidnight(fmt, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return { from: start, to: end - 1000 };
}

function isoInput(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms))
    throw new InvalidInputError(`"${label}" must be an ISO 8601 date, got "${value}".`);
  return ms;
}

/** Every chat with activity in a day (in `timezone`) or an explicit range, in one call. */
export async function buildActivityDigest(
  gw: WahaGateway,
  m: EngineMapper,
  q: { date?: string; from?: string; to?: string; timezone?: string; scope?: ChatScope },
  deps: FanoutDeps,
): Promise<ActivityDigest> {
  const now = (deps.now ?? Date.now)();
  const timezone = q.timezone ?? "UTC";
  const fmt = formatter(timezone);
  if (q.date !== undefined && (q.from !== undefined || q.to !== undefined))
    throw new InvalidInputError('Use either "date" or "from"/"to", not both.');
  let from: number;
  let to: number;
  if (q.from !== undefined || q.to !== undefined) {
    from = q.from !== undefined ? isoInput(q.from, "from") : 0;
    to = q.to !== undefined ? isoInput(q.to, "to") : now;
  } else {
    const p = parts(fmt, now);
    const today = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    ({ from, to } = dayRange(q.date ?? today, fmt));
  }
  const scope = q.scope ?? "direct";
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();

  const who = identityOf(await gw.getMe());
  const { scanned, coverage } = await scanChats(gw, m, {
    scope,
    from: fromIso,
    to: toIso,
    cap: deps.statsMaxMessages,
  });

  const active = scanned
    .map((s) => ({ s, conversational: s.messages.filter(isConversational) }))
    .filter((x) => x.conversational.length > 0);
  const window = Math.max(
    MIN_MESSAGES,
    Math.min(MAX_MESSAGES, Math.floor(TOTAL_MESSAGE_BUDGET / Math.max(1, active.length))),
  );
  const notes = [...coverage.notes];
  if (window < MAX_MESSAGES)
    notes.push(
      `Per-chat message window reduced to ${window} to fit ${active.length} active chats; see messagesOmitted per chat and use get_messages for the rest.`,
    );
  if (to < now - OLD_DAY_MS && coverage.chatsSkipped > 0)
    notes.push(
      "This range ended more than 7 days ago and chats were skipped: candidates are picked by last activity, so older days may miss chats that have been quiet since.",
    );

  const chats: (DigestChat & { lastAt: string })[] = [];
  for (const { s, conversational } of active) {
    const newest = conversational[0];
    if (!newest) continue;
    const shown = conversational.slice(0, window).reverse();
    chats.push({
      chatId: s.chat.id,
      name: s.chat.name ?? s.chat.phone ?? s.chat.id,
      isGroup: s.isGroup,
      messageCount: conversational.length,
      lastFrom: toCompact(newest, who.isMine).from,
      awaitingReply: assessWaiting(conversational, s.isGroup, who) !== null,
      messages: shown.map((msg) => toCompact(msg, who.isMine)),
      messagesOmitted: conversational.length - shown.length,
      lastAt: newest.timestamp,
    });
  }
  chats.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  return {
    from: fromIso,
    to: toIso,
    timezone,
    scope,
    chats: chats.map(({ lastAt: _lastAt, ...c }) => c),
    coverage: { ...coverage, notes },
  };
}
