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

export function wrapDek(kek: Buffer, dek: Buffer, tenantId: string): string {
  return encodeText(sealBytes(kek, dek, `dek:${tenantId}`));
}

export function unwrapDek(kek: Buffer, wrapped: string, tenantId: string): Buffer {
  return openBytes(kek, decodeText(wrapped), `dek:${tenantId}`);
}

export function createTenantCipher(dek: Buffer, tenantId: string): TenantCipher {
  const scope = (aad: string) => `${tenantId}:${aad}`;
  return {
    sealText: (text, aad) => encodeText(sealBytes(dek, Buffer.from(text, "utf8"), scope(aad))),
    openText: (sealed, aad) => openBytes(dek, decodeText(sealed), scope(aad)).toString("utf8"),
    seal: (data, aad) => sealBytes(dek, data, scope(aad)),
    open: (sealed, aad) => openBytes(dek, sealed, scope(aad)),
  };
}

export function isSealedText(value: string): boolean {
  return value.startsWith(TEXT_PREFIX);
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
