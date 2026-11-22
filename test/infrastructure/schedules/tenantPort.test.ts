import { describe, expect, it } from "vitest";
import { DISABLED_TRANSCRIPTION } from "../../../src/application/transcripts.js";
import {
  contactRepliedSince,
  readOwnerStyle,
  readScheduleContext,
} from "../../../src/infrastructure/schedules/tenantPort.js";
import { gowsMapper } from "../../../src/infrastructure/waha/engines/gows.js";
import { ANA, BOB, gateway, msg, systemMsg } from "../../application/helpers.js";
import { rawReaction, rawVoice } from "../../fakes/InMemoryWahaGateway.js";

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

describe("contactRepliedSince", () => {
  /** The anchor: three days before NOW. */
  const SINCE = new Date(NOW.getTime() - 3 * DAY * 1000);
  const s = sec(SINCE);
  const replied = (messages: Record<string, unknown>[], chatId = ANA) =>
    contactRepliedSince(
      { gateway: gateway({ messages: { [ANA]: messages } }), mapper: async () => gowsMapper },
      chatId,
      SINCE.toISOString(),
    );

  it("is true when the contact wrote after the anchor", async () => {
    expect(
      await replied([
        msg("m2", s + 60, "Sí, ya lo vi", { chat: ANA }),
        msg("m1", s - 60, "Te mando la cotización", { chat: ANA, mine: true }),
      ]),
    ).toBe(true);
  });

  it("counts a voice note from the contact as a reply", async () => {
    const voice = rawVoice("v1", s + 60, { url: "http://waha/v1.ogg", chat: ANA, sender: ANA });
    expect(await replied([voice])).toBe(true);
  });

  it("is false with only the owner's messages, reactions or system messages after the anchor", async () => {
    expect(
      await replied([
        rawReaction("r1", s + 300, "m1", "👍", { chat: ANA, sender: ANA }),
        systemMsg("x1", s + 200, ANA),
        msg("m2", s + 100, "¿Lo viste?", { chat: ANA, mine: true }),
      ]),
    ).toBe(false);
  });

  it("ignores the contact's messages up to the anchor", async () => {
    expect(
      await replied([
        msg("m2", s, "Justo antes", { chat: ANA }),
        msg("m1", s - 3600, "Hola", { chat: ANA }),
      ]),
    ).toBe(false);
  });

  it("reads only the given chat; a chat with no messages has no reply", async () => {
    expect(await replied([msg("m1", s + 60, "Hola", { chat: ANA })], BOB)).toBe(false);
  });

  it("propagates read failures", async () => {
    const failing = gateway({ failWith: new Error("waha down") });
    await expect(
      contactRepliedSince(
        { gateway: failing, mapper: async () => gowsMapper },
        ANA,
        SINCE.toISOString(),
      ),
    ).rejects.toThrow("waha down");
  });
});

describe("readOwnerStyle", () => {
  it("describes the owner's style from the owner's own messages in the chat, ignoring the contact's", async () => {
    const t = sec(NOW);
    const style = await readOwnerStyle(
      ctx([
        msg("c2", t - 10, "Estimado, le saludo cordialmente.", { chat: ANA }),
        msg("o4", t - 20, "va, te aviso", { chat: ANA, mine: true }),
        msg("o3", t - 30, "ok bro 😂", { chat: ANA, mine: true }),
        // Older than the schedule context window (14 days), still the owner's style.
        msg("o2", t - 20 * DAY, "nos vemos mañana 👍", { chat: ANA, mine: true }),
        msg("o1", t - 30 * DAY, "jaja dale 😂", { chat: ANA, mine: true }),
        msg("c1", t - 31 * DAY, "Buenos días, estimado.", { chat: ANA }),
      ]),
      ANA,
      NOW,
    );
    expect(style).toBe(
      'Owner\'s writing style in this chat, from their last 4 messages (imitate it in every message you write; never mention it): very short messages (about 3 words); uses emojis often (😂 👍); informal, casual tone; laughs with "jaja"; usually starts in lowercase; rarely ends with a period; writes in Spanish.',
    );
  });

  it("is null for a chat WAHA has never seen or where the owner wrote too little", async () => {
    const t = sec(NOW);
    expect(await readOwnerStyle(ctx([]), "51900000000@c.us", NOW)).toBeNull();
    expect(
      await readOwnerStyle(ctx([msg("o1", t - 10, "hola", { chat: ANA, mine: true })]), ANA, NOW),
    ).toBeNull();
  });
});
