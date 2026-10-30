import type { AudioSource } from "../../domain/ports/AudioSource.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import {
  baseMimetype,
  MEDIA_IDLE_TIMEOUT_MS,
  openMediaById,
  readCapped,
} from "../media/resolveMedia.js";
import { decodeMediaId } from "../waha/engines/gows.js";

/**
 * Audio through the same path as `get_media`: mediaId → message (`downloadMedia=true`) →
 * WAHA file, read with the idle timeout and never more than `maxBytes` (MEDIA_MAX_BYTES).
 */
export function createWahaAudioSource(
  gw: WahaGateway,
  opts: { maxBytes: number; idleTimeoutMs?: number },
): AudioSource {
  const idle = opts.idleTimeoutMs ?? MEDIA_IDLE_TIMEOUT_MS;
  return {
    keyOf: (mediaId) => decodeMediaId(mediaId),
    async load(mediaId, mapper) {
      const media = await openMediaById(gw, mediaId, mapper);
      if (!media) return { status: "gone" };
      const audio =
        media.kind !== null
          ? media.kind === "audio" || media.kind === "voice"
          : baseMimetype(media.mimetype).startsWith("audio/");
      if (!audio) {
        await media.body.cancel().catch(() => {});
        return { status: "not-audio", kind: media.kind };
      }
      if (media.size !== null && media.size > opts.maxBytes) {
        await media.body.cancel().catch(() => {});
        return { status: "too-large" };
      }
      const bytes = await readCapped(media.body, opts.maxBytes, idle);
      if (!bytes) return { status: "too-large" };
      return {
        status: "ok",
        file: { bytes, mimetype: media.mimetype, durationSeconds: media.durationSeconds },
      };
    },
  };
}
