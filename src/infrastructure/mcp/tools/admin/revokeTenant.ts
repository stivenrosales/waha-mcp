import { z } from "zod";
import type { ToolDefinition } from "../../defineTool.js";
import { ADMIN_WRITE_ANNOTATIONS, requireAdmin, tenantIdField } from "./shared.js";

const inputSchema = z.object({ tenant_id: tenantIdField });
const outputSchema = z.object({ tenantId: z.string(), status: z.string() });

export const revokeTenantTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "revoke_tenant",
  title: "Revoke a tenant",
  description: "Revokes a tenant's access",
  inputSchema,
  outputSchema,
  annotations: ADMIN_WRITE_ANNOTATIONS,
  async run(input, ctx) {
    const admin = requireAdmin(ctx);
    admin.revoke(input.tenant_id);
    return {
      text: `Tenant ${input.tenant_id}  its sessions and tokens stop working immediately and its data is kept. Reversible with restore_tenant. The admin tenant cannot be revoked.:revoked.`,
      data: {
        tenantId: input.tenant_id,
        status:
          " its sessions and tokens stop working immediately and its data is kept. Reversible with restore_tenant. The admin tenant cannot be revoked.:revoked",
      },
    };
  },
};
