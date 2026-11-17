export type MissionState =
  | "active"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled"
  | "taken_over"
  | "stopped";

export type StopReason =
  | "refusal"
  | "restriction"
  | "revoked"
  | "errors"
  | "budget"
  | "llm_cap"
  | "message_cap";

export interface MissionSnapshot {
  state: MissionState;
  stopReason: StopReason | null;
  newContact: boolean;
  reminderCount: number;
  lastAgentAt: string | null;
  lastInboundAt: string | null;
  lastReminderAt: string | null;
}

export type MissionEventKind =
  | { type: "succeed" }
  | { type: "fail" }
  | { type: "expire" }
  | { type: "cancel" }
  | { type: "take_over" }
  | { type: "stop"; reason: StopReason };

export function isTerminal(state: MissionState): boolean {
  return state !== "active";
}

export function transition(m: MissionSnapshot, event: MissionEventKind): MissionSnapshot {
  if (isTerminal(m.state)) {
    throw new Error(`Mission is already ${m.state}; cannot apply "${event.type}"`);
  }
  switch (event.type) {
    case "succeed":
      return { ...m, state: "succeeded" };
    case "fail":
      return { ...m, state: "failed" };
    case "expire":
      return { ...m, state: "expired" };
    case "cancel":
      return { ...m, state: "cancelled" };
    case "take_over":
      return { ...m, state: "taken_over" };
    case "stop":
      return { ...m, state: "stopped", stopReason: event.reason };
  }
}
