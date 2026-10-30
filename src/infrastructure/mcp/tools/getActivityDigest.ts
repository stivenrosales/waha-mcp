import { z } from "zod";
import { buildActivityDigest } from "../../../application/digest.js";
import type { ToolDefinition } from "../defineTool.js";
import { activityDigestSchema, coverageText, isoDate, scopeSchema } from "./schemas.js";

const inputSchema = z.object({
  date: z
    .string()
    .optional()
    .describe(
      "A single day as YYYY-MM-DD in `timezone` (default: today). Do not combine with from/to.",
    ),
  from: isoDate("Start of an explicit range (instead of date)").optional(),
  to: isoDate("End of an explicit range (instead of date)").optional(),
  timezone: z
    .string()
    .optional()
    .describe('IANA time zone that defines the day (e.g. "America/Lima"). Defaults to TIMEZONE.'),
  scope: scopeSchema,
});

export const getActivityDigestTool: ToolDefinition<
  typeof inputSchema,
  typeof activityDigestSchema
> = {
  name: "get_activity_digest",
  title: "Activity digest",
  description:
    "Lists every chat active on a day or range in one call: message count, who spoke last, whether it awaits the owner's reply, and the last 30 messages (compact, oldest first). Use it to review a day across all chats, then build summaries or to-dos yourself. Always read coverage: it states which chats were scanned and what is missing.",
  inputSchema,
  outputSchema: activityDigestSchema,
  async run(input, { gateway, mapper, config }) {
    const r = await buildActivityDigest(
      gateway,
      mapper,
      {
        date: input.date,
        from: input.from,
        to: input.to,
        timezone: input.timezone ?? config.timezone,
        scope: input.scope,
      },
      { statsMaxMessages: config.statsMaxMessages },
    );
    const lines = r.chats.map(
      (c) =>
        `- ${c.name} (${c.chatId}) · ${c.messageCount} messages · last from ${c.lastFrom}${c.awaitingReply ? " · AWAITING YOUR REPLY" : ""}`,
    );
    const head =
      r.chats.length === 0
        ? `No chat activity between ${r.from} and ${r.to} (scope ${r.scope}, timezone ${r.timezone}).`
        : `${r.chats.length} active chats between ${r.from} and ${r.to} (scope ${r.scope}, timezone ${r.timezone}):`;
    return { text: [head, ...lines, coverageText(r.coverage)].join("\n"), data: r };
  },
};
