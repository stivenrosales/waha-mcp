import { z } from "zod";
import { getPollResults } from "../../../application/pollResults.js";
import type { ToolDefinition } from "../defineTool.js";

const inputSchema = z.object({
  message_id: z
    .string()
    .min(1)
    .describe("Full id of the poll message, from send_poll, get_messages or get_thread."),
});

const outputSchema = z.object({
  question: z.string(),
  options: z.array(z.object({ option: z.string(), votes: z.number() })),
  voters: z.array(
    z.object({ id: z.string(), name: z.string().nullable(), options: z.array(z.string()) }),
  ),
  failedVotes: z.number(),
  webhooks: z.boolean(),
});

export const getPollResultsTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "get_poll_results",
  title: "Poll results",
  description:
    "Reads a poll: its question, the count per option and who voted what (the latest vote of each person). Votes are counted as they arrive through webhooks, from when this server started receiving them, so earlier votes are missing; votes WhatsApp could not decrypt are reported as a count (failedVotes) and are not in the totals. Needs the server's webhooks (WAHA_WEBHOOK_SECRET); without them it returns the options with zero counts.",
  inputSchema,
  outputSchema,
  async run(input, { gateway, mapper, config, messageActions }) {
    const r = await getPollResults(
      {
        gateway,
        mapper,
        actions: messageActions,
        webhooksOn: config.webhookSecret !== null,
        now: Date.now,
      },
      input.message_id,
    );
    const lines = [`Poll: ${r.question}`];
    for (const o of r.options) lines.push(`- ${o.option}: ${o.votes}`);
    if (!r.webhooks) {
      lines.push("Votes are not available: this server has no webhooks (WAHA_WEBHOOK_SECRET).");
    } else {
      if (r.voters.length > 0) {
        lines.push("Voters (newest first):");
        for (const v of r.voters)
          lines.push(`- ${v.name ?? v.id}${v.name ? ` (${v.id})` : ""}: ${v.options.join(", ")}`);
      } else lines.push("No votes received yet.");
      if (r.failedVotes > 0)
        lines.push(
          `${r.failedVotes} vote(s) could not be decrypted by WhatsApp and are not counted.`,
        );
      lines.push("Only votes received since this server started listening are counted.");
    }
    return { text: lines.join("\n"), data: r };
  },
};
