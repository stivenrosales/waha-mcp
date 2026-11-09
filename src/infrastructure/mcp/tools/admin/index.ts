import type { ToolDefinition } from "../../defineTool.js";
import { createInviteTool } from "./createInvite.js";
import { deleteTenantTool } from "./deleteTenant.js";
import { getToolUsageTool } from "./getToolUsage.js";
import { getTranscriptionUsageTool } from "./getTranscriptionUsage.js";
import { listTenantsTool } from "./listTenants.js";
import { resetPasswordTool } from "./resetPassword.js";
import { restoreTenantTool } from "./restoreTenant.js";
import { revokeTenantTool } from "./revokeTenant.js";

/** The tenant-management tools. Registered for the admin role only (see server wiring). */
export function createAdminTools(): ToolDefinition[] {
  return [
    listTenantsTool,
    getTranscriptionUsageTool,
    getToolUsageTool,
    createInviteTool,
    resetPasswordTool,
    revokeTenantTool,
    restoreTenantTool,
    deleteTenantTool,
  ] as unknown as ToolDefinition[];
}
