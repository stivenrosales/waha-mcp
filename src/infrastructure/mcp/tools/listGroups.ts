import { z } from "zod";
import { listGroups } from "../../../application/groups.js";
import type { ToolDefinition } from "../defineTool.js";
import { groupSummarySchema } from "./schemas.js";

const inputSchema = z.object({
  name_contains: z
    .string()
    .optional()
    .describe("Case-insensitive substring of the group name to filter by."),
});
const outputSchema = z.object({ groups: z.array(groupSummarySchema) });

export const listGroupsTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "list_groups",
  title: "List WhatsApp groups",
  description:
    "Lists the WhatsApp groups the owner belongs to (id, name, participant count, last activity), most recently active first. Use the id with get_group_info, get_messages or get_chat_stats.",
  inputSchema,
  outputSchema,
  async run(input, { gateway, mapper }) {
    const groups = await listGroups(gateway, mapper, { nameContains: input.name_contains });
    const lines = groups.map(
      (g) =>
        `- ${g.name} (${g.id}) · ${g.participantCount} participants · last activity ${g.lastActivity ?? "unknown"}`,
    );
    const text =
      groups.length === 0 ? "No groups found." : `${groups.length} groups:\n${lines.join("\n")}`;
    return { text, data: { groups } };
  },
};
