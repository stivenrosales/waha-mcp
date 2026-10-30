import type { WahaGateway } from "../../src/domain/ports/WahaGateway.js";

type Raw = Record<string, unknown>;

export interface InMemoryData {
  groups?: unknown[];
  groupDetails?: Record<string, unknown>;
  chats?: unknown[];
  contacts?: unknown[];
  /** Raw messages per chat id, newest first (the order WAHA returns). */
  messages?: Record<string, Raw[]>;
}

export interface Call {
  method: "listChats" | "listContacts" | "getMessages";
  args: unknown[];
}

/** WAHA stand-in: honours offset/limit and the unix-second timestamp filters. */
export class InMemoryWahaGateway implements WahaGateway {
  readonly calls: Call[] = [];
  constructor(private readonly data: InMemoryData = {}) {}

  count(method: Call["method"]): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async getSession() {
    return { engine: "GOWS", status: "WORKING" };
  }

  async listGroups() {
    return this.data.groups ?? [];
  }

  async getGroup(groupId: string) {
    return this.data.groupDetails?.[groupId] ?? {};
  }

  async listChats(q: { limit: number; offset: number }) {
    this.calls.push({ method: "listChats", args: [q] });
    return (this.data.chats ?? []).slice(q.offset, q.offset + q.limit);
  }

  async listContacts(q: { limit: number; offset: number }) {
    this.calls.push({ method: "listContacts", args: [q] });
    return (this.data.contacts ?? []).slice(q.offset, q.offset + q.limit);
  }

  async getMessages(
    chatId: string,
    q: { limit: number; offset: number; from?: number; to?: number },
  ) {
    this.calls.push({ method: "getMessages", args: [chatId, q] });
    const all = (this.data.messages?.[chatId] ?? []).filter((m) => {
      const t = Number(m.timestamp);
      return (q.from === undefined || t >= q.from) && (q.to === undefined || t <= q.to);
    });
    return all.slice(q.offset, q.offset + q.limit);
  }

  async fetchMedia() {
    return null;
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
