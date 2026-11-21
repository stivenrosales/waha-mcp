import { z } from "zod";
import { isSingleEmoji } from "../../../application/emoji.js";
import { InvalidInputError } from "../../../domain/errors.js";
import { parseMessageId } from "../../../domain/messageId.js";
import { SEND_ANNOTATIONS, type ToolDefinition } from "../defineTool.js";

const inputSchema = z.object({
  message_id: z
    .string()
    .min(1)
    .describe("Full message id from get_messages, search_messages or get_thread."),
  emoji: z
    .string()
    .describe('One emoji to react with, or "" to remove your reaction from the message.'),
});

const outputSchema = z.object({ message_id: z.string(), emoji: z.string() });

export const reactMessageTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "react_message",
  title: "React to a WhatsApp message",
  description:
    "Reacts to a message with one emoji from the owner's WhatsApp, or removes the owner's reaction with emoji \"\". Works on any message, the owner's or not. React only when the owner asked for it. Never retry on your own.",
  inputSchema,
  outputSchema,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const parsed = parseMessageId(input.message_id);
    if (input.emoji !== "" && !isSingleEmoji(input.emoji))
      throw new InvalidInputError('"emoji" must be one emoji, or "" to remove your reaction.');
    await ctx.sender.react({ messageId: input.message_id, emoji: input.emoji });
    // Recorded right away; the later webhook echo carries the same reactor, so it is idempotent.
    await ctx.messageActions.applyReaction({
      messageId: parsed.shortId,
      reactor: "me",
      emoji: input.emoji,
      ts: Math.floor(Date.now() / 1000),
    });
    return {
      text:
        input.emoji === ""
          ? `Removed your reaction from message ${input.message_id}.`
          : `Reacted ${input.emoji} to message ${input.message_id}.`,
      data: { message_id: input.message_id, emoji: input.emoji },
    };
  },
};
