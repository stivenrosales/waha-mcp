export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "voice"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "poll"
  | "system"
  | "deleted"
  | "unknown";

export interface Author {
  id: string;
  phone: string | null;
  name: string | null;
}

export interface Attachment {
  kind: "image" | "video" | "audio" | "voice" | "document" | "sticker";
  mimetype: string | null;
  size: number | null;
  filename: string | null;
  caption: string | null;
  /** Opaque; the gateway layer turns it back into a WAHA media request. */
  mediaId: string | null;
  /** True when the message carries a media payload (actual availability is checked on download). */
  available: boolean;
}

export interface Reaction {
  emoji: string;
  by: string;
}

export interface NormalizedMessage {
  id: string;
  /** ISO 8601, UTC. */
  timestamp: string;
  author: Author;
  /** True when the account owner sent it (from any device). */
  fromMe: boolean;
  type: MessageType;
  rawType?: string;
  text: string | null;
  replyToId: string | null;
  mentions: string[];
  reactions: Reaction[];
  attachment: Attachment | null;
  location: { lat: number; lng: number; name: string | null } | null;
  contact: { name: string | null; phone: string | null } | null;
  poll: { question: string; options: string[] } | null;
}

export interface GroupSummary {
  id: string;
  name: string;
  participantCount: number;
  lastActivity: string | null;
}

export interface GroupInfo extends GroupSummary {
  description: string | null;
  createdAt: string | null;
  participants: { id: string; phone: string | null; isAdmin: boolean }[];
}

/** A chat from the chats list. `name` is often null for direct chats (names live in contacts). */
export interface ChatSummary {
  id: string;
  name: string | null;
  phone: string | null;
  lastActivity: string | null;
}

export interface EngineMapper {
  /** Never throws: unexpected payloads map to `type: "unknown"`. */
  message(raw: unknown): NormalizedMessage;
  /** Non-null when the raw message is a reaction event (not a message). */
  reaction(raw: unknown): { targetId: string; reaction: Reaction } | null;
  groupSummary(raw: unknown): GroupSummary;
  groupInfo(raw: unknown): GroupInfo;
  chatSummary(raw: unknown): ChatSummary;
}
