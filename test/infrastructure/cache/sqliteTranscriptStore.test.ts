import { describe, expect, it } from "vitest";
import { openCacheDatabase } from "../../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../../../src/infrastructure/cache/sqliteTranscriptStore.js";
import {
  createTenantCipher,
  DecryptionError,
  generateDek,
} from "../../../src/infrastructure/crypto/envelope.js";
import { testCipher } from "../../fakes/testCipher.js";

const CHAT = "100000000000009@g.us";

describe("sqlite transcript store encryption", () => {
  it('the value on disk starts with "v1." and does not contain the text', () => {
    const db = openCacheDatabase(":memory:");
    createSqliteTranscriptStore(db, testCipher()).put(CHAT, "m1", "private words");
    const { text } = db.prepare("SELECT text FROM transcripts").get() as { text: string };
    expect(text.startsWith("v1.")).toBe(true);
    expect(text).not.toContain("private");
  });

  it("reads back the same text", () => {
    const store = createSqliteTranscriptStore(openCacheDatabase(":memory:"), testCipher());
    store.put(CHAT, "m1", "private words");
    expect(store.get(CHAT, "m1")).toBe("private words");
  });

  it("a store with another tenant's cipher cannot read rows", () => {
    const db = openCacheDatabase(":memory:");
    createSqliteTranscriptStore(db, testCipher("t1")).put(CHAT, "m1", "x");
    const other = createSqliteTranscriptStore(db, createTenantCipher(generateDek(), "t2"));
    expect(() => other.get(CHAT, "m1")).toThrow(DecryptionError);
  });

  it("a legacy plaintext row is still readable", () => {
    const db = openCacheDatabase(":memory:");
    db.prepare(
      "INSERT INTO transcripts (chat_id, message_id, text, created_at) VALUES (?, 'old', 'plain', 1)",
    ).run(CHAT);
    expect(createSqliteTranscriptStore(db, testCipher()).get(CHAT, "old")).toBe("plain");
  });

  it('row AADs are unambiguous: chat "a:b" / id "c" is not chat "a" / id "b:c"', () => {
    const db = openCacheDatabase(":memory:");
    const store = createSqliteTranscriptStore(db, testCipher());
    store.put("a:b", "c", "x");
    db.prepare("UPDATE transcripts SET chat_id = 'a', message_id = 'b:c'").run();
    expect(() => store.get("a", "b:c")).toThrow(DecryptionError);
  });
});
