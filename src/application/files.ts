import { InvalidInputError } from "../domain/errors.js";
import type { EngineMapper, NormalizedMessage } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import { type Coverage, checkLimit, collectChats, parseIso } from "./fanout.js";
import type { ChatScope } from "./groups.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_WINDOW_MS = 30 * 86_400_000;

export const FILE_KINDS = [
  "document",
  "image",
  "video",
  "audio",
  "voice",
  "sticker",
  "link",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface SharedFile {
  chatId: string;
  chatName: string;
  messageId: string;
  at: string;
  kind: FileKind;
  filename: string | null;
  mimetype: string | null;
  size: number | null;
  /** Links only. */
  url: string | null;
  /** Pass to get_media; attachments only. */
  mediaId: string | null;
}

export interface SharedFilesResult {
  from: string;
  to: string | null;
  /** The scope used, or null when a single `chatId` was read. */
  scope: ChatScope | null;
  kind: FileKind | null;
  items: SharedFile[];
  /** Matches found before `limit` was applied. */
  totalMatches: number;
  coverage: Coverage;
}

const URL_RE = /(?<![\w])https?:\/\/[^\s<>"`]+/gi;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'"]);
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
/** Longer URLs are skipped (and counted), never truncated. */
export const MAX_URL_LENGTH = 2048;
const MAX_FILENAME_LENGTH = 255;

/** Drops punctuation that ends a sentence, and closing brackets the URL never opened. One pass. */
function trimUrl(url: string): string {
  const open: Record<string, number> = {};
  for (const ch of url) open[ch] = (open[ch] ?? 0) + 1;
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] as string;
    const opener = PAIRS[last];
    if (TRAILING.has(last) || (opener !== undefined && (open[last] ?? 0) > (open[opener] ?? 0))) {
      open[last] = (open[last] ?? 0) - 1;
      end--;
    } else break;
  }
  return url.slice(0, end);
}

/** Links of a text plus how many were skipped for exceeding MAX_URL_LENGTH. */
function scanLinks(text: string): { urls: string[]; skipped: number } {
  const out = new Set<string>();
  let skipped = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match[0].length > MAX_URL_LENGTH) {
      skipped++;
      continue;
    }
    const url = trimUrl(match[0]);
    if (/^https?:\/\/[^/?#\s]+/i.test(url)) out.add(url);
  }
  return { urls: [...out], skipped };
}

/** Conservative `http(s)://` links of a text, in order of appearance, without duplicates. */
export function extractLinks(text: string): string[] {
  return scanLinks(text).urls;
}

/** Links of the text and of the caption, deduped per message. */
function linksOf(m: NormalizedMessage): { urls: string[]; skipped: number } {
  const out = new Set<string>();
  let skipped = 0;
  for (const field of [m.text, m.attachment?.caption])
    if (field) {
      const r = scanLinks(field);
      skipped += r.skipped;
      for (const url of r.urls) out.add(url);
    }
  return { urls: [...out], skipped };
}

const cutName = (name: string | null) =>
  name === null || Array.from(name).length <= MAX_FILENAME_LENGTH
    ? name
    : `${Array.from(name)
        .slice(0, MAX_FILENAME_LENGTH - 1)
        .join("")}…`;

/**
 * Documents, media and links shared in chats, newest first. With `chatId` it reads that
 * single chat (any type); otherwise it fans out over `scope`. Same range/coverage rules
 * as `searchMessages`.
 */
export async function listSharedFiles(
  gw: WahaGateway,
  m: EngineMapper,
  q: {
    chatId?: string;
    scope?: ChatScope;
    kind?: FileKind;
    from?: string;
    to?: string;
    limit?: number;
  },
  deps: { now?: () => number; statsMaxMessages: number },
): Promise<SharedFilesResult> {
  if (q.kind !== undefined && !FILE_KINDS.includes(q.kind))
    throw new InvalidInputError(`"kind" must be one of: ${FILE_KINDS.join(", ")}.`);
  const limit = checkLimit(q.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const now = (deps.now ?? Date.now)();
  const fromMs = parseIso(q.from, "from") ?? now - DEFAULT_WINDOW_MS;
  const toMs = parseIso(q.to, "to");
  if (toMs !== undefined && toMs < fromMs)
    throw new InvalidInputError('"from" must not be later than "to".');
  const from = new Date(fromMs).toISOString();
  const to = toMs === undefined ? undefined : new Date(toMs).toISOString();
  const scope = q.chatId === undefined ? (q.scope ?? "direct") : null;

  const { chats, coverage } = await collectChats(gw, m, {
    chatId: q.chatId,
    scope: scope ?? "direct",
    from,
    to,
    cap: deps.statsMaxMessages,
  });

  const all: SharedFile[] = [];
  let skippedLinks = 0;
  for (const c of chats)
    for (const message of c.messages) {
      const base = { chatId: c.id, chatName: c.name, messageId: message.id, at: message.timestamp };
      const a = message.attachment;
      if (a && (q.kind === undefined || q.kind === a.kind))
        all.push({
          ...base,
          kind: a.kind,
          filename: cutName(a.filename),
          mimetype: a.mimetype,
          size: a.size,
          url: null,
          mediaId: a.mediaId,
        });
      if (q.kind === undefined || q.kind === "link") {
        const { urls, skipped } = linksOf(message);
        skippedLinks += skipped;
        for (const url of urls)
          all.push({
            ...base,
            kind: "link",
            filename: null,
            mimetype: null,
            size: null,
            url,
            mediaId: null,
          });
      }
    }
  // Array.sort is stable: items of one message keep attachment-then-links order.
  all.sort(
    (a, b) =>
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
      a.chatId.localeCompare(b.chatId) ||
      a.messageId.localeCompare(b.messageId),
  );
  if (skippedLinks > 0)
    coverage.notes.push(
      `${skippedLinks} link(s) longer than ${MAX_URL_LENGTH} characters were skipped.`,
    );
  const items = all.slice(0, limit);
  if (all.length > items.length)
    coverage.notes.push(
      `Showing the newest ${items.length} of ${all.length} matches; raise "limit" (max ${MAX_LIMIT}) or narrow the range to see the rest.`,
    );
  return {
    from,
    to: to ?? null,
    scope,
    kind: q.kind ?? null,
    items,
    totalMatches: all.length,
    coverage,
  };
}
