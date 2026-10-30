import { describe, expect, it } from "vitest";
import { getThread } from "../../src/application/thread.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import type { InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";
import { ANA, chat, gateway, msg } from "./helpers.js";

const deps = { statsMaxMessages: 5000 };
const run = (gw: InMemoryWahaGateway, q: Partial<Parameters<typeof getThread>[2]> = {}) =>
  getThread(gw, gowsMapper, { chatId: ANA, messageId: "m10", ...q }, deps);

/** 30 messages m1..m30, newest first; m20 replies to m15, m15 to m3, m3 to a message outside. */
function data(n = 30) {
  const messages = Array.from({ length: n }, (_, i) => {
    const k = n - i;
    const replyTo = k === 20 ? "m15" : k === 15 ? "m3" : k === 3 ? "gone" : undefined;
    return msg(`m${k}`, 1_000_000 + k * 10, `text ${k}`, { chat: ANA, replyTo });
  });
  return { chats: [chat(ANA, 2_000_000)], messages: { [ANA]: messages } };
}
const texts = (ms: { text: string | null }[]) => ms.map((m) => m.text);

describe("getThread", () => {
  it("returns the anchor with before (older) and after (newer) in chronological order", async () => {
    const r = await run(gateway(data()), { before: 2, after: 3 });
    expect(r.anchor.text).toBe("text 10");
    expect(texts(r.before)).toEqual(["text 8", "text 9"]);
    expect(texts(r.after)).toEqual(["text 11", "text 12", "text 13"]);
  });

  it("defaults to 10 before and 10 after", async () => {
    const r = await run(gateway(data()));
    expect(r.before).toHaveLength(9); // only m1..m9 exist before m10
    expect(r.after).toHaveLength(10);
    const mid = await run(gateway(data()), { messageId: "m15" });
    expect(mid.before).toHaveLength(10);
    expect(mid.after).toHaveLength(10);
  });

  it("accepts the full WAHA id or the bare stanza id", async () => {
    const gw = gateway(data());
    const full = `false_${ANA}_m10_${ANA}`;
    expect((await run(gw, { messageId: full })).anchor.text).toBe("text 10");
  });

  it("replyChain lists the ancestors in the window oldest first; missing ones go to coverage", async () => {
    const r = await run(gateway(data()), { messageId: "m20", before: 0, after: 0 });
    // m20 -> m15 -> m3 -> "gone" (not in history). Ancestors are found even beyond `before`.
    expect(texts(r.replyChain)).toEqual(["text 3", "text 15"]);
    expect(r.coverage.missingAncestors).toEqual(["gone"]);
    expect(r.coverage.notes.join(" ")).toContain("gone");
    const plain = await run(gateway(data()), { messageId: "m10" });
    expect(plain.replyChain).toEqual([]);
    expect(plain.coverage.missingAncestors).toEqual([]);
  });

  it("pages through older history until the anchor is found", async () => {
    const gw = gateway(data(500));
    const r = await run(gw, { messageId: "m5", before: 2, after: 2 });
    expect(r.anchor.text).toBe("text 5");
    expect(texts(r.before)).toEqual(["text 3", "text 4"]);
    expect(texts(r.after)).toEqual(["text 6", "text 7"]);
  });

  it("does not read the whole history when the anchor is recent", async () => {
    const gw = gateway(data(1000));
    await run(gw, { messageId: "m995", before: 1, after: 1 });
    expect(gw.count("getMessages")).toBe(1);
  });

  it("fails clearly when the anchor is not in the recent history", async () => {
    const err = await run(gateway(data()), { messageId: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).toContain("message not found in the recent history");
  });

  it("stops looking after STATS_MAX_MESSAGES", async () => {
    const gw = gateway(data(500));
    const err = await getThread(
      gw,
      gowsMapper,
      { chatId: ANA, messageId: "m5" },
      { statsMaxMessages: 300 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).toContain("not found in the recent history");
  });

  it("stops paging when the cursor does not advance", async () => {
    const gw = gateway(data(300));
    const page = await gw.getMessages(ANA, { limit: 200, offset: 0 });
    gw.getMessages = async () => page;
    const err = await run(gw, { messageId: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
  });

  it("caps the reply chain at 10 and says so", async () => {
    const messages = Array.from({ length: 30 }, (_, i) => {
      const k = 30 - i;
      return msg(`c${k}`, 1_000_000 + k, `t${k}`, {
        chat: ANA,
        replyTo: k > 1 ? `c${k - 1}` : undefined,
      });
    });
    const gw = gateway({ chats: [chat(ANA, 2_000_000)], messages: { [ANA]: messages } });
    const r = await run(gw, { messageId: "c30", before: 0, after: 0 });
    expect(r.replyChain).toHaveLength(10);
    expect(r.coverage.notes.join(" ")).toContain("cut at 10");
  });

  it("flags a reply cycle", async () => {
    const messages = [
      msg("y2", 1_000_002, "b", { chat: ANA, replyTo: "y1" }),
      msg("y1", 1_000_001, "a", { chat: ANA, replyTo: "y2" }),
    ];
    const gw = gateway({ chats: [chat(ANA, 2_000_000)], messages: { [ANA]: messages } });
    const r = await run(gw, { messageId: "y2", before: 0, after: 0 });
    expect(r.replyChain).toHaveLength(1);
    expect(r.coverage.notes.join(" ")).toContain("loop");
  });

  it("validates before/after (0..50)", async () => {
    const gw = gateway(data());
    for (const q of [{ before: -1 }, { after: 51 }, { before: 1.5 }])
      await expect(run(gw, q)).rejects.toBeInstanceOf(InvalidInputError);
    expect((await run(gw, { before: 0, after: 0 })).before).toEqual([]);
  });
});
