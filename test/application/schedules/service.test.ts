import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createScheduleService,
  SCHEDULE_TEXTS,
  type ScheduleService,
} from "../../../src/application/schedules/service.js";
import { InvalidInputError } from "../../../src/domain/errors.js";
import { DEFAULT_MISSION_LIMITS } from "../../../src/domain/missions/limits.js";
import { DEFAULT_SCHEDULE_LIMITS } from "../../../src/domain/schedules/limits.js";
import { createSqliteMissionStore } from "../../../src/infrastructure/missions/sqliteMissionStore.js";
import { createSealedScheduleLog } from "../../../src/infrastructure/schedules/sealedScheduleLog.js";
import { createSqliteScheduleStore } from "../../../src/infrastructure/schedules/sqliteScheduleStore.js";
import { testCipher } from "../../fakes/testCipher.js";

const TENANT = "t1";
const OWNER = "51999000000@c.us";
const CHAT = "51911111111@c.us";
const LID = "123456789012345@lid";
const GROUP = "120363000000000000@g.us";
const TZ = "America/Lima";
/** 10:00 in Lima (UTC-5). */
const T0 = new Date("2026-11-17T15:00:00.000Z");

function harness(opts: { history?: string[] } = {}) {
  const authDb = new DatabaseSync(":memory:");
  const store = createSqliteScheduleStore(authDb, () => T0.toISOString());
  const missions = createSqliteMissionStore(authDb, () => T0.toISOString());
  const log = createSealedScheduleLog(new DatabaseSync(":memory:"), testCipher(TENANT));
  const history = new Set(opts.history ?? [CHAT, OWNER]);
  const cancels: string[] = [];
  const service: ScheduleService = createScheduleService({
    tenantId: TENANT,
    store,
    log,
    missions,
    cancel(tenantId, id) {
      cancels.push(`${tenantId}/${id}`);
      if (store.get(tenantId, id)?.state !== "active") return false;
      store.update(id, { state: "cancelled", endedAt: T0.toISOString(), nextRunAt: null });
      return true;
    },
    limits: DEFAULT_SCHEDULE_LIMITS,
    missionLimits: DEFAULT_MISSION_LIMITS,
    timezone: TZ,
    now: () => T0,
    ownerChatId: OWNER,
    hasHistory: async (chatId) => history.has(chatId),
    lookupLid: async (lid) => (lid === LID ? CHAT : null),
  });
  const fixed = (q: Record<string, unknown> = {}) =>
    service.schedule({
      chatId: CHAT,
      kind: "fixed",
      text: "Hola Ana, ¿confirmamos mañana?",
      at: "2026-11-18 09:00",
      repeat: "none",
      ...q,
    });
  return { authDb, store, missions, log, service, cancels, fixed };
}

const refusal = (message: string) => new InvalidInputError(message);

describe("schedule service: schedule()", () => {
  it("stores the metadata in the store and the text sealed in the schedule log", async () => {
    const h = harness();
    const { row, note } = await h.fixed({ text: "**Hola** Ana" });
    expect(note).toBeNull();
    expect(row).toMatchObject({
      tenantId: TENANT,
      chatId: CHAT,
      kind: "fixed",
      repeat: "none",
      maxRuns: 1,
      runsDone: 0,
      newContact: false,
      state: "active",
      // 09:00 in Lima.
      firstAt: "2026-11-18T14:00:00.000Z",
      nextRunAt: "2026-11-18T14:00:00.000Z",
    });
    // WhatsApp formatting, like send_text.
    expect(h.log.content(row.id)).toEqual({ text: "*Hola* Ana" });
    const dump = JSON.stringify(h.authDb.prepare("SELECT * FROM schedules").all());
    expect(dump).not.toContain("Hola");
  });

  it("stores an AI instruction sealed, never the text", async () => {
    const h = harness();
    const { row } = await h.service.schedule({
      chatId: CHAT,
      kind: "ai",
      instruction: "Remind Ana about the invoice if she has not paid",
      at: "2026-11-18 09:00",
      repeat: "weekly",
    });
    expect(h.log.content(row.id)).toEqual({
      instruction: "Remind Ana about the invoice if she has not paid",
    });
    expect(JSON.stringify(h.authDb.prepare("SELECT * FROM schedules").all())).not.toContain(
      "invoice",
    );
  });

  it("requires text and no instruction for fixed, and an instruction and no text for ai", async () => {
    const h = harness();
    await expect(h.fixed({ text: undefined })).rejects.toThrow(refusal(SCHEDULE_TEXTS.fixed));
    await expect(h.fixed({ instruction: "x" })).rejects.toThrow(refusal(SCHEDULE_TEXTS.fixed));
    await expect(h.fixed({ kind: "ai", text: undefined })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.ai),
    );
    await expect(h.fixed({ kind: "ai", instruction: "Say hi" })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.ai),
    );
    await expect(
      h.fixed({ kind: "ai", text: undefined, instruction: "x".repeat(2001) }),
    ).rejects.toThrow(refusal(SCHEDULE_TEXTS.instructionLength));
    await expect(h.fixed({ kind: "ai", text: undefined, instruction: "   " })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.ai),
    );
    expect(h.store.countActive(TENANT)).toBe(0);
  });

  it("applies send_text's length rule to the text", async () => {
    const h = harness();
    await expect(h.fixed({ text: "x".repeat(70_000) })).rejects.toThrow(InvalidInputError);
  });

  it("refuses chat ids that are neither a person nor a group", async () => {
    const h = harness();
    await expect(h.fixed({ chatId: "status@broadcast" })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.chatId),
    );
  });

  it("refuses a malformed or past time", async () => {
    const h = harness();
    await expect(h.fixed({ at: "18/11/2026 09:00" })).rejects.toThrow(InvalidInputError);
    await expect(h.fixed({ at: "2026-11-17 10:00" })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.past("2026-11-17 10:00", TZ)),
    );
    await expect(h.fixed({ at: "2026-11-17 09:59" })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.past("2026-11-17 10:00", TZ)),
    );
  });

  it("max_runs: only when repeating, default 12, between 1 and 52", async () => {
    const h = harness();
    await expect(h.fixed({ maxRuns: 3 })).rejects.toThrow(refusal(SCHEDULE_TEXTS.maxRunsOnce));
    expect((await h.fixed({ repeat: "daily" })).row.maxRuns).toBe(12);
    expect((await h.fixed({ repeat: "monthly", maxRuns: 52 })).row.maxRuns).toBe(52);
    await expect(h.fixed({ repeat: "daily", maxRuns: 53 })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.maxRuns(52)),
    );
    await expect(h.fixed({ repeat: "daily", maxRuns: 0 })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.maxRuns(52)),
    );
  });

  it("refuses the 21st active schedule", async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) await h.fixed();
    await expect(h.fixed()).rejects.toThrow(refusal(SCHEDULE_TEXTS.active(20)));
    expect(h.store.countActive(TENANT)).toBe(20);
  });

  it("marks a direct chat with no history, under any id form, as a new contact; groups never", async () => {
    const h = harness({ history: [] });
    expect((await h.fixed()).row.newContact).toBe(true);
    expect((await h.fixed({ chatId: GROUP })).row.newContact).toBe(false);
    const known = harness({ history: [CHAT] });
    // The @lid form maps to CHAT, which has history.
    expect((await known.fixed({ chatId: LID })).row.newContact).toBe(false);
  });

  it("shares the daily new-contact cap with missions: one mission and four schedules fill it", async () => {
    const h = harness({ history: [] });
    h.missions.create({
      tenantId: TENANT,
      chatId: "51933333333@c.us",
      newContact: true,
      deadlineAt: T0.toISOString(),
      expectsFiles: false,
    });
    for (let i = 0; i < 4; i++) await h.fixed();
    await expect(h.fixed()).rejects.toThrow(refusal(SCHEDULE_TEXTS.newContacts(5)));
    // A known contact is not a new one: still allowed.
    const known = await h.fixed({ chatId: GROUP });
    expect(known.row.state).toBe("active");
  });

  it("notes when the first run falls in quiet hours, except in the owner's own chat", async () => {
    const h = harness();
    const late = await h.fixed({ at: "2026-11-17 23:30" });
    expect(late.note).toBe(SCHEDULE_TEXTS.quietHours("22:00", "08:00", "2026-11-18 08:00"));
    expect(late.note).toBe(
      "This falls in quiet hours (22:00–08:00); it will be sent at 2026-11-18 08:00.",
    );
    expect((await h.fixed({ at: "2026-11-17 23:30", chatId: OWNER })).note).toBeNull();
  });
});

describe("schedule service: follow-ups (if no reply within)", () => {
  const followUp = (h: ReturnType<typeof harness>, q: Record<string, unknown> = {}) =>
    h.service.schedule({
      chatId: CHAT,
      kind: "ai",
      instruction: "Recuérdale con buen tono lo de la cotización",
      repeat: "none",
      ifNoReplyWithin: "3d",
      ...q,
    });

  it("runs once, the window after now, and stores now as the anchor", async () => {
    const h = harness();
    const { row, note } = await followUp(h);
    expect(note).toBeNull();
    expect(row).toMatchObject({
      chatId: CHAT,
      kind: "ai",
      repeat: "none",
      maxRuns: 1,
      state: "active",
      followUpSince: T0.toISOString(),
      firstAt: "2026-11-20T15:00:00.000Z",
      nextRunAt: "2026-11-20T15:00:00.000Z",
    });
    expect(h.store.get(TENANT, row.id)?.followUpSince).toBe(T0.toISOString());
    expect(h.log.content(row.id)).toEqual({
      instruction: "Recuérdale con buen tono lo de la cotización",
    });
    const hours = await followUp(h, { ifNoReplyWithin: "48h" });
    expect(hours.row.firstAt).toBe("2026-11-19T15:00:00.000Z");
    const fixed = await followUp(h, {
      kind: "fixed",
      instruction: undefined,
      text: "¿Pudiste ver la cotización?",
    });
    expect(fixed.row).toMatchObject({ kind: "fixed", followUpSince: T0.toISOString() });
  });

  it("stores the normalized chat id, like any schedule", async () => {
    const h = harness();
    const { row } = await followUp(h, { chatId: LID });
    expect(row.chatId).toBe(LID);
    const phone = await followUp(h, { chatId: "51911111111@s.whatsapp.net" });
    expect(phone.row.chatId).toBe(CHAT);
  });

  it("regular schedules have no anchor", async () => {
    const h = harness();
    expect((await h.fixed()).row.followUpSince).toBeNull();
  });

  it("takes either at or if_no_reply_within, never both, and needs one of them", async () => {
    const h = harness();
    await expect(followUp(h, { at: "2026-11-18 09:00" })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.followUpAt),
    );
    await expect(h.fixed({ at: undefined })).rejects.toThrow(refusal(SCHEDULE_TEXTS.needAt));
    expect(h.store.countActive(TENANT)).toBe(0);
  });

  it("refuses groups and repetition", async () => {
    const h = harness();
    await expect(followUp(h, { chatId: GROUP })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.followUpDirect),
    );
    await expect(followUp(h, { repeat: "daily" })).rejects.toThrow(
      refusal(SCHEDULE_TEXTS.followUpOnce),
    );
    await expect(followUp(h, { maxRuns: 2 })).rejects.toThrow(refusal(SCHEDULE_TEXTS.maxRunsOnce));
    expect(h.store.countActive(TENANT)).toBe(0);
  });

  it("accepts whole hours or days from 1h to 30d", async () => {
    const h = harness();
    for (const ok of ["1h", "720h", "1d", "30d", " 2D "])
      expect((await followUp(h, { ifNoReplyWithin: ok })).row.state).toBe("active");
    for (const bad of ["0h", "0d", "721h", "31d", "3w", "1.5d", "-1d", "d", "3", ""])
      await expect(followUp(h, { ifNoReplyWithin: bad })).rejects.toThrow(
        refusal(SCHEDULE_TEXTS.replyWindow),
      );
  });

  it("notes quiet hours for the run time, like any schedule", async () => {
    const h = harness();
    // 10:00 + 13 h = 23:00 in Lima.
    const { note } = await followUp(h, { ifNoReplyWithin: "13h" });
    expect(note).toBe(SCHEDULE_TEXTS.quietHours("22:00", "08:00", "2026-11-18 08:00"));
  });
});

describe("schedule service: list() and cancel()", () => {
  it("lists active schedules newest first with their content and last five runs", async () => {
    const h = harness();
    const a = (await h.fixed({ repeat: "daily" })).row;
    const b = (
      await h.service.schedule({
        chatId: GROUP,
        kind: "ai",
        instruction: "Wish the team a good week",
        at: "2026-11-23 09:00",
        repeat: "weekly",
      })
    ).row;
    for (let i = 0; i < 7; i++)
      h.log.appendRun(a.id, { at: `2026-11-1${i}T14:00:00.000Z`, outcome: "sent", text: "t" });
    const list = h.service.list();
    expect(list.map((x) => x.row.id)).toEqual([b.id, a.id]);
    expect(list[0]?.content).toEqual({ instruction: "Wish the team a good week" });
    expect(list[1]?.content).toEqual({ text: "Hola Ana, ¿confirmamos mañana?" });
    expect(list[1]?.runs).toHaveLength(5);
    expect(list[1]?.runs[0]?.at).toBe("2026-11-16T14:00:00.000Z");
  });

  it("cancels through the runner and refuses unknown or ended schedules", async () => {
    const h = harness();
    const { row } = await h.fixed();
    expect(() => h.service.cancel("nope")).toThrow(refusal(SCHEDULE_TEXTS.notFound));
    expect(h.service.cancel(row.id).state).toBe("cancelled");
    expect(h.cancels).toEqual([`${TENANT}/${row.id}`]);
    expect(() => h.service.cancel(row.id)).toThrow(
      refusal(SCHEDULE_TEXTS.notActive(row.id, "cancelled")),
    );
    expect(h.service.list()).toEqual([]);
  });
});

describe("schedule service: history()", () => {
  it("lists every schedule, ended ones included, newest first, with up to 20 runs each", async () => {
    const h = harness();
    const a = (await h.fixed({ repeat: "daily" })).row;
    const b = (await h.fixed({ text: "Otro recordatorio" })).row;
    h.service.cancel(b.id);
    for (let i = 0; i < 25; i++)
      h.log.appendRun(a.id, {
        at: new Date(Date.UTC(2026, 10, 1, 14) + i * 86_400_000).toISOString(),
        outcome: "sent",
        text: "t",
      });
    const history = h.service.history();
    expect(history.map((x) => [x.row.id, x.row.state])).toEqual([
      [b.id, "cancelled"],
      [a.id, "active"],
    ]);
    expect(history[0]?.content).toEqual({ text: "Otro recordatorio" });
    expect(history[1]?.runs).toHaveLength(20);
    expect(h.service.list().map((x) => x.row.id)).toEqual([a.id]);
  });

  it("is limited to the given number of schedules", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.fixed({ text: `r${i}` });
    expect(h.service.history(2)).toHaveLength(2);
  });
});
