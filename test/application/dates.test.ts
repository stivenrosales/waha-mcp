import { describe, expect, it } from "vitest";
import { parseRange, parseRangeBound } from "../../src/application/dates.js";
import { buildActivityDigest } from "../../src/application/digest.js";
import { listSharedFiles } from "../../src/application/files.js";
import { fetchRange, getMessages } from "../../src/application/messages.js";
import { findPendingReplies } from "../../src/application/pending.js";
import { searchMessages } from "../../src/application/search.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { gowsMapper } from "../../src/infrastructure/waha/engines/gows.js";
import { InMemoryWahaGateway } from "../fakes/InMemoryWahaGateway.js";
import { ANA, chat, gateway, msg } from "./helpers.js";

const LIMA = "America/Lima"; // UTC-5, no DST
const iso = (ms: number) => new Date(ms).toISOString();

describe("parseRangeBound", () => {
  it("reads a bare date as the local day: start = midnight, end = last second", () => {
    expect(iso(parseRangeBound("2026-10-01", LIMA, "start"))).toBe("2026-10-01T05:00:00.000Z");
    expect(iso(parseRangeBound("2026-10-01", LIMA, "end"))).toBe("2026-10-02T04:59:59.000Z");
    expect(iso(parseRangeBound("2026-10-01", "UTC", "end"))).toBe("2026-10-01T23:59:59.000Z");
  });

  it("reads a date-time without offset in the timezone", () => {
    expect(iso(parseRangeBound("2026-10-01T08:30:00", LIMA, "start"))).toBe(
      "2026-10-01T13:30:00.000Z",
    );
    expect(iso(parseRangeBound("2026-10-01 08:30", LIMA, "end"))).toBe("2026-10-01T13:30:00.000Z");
  });

  it("leaves Z and offset date-times untouched", () => {
    expect(iso(parseRangeBound("2026-10-01T08:00:00Z", LIMA, "start"))).toBe(
      "2026-10-01T08:00:00.000Z",
    );
    expect(iso(parseRangeBound("2026-10-01T08:00:00-05:00", "Asia/Tokyo", "end"))).toBe(
      "2026-10-01T13:00:00.000Z",
    );
  });

  it("rejects invalid values", () => {
    for (const bad of ["nope", "2026-02-30", "2026-13-01", "2026-10-01T25:00:00", "Oct 1 2026"])
      expect(() => parseRangeBound(bad, LIMA, "start")).toThrow(InvalidInputError);
  });

  it("rejects from after to, and accepts from = to for a bare day", () => {
    expect(() => parseRange({ from: "2026-10-02", to: "2026-10-01" }, LIMA)).toThrow(
      /"from" must not be later than "to"/,
    );
    const r = parseRange({ from: "2026-10-01", to: "2026-10-01" }, LIMA);
    expect((r.to as number) - (r.from as number)).toBe(86_399_000);
  });
});

describe("range bounds across the date tools (TIMEZONE = Lima)", () => {
  // Lima 2026-10-01 = 2026-10-01T05:00:00Z .. 2026-10-02T04:59:59Z
  const sec = (s: string) => Date.parse(s) / 1000;
  const INSIDE = sec("2026-10-02T03:00:00Z"); // 22:00 on the 1st in Lima
  const BEFORE = sec("2026-10-01T04:00:00Z"); // 23:00 on Sept 30 in Lima
  const NOW = Date.parse("2026-10-05T12:00:00Z");

  const data = () => ({
    chats: [chat(ANA, INSIDE, "Ana")],
    messages: {
      [ANA]: [
        msg("in", INSIDE, "factura https://example.com/x", { chat: ANA }),
        msg("out", BEFORE, "factura vieja", { chat: ANA }),
      ],
    },
  });

  it("getMessages sends the local day window to WAHA", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [ANA]: [] } });
    await getMessages(gw, gowsMapper, {
      chatId: ANA,
      from: "2026-10-01",
      to: "2026-10-01",
      timezone: LIMA,
    });
    expect(gw.calls[0]?.args[1]).toMatchObject({
      from: sec("2026-10-01T05:00:00Z"),
      to: sec("2026-10-02T04:59:59Z"),
    });
  });

  it("getMessages and fetchRange reject from after to", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [ANA]: [] } });
    await expect(
      getMessages(gw, gowsMapper, { chatId: ANA, from: "2026-10-02", to: "2026-10-01" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      fetchRange(gw, gowsMapper, { chatId: ANA, from: "2026-10-02", to: "2026-10-01", cap: 5 }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("fetchRange (chat stats) reads the day in the timezone", async () => {
    const gw = new InMemoryWahaGateway({ messages: { [ANA]: [] } });
    await fetchRange(gw, gowsMapper, {
      chatId: ANA,
      from: "2026-10-01",
      to: "2026-10-01",
      cap: 5,
      timezone: LIMA,
    });
    expect(gw.calls[0]?.args[1]).toMatchObject({
      from: sec("2026-10-01T05:00:00Z"),
      to: sec("2026-10-02T04:59:59Z"),
    });
  });

  it("searchMessages and listSharedFiles include the evening of the local day only", async () => {
    const deps = { now: () => NOW, statsMaxMessages: 5000, timezone: LIMA };
    const q = { scope: "direct" as const, from: "2026-10-01", to: "2026-10-01" };
    const s = await searchMessages(gateway(data()), gowsMapper, { query: "factura", ...q }, deps);
    expect(s.hits.map((h) => h.message.text)).toEqual(["factura https://example.com/x"]);
    expect(s.from).toBe("2026-10-01T05:00:00.000Z");
    const f = await listSharedFiles(gateway(data()), gowsMapper, { ...q, kind: "link" }, deps);
    expect(f.items.length).toBe(1);
  });

  it("findPendingReplies reads a bare since as local midnight", async () => {
    const r = await findPendingReplies(
      gateway(data()),
      gowsMapper,
      { since: "2026-10-01" },
      { now: () => NOW, statsMaxMessages: 5000, timezone: LIMA },
    );
    expect(r.since).toBe("2026-10-01T05:00:00.000Z");
  });

  it("buildActivityDigest honours the timezone for bare from/to", async () => {
    const r = await buildActivityDigest(
      gateway(data()),
      gowsMapper,
      { from: "2026-10-01", to: "2026-10-01", timezone: LIMA },
      { now: () => NOW, statsMaxMessages: 5000 },
    );
    expect(r.from).toBe("2026-10-01T05:00:00.000Z");
    expect(r.to).toBe("2026-10-02T04:59:59.000Z");
    expect(r.chats[0]?.messageCount).toBe(1);
  });
});
