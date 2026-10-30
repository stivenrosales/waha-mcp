import { parseArgs } from "node:util";

/** Pure helpers of the capture script (argument parsing, naming, sampling). */

export const DEFAULT_OUT_DIR = "test/fixtures/gows";

export const MESSAGE_KINDS = [
  "text",
  "reply",
  "mention",
  "image",
  "sticker",
  "audio",
  "voice",
  "video",
  "document",
  "location",
  "contact",
  "poll",
  "reaction",
  "system",
  "deleted",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export type MessageBucket = "messages-text" | "messages-media" | "messages-misc";

export interface CaptureArgs {
  groups: string[];
  out: string;
}

export function parseCaptureArgs(argv: string[]): CaptureArgs {
  // pnpm forwards the `--` separator to the script.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args,
    options: {
      group: { type: "string", multiple: true },
      out: { type: "string" },
    },
    strict: true,
  });
  const groups = values.group ?? [];
  if (groups.length === 0) throw new Error("Pass at least one --group <id>.");
  if (groups.length > 2) throw new Error("Pass at most 2 --group values.");
  return { groups, out: values.out ?? DEFAULT_OUT_DIR };
}

export function fixtureFileName(name: string, download = false): string {
  return `${name}${download ? "-download" : ""}.json`;
}

const MEDIA_KINDS: ReadonlySet<MessageKind> = new Set([
  "image",
  "sticker",
  "audio",
  "voice",
  "video",
  "document",
]);
const TEXT_KINDS: ReadonlySet<MessageKind> = new Set(["text", "reply", "mention"]);

export function bucketOf(kind: MessageKind): MessageBucket {
  if (TEXT_KINDS.has(kind)) return "messages-text";
  if (MEDIA_KINDS.has(kind)) return "messages-media";
  return "messages-misc";
}

const WAHA_TYPE_TO_KIND: Record<string, MessageKind> = {
  chat: "text",
  image: "image",
  video: "video",
  audio: "audio",
  ptt: "voice",
  sticker: "sticker",
  document: "document",
  location: "location",
  vcard: "contact",
  multi_vcard: "contact",
  poll_creation: "poll",
  reaction: "reaction",
  revoked: "deleted",
};

const KEY_TO_KIND: Record<string, MessageKind> = {
  imagemessage: "image",
  stickermessage: "sticker",
  videomessage: "video",
  ptvmessage: "video",
  documentmessage: "document",
  documentwithcaptionmessage: "document",
  locationmessage: "location",
  livelocationmessage: "location",
  contactmessage: "contact",
  contactsarraymessage: "contact",
  reactionmessage: "reaction",
  extendedtextmessage: "text",
  conversation: "text",
  stubtype: "system",
  messagestubtype: "system",
};

const MAX_DEPTH = 8;

/**
 * Best-effort classification of a raw GOWS message by the protobuf-style keys
 * under `_data.Message` (falling back to WAHA's own `type`/`body`/`replyTo`).
 * Quoted messages are not walked, so a reply to an image is not an image.
 */
export function classifyMessage(message: unknown): MessageKind[] {
  const kinds = new Set<MessageKind>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || node === null || typeof node !== "object" || Array.isArray(node))
      return;
    for (const [rawKey, value] of Object.entries(node)) {
      const key = rawKey.toLowerCase();
      if (key === "quotedmessage") {
        kinds.add("reply");
        continue;
      }
      if (key === "mentionedjid" && Array.isArray(value) && value.length > 0) kinds.add("mention");
      if (key === "audiomessage") {
        const ptt =
          (value as Record<string, unknown> | null)?.PTT ??
          (value as Record<string, unknown> | null)?.ptt;
        kinds.add(ptt === true ? "voice" : "audio");
      } else if (key.startsWith("pollcreationmessage")) {
        kinds.add("poll");
      } else if (key === "protocolmessage") {
        const type = (value as Record<string, unknown> | null)?.type;
        kinds.add(type === "REVOKE" || type === 0 ? "deleted" : "system");
      } else if (key === "conversation" && typeof value !== "string") {
        // not a text payload
      } else if (key in KEY_TO_KIND) {
        const kind = KEY_TO_KIND[key];
        if (kind !== undefined && (kind !== "system" || value)) kinds.add(kind);
      }
      walk(value, depth + 1);
    }
  };

  walk((message as { _data?: unknown } | null)?._data, 0);

  const top = message as { type?: unknown; body?: unknown; replyTo?: unknown } | null;
  if (kinds.size === 0 && typeof top?.type === "string") {
    const fallback = WAHA_TYPE_TO_KIND[top.type];
    if (fallback !== undefined) kinds.add(fallback);
  }
  if (top?.replyTo) kinds.add("reply");
  if (kinds.size === 0 && typeof top?.body === "string" && top.body !== "") kinds.add("text");
  return [...kinds];
}

export interface Selection {
  selected: unknown[];
  byBucket: Record<MessageBucket, unknown[]>;
  found: MessageKind[];
  missing: MessageKind[];
}

/**
 * Keeps a message when it is among the first `perKind` samples of any of its
 * kinds, so every kind present in the pages is covered with few messages.
 */
export function selectMessages(messages: unknown[], perKind: number): Selection {
  const counts = new Map<MessageKind, number>();
  const selected: unknown[] = [];
  const byBucket: Record<MessageBucket, unknown[]> = {
    "messages-text": [],
    "messages-media": [],
    "messages-misc": [],
  };
  for (const message of messages) {
    const kinds = classifyMessage(message);
    if (!kinds.some((k) => (counts.get(k) ?? 0) < perKind)) continue;
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    selected.push(message);
    const primary = MESSAGE_KINDS.find((k) => kinds.includes(k));
    if (primary !== undefined) byBucket[bucketOf(primary)].push(message);
  }
  const found = MESSAGE_KINDS.filter((k) => counts.has(k));
  return { selected, byBucket, found, missing: MESSAGE_KINDS.filter((k) => !counts.has(k)) };
}

/** Keeps only structural session fields; `config` (webhooks, HMAC keys, headers) and `me` are dropped. */
export function sessionFixture(raw: unknown): unknown {
  const r = (raw ?? {}) as {
    name?: unknown;
    status?: unknown;
    engine?: { engine?: unknown } | null;
  };
  return {
    name: r.name,
    status: r.status,
    engine: { engine: r.engine?.engine },
  };
}

export interface PageRef {
  chatId: string;
  offset: number;
}

/** Each fetched page's own (chat, offset), once. */
export function planDownloadPages(pages: PageRef[]): PageRef[] {
  const seen = new Set<string>();
  const out: PageRef[] = [];
  for (const { chatId, offset } of pages) {
    const key = `${chatId}\u0000${offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chatId, offset });
  }
  return out;
}

export function dedupeById(messages: unknown[]): unknown[] {
  const seen = new Set<string>();
  return messages.filter((m) => {
    const id = (m as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
