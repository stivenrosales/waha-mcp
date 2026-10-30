import { z } from "zod";
import {
  baseMimetype,
  isInlineImage,
  MEDIA_GONE,
  openMediaById,
  readCapped,
} from "../../media/resolveMedia.js";
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
  async run(input, { gateway, mapper, config, links }) {
    const media = await openMediaById(gateway, input.media_id, mapper);
    if (!media) return { content: [{ type: "text", text: MEDIA_GONE }] };
    // Decide from the declared size; only a small image of known size is ever read,
    // and reading stops if more bytes arrive than were declared.
    if (
      isInlineImage(media.mimetype) &&
      media.size !== null &&
      media.size <= config.mediaInlineMaxBytes
    ) {
      const bytes = await readCapped(media.body, media.size);
      if (bytes)
        return {
          content: [
            {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: baseMimetype(media.mimetype),
            },
          ],
        };
    } else {
      await media.body.cancel().catch(() => {});
    }
    const { token, expiresAt } = links.issue(input.media_id);
    const name = media.filename ? ` "${media.filename}"` : "";
    const size = media.size === null ? "unknown size" : `${media.size} bytes`;
    const text = `File${name} (${media.mimetype}, ${size}): ${config.publicBaseUrl}/media/${token}\nThe link expires at ${expiresAt}.`;
    return { content: [{ type: "text", text }] };
  },
};
