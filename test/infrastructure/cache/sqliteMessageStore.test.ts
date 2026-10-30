import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../../src/infrastructure/cache/sqliteMessageStore.js";

const CHAT = "100000000000009@g.us";
const row = (id: string, ts: number, text = id) => ({ id, ts, raw: { id, timestamp: ts, text } });

describe("sqlite message store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const memory = () => createSqliteMessageStore(openCacheDatabase(":memory:"));

  it("creates DATA_DIR/cache.db readable only by the owner, WAL side files included", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-cache-"));
    dirs.push(dir);
    const file = path.join(dir, "cache.db");
    const db = openCacheDatabase(file);
    const store = createSqliteMessageStore(db);
    store.upsertRaw(CHAT, [row("a", 10)]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    for (const side of [`${file}-wal`, `${file}-shm`])
      if (fs.existsSync(side)) expect(fs.statSync(side).mode & 0o777).toBe(0o600);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "wal",
    );
    store.close();
  });

  it("reads newest first within the range, with limit and offset, and keeps raw payloads", () => {
    const store = memory();
    store.upsertRaw(CHAT, [row("c", 30), row("b", 20), row("a", 10)]);
    store.upsertRaw("other@g.us", [row("x", 25)]);
    expect(store.readRange(CHAT, { limit: 10, offset: 0 })).toEqual([
      { id: "c", timestamp: 30, text: "c" },
      { id: "b", timestamp: 20, text: "b" },
      { id: "a", timestamp: 10, text: "a" },
    ]);
    expect(
      store.readRange(CHAT, { fromTs: 10, toTs: 20, limit: 1, offset: 1 }).map((r) => r),
    ).toEqual([{ id: "a", timestamp: 10, text: "a" }]);
    expect(store.countRange(CHAT, { fromTs: 15 })).toBe(2);
    expect(store.countRange(CHAT, { toTs: 15 })).toBe(1);
  });

  it("keeps the arrival order of messages that share a second", () => {
    const store = memory();
    store.upsertRaw(CHAT, [row("y", 10), row("x", 10), row("w", 10)]);
    expect(
      store.readRange(CHAT, { limit: 10, offset: 0 }).map((r) => (r as { id: string }).id),
    ).toEqual(["y", "x", "w"]);
  });

  it("upsert replaces the raw payload of an existing message", () => {
    const store = memory();
    store.upsertRaw(CHAT, [row("a", 10, "before")]);
    store.upsertRaw(CHAT, [row("a", 10, "after")]);
    expect(store.readRange(CHAT, { limit: 10, offset: 0 })).toEqual([
      { id: "a", timestamp: 10, text: "after" },
    ]);
  });

  it("stores and returns the per-chat sync state", () => {
    const store = memory();
    expect(store.getSyncState(CHAT)).toBeNull();
    store.setSyncState(CHAT, { newestTs: 30, oldestTs: 11, lastSyncAt: 5000 });
    expect(store.getSyncState(CHAT)).toEqual({ newestTs: 30, oldestTs: 11, lastSyncAt: 5000 });
    store.setSyncState(CHAT, { newestTs: null, oldestTs: null, lastSyncAt: 6000 });
    expect(store.getSyncState(CHAT)).toEqual({ newestTs: null, oldestTs: null, lastSyncAt: 6000 });
  });

  it("deletes the messages of a window that WAHA no longer returns", () => {
    const store = memory();
    store.upsertRaw(CHAT, [row("c", 30), row("b", 20), row("a", 10)]);
    expect(store.deleteMissing(CHAT, 15, ["c"])).toBe(1);
    expect(
      store.readRange(CHAT, { limit: 10, offset: 0 }).map((r) => (r as { id: string }).id),
    ).toEqual(["c", "a"]);
  });

  it("records the owner and wipes messages and sync state when it changes", () => {
    const store = memory();
    expect(store.getOwner()).toBeNull();
    store.upsertRaw(CHAT, [row("a", 10)]);
    store.setSyncState(CHAT, { newestTs: 10, oldestTs: null, lastSyncAt: 1 });
    store.resetForOwner("default|51000000002@c.us");
    expect(store.getOwner()).toBe("default|51000000002@c.us");
    expect(store.countRange(CHAT, {})).toBe(0);
    expect(store.getSyncState(CHAT)).toBeNull();
  });

  it("keeps rows and the owner across a reopen of the same file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-cache-"));
    dirs.push(dir);
    const file = path.join(dir, "cache.db");
    const first = createSqliteMessageStore(openCacheDatabase(file));
    first.resetForOwner("default|me");
    first.upsertRaw(CHAT, [row("a", 10)]);
    first.close();
    const second = createSqliteMessageStore(openCacheDatabase(file));
    expect(second.getOwner()).toBe("default|me");
    expect(second.countRange(CHAT, {})).toBe(1);
    second.close();
  });

  it("indexes messages by timestamp for pruning", () => {
    const db = openCacheDatabase(":memory:");
    const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM messages WHERE ts < 5").all() as {
      detail: string;
    }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING (COVERING )?INDEX messages_ts/);
  });

  it("prune removes old rows and narrows the coverage of the chats it touched", () => {
    const store = memory();
    store.upsertRaw(CHAT, [row("c", 300), row("b", 200), row("a", 100)]);
    store.setSyncState(CHAT, { newestTs: 300, oldestTs: null, lastSyncAt: 1 });
    store.setSyncState("recent@g.us", { newestTs: 900, oldestTs: 800, lastSyncAt: 1 });
    expect(store.prune(150)).toBe(1);
    expect(store.countRange(CHAT, {})).toBe(2);
    expect(store.getSyncState(CHAT)).toEqual({ newestTs: 300, oldestTs: 150, lastSyncAt: 1 });
    expect(store.getSyncState("recent@g.us")).toEqual({
      newestTs: 900,
      oldestTs: 800,
      lastSyncAt: 1,
    });
  });
});
