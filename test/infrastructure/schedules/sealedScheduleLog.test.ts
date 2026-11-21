import { describe, expect, it } from "vitest";
import { openCacheDatabase } from "../../../src/infrastructure/cache/sqliteMessageStore.js";
import {
  createTenantCipher,
  DecryptionError,
  generateDek,
} from "../../../src/infrastructure/crypto/envelope.js";
import { createSealedScheduleLog } from "../../../src/infrastructure/schedules/sealedScheduleLog.js";
import { testCipher } from "../../fakes/testCipher.js";

const setup = () => {
  const db = openCacheDatabase(":memory:");
  return { db, log: createSealedScheduleLog(db, testCipher("t1")) };
};

describe("sealedScheduleLog", () => {
  it("round-trips content, replaces it on a second put, and seals it at rest", () => {
    const { db, log } = setup();
    expect(log.content("s1")).toBeNull();
    log.putContent("s1", { text: "secret hello" });
    expect(log.content("s1")).toEqual({ text: "secret hello" });
    log.putContent("s1", { instruction: "ask about the invoice" });
    expect(log.content("s1")).toEqual({ instruction: "ask about the invoice" });
    log.putContent("s2", { text: "other secret" });
    const raw = db.prepare("SELECT sealed FROM schedule_content").all() as { sealed: string }[];
    const joined = raw.map((r) => r.sealed).join("");
    expect(joined).not.toContain("invoice");
    expect(joined).not.toContain("other secret");
  });

  it("returns runs newest first, honours the limit and seals the body", () => {
    const { db, log } = setup();
    log.appendRun("s1", { at: "2026-11-21T10:00:00.000Z", outcome: "sent", text: "secret body" });
    log.appendRun("s1", { at: "2026-11-22T10:00:00.000Z", outcome: "skipped", reason: "paused" });
    log.appendRun("s1", { at: "2026-11-23T10:00:00.000Z", outcome: "failed" });
    log.appendRun("s2", { at: "2026-11-23T11:00:00.000Z", outcome: "sent" });
    expect(log.runs("s1", 10)).toEqual([
      { at: "2026-11-23T10:00:00.000Z", outcome: "failed" },
      { at: "2026-11-22T10:00:00.000Z", outcome: "skipped", reason: "paused" },
      { at: "2026-11-21T10:00:00.000Z", outcome: "sent", text: "secret body" },
    ]);
    expect(log.runs("s1", 2).map((r) => r.outcome)).toEqual(["failed", "skipped"]);
    const raw = db.prepare("SELECT sealed FROM schedule_runs").all() as { sealed: string }[];
    expect(raw.map((r) => r.sealed).join("")).not.toContain("secret body");
  });

  it("purgeRunsBefore removes only older runs and keeps content", () => {
    const { log } = setup();
    log.putContent("s1", { text: "hi" });
    log.appendRun("s1", { at: "2026-10-01T10:00:00.000Z", outcome: "sent" });
    log.appendRun("s1", { at: "2026-11-20T10:00:00.000Z", outcome: "sent" });
    log.purgeRunsBefore("2026-11-01T00:00:00.000Z");
    expect(log.runs("s1", 10).map((r) => r.at)).toEqual(["2026-11-20T10:00:00.000Z"]);
    expect(log.content("s1")).toEqual({ text: "hi" });
  });

  it("deleteSchedules removes content and runs of the given schedules only", () => {
    const { log } = setup();
    for (const id of ["s1", "s2"]) {
      log.putContent(id, { text: id });
      log.appendRun(id, { at: "2026-11-20T10:00:00.000Z", outcome: "sent" });
    }
    log.deleteSchedules(["s1"]);
    expect(log.content("s1")).toBeNull();
    expect(log.runs("s1", 10)).toEqual([]);
    expect(log.content("s2")).toEqual({ text: "s2" });
    expect(log.runs("s2", 10)).toHaveLength(1);
  });

  it("is unreadable with another tenant's cipher", () => {
    const db = openCacheDatabase(":memory:");
    const mine = createSealedScheduleLog(db, createTenantCipher(generateDek(), "t1"));
    mine.putContent("s1", { text: "x" });
    mine.appendRun("s1", { at: "2026-11-20T10:00:00.000Z", outcome: "sent" });
    const other = createSealedScheduleLog(db, createTenantCipher(generateDek(), "t2"));
    expect(() => other.content("s1")).toThrow(DecryptionError);
    expect(() => other.runs("s1", 5)).toThrow(DecryptionError);
  });

  it("binds sealed rows to their schedule id", () => {
    const { db, log } = setup();
    log.putContent("s1", { text: "x" });
    db.exec("UPDATE schedule_content SET schedule_id = 's2'");
    expect(() => log.content("s2")).toThrow(DecryptionError);
  });
});
