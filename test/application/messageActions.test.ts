import { describe, expect, it } from "vitest";
import { createMessageActions } from "../../src/application/messageActions.js";
import { createSqliteMessageActionStore } from "../../src/infrastructure/cache/sqliteMessageActionStore.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../../src/infrastructure/cache/sqliteTranscriptStore.js";
import { getEngineMapper } from "../../src/infrastructure/waha/engines/index.js";
import { rawText } from "../fakes/InMemoryWahaGateway.js";
import { testCipher } from "../fakes/testCipher.js";

const m = getEngineMapper("GOWS");
const CHAT = "100000000000009@g.us";
const OTHER = "100000000000010@g.us";

function setup(cacheOn = true) {
  const db = openCacheDatabase(":memory:");
  const cipher = testCipher();
  const messages = createSqliteMessageStore(db, cipher);
  const transcripts = createSqliteTranscriptStore(db, cipher);
  const store = createSqliteMessageActionStore(db, cipher);
  const actions = createMessageActions({
    store,
    messages: cacheOn ? messages : null,
    transcripts,
    mapper: async () => m,
  });
  return { db, messages, transcripts, store, actions };
}

const read = (messages: ReturnType<typeof setup>["messages"], chat: string) =>
  messages.readRange(chat, { limit: 10, offset: 0 }).map((r) => m.message(r));

describe("message actions on cached payloads", () => {
  it("applyRevoke blanks every cached copy and the transcript", async () => {
    const { db, messages, transcripts, actions } = setup();
    const a = rawText("S1", 100, "old secret words", { chat: CHAT });
    const b = rawText("S1", 100, "old secret words", { chat: OTHER });
    messages.upsertRaw(CHAT, [{ id: a.id as string, ts: 100, raw: a }]);
    messages.upsertRaw(OTHER, [{ id: b.id as string, ts: 100, raw: b }]);
    transcripts.put(CHAT, a.id as string, "spoken secret");
    const cached = () => JSON.stringify(messages.findByShortId("S1")); // decrypted rows
    expect(cached()).toContain("old secret words");
    await actions.applyRevoke("S1", 200);
    expect(messages.findByShortId("S1")).toHaveLength(2);
    expect(cached()).not.toContain("old secret words");
    for (const chat of [CHAT, OTHER]) {
      const [msg] = read(messages, chat);
      expect(msg?.type).toBe("deleted");
      expect(msg?.text).toBeNull();
    }
    expect(transcripts.get(CHAT, a.id as string)).toBeNull();
    for (const { raw } of db.prepare("SELECT raw FROM messages").all() as { raw: string }[])
      expect(raw).not.toContain("secret");
  });

  it("applyEdit rewrites the cached row text and keeps ts and order", async () => {
    const { messages, actions } = setup();
    const first = rawText("E1", 100, "before");
    const second = rawText("E2", 200, "later");
    messages.upsertRaw(CHAT, [
      { id: first.id as string, ts: 100, raw: first },
      { id: second.id as string, ts: 200, raw: second },
    ]);
    await actions.applyEdit("E1", "after", 300);
    const rows = read(messages, CHAT);
    expect(rows.map((r) => r.text)).toEqual(["later", "after"]);
    expect(rows[1]?.edited).toBe(true);
    expect(rows[1]?.timestamp).toBe(new Date(100_000).toISOString());
  });

  it("applyEdit after applyRevoke stays deleted", async () => {
    const { messages, actions } = setup();
    const raw = rawText("D1", 100, "gone");
    messages.upsertRaw(CHAT, [{ id: raw.id as string, ts: 100, raw }]);
    await actions.applyRevoke("D1", 200);
    await actions.applyEdit("D1", "back again", 300);
    const [msg] = read(messages, CHAT);
    expect(msg?.type).toBe("deleted");
    expect(msg?.text).toBeNull();
  });

  it.each(["applyRevoke", "applyEdit"] as const)(
    "%s with a failing mapper lookup writes nothing and throws",
    async (method) => {
      const db = openCacheDatabase(":memory:");
      const cipher = testCipher();
      const messages = createSqliteMessageStore(db, cipher);
      const transcripts = createSqliteTranscriptStore(db, cipher);
      const store = createSqliteMessageActionStore(db, cipher);
      const actions = createMessageActions({
        store,
        messages,
        transcripts,
        mapper: async () => {
          throw new Error("waha down");
        },
      });
      const raw = rawText("F1", 100, "keep me");
      messages.upsertRaw(CHAT, [{ id: raw.id as string, ts: 100, raw }]);
      transcripts.put(CHAT, raw.id as string, "spoken");
      const call =
        method === "applyRevoke" ? actions.applyRevoke("F1", 5) : actions.applyEdit("F1", "x", 5);
      await expect(call).rejects.toThrow("waha down");
      expect(store.overrides(["F1"]).size).toBe(0);
      expect(transcripts.get(CHAT, raw.id as string)).toBe("spoken");
      expect(messages.findByShortId("F1")[0]?.raw).toEqual(raw);
    },
  );

  it("works with the cache off", async () => {
    const { store, actions } = setup(false);
    await actions.applyEdit("N1", "x", 10);
    expect(store.overrides(["N1"]).get("N1")).toEqual({ kind: "edited", text: "x", at: 10 });
    await expect(actions.applyRevoke("N1", 20)).resolves.toBeUndefined();
    expect(store.overrides(["N1"]).get("N1")?.kind).toBe("revoked");
  });

  it("delegates reactions and votes to the store", () => {
    const { actions } = setup(false);
    actions.applyVote({ pollId: "P", voter: "a@lid", options: ["x"], ts: 1 });
    actions.applyFailedVote({ pollId: "P", voter: "b@lid", ts: 2 });
    const { votes, failed } = actions.pollVotes("P");
    expect(votes.map((v) => v.voter)).toEqual(["a@lid"]);
    expect(failed).toBe(1);
  });
});
