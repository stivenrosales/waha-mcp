import type { ChatSummary, EngineMapper, NormalizedMessage } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import { type ChatScope, listChatsByScope } from "./groups.js";
import { fetchRange } from "./messages.js";

export const MAX_CHATS_PER_CALL = 100;
export const FETCH_CONCURRENCY = 5;

export interface Coverage {
  /** Chats whose messages were fetched successfully. */
  chatsScanned: number;
  /** Candidate chats beyond MAX_CHATS_PER_CALL that were not fetched. */
  chatsSkipped: number;
  /** True when anything is missing: skipped chats, failed chats or chats cut at the message cap. */
  truncated: boolean;
  failedChats: string[];
  notes: string[];
}

export interface ScannedChat {
  chat: ChatSummary;
  isGroup: boolean;
  messages: NormalizedMessage[];
  truncated: boolean;
}

/** Runs `fn` over `items` with at most `size` in flight; results keep the input order. */
export async function mapPool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/**
 * Multi-chat fan-out: candidates are the chats of `scope` whose last activity is at or after
 * `from`; the most recently active ones are fetched (newest messages first, `from`..`to`).
 * A chat whose fetch fails goes to `coverage.failedChats` instead of failing the call.
 */
export async function scanChats(
  gw: WahaGateway,
  m: EngineMapper,
  q: { scope: ChatScope; from: string; to?: string; cap: number },
): Promise<{ scanned: ScannedChat[]; coverage: Coverage }> {
  const fromMs = Date.parse(q.from);
  const { chats, namesResolved } = await listChatsByScope(gw, m, q.scope);
  let unknownActivity = 0;
  const candidates = chats
    .filter((c) => {
      if (c.lastActivity === null) {
        unknownActivity++;
        return false;
      }
      return Date.parse(c.lastActivity) >= fromMs;
    })
    .sort((a, b) => ((a.lastActivity ?? "") < (b.lastActivity ?? "") ? 1 : -1));
  const chosen = candidates.slice(0, MAX_CHATS_PER_CALL);

  const results = await mapPool(chosen, FETCH_CONCURRENCY, async (chat) => {
    try {
      const r = await fetchRange(gw, m, { chatId: chat.id, from: q.from, to: q.to, cap: q.cap });
      return { chat, isGroup: chat.id.endsWith("@g.us"), ...r } satisfies ScannedChat;
    } catch {
      return chat.id;
    }
  });
  const scanned = results.filter((r): r is ScannedChat => typeof r !== "string");
  const failedChats = results.filter((r): r is string => typeof r === "string");
  const cut = scanned.filter((s) => s.truncated).length;
  const skipped = candidates.length - chosen.length;

  const notes = [
    "Candidate chats come from WAHA's chat list, which can omit a chat that has recent messages; a chat missing there is not scanned.",
  ];
  if (skipped > 0)
    notes.push(
      `Only the ${MAX_CHATS_PER_CALL} most recently active chats were scanned; ${skipped} older candidates were skipped. Narrow the date range to see them.`,
    );
  if (cut > 0)
    notes.push(
      `${cut} chat(s) hit the per-chat cap of ${q.cap} messages: only their ${q.cap} newest messages of the range were read.`,
    );
  if (failedChats.length > 0)
    notes.push(
      `${failedChats.length} chat(s) could not be read from WAHA and are listed in failedChats.`,
    );
  if (unknownActivity > 0)
    notes.push(`${unknownActivity} chat(s) have no activity time in WAHA and were not considered.`);
  if (!namesResolved)
    notes.push("Contact names could not be loaded; direct chats may show only a phone or id.");

  return {
    scanned,
    coverage: {
      chatsScanned: scanned.length,
      chatsSkipped: skipped,
      truncated: skipped > 0 || cut > 0 || failedChats.length > 0,
      failedChats,
      notes,
    },
  };
}
