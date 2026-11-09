import { z } from "zod";
import type { ToolDefinition } from "../../defineTool.js";
import { ADMIN_READ_ANNOTATIONS, requireAdmin, tenantIdField } from "./shared.js";

const bound = (edge: string) =>
  z
    .string()
    .min(1)
    .optional()
    .describe(
      `${edge} of the range (inclusive) as an ISO 8601 date or date-time; a bare date is read in the server TIMEZONE. Default range: the current month.`,
    );

const inputSchema = z.object({
  from: bound("Start"),
  to: bound("End"),
  tenant_id: tenantIdField.optional(),
});

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
    const report = await requireAdmin(ctx).toolUsage({
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.tenant_id !== undefined ? { tenantId: input.tenant_id } : {}),
    });
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
