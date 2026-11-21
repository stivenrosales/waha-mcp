import { describe, expect, it } from "vitest";
import { createSqliteMessageActionStore } from "../../../src/infrastructure/cache/sqliteMessageActionStore.js";
import { openCacheDatabase } from "../../../src/infrastructure/cache/sqliteMessageStore.js";
import {
  createTenantCipher,
  DecryptionError,
  generateDek,
} from "../../../src/infrastructure/crypto/envelope.js";
import { testCipher } from "../../fakes/testCipher.js";

const setup = () => {
  const db = openCacheDatabase(":memory:");
  return { db, store: createSqliteMessageActionStore(db, testCipher("t1")) };
};

describe("sqlite message action store: overrides", () => {
  it("round trips an edit and keeps the text sealed at rest", () => {
    const { db, store } = setup();
    store.putOverride("A", { kind: "edited", text: "secret words", at: 5 });
    expect(store.overrides(["A", "B"]).get("A")).toEqual({
      kind: "edited",
      text: "secret words",
      at: 5,
    });
    expect(store.overrides(["B"]).size).toBe(0);
    const row = db.prepare("SELECT sealed FROM message_overrides").get() as { sealed: string };
    expect(row.sealed.startsWith("v1.")).toBe(true);
    expect(row.sealed).not.toContain("secret");
  });

  it("a revoke is final and leaves no text behind", () => {
    const { db, store } = setup();
    store.putOverride("A", { kind: "edited", text: "old text", at: 1 });
    store.putOverride("A", { kind: "revoked", at: 2 });
    store.putOverride("A", { kind: "edited", text: "later edit", at: 9 });
    expect(store.overrides(["A"]).get("A")).toEqual({ kind: "revoked", at: 2 });
    const row = db.prepare("SELECT kind, sealed FROM message_overrides").get() as {
      kind: string;
      sealed: string;
    };
    expect(row).toEqual({ kind: "revoked", sealed: "" });
  });

  it("the newer edit wins, an older one is ignored, a tie is last-write-wins", () => {
    const { store } = setup();
    store.putOverride("A", { kind: "edited", text: "v2", at: 20 });
    store.putOverride("A", { kind: "edited", text: "v1", at: 10 });
    expect(store.overrides(["A"]).get("A")).toMatchObject({ text: "v2" });
    store.putOverride("A", { kind: "edited", text: "v2b", at: 20 });
    expect(store.overrides(["A"]).get("A")).toMatchObject({ text: "v2b" });
  });

  it("another tenant's cipher cannot read", () => {
    const { db, store } = setup();
    store.putOverride("A", { kind: "edited", text: "x", at: 1 });
    const other = createSqliteMessageActionStore(db, createTenantCipher(generateDek(), "t2"));
    expect(() => other.overrides(["A"])).toThrow(DecryptionError);
  });
});

describe("sqlite message action store: reactions", () => {
  it("keeps the latest per reactor, ignores older ones, and an empty emoji removes", () => {
    const { db, store } = setup();
    store.putReaction({ messageId: "M", reactor: "r2", emoji: "🔥", ts: 1 });
    store.putReaction({ messageId: "M", reactor: "r1", emoji: "👍", ts: 10 });
    store.putReaction({ messageId: "M", reactor: "r1", emoji: "❤️", ts: 12 });
    store.putReaction({ messageId: "M", reactor: "r1", emoji: "😂", ts: 11 });
    const got = store.reactions(["M"]).get("M") ?? [];
    expect(got).toHaveLength(2);
    expect(got).toContainEqual({ emoji: "❤️", by: "r1" });
    expect(got).toContainEqual({ emoji: "🔥", by: "r2" });
    const sealed = (
      db.prepare("SELECT sealed FROM message_reactions").all() as { sealed: string }[]
    )
      .map((r) => r.sealed)
      .join();
    expect(sealed).not.toContain("🔥");

    store.putReaction({ messageId: "M", reactor: "r1", emoji: "", ts: 13 });
    expect(store.reactions(["M"]).get("M")).toEqual([{ emoji: "🔥", by: "r2" }]);
    // a late, older reaction does not resurrect a removed one
    store.putReaction({ messageId: "M", reactor: "r1", emoji: "😂", ts: 12 });
    expect(store.reactions(["M"]).get("M")).toEqual([{ emoji: "🔥", by: "r2" }]);
  });

  it("a tie is last-write-wins", () => {
    const { store } = setup();
    store.putReaction({ messageId: "M", reactor: "me", emoji: "👍", ts: 5 });
    store.putReaction({ messageId: "M", reactor: "me", emoji: "👎", ts: 5 });
    expect(store.reactions(["M"]).get("M")).toEqual([{ emoji: "👎", by: "me" }]);
  });
});

describe("sqlite message action store: poll votes", () => {
  it("keeps the latest vote per voter, sealed at rest, with a tie last-write-wins", () => {
    const { db, store } = setup();
    store.putVote({ pollId: "P", voter: "v1", options: ["Yes"], ts: 5 });
    store.putVote({ pollId: "P", voter: "v1", options: ["No"], ts: 4 });
    store.putVote({ pollId: "P", voter: "v2", options: ["Maybe", "Yes"], ts: 6 });
    const { votes, failed } = store.votes("P");
    expect(failed).toBe(0);
    expect(votes).toHaveLength(2);
    expect(votes).toContainEqual({ pollId: "P", voter: "v1", options: ["Yes"], ts: 5 });
    store.putVote({ pollId: "P", voter: "v1", options: ["No"], ts: 5 });
    expect(store.votes("P").votes.find((v) => v.voter === "v1")?.options).toEqual(["No"]);
    const sealed = (db.prepare("SELECT sealed FROM poll_votes").all() as { sealed: string }[])
      .map((r) => r.sealed)
      .join();
    expect(sealed).not.toContain("Maybe");
  });

  it("a failed vote is counted, then cleared by a later good vote", () => {
    const { store } = setup();
    store.putFailedVote({ pollId: "P", voter: "v1", ts: 5 });
    store.putFailedVote({ pollId: "P", voter: "v1", ts: 6 });
    expect(store.votes("P")).toEqual({ votes: [], failed: 1 });
    store.putVote({ pollId: "P", voter: "v1", options: ["A"], ts: 7 });
    expect(store.votes("P")).toMatchObject({ failed: 0 });
    expect(store.votes("P").votes).toHaveLength(1);
    // an older failure does not count against a newer good vote
    store.putFailedVote({ pollId: "P", voter: "v1", ts: 3 });
    expect(store.votes("P").failed).toBe(0);
  });

  it("another tenant's cipher cannot read", () => {
    const { db, store } = setup();
    store.putVote({ pollId: "P", voter: "v", options: ["A"], ts: 1 });
    const other = createSqliteMessageActionStore(db, createTenantCipher(generateDek(), "t2"));
    expect(() => other.votes("P")).toThrow(DecryptionError);
  });
});
