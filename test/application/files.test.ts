import { describe, expect, it } from "vitest";
import { extractLinks, listSharedFiles } from "../../src/application/files.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import type { InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";
import { ANA, BOB, chat, GROUP_A, gateway, msg, type Raw } from "./helpers.js";

const NOW = Date.parse("2026-10-30T15:00:00Z");
const nowSec = NOW / 1000;
const DAY = 86_400;
const deps = { now: () => NOW, statsMaxMessages: 5000 };
const run = (gw: InMemoryWahaGateway, q: Partial<Parameters<typeof listSharedFiles>[2]> = {}) =>
  listSharedFiles(gw, gowsMapper, { scope: "direct", ...q }, deps);

/** Raw media message: `key` is the GOWS content key (documentMessage, imageMessage, ...). */
function media(
  id: string,
  ts: number,
  key: string,
  content: Record<string, unknown>,
  chatId: string,
  mine = false,
): Raw {
  const base = msg(id, ts, "", { chat: chatId, mine });
  return {
    ...base,
    hasMedia: true,
    body: null,
    _data: { ...(base._data as Raw), Message: { [key]: content } },
  };
}

describe("extractLinks", () => {
  it("finds http(s) urls and strips trailing punctuation that is not part of the url", () => {
    expect(
      extractLinks("mira https://a.com/x. y (http://b.org/p?q=1), luego https://c.io/a_(b)!"),
    ).toEqual(["https://a.com/x", "http://b.org/p?q=1", "https://c.io/a_(b)"]);
  });

  it("does not match a scheme inside a word", () => {
    expect(extractLinks("xhttp://a.com y_https://b.com ok http://c.com")).toEqual(["http://c.com"]);
  });

  it("stays linear on an adversarial run of closing brackets", () => {
    const t0 = performance.now();
    expect(extractLinks(`http://a${")".repeat(60_000)}`)).toEqual([]);
    expect(extractLinks(`http://a${")".repeat(2_000)}`)).toEqual(["http://a"]);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("dedupes within the text and ignores non-links", () => {
    expect(extractLinks("https://a.com https://a.com ftp://x.com www.a.com https://")).toEqual([
      "https://a.com",
    ]);
  });
});

describe("listSharedFiles", () => {
  const data = () => ({
    chats: [chat(ANA, nowSec - 100, "Ana"), chat(BOB, nowSec - 200, "Bob")],
    messages: {
      [ANA]: [
        msg("a3", nowSec - 100, "el link https://a.com/doc, y otra vez https://a.com/doc", {
          chat: ANA,
        }),
        media(
          "a2",
          nowSec - 3600,
          "documentMessage",
          { fileName: "contrato.pdf", mimetype: "application/pdf", fileLength: 1234 },
          ANA,
          true,
        ),
        media(
          "a1",
          nowSec - 2 * DAY,
          "imageMessage",
          { mimetype: "image/jpeg", caption: "foto https://img.io/x" },
          ANA,
        ),
      ],
      [BOB]: [
        media("b1", nowSec - 200, "audioMessage", { PTT: true, mimetype: "audio/ogg" }, BOB),
        media("b0", nowSec - 40 * DAY, "documentMessage", { fileName: "viejo.pdf" }, BOB),
      ],
    },
  });

  it("lists attachments and links newest first with the documented fields", async () => {
    const r = await run(gateway(data()));
    expect(r.items.map((i) => [i.messageId.split("_")[2], i.kind])).toEqual([
      ["a3", "link"],
      ["b1", "voice"],
      ["a2", "document"],
      ["a1", "image"],
      ["a1", "link"],
    ]);
    const doc = r.items.find((i) => i.kind === "document");
    expect(doc).toMatchObject({
      chatId: ANA,
      chatName: "Ana",
      filename: "contrato.pdf",
      mimetype: "application/pdf",
      size: 1234,
      url: null,
    });
    expect(doc?.mediaId).toEqual(expect.any(String));
    expect(doc?.at).toBe(new Date((nowSec - 3600) * 1000).toISOString());
    const link = r.items[0];
    expect(link).toMatchObject({
      url: "https://a.com/doc",
      filename: null,
      mimetype: null,
      size: null,
      mediaId: null,
    });
    expect(r.totalMatches).toBe(5);
    expect(r.coverage.chatsScanned).toBe(2);
  });

  it("filters by kind, including links only", async () => {
    const docs = await run(gateway(data()), { kind: "document" });
    expect(docs.items.map((i) => i.filename)).toEqual(["contrato.pdf"]);
    const links = await run(gateway(data()), { kind: "link" });
    expect(links.items.map((i) => i.url)).toEqual(["https://a.com/doc", "https://img.io/x"]);
  });

  it("applies the 30-day default window, an explicit range and limit with a note", async () => {
    const old = await run(gateway(data()), { from: "2026-08-01T00:00:00Z", kind: "document" });
    expect(old.items.map((i) => i.filename)).toEqual(["contrato.pdf", "viejo.pdf"]);
    const one = await run(gateway(data()), { limit: 2 });
    expect(one.items).toHaveLength(2);
    expect(one.totalMatches).toBe(5);
    expect(one.coverage.notes.join(" ")).toContain("Showing the newest 2 of 5");
  });

  it("reads one chat of any type with chatId, and fans out over groups with scope", async () => {
    const gw = gateway({
      chats: [chat(GROUP_A, nowSec - 50, "Equipo")],
      messages: {
        [GROUP_A]: [
          media("g1", nowSec - 50, "stickerMessage", { mimetype: "image/webp" }, GROUP_A),
        ],
      },
    });
    const direct = await run(gw);
    expect(direct.items).toEqual([]);
    const groups = await run(gw, { scope: "groups" });
    expect(groups.items).toMatchObject([{ chatId: GROUP_A, chatName: "Equipo", kind: "sticker" }]);
    const one = await run(gw, { chatId: GROUP_A });
    expect(one).toMatchObject({ scope: null });
    expect(one.items).toHaveLength(1);
  });

  it("bounds item size: long urls are skipped and counted, long filenames truncated", async () => {
    const long = `https://a.com/${"x".repeat(2100)}`;
    const gw = gateway({
      chats: [chat(ANA, nowSec - 10, "Ana")],
      messages: {
        [ANA]: [
          msg("l1", nowSec - 10, `${long} y https://ok.com/a`, { chat: ANA }),
          media("l2", nowSec - 20, "documentMessage", { fileName: "n".repeat(400) }, ANA),
        ],
      },
    });
    const r = await run(gw);
    expect(r.items.filter((i) => i.kind === "link").map((i) => i.url)).toEqual([
      "https://ok.com/a",
    ]);
    expect(r.coverage.notes.join(" ")).toContain("1 link(s) longer than 2048");
    const doc = r.items.find((i) => i.kind === "document");
    expect(Array.from(doc?.filename ?? "")).toHaveLength(255);
    expect(doc?.filename?.endsWith("…")).toBe(true);
  });

  it("validates kind, limit and range", async () => {
    const gw = gateway(data());
    await expect(run(gw, { limit: 201 })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { limit: 0 })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { from: "ayer" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      run(gw, { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { kind: "pdf" as never })).rejects.toBeInstanceOf(InvalidInputError);
  });
});
