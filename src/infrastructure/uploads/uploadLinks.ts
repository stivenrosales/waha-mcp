import { createHmac } from "node:crypto";
import { createSignedLinks, type SignedLinks } from "../media/signedLink.js";

/**
 * Signed upload tokens. The key is derived from the media secret with a fixed label,
 * so an upload token never verifies as a media link (or the other way round).
 */
export function createUploadLinks(mediaSecret: Uint8Array, ttlSeconds: number): SignedLinks {
  const secret = new Uint8Array(createHmac("sha256", mediaSecret).update("upload").digest());
  return createSignedLinks({ secret, ttlSeconds });
}
