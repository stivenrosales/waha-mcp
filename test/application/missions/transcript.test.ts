import { describe, expect, it } from "vitest";
import { missionTranscript } from "../../../src/application/missions/history.js";
import type { MissionLogEntry } from "../../../src/domain/ports/MissionLog.js";

const entry = (at: string, body: unknown): MissionLogEntry => ({ kind: "message", at, body });

describe("missionTranscript", () => {
  it("keeps what the contact wrote and what the agent replied, in order, with their times", () => {
    const entries: MissionLogEntry[] = [
      { kind: "prompt", at: "2026-11-23T10:00:00Z", body: { text: "system" } },
      entry("2026-11-23T10:00:01Z", { from: "engine", text: "Open the conversation" }),
      entry("2026-11-23T10:00:05Z", {
        from: "agent",
        content: [
          { type: "thinking", thinking: "plan", signature: "s" },
          { type: "text", text: "Hola, ¿confirmamos el martes?" },
        ],
      }),
      entry("2026-11-23T10:05:00Z", {
        from: "contact",
        id: "m1",
        content: [
          { type: "text", text: "Sí, a las 3" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
        ],
      }),
      entry("2026-11-23T10:05:02Z", {
        from: "agent",
        content: [{ type: "tool_use", id: "t", name: "no_reply", input: {} }],
      }),
      entry("2026-11-23T10:05:03Z", { from: "tool", content: [] }),
    ];
    expect(missionTranscript(entries)).toEqual([
      { at: "2026-11-23T10:00:05Z", from: "agent", text: "Hola, ¿confirmamos el martes?" },
      { at: "2026-11-23T10:05:00Z", from: "contact", text: "Sí, a las 3 [imagen]" },
    ]);
  });
});
