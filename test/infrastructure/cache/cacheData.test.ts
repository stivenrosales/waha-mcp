import { describe, expect, it } from "vitest";
import { createCacheData } from "../../../src/infrastructure/cache/cacheData.js";
import { createSqliteMessageActionStore } from "../../../src/infrastructure/cache/sqliteMessageActionStore.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../../../src/infrastructure/cache/sqliteTranscriptStore.js";
import { testCipher } from "../../fakes/testCipher.js";

const CHAT = "51911111111@c.us";
const DAY_S = 86_400;
/** "Now" in unix seconds; rows are placed relative to it. */
const NOW_S = 1_800_000_000;
const row = (id: string, ts: number) => ({ id, ts, raw: { id, timestamp: ts, body: id } });

function world() {
  const db = openCacheDatabase(":memory:");
  const cipher = testCipher();
  const messages = createSqliteMessageStore(db, cipher);
  const actions = createSqliteMessageActionStore(db, cipher);
  let transcriptClock = 0;
  const transcripts = createSqliteTranscriptStore(db, cipher, () => transcriptClock);
  const putTranscript = (id: string, atS: number) => {
    transcriptClock = atS * 1000;
    transcripts.put(CHAT, id, `transcript ${id}`);
  };
  messages.resetForOwner("s|51900000001@c.us");
  return { db, cipher, messages, actions, transcripts, putTranscript };
}

const count = (db: ReturnType<typeof openCacheDatabase>, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe("cache data (retention and self-service deletion over cache.db)", () => {
  it("pruneBefore deletes cached data older than the cutoff and keeps everything newer", () => {
    const w = world();
    const old = NOW_S - 91 * DAY_S;
    const recent = NOW_S - 89 * DAY_S;
    w.messages.upsertRaw(CHAT, [row("true_x_OLD", old), row("true_x_NEW", recent)]);
    w.messages.setSyncState(CHAT, { newestTs: recent, oldestTs: null, lastSyncAt: 0 });
    w.actions.putOverride("OLD", { kind: "edited", text: "viejo", at: old });
    w.actions.putOverride("NEW", { kind: "edited", text: "nuevo", at: recent });
    w.actions.putReaction({ messageId: "OLD", reactor: "r", emoji: "👍", ts: old });
    w.actions.putReaction({ messageId: "NEW", reactor: "r", emoji: "👍", ts: recent });
    w.actions.putVote({ pollId: "P", voter: "v1", options: ["a"], ts: old });
    w.actions.putVote({ pollId: "P", voter: "v2", options: ["a"], ts: recent });
    w.putTranscript("true_x_OLD", old);
    w.putTranscript("true_x_NEW", recent);

    const cutoffMs = (NOW_S - 90 * DAY_S) * 1000;
    const deleted = createCacheData(w.db, w.cipher).pruneBefore(cutoffMs);

    expect(deleted).toEqual({ messages: 1, transcripts: 1 });
    expect(w.messages.readRange(CHAT, { limit: 10, offset: 0 })).toEqual([
      { id: "true_x_NEW", timestamp: recent, body: "true_x_NEW" },
    ]);
    // The pruned span is no longer covered: older reads go back to WAHA.
    expect(w.messages.getSyncState(CHAT)?.oldestTs).toBe(NOW_S - 90 * DAY_S);
    expect([...w.actions.overrides(["OLD", "NEW"]).keys()]).toEqual(["NEW"]);
    expect([...w.actions.reactions(["OLD", "NEW"]).keys()]).toEqual(["NEW"]);
    expect(w.actions.votes("P").votes.map((v) => v.voter)).toEqual(["v2"]);
    expect(w.transcripts.get(CHAT, "true_x_OLD")).toBeNull();
    expect(w.transcripts.get(CHAT, "true_x_NEW")).toBe("transcript true_x_NEW");
    // The account the cache belongs to is not data to prune.
    expect(w.messages.getOwner()).toBe("s|51900000001@c.us");
  });

  it("wipe deletes every cached message, coverage, edit, reaction, vote and transcript, keeping the owner", () => {
    const w = world();
    w.messages.upsertRaw(CHAT, [row("true_x_A", NOW_S), row("true_x_B", NOW_S - 1)]);
    w.messages.setSyncState(CHAT, { newestTs: NOW_S, oldestTs: null, lastSyncAt: 1 });
    w.actions.putOverride("A", { kind: "revoked", at: NOW_S });
    w.actions.putReaction({ messageId: "A", reactor: "r", emoji: "👍", ts: NOW_S });
    w.actions.putVote({ pollId: "P", voter: "v", options: ["a"], ts: NOW_S });
    w.putTranscript("true_x_A", NOW_S);

    const deleted = createCacheData(w.db, w.cipher).wipe();

    expect(deleted).toEqual({ messages: 2, transcripts: 1 });
    for (const table of [
      "messages",
      "chat_sync",
      "transcripts",
      "message_overrides",
      "message_reactions",
      "poll_votes",
    ])
      expect(count(w.db, table)).toBe(0);
    expect(w.messages.getOwner()).toBe("s|51900000001@c.us");
  });
});
