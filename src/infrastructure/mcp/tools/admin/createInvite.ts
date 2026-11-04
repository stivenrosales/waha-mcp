import { z } from "zod";
import { InvalidInputError } from "../../../../domain/errors.js";
import type { ToolDefinition } from "../../defineTool.js";
import { ADMIN_WRITE_ANNOTATIONS, requireAdmin } from "./shared.js";

const inputSchema = z.object({
  display_name: z
    .string()
    .min(1)
    .optional()
    .describe("Name of the new tenant (a person or business). Creates the tenant."),
  tenant_id: z
    .string()
    .min(1)
    .optional()
    .describe("Existing tenant that has no user yet: issues a fresh invite link for it."),
});
const outputSchema = z.object({
  tenantId: z.string(),
  url: z.string(),
  expiresAt: z.string(),
});

export const createInviteTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "create_invite",
  title: "Create a tenant invite link",
  description:
    "Creates a tenant and returns a single-use invite link (valid 72 hours) to send to its owner, who sets a username and password and pairs WhatsApp. Pass exactly one of display_name (new tenant) or tenant_id (new link for a tenant that has not signed up yet; the previous link stops working).",
  inputSchema,
  outputSchema,
  annotations: ADMIN_WRITE_ANNOTATIONS,
  async run(input, ctx) {
    const admin = requireAdmin(ctx);
    if ((input.display_name === undefined) === (input.tenant_id === undefined))
      throw new InvalidInputError("Provide exactly one of display_name or tenant_id.");
    const out = await admin.createInvite({
      ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
      ...(input.tenant_id !== undefined ? { tenantId: input.tenant_id } : {}),
    });
    return {
      text: `Invite link for tenant ${out.tenantId} (expires ${out.expiresAt}, single use):\n${out.url}`,
      data: out,
    };
  },
};
