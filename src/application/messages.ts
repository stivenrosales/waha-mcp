import { InvalidInputError } from "../domain/errors.js";
import type { EngineMapper, NormalizedMessage } from "../domain/message.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RANGE_PAGE = 200;

/** ISO string -> unix seconds, or undefined when absent. */
function toUnix(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms))
    throw new InvalidInputError(`"${label}" must be an ISO 8601 date, got "${value}".`);
  return Math.floor(ms / 1000);
}

/** WAHA ids look like `false_<chat>_<stanzaId>[_<sender>]`; replies and reactions use the bare stanza id. */
export function messageKeys(id: string): string[] {
  const keys = [id];
  const stanza = id.split("_")[2];
  if (stanza) keys.push(stanza);
  return keys;
}

/**
 * Maps raw WAHA messages, preserving their order, and folds reaction events into the
 * message they target. A reaction whose target is not in `raws` is dropped. Reaction
 * events are never returned as messages.
 */
function mapAndAttach(m: EngineMapper, raws: unknown[]): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const reactions: NonNullable<ReturnType<EngineMapper["reaction"]>>[] = [];
  for (const raw of raws) {
    const reaction = m.reaction(raw);
    if (reaction) reactions.push(reaction);
    else messages.push(m.message(raw));
  }
  if (reactions.length > 0) {
    const index = new Map<string, NormalizedMessage>();
    for (const msg of messages) for (const key of messageKeys(msg.id)) index.set(key, msg);
    for (const r of reactions) index.get(r.targetId)?.reactions.push(r.reaction);
  }
  return messages;
}

/**
 * Ordering: NEWEST FIRST, exactly as WAHA returns it (verified against the fixtures).
 * Pagination uses WAHA's offset over raw events, so a page may hold fewer than `limit`
 * messages when it contains reaction events.
 */
export async function getMessages(
  gw: WahaGateway,
  m: EngineMapper,
  q: { chatId: string; from?: string; to?: string; limit?: number; cursor?: string },
): Promise<{ messages: NormalizedMessage[]; nextCursor: string | null }> {
  const limit = q.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new InvalidInputError(`"limit" must be an integer between 1 and ${MAX_LIMIT}.`);
  const from = toUnix(q.from, "from");
  const to = toUnix(q.to, "to");
  let offset = 0;
  if (q.cursor !== undefined) {
    const c = decodeCursor(q.cursor);
    if (c.from !== (q.from ?? null) || c.to !== (q.to ?? null))
      throw new InvalidInputError(
        "This cursor belongs to a different date range. Repeat the call without a cursor to start over.",
      );
    offset = c.offset;
  }
  const raws = await gw.getMessages(q.chatId, { limit, offset, from, to });
  const nextCursor =
    raws.length < limit
      ? null
      : encodeCursor({ offset: offset + raws.length, from: q.from ?? null, to: q.to ?? null });
  return { messages: mapAndAttach(m, raws), nextCursor };
}

/**
 * Fetches up to `cap` messages of the range, NEWEST FIRST, in pages of 200.
 * `truncated` is true only when older messages exist beyond the cap.
 */
export async function fetchRange(
  gw: WahaGateway,
  m: EngineMapper,
  q: { chatId: string; from?: string; to?: string; cap: number },
): Promise<{ messages: NormalizedMessage[]; truncated: boolean }> {
  const from = toUnix(q.from, "from");
  const to = toUnix(q.to, "to");
  const raws: unknown[] = [];
  let counted = 0;
  // Read until we hold one message more than the cap (proof that the cap cut something) or run out.
  while (counted <= q.cap) {
    const page = await gw.getMessages(q.chatId, {
      limit: RANGE_PAGE,
      offset: raws.length,
      from,
      to,
    });
    for (const raw of page) {
      raws.push(raw);
      if (!m.reaction(raw)) counted++;
    }
    if (page.length < RANGE_PAGE) break;
  }
  const all = mapAndAttach(m, raws);
  const truncated = all.length > q.cap;
  return { messages: truncated ? all.slice(0, q.cap) : all, truncated };
}
