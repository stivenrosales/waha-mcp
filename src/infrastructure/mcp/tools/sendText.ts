import { z } from "zod";
import { assertMentions, assertTextLength } from "../../../application/send.js";
import { toWhatsAppText } from "../../../application/whatsappFormat.js";
import { SEND_ANNOTATIONS, type ToolDefinition } from "../defineTool.js";
import {
  chatIdField,
  replyToField,
  SEND_POLICY,
  sendOutputSchema,
  sentResult,
  WHATSAPP_FORMAT_RULES,
} from "./sendShared.js";

const inputSchema = z.object({
  chat_id: chatIdField,
  text: z.string().min(1).describe("The message, in WhatsApp formatting."),
  reply_to: replyToField,
  mentions: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Contact ids to @mention in a group (…@c.us or …@lid). Each one must also appear in the text as @<number>, e.g. @51999888777 for 51999888777@c.us.",
    ),
});

export const sendTextTool: ToolDefinition<typeof inputSchema, typeof sendOutputSchema> = {
  name: "send_text",
  title: "Send a WhatsApp text message",
  description: `Sends a text message from the owner's WhatsApp to a person or group, optionally quoting a message and mentioning people. ${SEND_POLICY}\n\n${WHATSAPP_FORMAT_RULES}`,
  inputSchema,
  outputSchema: sendOutputSchema,
  annotations: SEND_ANNOTATIONS,
  async run(input, { sender }) {
    const text = toWhatsAppText(input.text);
    assertTextLength(text);
    const mentions = input.mentions ?? [];
    assertMentions(text, mentions);
    const sent = await sender.sendText({
      chatId: input.chat_id,
      text,
      ...(input.reply_to ? { replyTo: input.reply_to } : {}),
      ...(mentions.length ? { mentions } : {}),
    });
    return sentResult(input.chat_id, sent, text);
  },
};
