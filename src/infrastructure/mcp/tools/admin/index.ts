import type { ToolDefinition } from "../../defineTool.js";
import { createInviteTool } from "./createInvite.js";
import { deleteTenantTool } from "./deleteTenant.js";
import { getLlmUsageTool } from "./getLlmUsage.js";
import { getToolUsageTool } from "./getToolUsage.js";
import { getTranscriptionUsageTool } from "./getTranscriptionUsage.js";
import { listTenantsTool } from "./listTenants.js";
import { resetPasswordTool } from "./resetPassword.js";
import { restoreTenantTool } from "./restoreTenant.js";
import { revokeTenantTool } from "./revokeTenant.js";

/**
 * The usage tools: what the owner of a single-owner server keeps (`MULTI_TENANT` off). Registered
 * for the admin role only (see server wiring).
 */
export function createUsageTools(): ToolDefinition[] {
  return [
    getTranscriptionUsageTool,
    getToolUsageTool,
    getLlmUsageTool,
  ] as unknown as ToolDefinition[];
}

/** The tenant-management tools plus the usage tools. Registered for the admin role only. */
export function createAdminTools(): ToolDefinition[] {
  return [
    listTenantsTool,
    ...createUsageTools(),
    createInviteTool,
    resetPasswordTool,
    revokeTenantTool,
    restoreTenantTool,
    deleteTenantTool,
  ] as unknown as ToolDefinition[];
}
