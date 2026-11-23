import { SendOutcomeUnknownError } from "../domain/errors.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";
import type { SentMessage, WhatsAppSender } from "../domain/ports/WhatsAppSender.js";

/** How long a send with an unknown outcome makes an identical send check the chat first. */
export const UNKNOWN_SEND_WINDOW_MS = 10 * 60_000;
/** Clock skew allowed between this server and WhatsApp's message timestamps. */
const SKEW_SECONDS = 60;
const HISTORY_LIMIT = 20;

export interface SendGuardDeps {
  /** Read straight from WAHA, not from a cache, so the check sees the latest messages. */
  gateway: Pick<WahaGateway, "getMessages">;
  now?: () => number;
  windowMs?: number;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/**
 * After a text send whose outcome is unknown, an identical send to the same chat within the
 * window first reads the chat: if the first message arrived, it is not sent again. The server
 * enforces this instead of relying on the client to check before retrying.
 */
export function guardUnknownSends(sender: WhatsAppSender, deps: SendGuardDeps): WhatsAppSender {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? UNKNOWN_SEND_WINDOW_MS;
  /** `chatId\ntext` → when the send with unknown outcome started (ms). */
  const pending = new Map<string, number>();

  async function findEarlier(
    chatId: string,
    text: string,
    since: number,
  ): Promise<SentMessage | null> {
    const fromSeconds = Math.floor(since / 1000) - SKEW_SECONDS;
    let page: unknown[];
    try {
      page = await deps.gateway.getMessages(chatId, {
        limit: HISTORY_LIMIT,
        offset: 0,
        from: fromSeconds,
      });
    } catch {
      // Without the history we cannot tell; sending could duplicate the message.
      throw new SendOutcomeUnknownError();
    }
    for (const raw of page) {
      const m = asRecord(raw);
      const ts = typeof m.timestamp === "number" ? m.timestamp : null;
      if (
        m.fromMe === true &&
        m.body === text &&
        typeof m.id === "string" &&
        (ts === null || ts >= fromSeconds)
      )
        return { id: m.id, timestamp: ts, alreadySent: true };
    }
    return null;
  }

  return {
    ...sender,
    async sendText(q) {
      const key = `${q.chatId}\n${q.text}`;
      for (const [k, at] of pending) if (now() - at > windowMs) pending.delete(k);
      const since = pending.get(key);
      if (since !== undefined) {
        const earlier = await findEarlier(q.chatId, q.text, since);
        pending.delete(key);
        if (earlier) return earlier;
      }
      const startedAt = now();
      try {
        return await sender.sendText(q);
      } catch (err) {
        if (err instanceof SendOutcomeUnknownError) pending.set(key, startedAt);
        throw err;
      }
    },
  };
}
