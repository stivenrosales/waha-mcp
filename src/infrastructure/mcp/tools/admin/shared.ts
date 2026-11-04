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
