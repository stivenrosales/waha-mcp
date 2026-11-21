import { DatabaseSync } from "node:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createScheduleRunner } from "../../../src/application/schedules/runner.js";
import { scheduleTexts } from "../../../src/application/schedules/texts.js";
import { LlmUnavailableError, SendOutcomeUnknownError } from "../../../src/domain/errors.js";
import { DEFAULT_MISSION_LIMITS } from "../../../src/domain/missions/limits.js";
import type {
  LlmClient,
  LlmTurnRequest,
  LlmTurnResult,
} from "../../../src/domain/ports/LlmClient.js";
import type { ScheduleRow } from "../../../src/domain/ports/ScheduleStore.js";
import type { SentMessage, WhatsAppSender } from "../../../src/domain/ports/WhatsAppSender.js";
import type { ScheduleRepeat } from "../../../src/domain/schedules/recurrence.js";
import { createSqliteMissionStore } from "../../../src/infrastructure/missions/sqliteMissionStore.js";
import { createSealedScheduleLog } from "../../../src/infrastructure/schedules/sealedScheduleLog.js";
import { createSqliteScheduleStore } from "../../../src/infrastructure/schedules/sqliteScheduleStore.js";
import { RecordingSender } from "../../fakes/InMemoryWahaGateway.js";
import { testCipher } from "../../fakes/testCipher.js";

const TENANT = "t1";
const OWNER = "51999000000@c.us";
const CHAT = "51911111111@c.us";
const LID = "123456789012345@lid";
const TZ = "America/Lima";
/** 10:00 in Lima (UTC-5, no DST). */
const T0 = new Date("2026-11-17T15:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

class Sender extends RecordingSender {
  fail?: Error;
  override async sendText(q: Parameters<WhatsAppSender["sendText"]>[0]): Promise<SentMessage> {
    if (this.fail && q.chatId !== OWNER) throw this.fail;
    return super.sendText(q);
  }
  texts(chatId: string): string[] {
    return this.calls
      .filter((c) => c.method === "sendText" && (c.args as { chatId: string }).chatId === chatId)
      .map((c) => (c.args as { text: string }).text);
  }
}

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

class FakeLlm implements LlmClient {
  requests: LlmTurnRequest[] = [];
  queue: (LlmTurnResult | Error)[] = [];
  async turn(q: LlmTurnRequest): Promise<LlmTurnResult> {
    this.requests.push(q);
    const next = this.queue.shift();
    if (!next) throw new Error("no scripted LLM reply");
    if (next instanceof Error) throw next;
    return next;
  }
}

const decide = (input: Record<string, unknown>): LlmTurnResult => ({
  content: [
    { type: "tool_use", id: "toolu_1", name: "decide", input } as unknown as Anthropic.ContentBlock,
  ],
  stopReason: "tool_use",
  usage,
});

function harness(opts: { spend?: number; revoked?: boolean; failAdvance?: boolean } = {}) {
  let now = T0;
  const authDb = new DatabaseSync(":memory:");
  const cacheDb = new DatabaseSync(":memory:");
  const store = createSqliteScheduleStore(authDb, () => now.toISOString());
  const missions = createSqliteMissionStore(authDb, () => now.toISOString());
  const log = createSealedScheduleLog(cacheDb, testCipher(TENANT));
  const sender = new Sender();
  const llm = new FakeLlm();
  const usageRows: object[] = [];
  const hooks: { sleep?: () => Promise<void> } = {};
  const tenants = {
    getTenant: (id: string) =>
      id === TENANT
        ? {
            id,
            wahaSession: "s1",
            displayName: "Stiven",
            status: "active" as const,
            waId: OWNER,
            createdAt: 0,
          }
        : null,
    recordLlmUsage: (q: object) => {
      usageRows.push(q);
    },
    llmSpendUsd: () => opts.spend ?? 0,
  };
  /** With `failAdvance`, recording a finished run fails like a database error would. */
  const runnerStore: typeof store = {
    ...store,
    update(id, patch) {
      if (opts.failAdvance && patch.runsDone !== undefined) throw new Error("db locked");
      store.update(id, patch);
    },
  };
  const runner = createScheduleRunner({
    store: runnerStore,
    missions,
    tenants,
    acquire: (id) =>
      id === TENANT && !opts.revoked
        ? {
            port: {
              sender,
              log,
              readContext: async () => [],
              lookupLid: async (lid) => (lid === LID ? CHAT : null),
            },
            release() {},
          }
        : null,
    llm,
    model: "anthropic/claude-haiku-5.5",
    monthlyBudgetUsd: 1,
    limits: DEFAULT_MISSION_LIMITS,
    missedAfterMs: 60 * MIN,
    timezone: TZ,
    paced: { sleep: async () => hooks.sleep?.(), rand: () => 0.5 },
    now: () => now,
    logger: { info: () => {} },
  });

  function schedule(
    q: {
      chatId?: string;
      kind?: "fixed" | "ai";
      repeat?: ScheduleRepeat;
      first?: Date;
      maxRuns?: number;
    } & ({ text: string } | { instruction: string }),
  ): ScheduleRow {
    const first = q.first ?? T0;
    const row = store.create({
      tenantId: TENANT,
      chatId: q.chatId ?? CHAT,
      kind: q.kind ?? ("text" in q ? "fixed" : "ai"),
      repeat: q.repeat ?? "none",
      firstAt: first.toISOString(),
      nextRunAt: first.toISOString(),
      maxRuns: q.maxRuns ?? (q.repeat && q.repeat !== "none" ? 12 : 1),
      newContact: false,
    });
    log.putContent(row.id, "text" in q ? { text: q.text } : { instruction: q.instruction });
    return row;
  }

  return {
    store,
    missions,
    log,
    sender,
    llm,
    usageRows,
    hooks,
    runner,
    schedule,
    row: (id: string) => store.get(TENANT, id) as ScheduleRow,
    async tickAt(t: Date) {
      now = t;
      await runner.tick(t);
    },
    setNow(t: Date) {
      now = t;
    },
  };
}

describe("schedule runner", () => {
  it("sends fixed text and schedules the next occurrence", async () => {
    const h = harness();
    const s = h.schedule({ text: "Buenos días, equipo", repeat: "daily" });
    await h.tickAt(T0);
    expect(h.sender.texts(CHAT)).toEqual(["Buenos días, equipo"]);
    const row = h.row(s.id);
    expect(row.runsDone).toBe(1);
    expect(row.nextRunAt).toBe(at(T0, DAY).toISOString());
    expect(row.state).toBe("active");
    expect(h.sender.texts(OWNER)).toEqual([]);
    expect(h.log.runs(s.id, 10)).toEqual([
      { at: T0.toISOString(), outcome: "sent", text: "Buenos días, equipo" },
    ]);
  });

  it("does nothing before the run is due", async () => {
    const h = harness();
    const s = h.schedule({ text: "Hola", first: at(T0, HOUR) });
    await h.tickAt(T0);
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.row(s.id).runsDone).toBe(0);
  });

  it("one-time schedule ends as done", async () => {
    const h = harness();
    const s = h.schedule({ text: "Recordatorio" });
    await h.tickAt(T0);
    const row = h.row(s.id);
    expect(row.state).toBe("done");
    expect(row.endedAt).toBe(T0.toISOString());
    expect(row.nextRunAt).toBeNull();
    expect(row.runsDone).toBe(1);
    expect(h.sender.texts(OWNER)).toEqual([]);
    await h.tickAt(at(T0, DAY));
    expect(h.sender.texts(CHAT)).toEqual(["Recordatorio"]);
  });

  it("max_runs reached ends the schedule and notifies", async () => {
    const h = harness();
    const s = h.schedule({ text: "Hola", repeat: "daily", maxRuns: 2 });
    await h.tickAt(T0);
    await h.tickAt(at(T0, DAY));
    const row = h.row(s.id);
    expect(row.state).toBe("done");
    expect(row.runsDone).toBe(2);
    expect(h.sender.texts(CHAT)).toEqual(["Hola", "Hola"]);
    expect(h.sender.texts(OWNER)).toEqual([scheduleTexts.ended("+51911111111")]);
    await h.tickAt(at(T0, 2 * DAY));
    expect(h.sender.texts(CHAT)).toHaveLength(2);
  });

  it("quiet hours postpone to 08:00 for other chats", async () => {
    const h = harness();
    // 23:00 in Lima.
    const late = new Date("2026-11-18T04:00:00.000Z");
    const s = h.schedule({ text: "Hola", first: late });
    await h.tickAt(late);
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.row(s.id).nextRunAt).toBe("2026-11-18T13:00:00.000Z");
    expect(h.row(s.id).runsDone).toBe(0);
    await h.tickAt(new Date("2026-11-18T13:00:00.000Z"));
    expect(h.sender.texts(CHAT)).toEqual(["Hola"]);
    expect(h.row(s.id).state).toBe("done");
  });

  it("owner chat ignores quiet hours", async () => {
    const h = harness();
    const late = new Date("2026-11-18T04:00:00.000Z");
    h.schedule({ text: "Tomar la pastilla", first: late, chatId: OWNER });
    await h.tickAt(late);
    expect(h.sender.texts(OWNER)).toEqual(["Tomar la pastilla"]);
  });

  it("pause postpones until the pause ends", async () => {
    const h = harness();
    const until = at(T0, 3 * HOUR);
    h.missions.pause(TENANT, T0.toISOString(), until.toISOString());
    const s = h.schedule({ text: "Hola" });
    await h.tickAt(T0);
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.row(s.id).nextRunAt).toBe(until.toISOString());
    await h.tickAt(at(until, 10 * MIN));
    expect(h.sender.texts(CHAT)).toEqual(["Hola"]);
  });

  it("owner chat ignores the pause", async () => {
    const h = harness();
    h.missions.pause(TENANT, T0.toISOString(), at(T0, 3 * HOUR).toISOString());
    h.schedule({ text: "Nota", chatId: OWNER });
    await h.tickAt(T0);
    expect(h.sender.texts(OWNER)).toEqual(["Nota"]);
  });

  it("server down three days logs three missed and no sends", async () => {
    const h = harness();
    const s = h.schedule({ text: "Hola", repeat: "daily" });
    await h.tickAt(T0);
    const now = at(T0, 3 * DAY + 2 * HOUR);
    await h.tickAt(now);
    expect(h.sender.texts(CHAT)).toEqual(["Hola"]);
    const runs = h.log.runs(s.id, 10);
    expect(runs.map((r) => r.outcome)).toEqual(["missed", "missed", "missed", "sent"]);
    expect(h.sender.texts(OWNER)).toEqual([scheduleTexts.missed("+51911111111", 3)]);
    const row = h.row(s.id);
    expect(row.runsDone).toBe(4);
    expect(row.nextRunAt).toBe(at(T0, 4 * DAY).toISOString());
    expect(Date.parse(row.nextRunAt as string)).toBeGreaterThan(now.getTime());
  });

  it("missed runs stop at max_runs and end the schedule", async () => {
    const h = harness();
    const s = h.schedule({ text: "Hola", repeat: "daily", maxRuns: 2 });
    await h.tickAt(at(T0, 5 * DAY));
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.log.runs(s.id, 10).map((r) => r.outcome)).toEqual(["missed", "missed"]);
    const row = h.row(s.id);
    expect(row.state).toBe("done");
    expect(row.runsDone).toBe(2);
    expect(h.sender.texts(OWNER)).toEqual([
      scheduleTexts.missed("+51911111111", 2),
      scheduleTexts.ended("+51911111111"),
    ]);
  });

  it("a late run inside quiet hours is missed, not postponed and sent later", async () => {
    const h = harness();
    // Due 20:00 Lima, the server comes back at 23:30 Lima.
    const first = new Date("2026-11-18T01:00:00.000Z");
    const s = h.schedule({ text: "Hola", first });
    await h.tickAt(new Date("2026-11-18T04:30:00.000Z"));
    await h.tickAt(new Date("2026-11-18T13:00:00.000Z"));
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.row(s.id).state).toBe("done");
    expect(h.log.runs(s.id, 10).map((r) => r.outcome)).toEqual(["missed"]);
  });

  it("late under the threshold still sends", async () => {
    const h = harness();
    h.schedule({ text: "Hola" });
    await h.tickAt(at(T0, 30 * MIN));
    expect(h.sender.texts(CHAT)).toEqual(["Hola"]);
  });

  it("active mission on the chat skips", async () => {
    const h = harness();
    h.missions.create({
      tenantId: TENANT,
      chatId: CHAT,
      newContact: false,
      deadlineAt: at(T0, DAY).toISOString(),
      expectsFiles: false,
    });
    const s = h.schedule({ text: "Hola", chatId: LID, repeat: "daily" });
    await h.tickAt(T0);
    expect(h.sender.texts(LID)).toEqual([]);
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.log.runs(s.id, 10)).toEqual([
      { at: T0.toISOString(), outcome: "skipped", reason: "hay una misión activa en este chat" },
    ]);
    expect(h.row(s.id).runsDone).toBe(1);
    expect(h.row(s.id).nextRunAt).toBe(at(T0, DAY).toISOString());
  });

  it("ai send notifies the owner with the text", async () => {
    const h = harness();
    h.llm.queue.push(decide({ action: "send", text: "Hola Ana, ¿cómo vas?", reason: "toca" }));
    const s = h.schedule({ instruction: "Saluda a Ana" });
    await h.tickAt(T0);
    expect(h.sender.texts(CHAT)).toEqual(["Hola Ana, ¿cómo vas?"]);
    expect(h.sender.texts(OWNER)).toEqual([
      scheduleTexts.sent("+51911111111", "Hola Ana, ¿cómo vas?"),
    ]);
    expect(h.log.runs(s.id, 10)[0]).toMatchObject({
      outcome: "sent",
      text: "Hola Ana, ¿cómo vas?",
    });
  });

  it("ai skip notifies with the reason and sends nothing", async () => {
    const h = harness();
    h.llm.queue.push(decide({ action: "skip", reason: "ya respondió" }));
    const s = h.schedule({ instruction: "Pregunta si recibió el pago" });
    await h.tickAt(T0);
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.sender.texts(OWNER)).toEqual([scheduleTexts.skipped("+51911111111", "ya respondió")]);
    expect(h.log.runs(s.id, 10)[0]).toMatchObject({ outcome: "skipped", reason: "ya respondió" });
    expect(h.row(s.id).state).toBe("done");
  });

  it("ai budget used up skips without calling the llm", async () => {
    const h = harness({ spend: 1 });
    const s = h.schedule({ instruction: "Saluda" });
    await h.tickAt(T0);
    expect(h.llm.requests).toHaveLength(0);
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.sender.texts(OWNER)).toEqual([
      scheduleTexts.skipped("+51911111111", "presupuesto mensual agotado"),
    ]);
    expect(h.log.runs(s.id, 10)[0]).toMatchObject({
      outcome: "skipped",
      reason: "presupuesto mensual agotado",
    });
  });

  it("records llm usage with the schedule id", async () => {
    const h = harness();
    h.llm.queue.push(decide({ action: "skip", reason: "no hace falta" }));
    const s = h.schedule({ instruction: "Saluda" });
    await h.tickAt(T0);
    expect(h.usageRows).toEqual([
      {
        tenantId: TENANT,
        missionId: s.id,
        at: T0.toISOString(),
        model: "anthropic/claude-haiku-5.5",
        kind: "agent",
        usage,
      },
    ]);
  });

  it("ai model failure skips, notifies and never retries", async () => {
    const h = harness();
    h.llm.queue.push(new LlmUnavailableError());
    const s = h.schedule({ instruction: "Saluda" });
    await h.tickAt(T0);
    await h.tickAt(at(T0, 5 * MIN));
    expect(h.llm.requests).toHaveLength(1);
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.sender.texts(OWNER)).toEqual([
      scheduleTexts.skipped("+51911111111", "el modelo no respondió"),
    ]);
    expect(h.row(s.id).state).toBe("done");
  });

  it("send failure logs failed, notifies, never retries", async () => {
    const h = harness();
    h.sender.fail = new Error("boom");
    const s = h.schedule({ text: "Hola", repeat: "daily" });
    await h.tickAt(T0);
    await h.tickAt(at(T0, 5 * MIN));
    expect(h.log.runs(s.id, 10)).toEqual([{ at: T0.toISOString(), outcome: "failed" }]);
    expect(h.sender.texts(OWNER)).toEqual([scheduleTexts.failed("+51911111111")]);
    expect(h.row(s.id).runsDone).toBe(1);
    expect(h.row(s.id).nextRunAt).toBe(at(T0, DAY).toISOString());
  });

  it("a run that cannot be recorded after sending is never sent again", async () => {
    const h = harness({ failAdvance: true });
    h.schedule({ text: "Hola", repeat: "daily" });
    await h.tickAt(T0);
    await h.tickAt(at(T0, MIN));
    await h.tickAt(at(T0, 2 * MIN));
    expect(h.sender.texts(CHAT)).toEqual(["Hola"]);
  });

  it("SendOutcomeUnknownError logs unknown", async () => {
    const h = harness();
    h.sender.fail = new SendOutcomeUnknownError();
    const s = h.schedule({ text: "Hola" });
    await h.tickAt(T0);
    expect(h.log.runs(s.id, 10)).toEqual([{ at: T0.toISOString(), outcome: "unknown" }]);
    expect(h.sender.texts(OWNER)).toEqual([scheduleTexts.unknown("+51911111111")]);
    expect(h.row(s.id).state).toBe("done");
  });

  it("cancel during the typing pause sends nothing", async () => {
    const h = harness();
    let resume = () => {};
    let paused = () => {};
    const inPause = new Promise<void>((r) => {
      paused = r;
    });
    h.hooks.sleep = () =>
      new Promise<void>((r) => {
        resume = r;
        paused();
      });
    const s = h.schedule({ text: "Hola", repeat: "daily" });
    const ticking = h.tickAt(T0);
    await inPause;
    expect(h.runner.cancel(TENANT, s.id)).toBe(true);
    resume();
    await ticking;
    expect(h.sender.texts(CHAT)).toEqual([]);
    const row = h.row(s.id);
    expect(row.state).toBe("cancelled");
    expect(row.endedAt).toBe(T0.toISOString());
    expect(row.runsDone).toBe(0);
    expect(h.log.runs(s.id, 10)).toEqual([]);
  });

  it("cancel of a schedule waiting behind another run in the same tick runs nothing", async () => {
    const h = harness();
    let resume = () => {};
    let paused = () => {};
    const inPause = new Promise<void>((r) => {
      paused = r;
    });
    h.hooks.sleep = () =>
      new Promise<void>((r) => {
        resume = r;
        paused();
      });
    h.schedule({ text: "Primero", first: at(T0, -MIN) });
    const second = h.schedule({ instruction: "Saluda" });
    const ticking = h.tickAt(T0);
    await inPause;
    expect(h.runner.cancel(TENANT, second.id)).toBe(true);
    resume();
    await ticking;
    expect(h.llm.requests).toHaveLength(0);
    expect(h.log.runs(second.id, 10)).toEqual([]);
    expect(h.sender.texts(OWNER)).toEqual([]);
  });

  it("cancel returns false for unknown or ended schedules", async () => {
    const h = harness();
    const s = h.schedule({ text: "Hola" });
    expect(h.runner.cancel(TENANT, "nope")).toBe(false);
    expect(h.runner.cancel("t2", s.id)).toBe(false);
    expect(h.runner.cancel(TENANT, s.id)).toBe(true);
    expect(h.runner.cancel(TENANT, s.id)).toBe(false);
    await h.tickAt(T0);
    expect(h.sender.texts(CHAT)).toEqual([]);
  });

  it("revoked tenant is left untouched", async () => {
    const h = harness({ revoked: true });
    const s = h.schedule({ text: "Hola", repeat: "daily" });
    await h.tickAt(T0);
    expect(h.sender.calls).toEqual([]);
    expect(h.row(s.id)).toEqual(s);
    expect(h.log.runs(s.id, 10)).toEqual([]);
  });

  it("catchUp marks passed occurrences missed with one summary note", async () => {
    const h = harness();
    const a = h.schedule({ text: "A", repeat: "daily" });
    const b = h.schedule({ text: "B" });
    const c = h.schedule({ text: "C", first: at(T0, 10 * DAY) });
    const now = at(T0, 2 * DAY + 2 * HOUR);
    h.setNow(now);
    await h.runner.catchUp(TENANT, now);
    expect(h.sender.texts(CHAT)).toEqual([]);
    expect(h.sender.texts(OWNER)).toEqual([scheduleTexts.restoredMissed(4)]);
    expect(h.log.runs(a.id, 10).map((r) => r.outcome)).toEqual(["missed", "missed", "missed"]);
    expect(h.row(a.id).nextRunAt).toBe(at(T0, 3 * DAY).toISOString());
    expect(h.row(a.id).runsDone).toBe(3);
    expect(h.row(b.id).state).toBe("done");
    expect(h.row(c.id)).toEqual(c);
  });

  it("catchUp with nothing passed sends no note", async () => {
    const h = harness();
    h.schedule({ text: "A", first: at(T0, DAY) });
    await h.runner.catchUp(TENANT, T0);
    expect(h.sender.calls).toEqual([]);
  });
});
