import { z } from "zod";
import type { SentMessage } from "../../../domain/ports/WhatsAppSender.js";

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
