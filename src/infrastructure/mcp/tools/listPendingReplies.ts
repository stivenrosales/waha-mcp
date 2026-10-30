import { z } from "zod";
import { findPendingReplies } from "../../../application/pending.js";
import type { ToolDefinition } from "../defineTool.js";
import { coverageText, isoDate, pendingRepliesSchema, scopeSchema } from "./schemas.js";

const inputSchema = z.object({
  since: isoDate("Only chats active since this moment; defaults to 7 days ago").optional(),
  scope: scopeSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum chats to return, longest wait first (default 50)."),
});

function waited(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 2880) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} days`;
}

export const listPendingRepliesTool: ToolDefinition<
  typeof inputSchema,
  typeof pendingRepliesSchema
> = {
  name: "list_pending_replies",
  title: "Pending replies",
  description:
    'Finds chats where someone is waiting for the owner\'s answer, longest wait first, with waiting time and the last messages. Direct chats: the other side spoke last. Groups (scope "groups"/"all"): only mentions of the owner or replies to the owner\'s messages not yet answered. Always read coverage: it states which chats were scanned and what is missing. Turn the result into to-dos yourself; the server never creates tasks.',
  inputSchema,
  outputSchema: pendingRepliesSchema,
  async run(input, { gateway, mapper, config, transcription }) {
    const r = await findPendingReplies(
      gateway,
      mapper,
      { since: input.since, scope: input.scope, limit: input.limit },
      {
        statsMaxMessages: config.statsMaxMessages,
        timezone: config.timezone,
        transcripts: transcription,
      },
    );
    const lines = r.pending.map(
      (p) =>
        `- ${p.name} (${p.chatId}) · ${p.reason} · waiting ${waited(p.waitingMinutes)} since ${p.waitingSince} · ${p.unansweredCount} unanswered`,
    );
    const head =
      r.totalPending === 0
        ? `No pending replies since ${r.since} (scope ${r.scope}).`
        : `${r.totalPending} chats waiting for a reply since ${r.since} (scope ${r.scope})${r.totalPending > r.pending.length ? `, showing ${r.pending.length}` : ""}:`;
    return {
      text: [head, ...lines, coverageText(r.coverage)].join("\n"),
      data: r,
    };
  },
};
