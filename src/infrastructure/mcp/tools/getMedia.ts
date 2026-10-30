import { z } from "zod";
import { baseMimetype, isInlineImage, MEDIA_GONE, resolveMedia } from "../../media/resolveMedia.js";
import type { ToolDefinition } from "../defineTool.js";

const inputSchema = z.object({
  media_id: z.string().min(1).describe("attachment.mediaId from get_messages."),
});

export const getMediaTool: ToolDefinition<typeof inputSchema> = {
  name: "get_media",
  title: "Get a message attachment",
  description:
    "Fetches one attachment on demand. Small images and stickers are returned inline as an image; anything else (large images, video, audio, documents) as a short-lived signed download link.",
  inputSchema,
  async run(input, { gateway, config, links }) {
    const media = await resolveMedia(gateway, input.media_id);
    if (!media) return { content: [{ type: "text", text: MEDIA_GONE }] };
    if (isInlineImage(media.mimetype) && media.bytes.byteLength <= config.mediaInlineMaxBytes) {
      return {
        content: [
          {
            type: "image",
            data: Buffer.from(media.bytes).toString("base64"),
            mimeType: baseMimetype(media.mimetype),
          },
        ],
      };
    }
    const { token, expiresAt } = links.issue(input.media_id);
    const name = media.filename ? ` "${media.filename}"` : "";
    const text = `File${name} (${media.mimetype}, ${media.bytes.byteLength} bytes): ${config.publicBaseUrl}/media/${token}\nThe link expires at ${expiresAt}.`;
    return { content: [{ type: "text", text }] };
  },
};
