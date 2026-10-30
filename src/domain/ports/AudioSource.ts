import type { Attachment, EngineMapper } from "../message.js";

export interface AudioFile {
  bytes: Uint8Array;
  mimetype: string;
  /** Declared length in seconds (only known when loaded with a mapper). */
  durationSeconds: number | null;
}

export type AudioLoad =
  | { status: "ok"; file: AudioFile }
  /** The message, its media URL or the file is no longer on WAHA. */
  | { status: "gone" }
  | { status: "not-audio"; kind: Attachment["kind"] | null }
  /** Larger than MEDIA_MAX_BYTES. */
  | { status: "too-large" };

/** Audio bytes of a message attachment, by the opaque `attachment.mediaId`. */
export interface AudioSource {
  /** Chat and message behind a media id; null when the id is malformed. */
  keyOf(mediaId: string): { chatId: string; messageId: string } | null;
  /** Throws `InvalidInputError` for a malformed id; WAHA failures propagate. */
  load(mediaId: string, mapper?: EngineMapper): Promise<AudioLoad>;
}
