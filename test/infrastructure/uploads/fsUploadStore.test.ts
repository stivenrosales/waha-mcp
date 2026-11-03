import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFsUploadStore,
  mimetypeFromFilename,
} from "../../../src/infrastructure/uploads/fsUploadStore.js";

const T0 = 1_800_000_000_000;
let dir: string;
let clock: number;

const store = (maxBytes = 100) =>
  createFsUploadStore({ dir, ttlSeconds: 900, maxBytes, now: () => clock });

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "uploads-")), "uploads");
  clock = T0;
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("createFsUploadStore", () => {
  it("creates a pending slot with a private metadata file", () => {
    const slot = store().create({ filename: "Cotización Ñandú 🎉.pdf", mimetype: null });
    expect(slot.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(slot).toMatchObject({
      filename: "Cotización Ñandú 🎉.pdf",
      uploaded: false,
      size: null,
    });
    expect(slot.expiresAt).toBe(T0 + 900_000);
    expect(statSync(join(dir, `${slot.id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("stores the upload once and reads it back", async () => {
    const s = store();
    const { id } = s.create({ filename: "Cotización Ñandú 🎉.pdf", mimetype: null });
    expect(await s.write(id, stream("hola ", "ñ"), "application/pdf")).toBe("ok");
    expect(s.get(id)).toMatchObject({ uploaded: true, size: 7 });
    expect(await s.write(id, stream("again"), null)).toBe("already_uploaded");
    const file = await s.read(id);
    expect(file?.filename).toBe("Cotización Ñandú 🎉.pdf");
    expect(file?.mimetype).toBe("application/pdf");
    expect(new TextDecoder().decode(file?.data)).toBe("hola ñ");
  });

  it("refuses uploads over the limit and keeps nothing", async () => {
    const s = store(4);
    const { id } = s.create({ filename: "a.bin", mimetype: null });
    expect(await s.write(id, stream("abc", "de"), null)).toBe("too_large");
    expect(s.get(id)?.uploaded).toBe(false);
    expect(readdirSync(dir).filter((f) => !f.endsWith(".json"))).toEqual([]);
  });

  it("answers not_found for unknown or malformed ids", async () => {
    const s = store();
    expect(await s.write("x".repeat(32), stream("a"), null)).toBe("not_found");
    expect(await s.write("../../etc/passwd", stream("a"), null)).toBe("not_found");
    expect(s.get("../x")).toBeNull();
  });

  it("resolves the mimetype: tool argument, then upload Content-Type, then extension", async () => {
    const s = store();
    const a = s.create({ filename: "foto.JPG", mimetype: null });
    await s.write(a.id, stream("x"), null);
    expect((await s.read(a.id))?.mimetype).toBe("image/jpeg");
    const b = s.create({ filename: "foto.jpg", mimetype: null });
    await s.write(b.id, stream("x"), "application/octet-stream");
    expect((await s.read(b.id))?.mimetype).toBe("image/jpeg");
    const c = s.create({ filename: "foto.jpg", mimetype: null });
    await s.write(c.id, stream("x"), "image/png; charset=binary");
    expect((await s.read(c.id))?.mimetype).toBe("image/png");
    const d = s.create({ filename: "foto.jpg", mimetype: "image/webp" });
    await s.write(d.id, stream("x"), "image/png");
    expect((await s.read(d.id))?.mimetype).toBe("image/webp");
  });

  it("survives a restart: a new store sees earlier slots", async () => {
    const { id } = store().create({ filename: "a.txt", mimetype: null });
    expect(await store().write(id, stream("hi"), null)).toBe("ok");
    expect(new TextDecoder().decode((await store().read(id))?.data)).toBe("hi");
  });

  it("returns null for pending slots and removes slots on demand", async () => {
    const s = store();
    const { id } = s.create({ filename: "a.txt", mimetype: null });
    expect(await s.read(id)).toBeNull();
    await s.write(id, stream("hi"), null);
    s.remove(id);
    expect(s.get(id)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("expires slots and sweeps their files", async () => {
    const s = store();
    const { id } = s.create({ filename: "a.txt", mimetype: null });
    await s.write(id, stream("hi"), null);
    const fresh = s.create({ filename: "b.txt", mimetype: null });
    clock = T0 + 900_001;
    expect(s.get(id)).toBeNull();
    expect(await s.read(id)).toBeNull();
    expect(await s.write(id, stream("x"), null)).toBe("not_found");
    expect(s.sweep()).toBe(2);
    expect(existsSync(join(dir, `${id}.bin`))).toBe(false);
    expect(existsSync(join(dir, `${fresh.id}.json`))).toBe(false);
  });
});

describe("mimetypeFromFilename", () => {
  it("maps common extensions and falls back to octet-stream", () => {
    expect(mimetypeFromFilename("a.PDF")).toBe("application/pdf");
    expect(mimetypeFromFilename("nota.opus")).toBe("audio/ogg");
    expect(mimetypeFromFilename("v.mp4")).toBe("video/mp4");
    expect(mimetypeFromFilename("sin-extension")).toBe("application/octet-stream");
  });
});
