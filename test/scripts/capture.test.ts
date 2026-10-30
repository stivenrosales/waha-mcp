import { describe, expect, it } from "vitest";
import {
  bucketOf,
  classifyMessage,
  dedupeById,
  fixtureFileName,
  MESSAGE_KINDS,
  parseCaptureArgs,
  planDownloadPages,
  selectMessages,
  sessionFixture,
} from "../../scripts/capture-lib.js";

describe("parseCaptureArgs", () => {
  it("parses repeatable --group and defaults --out", () => {
    expect(parseCaptureArgs(["--group", "a@g.us", "--group=b@g.us"])).toEqual({
      groups: ["a@g.us", "b@g.us"],
      out: "test/fixtures/gows",
    });
  });
  it("ignores a leading -- forwarded by pnpm and accepts --out", () => {
    expect(parseCaptureArgs(["--", "--group", "a@g.us", "--out", "tmp/x"])).toEqual({
      groups: ["a@g.us"],
      out: "tmp/x",
    });
  });
  it("requires 1 or 2 groups", () => {
    expect(() => parseCaptureArgs([])).toThrow(/--group/);
    expect(() => parseCaptureArgs(["--group", "a", "--group", "b", "--group", "c"])).toThrow(
      /at most 2/,
    );
  });
  it("rejects unknown options", () => {
    expect(() => parseCaptureArgs(["--group", "a", "--nope"])).toThrow();
  });
});

describe("fixtureFileName", () => {
  it("names message files by bucket and download mode", () => {
    expect(fixtureFileName("messages-media", false)).toBe("messages-media.json");
    expect(fixtureFileName("messages-media", true)).toBe("messages-media-download.json");
  });
});

const wrap = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "x",
  _data: { Message: message },
  ...extra,
});

describe("classifyMessage", () => {
  it.each([
    [wrap({ conversation: "hi" }), ["text"]],
    [wrap({ imageMessage: {} }), ["image"]],
    [wrap({ stickerMessage: {} }), ["sticker"]],
    [wrap({ audioMessage: { PTT: true } }), ["voice"]],
    [wrap({ audioMessage: { PTT: false } }), ["audio"]],
    [wrap({ videoMessage: {} }), ["video"]],
    [wrap({ documentMessage: {} }), ["document"]],
    [wrap({ locationMessage: {} }), ["location"]],
    [wrap({ contactMessage: {} }), ["contact"]],
    [wrap({ pollCreationMessageV3: {} }), ["poll"]],
    [wrap({ reactionMessage: {} }), ["reaction"]],
    [wrap({ protocolMessage: { type: "REVOKE" } }), ["deleted"]],
    [wrap({ protocolMessage: { type: "EPHEMERAL_SETTING" } }), ["system"]],
    [
      wrap({
        extendedTextMessage: { text: "a", contextInfo: { quotedMessage: {}, mentionedJid: ["1"] } },
      }),
      ["text", "reply", "mention"],
    ],
  ])("classifies %#", (msg, kinds) => {
    expect([...classifyMessage(msg)].sort()).toEqual([...kinds].sort());
  });

  it("falls back to the WAHA type and replyTo fields", () => {
    expect([...classifyMessage({ type: "image" })]).toContain("image");
    expect([...classifyMessage({ replyTo: { id: "y" }, body: "r" })]).toContain("reply");
    expect([...classifyMessage({ body: "plain" })]).toEqual(["text"]);
  });
});

describe("bucketOf", () => {
  it("groups kinds into the three message fixtures", () => {
    expect(bucketOf("text")).toBe("messages-text");
    expect(bucketOf("reply")).toBe("messages-text");
    expect(bucketOf("image")).toBe("messages-media");
    expect(bucketOf("voice")).toBe("messages-media");
    expect(bucketOf("poll")).toBe("messages-misc");
    expect(bucketOf("deleted")).toBe("messages-misc");
  });
});

describe("selectMessages", () => {
  const msgs = [
    wrap({ conversation: "1" }, { id: "t1" }),
    wrap({ conversation: "2" }, { id: "t2" }),
    wrap({ conversation: "3" }, { id: "t3" }),
    wrap({ imageMessage: {} }, { id: "i1" }),
    wrap({ imageMessage: {} }, { id: "i2" }),
    wrap({ pollCreationMessage: {} }, { id: "p1" }),
  ];

  it("keeps up to perKind samples of each kind and reports found vs missing", () => {
    const r = selectMessages(msgs, 1);
    expect(r.selected.map((m) => (m as { id: string }).id)).toEqual(["t1", "i1", "p1"]);
    expect(r.found.sort()).toEqual(["image", "poll", "text"]);
    expect(r.missing.sort()).toEqual(MESSAGE_KINDS.filter((k) => !r.found.includes(k)).sort());
    expect(r.missing).toContain("sticker");
  });

  it("buckets selected messages", () => {
    const r = selectMessages(msgs, 2);
    expect(r.byBucket["messages-text"]).toHaveLength(2);
    expect(r.byBucket["messages-media"]).toHaveLength(2);
    expect(r.byBucket["messages-misc"]).toHaveLength(1);
  });
});

describe("sessionFixture", () => {
  it("keeps only name, status and engine, dropping config and me", () => {
    const out = sessionFixture({
      name: "default",
      status: "WORKING",
      engine: { engine: "GOWS", other: 1 },
      config: { webhooks: [{ hmac: { key: "secret" } }] },
      me: { id: "51987654321@c.us" },
    });
    expect(out).toEqual({ name: "default", status: "WORKING", engine: { engine: "GOWS" } });
  });
});

describe("planDownloadPages", () => {
  it("requests each page's own offset once", () => {
    const pages = [
      { chatId: "a", offset: 0 },
      { chatId: "a", offset: 100 },
      { chatId: "a", offset: 200 },
      { chatId: "b", offset: 0 },
      { chatId: "a", offset: 100 },
    ];
    expect(planDownloadPages(pages)).toEqual([
      { chatId: "a", offset: 0 },
      { chatId: "a", offset: 100 },
      { chatId: "a", offset: 200 },
      { chatId: "b", offset: 0 },
    ]);
  });
});

describe("dedupeById", () => {
  it("drops repeated message ids", () => {
    expect(dedupeById([{ id: "1" }, { id: "2" }, { id: "1" }])).toEqual([{ id: "1" }, { id: "2" }]);
  });
});
