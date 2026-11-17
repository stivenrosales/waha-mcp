import type Anthropic from "@anthropic-ai/sdk";
import type { NormalizedMessage } from "../../domain/message.js";
import { isDirectChatId } from "../groups.js";

/** Largest file attached to the agent as a content block (the provider's image limit is 5 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The `payload` of a stored webhook envelope, or null when it is not an object. */
export function envelopePayload(json: string): Record<string, unknown> | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(json);
  } catch {
    return null;
  }
  return isRecord(envelope) && isRecord(envelope.payload) ? envelope.payload : null;
}

/** `51911…:12@s.whatsapp.net` → `51911…@c.us`; other JIDs lose only the device suffix. */
function normalizeJid(jid: string): string {
  const [user = "", server = ""] = jid.split("@");
  const bare = user.split(":")[0] ?? user;
  return server === "s.whatsapp.net" ? `${bare}@c.us` : `${bare}@${server}`;
}

/**
 * Every id this message's chat may go by (spike §3.13): `from` / `Info.Chat`, plus, for a direct
 * chat only, the phone JID behind a `@lid` (`SenderAlt` for the contact, `RecipientAlt` for our
 * own sends, else WAHA's lid lookup). A group, Status or channel message keeps only its chat id:
 * its sender's alternate ids name the sender, not the chat.
 */
export async function chatIdsOf(
  payload: Record<string, unknown>,
  lookupLid: (lid: string) => Promise<string | null>,
): Promise<Set<string>> {
  const info = isRecord(payload._data) && isRecord(payload._data.Info) ? payload._data.Info : {};
  const fromMe = payload.fromMe === true || info.IsFromMe === true;
  const ids = new Set<string>();
  const add = (v: unknown): void => {
    const id = str(v);
    if (id?.includes("@")) ids.add(normalizeJid(id));
  };
  add(payload.from);
  add(info.Chat);
  if (ids.size === 0 || [...ids].some((id) => !isDirectChatId(id))) return ids;
  add(fromMe ? info.RecipientAlt : info.SenderAlt);
  for (const id of [...ids]) {
    if (!id.endsWith("@lid")) continue;
    try {
      const phone = await lookupLid(id);
      if (phone) ids.add(normalizeJid(phone));
    } catch {
      // No mapping today: the other forms may still match.
    }
  }
  return ids;
}

/**
 * Every id one chat id may go by, normalized, the given form first: the same resolution as
 * `chatIdsOf` (a `@lid` adds the phone JID behind it). Two ids name the same chat when their
 * forms intersect.
 */
export async function chatIdForms(
  chatId: string,
  lookupLid: (lid: string) => Promise<string | null>,
): Promise<string[]> {
  return [...(await chatIdsOf({ from: chatId }, lookupLid))];
}

/** `Info.ID` of a message payload (the stable part of its id), or null. */
export function payloadShortId(payload: Record<string, unknown>): string | null {
  const info = isRecord(payload._data) && isRecord(payload._data.Info) ? payload._data.Info : {};
  return str(info.ID);
}

export interface Timelock {
  active: boolean;
  /** When WhatsApp lifts the lock, if the status says so. */
  endsAt: Date | null;
}

/** An end-time field of a lock: an ISO string or epoch seconds/milliseconds. */
function lockEnd(lock: Record<string, unknown>): Date | null {
  for (const [key, v] of Object.entries(lock)) {
    if (!/end|expir|until/i.test(key)) continue;
    const ms =
      typeof v === "number"
        ? v < 1e12
          ? v * 1000
          : v
        : typeof v === "string"
          ? Date.parse(v)
          : NaN;
    if (Number.isFinite(ms) && ms > 0) return new Date(ms);
  }
  return null;
}

/** `reachoutTimelock` anywhere in a `session.status` payload; null when absent. */
export function timelockOf(payload: unknown, depth = 0): Timelock | null {
  if (!isRecord(payload) || depth > 4) return null;
  const lock = payload.reachoutTimelock;
  if (isRecord(lock)) {
    const active = typeof lock.isActive === "boolean" ? lock.isActive : lock.IsActive;
    if (typeof active === "boolean") return { active, endsAt: active ? lockEnd(lock) : null };
  }
  for (const v of Object.values(payload)) {
    const found = timelockOf(v, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export interface MediaReader {
  /** Transcript of a voice note or audio; null when it cannot be transcribed. */
  transcribe(mediaId: string): Promise<string | null>;
  /** File bytes, or null when gone or larger than `maxBytes`. */
  fetchMedia(
    mediaId: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; mimetype: string } | null>;
}

const baseMime = (m: string | null | undefined): string =>
  (m ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const b64 = (data: Uint8Array): string => Buffer.from(data).toString("base64");

/**
 * What the agent sees of one contact message: text as is, voice notes transcribed, images and
 * PDFs as base64 blocks, anything else described. Null for messages with nothing to say
 * (system, deleted, reactions).
 */
export async function contactContent(
  msg: NormalizedMessage,
  media: MediaReader,
): Promise<Anthropic.ContentBlockParam[] | null> {
  const text = (t: string): Anthropic.TextBlockParam => ({ type: "text", text: t });
  const a = msg.attachment;
  const caption = msg.text ? ` ${msg.text}` : "";
  const ref = a?.mediaId ? `, media_id: ${a.mediaId}` : "";
  switch (msg.type) {
    case "text":
      return msg.text ? [text(msg.text)] : null;
    case "voice":
    case "audio": {
      const label = msg.type === "voice" ? "Voice note" : "Audio";
      const transcript = a?.mediaId ? await media.transcribe(a.mediaId).catch(() => null) : null;
      return [
        text(
          transcript
            ? `[${label}${ref}] ${transcript}`
            : `[${label}${ref}: could not be transcribed]`,
        ),
      ];
    }
    case "image": {
      const file = a?.mediaId
        ? await media.fetchMedia(a.mediaId, MAX_IMAGE_BYTES).catch(() => null)
        : null;
      const mime = baseMime(file?.mimetype ?? a?.mimetype);
      if (!file || !IMAGE_TYPES.has(mime)) return [text(`[Image${ref}: not available]${caption}`)];
      return [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mime as Anthropic.Base64ImageSource["media_type"],
            data: b64(file.data),
          },
        },
        text(`[Image${ref}]${caption}`),
      ];
    }
    case "document": {
      const name = a?.filename ? ` ${a.filename}` : "";
      if (baseMime(a?.mimetype) === "application/pdf" && a?.mediaId) {
        const file = await media.fetchMedia(a.mediaId, MAX_PDF_BYTES).catch(() => null);
        if (file)
          return [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: b64(file.data) },
            },
            text(`[PDF${name}${ref}]${caption}`),
          ];
      }
      return [text(`[File${name} (${a?.mimetype ?? "unknown type"})${ref}]${caption}`)];
    }
    case "video":
      return [text(`[Video${ref}]${caption}`)];
    case "sticker":
      return [text("[Sticker]")];
    case "location":
      return msg.location
        ? [
            text(
              `[Location: ${msg.location.lat}, ${msg.location.lng}${msg.location.name ? ` (${msg.location.name})` : ""}]`,
            ),
          ]
        : null;
    case "contact":
      return [text(`[Contact card: ${msg.contact?.name ?? "?"}, ${msg.contact?.phone ?? "?"}]`)];
    case "poll":
      return msg.poll ? [text(`[Poll: ${msg.poll.question}]`)] : null;
    default:
      return null;
  }
}
