import { z } from "zod";
import type { ToolDefinition } from "../../defineTool.js";
import { ADMIN_DELETE_ANNOTATIONS, requireAdmin, tenantIdField } from "./shared.js";

const inputSchema = z.object({
  tenant_id: tenantIdField,
  confirm_display_name: z
    .string()
    .min(1)
    .describe("The tenant's exact display name, to confirm the deletion."),
});
const outputSchema = z.object({
  tenantId: z.string(),
  deleted: z.literal(true),
  whatsappCleanup: z.enum(["ok", "failed"]),
  localCleanup: z.enum(["ok", "failed"]),
});

export const deleteTenantTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "delete_tenant",
  title: "Delete a tenant permanently",
  description:
    "Permanently deletes a tenant: its account, encryption key, cached messages and WhatsApp session. This cannot be undone. Requires the tenant's exact display name in confirm_display_name. The admin tenant cannot be deleted.",
  inputSchema,
  outputSchema,
  annotations: ADMIN_DELETE_ANNOTATIONS,
  async run(input, ctx) {
    const { whatsappCleanup, localCleanup } = await requireAdmin(ctx).delete(
      input.tenant_id,
      input.confirm_display_name,
    );
    const note =
      (whatsappCleanup === "ok"
        ? ""
        : " The WhatsApp session could not be removed from WAHA; remove it there manually.") +
      (localCleanup === "ok"
        ? ""
        : " Some local cleanup failed; check the server logs and the tenant's data directory.");
    return {
      text: `Tenant ${input.tenant_id} deleted.${note}`,
      data: { tenantId: input.tenant_id, deleted: true as const, whatsappCleanup, localCleanup },
    };
  },
};
