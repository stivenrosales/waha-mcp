import type { ToolDefinition } from "../defineTool.js";
import { getActivityDigestTool } from "./getActivityDigest.js";
import { getChatStatsTool } from "./getChatStats.js";
import { getContactTool } from "./getContact.js";
import { getGroupInfoTool } from "./getGroupInfo.js";
import { getMediaTool } from "./getMedia.js";
import { getMessagesTool } from "./getMessages.js";
import { getThreadTool } from "./getThread.js";
import { listChatsTool } from "./listChats.js";
import { listGroupsTool } from "./listGroups.js";
import { listPendingRepliesTool } from "./listPendingReplies.js";
import { listSharedFilesTool } from "./listSharedFiles.js";
import { searchMessagesTool } from "./searchMessages.js";

/** The read-only tools, in the order clients list them. */
export function createTools(): ToolDefinition[] {
  return [
    listGroupsTool,
    listChatsTool,
    getGroupInfoTool,
    getMessagesTool,
    getChatStatsTool,
    getMediaTool,
    listPendingRepliesTool,
    getActivityDigestTool,
    searchMessagesTool,
    getThreadTool,
    listSharedFilesTool,
    getContactTool,
  ] as unknown as ToolDefinition[];
}
