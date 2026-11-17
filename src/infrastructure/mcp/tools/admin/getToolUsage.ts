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

const totals = { calls: z.number(), errors: z.number() };
const outputSchema = z.object({
  from: z.string(),
  to: z.string(),
  tenants: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().nullable(),
      lastAt: z.string(),
      ...totals,
      tools: z.array(z.object({ tool: z.string(), lastAt: z.string(), ...totals })),
    }),
  ),
  total: z.object(totals),
});

const counts = (t: { calls: number; errors: number }) =>
  `${plural(t.calls, "call")} · ${plural(t.errors, "error")}`;

export const getToolUsageTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "get_tool_usage",
  title: "Tool usage",
  description:
    "Reports MCP tool calls per tenant for a date range: calls and errors per tool and the last call, busiest tenant first, plus the total. Default range: the current month. Only tool names and outcomes are recorded, never arguments or results; calls from before usage tracking was added are not included.",
  inputSchema,
  outputSchema,
  annotations: ADMIN_READ_ANNOTATIONS,
  async run(input, ctx) {
    const report = await requireAdmin(ctx).toolUsage(usageQuery(input));
    if (report.tenants.length === 0) {
      return { text: `No tool calls between ${report.from} and ${report.to}.`, data: report };
    }
    const lines = [`Tool usage ${report.from} → ${report.to}:`];
    for (const t of report.tenants) {
      lines.push(
        `- ${t.displayName ?? "(deleted tenant)"} (${t.id}) · ${counts(t)} · last ${t.lastAt}`,
        `  ${t.tools
          .map(
            (u) => `${u.tool} ${u.calls}${u.errors > 0 ? ` (${plural(u.errors, "error")})` : ""}`,
          )
          .join(" · ")}`,
      );
    }
    lines.push(`Total: ${counts(report.total)}`);
    return { text: lines.join("\n"), data: report };
  },
};
