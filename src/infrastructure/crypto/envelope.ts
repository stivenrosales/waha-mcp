import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const TEXT_PREFIX = "v1.";

export class DecryptionError extends Error {
  constructor(message = "Decryption failed.") {
    super(message);
    this.name = "DecryptionError";
  }
}

export interface TenantCipher {
  /** `v1.<base64url(nonce|ciphertext|tag)>`. */
  sealText(text: string, aad: string): string;
  openText(sealed: string, aad: string): string;
  /** Binary `nonce(12) | ciphertext | tag(16)`. */
  seal(data: Uint8Array, aad: string): Buffer;
  open(sealed: Uint8Array, aad: string): Buffer;
}

/** Decodes the base64 `MASTER_KEY`; it must be exactly 32 bytes. */
export function parseMasterKey(base64: string): Buffer {
  const fail = () => new Error("MASTER_KEY must be 32 bytes encoded in base64.");
  const trimmed = base64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw fail();
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) throw fail();
  return key;
}

export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

// AADs are length-prefixed (tenant id length) so no tenant id can be confused with
// part of the caller's aad, and domain-separated ("dek" vs "val") so a wrapped DEK
// can never be opened as a value or the other way around.
const dekAad = (tenantId: string) => `dek:${tenantId.length}:${tenantId}`;

function assertKey(key: Buffer, name: string): void {
  if (key.length !== KEY_BYTES) throw new Error(`${name} must be ${KEY_BYTES} bytes.`);
}

export function wrapDek(kek: Buffer, dek: Buffer, tenantId: string): string {
  assertKey(kek, "KEK");
  assertKey(dek, "DEK");
  return encodeText(sealBytes(kek, dek, dekAad(tenantId)));
}

export function unwrapDek(kek: Buffer, wrapped: string, tenantId: string): Buffer {
  assertKey(kek, "KEK");
  const dek = openBytes(kek, decodeText(wrapped), dekAad(tenantId));
  if (dek.length !== KEY_BYTES) throw new DecryptionError();
  return dek;
}

export function createTenantCipher(dek: Buffer, tenantId: string): TenantCipher {
  assertKey(dek, "DEK");
  const scope = (aad: string) => `val:${tenantId.length}:${tenantId}:${aad}`;
  return {
    sealText: (text, aad) => encodeText(sealBytes(dek, Buffer.from(text, "utf8"), scope(aad))),
    openText: (sealed, aad) => openBytes(dek, decodeText(sealed), scope(aad)).toString("utf8"),
    seal: (data, aad) => sealBytes(dek, data, scope(aad)),
    open: (sealed, aad) => openBytes(dek, sealed, scope(aad)),
  };
}

/** True only for `v1.` + base64url long enough to hold a nonce and a tag. */
export function isSealedText(value: string): boolean {
  if (!value.startsWith(TEXT_PREFIX)) return false;
  const body = value.slice(TEXT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || body.length % 4 === 1) return false;
  return Math.floor((body.length * 3) / 4) >= NONCE_BYTES + TAG_BYTES;
}

function sealBytes(key: Buffer, data: Uint8Array, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function openBytes(key: Buffer, sealed: Uint8Array, aad: string): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new DecryptionError();
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const body = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

function encodeText(sealed: Buffer): string {
  return TEXT_PREFIX + sealed.toString("base64url");
}

function decodeText(text: string): Buffer {
  if (!isSealedText(text)) throw new DecryptionError();
  return Buffer.from(text.slice(TEXT_PREFIX.length), "base64url");
}
