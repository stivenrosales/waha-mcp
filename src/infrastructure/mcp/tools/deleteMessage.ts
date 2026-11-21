import { z } from "zod";
import { assertOwnMessage, parseMessageId } from "../../../domain/messageId.js";
import { DESTRUCTIVE_ANNOTATIONS, type ToolDefinition } from "../defineTool.js";
import { actThenApply, LOCAL_STALE_NOTE } from "./sendShared.js";

const inputSchema = z.object({
  message_id: z
    .string()
    .min(1)
    .describe("Full id of one of the owner's own messages (starts with true_), from get_messages."),
});

const outputSchema = z.object({ message_id: z.string() });

export const deleteMessageTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "delete_message",
  title: "Delete a WhatsApp message",
  description:
    "Deletes a message the owner sent, for everyone in the chat. This cannot be undone. Only the owner's own messages (ids that start with true_); WhatsApp only allows it within a limited time. Delete only when the owner explicitly asked in this conversation; show them the message (text and chat) first. Never retry on your own.",
  inputSchema,
  outputSchema,
  annotations: DESTRUCTIVE_ANNOTATIONS,
  async run(input, ctx) {
    const parsed = parseMessageId(input.message_id);
    assertOwnMessage(parsed, "delete");
    const { localStale } = await actThenApply({
      call: () => ctx.sender.deleteMessage({ chatId: parsed.chatId, messageId: input.message_id }),
      apply: () => ctx.messageActions.applyRevoke(parsed.shortId, Math.floor(Date.now() / 1000)),
      logger: ctx.logger,
      kind: "delete",
      tooLate: "WhatsApp only allows deleting for everyone within a limited time.",
    });
    return {
      text: `Deleted message ${input.message_id} for everyone. This cannot be undone.${localStale ? `\n${LOCAL_STALE_NOTE}` : ""}`,
      data: { message_id: input.message_id },
    };
  },
};
