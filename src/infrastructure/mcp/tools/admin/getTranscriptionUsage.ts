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

const totals = {
  count: z.number(),
  seconds: z.number(),
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
const secs = (v: number) => `${Math.round(v)} s`;

export const getTranscriptionUsageTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "get_transcription_usage",
  title: "Transcription usage",
  description:
    "Reports voice-note transcription spend per tenant (count, audio seconds, cost in USD as reported by the provider) for a date range, most expensive first, plus the total. Default range: the current month. Spend from before usage tracking was added is not included.",
  inputSchema,
  outputSchema,
  annotations: ADMIN_READ_ANNOTATIONS,
  async run(input, ctx) {
    const report = await requireAdmin(ctx).transcriptionUsage({
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.tenant_id !== undefined ? { tenantId: input.tenant_id } : {}),
    });
    if (report.tenants.length === 0) {
      return { text: `No transcriptions between ${report.from} and ${report.to}.`, data: report };
    }
    const line = (t: { count: number; seconds: number; costUsd: number }) =>
      `${t.count} transcriptions · ${secs(t.seconds)} · ${usd(t.costUsd)}`;
    const lines = [
      `Transcription usage ${report.from} → ${report.to}:`,
      ...report.tenants.map(
        (t) => `- ${t.displayName ?? "(deleted tenant)"} (${t.id}) · ${line(t)}`,
      ),
      `Total: ${line(report.total)}`,
    ];
    if (report.total.rowsWithoutCost > 0) {
      lines.push(
        `${report.total.rowsWithoutCost} transcription(s) without cost reported: the total does not include them.`,
      );
    }
    return { text: lines.join("\n"), data: report };
  },
};
