import { InvalidInputError } from "../domain/errors.js";
import type { GroupInfo, MessageType, NormalizedMessage } from "../domain/message.js";
import { isConversational } from "./compact.js";
import { messageKeys } from "./messages.js";

export interface ChatStats {
  totalMessages: number;
  perParticipant: {
    id: string;
    name: string | null;
    messages: number;
    byType: Partial<Record<MessageType, number>>;
  }[];
  perDay: { date: string; messages: number }[];
  perHour: { hour: number; messages: number }[];
  replies: { from: string; to: string; count: number }[];
  silentMembers: string[];
  /** Per party: how long they take to answer someone else (minutes). Owner is "me". */
  responseTimes: {
    party: string;
    replies: number;
    medianMinutes: number | null;
    averageMinutes: number | null;
  }[];
  coverage: {
    requestedFrom: string | null;
    requestedTo: string | null;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
    truncated: boolean;
    /** Reply gaps longer than 72 h that were left out of responseTimes. */
    ignoredGaps: number;
    note: string;
  };
}

export interface StatsOptions {
  chatId: string;
  timezone: string;
  requestedFrom: string | null;
  requestedTo: string | null;
  truncated: boolean;
  /** The STATS_MAX_MESSAGES cap that was applied; used in the coverage note. */
  cap?: number;
}

const isGroupId = (id: string) => id.endsWith("@g.us");

function bucketer(timezone: string): (d: Date) => { date: string; hour: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new InvalidInputError(
      `Invalid timezone "${timezone}". Use an IANA name such as "America/Lima".`,
    );
  }
  return (d) => {
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
  };
}

function coverageNote(
  o: StatsOptions,
  total: number,
  first: string | null,
  last: string | null,
  ignoredGaps: number,
) {
  if (total === 0)
    return "No messages returned for this chat and range. WAHA may have no stored history for it (message storage disabled or chat joined recently); this does NOT mean the chat was silent.";
  const span = `${total} messages from ${first} to ${last}.`;
  const gaps =
    ignoredGaps > 0
      ? ` Response times ignore ${ignoredGaps} gap${ignoredGaps === 1 ? "" : "s"} longer than 72 h (the conversation restarted).`
      : "";
  if (o.truncated)
    return `Partial coverage: only the ${o.cap ?? total} newest messages of the range were analysed (STATS_MAX_MESSAGES cap); older ones are not counted. ${span}${gaps}`;
  return `Complete for the stored history: ${span}${gaps}`;
}

const MAX_REPLY_GAP_MS = 72 * 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A reply is the first message of party B after a message of a party A ≠ B; it is timed from
 * the latest message of A. Only conversational messages count; gaps over 72 h are ignored.
 */
function computeResponseTimes(messages: NormalizedMessage[]) {
  const timed = messages
    .filter(
      (m) =>
        isConversational(m) &&
        (m.fromMe || m.author.id !== "") &&
        !Number.isNaN(Date.parse(m.timestamp)),
    )
    .map((m) => ({ m, at: Date.parse(m.timestamp) }))
    .sort((a, b) => a.at - b.at);
  const parties = new Map<string, { label: string; labelAt: number; gaps: number[] }>();
  const keyOf = (m: NormalizedMessage) => (m.fromMe ? "me" : m.author.id);
  let ignoredGaps = 0;
  let prev: { key: string; at: number } | null = null;
  for (const { m, at } of timed) {
    const key = keyOf(m);
    let party = parties.get(key);
    if (!party) {
      party = {
        label: m.fromMe ? "me" : (m.author.name ?? m.author.id),
        labelAt: -Infinity,
        gaps: [],
      };
      parties.set(key, party);
    }
    if (!m.fromMe && m.author.name !== null && at >= party.labelAt) {
      party.label = m.author.name;
      party.labelAt = at;
    }
    if (prev && prev.key !== key) {
      const gap = at - prev.at;
      if (gap > MAX_REPLY_GAP_MS) ignoredGaps++;
      else party.gaps.push(gap / 60_000);
    }
    prev = { key, at };
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
  };
  const responseTimes = [...parties.values()]
    .map(({ label, gaps }) => ({
      party: label,
      replies: gaps.length,
      medianMinutes: gaps.length ? round1(median(gaps)) : null,
      averageMinutes: gaps.length ? round1(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
    }))
    .sort((a, b) => b.replies - a.replies || a.party.localeCompare(b.party));
  return { responseTimes, ignoredGaps };
}

/**
 * Pure statistics over already-fetched messages. Reaction events are never part of
 * `messages`. For direct chats the two parties are derived from the messages and
 * `silentMembers` is always empty; for groups `participants` are the current members.
 */
export function computeChatStats(
  messages: NormalizedMessage[],
  participants: GroupInfo["participants"],
  opts: StatsOptions,
): ChatStats {
  const bucket = bucketer(opts.timezone);

  const perDay = new Map<string, number>();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, messages: 0 }));
  const people = new Map<
    string,
    {
      id: string;
      name: string | null;
      nameAt: number;
      messages: number;
      byType: Partial<Record<MessageType, number>>;
    }
  >();
  const index = new Map<string, NormalizedMessage>();
  let first: number | null = null;
  let last: number | null = null;

  for (const msg of messages) {
    const at = Date.parse(msg.timestamp);
    if (!Number.isNaN(at)) {
      first = first === null ? at : Math.min(first, at);
      last = last === null ? at : Math.max(last, at);
      const b = bucket(new Date(at));
      perDay.set(b.date, (perDay.get(b.date) ?? 0) + 1);
      const h = hours[b.hour];
      if (h) h.messages++;
    }
    for (const key of messageKeys(msg.id)) index.set(key, msg);
    if (msg.author.id === "") continue;
    let p = people.get(msg.author.id);
    if (!p) {
      p = { id: msg.author.id, name: null, nameAt: -Infinity, messages: 0, byType: {} };
      people.set(msg.author.id, p);
    }
    p.messages++;
    p.byType[msg.type] = (p.byType[msg.type] ?? 0) + 1;
    // Keep the name from the most recent message that has one.
    if (msg.author.name !== null && (Number.isNaN(at) ? 0 : at) >= p.nameAt) {
      p.name = msg.author.name;
      p.nameAt = Number.isNaN(at) ? 0 : at;
    }
  }

  const replyCounts = new Map<string, { from: string; to: string; count: number }>();
  for (const msg of messages) {
    if (!msg.replyToId || msg.author.id === "") continue;
    const target = index.get(msg.replyToId);
    if (!target || target.author.id === "") continue;
    const key = `${msg.author.id}\u0000${target.author.id}`;
    const entry = replyCounts.get(key) ?? { from: msg.author.id, to: target.author.id, count: 0 };
    entry.count++;
    replyCounts.set(key, entry);
  }

  let silentMembers: string[] = [];
  if (isGroupId(opts.chatId)) {
    const authorIds = new Set(people.keys());
    const authorPhones = new Set<string>();
    for (const msg of messages) if (msg.author.phone) authorPhones.add(msg.author.phone);
    silentMembers = participants
      .filter((p) => !authorIds.has(p.id) && !(p.phone !== null && authorPhones.has(p.phone)))
      .map((p) => p.id);
  }

  const { responseTimes, ignoredGaps } = computeResponseTimes(messages);
  const firstIso = first === null ? null : new Date(first).toISOString();
  const lastIso = last === null ? null : new Date(last).toISOString();
  return {
    totalMessages: messages.length,
    perParticipant: [...people.values()]
      .sort((a, b) => b.messages - a.messages || a.id.localeCompare(b.id))
      .map(({ id, name, messages: n, byType }) => ({ id, name, messages: n, byType })),
    perDay: [...perDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, n]) => ({ date, messages: n })),
    perHour: hours,
    replies: [...replyCounts.values()].sort((a, b) => b.count - a.count),
    silentMembers,
    responseTimes,
    coverage: {
      requestedFrom: opts.requestedFrom,
      requestedTo: opts.requestedTo,
      firstMessageAt: firstIso,
      lastMessageAt: lastIso,
      truncated: opts.truncated,
      ignoredGaps,
      note: coverageNote(opts, messages.length, firstIso, lastIso, ignoredGaps),
    },
  };
}
