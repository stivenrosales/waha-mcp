import { describe, expect, it } from "vitest";
import { DISABLED_TRANSCRIPTION } from "../../../src/application/transcripts.js";
import { readScheduleContext } from "../../../src/infrastructure/schedules/tenantPort.js";
import { gowsMapper } from "../../../src/infrastructure/waha/engines/gows.js";
import { ANA, gateway, msg, systemMsg } from "../../application/helpers.js";

const TZ = "America/Lima";
/** 10:00 in Lima. */
const NOW = new Date("2026-11-17T15:00:00.000Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const DAY = 24 * 3600;

const ctx = (messages: Record<string, unknown>[]) => ({
  gateway: gateway({ messages: { [ANA]: messages } }),
  mapper: async () => gowsMapper,
  transcription: DISABLED_TRANSCRIPTION,
});

describe("readScheduleContext", () => {
  it("returns the chat's recent text messages oldest first, in local time, skipping empty ones", async () => {
    const t = sec(NOW);
    // WAHA order: newest first.
    const lines = await readScheduleContext(
      ctx([
        msg("m3", t - 60, "¿Ya pagaste?", { chat: ANA, mine: true }),
        systemMsg("m2", t - 120, ANA),
        msg("m1", t - 3600, "Hola", { chat: ANA }),
      ]),
      ANA,
      TZ,
      NOW,
    );
    expect(lines).toEqual([
      { at: "2026-11-17 09:00", fromOwner: false, text: "Hola" },
      { at: "2026-11-17 09:59", fromOwner: true, text: "¿Ya pagaste?" },
    ]);
  });

  it("reads at most 40 messages from the last 14 days", async () => {
    const t = sec(NOW);
    const recent = Array.from({ length: 45 }, (_, i) =>
      msg(`r${i}`, t - i * 60, `msg ${i}`, { chat: ANA }),
    );
    const lines = await readScheduleContext(
      ctx([...recent, msg("old", t - 15 * DAY, "old", { chat: ANA })]),
      ANA,
      TZ,
      NOW,
    );
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)?.text).toBe("msg 0");
    expect(lines.map((l) => l.text)).not.toContain("old");
    const older = await readScheduleContext(
      ctx([msg("old", t - 15 * DAY, "old", { chat: ANA })]),
      ANA,
      TZ,
      NOW,
    );
    expect(older).toEqual([]);
  });
});
