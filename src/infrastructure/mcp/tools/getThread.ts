import { z } from "zod";
import { getThread } from "../../../application/thread.js";
import type { NormalizedMessage } from "../../../domain/message.js";
import type { ToolDefinition } from "../defineTool.js";
import { threadSchema } from "./schemas.js";

const inputSchema = z.object({
  chat_id: z.string().min(1).describe("Chat that contains the message."),
  message_id: z
    .string()
    .min(1)
    .describe("Message id from get_messages or search_messages (the bare stanza id also works)."),
  before: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Messages to include before (older than) the anchor, 0-50 (default 10)."),
  after: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Messages to include after (newer than) the anchor, 0-50 (default 10)."),
});

function line(m: NormalizedMessage, mark = " "): string {
  const who = m.fromMe ? "me" : m.author.name || m.author.phone || m.author.id || "unknown";
  const text =
    m.text === null
      ? null
      : Array.from(m.text).length > 280
        ? `${Array.from(m.text).slice(0, 279).join("")}…`
        : m.text;
  const body = text ?? (m.attachment ? `[${m.attachment.kind}]` : `[${m.type}]`);
  return `${mark} [${m.timestamp}] ${who} (id=${m.id}): ${body}${m.replyToId ? ` (reply to ${m.replyToId})` : ""}`;
}

export const getThreadTool: ToolDefinition<typeof inputSchema, typeof threadSchema> = {
  name: "get_thread",
  title: "Message thread",
  description:
    "Reads the conversation around one message: the message itself, up to 50 messages before and after it (chronological), and its reply chain (up to 10 messages it answers, oldest first). Use it after search_messages or get_messages to see the context of a message. If the message is not in the chat's recent history it fails with a clear error. Missing reply ancestors are listed in coverage.",
  inputSchema,
  outputSchema: threadSchema,
  async run(input, { gateway, mapper, config }) {
    const t = await getThread(
      gateway,
      mapper,
      {
        chatId: input.chat_id,
        messageId: input.message_id,
        before: input.before,
        after: input.after,
      },
      { statsMaxMessages: config.statsMaxMessages },
    );
    const parts = [
      `Thread around ${t.anchor.id} in ${t.chatId} (${t.before.length} before, ${t.after.length} after, chronological; > marks the anchor):`,
      ...t.before.map((m) => line(m)),
      line(t.anchor, ">"),
      ...t.after.map((m) => line(m)),
    ];
    if (t.replyChain.length > 0)
      parts.push("Reply chain (oldest first):", ...t.replyChain.map((m) => line(m)));
    parts.push(...t.coverage.notes.map((n) => `Coverage: ${n}`));
    return { text: parts.join("\n"), data: t };
  },
};
