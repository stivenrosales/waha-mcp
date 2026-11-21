import { z } from "zod";
import { IDEMPOTENT_WRITE_ANNOTATIONS, type ToolDefinition } from "../defineTool.js";
import { chatIdField } from "./sendShared.js";

const inputSchema = z.object({ chat_id: chatIdField });
const outputSchema = z.object({ chat_id: z.string() });

export const markReadTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "mark_read",
  title: "Mark a WhatsApp chat as read",
  description:
    "Marks a whole chat as read, which also sends read receipts (blue ticks) to the other person. Use only when the owner asked for it.",
  inputSchema,
  outputSchema,
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  async run(input, ctx) {
    await ctx.sender.markRead(input.chat_id);
    return { text: `Marked ${input.chat_id} as read.`, data: { chat_id: input.chat_id } };
  },
};

export const markUnreadTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "mark_unread",
  title: "Mark a WhatsApp chat as unread",
  description:
    "Marks a chat as unread, so it shows the unread badge again in the owner's WhatsApp. Use only when the owner asked for it.",
  inputSchema,
  outputSchema,
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  async run(input, ctx) {
    await ctx.sender.markUnread(input.chat_id);
    return { text: `Marked ${input.chat_id} as unread.`, data: { chat_id: input.chat_id } };
  },
};
