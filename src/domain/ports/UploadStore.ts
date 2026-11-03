import type { OutgoingFile } from "./WhatsAppSender.js";

export interface UploadSlot {
  id: string;
  filename: string;
  /** Mimetype given by the tool caller; null to resolve it from the upload. */
  mimetype: string | null;
  /** Bytes stored; null until uploaded. */
  size: number | null;
  /** Unix milliseconds. */
  expiresAt: number;
  uploaded: boolean;
}

export type WriteResult = "ok" | "too_large" | "already_uploaded" | "not_found";

/** Short-lived, single-use slots for files the owner hands to the server before sending them. */
export interface UploadStore {
  create(q: { filename: string; mimetype: string | null }): UploadSlot;
  /** `null` when the id is unknown, malformed or expired. */
  get(id: string): UploadSlot | null;
  write(
    id: string,
    body: ReadableStream<Uint8Array>,
    contentType: string | null,
  ): Promise<WriteResult>;
  /** `null` unless the slot exists, is uploaded and has not expired. */
  read(id: string): Promise<OutgoingFile | null>;
  remove(id: string): void;
  /** Deletes expired slots and their files; returns how many slots were removed. */
  sweep(): number;
}
