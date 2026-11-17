import { typingDelayMs } from "../../domain/missions/pacing.js";
import type { SentMessage, WhatsAppSender } from "../../domain/ports/WhatsAppSender.js";

export interface PacedDeps {
  sender: WhatsAppSender;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
}

/** Presence is cosmetic: a failure here must never stop the reply. */
async function bestEffort(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Deliberately silent: never log message text, and the send still goes out.
  }
}

/**
 * Sends a mission reply the way a person would: read, type for a length-based pause,
 * then send. A `sendText` failure (including an unknown outcome) propagates unchanged.
 */
export async function sendPaced(
  deps: PacedDeps,
  q: { chatId: string; text: string; seenIds: string[] },
): Promise<SentMessage> {
  const { sender, sleep, rand } = deps;
  if (q.seenIds.length > 0)
    await bestEffort(() => sender.sendSeen({ chatId: q.chatId, messageIds: q.seenIds }));
  await bestEffort(() => sender.startTyping(q.chatId));
  await sleep(typingDelayMs(q.text, rand));
  await bestEffort(() => sender.stopTyping(q.chatId));
  return sender.sendText({ chatId: q.chatId, text: q.text });
}
