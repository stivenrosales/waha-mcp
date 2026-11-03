import { basename } from "node:path";
import { z } from "zod";
import { assertTextLength, pickMediaKind } from "../../../application/send.js";
import { toWhatsAppText } from "../../../application/whatsappFormat.js";
import { InvalidInputError } from "../../../domain/errors.js";
import type { FileSource, SentMessage } from "../../../domain/ports/WhatsAppSender.js";
import { baseMimetype, MEDIA_GONE, openMediaById, readCapped } from "../../media/resolveMedia.js";
import { mimetypeFromFilename } from "../../uploads/fsUploadStore.js";
import { SEND_ANNOTATIONS, type ToolDefinition, type ToolRunContext } from "../defineTool.js";
import {
  chatIdField,
  replyToField,
  SEND_POLICY,
  sendOutputSchema,
  sentResult,
  WHATSAPP_FORMAT_RULES,
} from "./sendShared.js";

const inputSchema = z.object({
  chat_id: chatIdField,
  upload_id: z.string().min(1).optional().describe("From create_upload_link, after the upload."),
  media_id: z
    .string()
    .min(1)
    .optional()
    .describe("attachment.mediaId of a file already in WhatsApp, to forward it."),
  url: z.string().min(1).optional().describe("Public https URL of the file."),
  caption: z.string().min(1).optional().describe("Text under the file, in WhatsApp formatting."),
  as: z
    .enum(["auto", "image", "video", "voice", "document"])
    .default("auto")
    .describe(
      "auto follows the file type (image, video, audio → voice note, anything else → document). Use document to send a photo without compression.",
    ),
  reply_to: replyToField,
});

const ONE_SOURCE = "Pass exactly one of upload_id, media_id or url.";
const UPLOAD_GONE = "This upload was already sent or has expired. Create a new upload link.";
const TOO_LARGE = "This file is too large to forward.";

async function resolveFile(
  input: z.output<typeof inputSchema>,
  ctx: ToolRunContext,
): Promise<FileSource> {
  if (input.upload_id !== undefined) {
    const slot = ctx.uploads.get(input.upload_id);
    if (!slot) throw new InvalidInputError(UPLOAD_GONE);
    if (!slot.uploaded) {
      const url = `${ctx.config.publicBaseUrl}/upload/${ctx.uploadLinks.sign(slot.id)}`;
      throw new InvalidInputError(`The file has not been uploaded yet. Upload it to ${url} first.`);
    }
    const file = await ctx.uploads.read(slot.id);
    if (!file) throw new InvalidInputError(UPLOAD_GONE);
    return file;
  }

  if (input.media_id !== undefined) {
    const media = await openMediaById(ctx.gateway, input.media_id, ctx.mapper);
    if (!media) throw new InvalidInputError(MEDIA_GONE);
    const max = ctx.config.mediaMaxBytes;
    if (media.size !== null && media.size > max) {
      await media.body.cancel().catch(() => {});
      throw new InvalidInputError(TOO_LARGE);
    }
    const data = await readCapped(media.body, max, ctx.mediaIdleTimeoutMs);
    if (!data) throw new InvalidInputError(TOO_LARGE);
    return { data, mimetype: baseMimetype(media.mimetype), filename: media.filename ?? "file" };
  }

  const raw = input.url as string;
  const parsed = URL.canParse(raw) ? new URL(raw) : null;
  if (parsed?.protocol !== "https:") throw new InvalidInputError("url must be a public https URL.");
  const filename = basename(decodeURIComponent(parsed.pathname)) || "file";
  return { url: parsed.href, mimetype: mimetypeFromFilename(filename), filename };
}

export const sendMediaTool: ToolDefinition<typeof inputSchema, typeof sendOutputSchema> = {
  name: "send_media",
  title: "Send a WhatsApp image, video, voice note or document",
  description: `Sends a file from the owner's WhatsApp to a person or group: an upload from create_upload_link (upload_id), a file already in WhatsApp (media_id, to forward it) or a public https URL (url). The message kind follows the file type unless "as" says otherwise; voice notes cannot have a caption. ${SEND_POLICY}\n\nCaptions: ${WHATSAPP_FORMAT_RULES}`,
  inputSchema,
  outputSchema: sendOutputSchema,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const sources = [input.upload_id, input.media_id, input.url].filter((v) => v !== undefined);
    if (sources.length !== 1) throw new InvalidInputError(ONE_SOURCE);

    const file = await resolveFile(input, ctx);
    const kind = pickMediaKind(file.mimetype, input.as);
    const caption = input.caption === undefined ? undefined : toWhatsAppText(input.caption);
    if (caption !== undefined) {
      if (kind === "voice") throw new InvalidInputError("Voice notes cannot have a caption.");
      assertTextLength(caption);
    }

    const target = {
      chatId: input.chat_id,
      ...(input.reply_to ? { replyTo: input.reply_to } : {}),
    };
    const withCaption = { ...target, file, ...(caption === undefined ? {} : { caption }) };
    let sent: SentMessage;
    if (kind === "image") sent = await ctx.sender.sendImage(withCaption);
    else if (kind === "video") sent = await ctx.sender.sendVideo(withCaption);
    else if (kind === "voice") sent = await ctx.sender.sendVoice({ ...target, file });
    else sent = await ctx.sender.sendFile(withCaption);

    // Only after WAHA confirmed: a failed send keeps the upload for a retry.
    if (input.upload_id !== undefined) ctx.uploads.remove(input.upload_id);
    return sentResult(input.chat_id, sent, caption);
  },
};
