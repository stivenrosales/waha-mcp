import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/application/cursor.js";
import { fetchRange, getMessages } from "../../src/application/messages.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { getEngineMapper } from "../../src/infrastructure/waha/engines/index.js";
import { InMemoryWahaGateway, rawReaction, rawText } from "../fakes/InMemoryWahaGateway.js";

const m = getEngineMapper("GOWS");
const CHAT = "100000000000009@g.us";

/** `n` messages, newest first (timestamps descending), ids M{n}..M1. */
function history(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const k = n - i;
    return rawText(`M${k}`, 1_000_000 + k * 60, `msg ${k}`, { name: "Ana" });
  });
}

describe("cursor", () => {
  it("round-trips base64url JSON and rejects garbage", () => {
    const c = encodeCursor({ offset: 50, from: "a", to: null });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual({ offset: 50, from: "a", to: null });
    expect(() => decodeCursor("%%%")).toThrow(InvalidInputError);
    expect(() => decodeCursor(Buffer.from('{"offset":-1}').toString("base64url"))).toThrow(
      InvalidInputError,
    );
  });
});

describe("getMessages", () => {
  it("paginates newest first with nextCursor and returns null at the end", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [CHAT]: history(5) } });
    const p1 = await getMessages(gw, m, { chatId: CHAT, limit: 2 });
    expect(p1.messages.map((x) => x.text)).toEqual(["msg 5", "msg 4"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await getMessages(gw, m, {
      chatId: CHAT,
      limit: 2,
      cursor: p1.nextCursor as string,
    });
    expect(p2.messages.map((x) => x.text)).toEqual(["msg 3", "msg 2"]);
    const p3 = await getMessages(gw, m, {
      chatId: CHAT,
      limit: 2,
      cursor: p2.nextCursor as string,
    });
    expect(p3.messages.map((x) => x.text)).toEqual(["msg 1"]);
    expect(p3.nextCursor).toBeNull();
  });

  it("rejects a cursor from another range", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [CHAT]: history(5) } });
    const p1 = await getMessages(gw, m, { chatId: CHAT, limit: 2, from: "1970-01-01T00:00:00Z" });
    await expect(
      getMessages(gw, m, { chatId: CHAT, limit: 2, cursor: p1.nextCursor as string }),
    ).rejects.toThrow(/different date range/);
  });

  it("validates limit (1..200, default 50) and dates", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [CHAT]: history(60) } });
    expect((await getMessages(gw, m, { chatId: CHAT })).messages).toHaveLength(50);
    await expect(getMessages(gw, m, { chatId: CHAT, limit: 0 })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(getMessages(gw, m, { chatId: CHAT, limit: 201 })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(getMessages(gw, m, { chatId: CHAT, from: "nope" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("passes from/to to the gateway as unix seconds", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [CHAT]: [] } });
    await getMessages(gw, m, {
      chatId: CHAT,
      from: "2026-10-30T00:00:00Z",
      to: "2026-10-31T00:00:00Z",
    });
    expect(gw.calls[0]?.args[1]).toMatchObject({ from: 1793318400, to: 1793404800 });
  });

  it("attaches reactions from the same page, drops others, never returns reaction events", async () => {
    const raws = [
      rawReaction("R1", 1_000_400, "M2", "👍", { sender: "200@lid" }),
      rawText("M2", 1_000_300, "target", { name: "Ana" }),
      rawReaction("R2", 1_000_200, "OFFPAGE", "😂"),
      rawText("M1", 1_000_100, "other", { name: "Ana" }),
    ];
    const gw = new InMemoryWahaGateway({ messages: { [CHAT]: raws } });
    const { messages } = await getMessages(gw, m, { chatId: CHAT, limit: 50 });
    expect(messages.map((x) => x.text)).toEqual(["target", "other"]);
    expect(messages[0]?.reactions).toEqual([{ emoji: "👍", by: "200@lid" }]);
    expect(messages[1]?.reactions).toEqual([]);
  });

  it("works for direct chats too", async () => {
    const chat = "51911111111@c.us";
    const gw = new InMemoryWahaGateway({
      messages: { [chat]: [rawText("D1", 1_000_100, "hola", { chat, sender: chat })] },
    });
    const out = await getMessages(gw, m, { chatId: chat, limit: 10 });
    expect(out.messages[0]?.text).toBe("hola");
  });
});

describe("fetchRange", () => {
  it("stops at cap and sets truncated (3 newest of 5)", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [CHAT]: history(5) } });
    const out = await fetchRange(gw, m, { chatId: CHAT, cap: 3 });
    expect(out.messages.map((x) => x.text)).toEqual(["msg 5", "msg 4", "msg 3"]);
    expect(out.truncated).toBe(true);
  });

  it("is not truncated when the history fits the cap exactly", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [CHAT]: history(3) } });
    const out = await fetchRange(gw, m, { chatId: CHAT, cap: 3 });
    expect(out.messages).toHaveLength(3);
    expect(out.truncated).toBe(false);
  });

  it("pages by 200 across the whole history", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [CHAT]: history(450) } });
    const out = await fetchRange(gw, m, { chatId: CHAT, cap: 1000 });
    expect(out.messages).toHaveLength(450);
    expect(out.truncated).toBe(false);
    expect(gw.calls.map((c) => (c.args[1] as { offset: number }).offset)).toEqual([0, 200, 400]);
  });

  it("empty history returns no messages and is not truncated", async () => {
    const gw = new InMemoryWahaGateway({ messages: {} });
    expect(await fetchRange(gw, m, { chatId: CHAT, cap: 10 })).toEqual({
      messages: [],
      truncated: false,
    });
  });
});
