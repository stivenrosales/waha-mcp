import type { UploadStore, WriteResult } from "../../domain/ports/UploadStore.js";
import type { Logger } from "../mcp/defineTool.js";
import type { SignedLinks } from "../media/signedLink.js";
import {
  alreadyUploadedPage,
  pickerPage,
  UPLOAD_PAGE_HEADERS,
  uploadedPage,
} from "./uploadPage.js";

/** Room for the multipart boundaries and part headers around the file. */
const MULTIPART_OVERHEAD = 64 * 1024;

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });

const html = (body: string) => new Response(body, { status: 200, headers: UPLOAD_PAGE_HEADERS });

function failure(result: Exclude<WriteResult, "ok">, maxBytes: number): Response {
  if (result === "too_large")
    return plain(413, `This file is too large (UPLOAD_MAX_BYTES is ${maxBytes}).`);
  if (result === "already_uploaded")
    return plain(409, "This link was already used. Ask for a new upload link.");
  return plain(404, "Not found");
}

const declaredLength = (req: Request): number | null => {
  const v = req.headers.get("content-length");
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
};

/**
 * `/upload/:token`: the signed token is the only credential and it names one slot.
 * - `GET`: a small page with a file picker (or "already uploaded").
 * - `PUT`: the raw file as the body (`curl -T file URL`); answers JSON.
 * - `POST`: `multipart/form-data` with a `file` field (the page's form); answers a page.
 * Bodies are streamed to disk and refused past `maxBytes`. This route never talks to WAHA.
 */
export function createUploadHandler(deps: {
  store: UploadStore;
  links: SignedLinks;
  maxBytes: number;
  logger?: Logger;
}): (req: Request, token: string) => Promise<Response> {
  const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

  return async (req, token) => {
    const id = deps.links.verify(token);
    const slot = id === null ? null : deps.store.get(id);
    if (id === null || !slot) {
      await req.body?.cancel().catch(() => {});
      return plain(404, "Not found");
    }

    if (req.method === "GET")
      return html(slot.uploaded ? alreadyUploadedPage() : pickerPage(slot.filename));

    const length = declaredLength(req);

    if (req.method === "PUT") {
      if (length !== null && length > deps.maxBytes) {
        await req.body?.cancel().catch(() => {});
        return failure("too_large", deps.maxBytes);
      }
      const result = await deps.store.write(
        id,
        req.body ?? empty(),
        req.headers.get("content-type"),
      );
      deps.logger?.info(`upload method=PUT result=${result}`);
      if (result !== "ok") return failure(result, deps.maxBytes);
      return Response.json(
        { upload_id: id, size: deps.store.get(id)?.size ?? 0, status: "uploaded" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (req.method === "POST") {
      // `formData()` buffers the whole body, so its size must be known and bounded first.
      if (length === null) {
        await req.body?.cancel().catch(() => {});
        return plain(411, "Content-Length is required.");
      }
      if (length > deps.maxBytes + MULTIPART_OVERHEAD) {
        await req.body?.cancel().catch(() => {});
        return failure("too_large", deps.maxBytes);
      }
      let file: ReturnType<FormData["get"]>;
      try {
        file = (await req.formData()).get("file");
      } catch {
        return plain(400, "Expected a multipart form with a file field.");
      }
      if (!(file instanceof File))
        return plain(400, "Expected a multipart form with a file field.");
      const result = await deps.store.write(id, file.stream(), file.type || null);
      deps.logger?.info(`upload method=POST result=${result}`);
      if (result !== "ok") return failure(result, deps.maxBytes);
      return html(uploadedPage());
    }

    return plain(405, "Method not allowed");
  };
}
