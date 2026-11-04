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
  /** Present when a cleanup step failed: the WAHA session to clean up by hand. */
  wahaSession: z.string().optional(),
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
    const { whatsappCleanup, localCleanup, wahaSession } = await requireAdmin(ctx).delete(
      input.tenant_id,
      input.confirm_display_name,
    );
    const note =
      (whatsappCleanup === "ok"
        ? ""
        : ` The WhatsApp session ${wahaSession} could not be removed from WAHA; log it out and delete it there manually.`) +
      (localCleanup === "ok"
        ? ""
        : ` Some local cleanup failed (WhatsApp session ${wahaSession}); check the server logs and DATA_DIR/tenants/${input.tenant_id}.`);
    return {
      text: `Tenant ${input.tenant_id} deleted.${note}`,
      data: {
        tenantId: input.tenant_id,
        deleted: true as const,
        whatsappCleanup,
        localCleanup,
        ...(wahaSession === undefined ? {} : { wahaSession }),
      },
    };
  },
};
