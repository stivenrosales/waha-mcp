import { InvalidInputError } from "../../domain/errors.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import type { Logger } from "../mcp/defineTool.js";
import { contentDisposition, resolveMedia } from "./resolveMedia.js";
import type { SignedLinks } from "./signedLink.js";

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });

/**
 * `GET /media/:token`: the signed token is the only credential. Its verified
 * payload is a mediaId, re-resolved against WAHA on every request, so a file
 * deleted on WAHA stops being served even while the link is still valid.
 */
export function createMediaHandler(deps: {
  gateway: WahaGateway;
  links: SignedLinks;
  logger?: Logger;
}): (token: string) => Promise<Response> {
  return async (token) => {
    const mediaId = deps.links.verify(token);
    if (mediaId === null) return notFound();
    try {
      const media = await resolveMedia(deps.gateway, mediaId);
      if (!media) return notFound();
      return new Response(media.bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: {
          "Content-Type": media.mimetype,
          "Content-Length": String(media.bytes.byteLength),
          "Content-Disposition": contentDisposition(media.mimetype, media.filename),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (err) {
      if (err instanceof InvalidInputError) return notFound();
      deps.logger?.info(`media result=${err instanceof Error ? err.name : "UnknownError"}`);
      return new Response("Could not load this file from WAHA right now.", {
        status: 502,
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  };
}
