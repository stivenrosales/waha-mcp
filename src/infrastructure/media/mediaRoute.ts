import {
  InvalidInputError,
  UnsupportedEngineError,
  WahaAuthError,
  WahaNotFoundError,
  WahaUnavailableError,
} from "../../domain/errors.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import type { Logger } from "../mcp/defineTool.js";
import { capStream, contentDisposition, openMediaById } from "./resolveMedia.js";
import type { SignedLinks } from "./signedLink.js";

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });

const isDomainError = (err: unknown) =>
  err instanceof WahaAuthError ||
  err instanceof WahaUnavailableError ||
  err instanceof WahaNotFoundError ||
  err instanceof UnsupportedEngineError;

/**
 * `GET /media/:token`: the signed token is the only credential. Its verified
 * payload is a mediaId, re-resolved against WAHA on every request, so a file
 * deleted on WAHA stops being served even while the link is still valid.
 * The body is streamed, never buffered: a declared size above `maxBytes` is
 * refused with 413, and the stream is aborted as soon as it passes the declared
 * Content-Length (or `maxBytes` when none was declared).
 */
export function createMediaHandler(deps: {
  gateway: WahaGateway;
  links: SignedLinks;
  maxBytes: number;
  logger?: Logger;
}): (token: string) => Promise<Response> {
  return async (token) => {
    const mediaId = deps.links.verify(token);
    if (mediaId === null) return plain(404, "Not found");
    try {
      const media = await openMediaById(deps.gateway, mediaId);
      if (!media) return plain(404, "Not found");
      if (media.length !== null && media.length > deps.maxBytes) {
        await media.body.cancel().catch(() => {});
        return plain(
          413,
          `This file is too large to serve (${media.length} bytes; MEDIA_MAX_BYTES is ${deps.maxBytes}).`,
        );
      }
      const headers: Record<string, string> = {
        "Content-Type": media.mimetype,
        "Content-Disposition": contentDisposition(media.mimetype, media.filename),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
      };
      if (media.length !== null) headers["Content-Length"] = String(media.length);
      const body = media.body.pipeThrough(capStream(media.length ?? deps.maxBytes));
      return new Response(body, { status: 200, headers });
    } catch (err) {
      if (err instanceof InvalidInputError) return plain(404, "Not found");
      const name = err instanceof Error ? err.name : "UnknownError";
      deps.logger?.info(`media result=${name}`);
      if (!isDomainError(err))
        deps.logger?.info(
          err instanceof Error
            ? `media error stack:\n${err.stack}`
            : `media error raw=${String(err)}`,
        );
      return plain(502, "Could not load this file from WAHA right now.");
    }
  };
}
