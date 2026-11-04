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
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { UploadSlot, UploadStore, WriteResult } from "../../domain/ports/UploadStore.js";
import { DecryptionError, isSealedText, type TenantCipher } from "../crypto/envelope.js";

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

/**
 * Tool argument, then a known extension, then the upload's Content-Type: clients often send
 * a default type (`text/plain` for a raw PUT body), while the filename was chosen on purpose.
 */
function resolveMimetype(m: Meta): string {
  if (m.mimetype) return m.mimetype;
  const fromName = mimetypeFromFilename(m.filename);
  return fromName !== GENERIC ? fromName : (m.contentType ?? GENERIC);
}

interface Meta extends UploadSlot {
  /** Content-Type the upload arrived with, when meaningful. */
  contentType: string | null;
}

/**
 * Upload slots on disk: `<id>.json` holds the metadata (so slots survive a restart),
 * `<id>.part` is an upload in progress, `<id>.bin` the finished file, both sealed
 * (`nonce|ciphertext|tag`, AAD `uploads:<id>`); plaintext never touches the disk. All mode 0600
 * inside a 0700 directory.
 */
export function createFsUploadStore(opts: {
  dir: string;
  ttlSeconds: number;
  /** Plaintext bytes allowed per upload. */
  maxBytes: number;
  cipher: TenantCipher;
  now?: () => number;
}): UploadStore {
  const now = opts.now ?? Date.now;
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dir, 0o700);

  const aad = (id: string) => `uploads:${id}`;
  const unseal = (id: string, file: Buffer): Uint8Array | null => {
    try {
      return new Uint8Array(opts.cipher.open(file, aad(id)));
    } catch (err) {
      if (err instanceof DecryptionError) return null;
      throw err;
    }
  };
  const path = (id: string, ext: string) => join(opts.dir, `${id}.${ext}`);
  // The filename is user content: sealed in the metadata file. The rest stays plaintext.
  const metaAad = (id: string) => `uploads-meta:${id}`;
  const saveMeta = (m: Meta) =>
    writeFileSync(
      path(m.id, "json"),
      JSON.stringify({ ...m, filename: opts.cipher.sealText(m.filename, metaAad(m.id)) }),
      { mode: 0o600 },
    );
  /** Slots with a body being received; reserved synchronously so one writer wins. */
  const inFlight = new Set<string>();

  function loadMeta(id: string): Meta | null {
    if (!ID.test(id)) return null;
    try {
      const m = JSON.parse(readFileSync(path(id, "json"), "utf8")) as Meta;
      if (isSealedText(m.filename)) m.filename = opts.cipher.openText(m.filename, metaAad(id));
      return m;
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
    for (const ext of ["bin", "sending", "part", "json"]) rmSync(path(id, ext), { force: true });
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
      if (inFlight.has(id)) {
        await body.cancel().catch(() => {});
        return "already_uploaded";
      }
      inFlight.add(id);
      try {
        // Buffered in memory (bounded by maxBytes) so the file is sealed once, as one GCM message.
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > opts.maxBytes) {
            await reader.cancel().catch(() => {});
            return "too_large";
          }
          chunks.push(value);
        }
        // Everything from here to the return is synchronous: re-check the slot, then commit.
        const current = live(id);
        if (!current) return "not_found";
        if (current.uploaded) return "already_uploaded";
        const sealed = opts.cipher.seal(Buffer.concat(chunks), aad(id));
        writeFileSync(path(id, "part"), sealed, { mode: 0o600 });
        renameSync(path(id, "part"), path(id, "bin"));
        const type = contentType?.split(";")[0]?.trim().toLowerCase() || null;
        saveMeta({
          ...current,
          uploaded: true,
          size,
          contentType: type && type !== GENERIC ? type : null,
        });
        return "ok";
      } finally {
        inFlight.delete(id);
      }
    },

    async read(id) {
      const m = live(id);
      if (!m?.uploaded) return null;
      const data = unseal(id, await readFile(path(id, "bin")));
      if (!data) return null;
      return {
        data,
        filename: m.filename,
        mimetype: resolveMimetype(m),
      };
    },

    async claim(id) {
      const m = live(id);
      if (!m?.uploaded) return null;
      try {
        // rename is atomic: of two concurrent claims, only one finds `.bin`.
        renameSync(path(id, "bin"), path(id, "sending"));
      } catch {
        return null;
      }
      const data = unseal(id, await readFile(path(id, "sending")));
      if (!data) {
        // Unreadable (tampered) file: put it back so the slot is not left half-claimed.
        renameSync(path(id, "sending"), path(id, "bin"));
        return null;
      }
      return { data, filename: m.filename, mimetype: resolveMimetype(m) };
    },

    release(id) {
      if (!ID.test(id)) return;
      try {
        renameSync(path(id, "sending"), path(id, "bin"));
      } catch {
        // Already released or removed.
      }
    },

    remove(id) {
      if (ID.test(id)) removeFiles(id);
    },

    sweep() {
      const ids = new Set(
        readdirSync(opts.dir)
          .map((f) => f.replace(/\.(json|bin|sending|part)$/, ""))
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
