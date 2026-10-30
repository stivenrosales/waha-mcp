import { InvalidInputError, MediaStalledError, WahaNotFoundError } from "../../domain/errors.js";
import type { EngineMapper } from "../../domain/message.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import { decodeMediaId } from "../waha/engines/gows.js";

export interface OpenedMedia {
  /** Unread file body: consume it (capped) or cancel it. */
  body: ReadableStream<Uint8Array>;
  /** The original mimetype reported for the message (falls back to the file response). */
  mimetype: string;
  filename: string | null;
  /** Content-Length declared by WAHA, or `null`. */
  length: number | null;
  /** Best known size: Content-Length, else the message's `fileLength`, else `null`. */
  size: number | null;
}

export const MEDIA_GONE = "This file is no longer available on WAHA.";

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/**
 * mediaId → message (`downloadMedia=true`) → `media.url` → opened (unread) file.
 * Returns `null` when the message, its media URL or the file is gone. Nothing is
 * buffered here. Throws `InvalidInputError` for a malformed id; other WAHA errors
 * propagate. With a `mapper`, the message's declared `fileLength` fills `size`.
 */
export async function openMediaById(
  gw: WahaGateway,
  mediaId: string,
  mapper?: EngineMapper,
): Promise<OpenedMedia | null> {
  const ref = decodeMediaId(mediaId);
  if (!ref)
    throw new InvalidInputError(
      "Invalid media_id. Use the attachment.mediaId returned by get_messages.",
    );
  try {
    const raw = await gw.getMessage(ref.chatId, ref.messageId);
    const media = asRecord(asRecord(raw).media);
    const url = nonEmpty(media.url);
    if (!url) return null;
    const file = await gw.openMedia(url);
    if (!file) return null;
    const declared = mapper?.message(raw).attachment?.size ?? null;
    return {
      body: file.body,
      mimetype: nonEmpty(media.mimetype) ?? file.mimetype,
      filename: nonEmpty(media.filename),
      length: file.length,
      size: file.length ?? declared,
    };
  } catch (err) {
    if (err instanceof WahaNotFoundError) return null;
    throw err;
  }
}

/** No chunk from WAHA for this long → the file transfer is considered stalled. */
export const MEDIA_IDLE_TIMEOUT_MS = 30_000;

/**
 * Wraps a WAHA body so that waiting more than `idleMs` for the next chunk errors
 * the stream with `MediaStalledError` and cancels the upstream body. Pull-based:
 * nothing is read until the consumer asks.
 */
export function withIdleTimeout(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MediaStalledError()), idleMs);
        });
        try {
          const { done, value } = await Promise.race([reader.read(), stalled]);
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          reader.cancel(err).catch(() => {});
          controller.error(err);
        } finally {
          clearTimeout(timer);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/**
 * Reads at most `max` bytes, with the idle timeout. Returns `null` (and cancels the source) as soon as
 * more arrive, so a lying size can never make us buffer more than `max`.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
  idleMs: number = MEDIA_IDLE_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  // A stalled body rejects with MediaStalledError (upstream already cancelled).
  const reader = withIdleTimeout(body, idleMs).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Passes bytes through and errors the stream (cancelling the source) past `max` bytes. */
export function capStream(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) controller.error(new Error("Media stream exceeded its size limit."));
      else controller.enqueue(chunk);
    },
  });
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
