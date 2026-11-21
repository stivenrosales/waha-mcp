import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  type CacheEventPort,
  cacheEffectOf,
  createCacheEventProcessor,
} from "../../src/application/cacheEvents.js";
import { createMessageActions } from "../../src/application/messageActions.js";
import type { StoredEvent, WebhookEventKind } from "../../src/domain/ports/EventStore.js";
import { createSqliteMessageActionStore } from "../../src/infrastructure/cache/sqliteMessageActionStore.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../../src/infrastructure/cache/sqliteTranscriptStore.js";
import { createSqliteEventStore } from "../../src/infrastructure/missions/sqliteEventStore.js";
import { getEngineMapper } from "../../src/infrastructure/waha/engines/index.js";
import { rawText } from "../fakes/InMemoryWahaGateway.js";
import { testCipher } from "../fakes/testCipher.js";

const m = getEngineMapper("GOWS");
const TENANT = "t1";
const RECEIVED = 1_000_000;

describe("cacheEffectOf", () => {
  it("edited: bare id, new body, the payload's own time", () => {
    expect(
      cacheEffectOf(
        "message.edited",
        { id: "ACT", timestamp: 1234, editedMessageId: "3EB0AA", body: "new text" },
        RECEIVED,
      ),
    ).toEqual({ kind: "edit", shortId: "3EB0AA", text: "new text", at: 1234 });
  });

  it("edited without a payload time uses the received time", () => {
    expect(
      cacheEffectOf("message.edited", { editedMessageId: "3EB0AA", body: "x" }, RECEIVED),
    ).toMatchObject({ at: RECEIVED });
  });

  it("missing editedMessageId → null", () => {
    expect(cacheEffectOf("message.edited", { body: "x" }, RECEIVED)).toBeNull();
  });

  it("revoked: bare id", () => {
    expect(
      cacheEffectOf("message.revoked", { revokedMessageId: "3EB0BB", before: null }, RECEIVED),
    ).toEqual({ kind: "revoke", shortId: "3EB0BB", at: RECEIVED });
  });

  it("reaction: short id from the full id, emoji, reactor", () => {
    expect(
      cacheEffectOf(
        "message.reaction",
        {
          timestamp: 50,
          fromMe: false,
          from: "51911@c.us",
          participant: "999@lid",
          reaction: { text: "👍", messageId: "true_51911@c.us_3EB0CC" },
        },
        RECEIVED,
      ),
    ).toEqual({
      kind: "reaction",
      reaction: { messageId: "3EB0CC", reactor: "999@lid", emoji: "👍", ts: 50 },
    });
  });

  it('reaction by the owner is "me"; reaction removal keeps ""', () => {
    expect(
      cacheEffectOf(
        "message.reaction",
        {
          timestamp: 50,
          fromMe: true,
          from: "51911@c.us",
          reaction: { text: "", messageId: "false_51911@c.us_3EB0CC" },
        },
        RECEIVED,
      ),
    ).toEqual({
      kind: "reaction",
      reaction: { messageId: "3EB0CC", reactor: "me", emoji: "", ts: 50 },
    });
  });

  it("reaction without a message id → null", () => {
    expect(cacheEffectOf("message.reaction", { reaction: { text: "👍" } }, RECEIVED)).toBeNull();
  });

  it("vote: poll short id, voter, options", () => {
    expect(
      cacheEffectOf(
        "poll.vote",
        {
          vote: {
            id: "v",
            selectedOptions: ["A", "B"],
            timestamp: 70,
            from: "51911@c.us",
            fromMe: false,
          },
          poll: { id: "false_51911@c.us_3EB0DD", to: "x", from: "51911@c.us", fromMe: false },
        },
        RECEIVED,
      ),
    ).toEqual({
      kind: "vote",
      vote: { pollId: "3EB0DD", voter: "51911@c.us", options: ["A", "B"], ts: 70 },
    });
  });

  it('vote in a group: voter is the participant; vote by owner is "me"', () => {
    const poll = { id: "false_g@g.us_3EB0DD", from: "g@g.us", fromMe: false };
    expect(
      cacheEffectOf(
        "poll.vote",
        {
          vote: {
            selectedOptions: [],
            timestamp: 1,
            from: "g@g.us",
            fromMe: false,
            participant: "9@lid",
          },
          poll,
        },
        RECEIVED,
      ),
    ).toMatchObject({ vote: { voter: "9@lid", options: [] } });
    expect(
      cacheEffectOf(
        "poll.vote",
        { vote: { selectedOptions: ["A"], timestamp: 1, from: "me@c.us", fromMe: true }, poll },
        RECEIVED,
      ),
    ).toMatchObject({ vote: { voter: "me" } });
  });

  it("non-string selectedOptions are dropped", () => {
    const e = cacheEffectOf(
      "poll.vote",
      {
        vote: { selectedOptions: ["A", 3, null, "B"], timestamp: 1, from: "x@c.us", fromMe: false },
        poll: { id: "false_x@c.us_P1" },
      },
      RECEIVED,
    );
    expect(e).toMatchObject({ vote: { options: ["A", "B"] } });
  });

  it("poll.vote.failed → vote_failed", () => {
    expect(
      cacheEffectOf(
        "poll.vote.failed",
        {
          vote: { timestamp: 9, from: "x@c.us", fromMe: false },
          poll: { id: "false_x@c.us_P1" },
        },
        RECEIVED,
      ),
    ).toEqual({ kind: "vote_failed", pollId: "P1", voter: "x@c.us", ts: 9 });
  });

  it("vote without a poll → null", () => {
    expect(
      cacheEffectOf("poll.vote", { vote: { selectedOptions: [], from: "x" } }, RECEIVED),
    ).toBeNull();
  });
});

function setup(
  opts: {
    failApply?: boolean;
    failTimes?: number;
    now?: () => number;
    /** A second tenant whose revokes always fail. */
    failingTenant?: string;
  } = {},
) {
  const authDb = new DatabaseSync(":memory:");
  const events = createSqliteEventStore(authDb);
  const db = openCacheDatabase(":memory:");
  const cipher = testCipher(TENANT);
  const messages = createSqliteMessageStore(db, cipher);
  const store = createSqliteMessageActionStore(db, cipher);
  const real = createMessageActions({
    store,
    messages,
    transcripts: createSqliteTranscriptStore(db, cipher),
    mapper: async () => m,
    ensureOwner: async () => {},
  });
  let failsLeft = opts.failApply ? Number.POSITIVE_INFINITY : (opts.failTimes ?? 0);
  const actions =
    failsLeft > 0
      ? {
          ...real,
          applyRevoke: async (shortId: string, at: number) => {
            if (failsLeft > 0) {
              failsLeft -= 1;
              throw new Error("boom with secret body");
            }
            return real.applyRevoke(shortId, at);
          },
        }
      : real;
  const lines: string[] = [];
  let held = 0;
  let released = 0;
  const port: CacheEventPort = {
    openEvent: (e: StoredEvent) =>
      cipher.openText(e.payloadSealed, `webhook:${e.tenantId}:${e.eventId}`),
    actions,
  };
  const failingPort: CacheEventPort = {
    ...port,
    actions: {
      ...real,
      applyRevoke: async () => {
        throw new Error("session logged out");
      },
    },
  };
  const processor = createCacheEventProcessor({
    events,
    acquire: (tenantId) => {
      if (tenantId !== TENANT && tenantId !== opts.failingTenant) return null;
      held += 1;
      return {
        port: tenantId === TENANT ? port : failingPort,
        release: () => {
          released += 1;
        },
      };
    },
    logger: { info: (l) => lines.push(l) },
    ...(opts.now ? { now: opts.now } : {}),
  });
  let n = 0;
  const put = (kind: WebhookEventKind, payload: Record<string, unknown>, tenantId = TENANT) => {
    n += 1;
    const eventId = `evt_${n}`;
    events.put({
      tenantId,
      eventId,
      kind,
      receivedAt: new Date(RECEIVED * 1000).toISOString(),
      payloadSealed: cipher.sealText(
        JSON.stringify({ id: eventId, payload }),
        `webhook:${tenantId}:${eventId}`,
      ),
    });
  };
  const read = (chat: string) =>
    messages.readRange(chat, { limit: 10, offset: 0 }).map((r) => m.message(r));
  return {
    events,
    messages,
    store,
    processor,
    lines,
    put,
    read,
    counts: () => ({ held, released }),
  };
}

describe("cache event processor", () => {
  it("applies and marks done", async () => {
    const s = setup();
    const raw = rawText("R1", 100, "to delete");
    s.messages.upsertRaw("100000000000009@g.us", [{ id: raw.id as string, ts: 100, raw }]);
    s.put("message.revoked", { revokedMessageId: "R1" });
    s.put("message.reaction", {
      timestamp: 5,
      fromMe: true,
      from: "x@c.us",
      reaction: { text: "👍", messageId: "false_x@c.us_R1" },
    });
    await s.processor.tick();
    expect(s.events.pending(10)).toHaveLength(0);
    expect(s.read("100000000000009@g.us")[0]?.type).toBe("deleted");
    expect(s.store.reactions(["R1"]).get("R1")).toEqual([{ emoji: "👍", by: "me" }]);
    expect(s.counts()).toEqual({ held: 2, released: 2 });
  });

  it("revoke matches a row cached under the @lid chat", async () => {
    const s = setup();
    const lid = "123456789012345@lid";
    const raw = rawText("L1", 100, "lid text", { chat: lid, sender: lid });
    s.messages.upsertRaw(lid, [{ id: raw.id as string, ts: 100, raw }]);
    s.put("message.revoked", { revokedMessageId: "L1", before: null });
    await s.processor.tick();
    expect(s.read(lid)[0]?.type).toBe("deleted");
  });

  it("ignores mission kinds", async () => {
    const s = setup();
    s.put("message", { id: "false_x@c.us_A", from: "x@c.us", body: "hola" });
    s.put("session.status", { status: "WORKING" });
    await s.processor.tick();
    expect(s.events.pending(10)).toHaveLength(2);
    expect(s.lines).toEqual([]);
  });

  it("an event with missing fields is ignored and marked done", async () => {
    const s = setup();
    s.put("message.edited", { body: "no id" });
    await s.processor.tick();
    expect(s.events.pending(10)).toHaveLength(0);
    expect(s.lines.join("\n")).toContain("outcome=ignored");
  });

  it("a failed revoke waits for its backoff: quick wakes do not burn attempts", async () => {
    let now = RECEIVED * 1000;
    const s = setup({ failTimes: 3, now: () => now });
    const raw = rawText("R1", 100, "to delete");
    s.messages.upsertRaw("100000000000009@g.us", [{ id: raw.id as string, ts: 100, raw }]);
    s.put("message.revoked", { revokedMessageId: "R1" });
    for (let i = 0; i < 5; i += 1) {
      s.processor.wake();
      await s.processor.idle();
    }
    expect(s.lines.filter((l) => l.includes("outcome=failed"))).toHaveLength(1);
    expect(s.events.pending(10)).toHaveLength(1);
    // Two more failures, each after its backoff has passed.
    for (let i = 0; i < 2; i += 1) {
      now += 60 * 60 * 1000;
      await s.processor.tick();
    }
    expect(s.lines.filter((l) => l.includes("outcome=failed"))).toHaveLength(3);
    expect(s.events.pending(10)).toHaveLength(1);
    expect(s.read("100000000000009@g.us")[0]?.type).not.toBe("deleted");
    // WAHA recovered: the next due attempt applies it.
    now += 60 * 60 * 1000;
    await s.processor.tick();
    expect(s.events.pending(10)).toHaveLength(0);
    expect(s.read("100000000000009@g.us")[0]?.type).toBe("deleted");
    expect(s.counts().held).toBe(s.counts().released);
  });

  it("over 100 events backing off for one tenant do not delay a revoke for another", async () => {
    let now = RECEIVED * 1000;
    const s = setup({ failingTenant: "tA", now: () => now });
    for (let i = 0; i < 150; i += 1) s.put("message.revoked", { revokedMessageId: `A${i}` }, "tA");
    await s.processor.tick();
    await s.processor.tick();
    const raw = rawText("B1", 100, "to delete");
    s.messages.upsertRaw("100000000000009@g.us", [{ id: raw.id as string, ts: 100, raw }]);
    s.put("message.revoked", { revokedMessageId: "B1" });
    now += 1_000;
    await s.processor.tick();
    expect(s.read("100000000000009@g.us")[0]?.type).toBe("deleted");
    expect(s.events.pending(200)).toHaveLength(150);
  });

  it("a failing event gives up only after the horizon", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let now = RECEIVED * 1000;
    const s = setup({ failApply: true, now: () => now });
    s.put("message.revoked", { revokedMessageId: "R1" });
    await s.processor.tick();
    now += 6 * DAY;
    await s.processor.tick();
    expect(s.events.pending(10)).toHaveLength(1);
    now += DAY;
    await s.processor.tick();
    expect(s.events.pending(10)).toHaveLength(0);
    expect(s.lines.at(-1)).toContain("outcome=gave-up");
    expect(s.lines.join("\n")).not.toContain("secret body");
  });

  it("unknown tenant marks done", async () => {
    const s = setup();
    s.put("message.revoked", { revokedMessageId: "R1" }, "gone");
    await s.processor.tick();
    expect(s.events.pending(10)).toHaveLength(0);
  });

  it("logs carry no text", async () => {
    const s = setup();
    s.put("message.edited", { editedMessageId: "E1", body: "SECRETBODY" });
    s.put("message.reaction", {
      timestamp: 5,
      from: "x@c.us",
      fromMe: false,
      reaction: { text: "🦄", messageId: "false_x@c.us_E1" },
    });
    s.put("poll.vote", {
      vote: { selectedOptions: ["SECRETOPTION"], timestamp: 1, from: "x@c.us", fromMe: false },
      poll: { id: "false_x@c.us_P1" },
    });
    await s.processor.tick();
    const all = s.lines.join("\n");
    expect(all).toContain("outcome=applied");
    for (const secret of ["SECRETBODY", "🦄", "SECRETOPTION"]) expect(all).not.toContain(secret);
  });

  it("wake runs a tick and idle waits for it", async () => {
    const s = setup();
    s.put("message.revoked", { revokedMessageId: "R1" });
    s.processor.wake();
    await s.processor.idle();
    expect(s.events.pending(10)).toHaveLength(0);
  });
});
