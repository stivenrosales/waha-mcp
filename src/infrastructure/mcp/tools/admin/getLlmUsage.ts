import { z } from "zod";
import type { ToolDefinition } from "../../defineTool.js";
import {
  ADMIN_READ_ANNOTATIONS,
  plural,
  requireAdmin,
  usageQuery,
  usageRangeInputSchema,
} from "./shared.js";

const inputSchema = usageRangeInputSchema;

const totals = {
  calls: z.number(),
  missions: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  costUsd: z.number(),
  rowsWithoutCost: z.number(),
};
const outputSchema = z.object({
  from: z.string(),
  to: z.string(),
  tenants: z.array(z.object({ id: z.string(), displayName: z.string().nullable(), ...totals })),
  total: z.object(totals),
});

const usd = (v: number) => `$${v.toFixed(4)}`;

export const getLlmUsageTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "get_llm_usage",
  title: "Mission LLM usage",
  description:
    "Reports mission LLM spend per tenant (calls, missions, input/output/cached tokens, cost in USD as reported by the provider) for a date range, most expensive first, plus the total. Default range: the current month.",
  inputSchema,
  outputSchema,
  annotations: ADMIN_READ_ANNOTATIONS,
  async run(input, ctx) {
    const report = await requireAdmin(ctx).llmUsage(usageQuery(input));
    if (report.tenants.length === 0) {
      return {
        text: `No mission LLM usage between ${report.from} and ${report.to}.`,
        data: report,
      };
    }
    const line = (t: z.infer<z.ZodObject<typeof totals>>) =>
      `${plural(t.calls, "call")} · ${plural(t.missions, "mission")} · ${t.inputTokens} in / ${t.outputTokens} out / ${t.cacheReadTokens} cached tokens · ${usd(t.costUsd)}`;
    const lines = [
      `Mission LLM usage ${report.from} → ${report.to}:`,
      ...report.tenants.map(
        (t) => `- ${t.displayName ?? "(deleted tenant)"} (${t.id}) · ${line(t)}`,
      ),
      `Total: ${line(report.total)}`,
    ];
    if (report.total.rowsWithoutCost > 0) {
      lines.push(
        `${report.total.rowsWithoutCost} call(s) without cost reported: the total does not include them.`,
      );
    }
    return { text: lines.join("\n"), data: report };
  },
};
