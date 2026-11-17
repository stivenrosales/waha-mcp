import { describe, expect, it } from "vitest";
import { openCacheDatabase } from "../../../src/infrastructure/cache/sqliteMessageStore.js";
import {
  createTenantCipher,
  DecryptionError,
  generateDek,
} from "../../../src/infrastructure/crypto/envelope.js";
import { createSealedMissionLog } from "../../../src/infrastructure/missions/sealedMissionLog.js";

const entry = (body: unknown) => ({
  kind: "message" as const,
  at: "2026-11-17T10:00:00.000Z",
  body,
});

describe("sealedMissionLog", () => {
  it("round-trips entries in order and seals them at rest", () => {
    const db = openCacheDatabase(":memory:");
    const log = createSealedMissionLog(db, createTenantCipher(generateDek(), "t1"));
    log.append("m1", entry({ text: "secret hello" }));
    log.append("m1", { kind: "answer", at: "2026-11-17T10:05:00.000Z", body: [1, "x"] });
    expect(log.read("m1")).toEqual([
      entry({ text: "secret hello" }),
      { kind: "answer", at: "2026-11-17T10:05:00.000Z", body: [1, "x"] },
    ]);
    const raw = db.prepare("SELECT sealed FROM mission_log").all() as { sealed: string }[];
    expect(raw.map((r) => r.sealed).join("")).not.toContain("secret hello");
  });

  it("is unreadable with another tenant's cipher", () => {
    const db = openCacheDatabase(":memory:");
    createSealedMissionLog(db, createTenantCipher(generateDek(), "t1")).append("m1", entry("x"));
    const other = createSealedMissionLog(db, createTenantCipher(generateDek(), "t2"));
    expect(() => other.read("m1")).toThrow(DecryptionError);
  });

  it("binds each entry to its mission and position", () => {
    const db = openCacheDatabase(":memory:");
    const log = createSealedMissionLog(db, createTenantCipher(generateDek(), "t1"));
    log.append("m1", entry("x"));
    db.exec("UPDATE mission_log SET mission_id = 'm2'");
    expect(() => log.read("m2")).toThrow(DecryptionError);
  });

  it("purgeMissions removes only the given missions; deleteAll removes everything", () => {
    const db = openCacheDatabase(":memory:");
    const log = createSealedMissionLog(db, createTenantCipher(generateDek(), "t1"));
    log.append("old", entry("a"));
    log.append("new", entry("b"));
    log.purgeMissions(["old"]);
    expect(log.read("old")).toEqual([]);
    expect(log.read("new")).toHaveLength(1);
    log.deleteAll();
    expect(log.read("new")).toEqual([]);
  });
});
