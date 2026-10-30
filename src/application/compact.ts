import type { NormalizedMessage } from "../domain/message.js";
import { messageKeys } from "./messages.js";

/** Message shape for multi-chat results: small enough to carry many chats in one answer. */
export interface CompactMessage {
  id: string;
  at: string;
  from: string;
  type: NormalizedMessage["type"];
  text: string | null;
  hasAttachment: boolean;
  /** Voice-note transcript, cut like `text`; null when there is none. */
  transcript: string | null;
}

const MAX_TEXT = 280;

function cut(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MAX_TEXT ? text : `${chars.slice(0, MAX_TEXT - 1).join("")}…`;
}

export function toCompact(
  msg: NormalizedMessage,
  isMine: (m: NormalizedMessage) => boolean,
): CompactMessage {
  return {
    id: msg.id,
    at: msg.timestamp,
    from: isMine(msg) ? "me" : msg.author.name || msg.author.phone || msg.author.id || "unknown",
    type: msg.type,
    text: msg.text === null ? null : cut(msg.text),
    hasAttachment: msg.attachment !== null,
    transcript: msg.transcript === null ? null : cut(msg.transcript),
  };
}

/** `…@s.whatsapp.net` and `…@c.us` are the same account; device suffixes are dropped. */
const normalizeJid = (jid: string) =>
  jid.replace(/:\d+@/, "@").replace(/@s\.whatsapp\.net$/, "@c.us");

export interface Identity {
  isMine(m: NormalizedMessage): boolean;
  mentionsMe(m: NormalizedMessage): boolean;
}

/** The owner may appear under the phone id or the lid, both as sender and in mentions. */
export function identityOf(me: { id: string; lid: string | null }): Identity {
  const ids = new Set([normalizeJid(me.id), ...(me.lid ? [normalizeJid(me.lid)] : [])]);
  return {
    isMine: (m) => m.fromMe || ids.has(normalizeJid(m.author.id)),
    mentionsMe: (m) => m.mentions.some((j) => ids.has(normalizeJid(j))),
  };
}

/** Messages that can wait for an answer: system events and deleted messages cannot. */
export const isConversational = (m: NormalizedMessage) =>
  m.type !== "system" && m.type !== "deleted";

export type WaitReason = "last-message-from-them" | "mentioned" | "replied-to-you";

export interface Waiting {
  reason: WaitReason;
  waitingSince: string;
  unansweredCount: number;
}

/**
 * Does this chat wait for the owner? `messages` are conversational, NEWEST FIRST.
 * Direct: pending iff the newest message is not the owner's. Group: pending only when
 * a message after the owner's last one mentions the owner or replies to an owner message.
 */
export function assessWaiting(
  messages: NormalizedMessage[],
  isGroup: boolean,
  who: Identity,
): Waiting | null {
  if (isGroup) {
    const mine = new Set<string>();
    for (const m of messages) if (who.isMine(m)) for (const k of messageKeys(m.id)) mine.add(k);
    const triggers: { at: string; reason: WaitReason }[] = [];
    for (const m of messages) {
      if (who.isMine(m)) break;
      if (who.mentionsMe(m)) triggers.push({ at: m.timestamp, reason: "mentioned" });
      else if (m.replyToId !== null && mine.has(m.replyToId))
        triggers.push({ at: m.timestamp, reason: "replied-to-you" });
    }
    const earliest = triggers.at(-1);
    return earliest
      ? { reason: earliest.reason, waitingSince: earliest.at, unansweredCount: triggers.length }
      : null;
  }
  const run = messages.findIndex((m) => who.isMine(m));
  const unanswered = run === -1 ? messages.length : run;
  const oldest = messages[unanswered - 1];
  return oldest
    ? {
        reason: "last-message-from-them",
        waitingSince: oldest.timestamp,
        unansweredCount: unanswered,
      }
    : null;
}
