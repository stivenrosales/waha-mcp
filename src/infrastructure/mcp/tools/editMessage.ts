import { z } from "zod";
import { assertTextLength } from "../../../application/send.js";
import { toWhatsAppText } from "../../../application/whatsappFormat.js";
import { assertOwnMessage, parseMessageId } from "../../../domain/messageId.js";
import { SEND_ANNOTATIONS, type ToolDefinition } from "../defineTool.js";
import { actThenApply, LOCAL_STALE_NOTE, WHATSAPP_FORMAT_RULES } from "./sendShared.js";

const inputSchema = z.object({
  message_id: z
    .string()
    .min(1)
    .describe("Full id of one of the owner's own messages (starts with true_), from get_messages."),
  text: z.string().min(1).describe("The new text, in WhatsApp formatting."),
});

const outputSchema = z.object({ message_id: z.string(), text_sent: z.string() });

export const editMessageTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "edit_message",
  title: "Edit a WhatsApp message",
  description: `Replaces the text of a message the owner sent. Only the owner's own messages (ids that start with true_); WhatsApp only allows editing recent messages. Edit only when the owner explicitly asked in this conversation; show them the message (text and chat) and the new text first. Never retry on your own.\n\n${WHATSAPP_FORMAT_RULES}`,
  inputSchema,
  outputSchema,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const parsed = parseMessageId(input.message_id);
    assertOwnMessage(parsed, "edit");
    const text = toWhatsAppText(input.text);
    assertTextLength(text);
    const { localStale } = await actThenApply({
      call: () =>
        ctx.sender.editMessage({ chatId: parsed.chatId, messageId: input.message_id, text }),
      apply: () =>
        ctx.messageActions.applyEdit(parsed.shortId, text, Math.floor(Date.now() / 1000)),
      logger: ctx.logger,
      kind: "edit",
      tooLate: "WhatsApp only allows editing recent messages.",
    });
    return {
      text: `Edited message ${input.message_id}.\nText sent:\n${text}${localStale ? `\n${LOCAL_STALE_NOTE}` : ""}`,
      data: { message_id: input.message_id, text_sent: text },
    };
  },
};
