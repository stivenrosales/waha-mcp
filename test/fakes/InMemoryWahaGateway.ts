import { WahaNotFoundError } from "../../src/domain/errors.js";
import type { WahaGateway } from "../../src/domain/ports/WahaGateway.js";

type Raw = Record<string, unknown>;

export interface InMemoryData {
  groups?: unknown[];
  groupDetails?: Record<string, unknown>;
  chats?: unknown[];
  contacts?: unknown[];
  /** Raw messages per chat id, newest first (the order WAHA returns). */
  messages?: Record<string, Raw[]>;
  /**
   * Files served by `openMedia`, keyed by the exact media URL. `length` is the
   * declared Content-Length (default: the real size; `null` = not declared), so a
   * test can make WAHA lie about it.
   */
  media?: Record<string, { bytes: Uint8Array; mimetype: string; length?: number | null }>;
  /** Engine reported by `getSession` (default "GOWS"). */
  engine?: string;
  /** When set, every method rejects with this error (simulates WAHA failures). */
  failWith?: Error;
}

export interface Call {
  method: "getSession" | "listChats" | "listContacts" | "getMessages" | "getMessage" | "openMedia";
  args: unknown[];
}

/** WAHA stand-in: honours offset/limit and the unix-second timestamp filters. */
export class InMemoryWahaGateway implements WahaGateway {
  readonly calls: Call[] = [];
  /** How many times each media URL's body was pulled (0 = never read). */
  readonly bodyReads = new Map<string, number>();
  constructor(private readonly data: InMemoryData = {}) {}

  count(method: Call["method"]): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  private guard(): void {
    if (this.data.failWith) throw this.data.failWith;
  }

  async getSession() {
    this.calls.push({ method: "getSession", args: [] });
    this.guard();
    return { engine: this.data.engine ?? "GOWS", status: "WORKING" };
  }

  async listGroups() {
    this.guard();
    return this.data.groups ?? [];
  }

  async getGroup(groupId: string) {
    this.guard();
    return this.data.groupDetails?.[groupId] ?? {};
  }

  async listChats(q: { limit: number; offset: number }) {
    this.calls.push({ method: "listChats", args: [q] });
    this.guard();
    return (this.data.chats ?? []).slice(q.offset, q.offset + q.limit);
  }

  async listContacts(q: { limit: number; offset: number }) {
    this.calls.push({ method: "listContacts", args: [q] });
    this.guard();
    return (this.data.contacts ?? []).slice(q.offset, q.offset + q.limit);
  }

  async getMessages(
    chatId: string,
    q: { limit: number; offset: number; from?: number; to?: number },
  ) {
    this.calls.push({ method: "getMessages", args: [chatId, q] });
    this.guard();
    const all = (this.data.messages?.[chatId] ?? []).filter((m) => {
      const t = Number(m.timestamp);
      return (q.from === undefined || t >= q.from) && (q.to === undefined || t <= q.to);
    });
    return all.slice(q.offset, q.offset + q.limit);
  }

  async getMessage(chatId: string, messageId: string) {
    this.calls.push({ method: "getMessage", args: [chatId, messageId] });
    this.guard();
    const found = (this.data.messages?.[chatId] ?? []).find((m) => m.id === messageId);
    if (!found) throw new WahaNotFoundError("message");
    return found;
  }

  async openMedia(url: string) {
    this.calls.push({ method: "openMedia", args: [url] });
    this.guard();
    const file = this.data.media?.[url];
    if (!file) return null;
    const CHUNK = 1024;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          this.bodyReads.set(url, (this.bodyReads.get(url) ?? 0) + 1);
          if (offset >= file.bytes.length) return controller.close();
          controller.enqueue(file.bytes.slice(offset, offset + CHUNK));
          offset += CHUNK;
        },
      },
      // No eager pull: the body is only read when someone consumes it.
      { highWaterMark: 0 },
    );
    const length = file.length === undefined ? file.bytes.length : file.length;
    return { body, mimetype: file.mimetype, length };
  }
}

/** Raw GOWS-shaped group text message. */
export function rawText(
  id: string,
  timestamp: number,
  text: string,
  o: { sender?: string; name?: string; chat?: string; replyTo?: string } = {},
): Raw {
  const chat = o.chat ?? "100000000000009@g.us";
  const sender = o.sender ?? "100000000000042@lid";
  return {
    id: `false_${chat}_${id}_${sender}`,
    timestamp,
    from: chat,
    fromMe: false,
    participant: sender,
    hasMedia: false,
    media: null,
    replyTo: null,
    body: text,
    _data: {
      Info: {
        Sender: `${sender.split("@")[0]}:5@${sender.split("@")[1]}`,
        PushName: o.name ?? null,
      },
      Message: o.replyTo
        ? { extendedTextMessage: { text, contextInfo: { stanzaID: o.replyTo } } }
        : { conversation: text },
    },
  };
}

export function rawReaction(
  id: string,
  timestamp: number,
  targetId: string,
  emoji: string,
  o: { sender?: string; chat?: string } = {},
): Raw {
  const base = rawText(id, timestamp, "", o);
  return {
    ...base,
    body: null,
    _data: {
      ...(base._data as Raw),
      Message: { reactionMessage: { key: { ID: targetId }, text: emoji } },
    },
  };
}
