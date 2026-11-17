import { describe, expect, it } from "vitest";
import {
  isTerminal,
  type MissionSnapshot,
  transition,
} from "../../../src/domain/missions/mission.js";

const active: MissionSnapshot = {
  state: "active",
  stopReason: null,
  newContact: false,
  reminderCount: 0,
  lastAgentAt: null,
  lastInboundAt: null,
  lastReminderAt: null,
};

describe("mission state", () => {
  it("only active is non-terminal", () => {
    expect(isTerminal("active")).toBe(false);
    for (const s of [
      "succeeded",
      "failed",
      "expired",
      "cancelled",
      "taken_over",
      "stopped",
    ] as const) {
      expect(isTerminal(s)).toBe(true);
    }
  });

  it("maps events to terminal states", () => {
    expect(transition(active, { type: "succeed" }).state).toBe("succeeded");
    expect(transition(active, { type: "fail" }).state).toBe("failed");
    expect(transition(active, { type: "expire" }).state).toBe("expired");
    expect(transition(active, { type: "cancel" }).state).toBe("cancelled");
    expect(transition(active, { type: "take_over" }).state).toBe("taken_over");
  });

  it("records the stop reason", () => {
    const m = transition(active, { type: "stop", reason: "llm_cap" });
    expect(m.state).toBe("stopped");
    expect(m.stopReason).toBe("llm_cap");
  });

  it("does not mutate the input", () => {
    transition(active, { type: "succeed" });
    expect(active.state).toBe("active");
  });

  it("throws on a transition out of a terminal state", () => {
    const done = transition(active, { type: "succeed" });
    expect(() => transition(done, { type: "cancel" })).toThrow();
  });
});
