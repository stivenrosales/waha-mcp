import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { UploadSlot, UploadStore, WriteResult } from "../../domain/ports/UploadStore.js";

const ID = /^[A-Za-z0-9_-]{32}$/;
const GENERIC = "application/octet-stream";

const EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

export function mimetypeFromFilename(name: string): string {
  return EXTENSIONS[extname(name).toLowerCase()] ?? GENERIC;
}

interface Meta extends UploadSlot {
  /** Content-Type the upload arrived with, when meaningful. */
  contentType: string | null;
}

/**
 * Upload slots on disk: `<id>.json` holds the metadata (so slots survive a restart),
 * `<id>.part` is an upload in progress, `<id>.bin` the finished file. All mode 0600
 * inside a 0700 directory.
 */
export function createFsUploadStore(opts: {
  dir: string;
  ttlSeconds: number;
  maxBytes: number;
  now?: () => number;
}): UploadStore {
  const now = opts.now ?? Date.now;
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dir, 0o700);

  const path = (id: string, ext: string) => join(opts.dir, `${id}.${ext}`);
  const saveMeta = (m: Meta) =>
    writeFileSync(path(m.id, "json"), JSON.stringify(m), { mode: 0o600 });

  function loadMeta(id: string): Meta | null {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(readFileSync(path(id, "json"), "utf8")) as Meta;
    } catch {
      return null;
    }
  }

  function live(id: string): Meta | null {
    const m = loadMeta(id);
    return m && now() <= m.expiresAt ? m : null;
  }

  const toSlot = ({ contentType: _ignored, ...slot }: Meta): UploadSlot => slot;

  function removeFiles(id: string): void {
    for (const ext of ["bin", "part", "json"]) rmSync(path(id, ext), { force: true });
  }

  return {
    create({ filename, mimetype }) {
      const meta: Meta = {
        id: randomBytes(24).toString("base64url"),
        filename,
        mimetype,
        size: null,
        expiresAt: now() + opts.ttlSeconds * 1000,
        uploaded: false,
        contentType: null,
      };
      saveMeta(meta);
      return toSlot(meta);
    },

    get(id) {
      const m = live(id);
      return m ? toSlot(m) : null;
    },

    async write(id, body, contentType): Promise<WriteResult> {
      const m = live(id);
      if (!m) {
        await body.cancel().catch(() => {});
        return "not_found";
      }
      if (m.uploaded) {
        await body.cancel().catch(() => {});
        return "already_uploaded";
      }
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        // "wx": a concurrent upload to the same slot loses instead of interleaving.
        handle = await open(path(id, "part"), "wx", 0o600);
      } catch {
        await body.cancel().catch(() => {});
        return "already_uploaded";
      }
      let size = 0;
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > opts.maxBytes) {
            await reader.cancel().catch(() => {});
            await handle.close();
            rmSync(path(id, "part"), { force: true });
            return "too_large";
          }
          await handle.write(value);
        }
        await handle.close();
      } catch (err) {
        await handle.close().catch(() => {});
        rmSync(path(id, "part"), { force: true });
        throw err;
      }
      renameSync(path(id, "part"), path(id, "bin"));
      const type = contentType?.split(";")[0]?.trim().toLowerCase() || null;
      saveMeta({
        ...m,
        uploaded: true,
        size,
        contentType: type && type !== GENERIC ? type : null,
      });
      return "ok";
    },

    async read(id) {
      const m = live(id);
      if (!m?.uploaded) return null;
      const data = new Uint8Array(await readFile(path(id, "bin")));
      return {
        data,
        filename: m.filename,
        mimetype: m.mimetype ?? m.contentType ?? mimetypeFromFilename(m.filename),
      };
    },

    remove(id) {
      if (ID.test(id)) removeFiles(id);
    },

    sweep() {
      const ids = new Set(
        readdirSync(opts.dir)
          .map((f) => f.replace(/\.(json|bin|part)$/, ""))
          .filter((id) => ID.test(id)),
      );
      let removed = 0;
      for (const id of ids) {
        const m = loadMeta(id);
        if (m && now() <= m.expiresAt) continue;
        removeFiles(id);
        removed++;
      }
      return removed;
    },
  };
}
