import { describe, expect, it } from "vitest";
import { createCachedGateway } from "../../src/application/cachedMessages.js";
import { fetchRange, getMessages } from "../../src/application/messages.js";
import type { WahaGateway } from "../../src/domain/ports/WahaGateway.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../src/infrastructure/cache/sqliteMessageStore.js";
import { getEngineMapper } from "../../src/infrastructure/waha/engines/index.js";
import { InMemoryWahaGateway, rawReaction, rawText } from "../fakes/InMemoryWahaGateway.js";

const m = getEngineMapper("GOWS");
const CHAT = "100000000000009@g.us";
const HOUR = 3600;
/** Newest message second; the clock starts a minute later. */
const NEWEST = 1_800_000_000;

type Raw = Record<string, unknown>;

/** `n` messages, newest first, one every `step` seconds ending at NEWEST; ids M{n}..M1. */
function history(n: number, step = 60): Raw[] {
  return Array.from({ length: n }, (_, i) => {
    const k = n - i;
    return rawText(`M${k}`, NEWEST - (n - k) * step, `msg ${k}`, { name: "Ana" });
  });
}

const iso = (unixS: number) => new Date(unixS * 1000).toISOString();

function setup(
  messages: Raw[],
  o: { maxAgeDays?: number; backfillMaxPages?: number; refreshHours?: number } = {},
) {
  const data = { messages: { [CHAT]: messages } };
  const waha = new InMemoryWahaGateway(data);
  const store = createSqliteMessageStore(openCacheDatabase(":memory:"));
  let t = (NEWEST + 60) * 1000;
  const gw = createCachedGateway(waha, store, {
    refreshHours: o.refreshHours ?? 48,
    maxAgeDays: o.maxAgeDays ?? 0,
    backfillMaxPages: o.backfillMaxPages,
    now: () => t,
  });
  const wahaCalls = () =>
    waha.calls
      .filter((c) => c.method === "getMessages")
      .map((c) => c.args[1] as { limit: number; offset: number; from?: number; to?: number });
  return {
    waha,
    gw,
    store,
    data,
    wahaCalls,
    advance: (seconds: number) => {
      t += seconds * 1000;
    },
  };
}

describe("cached gateway", () => {
  it("answers a second read of the same range from SQLite within 60 s", async () => {
    const s = setup(history(30));
    const first = await fetchRange(s.gw, m, { chatId: CHAT, cap: 100 });
    const calls = s.wahaCalls().length;
    expect(calls).toBeGreaterThan(0);
    s.advance(59);
    const second = await fetchRange(s.gw, m, { chatId: CHAT, cap: 100 });
    expect(s.wahaCalls()).toHaveLength(calls);
    expect(second).toEqual(first);
    expect(second.messages).toHaveLength(30);
  });

  it("after 60 s fetches only the refresh window (newest − CACHE_REFRESH_HOURS)", async () => {
    const s = setup(history(30));
    await fetchRange(s.gw, m, { chatId: CHAT, cap: 100 });
    const before = s.wahaCalls().length;
    s.advance(61);
    await fetchRange(s.gw, m, { chatId: CHAT, cap: 100 });
    const refresh = s.wahaCalls().slice(before);
    expect(refresh).toEqual([{ limit: 200, offset: 0, from: NEWEST - 48 * HOUR }]);
  });

  it("picks up a new message, an edit and a revoke inside the refresh window", async () => {
    const s = setup(history(5));
    await fetchRange(s.gw, m, { chatId: CHAT, cap: 100 });
    const list = s.data.messages[CHAT] as Raw[];
    const edited = rawText("M5", NEWEST, "fixed", { name: "Ana" });
    edited._data = {
      ...(edited._data as Raw),
      Message: { editedMessage: { message: { conversation: "fixed" } } },
    };
    list[0] = edited;
    const revoked = rawText("M4", NEWEST - 60, "", { name: "Ana" });
    revoked._data = {
      ...(revoked._data as Raw),
      Message: { protocolMessage: { type: "REVOKE", key: { ID: "M4" } } },
    };
    list[1] = revoked;
    list.unshift(rawText("M6", NEWEST + 30, "new one", { name: "Ana" }));
    s.advance(61);
    const { messages } = await fetchRange(s.gw, m, { chatId: CHAT, cap: 100 });
    expect(messages.map((x) => x.text)).toEqual([
      "new one",
      "fixed",
      null,
      "msg 3",
      "msg 2",
      "msg 1",
    ]);
    expect(messages[2]?.type).toBe("deleted");
  });

  it("a never-synced chat without `from` returns the newest messages with one WAHA page", async () => {
    const s = setup(history(500));
    const page = await getMessages(s.gw, m, { chatId: CHAT, limit: 3 });
    expect(page.messages.map((x) => x.text)).toEqual(["msg 500", "msg 499", "msg 498"]);
    expect(s.wahaCalls()).toEqual([{ limit: 200, offset: 0 }]);
  });

  it("an older range than cached triggers one bounded backfill, then is served from SQLite", async () => {
    const s = setup(history(500));
    await getMessages(s.gw, m, { chatId: CHAT, limit: 3 }); // caches the newest 200
    const cachedOldest = NEWEST - 199 * 60 + 1; // covered bound: the page edge second is re-read
    const from = NEWEST - 250 * 60;
    const before = s.wahaCalls().length;
    const r = await fetchRange(s.gw, m, { chatId: CHAT, from: iso(from), cap: 1000 });
    expect(r.messages).toHaveLength(251);
    expect(r.truncated).toBe(false);
    // Only the gap between the requested `from` and what was cached is read from WAHA.
    expect(s.wahaCalls().slice(before)).toEqual([
      { limit: 200, offset: 0, from, to: cachedOldest - 1 },
    ]);
    const again = s.wahaCalls().length;
    await fetchRange(s.gw, m, { chatId: CHAT, from: iso(from), cap: 1000 });
    expect(s.wahaCalls()).toHaveLength(again);
  });

  it("never downloads more than the backfill budget for one call and falls back to WAHA", async () => {
    const s = setup(history(1000), { backfillMaxPages: 2 });
    await getMessages(s.gw, m, { chatId: CHAT, limit: 3 }); // 1 page cached
    const before = s.wahaCalls().length;
    const direct = await fetchRange(new InMemoryWahaGateway(s.data), m, {
      chatId: CHAT,
      to: iso(NEWEST - 900 * 60),
      cap: 50,
    });
    const r = await fetchRange(s.gw, m, { chatId: CHAT, to: iso(NEWEST - 900 * 60), cap: 50 });
    expect(r).toEqual({ messages: direct.messages, truncated: direct.truncated });
    // Two backfill pages (the budget) extend the cache downwards; the request itself then
    // goes straight to WAHA instead of downloading the whole gap.
    const upper = NEWEST - 199 * 60;
    expect(s.wahaCalls().slice(before)).toEqual([
      { limit: 200, offset: 0, to: upper },
      { limit: 200, offset: 200, to: upper },
      { limit: 200, offset: 0, to: NEWEST - 900 * 60 },
    ]);
    expect(r.cacheNote).toBeUndefined();
  });

  it("serializes concurrent reads of one chat: two calls, one WAHA fetch", async () => {
    const s = setup(history(30));
    const [a, b] = await Promise.all([
      fetchRange(s.gw, m, { chatId: CHAT, cap: 100 }),
      fetchRange(s.gw, m, { chatId: CHAT, cap: 100 }),
    ]);
    expect(a).toEqual(b);
    expect(s.wahaCalls()).toHaveLength(1);
  });

  it("prunes rows older than CACHE_MAX_AGE_DAYS on startup and at most once per hour", async () => {
    const s = setup(history(10, 24 * HOUR), { maxAgeDays: 3 });
    await fetchRange(s.gw, m, { chatId: CHAT, cap: 100 });
    // Rows were stored after the startup prune; the next prune is due an hour later.
    expect(s.store.countRange(CHAT, {})).toBe(10);
    s.advance(30 * 60);
    await fetchRange(s.gw, m, { chatId: CHAT, cap: 100 });
    expect(s.store.countRange(CHAT, {})).toBe(10);
    s.advance(31 * 60);
    await getMessages(s.gw, m, { chatId: CHAT, limit: 1 });
    // now = NEWEST + 61 min + 60 s; 3 days back keeps M10..M8 (0, 1, 2 days old)
    expect(s.store.countRange(CHAT, {})).toBe(3);
  });

  it("matches the uncached results for paging, cursors, ranges, caps and reactions", async () => {
    const raws: Raw[] = [];
    for (let k = 450; k >= 1; k--) {
      if (k % 50 === 0) raws.push(rawReaction(`R${k}`, NEWEST - (450 - k) * 60, `M${k - 1}`, "👍"));
      raws.push(rawText(`M${k}`, NEWEST - (450 - k) * 60, `msg ${k}`, { name: "Ana" }));
    }
    const plain = new InMemoryWahaGateway({ messages: { [CHAT]: raws } });
    const s = setup(raws);
    const scenarios = [
      (g: WahaGateway) => fetchRange(g, m, { chatId: CHAT, cap: 120 }),
      (g: WahaGateway) => fetchRange(g, m, { chatId: CHAT, cap: 5000 }),
      (g: WahaGateway) =>
        fetchRange(g, m, {
          chatId: CHAT,
          from: iso(NEWEST - 300 * 60),
          to: iso(NEWEST - 100 * 60),
          cap: 5000,
        }),
      async (g: WahaGateway) => {
        const p1 = await getMessages(g, m, { chatId: CHAT, limit: 199 });
        const p2 = await getMessages(g, m, {
          chatId: CHAT,
          limit: 199,
          cursor: p1.nextCursor as string,
        });
        const p3 = await getMessages(g, m, {
          chatId: CHAT,
          limit: 199,
          cursor: p2.nextCursor as string,
        });
        return [p1, p2, p3].map((p) => ({ messages: p.messages, nextCursor: p.nextCursor }));
      },
    ];
    for (const run of scenarios) {
      const expected = await run(plain);
      const actual = await run(s.gw);
      const strip = (v: unknown) =>
        JSON.parse(JSON.stringify(v, (k, x) => (k === "cacheNote" ? undefined : x)));
      expect(strip(actual)).toEqual(strip(expected));
    }
  });

  it("adds a cache note only when the data came from the cache", async () => {
    const plain = new InMemoryWahaGateway({ messages: { [CHAT]: history(3) } });
    expect(await getMessages(plain, m, { chatId: CHAT })).not.toHaveProperty("cacheNote");
    const s = setup(history(3));
    const page = await getMessages(s.gw, m, { chatId: CHAT });
    expect(page.cacheNote).toMatch(/local message cache/);
    const range = await fetchRange(s.gw, m, { chatId: CHAT, cap: 10 });
    expect(range.cacheNote).toMatch(/local message cache/);
  });

  it("delegates every other gateway method", async () => {
    const s = setup(history(1));
    expect(await s.gw.getSession()).toEqual({ engine: "GOWS", status: "WORKING" });
    expect(s.waha.count("getSession")).toBe(1);
  });
});
