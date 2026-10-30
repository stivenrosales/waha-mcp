import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UnsupportedEngineError } from "../../../../src/domain/errors.js";
import { decodeMediaId, encodeMediaId } from "../../../../src/infrastructure/waha/engines/gows.js";
import { getEngineMapper } from "../../../../src/infrastructure/waha/engines/index.js";

// biome-ignore lint/suspicious/noExplicitAny: fixtures are untyped raw JSON
type Raw = Record<string, any>;

function load(dir: string, file: string): Raw[] {
  return JSON.parse(readFileSync(`test/fixtures/${dir}/${file}`, "utf8"));
}
function pick(list: Raw[], key: string, extra?: (m: Raw) => boolean): Raw {
  const found = list.find((m) => key in m._data.Message && (extra?.(m) ?? true));
  if (!found) throw new Error(`fixture has no ${key}`);
  return found;
}

const mapper = getEngineMapper("GOWS");
const groupText = load("gows", "messages-text.json");
const groupMedia = load("gows", "messages-media.json");
const directText = load("gows-direct", "messages-text.json");
const directMedia = load("gows-direct", "messages-media.json");

/** Minimal synthetic message following the observed GOWS shape. */
function synth(message: Raw, over: Raw = {}, info: Raw = {}): Raw {
  return {
    id: "false_100000000000009@g.us_SYN1_100000000000042@lid",
    timestamp: 1793376315,
    from: "100000000000009@g.us",
    fromMe: false,
    participant: "100000000000042@lid",
    hasMedia: false,
    media: null,
    replyTo: null,
    body: null,
    _data: {
      Info: { Sender: "100000000000042:5@lid", PushName: "Ana", IsFromMe: false, ...info },
      Message: message,
    },
    ...over,
  };
}

describe("GOWS message mapper - real fixtures", () => {
  it("maps a plain group text message completely", () => {
    const raw = pick(groupText, "conversation");
    expect(mapper.message(raw)).toEqual({
      id: raw.id,
      timestamp: new Date(raw.timestamp * 1000).toISOString(),
      author: {
        id: raw.participant,
        phone: raw._data.Info.SenderAlt.replace(/:\d+@.*/, ""),
        name: raw._data.Info.PushName,
      },
      fromMe: false,
      type: "text",
      text: raw._data.Message.conversation,
      replyToId: null,
      mentions: [],
      reactions: [],
      attachment: null,
      location: null,
      contact: null,
      poll: null,
    });
  });

  it("maps extendedTextMessage text and replyToId from the quoted stanza", () => {
    const raw = pick(groupText, "extendedTextMessage", (m) => !!m.replyTo);
    const out = mapper.message(raw);
    expect(out.type).toBe("text");
    expect(out.text).toBe(raw._data.Message.extendedTextMessage.text);
    expect(out.replyToId).toBe(raw._data.Message.extendedTextMessage.contextInfo.stanzaID);
  });

  it("maps an image with caption", () => {
    const raw = pick(groupMedia, "imageMessage");
    const out = mapper.message(raw);
    expect(out.type).toBe("image");
    expect(out.text).toBe(raw._data.Message.imageMessage.caption);
    expect(out.attachment).toEqual({
      kind: "image",
      mimetype: "image/jpeg",
      size: raw._data.Message.imageMessage.fileLength,
      filename: null,
      caption: raw._data.Message.imageMessage.caption,
      mediaId: encodeMediaId(raw.from, raw.id),
      available: true,
    });
  });

  it("maps a sticker and a video", () => {
    const sticker = mapper.message(pick(groupMedia, "stickerMessage"));
    expect(sticker.type).toBe("sticker");
    expect(sticker.attachment?.mimetype).toBe("image/webp");
    const video = mapper.message(pick(groupMedia, "videoMessage"));
    expect(video.type).toBe("video");
    expect(video.attachment?.mimetype).toBe("video/mp4");
  });

  it("maps a PTT audio message as a voice note", () => {
    const raw = pick(directMedia, "audioMessage");
    const out = mapper.message(raw);
    expect(out.type).toBe("voice");
    expect(out.attachment?.kind).toBe("voice");
    expect(out.attachment?.mimetype).toBe("audio/ogg; codecs=opus");
  });

  it("maps non-PTT audio as audio", () => {
    const out = mapper.message(
      synth({ audioMessage: { mimetype: "audio/mpeg", fileLength: 10, PTT: false } }),
    );
    expect(out.type).toBe("audio");
    expect(out.attachment?.kind).toBe("audio");
  });

  it("maps a document with its filename", () => {
    const raw = pick(directMedia, "documentMessage");
    const out = mapper.message(raw);
    expect(out.type).toBe("document");
    expect(out.attachment?.filename).toBe(raw._data.Message.documentMessage.fileName);
    expect(out.attachment?.mimetype).toBe("application/pdf");
  });

  it("direct chat: outgoing message is authored by the owner", () => {
    const raw = directText.find((m) => m.fromMe) as Raw;
    const out = mapper.message(raw);
    expect(out.author.id).toBe(raw._data.Info.Sender.replace(/:\d+@/, "@"));
    expect(out.author.id).not.toBe(raw.from);
  });

  it("direct chat: incoming message is authored by the contact", () => {
    const raw = directText.find((m) => !m.fromMe) as Raw;
    expect(mapper.message(raw).author.id).toBe(raw.from);
  });

  it("every plain fixture message maps to a known type with an ISO UTC timestamp", () => {
    for (const raw of [...groupText, ...groupMedia, ...directText, ...directMedia]) {
      const out = mapper.message(raw);
      expect(out.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(out.type).not.toBe("unknown");
    }
  });
});

describe("GOWS message mapper - synthetic kinds", () => {
  it("maps mentions from extendedTextMessage contextInfo", () => {
    const out = mapper.message(
      synth({
        extendedTextMessage: {
          text: "hi @x",
          contextInfo: { mentionedJID: ["1@lid", "2@s.whatsapp.net"] },
        },
      }),
    );
    expect(out.mentions).toEqual(["1@lid", "2@s.whatsapp.net"]);
  });

  it("maps a location", () => {
    const out = mapper.message(
      synth({
        locationMessage: { degreesLatitude: -12.05, degreesLongitude: -77.04, name: "Lima" },
      }),
    );
    expect(out.type).toBe("location");
    expect(out.location).toEqual({ lat: -12.05, lng: -77.04, name: "Lima" });
  });

  it("maps a contact card", () => {
    const out = mapper.message(
      synth({
        contactMessage: {
          displayName: "Bob",
          vcard: "BEGIN:VCARD\nFN:Bob\nTEL;waid=51999888777:+51 999 888 777\nEND:VCARD",
        },
      }),
    );
    expect(out.type).toBe("contact");
    expect(out.contact).toEqual({ name: "Bob", phone: "51999888777" });
  });

  it("maps a poll", () => {
    const out = mapper.message(
      synth({
        pollCreationMessageV3: {
          name: "Lunch?",
          options: [{ optionName: "Yes" }, { optionName: "No" }],
        },
      }),
    );
    expect(out.type).toBe("poll");
    expect(out.poll).toEqual({ question: "Lunch?", options: ["Yes", "No"] });
  });

  it("reaction events are not messages: reaction() exposes target and emoji", () => {
    const raw = synth({
      reactionMessage: { key: { ID: "TARGET1" }, text: "👍" },
    });
    expect(mapper.reaction(raw)).toEqual({
      targetId: "TARGET1",
      reaction: { emoji: "👍", by: "100000000000042@lid" },
    });
    expect(mapper.reaction(synth({ conversation: "x" }))).toBeNull();
  });

  it("maps a revoked message as deleted without text", () => {
    const out = mapper.message(synth({ protocolMessage: { type: "REVOKE", key: { ID: "T" } } }));
    expect(out.type).toBe("deleted");
    expect(out.text).toBeNull();
  });

  it("maps other protocol messages and empty payloads as system", () => {
    expect(mapper.message(synth({ protocolMessage: { type: "EPHEMERAL_SETTING" } })).type).toBe(
      "system",
    );
    expect(mapper.message(synth({ messageContextInfo: {} })).type).toBe("system");
  });

  it("maps an unknown kind to unknown with rawType and does not throw", () => {
    const out = mapper.message(synth({ fancyNewMessage: { a: 1 } }));
    expect(out.type).toBe("unknown");
    expect(out.rawType).toBe("fancyNewMessage");
  });

  it("unwraps ephemeral-wrapped text", () => {
    const out = mapper.message(
      synth({ ephemeralMessage: { message: { extendedTextMessage: { text: "vanish" } } } }),
    );
    expect(out.type).toBe("text");
    expect(out.text).toBe("vanish");
  });

  it("unwraps viewOnce and viewOnceV2 images keeping the caption", () => {
    for (const wrap of ["viewOnceMessage", "viewOnceMessageV2"]) {
      const out = mapper.message(
        synth({
          [wrap]: {
            message: { imageMessage: { mimetype: "image/jpeg", caption: "peek", fileLength: 5 } },
          },
        }),
      );
      expect(out.type).toBe("image");
      expect(out.text).toBe("peek");
      expect(out.attachment?.caption).toBe("peek");
    }
  });

  it("unwraps documentWithCaptionMessage keeping caption and filename", () => {
    const out = mapper.message(
      synth({
        documentWithCaptionMessage: {
          message: {
            documentMessage: { fileName: "a.pdf", caption: "see", mimetype: "application/pdf" },
          },
        },
      }),
    );
    expect(out.type).toBe("document");
    expect(out.attachment?.filename).toBe("a.pdf");
    expect(out.attachment?.caption).toBe("see");
  });

  it("treats edited content as the current text", () => {
    const wrapped = mapper.message(
      synth({ editedMessage: { message: { conversation: "fixed" } } }),
    );
    expect(wrapped.text).toBe("fixed");
    const proto = mapper.message(
      synth({
        protocolMessage: { type: "MESSAGE_EDIT", editedMessage: { conversation: "fixed2" } },
      }),
    );
    expect(proto.type).toBe("text");
    expect(proto.text).toBe("fixed2");
  });

  it("stops safely on over-nested containers", () => {
    const deep = {
      ephemeralMessage: {
        message: {
          viewOnceMessage: {
            message: {
              ephemeralMessage: {
                message: { ephemeralMessage: { message: { conversation: "x" } } },
              },
            },
          },
        },
      },
    };
    const out = mapper.message(synth(deep));
    expect(out.type).toBe("unknown");
  });

  it("does not treat prototype keys as media kinds", () => {
    for (const k of ["constructor", "toString"]) {
      const out = mapper.message(synth({ [k]: {} }));
      expect(out.type).toBe("unknown");
      expect(out.rawType).toBe(k);
    }
  });

  it("never throws on garbage input", () => {
    for (const bad of [null, undefined, 42, "x", {}, { _data: 5 }]) {
      expect(mapper.message(bad).type).toBe("unknown");
    }
  });

  it("author falls back to phone when push name is missing", () => {
    const out = mapper.message(
      synth(
        { conversation: "hi" },
        { participant: "51999888777@s.whatsapp.net" },
        { Sender: "51999888777:3@s.whatsapp.net", PushName: "" },
      ),
    );
    expect(out.author).toEqual({
      id: "51999888777@s.whatsapp.net",
      phone: "51999888777",
      name: "51999888777",
    });
  });

  it("uses SenderAlt as phone for lid senders and null name without any identity", () => {
    const out = mapper.message(
      synth(
        { conversation: "hi" },
        {},
        { PushName: "", SenderAlt: "51999888777:23@s.whatsapp.net" },
      ),
    );
    expect(out.author.phone).toBe("51999888777");
    const none = mapper.message(synth({ conversation: "hi" }, {}, { PushName: "" }));
    expect(none.author.name).toBeNull();
  });

  it("timestamps are ISO UTC", () => {
    expect(mapper.message(synth({ conversation: "hi" })).timestamp).toBe(
      "2026-10-30T16:05:15.000Z",
    );
  });
});

describe("GOWS group and chat mappers", () => {
  it("maps group list items", () => {
    const raw = load("gows", "groups.json")[0] as Raw;
    expect(mapper.groupSummary(raw)).toEqual({
      id: raw.JID,
      name: raw.Name,
      participantCount: raw.ParticipantCount,
      lastActivity: null,
    });
  });

  it("maps group detail with participants", () => {
    const raw = JSON.parse(readFileSync("test/fixtures/gows/group.json", "utf8")) as Raw;
    const out = mapper.groupInfo(raw);
    expect(out.id).toBe(raw.JID);
    expect(out.participants).toHaveLength(raw.Participants.length);
    expect(out.participants[0]).toEqual({
      id: raw.Participants[0].JID,
      phone: null,
      isAdmin: false,
    });
    expect(out.participantCount).toBe(raw.ParticipantCount);
    expect(out.createdAt).toBeNull();
  });

  it("treats super admins as admins and reads real phone numbers", () => {
    const out = mapper.groupInfo({
      JID: "1@g.us",
      Name: "G",
      Topic: "about",
      GroupCreated: "2024-01-02T03:04:05Z",
      Participants: [
        { JID: "9@lid", PhoneNumber: "51999888777@s.whatsapp.net", IsSuperAdmin: true },
      ],
    });
    expect(out.description).toBe("about");
    expect(out.createdAt).toBe("2024-01-02T03:04:05.000Z");
    expect(out.participantCount).toBe(1);
    expect(out.participants).toEqual([{ id: "9@lid", phone: "51999888777", isAdmin: true }]);
  });

  it("maps chat list items (name often empty)", () => {
    expect(
      mapper.chatSummary({ id: "51999888777@c.us", name: "", conversationTimestamp: 1793376315 }),
    ).toEqual({
      id: "51999888777@c.us",
      name: null,
      phone: "51999888777",
      lastActivity: "2026-10-30T16:05:15.000Z",
    });
    expect(mapper.chatSummary({ id: { _serialized: "51999888777@c.us" } }).id).toBe(
      "51999888777@c.us",
    );
    expect(mapper.chatSummary({ id: "5@lid", name: "Ana" })).toEqual({
      id: "5@lid",
      name: "Ana",
      phone: null,
      lastActivity: null,
    });
  });
});

describe("mediaId and engine selection", () => {
  it("round-trips and rejects garbage", () => {
    const id = encodeMediaId("c@g.us", "false_c@g.us_M1_p@lid");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeMediaId(id)).toEqual({ chatId: "c@g.us", messageId: "false_c@g.us_M1_p@lid" });
    expect(decodeMediaId("%%%")).toBeNull();
    expect(decodeMediaId(Buffer.from("[1]").toString("base64url"))).toBeNull();
    expect(decodeMediaId(Buffer.from('{"c":1}').toString("base64url"))).toBeNull();
  });

  it("getEngineMapper('WEBJS') throws UnsupportedEngineError mentioning WEBJS and GOWS", () => {
    expect(() => getEngineMapper("WEBJS")).toThrow(UnsupportedEngineError);
    expect(() => getEngineMapper("WEBJS")).toThrow(/WEBJS.*GOWS/);
  });

  it("fromMe is true for the owner's messages and false for the rest", () => {
    expect(directText.some((r) => r.fromMe === true)).toBe(true);
    for (const raw of [...directText, ...directMedia, ...groupText])
      expect(mapper.message(raw).fromMe).toBe(raw.fromMe === true);
    expect(mapper.message({ _data: { Info: { IsFromMe: true }, Message: {} } }).fromMe).toBe(true);
  });
});
