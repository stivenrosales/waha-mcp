import { InvalidInputError, WahaNotFoundError } from "../../domain/errors.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import { decodeMediaId } from "../waha/engines/gows.js";

export interface ResolvedMedia {
  bytes: Uint8Array;
  /** The original mimetype reported for the message (falls back to the file response). */
  mimetype: string;
  filename: string | null;
}

export const MEDIA_GONE = "This file is no longer available on WAHA.";

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/**
 * mediaId → message (`downloadMedia=true`) → `media.url` → file bytes.
 * Returns `null` when the message, its media URL or the file is gone.
 * Throws `InvalidInputError` for a malformed id; other WAHA errors propagate.
 */
export async function resolveMedia(
  gw: WahaGateway,
  mediaId: string,
): Promise<ResolvedMedia | null> {
  const ref = decodeMediaId(mediaId);
  if (!ref)
    throw new InvalidInputError(
      "Invalid media_id. Use the attachment.mediaId returned by get_messages.",
    );
  try {
    const media = asRecord(asRecord(await gw.getMessage(ref.chatId, ref.messageId)).media);
    const url = nonEmpty(media.url);
    if (!url) return null;
    const file = await gw.fetchMedia(url);
    if (!file) return null;
    return {
      bytes: file.bytes,
      mimetype: nonEmpty(media.mimetype) ?? file.mimetype,
      filename: nonEmpty(media.filename),
    };
  } catch (err) {
    if (err instanceof WahaNotFoundError) return null;
    throw err;
  }
}

const INLINE_SAFE = /^(image\/(jpeg|png|gif|webp)|audio\/[\w.+-]+|video\/[\w.+-]+)$/;

/** Base mimetype without parameters, lowercased. */
export const baseMimetype = (mimetype: string): string =>
  (mimetype.split(";")[0] ?? "").trim().toLowerCase();

/** Raster images WhatsApp sends as photos or stickers; SVG is never inlined. */
export const isInlineImage = (mimetype: string): boolean =>
  /^image\/(jpeg|png|gif|webp)$/.test(baseMimetype(mimetype));

/** Browser-safe types are shown inline; everything else is forced to download. */
export function contentDisposition(mimetype: string, filename: string | null): string {
  const type = INLINE_SAFE.test(baseMimetype(mimetype)) ? "inline" : "attachment";
  if (!filename) return type;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
