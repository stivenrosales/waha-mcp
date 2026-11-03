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
  full_name: z.string().min(1),
  phone_number: z
    .string()
    .regex(/\d/, "phone_number must contain digits.")
    .describe("With country code, e.g. +51 999 888 777."),
  organization: z.string().min(1).optional(),
  reply_to: replyToField,
});

export const sendContactTool: ToolDefinition<typeof inputSchema, typeof sendOutputSchema> = {
  name: "send_contact",
  title: "Send a WhatsApp contact card",
  description: `Sends one contact card (vCard) from the owner's WhatsApp to a person or group. ${SEND_POLICY}`,
  inputSchema,
  outputSchema: sendOutputSchema,
  annotations: SEND_ANNOTATIONS,
  async run(input, { sender }) {
    const sent = await sender.sendContact({
      chatId: input.chat_id,
      fullName: input.full_name,
      phoneNumber: input.phone_number,
      ...(input.organization ? { organization: input.organization } : {}),
      ...(input.reply_to ? { replyTo: input.reply_to } : {}),
    });
    return sentResult(input.chat_id, sent);
  },
};
