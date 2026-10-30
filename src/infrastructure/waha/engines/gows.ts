import type {
  Attachment,
  ChatSummary,
  EngineMapper,
  GroupInfo,
  GroupSummary,
  NormalizedMessage,
  Reaction,
} from "../../../domain/message.js";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^\d+(\.\d+)?$/.test(v)
      ? Number(v)
      : null;

// --- media ids ---------------------------------------------------------------

export function encodeMediaId(chatId: string, messageId: string): string {
  return Buffer.from(JSON.stringify({ c: chatId, m: messageId })).toString("base64url");
}

export function decodeMediaId(id: string): { chatId: string; messageId: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
    const o = obj(parsed);
    return typeof o.c === "string" && typeof o.m === "string"
      ? { chatId: o.c, messageId: o.m }
      : null;
  } catch {
    return null;
  }
}

// --- helpers -----------------------------------------------------------------

/** "123:45@lid" -> "123@lid" (drops the device suffix). */
function stripDevice(jid: string): string {
  return jid.replace(/:\d+@/, "@");
}

/** Digits of a phone-number JID ("51999@s.whatsapp.net" / "@c.us"); null for lid or redacted values. */
function phoneOf(jid: unknown): string | null {
  const s = str(jid);
  if (!s) return null;
  const m = /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/.exec(s);
  return m?.[1] ?? null;
}

function iso(v: unknown): string | null {
  let ms: number | null = null;
  const n = num(v);
  if (n !== null) ms = n > 1e12 ? n : n * 1000;
  else if (typeof v === "string") ms = Date.parse(v);
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const IGNORABLE = new Set([
  "messageContextInfo",
  "senderKeyDistributionMessage",
  "deviceSentMessage",
]);

const MEDIA_KINDS = {
  imageMessage: "image",
  videoMessage: "video",
  stickerMessage: "sticker",
  documentMessage: "document",
  audioMessage: "audio",
} as const;

const CONTAINERS = new Set([
  "ephemeralmessage",
  "viewoncemessage",
  "viewoncemessagev2",
  "viewoncemessagev2extension",
  "documentwithcaptionmessage",
  "editedmessage",
]);
const MAX_UNWRAP_DEPTH = 3;

function ciGet(o: Obj, name: string): unknown {
  const k = Object.keys(o).find((x) => x.toLowerCase() === name);
  return k === undefined ? undefined : o[k];
}

/** Descends through container kinds (ephemeral, view-once, edits) up to a bounded depth. */
function unwrap(message: Obj): Obj {
  let current = message;
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    const key = contentKey(current);
    if (key === null) break;
    const content = obj(current[key]);
    let inner: Obj | null = null;
    if (CONTAINERS.has(key.toLowerCase())) inner = obj(ciGet(content, "message"));
    else if (key === "protocolMessage" && content.editedMessage !== undefined)
      inner = obj(content.editedMessage);
    if (inner === null || Object.keys(inner).length === 0) break;
    current = inner;
  }
  return current;
}

function contentKey(message: Obj): string | null {
  const keys = Object.keys(message);
  if (keys.length === 0) return null;
  return keys.find((k) => !IGNORABLE.has(k)) ?? null;
}

function contextInfoOf(content: Obj): Obj {
  return obj(content.contextInfo);
}

function authorOf(raw: Obj): NormalizedMessage["author"] {
  const info = obj(obj(raw._data).Info);
  const sender = str(info.Sender);
  const participant = str(raw.participant);
  const from = str(raw.from);
  const jid = sender ?? participant ?? (raw.fromMe === true ? null : from);
  const id = jid ? stripDevice(jid) : "";
  const phone = phoneOf(id) ?? phoneOf(info.SenderAlt);
  return { id, phone, name: str(info.PushName) ?? phone };
}

// --- message -----------------------------------------------------------------

function unknownMessage(raw: unknown, rawType?: string): NormalizedMessage {
  const r = obj(raw);
  return {
    id: str(r.id) ?? "",
    timestamp: iso(r.timestamp) ?? new Date(0).toISOString(),
    author: authorOf(r),
    type: "unknown",
    ...(rawType ? { rawType } : {}),
    text: null,
    replyToId: null,
    mentions: [],
    // Deliberately empty: GOWS returns no reaction events on the messages endpoint;
    // reaction() maps them if they ever appear.
    reactions: [],
    attachment: null,
    location: null,
    contact: null,
    poll: null,
  };
}

function vcardPhone(vcard: unknown): string | null {
  const s = str(vcard);
  if (!s) return null;
  const waid = /waid=(\d+)/.exec(s);
  if (waid) return waid[1] ?? null;
  const tel = /^TEL[^:]*:\+?([\d\s-]+)$/m.exec(s);
  const digits = tel?.[1]?.replace(/\D/g, "");
  return digits || null;
}

function mapMessage(rawIn: unknown): NormalizedMessage {
  const raw = obj(rawIn);
  if (typeof obj(raw._data).Message !== "object" || obj(raw._data).Message === null) {
    return unknownMessage(raw, "malformed");
  }
  const message = unwrap(obj(obj(raw._data).Message));
  const key = contentKey(message);
  const base = unknownMessage(raw);
  const out: NormalizedMessage = { ...base };
  const chatId = str(raw.from) ?? str(obj(obj(raw._data).Info).Chat) ?? "";

  if (key === null) {
    out.type = "system";
    return out;
  }
  const content = obj(message[key]);
  const ctx = contextInfoOf(content);
  out.replyToId = str(ctx.stanzaID) ?? str(obj(raw.replyTo).id);
  out.mentions = Array.isArray(ctx.mentionedJID)
    ? ctx.mentionedJID.filter((j): j is string => typeof j === "string")
    : [];

  if (key === "conversation") {
    out.type = "text";
    out.text = str(message.conversation);
    return out;
  }
  if (key === "extendedTextMessage") {
    out.type = "text";
    out.text = str(content.text);
    return out;
  }
  if (Object.hasOwn(MEDIA_KINDS, key)) {
    const baseKind = MEDIA_KINDS[key as keyof typeof MEDIA_KINDS];
    const kind: Attachment["kind"] =
      baseKind === "audio" && (content.PTT === true || content.ptt === true) ? "voice" : baseKind;
    const caption = str(content.caption);
    out.type = kind;
    out.text = caption;
    out.attachment = {
      kind,
      mimetype: str(content.mimetype) ?? str(obj(raw.media).mimetype),
      size: num(content.fileLength),
      filename: str(content.fileName) ?? str(obj(raw.media).filename),
      caption,
      mediaId: str(raw.id) && chatId ? encodeMediaId(chatId, str(raw.id) as string) : null,
      available: true,
    };
    return out;
  }
  if (key === "locationMessage" || key === "liveLocationMessage") {
    const lat = num(content.degreesLatitude);
    const lng = num(content.degreesLongitude);
    if (lat === null || lng === null) return unknownMessage(raw, key);
    out.type = "location";
    out.location = { lat, lng, name: str(content.name) };
    return out;
  }
  if (key === "contactMessage") {
    out.type = "contact";
    out.contact = { name: str(content.displayName), phone: vcardPhone(content.vcard) };
    return out;
  }
  if (key === "contactsArrayMessage") {
    const first = obj(Array.isArray(content.contacts) ? content.contacts[0] : null);
    out.type = "contact";
    out.contact = { name: str(first.displayName), phone: vcardPhone(first.vcard) };
    return out;
  }
  if (/^pollCreationMessage(V\d)?$/.test(key)) {
    const question = str(content.name);
    if (!question) return unknownMessage(raw, key);
    const options = Array.isArray(content.options)
      ? content.options.map((o) => str(obj(o).optionName)).filter((o): o is string => o !== null)
      : [];
    out.type = "poll";
    out.poll = { question, options };
    return out;
  }
  if (key === "protocolMessage") {
    const t = content.type;
    out.type = t === "REVOKE" || t === 0 ? "deleted" : "system";
    return out;
  }
  // Includes reaction events: callers use `reaction()` to tell them apart.
  return unknownMessage(raw, key);
}

function mapReaction(rawIn: unknown): { targetId: string; reaction: Reaction } | null {
  const raw = obj(rawIn);
  const content = obj(obj(obj(raw._data).Message).reactionMessage);
  const targetId = str(obj(content.key).ID) ?? str(obj(content.key).id);
  if (!targetId) return null;
  return { targetId, reaction: { emoji: str(content.text) ?? "", by: authorOf(raw).id } };
}

// --- groups & chats ------------------------------------------------------------

function groupSummary(rawIn: unknown): GroupSummary {
  const raw = obj(rawIn);
  const participants = Array.isArray(raw.Participants) ? raw.Participants : [];
  return {
    id: str(raw.JID) ?? str(raw.id) ?? "",
    name: str(raw.Name) ?? str(raw.subject) ?? "",
    participantCount: num(raw.ParticipantCount) ?? participants.length,
    lastActivity: null,
  };
}

function groupInfo(rawIn: unknown): GroupInfo {
  const raw = obj(rawIn);
  const participants = Array.isArray(raw.Participants) ? raw.Participants : [];
  return {
    ...groupSummary(raw),
    description: str(raw.Topic) ?? str(raw.description),
    createdAt: iso(raw.GroupCreated),
    participants: participants.map((p) => {
      const o = obj(p);
      const id = str(o.JID) ?? str(o.id) ?? "";
      return {
        id,
        phone: phoneOf(o.PhoneNumber) ?? phoneOf(id),
        isAdmin: o.IsAdmin === true || o.IsSuperAdmin === true,
      };
    }),
  };
}

function chatSummary(rawIn: unknown): ChatSummary {
  const raw = obj(rawIn);
  const id = str(raw.id) ?? str(obj(raw.id)._serialized) ?? "";
  return {
    id,
    name: str(raw.name),
    phone: phoneOf(id),
    lastActivity: iso(raw.conversationTimestamp),
  };
}

function safe<T>(fn: (raw: unknown) => T, fallback: (raw: unknown) => T): (raw: unknown) => T {
  return (raw) => {
    try {
      return fn(raw);
    } catch {
      return fallback(raw);
    }
  };
}

export const gowsMapper: EngineMapper = {
  message: safe(mapMessage, (raw) => unknownMessage(raw, "malformed")),
  reaction: safe(mapReaction, () => null),
  groupSummary,
  groupInfo,
  chatSummary,
};
