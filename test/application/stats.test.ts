import { describe, expect, it } from "vitest";
import { computeChatStats } from "../../src/application/stats.js";
import type { MessageType, NormalizedMessage } from "../../src/domain/message.js";

const GROUP = "g1@g.us";

function msg(
  id: string,
  ts: string,
  author: string | null,
  type: MessageType = "text",
  replyToId: string | null = null,
): NormalizedMessage {
  return {
    id,
    timestamp: ts,
    author: { id: author ?? "", phone: null, name: author ? author.toUpperCase() : null },
    fromMe: false,
    type,
    text: type === "text" ? "x" : null,
    replyToId,
    mentions: [],
    reactions: [],
    attachment: null,
    location: null,
    contact: null,
    poll: null,
    transcript: null,
  };
}

const opts = (over: object = {}) => ({
  chatId: GROUP,
  timezone: "UTC",
  requestedFrom: null,
  requestedTo: null,
  truncated: false,
  ...over,
});
const members = (...ids: string[]) => ids.map((id) => ({ id, phone: null, isAdmin: false }));

describe("computeChatStats", () => {
  it("perDay and perHour use the timezone", () => {
    const stats = computeChatStats(
      [msg("1", "2026-10-30T03:30:00Z", "ana")],
      members("ana"),
      opts({ timezone: "America/Lima" }),
    );
    expect(stats.perDay).toEqual([{ date: "2026-10-29", messages: 1 }]);
    expect(stats.perHour.find((h) => h.hour === 22)?.messages).toBe(1);
  });

  it("midnight in the timezone is hour 0, not 24", () => {
    const stats = computeChatStats(
      [msg("1", "2026-10-30T05:00:00Z", "ana")],
      members("ana"),
      opts({ timezone: "America/Lima" }),
    );
    expect(stats.perHour[0]).toEqual({ hour: 0, messages: 1 });
    expect(stats.perDay[0]?.date).toBe("2026-10-30");
  });

  it("perHour always has 24 entries", () => {
    expect(computeChatStats([], [], opts()).perHour.map((h) => h.hour)).toEqual(
      Array.from({ length: 24 }, (_, i) => i),
    );
    expect(
      computeChatStats([msg("1", "2026-10-30T10:00:00Z", "ana")], members("ana"), opts()).perHour,
    ).toHaveLength(24);
  });

  it("rejects an invalid timezone with an actionable error", () => {
    expect(() => computeChatStats([], [], opts({ timezone: "Mars/Base" }))).toThrow(/timezone/i);
  });

  it("replies graph counts reply author -> replied author", () => {
    const stats = computeChatStats(
      [
        msg("a1", "2026-10-30T10:00:00Z", "ana"),
        msg("b1", "2026-10-30T10:01:00Z", "bob", "text", "a1"),
        msg("b2", "2026-10-30T10:02:00Z", "bob", "text", "a1"),
        msg("a2", "2026-10-30T10:03:00Z", "ana", "text", "b1"),
        msg("c1", "2026-10-30T10:04:00Z", "cy", "text", "not-in-range"),
      ],
      members("ana", "bob", "cy"),
      opts(),
    );
    expect(stats.replies).toEqual([
      { from: "bob", to: "ana", count: 2 },
      { from: "ana", to: "bob", count: 1 },
    ]);
  });

  it("matches replies against bare stanza ids inside WAHA ids", () => {
    const target = msg("false_g1@g.us_ABC123_ana@lid", "2026-10-30T10:00:00Z", "ana");
    const reply = msg("false_g1@g.us_DEF_bob@lid", "2026-10-30T10:01:00Z", "bob", "text", "ABC123");
    const stats = computeChatStats([target, reply], members("ana", "bob"), opts());
    expect(stats.replies).toEqual([{ from: "bob", to: "ana", count: 1 }]);
  });

  it("silentMembers lists participants with zero messages and ignores ex-members", () => {
    const stats = computeChatStats(
      [msg("1", "2026-10-30T10:00:00Z", "ana"), msg("2", "2026-10-30T10:01:00Z", "ex")],
      members("ana", "quiet"),
      opts(),
    );
    expect(stats.silentMembers).toEqual(["quiet"]);
    // the ex-member's messages are still counted and attributed
    expect(stats.perParticipant.map((p) => p.id).sort()).toEqual(["ana", "ex"]);
    expect(stats.totalMessages).toBe(2);
  });

  it("system, deleted and unknown messages count in total but never as text", () => {
    const stats = computeChatStats(
      [
        msg("1", "2026-10-30T10:00:00Z", "ana", "text"),
        msg("2", "2026-10-30T10:01:00Z", "ana", "text"),
        msg("3", "2026-10-30T10:02:00Z", "bob", "image"),
        msg("4", "2026-10-30T10:03:00Z", "bob", "deleted"),
        msg("5", "2026-10-30T10:04:00Z", null, "system"),
        msg("6", "2026-10-30T10:05:00Z", "ana", "unknown"),
      ],
      members("ana", "bob"),
      opts(),
    );
    expect(stats.totalMessages).toBe(6);
    expect(stats.perParticipant).toEqual([
      { id: "ana", name: "ANA", messages: 3, byType: { text: 2, unknown: 1 } },
      { id: "bob", name: "BOB", messages: 2, byType: { image: 1, deleted: 1 } },
    ]);
    expect(stats.perDay).toEqual([{ date: "2026-10-30", messages: 6 }]);
    expect(stats.perHour[10]?.messages).toBe(6);
  });

  it("stats coverage reports empty range explicitly", () => {
    const stats = computeChatStats(
      [],
      members("ana"),
      opts({ requestedFrom: "2026-10-01T00:00:00Z" }),
    );
    expect(stats.totalMessages).toBe(0);
    expect(stats.coverage.note).toContain("No messages returned");
    expect(stats.coverage.firstMessageAt).toBeNull();
    expect(stats.coverage.lastMessageAt).toBeNull();
    expect(stats.coverage.requestedFrom).toBe("2026-10-01T00:00:00Z");
  });

  it("coverage reports first/last message and the cap when truncated", () => {
    const stats = computeChatStats(
      [msg("2", "2026-10-30T10:00:00Z", "ana"), msg("1", "2026-10-29T09:00:00Z", "ana")],
      members("ana"),
      opts({ truncated: true, cap: 2 }),
    );
    expect(stats.coverage.firstMessageAt).toBe("2026-10-29T09:00:00.000Z");
    expect(stats.coverage.lastMessageAt).toBe("2026-10-30T10:00:00.000Z");
    expect(stats.coverage.truncated).toBe(true);
    expect(stats.coverage.note).toContain("STATS_MAX_MESSAGES");
    expect(stats.coverage.note).toContain("2");
  });

  it("direct chats: parties come from the messages and silentMembers is empty", () => {
    const stats = computeChatStats(
      [
        msg("1", "2026-10-30T10:00:00Z", "owner@s.whatsapp.net"),
        msg("2", "2026-10-30T10:01:00Z", "51911111111@c.us"),
        msg("3", "2026-10-30T10:02:00Z", "51911111111@c.us"),
      ],
      members("someone-else"),
      opts({ chatId: "51911111111@c.us" }),
    );
    expect(stats.silentMembers).toEqual([]);
    expect(stats.perParticipant.map((p) => [p.id, p.messages])).toEqual([
      ["51911111111@c.us", 2],
      ["owner@s.whatsapp.net", 1],
    ]);
  });
});

describe("computeChatStats response times", () => {
  const DIRECT = "ana@c.us";
  const dm = (id: string, ts: string, fromMe: boolean, type: MessageType = "text") => ({
    ...msg(id, ts, fromMe ? "owner@c.us" : "ana", type),
    fromMe,
  });
  const run = (messages: NormalizedMessage[], chatId = DIRECT) =>
    computeChatStats(messages, [], opts({ chatId }));

  it("measures replies per party in minutes with median and average", () => {
    const stats = run([
      dm("1", "2026-10-30T10:00:00Z", false),
      dm("2", "2026-10-30T10:10:00Z", true), // me replies in 10
      dm("3", "2026-10-30T10:20:00Z", false),
      dm("4", "2026-10-30T10:50:00Z", true), // me replies in 30
      dm("5", "2026-10-30T11:00:00Z", false), // follow-up of the same turn is not a reply
      dm("6", "2026-10-30T11:05:00Z", false),
      dm("7", "2026-10-30T11:15:00Z", true), // me replies in 10 after the last ana message (10)
    ]);
    const me = stats.responseTimes.find((r) => r.party === "me");
    expect(me).toEqual({ party: "me", replies: 3, medianMinutes: 10, averageMinutes: 16.7 });
    const ana = stats.responseTimes.find((r) => r.party === "ANA");
    expect(ana).toEqual({ party: "ANA", replies: 2, medianMinutes: 10, averageMinutes: 10 });
    expect(stats.coverage.ignoredGaps).toBe(0);
  });

  it("ignores gaps over 72 h and counts them in coverage", () => {
    const stats = run([
      dm("1", "2026-10-25T10:00:00Z", false),
      dm("2", "2026-10-29T10:00:00Z", true), // 4 days: ignored
      dm("3", "2026-10-29T10:30:00Z", false),
      dm("4", "2026-10-29T10:45:00Z", true), // 15 min
    ]);
    const me = stats.responseTimes.find((r) => r.party === "me");
    expect(me).toMatchObject({ replies: 1, medianMinutes: 15, averageMinutes: 15 });
    expect(stats.responseTimes.find((r) => r.party === "ANA")).toMatchObject({ replies: 1 });
    expect(stats.coverage.ignoredGaps).toBe(1);
    expect(stats.coverage.note).toContain("1 gap");
  });

  it("handles a group with three parties and skips non-conversational messages", () => {
    const stats = run(
      [
        msg("1", "2026-10-30T10:00:00Z", "ana"),
        msg("2", "2026-10-30T10:05:00Z", "system-user", "system"),
        msg("3", "2026-10-30T10:10:00Z", "bob"),
        msg("4", "2026-10-30T10:30:00Z", "cy"),
        msg("5", "2026-10-30T10:31:00Z", "ana", "deleted"),
        msg("6", "2026-10-30T11:00:00Z", "ana"),
      ],
      GROUP,
    );
    const by = Object.fromEntries(stats.responseTimes.map((r) => [r.party, r]));
    expect(by.BOB).toMatchObject({ replies: 1, medianMinutes: 10 });
    expect(by.CY).toMatchObject({ replies: 1, medianMinutes: 20 });
    expect(by.ANA).toMatchObject({ replies: 1, medianMinutes: 30 });
    expect(by["SYSTEM-USER"]).toBeUndefined();
  });

  it("reports null median and average for a party that never replied", () => {
    const stats = run([dm("1", "2026-10-30T10:00:00Z", false)]);
    expect(stats.responseTimes).toEqual([
      { party: "ANA", replies: 0, medianMinutes: null, averageMinutes: null },
    ]);
  });

  it("counts own replies when fromMe messages have no author id", () => {
    const own = (id: string, ts: string) => ({
      ...dm(id, ts, true),
      author: { id: "", phone: null, name: null },
    });
    const stats = run([
      dm("1", "2026-10-30T10:00:00Z", false),
      own("2", "2026-10-30T10:10:00Z"),
      dm("3", "2026-10-30T10:20:00Z", false),
      own("4", "2026-10-30T10:50:00Z"),
    ]);
    expect(stats.responseTimes.find((r) => r.party === "me")).toMatchObject({
      replies: 2,
      medianMinutes: 20,
    });
  });

  it("returns no response times for an empty chat", () => {
    const stats = run([]);
    expect(stats.responseTimes).toEqual([]);
    expect(stats.coverage.ignoredGaps).toBe(0);
  });
});
