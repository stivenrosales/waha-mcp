import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createMissionEngine } from "../../../../src/application/missions/engine.js";
import {
  createMissionService,
  type MissionService,
} from "../../../../src/application/missions/service.js";
import { loadConfig } from "../../../../src/config.js";
import { DEFAULT_MISSION_LIMITS } from "../../../../src/domain/missions/limits.js";
import type { LlmClient } from "../../../../src/domain/ports/LlmClient.js";
import {
  createToolHandler,
  type ToolDefinition,
  type ToolDeps,
} from "../../../../src/infrastructure/mcp/defineTool.js";
import { createTools } from "../../../../src/infrastructure/mcp/tools/index.js";
import { createSealedMissionLog } from "../../../../src/infrastructure/missions/sealedMissionLog.js";
import { createSqliteEventStore } from "../../../../src/infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "../../../../src/infrastructure/missions/sqliteMissionStore.js";
import { gowsMapper } from "../../../../src/infrastructure/waha/engines/gows.js";
import { RecordingSender } from "../../../fakes/InMemoryWahaGateway.js";
import { testCipher } from "../../../fakes/testCipher.js";

const TENANT = "t1";
const OWNER = "51999000000@c.us";
const CHAT = "51911111111@c.us";
const OTHER = "51922222222@c.us";
const TZ = "America/Lima";
/** 10:00 in Lima (UTC-5). */
const T0 = new Date("2026-11-17T15:00:00.000Z");
const MIN = 60_000;

const config = loadConfig({
  WAHA_API_URL: "http://waha:3000",
  WAHA_API_KEY: "k",
  PUBLIC_BASE_URL: "https://mcp.example.com",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery",
  TIMEZONE: TZ,
});

const tools = createTools();
const tool = (name: string): ToolDefinition => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const noLlm: LlmClient = {
  turn: async () => {
    throw new Error("no LLM in tool tests");
  },
};

function harness(opts: { spend?: number; withHistory?: string[] } = {}) {
  let now = T0;
  const authDb = new DatabaseSync(":memory:");
  const store = createSqliteMissionStore(authDb, () => now.toISOString());
  const events = createSqliteEventStore(authDb, () => now.toISOString());
  const log = createSealedMissionLog(new DatabaseSync(":memory:"), testCipher(TENANT));
  const sender = new RecordingSender();
  const state = { spend: opts.spend ?? 0 };
  const history = new Set(opts.withHistory ?? [CHAT]);
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
    recordLlmUsage: () => {},
    llmSpendUsd: () => state.spend,
  };
  const engine = createMissionEngine({
    missions: store,
    events,
    tenants,
    llm: noLlm,
    model: "m",
    limits: DEFAULT_MISSION_LIMITS,
    monthlyBudgetUsd: 1,
    timezone: TZ,
    acquire: (id) =>
      id === TENANT
        ? {
            port: {
              log,
              sender,
              openEvent: () => "",
              mapper: async () => gowsMapper,
              lookupLid: async () => null,
              transcribe: async () => null,
              fetchMedia: async () => null,
            },
            release() {},
          }
        : null,
    now: () => now,
    rand: () => 0.5,
    sleep: async () => {},
    logger: { info: () => {} },
  });
  const wakes: number[] = [];
  const takeOvers: string[] = [];
  const service: MissionService = createMissionService({
    tenantId: TENANT,
    store,
    log,
    tenants,
    engine: {
      cancel: engine.cancel,
      answer: engine.answer,
      takeOver: async (tenantId, missionId) => {
        takeOvers.push(missionId);
        return engine.takeOver(tenantId, missionId);
      },
      // Recorded only: a real tick would call the (absent) LLM.
      wake: () => wakes.push(1),
    },
    limits: DEFAULT_MISSION_LIMITS,
    monthlyBudgetUsd: 1,
    timezone: TZ,
    now: () => now,
    hasHistory: async (chatId) => history.has(chatId),
  });
  const deps = (missions: MissionService | null): ToolDeps =>
    ({
      mapper: async () => gowsMapper,
      config,
      sender,
      missions,
    }) as unknown as ToolDeps;
  const call = async (name: string, input: Record<string, unknown>, missions = service) => {
    const parsed = tool(name).inputSchema.parse(input);
    const r = await createToolHandler(tool(name), deps(missions))(parsed);
    return {
      isError: r.isError === true,
      text: (r.content[0] as { text: string }).text,
      data: r.structuredContent as Record<string, unknown> | undefined,
    };
  };
  const startInput = (q: Record<string, unknown> = {}) => ({
    chat_id: CHAT,
    system_prompt: "You are Stiven's assistant.",
    objective: "Book a meeting with Ana this week.",
    done_when: "Ana confirms a day and time.",
    max_duration_minutes: 60,
    ...q,
  });
  return {
    store,
    log,
    sender,
    state,
    engine,
    wakes,
    takeOvers,
    service,
    call,
    startInput,
    at(ms: number) {
      now = new Date(T0.getTime() + ms);
    },
    get now() {
      return now;
    },
    byChat(chatId: string) {
      return store.list(TENANT).find((m) => m.chatId === chatId);
    },
  };
}

describe("mission tools", () => {
  it("are registered with write annotations for start/answer/cancel and read-only for get/list", () => {
    for (const n of ["start_mission", "answer_mission", "cancel_mission"])
      expect(tool(n).annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    for (const n of ["get_mission", "list_missions"]) expect(tool(n).annotations).toBeUndefined();
  });

  it("start_mission carries the prompt-writing guidance and the WhatsApp formatting rules", () => {
    const d = tool("start_mission").description;
    for (const needle of [
      "assistant",
      "what counts as done",
      "likely answers",
      "never commit",
      "insists",
      "WhatsApp formatting",
    ])
      expect(d).toContain(needle);
  });

  it("refuses every mission tool when missions are not configured", async () => {
    const h = harness();
    const msg = "Missions are not configured on this server.";
    for (const [name, input] of [
      ["start_mission", h.startInput()],
      ["get_mission", { mission_id: "x" }],
      ["list_missions", {}],
      ["answer_mission", { mission_id: "x", answer: "yes" }],
      ["cancel_mission", { mission_id: "x" }],
    ] as const) {
      const r = await h.call(name, input, null as unknown as MissionService);
      expect(r).toMatchObject({ isError: true, text: msg });
    }
  });

  it("rejects a group chat id", async () => {
    const h = harness();
    const r = await h.call("start_mission", h.startInput({ chat_id: "120363000000@g.us" }));
    expect(r).toMatchObject({ isError: true, text: "Group missions are not available yet." });
    expect(h.store.list(TENANT)).toEqual([]);
  });

  it("starts a mission: stores the prompt and spec, wakes the engine, reports id and deadline", async () => {
    const h = harness();
    const r = await h.call("start_mission", h.startInput({ closing_message: true }));
    expect(r.isError).toBe(false);
    const [m] = h.store.list(TENANT);
    expect(m).toMatchObject({
      chatId: CHAT,
      state: "active",
      newContact: false,
      deadlineAt: new Date(T0.getTime() + 60 * MIN).toISOString(),
      nextWakeAt: T0.toISOString(),
      closingMessage: "yes",
      expectsFiles: false,
    });
    expect(r.data).toMatchObject({
      mission_id: m?.id,
      deadline_at: m?.deadlineAt,
      new_contact: false,
      deadline_in_quiet_hours: false,
    });
    expect(r.text).toContain(`Mission ${m?.id} started`);
    expect(r.text).not.toContain("quiet hours");
    expect(h.log.read(m?.id as string).map((e) => e.kind)).toEqual(["prompt", "spec"]);
    expect(h.wakes).toHaveLength(1);
  });

  it("marks a chat without prior messages as a new contact", async () => {
    const h = harness({ withHistory: [] });
    const r = await h.call("start_mission", h.startInput({ expects_files: true }));
    expect(r.data).toMatchObject({ new_contact: true });
    expect(h.store.list(TENANT)[0]).toMatchObject({ newContact: true, expectsFiles: true });
  });

  it("notes when the deadline falls in quiet hours", async () => {
    const h = harness();
    h.at(11 * 60 * MIN + 30 * MIN); // 21:30 Lima: the deadline (+60 min) is 22:30
    const r = await h.call("start_mission", h.startInput());
    expect(r.isError).toBe(false);
    expect(r.text).toContain(
      "The deadline falls in quiet hours (22:00–08:00); the agent will not start conversations then.",
    );
    expect(r.data).toMatchObject({ deadline_in_quiet_hours: true });
  });

  it("refuses when the monthly budget is used up", async () => {
    const h = harness({ spend: 1 });
    const r = await h.call("start_mission", h.startInput());
    expect(r).toMatchObject({
      isError: true,
      text: "The monthly mission budget of this account is used up; missions can start again next month.",
    });
    expect(h.store.list(TENANT)).toEqual([]);
  });

  it("refuses a fourth active mission", async () => {
    const h = harness({ withHistory: ["a@c.us", "b@c.us", "c@c.us", "d@c.us"] });
    for (const chat of ["a@c.us", "b@c.us", "c@c.us"])
      expect((await h.call("start_mission", h.startInput({ chat_id: chat }))).isError).toBe(false);
    const r = await h.call("start_mission", h.startInput({ chat_id: "d@c.us" }));
    expect(r).toMatchObject({
      isError: true,
      text: "This account already has 3 active missions; wait for one to finish or cancel one.",
    });
  });

  it("refuses a sixth new contact in the same day", async () => {
    const h = harness({ withHistory: [] });
    for (const chat of ["1@c.us", "2@c.us", "3@c.us"])
      await h.call("start_mission", h.startInput({ chat_id: chat }));
    // Free the active slots: cancelled missions still count as today's new contacts.
    for (const m of h.store.list(TENANT)) await h.call("cancel_mission", { mission_id: m.id });
    for (const chat of ["4@c.us", "5@c.us"])
      expect((await h.call("start_mission", h.startInput({ chat_id: chat }))).isError).toBe(false);
    const r = await h.call("start_mission", h.startInput({ chat_id: "6@c.us" }));
    expect(r).toMatchObject({
      isError: true,
      text: "Missions to 5 new contacts were already started today; try again tomorrow.",
    });
  });

  it("refuses a second active mission in the same chat", async () => {
    const h = harness();
    await h.call("start_mission", h.startInput());
    const [m] = h.store.list(TENANT);
    const r = await h.call("start_mission", h.startInput());
    expect(r).toMatchObject({
      isError: true,
      text: `This chat already has an active mission (${m?.id}).`,
    });
  });

  it("cancel_mission ends the mission as cancelled", async () => {
    const h = harness();
    await h.call("start_mission", h.startInput());
    const [m] = h.store.list(TENANT);
    const r = await h.call("cancel_mission", { mission_id: m?.id });
    expect(r).toMatchObject({ isError: false, text: `Mission ${m?.id} cancelled.` });
    expect(h.store.get(TENANT, m?.id as string)?.state).toBe("cancelled");
    const again = await h.call("cancel_mission", { mission_id: m?.id });
    expect(again).toMatchObject({
      isError: true,
      text: `Mission ${m?.id} is not active (cancelled).`,
    });
    expect(await h.call("cancel_mission", { mission_id: "nope" })).toMatchObject({
      isError: true,
      text: "Mission not found.",
    });
  });

  it("answer_mission logs the answer for the agent and wakes the engine", async () => {
    const h = harness();
    await h.call("start_mission", h.startInput());
    const [m] = h.store.list(TENANT);
    h.wakes.length = 0;
    h.at(MIN);
    const r = await h.call("answer_mission", { mission_id: m?.id, answer: "Tuesday at 3 works." });
    expect(r).toMatchObject({ isError: false, text: `Answer delivered to mission ${m?.id}.` });
    const last = h.log.read(m?.id as string).at(-1);
    expect(last).toMatchObject({ kind: "answer", body: { text: "Tuesday at 3 works." } });
    expect(h.store.get(TENANT, m?.id as string)?.nextWakeAt).toBe(h.now.toISOString());
    expect(h.wakes).toHaveLength(1);
  });

  it("get_mission and list_missions report state, objective, questions and outcome", async () => {
    const h = harness({ withHistory: [CHAT, OTHER] });
    await h.call("start_mission", h.startInput());
    await h.call("start_mission", h.startInput({ chat_id: OTHER }));
    const [a, b] = [h.byChat(CHAT), h.byChat(OTHER)];
    h.log.append(a?.id as string, {
      kind: "question",
      at: T0.toISOString(),
      body: { question: "Can it be on Friday?" },
    });
    const got = await h.call("get_mission", { mission_id: a?.id });
    expect(got.isError).toBe(false);
    expect(got.data).toMatchObject({
      id: a?.id,
      chat_id: CHAT,
      state: "active",
      objective: "Book a meeting with Ana this week.",
      pending_questions: ["Can it be on Friday?"],
    });
    expect(got.text).toContain("Can it be on Friday?");
    await h.call("cancel_mission", { mission_id: b?.id });
    const active = await h.call("list_missions", { state: "active" });
    expect((active.data as { missions: { id: string }[] }).missions.map((m) => m.id)).toEqual([
      a?.id,
    ]);
    const all = await h.call("list_missions", {});
    expect((all.data as { missions: { id: string }[] }).missions.map((m) => m.id).sort()).toEqual(
      [a?.id, b?.id].sort(),
    );
    expect(await h.call("get_mission", { mission_id: "nope" })).toMatchObject({
      isError: true,
      text: "Mission not found.",
    });
  });

  it("appends the outcome notice once to the next successful result, then marks it seen", async () => {
    const h = harness({ withHistory: [CHAT, OTHER] });
    await h.call("start_mission", h.startInput());
    await h.call("start_mission", h.startInput({ chat_id: OTHER }));
    for (const m of h.store.list(TENANT)) await h.engine.cancel(TENANT, m.id);
    // An error result does not consume the notice.
    const failed = await h.call("get_mission", { mission_id: "nope" });
    expect(failed.text).toBe("Mission not found.");
    const first = await h.call("start_mission", h.startInput({ chat_id: "51933333333@c.us" }));
    expect(first.text.endsWith("\n\nMissions: 2 finished — call list_missions.")).toBe(true);
    const second = await h.call("get_mission", {
      mission_id: h.store.list(TENANT, "active")[0]?.id,
    });
    expect(second.text).not.toContain("Missions:");
    expect(h.store.unseenOutcomes(TENANT)).toEqual([]);
  });

  it("send_text into a chat with an active mission takes the mission over at once", async () => {
    const h = harness({ withHistory: [CHAT, OTHER] });
    await h.call("start_mission", h.startInput());
    await h.call("start_mission", h.startInput({ chat_id: OTHER }));
    const [a, b] = [h.byChat(CHAT), h.byChat(OTHER)];
    const r = await h.call("send_text", { chat_id: CHAT, text: "Hi Ana, I'll take it from here." });
    expect(r.isError).toBe(false);
    await h.engine.idle();
    expect(h.takeOvers).toEqual([a?.id]);
    expect(h.store.get(TENANT, a?.id as string)?.state).toBe("taken_over");
    expect(h.store.get(TENANT, b?.id as string)?.state).toBe("active");
  });

  it("send_media, send_location and send_contact into a mission chat take it over too", async () => {
    const third = "51933333333@c.us";
    const h = harness({ withHistory: [CHAT, OTHER, third] });
    for (const chat of [CHAT, OTHER, third])
      await h.call("start_mission", h.startInput({ chat_id: chat }));
    await h.call("send_media", { chat_id: CHAT, url: "https://files.example.com/menu.pdf" });
    await h.call("send_location", { chat_id: OTHER, latitude: -12, longitude: -77 });
    await h.call("send_contact", {
      chat_id: third,
      full_name: "Stiven",
      phone_number: "+51999000000",
    });
    await h.engine.idle();
    expect(h.store.list(TENANT).map((m) => m.state)).toEqual([
      "taken_over",
      "taken_over",
      "taken_over",
    ]);
  });
});
