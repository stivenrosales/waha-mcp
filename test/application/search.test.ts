import { describe, expect, it } from "vitest";
import { searchMessages } from "../../src/application/search.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import type { InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";
import { ANA, BOB, chat, GROUP_A, gateway, msg } from "./helpers.js";

const NOW = Date.parse("2026-10-30T15:00:00Z");
const nowSec = NOW / 1000;
const DAY = 86_400;
const deps = { now: () => NOW, statsMaxMessages: 5000 };
const run = (gw: InMemoryWahaGateway, q: Partial<Parameters<typeof searchMessages>[2]> = {}) =>
  searchMessages(gw, gowsMapper, { query: "factura", scope: "direct", ...q }, deps);

describe("searchMessages", () => {
  const data = () => ({
    chats: [chat(ANA, nowSec - 100, "Ana"), chat(BOB, nowSec - 200, "Bob")],
    messages: {
      [ANA]: [
        msg("a2", nowSec - 100, "Te envío la FACTURA mañana", { chat: ANA, mine: true }),
        msg("a1", nowSec - 5 * DAY, "hola", { chat: ANA }),
      ],
      [BOB]: [
        msg("b2", nowSec - 200, "ok", { chat: BOB }),
        msg("b1", nowSec - 3 * DAY, "la facturación está lista", { chat: BOB }),
        msg("b0", nowSec - 40 * DAY, "factura vieja", { chat: BOB }),
      ],
    },
  });

  it("matches case-insensitively, newest first, and centers the snippet on the match", async () => {
    const r = await run(gateway(data()));
    expect(r.hits.map((h) => h.chatId)).toEqual([ANA, BOB]);
    expect(r.hits[0]).toMatchObject({
      chatName: "Ana",
      message: { text: "Te envío la FACTURA mañana", from: "me" },
    });
    expect(r.hits[0]?.snippet).toBe("Te envío la FACTURA mañana");
    expect(r.totalMatches).toBe(2);
  });

  it("is accent-insensitive in both directions", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 10)],
      messages: {
        [ANA]: [
          msg("2", nowSec - 10, "reunión de CAFÉ", { chat: ANA }),
          msg("1", nowSec - 20, "cafe y reunion", { chat: ANA }),
        ],
      },
    });
    expect((await run(gw, { query: "reunion" })).hits).toHaveLength(2);
    expect((await run(gw, { query: "CAFÉ" })).hits).toHaveLength(2);
  });

  it("matches captions and filenames", async () => {
    const base = msg("1", nowSec - 10, "x", { chat: ANA });
    const withMedia = {
      ...base,
      body: "Informe trimestral",
      hasMedia: true,
      _data: {
        ...(base._data as Record<string, unknown>),
        Message: {
          documentMessage: {
            caption: "Informe trimestral",
            fileName: "Balance-Enero.pdf",
            mimetype: "application/pdf",
          },
        },
      },
    };
    const gw = gateway({ chats: [chat(ANA, nowSec - 10)], messages: { [ANA]: [withMedia] } });
    expect((await run(gw, { query: "trimestral" })).hits).toHaveLength(1);
    const byName = await run(gw, { query: "balance-enero" });
    expect(byName.hits).toHaveLength(1);
    expect(byName.hits[0]?.snippet).toContain("Balance-Enero.pdf");
  });

  it("defaults to the last 30 days and honours from/to", async () => {
    const gw = gateway(data());
    expect((await run(gw)).hits.some((h) => h.message.id.includes("b0"))).toBe(false);
    const wide = await run(gw, { from: new Date((nowSec - 60 * DAY) * 1000).toISOString() });
    expect(wide.hits).toHaveLength(3);
    const narrow = await run(gw, { to: new Date((nowSec - 2 * DAY) * 1000).toISOString() });
    expect(narrow.hits.map((h) => h.chatId)).toEqual([BOB]);
  });

  it("scope picks the chats: direct by default, groups and all on request", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 10), chat(GROUP_A, nowSec - 10, "Equipo")],
      messages: {
        [ANA]: [msg("1", nowSec - 10, "factura directa", { chat: ANA })],
        [GROUP_A]: [msg("2", nowSec - 10, "factura grupal", { chat: GROUP_A })],
      },
    });
    expect((await run(gw)).hits.map((h) => h.chatId)).toEqual([ANA]);
    const groups = await run(gw, { scope: "groups" });
    expect(groups.hits.map((h) => h.chatId)).toEqual([GROUP_A]);
    expect(groups.hits[0]).toMatchObject({ chatName: "Equipo", isGroup: true });
    expect((await run(gw, { scope: "all" })).hits).toHaveLength(2);
  });

  it("chatId searches that single chat of any type, ignoring scope", async () => {
    const gw = gateway({
      chats: [chat(ANA, nowSec - 10), chat(GROUP_A, nowSec - 10, "Equipo")],
      messages: {
        [ANA]: [msg("1", nowSec - 10, "factura directa", { chat: ANA })],
        [GROUP_A]: [msg("2", nowSec - 10, "factura grupal", { chat: GROUP_A })],
      },
    });
    const r = await run(gw, { chatId: GROUP_A });
    expect(r.hits.map((h) => h.chatId)).toEqual([GROUP_A]);
    expect(r.hits[0]?.chatName).toBe("Equipo");
    expect(r.coverage).toMatchObject({ chatsScanned: 1, truncated: false });
  });

  it("limit caps the hits but totalMatches keeps the real count", async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg(`m${i}`, nowSec - i - 1, `factura ${i}`, { chat: ANA }),
    );
    const gw = gateway({ chats: [chat(ANA, nowSec)], messages: { [ANA]: messages } });
    const r = await run(gw, { limit: 3 });
    expect(r.hits).toHaveLength(3);
    expect(r.totalMatches).toBe(10);
    expect(r.coverage.notes.join(" ")).toContain("3 of 10");
  });

  it("cuts snippets to 280 chars around the first match, with ellipses", async () => {
    const long = `${"a".repeat(500)} factura ${"b".repeat(500)}`;
    const gw = gateway({
      chats: [chat(ANA, nowSec)],
      messages: { [ANA]: [msg("1", nowSec - 1, long, { chat: ANA })] },
    });
    const snippet = (await run(gw)).hits[0]?.snippet ?? "";
    expect(Array.from(snippet).length).toBeLessThanOrEqual(280);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("factura");
    expect(Array.from(snippet).length).toBeGreaterThan(200);
  });

  it("snippets stay correct after emoji before the match", async () => {
    const text = `${"😀 ".repeat(60)}${"x".repeat(200)} factura`;
    const gw = gateway({
      chats: [chat(ANA, nowSec)],
      messages: { [ANA]: [msg("1", nowSec - 1, text, { chat: ANA })] },
    });
    const snippet = (await run(gw)).hits[0]?.snippet ?? "";
    expect(snippet).toContain("factura");
    expect(Array.from(snippet).length).toBeLessThanOrEqual(280);
    expect(snippet).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    const accent = gateway({
      chats: [chat(ANA, nowSec)],
      messages: { [ANA]: [msg("1", nowSec - 1, "feliz año nuevo", { chat: ANA })] },
    });
    expect((await run(accent, { query: "ANO" })).hits).toHaveLength(1);
  });

  it("a failing chat goes to coverage.failedChats and is not fatal", async () => {
    const gw = gateway(data());
    const orig = gw.getMessages.bind(gw);
    gw.getMessages = async (id, q) => {
      if (id === BOB) throw new Error("boom");
      return orig(id, q);
    };
    const r = await run(gw);
    expect(r.hits.map((h) => h.chatId)).toEqual([ANA]);
    expect(r.coverage.failedChats).toEqual([BOB]);
    expect(r.coverage.truncated).toBe(true);
  });

  it("validates the query (2..200 chars after trim), limit and dates", async () => {
    const gw = gateway(data());
    for (const query of ["a", "  a  ", "   ", "x".repeat(201)])
      await expect(run(gw, { query })).rejects.toBeInstanceOf(InvalidInputError);
    expect((await run(gw, { query: "  fa  " })).hits).toBeDefined();
    await expect(run(gw, { limit: 0 })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { limit: 201 })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { from: "ayer" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(run(gw, { to: "mañana" })).rejects.toBeInstanceOf(InvalidInputError);
  });
});
