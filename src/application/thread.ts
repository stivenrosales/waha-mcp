import { InvalidInputError } from "../domain/errors.js";
import type { EngineMapper, NormalizedMessage } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import { getMessages, messageKeys } from "./messages.js";

const DEFAULT_CONTEXT = 10;
const MAX_CONTEXT = 50;
const PAGE = 200;
const MAX_CHAIN = 10;

export interface Thread {
  chatId: string;
  anchor: NormalizedMessage;
  /** Older messages right before the anchor, oldest first. */
  before: NormalizedMessage[];
  /** Newer messages right after the anchor, oldest first. */
  after: NormalizedMessage[];
  /** Messages the anchor replies to, transitively, oldest first (anchor excluded). */
  replyChain: NormalizedMessage[];
  coverage: {
    messagesRead: number;
    /** Reply ancestors that are not in the fetched history. */
    missingAncestors: string[];
    notes: string[];
  };
}

function context(value: number | undefined, label: string): number {
  const n = value ?? DEFAULT_CONTEXT;
  if (!Number.isInteger(n) || n < 0 || n > MAX_CONTEXT)
    throw new InvalidInputError(`"${label}" must be an integer between 0 and ${MAX_CONTEXT}.`);
  return n;
}

/**
 * Window around one message of a chat. History is read newest first with WAHA offset paging
 * until the anchor and `before` older messages are in hand, or `statsMaxMessages` is reached.
 */
export async function getThread(
  gw: WahaGateway,
  m: EngineMapper,
  q: { chatId: string; messageId: string; before?: number; after?: number },
  deps: { statsMaxMessages: number },
): Promise<Thread> {
  const before = context(q.before, "before");
  const after = context(q.after, "after");
  const wanted = new Set(messageKeys(q.messageId));
  const isAnchor = (msg: NormalizedMessage) => messageKeys(msg.id).some((k) => wanted.has(k));

  const history: NormalizedMessage[] = []; // newest first
  const seen = new Set<string>();
  let anchorAt = -1;
  let cursor: string | undefined;
  let cacheNote: string | undefined;
  do {
    const page = await getMessages(gw, m, { chatId: q.chatId, limit: PAGE, cursor });
    cacheNote = page.cacheNote;
    let added = 0;
    for (const msg of page.messages) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      history.push(msg);
      added++;
    }
    if (anchorAt === -1) anchorAt = history.findIndex(isAnchor);
    // A page with nothing new means the cursor is not advancing: stop instead of looping.
    cursor = added === 0 ? undefined : (page.nextCursor ?? undefined);
  } while (
    cursor !== undefined &&
    history.length < deps.statsMaxMessages &&
    (anchorAt === -1 || history.length - anchorAt - 1 < before)
  );

  const anchor = history[anchorAt];
  if (anchorAt === -1 || !anchor)
    throw new InvalidInputError(
      `Message "${q.messageId}" not found in the recent history of this chat: message not found in the recent history (the last ${Math.min(history.length, deps.statsMaxMessages)} messages were searched). Check the id, or read the chat with get_messages.`,
    );

  const index = new Map<string, NormalizedMessage>();
  for (const msg of history) for (const k of messageKeys(msg.id)) index.set(k, msg);
  const chain: NormalizedMessage[] = [];
  const missingAncestors: string[] = [];
  const visited = new Set([anchor.id]);
  let chainStop: "cap" | "cycle" | null = null;
  for (let cur = anchor; cur.replyToId !== null; ) {
    const parent = index.get(cur.replyToId);
    if (!parent) {
      missingAncestors.push(cur.replyToId);
      break;
    }
    if (visited.has(parent.id)) {
      chainStop = "cycle";
      break;
    }
    if (chain.length >= MAX_CHAIN) {
      chainStop = "cap";
      break;
    }
    visited.add(parent.id);
    chain.push(parent);
    cur = parent;
  }

  const notes: string[] = [];
  if (missingAncestors.length > 0)
    notes.push(
      `Reply ancestor ${missingAncestors.map((id) => `"${id}"`).join(", ")} is not in the fetched history (too old, deleted or not stored by WAHA), so the chain stops there.`,
    );
  if (chainStop === "cap")
    notes.push(
      `The reply chain was cut at ${MAX_CHAIN} ancestors; older ones exist in the history.`,
    );
  if (chainStop === "cycle")
    notes.push("The reply chain stopped because the replies loop back on themselves.");
  if (anchorAt + 1 + before > history.length && cursor !== undefined)
    notes.push(`Older context was cut at the cap of ${deps.statsMaxMessages} messages.`);
  if (cacheNote) notes.push(cacheNote);
  return {
    chatId: q.chatId,
    anchor,
    before: history.slice(anchorAt + 1, anchorAt + 1 + before).reverse(),
    after: history.slice(Math.max(0, anchorAt - after), anchorAt).reverse(),
    replyChain: chain.reverse(),
    coverage: { messagesRead: history.length, missingAncestors, notes },
  };
}
