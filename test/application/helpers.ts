import { type InMemoryData, InMemoryWahaGateway, rawText } from "../fakes/InMemoryWahaGateway.js";

export const ME_LID = "100000000000002@lid";
export const ME_PHONE = "51000000002@c.us";
export const ANA = "51999000111@c.us";
export const BOB = "51999000222@c.us";
export const GROUP_A = "100000000000001@g.us";
export const GROUP_B = "100000000000002@g.us";

export type Raw = Record<string, unknown>;

interface Opts {
  chat: string;
  from?: string;
  mine?: boolean;
  mention?: string[];
  replyTo?: string;
  name?: string;
}

/** Raw GOWS text message; `mine` makes it an owner message (sender = the owner's lid). */
export function msg(id: string, ts: number, text: string, o: Opts): Raw {
  const sender = o.mine ? ME_LID : (o.from ?? o.chat);
  const raw = rawText(id, ts, text, {
    chat: o.chat,
    sender,
    name: o.name,
    replyTo: o.replyTo,
  });
  const out: Raw = { ...raw, fromMe: o.mine === true };
  if (o.mention) {
    out._data = {
      ...(raw._data as Raw),
      Message: {
        extendedTextMessage: {
          text,
          contextInfo: {
            ...(o.replyTo ? { stanzaID: o.replyTo } : {}),
            mentionedJID: o.mention,
          },
        },
      },
    };
  }
  return out;
}

/** A message with no content: the mapper reports it as `system`. */
export function systemMsg(id: string, ts: number, chat: string): Raw {
  const raw = rawText(id, ts, "", { chat, sender: chat });
  return { ...raw, body: null, _data: { ...(raw._data as Raw), Message: {} } };
}

/** Messages must be given newest first, as WAHA returns them. */
export function gateway(data: InMemoryData): InMemoryWahaGateway {
  return new InMemoryWahaGateway({
    me: { id: ME_PHONE, lid: ME_LID },
    ...data,
  });
}

export const chat = (id: string, ts: number, name: string | null = null) => ({
  id,
  name,
  conversationTimestamp: ts,
});
