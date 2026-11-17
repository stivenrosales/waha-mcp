import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TenantAdmin } from "../../../../application/tenantAdmin.js";
import { InvalidInputError } from "../../../../domain/errors.js";
import type { ToolRunContext } from "../../defineTool.js";

/** The admin service, or a clear error when this server instance was built without one. */
export function requireAdmin(ctx: Pick<ToolRunContext, "admin">): TenantAdmin {
  if (!ctx.admin) throw new InvalidInputError("Admin tools are not available on this server.");
  return ctx.admin;
}

export const tenantIdField = z.string().min(1).describe("The tenant id, as shown by list_tenants.");

const rangeBound = (edge: string) =>
  z
    .string()
    .min(1)
    .optional()
    .describe(
      `${edge} of the range (inclusive) as an ISO 8601 date or date-time; a bare date is read in the server TIMEZONE. Default range: the current month.`,
    );

/** Input of the usage reports: an optional range (default: the current month) and tenant. */
export const usageRangeInputSchema = z.object({
  from: rangeBound("Start"),
  to: rangeBound("End"),
  tenant_id: tenantIdField.optional(),
});

/** The range and tenant filter as `TenantAdmin` usage reports take them. */
export const usageQuery = (input: z.infer<typeof usageRangeInputSchema>) => ({
  ...(input.from !== undefined ? { from: input.from } : {}),
  ...(input.to !== undefined ? { to: input.to } : {}),
  ...(input.tenant_id !== undefined ? { tenantId: input.tenant_id } : {}),
});

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Admin changes that are reversible or only add access; the client still asks for approval. */
export const ADMIN_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const ADMIN_DELETE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const ADMIN_READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};
