import { z } from "zod";
import { InvalidInputError } from "../../../domain/errors.js";
import type { SentMessage } from "../../../domain/ports/WhatsAppSender.js";
import type { Logger, ToolRunContext } from "../defineTool.js";

/** WhatsApp's formatting syntax, repeated wherever the model writes text that will be sent. */
export const WHATSAPP_FORMAT_RULES = `Write in WhatsApp formatting, not Markdown:
- *bold*, _italic_, ~strikethrough~, \`\`\`monospace\`\`\`, \`inline code\`; markers must touch the text (*bold*, not * bold *) and can be combined (*_bold italic_*).
- "> " quote, "- " or "* " bulleted list, "1. " numbered list, each at the start of a line.
- No headings, no tables, no [text](url) links (paste the bare URL), no HTML.
- Write it exactly as the owner would send it: no preamble such as "Here is your message".
Common Markdown (**bold**, # headings, links, tables) is converted automatically; the result reports the final text sent.`;

export const SEND_POLICY =
  "Send only when the owner explicitly asked to send this in the conversation; show them the final content and the recipient first. Never retry on your own.";

export const chatIdField = z
  .string()
  .min(1)
  .describe(
    "Recipient chat id: …@c.us or …@lid for a person, …@g.us for a group (from list_chats, list_groups or get_contact).",
  );

export const replyToField = z
  .string()
  .min(1)
  .optional()
  .describe("Id of a message to quote in the reply (from get_messages or search_messages).");

export const sendOutputSchema = z.object({
  chat_id: z.string(),
  message_id: z.string(),
  timestamp: z.number().nullable(),
  text_sent: z
    .string()
    .optional()
    .describe("The text or caption exactly as sent, after WhatsApp formatting."),
});

export function sentResult(chatId: string, sent: SentMessage, textSent?: string) {
  const echo = textSent === undefined ? "" : `\nText sent:\n${textSent}`;
  return {
    text: `Sent to ${chatId} (message ${sent.id}).${echo}`,
    data: {
      chat_id: chatId,
      message_id: sent.id,
      timestamp: sent.timestamp,
      ...(textSent === undefined ? {} : { text_sent: textSent }),
    },
  };
}

/**
 * The owner wrote in `chatId` through these tools: an active mission there (under either id form)
 * is taken over at once; WAHA's echo of an API send is not relied on. Waits only for the chat
 * matching; the takeover itself queues behind a running turn. Never fails the send that already
 * happened (`ownerSent` logs its own failures).
 */
export async function noteOwnerSend(
  ctx: Pick<ToolRunContext, "missions">,
  chatId: string,
): Promise<void> {
  await ctx.missions?.ownerSent(chatId).catch(() => {});
}

/**
 * Runs a WhatsApp message action, then mirrors it in the local cache. WhatsApp already accepted
 * the action by then, so a failing local update never fails the call: it reports `localStale`
 * and the cache catches up on the next sync. `tooLate` rewrites WAHA's 400/422 refusal.
 */
export async function actThenApply(q: {
  call: () => Promise<unknown>;
  apply: () => Promise<unknown>;
  tooLate: string;
  /** Where a swallowed local-apply failure is noted (kind and outcome only, never text). */
  logger: Logger;
  kind: string;
}): Promise<{ localStale: boolean }> {
  try {
    await q.call();
  } catch (err) {
    if (err instanceof InvalidInputError)
      throw new InvalidInputError(`${err.message} ${q.tooLate}`);
    throw err;
  }
  try {
    await q.apply();
    return { localStale: false };
  } catch (err) {
    q.logger.info(
      `message-action kind=${q.kind} outcome=local-apply-failed error=${err instanceof Error ? err.name : "unknown"}`,
    );
    return { localStale: true };
  }
}

export const LOCAL_STALE_NOTE = "The local copy will update on the next sync.";
