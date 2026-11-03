import { z } from "zod";
import { SEND_ANNOTATIONS, type ToolDefinition } from "../defineTool.js";

const inputSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .describe("Name the file will have on WhatsApp, with its extension (e.g. Quote.pdf)."),
  mimetype: z
    .string()
    .min(1)
    .optional()
    .describe("Mimetype, when known; otherwise taken from the upload or the extension."),
});
const outputSchema = z.object({
  upload_id: z.string().describe("Pass it to send_media once the file is uploaded."),
  upload_url: z.string(),
  expires_at: z.string(),
  curl: z.string().describe("Upload command; replace <path-to-file>."),
});

export const createUploadLinkTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "create_upload_link",
  title: "Create a link to upload a file to send",
  description:
    "First step to send a file the owner gave you in this conversation (image, PDF, audio, video...). Returns a one-time upload link that expires in minutes; the file goes to the server without passing through the conversation. Then: if your code sandbox has the file, run the returned curl command with <path-to-file> replaced (your sandbox needs network access to this server's domain); otherwise give the owner the upload_url to open in a browser and pick the file. Finally call send_media with the upload_id. For a file already in WhatsApp use send_media with media_id instead; for a public https URL use send_media with url.",
  inputSchema,
  outputSchema,
  annotations: SEND_ANNOTATIONS,
  async run(input, { uploads, uploadLinks, config }) {
    const slot = uploads.create({ filename: input.filename, mimetype: input.mimetype ?? null });
    const uploadUrl = `${config.publicBaseUrl}/upload/${uploadLinks.sign(slot.id)}`;
    const data = {
      upload_id: slot.id,
      upload_url: uploadUrl,
      expires_at: new Date(slot.expiresAt).toISOString(),
      curl: `curl -fsS -T '<path-to-file>' '${uploadUrl}'`,
    };
    return {
      text: `Upload link for ${input.filename} (one use, expires ${data.expires_at}):\n${uploadUrl}\n\nFrom your code sandbox: ${data.curl}\nOr give the owner the link to open and pick the file. Then call send_media with upload_id "${slot.id}".`,
      data,
    };
  },
};
