import { z } from "zod";
import { getGroupInfo } from "../../../application/groups.js";
import { fetchRange } from "../../../application/messages.js";
import { computeChatStats } from "../../../application/stats.js";
import type { ToolDefinition } from "../defineTool.js";
import { chatStatsSchema, isoDate, label } from "./schemas.js";

const inputSchema = z.object({
  chat_id: z
    .string()
    .min(1)
    .describe("Group id (…@g.us) from list_groups or direct chat id from list_chats."),
  from: isoDate("Start of the range (inclusive)").optional(),
  to: isoDate("End of the range (inclusive)").optional(),
  timezone: z
    .string()
    .optional()
    .describe(
      'IANA time zone for per-day/per-hour buckets (e.g. "America/Lima"). Defaults to the server TIMEZONE.',
    ),
});

const TOP = 10;

export const getChatStatsTool: ToolDefinition<typeof inputSchema, typeof chatStatsSchema> = {
  name: "get_chat_stats",
  title: "Chat statistics",
  description:
    "Computes exact activity metrics for a group or direct chat over a date range: totals, messages per participant and type, per day, per hour, who replies to whom and (groups only) silent members. Always read coverage.note: it says whether history was complete, truncated or unavailable.",
  inputSchema,
  outputSchema: chatStatsSchema,
  async run(input, { gateway, mapper, config }) {
    const timezone = input.timezone ?? config.timezone;
    const isGroup = input.chat_id.endsWith("@g.us");
    const participants = isGroup
      ? (await getGroupInfo(gateway, mapper, input.chat_id)).participants
      : [];
    const { messages, truncated } = await fetchRange(gateway, mapper, {
      chatId: input.chat_id,
      from: input.from,
      to: input.to,
      cap: config.statsMaxMessages,
    });
    const stats = computeChatStats(messages, participants, {
      chatId: input.chat_id,
      timezone,
      requestedFrom: input.from ?? null,
      requestedTo: input.to ?? null,
      truncated,
      cap: config.statsMaxMessages,
    });
    const top = stats.perParticipant
      .slice(0, TOP)
      .map((p) => `- ${label(p.name, p.id)}: ${p.messages}`);
    const busiestHour = [...stats.perHour].sort((a, b) => b.messages - a.messages)[0];
    const text = [
      `Coverage: ${stats.coverage.note}`,
      `Total messages: ${stats.totalMessages} (timezone ${timezone})`,
      stats.perParticipant.length > 0
        ? `Top participants:\n${top.join("\n")}${stats.perParticipant.length > TOP ? `\n… ${stats.perParticipant.length - TOP} more in the structured result` : ""}`
        : "",
      stats.totalMessages > 0 && busiestHour
        ? `Busiest hour: ${String(busiestHour.hour).padStart(2, "0")}:00 (${busiestHour.messages} messages)`
        : "",
      isGroup
        ? `Silent members (current participants with no messages): ${stats.silentMembers.length}`
        : "",
      "These numbers are exact; do not recount them from get_messages.",
    ]
      .filter(Boolean)
      .join("\n");
    return { text, data: { chatId: input.chat_id, timezone, ...stats } };
  },
};
