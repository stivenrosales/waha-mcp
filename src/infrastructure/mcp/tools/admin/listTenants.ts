import { z } from "zod";
import type { ToolDefinition } from "../../defineTool.js";
import { ADMIN_READ_ANNOTATIONS, requireAdmin } from "./shared.js";

const inputSchema = z.object({});
const outputSchema = z.object({
  tenants: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      status: z.enum(["invited", "pairing", "active", "revoked"]),
      whatsapp: z.enum(["STOPPED", "STARTING", "SCAN_QR_CODE", "WORKING", "FAILED", "UNKNOWN"]),
      createdAt: z.string(),
      lastLoginAt: z.string().nullable(),
      isAdmin: z.boolean(),
    }),
  ),
});

export const listTenantsTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "list_tenants",
  title: "List tenants",
  description:
    "Lists every tenant with its status (invited, pairing, active, revoked), WhatsApp connection state, creation date and last login. Never includes message content.",
  inputSchema,
  outputSchema,
  annotations: ADMIN_READ_ANNOTATIONS,
  async run(_input, ctx) {
    const tenants = await requireAdmin(ctx).listTenants();
    const lines = tenants.map(
      (t) =>
        `- ${t.displayName} (${t.id})${t.isAdmin ? " [admin]" : ""} · ${t.status} · WhatsApp ${t.whatsapp} · created ${t.createdAt} · last login ${t.lastLoginAt ?? "never"}`,
    );
    return {
      text:
        tenants.length === 0 ? "No tenants." : `${tenants.length} tenants:\n${lines.join("\n")}`,
      data: { tenants },
    };
  },
};
