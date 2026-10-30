import { InvalidInputError } from "../domain/errors.js";
import type { EngineMapper, NormalizedMessage } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import { type CompactMessage, identityOf, toCompact } from "./compact.js";
import { type Coverage, checkLimit, collectChats, parseIso } from "./fanout.js";
import type { ChatScope } from "./groups.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_WINDOW_MS = 30 * 86_400_000;
const MIN_QUERY = 2;
const MAX_QUERY = 200;
const SNIPPET_MAX = 280;

export interface SearchHit {
  chatId: string;
  chatName: string;
  isGroup: boolean;
  message: CompactMessage;
  /** Up to 280 chars of the matching field, centered on the first match. */
  snippet: string;
}

export interface SearchResult {
  query: string;
  from: string;
  to: string | null;
  /** The scope used, or null when a single `chatId` was searched. */
  scope: ChatScope | null;
  hits: SearchHit[];
  /** Matches found before `limit` was applied. */
  totalMatches: number;
  coverage: Coverage;
}

const strip = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");

/**
 * Matching ignores case and accents ("ano" also matches "año"). Returns the lowercase,
 * accent-free form of `text`, with each folded UTF-16 unit mapped to its source code point index.
 */
export function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  Array.from(text).forEach((ch, i) => {
    const plain = strip(strip(ch).toLowerCase());
    folded += plain;
    // One entry per UTF-16 unit: `indexOf` offsets are UTF-16, `i` is a code point index.
    for (let k = 0; k < plain.length; k++) map.push(i);
  });
  return { folded, map };
}

/** The searchable fields of a message, in priority order. */
function fieldsOf(m: NormalizedMessage): string[] {
  return [m.text, m.attachment?.caption, m.attachment?.filename].filter(
    (f): f is string => typeof f === "string" && f !== "",
  );
}

function snippetAround(text: string, start: number, len: number): string {
  const chars = Array.from(text);
  if (chars.length <= SNIPPET_MAX) return text;
  const room = SNIPPET_MAX - 2; // keeps both ellipses inside the budget
  const from = Math.max(0, Math.min(start - Math.floor((room - len) / 2), chars.length - room));
  const to = Math.min(chars.length, from + room);
  return `${from > 0 ? "…" : ""}${chars.slice(from, to).join("")}${to < chars.length ? "…" : ""}`;
}

/** The snippet of the first field containing `needle` (already folded), or null. */
function matchSnippet(m: NormalizedMessage, needle: string): string | null {
  for (const field of fieldsOf(m)) {
    const { folded, map } = fold(field);
    const at = folded.indexOf(needle);
    if (at === -1) continue;
    const start = map[at] as number;
    const end = (map[at + needle.length - 1] as number) + 1;
    return snippetAround(field, start, end - start);
  }
  return null;
}

/**
 * Case- and accent-insensitive search over text, caption and filename, newest hits first.
 * With `chatId` it reads that single chat (any type); otherwise it fans out over `scope`.
 */
export async function searchMessages(
  gw: WahaGateway,
  m: EngineMapper,
  q: {
    query: string;
    chatId?: string;
    scope?: ChatScope;
    from?: string;
    to?: string;
    limit?: number;
  },
  deps: { now?: () => number; statsMaxMessages: number },
): Promise<SearchResult> {
  const query = q.query.trim();
  const queryLength = Array.from(query).length;
  if (queryLength < MIN_QUERY || queryLength > MAX_QUERY)
    throw new InvalidInputError(
      `"query" must be between ${MIN_QUERY} and ${MAX_QUERY} characters after trimming.`,
    );
  const limit = checkLimit(q.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const now = (deps.now ?? Date.now)();
  const fromMs = parseIso(q.from, "from") ?? now - DEFAULT_WINDOW_MS;
  const toMs = parseIso(q.to, "to");
  if (toMs !== undefined && toMs < fromMs)
    throw new InvalidInputError('"from" must not be later than "to".');
  const from = new Date(fromMs).toISOString();
  const to = toMs === undefined ? undefined : new Date(toMs).toISOString();
  const needle = fold(query).folded;
  const who = identityOf(await gw.getMe());

  const scope = q.chatId === undefined ? (q.scope ?? "direct") : null;
  const { chats, coverage } = await collectChats(gw, m, {
    chatId: q.chatId,
    scope: scope ?? "direct",
    from,
    to,
    cap: deps.statsMaxMessages,
  });

  const all: SearchHit[] = [];
  for (const c of chats)
    for (const message of c.messages) {
      const snippet = matchSnippet(message, needle);
      if (snippet === null) continue;
      all.push({
        chatId: c.id,
        chatName: c.name,
        isGroup: c.isGroup,
        message: toCompact(message, who.isMine),
        snippet,
      });
    }
  all.sort(
    (a, b) =>
      (a.message.at < b.message.at ? 1 : a.message.at > b.message.at ? -1 : 0) ||
      a.chatId.localeCompare(b.chatId),
  );
  const hits = all.slice(0, limit);
  if (all.length > hits.length)
    coverage.notes.push(
      `Showing the newest ${hits.length} of ${all.length} matches; raise "limit" (max ${MAX_LIMIT}) or narrow the range to see the rest.`,
    );
  return { query, from, to: to ?? null, scope, hits, totalMatches: all.length, coverage };
}
