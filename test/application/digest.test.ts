import { describe, expect, it } from "vitest";
import { buildActivityDigest } from "../../src/application/digest.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import type { InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";
import { ANA, BOB, chat, GROUP_A, gateway, ME_LID, msg, systemMsg } from "./helpers.js";

const NOW = Date.parse("2026-10-30T15:00:00Z");
const deps = { now: () => NOW, statsMaxMessages: 5000 };
const run = (gw: InMemoryWahaGateway, q: Parameters<typeof buildActivityDigest>[2] = {}) =>
  buildActivityDigest(gw, gowsMapper, { timezone: "America/Lima", ...q }, deps);
const sec = (iso: string) => Date.parse(iso) / 1000;

// Lima is UTC-5: 2026-10-29 in Lima = 2026-10-29T05:00:00Z .. 2026-10-30T04:59:59Z.
const T_BEFORE = sec("2026-10-29T04:59:00Z"); // 28th 23:59 Lima
const T_START = sec("2026-10-29T05:00:00Z"); // 29th 00:00 Lima
const T_LATE = sec("2026-10-30T03:30:00Z"); // 29th 22:30 Lima
const T_NEXT = sec("2026-10-30T05:00:00Z"); // 30th 00:00 Lima

describe("buildActivityDigest", () => {
  const data = () => ({
    chats: [chat(ANA, T_NEXT, "Ana"), chat(BOB, T_LATE)],
    messages: {
      [ANA]: [
        msg("5", T_NEXT, "ya es otro día", { chat: ANA }),
        msg("4", T_LATE, "buenas noches", { chat: ANA }),
        msg("3", T_START, "primero del día", { chat: ANA, mine: true }),
        msg("2", T_BEFORE, "ayer tarde", { chat: ANA }),
      ],
      [BOB]: [
        msg("2", T_LATE, "gracias", { chat: BOB, mine: true }),
        msg("1", T_START + 60, "pregunta", { chat: BOB }),
      ],
    },
  });

  it("buckets a date in the requested timezone, not UTC", async () => {
    const gw = gateway(data());
    const r = await run(gw, { date: "2026-10-29" });
    expect(r.from).toBe("2026-10-29T05:00:00.000Z");
    expect(r.to).toBe("2026-10-30T04:59:59.000Z");
    const ana = r.chats.find((c) => c.chatId === ANA);
    expect(ana?.messageCount).toBe(2);
    expect(ana?.messages.map((m) => m.text)).toEqual(["primero del día", "buenas noches"]);
    // The same instants bucketed in UTC land in a different day.
    const utc = await run(gateway(data()), { date: "2026-10-29", timezone: "UTC" });
    expect(utc.chats.find((c) => c.chatId === ANA)?.messages.map((m) => m.text)).toEqual([
      "ayer tarde",
      "primero del día",
    ]);
  });

  it("reports per chat: count, lastFrom, awaitingReply, messages oldest to newest", async () => {
    const r = await run(gateway(data()), { date: "2026-10-29" });
    const ana = r.chats.find((c) => c.chatId === ANA);
    expect(ana).toMatchObject({
      name: "Ana",
      isGroup: false,
      lastFrom: expect.any(String),
      awaitingReply: true,
    });
    expect(ana?.lastFrom).not.toBe("me");
    const bob = r.chats.find((c) => c.chatId === BOB);
    expect(bob).toMatchObject({ messageCount: 2, lastFrom: "me", awaitingReply: false });
  });

  it("only lists chats active in the range and skips them without a fetch when idle", async () => {
    const gw = gateway({
      chats: [chat(ANA, T_BEFORE)],
      messages: { [ANA]: [msg("1", T_BEFORE, "ayer", { chat: ANA })] },
    });
    const r = await run(gw, { date: "2026-10-29" });
    expect(r.chats).toEqual([]);
    expect(r.coverage.chatsScanned).toBe(0);
    expect(gw.count("getMessages")).toBe(0);
  });

  it("ignores system messages and chats with only system messages", async () => {
    const gw = gateway({
      chats: [chat(ANA, T_LATE), chat(BOB, T_LATE)],
      messages: {
        [ANA]: [systemMsg("s", T_LATE, ANA), msg("1", T_START, "hola", { chat: ANA, mine: true })],
        [BOB]: [systemMsg("s", T_LATE, BOB)],
      },
    });
    const r = await run(gw, { date: "2026-10-29" });
    expect(r.chats.map((c) => c.chatId)).toEqual([ANA]);
    expect(r.chats[0]).toMatchObject({ messageCount: 1, awaitingReply: false, lastFrom: "me" });
  });

  it("caps messages at 30 (the newest, oldest first) and reports how many were left out", async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      msg(String(45 - i), T_START + (45 - i) * 60, `m${45 - i}`, { chat: ANA }),
    );
    const gw = gateway({ chats: [chat(ANA, T_LATE)], messages: { [ANA]: many } });
    const [c] = (await run(gw, { date: "2026-10-29" })).chats;
    expect(c?.messageCount).toBe(45);
    expect(c?.messages).toHaveLength(30);
    expect(c?.messages[0]?.text).toBe("m16");
    expect(c?.messages.at(-1)?.text).toBe("m45");
    expect(c?.messagesOmitted).toBe(15);
  });

  it("groups: scope filters, and awaitingReply follows the mention rule", async () => {
    const gw = gateway({
      chats: [chat(ANA, T_LATE), chat(GROUP_A, T_LATE, "Team")],
      messages: {
        [ANA]: [msg("1", T_START, "hola", { chat: ANA })],
        [GROUP_A]: [
          msg("2", T_LATE, "@yo", { chat: GROUP_A, from: "9@lid", mention: [ME_LID] }),
          msg("1", T_START, "ruido", { chat: GROUP_A, from: "8@lid" }),
        ],
      },
    });
    expect((await run(gw, { date: "2026-10-29" })).chats.map((c) => c.chatId)).toEqual([ANA]);
    const groups = await run(gw, { date: "2026-10-29", scope: "groups" });
    expect(groups.chats).toHaveLength(1);
    expect(groups.chats[0]).toMatchObject({ chatId: GROUP_A, isGroup: true, awaitingReply: true });
    const all = await run(gw, { date: "2026-10-29", scope: "all" });
    expect(all.chats.map((c) => c.chatId).sort()).toEqual([ANA, GROUP_A].sort());
  });

  it("accepts an explicit from/to instead of a date", async () => {
    const r = await run(gateway(data()), {
      from: "2026-10-29T05:00:00Z",
      to: "2026-10-29T06:00:00Z",
    });
    expect(r.from).toBe("2026-10-29T05:00:00.000Z");
    expect(r.chats.map((c) => c.chatId).sort()).toEqual([ANA, BOB].sort());
  });

  it("defaults to today in the timezone", async () => {
    const r = await run(gateway({}));
    // 2026-10-30T15:00Z is 10:00 on the 30th in Lima.
    expect(r.from).toBe("2026-10-30T05:00:00.000Z");
  });

  it("rejects bad input", async () => {
    const gw = gateway({});
    await expect(run(gw, { date: "30/10/2026" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { date: "2026-02-31" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { timezone: "Mars/Base" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      run(gw, { date: "2026-10-29", from: "2026-10-29T00:00:00Z" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { from: "nope" })).rejects.toBeInstanceOf(InvalidInputError);
  });
});
