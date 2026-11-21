import { z } from "zod";
import { InvalidInputError } from "../../../domain/errors.js";
import { SEND_ANNOTATIONS, type ToolDefinition } from "../defineTool.js";
import {
  chatIdField,
  noteOwnerSend,
  replyToField,
  SEND_POLICY,
  sendOutputSchema,
} from "./sendShared.js";

const inputSchema = z.object({
  chat_id: chatIdField,
  question: z.string().min(1).max(255).describe("The poll question (up to 255 characters)."),
  options: z
    .array(z.string().trim().min(1).max(100))
    .min(2)
    .max(12)
    .describe("The answers people can pick: 2 to 12, each up to 100 characters and all different."),
  multiple_answers: z
    .boolean()
    .default(false)
    .describe("Whether people may pick more than one option. Defaults to false."),
  reply_to: replyToField,
});

export const sendPollTool: ToolDefinition<typeof inputSchema, typeof sendOutputSchema> = {
  name: "send_poll",
  title: "Send a WhatsApp poll",
  description: `Sends a poll from the owner's WhatsApp to a person or group: a question with 2 to 12 options, single or multiple answers. ${SEND_POLICY}`,
  inputSchema,
  outputSchema: sendOutputSchema,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const seen = new Set(input.options.map((o) => o.toLowerCase()));
    if (seen.size !== input.options.length)
      throw new InvalidInputError("Poll options must be different from each other.");
    const sent = await ctx.sender.sendPoll({
      chatId: input.chat_id,
      ...(input.reply_to ? { replyTo: input.reply_to } : {}),
      question: input.question,
      options: input.options,
      multipleAnswers: input.multiple_answers,
    });
    await noteOwnerSend(ctx, input.chat_id);
    return {
      text: `Sent poll to ${input.chat_id} (message ${sent.id}). Read votes with get_poll_results.`,
      data: { chat_id: input.chat_id, message_id: sent.id, timestamp: sent.timestamp },
    };
  },
};
