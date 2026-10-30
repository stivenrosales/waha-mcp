import { describe, expect, it } from "vitest";
import { findPendingReplies } from "../../src/application/pending.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import { InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";
import {
  ANA,
  BOB,
  chat,
  GROUP_A,
  GROUP_B,
  gateway,
  ME_LID,
  ME_PHONE,
  msg,
  systemMsg,
} from "./helpers.js";

const NOW = Date.parse("2026-10-30T15:00:00Z");
const nowSec = NOW / 1000;
const deps = { now: () => NOW, statsMaxMessages: 5000 };
const run = (gw: InMemoryWahaGateway, q: Parameters<typeof findPendingReplies>[2] = {}) =>
  findPendingReplies(gw, gowsMapper, q, deps);

describe("findPendingReplies: direct chats", () => {
  it("a chat where the owner answered last is not pending", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 100)],
      messages: {
        [ANA]: [
          msg("2", nowSec - 100, "listo", { chat: ANA, mine: true }),
          msg("1", nowSec - 200, "hola", { chat: ANA }),
        ],
      },
    });
    const r = await run(gw);
    expect(r.pending).toEqual([]);
    expect(r.totalPending).toBe(0);
    expect(r.coverage.chatsScanned).toBe(1);
  });

  it("the other side speaking last is pending: waiting since the first unanswered message", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 60, "Ana")],
      messages: {
        [ANA]: [
          msg("4", nowSec - 60, "?", { chat: ANA }),
          msg("3", nowSec - 3600, "puedes?", { chat: ANA }),
          msg("2", nowSec - 7200, "ok gracias", { chat: ANA, mine: true }),
          msg("1", nowSec - 9000, "hola", { chat: ANA }),
        ],
      },
    });
    const [p] = (await run(gw)).pending;
    expect(p).toMatchObject({
      chatId: ANA,
      isGroup: false,
      reason: "last-message-from-them",
      unansweredCount: 2,
      waitingSince: new Date((nowSec - 3600) * 1000).toISOString(),
      waitingMinutes: 60,
    });
    expect(p?.lastMessages.map((m) => m.text)).toEqual(["hola", "ok gracias", "puedes?", "?"]);
    expect(p?.lastMessages[1]).toMatchObject({ from: "me", type: "text", hasAttachment: false });
    expect(p?.lastMessages[0]?.at).toBe(new Date((nowSec - 9000) * 1000).toISOString());
  });

  it("system messages never count as the last message", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 10), chat(BOB, nowSec - 10)],
      messages: {
        [ANA]: [
          systemMsg("s", nowSec - 10, ANA),
          msg("2", nowSec - 100, "listo", { chat: ANA, mine: true }),
          msg("1", nowSec - 200, "hola", { chat: ANA }),
        ],
        [BOB]: [systemMsg("s", nowSec - 10, BOB), msg("1", nowSec - 200, "hola", { chat: BOB })],
      },
    });
    expect((await run(gw)).pending.map((p) => p.chatId)).toEqual([BOB]);
  });

  it("keeps at most 5 last messages, truncates long text to 280 chars with an ellipsis", async () => {
    const long = "x".repeat(400);
    const msgs = Array.from({ length: 8 }, (_, i) =>
      msg(String(8 - i), nowSec - 10 * (i + 1), i === 0 ? long : `m${8 - i}`, { chat: ANA }),
    );
    const gw = gateway({ chats: [chat(ANA, nowSec - 10)], messages: { [ANA]: msgs } });
    const [p] = (await run(gw)).pending;
    expect(p?.lastMessages).toHaveLength(5);
    expect(p?.lastMessages.at(-1)?.text).toHaveLength(280);
    expect(p?.lastMessages.at(-1)?.text?.endsWith("…")).toBe(true);
    expect(p?.unansweredCount).toBe(8);
  });

  it("sorts by waitingSince ascending and applies limit, reporting the total", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 10), chat(BOB, nowSec - 20)],
      messages: {
        [ANA]: [msg("1", nowSec - 100, "a", { chat: ANA })],
        [BOB]: [msg("1", nowSec - 5000, "b", { chat: BOB })],
      },
    });
    const all = await run(gw);
    expect(all.pending.map((p) => p.chatId)).toEqual([BOB, ANA]);
    const limited = await run(gw, { limit: 1 });
    expect(limited.pending.map((p) => p.chatId)).toEqual([BOB]);
    expect(limited.totalPending).toBe(2);
  });

  it("defaults to the last 7 days: older chats are not fetched", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 8 * 86400), chat(BOB, nowSec - 6 * 86400)],
      messages: {
        [ANA]: [msg("1", nowSec - 8 * 86400, "a", { chat: ANA })],
        [BOB]: [msg("1", nowSec - 6 * 86400, "b", { chat: BOB })],
      },
    });
    const r = await run(gw);
    expect(r.pending.map((p) => p.chatId)).toEqual([BOB]);
    expect(r.since).toBe(new Date(NOW - 7 * 86400_000).toISOString());
    expect(gw.calls.filter((c) => c.method === "getMessages").map((c) => c.args[0])).toEqual([BOB]);
  });

  it("an explicit since widens the window", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 8 * 86400)],
      messages: { [ANA]: [msg("1", nowSec - 8 * 86400, "a", { chat: ANA })] },
    });
    const r = await run(gw, { since: new Date((nowSec - 9 * 86400) * 1000).toISOString() });
    expect(r.pending).toHaveLength(1);
  });

  it("rejects an invalid since and an out-of-range limit", async () => {
    const gw = gateway({});
    await expect(run(gw, { since: "yesterday-ish" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { limit: 0 })).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("findPendingReplies: groups", () => {
  const groupData = (messages: ReturnType<typeof msg>[], id = GROUP_A) => ({
    chats: [chat(id, nowSec - 10, "Team")],
    messages: { [id]: messages },
  });

  it("plain group chatter is not pending", async () => {
    const gw = gateway(
      groupData([
        msg("2", nowSec - 10, "jaja", { chat: GROUP_A, from: "1@lid" }),
        msg("1", nowSec - 20, "hola", { chat: GROUP_A, from: "2@lid" }),
      ]),
    );
    const r = await run(gw, { scope: "groups" });
    expect(r.pending).toEqual([]);
  });

  it("a mention of the owner (by lid or by phone) is pending until the owner writes again", async () => {
    for (const jid of [ME_LID, ME_PHONE, "51000000002@s.whatsapp.net"]) {
      const gw = gateway(
        groupData([
          msg("2", nowSec - 10, "chisme", { chat: GROUP_A, from: "1@lid" }),
          msg("1", nowSec - 600, "@yo puedes?", { chat: GROUP_A, from: "2@lid", mention: [jid] }),
        ]),
      );
      const [p] = (await run(gw, { scope: "groups" })).pending;
      expect(p).toMatchObject({
        chatId: GROUP_A,
        isGroup: true,
        reason: "mentioned",
        unansweredCount: 1,
        waitingMinutes: 10,
      });
    }
    const answered = gateway(
      groupData([
        msg("3", nowSec - 5, "ya", { chat: GROUP_A, mine: true }),
        msg("1", nowSec - 600, "@yo puedes?", {
          chat: GROUP_A,
          from: "2@lid",
          mention: [ME_LID],
        }),
      ]),
    );
    expect((await run(answered, { scope: "groups" })).pending).toEqual([]);
  });

  it("a reply to an owner's message is pending with reason replied-to-you", async () => {
    const gw = gateway(
      groupData([
        msg("3", nowSec - 30, "cuándo?", { chat: GROUP_A, from: "2@lid", replyTo: "1" }),
        msg("2", nowSec - 60, "otra cosa", { chat: GROUP_A, from: "1@lid" }),
        msg("1", nowSec - 120, "mañana", { chat: GROUP_A, mine: true }),
      ]),
    );
    const [p] = (await run(gw, { scope: "groups" })).pending;
    expect(p).toMatchObject({ reason: "replied-to-you", unansweredCount: 1 });
    expect(p?.waitingSince).toBe(new Date((nowSec - 30) * 1000).toISOString());
  });

  it("a reply to somebody else's message is not pending", async () => {
    const gw = gateway(
      groupData([
        msg("2", nowSec - 30, "sí", { chat: GROUP_A, from: "2@lid", replyTo: "1" }),
        msg("1", nowSec - 60, "hola", { chat: GROUP_A, from: "1@lid" }),
      ]),
    );
    expect((await run(gw, { scope: "groups" })).pending).toEqual([]);
  });

  it("counts every trigger since the owner's last message and reports the earliest", async () => {
    const gw = gateway(
      groupData([
        msg("4", nowSec - 10, "@yo?", { chat: GROUP_A, from: "1@lid", mention: [ME_LID] }),
        msg("3", nowSec - 100, "reply", { chat: GROUP_A, from: "2@lid", replyTo: "1" }),
        msg("2", nowSec - 200, "ruido", { chat: GROUP_A, from: "2@lid" }),
        msg("1", nowSec - 300, "yo", { chat: GROUP_A, mine: true }),
      ]),
    );
    const [p] = (await run(gw, { scope: "groups" })).pending;
    expect(p).toMatchObject({ unansweredCount: 2, reason: "replied-to-you" });
    expect(p?.waitingSince).toBe(new Date((nowSec - 100) * 1000).toISOString());
  });
});

describe("findPendingReplies: scope and coverage", () => {
  const data = () => ({
    chats: [chat(ANA, nowSec - 10), chat(GROUP_A, nowSec - 10)],
    messages: {
      [ANA]: [msg("1", nowSec - 100, "hola", { chat: ANA })],
      [GROUP_A]: [
        msg("1", nowSec - 100, "@yo", { chat: GROUP_A, from: "2@lid", mention: [ME_LID] }),
      ],
    },
  });

  it("direct is the default, groups and all widen it", async () => {
    expect((await run(gateway(data()))).pending.map((p) => p.chatId)).toEqual([ANA]);
    expect((await run(gateway(data()), { scope: "groups" })).pending.map((p) => p.chatId)).toEqual([
      GROUP_A,
    ]);
    expect(
      (await run(gateway(data()), { scope: "all" })).pending.map((p) => p.chatId).sort(),
    ).toEqual([ANA, GROUP_A].sort());
  });

  it("a chat whose fetch fails is listed in failedChats and the rest is returned", async () => {
    class Flaky extends InMemoryWahaGateway {
      override async getMessages(
        chatId: string,
        q: Parameters<InMemoryWahaGateway["getMessages"]>[1],
      ) {
        if (chatId === ANA) throw new Error("boom");
        return super.getMessages(chatId, q);
      }
    }
    const d = data();
    const gw = new Flaky({ me: { id: ME_PHONE, lid: ME_LID }, ...d });
    const r = await run(gw, { scope: "all" });
    expect(r.pending.map((p) => p.chatId)).toEqual([GROUP_A]);
    expect(r.coverage.failedChats).toEqual([ANA]);
    expect(r.coverage.chatsScanned).toBe(1);
    expect(r.coverage.truncated).toBe(true);
  });

  it("scans at most 100 chats per call and says how many were skipped", async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `5199${String(i).padStart(7, "0")}@c.us`);
    const gw = gateway({
      chats: ids.map((id, i) => chat(id, nowSec - 10 - i)),
      messages: Object.fromEntries(
        ids.map((id) => [id, [msg("1", nowSec - 100, "hi", { chat: id })]]),
      ),
    });
    const r = await run(gw);
    expect(r.coverage.chatsScanned).toBe(100);
    expect(r.coverage.chatsSkipped).toBe(30);
    expect(r.coverage.truncated).toBe(true);
    expect(r.pending).toHaveLength(50);
    expect(r.totalPending).toBe(100);
  });

  it("fetches at most 5 chats concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    class Slow extends InMemoryWahaGateway {
      override async getMessages(
        chatId: string,
        q: Parameters<InMemoryWahaGateway["getMessages"]>[1],
      ) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await super.getMessages(chatId, q);
        } finally {
          inFlight--;
        }
      }
    }
    const ids = Array.from({ length: 20 }, (_, i) => `5199${String(i).padStart(7, "0")}@c.us`);
    const gw = new Slow({
      me: { id: ME_PHONE, lid: ME_LID },
      chats: ids.map((id) => chat(id, nowSec - 10)),
      messages: Object.fromEntries(
        ids.map((id) => [id, [msg("1", nowSec - 100, "hi", { chat: id })]]),
      ),
    });
    await run(gw);
    expect(peak).toBe(5);
  });

  it("marks coverage truncated when a chat hit the per-chat message cap, and always notes the chat-list gap", async () => {
    const msgs = Array.from({ length: 5 }, (_, i) =>
      msg(String(5 - i), nowSec - 10 * (i + 1), `m${i}`, { chat: ANA }),
    );
    const gw = gateway({ chats: [chat(ANA, nowSec - 10)], messages: { [ANA]: msgs } });
    const r = await findPendingReplies(gw, gowsMapper, {}, { now: () => NOW, statsMaxMessages: 3 });
    expect(r.coverage.truncated).toBe(true);
    expect(r.coverage.notes.join(" ")).toMatch(/chat list/i);
    expect(r.coverage.notes.join(" ")).toMatch(/3 newest messages/);
  });

  it("includes group chats without touching direct ones when scope is groups", async () => {
    const gw = gateway(data());
    await run(gw, { scope: "groups" });
    expect(gw.calls.filter((c) => c.method === "getMessages").map((c) => c.args[0])).toEqual([
      GROUP_A,
    ]);
    void GROUP_B;
  });
});
