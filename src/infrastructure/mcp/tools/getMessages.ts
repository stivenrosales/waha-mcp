import { z } from "zod";
import { getMessages } from "../../../application/messages.js";
import type { NormalizedMessage } from "../../../domain/message.js";
import type { ToolDefinition } from "../defineTool.js";
import { isoDate, label, messageSchema } from "./schemas.js";

const inputSchema = z.object({
  chat_id: z
    .string()
    .min(1)
    .describe("Group id (…@g.us) from list_groups or direct chat id from list_chats."),
  from: isoDate("Start of the range (inclusive)").optional(),
  to: isoDate("End of the range (inclusive)").optional(),
  limit: z.number().int().min(1).max(200).optional().describe("Page size, 1-200 (default 50)."),
  cursor: z
    .string()
    .optional()
    .describe("nextCursor from a previous call with the same chat_id, from and to."),
});
const outputSchema = z.object({
  messages: z.array(messageSchema),
  nextCursor: z.string().nullable(),
});

function line(m: NormalizedMessage): string {
  const who = label(m.author.name, m.author.phone ?? m.author.id) || "unknown";
  const parts = [`[${m.timestamp}] ${who}:`];
  if (m.attachment)
    parts.push(
      `[${m.attachment.kind}${m.attachment.filename ? ` "${m.attachment.filename}"` : ""}${m.attachment.mediaId ? ` media_id=${m.attachment.mediaId}` : ""}]`,
    );
  else if (m.type !== "text") parts.push(`[${m.type}]`);
  if (m.text) parts.push(m.text);
  if (m.location) parts.push(`(${m.location.lat}, ${m.location.lng}) ${m.location.name ?? ""}`);
  if (m.contact) parts.push(`${m.contact.name ?? ""} ${m.contact.phone ?? ""}`.trim());
  if (m.poll) parts.push(`${m.poll.question} — ${m.poll.options.join(" / ")}`);
  if (m.replyToId) parts.push(`(reply to ${m.replyToId})`);
  return parts.join(" ");
}

export const getMessagesTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "get_messages",
  title: "Read chat messages",
  description:
    "Reads messages of a group or direct chat, NEWEST FIRST, optionally within a date range. Paginate with nextCursor. Attachments carry a media_id for get_media. For counts and rankings use get_chat_stats instead of counting pages.",
  inputSchema,
  outputSchema,
  async run(input, { gateway, mapper, config }) {
    const { messages, nextCursor, cacheNote } = await getMessages(gateway, mapper, {
      chatId: input.chat_id,
      from: input.from,
      to: input.to,
      limit: input.limit,
      cursor: input.cursor,
      timezone: config.timezone,
    });
    const body =
      messages.length === 0
        ? "No messages returned for this chat and range. WAHA may have no stored history for it; this does not mean the chat was silent."
        : `${messages.length} messages (newest first):\n${messages.map(line).join("\n")}`;
    const more = nextCursor
      ? `\n\nMore messages available: call again with cursor="${nextCursor}".`
      : "";
    const cache = cacheNote ? `\n\n${cacheNote}` : "";
    return { text: `${body}${more}${cache}`, data: { messages, nextCursor } };
  },
};
