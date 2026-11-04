import { z } from "zod";
import type { ToolDefinition } from "../../defineTool.js";
import { ADMIN_WRITE_ANNOTATIONS, requireAdmin, tenantIdField } from "./shared.js";

const inputSchema = z.object({ tenant_id: tenantIdField });
const outputSchema = z.object({ tenantId: z.string(), status: z.string() });

export const restoreTenantTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "restore_tenant",
  title: "Restore a tenant",
  description:
    "Restores a revoked tenant. It goes back to active when it was fully set up, to pairing when it has a user but no paired WhatsApp, or to invited when it never signed up. The admin tenant cannot be restored.",
  inputSchema,
  outputSchema,
  annotations: ADMIN_WRITE_ANNOTATIONS,
  async run(input, ctx) {
    const admin = requireAdmin(ctx);
    admin.restore(input.tenant_id);
    return {
      text: `Tenant ${input.tenant_id} restored.`,
      data: { tenantId: input.tenant_id, status: "restored" },
    };
  },
};
