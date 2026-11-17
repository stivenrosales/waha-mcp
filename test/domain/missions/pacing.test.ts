import { describe, expect, it } from "vitest";
import { DEFAULT_MISSION_LIMITS as L } from "../../../src/domain/missions/limits.js";
import type { MissionSnapshot } from "../../../src/domain/missions/mission.js";
import {
  inQuietHours,
  nextAllowedInitiatedSend,
  reminderDue,
  typingDelayMs,
} from "../../../src/domain/missions/pacing.js";

const TZ = "America/Lima"; // UTC-5, no DST
const lima = (iso: string) => new Date(`${iso}-05:00`);

describe("typingDelayMs", () => {
  it("clamps short text up to 2000", () => {
    expect(typingDelayMs("hola", () => 0.5)).toBe(2000);
  });
  it("clamps long text down to 15000", () => {
    expect(typingDelayMs("a".repeat(1000), () => 0.5)).toBe(15000);
  });
  it("applies +-25% jitter from the injected rand", () => {
    const text = "a".repeat(100); // 6500 base
    expect(typingDelayMs(text, () => 0.5)).toBe(6500);
    expect(typingDelayMs(text, () => 0)).toBe(4875);
    expect(typingDelayMs(text, () => 1)).toBe(8125);
  });
});

describe("quiet hours", () => {
  it("23:30 and 03:00 are quiet; 08:00 and 21:59 are not", () => {
    expect(inQuietHours(lima("2026-03-10T23:30:00"), TZ, L)).toBe(true);
    expect(inQuietHours(lima("2026-03-10T03:00:00"), TZ, L)).toBe(true);
    expect(inQuietHours(lima("2026-03-10T08:00:00"), TZ, L)).toBe(false);
    expect(inQuietHours(lima("2026-03-10T21:59:00"), TZ, L)).toBe(false);
    expect(inQuietHours(lima("2026-03-10T22:00:00"), TZ, L)).toBe(true);
  });

  it("nextAllowedInitiatedSend returns the same instant outside quiet hours", () => {
    const at = lima("2026-03-10T12:00:00");
    expect(nextAllowedInitiatedSend(at, TZ, L).getTime()).toBe(at.getTime());
  });
  it("23:30 goes to 08:00 next day", () => {
    expect(nextAllowedInitiatedSend(lima("2026-03-10T23:30:00"), TZ, L).toISOString()).toBe(
      lima("2026-03-11T08:00:00").toISOString(),
    );
  });
  it("03:00 goes to 08:00 the same day", () => {
    expect(nextAllowedInitiatedSend(lima("2026-03-11T03:00:00"), TZ, L).toISOString()).toBe(
      lima("2026-03-11T08:00:00").toISOString(),
    );
  });
  it("handles month rollover", () => {
    expect(nextAllowedInitiatedSend(lima("2026-03-31T22:00:00"), TZ, L).toISOString()).toBe(
      lima("2026-04-01T08:00:00").toISOString(),
    );
  });
});

describe("reminderDue", () => {
  const t0 = new Date("2026-03-10T15:00:00Z");
  const min = (n: number) => new Date(t0.getTime() + n * 60_000);
  const base: MissionSnapshot = {
    state: "active",
    stopReason: null,
    newContact: false,
    reminderCount: 0,
    lastAgentAt: t0.toISOString(),
    lastInboundAt: null,
    lastReminderAt: null,
  };

  it("is not due after 29 minutes, due after 30", () => {
    expect(reminderDue(base, min(29), L)).toBe(false);
    expect(reminderDue(base, min(30), L)).toBe(true);
  });
  it("is not due when the other side replied after the agent", () => {
    expect(reminderDue({ ...base, lastInboundAt: min(5).toISOString() }, min(60), L)).toBe(false);
  });
  it("is due when the last inbound predates the last agent message", () => {
    expect(reminderDue({ ...base, lastInboundAt: min(-10).toISOString() }, min(30), L)).toBe(true);
  });
  it("measures the gap from the last reminder", () => {
    const m = { ...base, reminderCount: 1, lastReminderAt: min(30).toISOString() };
    expect(reminderDue(m, min(59), L)).toBe(false);
    expect(reminderDue(m, min(60), L)).toBe(true);
  });
  it("caps at 2 reminders, or 1 for a new contact", () => {
    expect(reminderDue({ ...base, reminderCount: 2 }, min(500), L)).toBe(false);
    expect(reminderDue({ ...base, newContact: true, reminderCount: 0 }, min(30), L)).toBe(true);
    expect(reminderDue({ ...base, newContact: true, reminderCount: 1 }, min(500), L)).toBe(false);
  });
  it("is never due for a terminal mission or before the agent wrote", () => {
    expect(reminderDue({ ...base, state: "stopped" }, min(500), L)).toBe(false);
    expect(reminderDue({ ...base, lastAgentAt: null }, min(500), L)).toBe(false);
  });
});
