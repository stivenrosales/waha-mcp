import { InvalidInputError } from "../domain/errors.js";

/** Opaque pagination state: the raw WAHA offset plus the range it belongs to. */
export interface Cursor {
  chatId: string;
  offset: number;
  from: string | null;
  to: string | null;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(
    JSON.stringify({ chatId: c.chatId, offset: c.offset, from: c.from, to: c.to }),
  ).toString("base64url");
}

export function decodeCursor(value: string): Cursor {
  const invalid = () =>
    new InvalidInputError("Invalid cursor. Use the nextCursor from a previous call.");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const bound = (v: unknown) => v === null || typeof v === "string";
  if (
    typeof o.chatId !== "string" ||
    typeof o.offset !== "number" ||
    !Number.isSafeInteger(o.offset) ||
    o.offset < 0 ||
    !bound(o.from) ||
    !bound(o.to)
  )
    throw invalid();
  return {
    chatId: o.chatId,
    offset: o.offset,
    from: o.from as string | null,
    to: o.to as string | null,
  };
}
