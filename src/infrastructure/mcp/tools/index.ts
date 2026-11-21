import type { ToolDefinition } from "../defineTool.js";
import { createUploadLinkTool } from "./createUploadLink.js";
import { deleteMessageTool } from "./deleteMessage.js";
import { editMessageTool } from "./editMessage.js";
import { getActivityDigestTool } from "./getActivityDigest.js";
import { getChatStatsTool } from "./getChatStats.js";
import { getContactTool } from "./getContact.js";
import { getGroupInfoTool } from "./getGroupInfo.js";
import { getMediaTool } from "./getMedia.js";
import { getMessagesTool } from "./getMessages.js";
import { getPollResultsTool } from "./getPollResults.js";
import { getThreadTool } from "./getThread.js";
import { listChatsTool } from "./listChats.js";
import { listGroupsTool } from "./listGroups.js";
import { listPendingRepliesTool } from "./listPendingReplies.js";
import { listSharedFilesTool } from "./listSharedFiles.js";
import { markReadTool, markUnreadTool } from "./markChat.js";
import {
  answerMissionTool,
  cancelMissionTool,
  getMissionTool,
  listMissionsTool,
  startMissionTool,
} from "./missions.js";
import { reactMessageTool } from "./reactMessage.js";
import { cancelScheduledTool, listScheduledTool, scheduleMessageTool } from "./schedules.js";
import { searchMessagesTool } from "./searchMessages.js";
import { deleteMyDataTool, unlinkAccountTool } from "./selfService.js";
import { sendContactTool } from "./sendContact.js";
import { sendLocationTool } from "./sendLocation.js";
import { sendMediaTool } from "./sendMedia.js";
import { sendPollTool } from "./sendPoll.js";
import { sendTextTool } from "./sendText.js";
import { transcribeAudioTool } from "./transcribeAudio.js";

/** Read tools first, then the tools that send, in the order clients list them. */
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
    getPollResultsTool,
    listSharedFilesTool,
    getContactTool,
    transcribeAudioTool,
    getMissionTool,
    listMissionsTool,
    listScheduledTool,
    sendTextTool,
    createUploadLinkTool,
    sendMediaTool,
    sendLocationTool,
    sendContactTool,
    sendPollTool,
    reactMessageTool,
    editMessageTool,
    deleteMessageTool,
    markReadTool,
    markUnreadTool,
    scheduleMessageTool,
    cancelScheduledTool,
    startMissionTool,
    answerMissionTool,
    cancelMissionTool,
    deleteMyDataTool,
    unlinkAccountTool,
  ] as unknown as ToolDefinition[];
}
