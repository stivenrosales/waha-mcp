import { z } from "zod";
import { TRANSCRIPTION_NOT_CONFIGURED } from "../../../application/transcripts.js";
import { MEDIA_GONE } from "../../media/resolveMedia.js";
import type { ToolDefinition } from "../defineTool.js";

const inputSchema = z.object({
  media_id: z
    .string()
    .min(1)
    .describe("attachment.mediaId of an audio message or voice note, from get_messages."),
});
const outputSchema = z.object({
  transcript: z.string().nullable(),
  cached: z.boolean().describe("True when the transcript was already stored (no provider call)."),
  durationSeconds: z.number().optional(),
});

export const transcribeAudioTool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "transcribe_audio",
  title: "Transcribe an audio message",
  description:
    "Transcribes one audio message or voice note on demand (any length, up to the server's media size limit) and stores the result, so it is never paid twice. Voice notes in get_messages, get_thread, list_pending_replies and get_activity_digest are already transcribed automatically within limits; use this for the ones a coverage note says were skipped, or for plain audio files. Read-only for WhatsApp; the audio is sent to the transcription provider configured on the server.",
  inputSchema,
  outputSchema,
  async run(input, { mapper, transcription }) {
    if (!transcription.enabled)
      return {
        text: TRANSCRIPTION_NOT_CONFIGURED,
        data: { transcript: null, cached: false },
      };
    const r = await transcription.transcribeMedia(input.media_id, mapper);
    if (r.status === "gone") return { text: MEDIA_GONE, data: { transcript: null, cached: false } };
    const { status: _status, ...data } = r;
    const length = r.durationSeconds === undefined ? "" : `, ${r.durationSeconds} s`;
    const source = r.cached ? "stored transcript" : "new transcript";
    return { text: `Transcript (${source}${length}):\n${r.transcript}`, data };
  },
};
