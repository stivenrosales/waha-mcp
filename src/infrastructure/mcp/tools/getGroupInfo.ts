import { z } from "zod";
import { getGroupInfo } from "../../../application/groups.js";
import { InvalidInputError } from "../../../domain/errors.js";
import type { ToolDefinition } from "../defineTool.js";
import { groupInfoSchema } from "./schemas.js";

const inputSchema = z.object({
  group_id: z.string().min(1).describe('Group id ending in "@g.us", as returned by list_groups.'),
});

export const NOT_A_GROUP =
  "get_group_info only works with group ids (…@g.us); use get_messages / get_chat_stats for direct chats.";

export const getGroupInfoTool: ToolDefinition<typeof inputSchema, typeof groupInfoSchema> = {
  name: "get_group_info",
  title: "Get group details",
  description:
    "Returns a group's name, description, creation date and current participants (with admins). Only for group ids (…@g.us).",
  inputSchema,
  outputSchema: groupInfoSchema,
  async run(input, { gateway, mapper }) {
    if (!input.group_id.endsWith("@g.us")) throw new InvalidInputError(NOT_A_GROUP);
    const g = await getGroupInfo(gateway, mapper, input.group_id);
    const admins = g.participants.filter((p) => p.isAdmin).map((p) => p.phone ?? p.id);
    const text = [
      `${g.name} (${g.id})`,
      `Participants: ${g.participants.length}`,
      `Admins: ${admins.length > 0 ? admins.join(", ") : "none listed"}`,
      `Created: ${g.createdAt ?? "unknown"}`,
      `Description: ${g.description ?? "(none)"}`,
      "The full participant list is in the structured result.",
    ].join("\n");
    return { text, data: g };
  },
};
