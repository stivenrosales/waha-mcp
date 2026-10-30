import { z } from "zod";
import { searchMessages } from "../../../application/search.js";
import type { ToolDefinition } from "../defineTool.js";
import { coverageText, isoDate, scopeSchema, searchMessagesSchema } from "./schemas.js";

const inputSchema = z.object({
  query: z
    .string()
    .describe(
      "Text to find, 2-200 characters. Case- and accent-insensitive; matches message text, media captions and file names.",
    ),
  chat_id: z
    .string()
    .min(1)
    .optional()
    .describe("Search only this chat (group or direct). Without it, `scope` picks the chats."),
  scope: scopeSchema,
  from: isoDate("Start of the range (default: 30 days ago)").optional(),
  to: isoDate("End of the range").optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum hits to return, newest first (default 50)."),
});

export const searchMessagesTool: ToolDefinition<typeof inputSchema, typeof searchMessagesSchema> = {
  name: "search_messages",
  title: "Search messages",
  description:
    'Finds messages containing a text, newest first, with a snippet centered on the match. Case- and accent-insensitive ("ano" also matches "año") over text, captions and file names. Give chat_id to search one chat of any type; otherwise it searches the chats of `scope` (default "direct") active in the range (default last 30 days). Always read coverage: it states which chats were scanned and what is missing, so no hits does not prove the text was never written. Use get_thread with a hit\'s message id to read the conversation around it.',
  inputSchema,
  outputSchema: searchMessagesSchema,
  async run(input, { gateway, mapper, config }) {
    const r = await searchMessages(
      gateway,
      mapper,
      {
        query: input.query,
        chatId: input.chat_id,
        scope: input.scope,
        from: input.from,
        to: input.to,
        limit: input.limit,
      },
      { statsMaxMessages: config.statsMaxMessages, timezone: config.timezone },
    );
    const where = r.scope === null ? `chat ${input.chat_id}` : `scope ${r.scope}`;
    const lines = r.hits.map(
      (h) =>
        `- [${h.message.at}] ${h.chatName} (${h.chatId}) · ${h.message.from} · id=${h.message.id}\n  ${h.snippet}`,
    );
    const head =
      r.totalMatches === 0
        ? `No messages matching "${r.query}" since ${r.from} (${where}).`
        : `${r.totalMatches} messages matching "${r.query}" since ${r.from} (${where})${r.totalMatches > r.hits.length ? `, showing the newest ${r.hits.length}` : ""}:`;
    return { text: [head, ...lines, coverageText(r.coverage)].join("\n"), data: r };
  },
};
