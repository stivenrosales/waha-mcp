import { z } from "zod";
import { listChats } from "../../../application/groups.js";
import type { ToolDefinition } from "../defineTool.js";
import { chatSummarySchema, label } from "./schemas.js";

const inputSchema = z.object({
  name_contains: z
    .string()
    .optional()
    .describe("Case-insensitive substring of the contact name or phone number to filter by."),
});
const outputSchema = z.object({
  chats: z.array(chatSummarySchema),
  namesResolved: z.boolean(),
  note: z.string().optional(),
});

const NAMES_NOTE =
  "Note: contact names could not be loaded from WAHA, so chats are listed by id/phone only and name filtering may miss chats.";

export const listChatsTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "list_chats",
  title: "List direct chats",
  description:
    "Lists the owner's direct (1:1) WhatsApp chats (id, contact name, phone, last activity), most recently active first. Groups are listed by list_groups instead. Use the id with get_messages or get_chat_stats.",
  inputSchema,
  outputSchema,
  async run(input, { gateway, mapper }) {
    const { chats, namesResolved } = await listChats(gateway, mapper, {
      nameContains: input.name_contains,
    });
    const lines = chats.map(
      (c) => `- ${label(c.name, c.id)} · last activity ${c.lastActivity ?? "unknown"}`,
    );
    const body =
      chats.length === 0
        ? "No direct chats found."
        : `${chats.length} direct chats:\n${lines.join("\n")}`;
    const note = namesResolved ? undefined : NAMES_NOTE;
    return {
      text: note ? `${body}\n\n${note}` : body,
      data: { chats, namesResolved, ...(note ? { note } : {}) },
    };
  },
};
