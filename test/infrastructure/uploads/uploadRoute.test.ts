import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UploadStore } from "../../../src/domain/ports/UploadStore.js";
import type { SignedLinks } from "../../../src/infrastructure/media/signedLink.js";
import { createFsUploadStore } from "../../../src/infrastructure/uploads/fsUploadStore.js";
import { createUploadLinks } from "../../../src/infrastructure/uploads/uploadLinks.js";
import { createUploadHandler } from "../../../src/infrastructure/uploads/uploadRoute.js";
import { testCipher } from "../../fakes/testCipher.js";

const MAX = 10;
let root: string;
let store: UploadStore;
let links: SignedLinks;
let handle: (req: Request, token: string) => Promise<Response>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "upload-route-"));
  store = createFsUploadStore({
    dir: join(root, "uploads"),
    ttlSeconds: 900,
    maxBytes: MAX,
    cipher: testCipher(),
  });
  links = createUploadLinks(new Uint8Array(32).fill(3), 900, "legacy");
  handle = createUploadHandler({ store, links, maxBytes: MAX });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const URL_ = "http://localhost:3000/upload/t";
const slot = (filename = "Cotización Ñandú 🎉.pdf") => {
  const s = store.create({ filename, mimetype: null });
  return { id: s.id, token: links.sign(s.id) };
};
const put = (body: string, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: "PUT", body, headers });
/** What a browser sends: a serialized form with its Content-Length. */
const multipart = async (content: string, name = "x.pdf") => {
  const form = new FormData();
  form.set("file", new File([content], name, { type: "application/pdf" }));
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return new Request(URL_, {
    method: "POST",
    body,
    headers: {
      "content-type": encoded.headers.get("content-type") ?? "",
      "content-length": String(body.byteLength),
    },
  });
};

describe("upload route", () => {
  it("answers 404 for bad or foreign tokens on every method", async () => {
    for (const method of ["GET", "PUT", "POST"]) {
      const res = await handle(
        new Request(URL_, { method, body: method === "GET" ? undefined : "x" }),
        "nope",
      );
      expect(res.status).toBe(404);
    }
    expect((await handle(put("x"), links.sign("x".repeat(32)))).status).toBe(404);
  });

  it("stores a PUT body once", async () => {
    const { id, token } = slot();
    const res = await handle(put("hola ñ"), token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upload_id: id, size: 7, status: "uploaded" });
    expect((await handle(put("again"), token)).status).toBe(409);
    expect((await store.read(id))?.filename).toBe("Cotización Ñandú 🎉.pdf");
  });

  it("refuses files over the limit, declared or streamed", async () => {
    const a = slot();
    const declared = await handle(put("x", { "content-length": String(MAX + 1) }), a.token);
    expect(declared.status).toBe(413);
    const b = slot();
    expect((await handle(put("x".repeat(MAX + 1)), b.token)).status).toBe(413);
    expect(store.get(b.id)?.uploaded).toBe(false);
  });

  it("accepts a multipart form upload and answers with a page", async () => {
    const { id, token } = slot();
    const req = await multipart("abc");
    const res = await handle(req, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Uploaded");
    expect((await store.read(id))?.mimetype).toBe("application/pdf");
  });

  it("requires a Content-Length for multipart uploads", async () => {
    const { token } = slot();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("--b\r\n"));
        c.close();
      },
    });
    const req = new Request(URL_, {
      method: "POST",
      body,
      headers: { "content-type": "multipart/form-data; boundary=b" },
      duplex: "half",
    } as RequestInit);
    expect((await handle(req, token)).status).toBe(411);
  });

  it("serves a picker page with security headers, then an already-uploaded page", async () => {
    const { token } = slot();
    const page = await handle(new Request(URL_), token);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<input type="file" name="file"');
    expect(html).toContain("Cotización Ñandú 🎉.pdf");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    await handle(put("x"), token);
    expect(await (await handle(new Request(URL_), token)).text()).toContain("Already uploaded");
  });

  it("escapes the filename in the page", async () => {
    const { token } = slot("<script>x</script>.pdf");
    const html = await (await handle(new Request(URL_), token)).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
