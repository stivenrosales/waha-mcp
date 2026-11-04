import { z } from "zod";
import type { ToolDefinition } from "../../defineTool.js";
import { ADMIN_WRITE_ANNOTATIONS, requireAdmin, tenantIdField } from "./shared.js";

const inputSchema = z.object({ tenant_id: tenantIdField });
const outputSchema = z.object({ url: z.string(), expiresAt: z.string() });

export const resetPasswordTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "reset_password",
  title: "Create a password reset link",
  description:
    "Creates a single-use password reset link (valid 72 hours) for the tenant's user; the previous reset link stops working. Send it to the tenant's owner.",
  inputSchema,
  outputSchema,
  annotations: ADMIN_WRITE_ANNOTATIONS,
  async run(input, ctx) {
    const out = requireAdmin(ctx).resetPassword(input.tenant_id);
    return {
      text: `Password reset link for tenant ${input.tenant_id} (expires ${out.expiresAt}, single use):\n${out.url}`,
      data: out,
    };
  },
};
