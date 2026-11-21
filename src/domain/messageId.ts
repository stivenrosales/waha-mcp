import { InvalidInputError } from "./errors.js";

export interface ParsedMessageId {
  id: string;
  fromMe: boolean;
  chatId: string;
  shortId: string;
  participant: string | null;
}

const INVALID =
  '"message_id" must be a full message id from get_messages, search_messages or get_thread (e.g. true_51999888777@c.us_3EB0…).';

/** `true|false_<chat>_<ID>[_<participant>]`, as WAHA serializes it. */
export function parseMessageId(id: string): ParsedMessageId {
  const parts = id.split("_");
  const [flag, chatId, shortId, participant] = parts;
  if (
    (flag !== "true" && flag !== "false") ||
    !chatId?.includes("@") ||
    !shortId ||
    shortId.includes("@") ||
    parts.length > 4 ||
    (participant !== undefined && !participant.includes("@"))
  )
    throw new InvalidInputError(INVALID);
  return { id, fromMe: flag === "true", chatId, shortId, participant: participant ?? null };
}

/** Edits and deletes only apply to the owner's own messages (ids that start with `true_`). */
export function assertOwnMessage(parsed: ParsedMessageId, verb: "edit" | "delete"): void {
  if (!parsed.fromMe)
    throw new InvalidInputError(
      `You can only ${verb} your own messages (ids that start with true_).`,
    );
}

/**
 * The stable part of a WhatsApp message id: `true_<chat>_<ID>[_<participant>]` → `<ID>`. Our
 * sends and their echoes may name the chat differently (`@c.us` vs `@lid`).
 */
export function shortMessageId(id: string): string {
  const parts = id.split("_");
  return (parts[0] === "true" || parts[0] === "false") && parts.length >= 3
    ? (parts[2] as string)
    : id;
}
