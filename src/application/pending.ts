import { InvalidInputError } from "../domain/errors.js";
import type { EngineMapper } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import {
  assessWaiting,
  type CompactMessage,
  identityOf,
  isConversational,
  toCompact,
  type WaitReason,
} from "./compact.js";
import { type Coverage, scanChats } from "./fanout.js";
import type { ChatScope } from "./groups.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_WINDOW_MS = 7 * 86_400_000;
const LAST_MESSAGES = 5;
/** Total lastMessages across the answer (limit 200 x 5 stays within it). */
const TOTAL_MESSAGE_BUDGET = 1500;

export interface PendingChat {
  chatId: string;
  name: string;
  isGroup: boolean;
  waitingSince: string;
  waitingMinutes: number;
  unansweredCount: number;
  reason: WaitReason;
  /** Up to 5 newest conversational messages, oldest first. */
  lastMessages: CompactMessage[];
}

export interface PendingReplies {
  since: string;
  scope: ChatScope;
  pending: PendingChat[];
  /** Pending chats found before `limit` was applied. */
  totalPending: number;
  coverage: Coverage;
}

export interface FanoutDeps {
  now?: () => number;
  /** STATS_MAX_MESSAGES: per-chat cap. */
  statsMaxMessages: number;
}

/** Chats where the other side is waiting for the owner, longest wait first. */
export async function findPendingReplies(
  gw: WahaGateway,
  m: EngineMapper,
  q: { since?: string; scope?: ChatScope; limit?: number },
  deps: FanoutDeps,
): Promise<PendingReplies> {
  const now = (deps.now ?? Date.now)();
  const limit = q.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new InvalidInputError(`"limit" must be an integer between 1 and ${MAX_LIMIT}.`);
  let since: string;
  if (q.since === undefined) since = new Date(now - DEFAULT_WINDOW_MS).toISOString();
  else {
    const ms = Date.parse(q.since);
    if (Number.isNaN(ms))
      throw new InvalidInputError(`"since" must be an ISO 8601 date, got "${q.since}".`);
    since = new Date(ms).toISOString();
  }
  const scope = q.scope ?? "direct";

  const who = identityOf(await gw.getMe());
  const { scanned, coverage } = await scanChats(gw, m, {
    scope,
    from: since,
    cap: deps.statsMaxMessages,
  });

  const perChat = Math.max(1, Math.min(LAST_MESSAGES, Math.floor(TOTAL_MESSAGE_BUDGET / limit)));
  const all: PendingChat[] = [];
  for (const s of scanned) {
    const conversational = s.messages.filter(isConversational);
    const waiting = assessWaiting(conversational, s.isGroup, who);
    if (!waiting) continue;
    all.push({
      chatId: s.chat.id,
      name: s.chat.name ?? s.chat.phone ?? s.chat.id,
      isGroup: s.isGroup,
      waitingSince: waiting.waitingSince,
      waitingMinutes: Math.max(0, Math.floor((now - Date.parse(waiting.waitingSince)) / 60_000)),
      unansweredCount: waiting.unansweredCount,
      reason: waiting.reason,
      lastMessages: conversational
        .slice(0, perChat)
        .reverse()
        .map((msg) => toCompact(msg, who.isMine)),
    });
  }
  all.sort(
    (a, b) =>
      (a.waitingSince < b.waitingSince ? -1 : a.waitingSince > b.waitingSince ? 1 : 0) ||
      a.chatId.localeCompare(b.chatId),
  );
  return { since, scope, pending: all.slice(0, limit), totalPending: all.length, coverage };
}
