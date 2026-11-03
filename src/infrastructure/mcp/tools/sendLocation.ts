import { z } from "zod";
import { SEND_ANNOTATIONS, type ToolDefinition } from "../defineTool.js";
import {
  chatIdField,
  replyToField,
  SEND_POLICY,
  sendOutputSchema,
  sentResult,
} from "./sendShared.js";

const inputSchema = z.object({
  chat_id: chatIdField,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  title: z.string().min(1).optional().describe("Name shown on the pin, e.g. the place's name."),
  reply_to: replyToField,
});

export const sendLocationTool: ToolDefinition<typeof inputSchema, typeof sendOutputSchema> = {
  name: "send_location",
  title: "Send a WhatsApp location",
  description: `Sends a location pin from the owner's WhatsApp to a person or group. ${SEND_POLICY}`,
  inputSchema,
  outputSchema: sendOutputSchema,
  annotations: SEND_ANNOTATIONS,
  async run(input, { sender }) {
    const sent = await sender.sendLocation({
      chatId: input.chat_id,
      latitude: input.latitude,
      longitude: input.longitude,
      ...(input.title ? { title: input.title } : {}),
      ...(input.reply_to ? { replyTo: input.reply_to } : {}),
    });
    return sentResult(input.chat_id, sent);
  },
};
