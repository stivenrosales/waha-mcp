import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MISSION_TEXTS } from "../../../../src/application/missions/service.js";
import {
  createScheduleService,
  type ScheduleService,
} from "../../../../src/application/schedules/service.js";
import { loadConfig } from "../../../../src/config.js";
import { DEFAULT_MISSION_LIMITS } from "../../../../src/domain/missions/limits.js";
import { DEFAULT_SCHEDULE_LIMITS } from "../../../../src/domain/schedules/limits.js";
import {
  createToolHandler,
  type ToolDefinition,
  type ToolDeps,
} from "../../../../src/infrastructure/mcp/defineTool.js";
import { createTools } from "../../../../src/infrastructure/mcp/tools/index.js";
import { createSqliteMissionStore } from "../../../../src/infrastructure/missions/sqliteMissionStore.js";
import { createSealedScheduleLog } from "../../../../src/infrastructure/schedules/sealedScheduleLog.js";
import { createSqliteScheduleStore } from "../../../../src/infrastructure/schedules/sqliteScheduleStore.js";
import { gowsMapper } from "../../../../src/infrastructure/waha/engines/gows.js";
import { testCipher } from "../../../fakes/testCipher.js";

const TENANT = "t1";
const OWNER = "51999000000@c.us";
const CHAT = "51911111111@c.us";
const TZ = "America/Lima";
/** 10:00 in Lima (UTC-5). */
const T0 = new Date("2026-11-17T15:00:00.000Z");

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

function harness() {
  const authDb = new DatabaseSync(":memory:");
  const store = createSqliteScheduleStore(authDb, () => T0.toISOString());
  const log = createSealedScheduleLog(new DatabaseSync(":memory:"), testCipher(TENANT));
  const service = createScheduleService({
    tenantId: TENANT,
    store,
    log,
    missions: createSqliteMissionStore(authDb),
    cancel(tenantId, id) {
      if (store.get(tenantId, id)?.state !== "active") return false;
      store.update(id, { state: "cancelled", endedAt: T0.toISOString(), nextRunAt: null });
      return true;
    },
    limits: DEFAULT_SCHEDULE_LIMITS,
    missionLimits: DEFAULT_MISSION_LIMITS,
    timezone: TZ,
    now: () => T0,
    ownerChatId: OWNER,
    hasHistory: async () => true,
    lookupLid: async () => null,
  });
  const call = async (
    name: string,
    input: Record<string, unknown>,
    schedules: ScheduleService | null = service,
  ) => {
    const deps = { mapper: async () => gowsMapper, config, schedules } as unknown as ToolDeps;
    const parsed = tool(name).inputSchema.parse(input);
    const r = await createToolHandler(tool(name), deps)(parsed);
    return {
      isError: r.isError === true,
      text: (r.content[0] as { text: string }).text,
      data: r.structuredContent as Record<string, unknown> | undefined,
    };
  };
  return { store, log, service, call };
}

const fixedInput = (q: Record<string, unknown> = {}) => ({
  chat_id: CHAT,
  kind: "fixed",
  text: "Hola Ana, ¿confirmamos mañana?",
  at: "2026-11-18 09:00",
  repeat: "none",
  ...q,
});

describe("schedule tools", () => {
  it("are registered: schedule_message and cancel_scheduled as writes, list_scheduled read-only", () => {
    expect(tool("schedule_message").annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
    expect(tool("cancel_scheduled").annotations).toMatchObject({ readOnlyHint: false });
    expect(tool("cancel_scheduled").annotations).toEqual(tool("cancel_mission").annotations);
    expect(tool("list_scheduled").annotations).toBeUndefined();
    const names = tools.map((t) => t.name);
    expect(names.indexOf("schedule_message")).toBeGreaterThan(names.indexOf("send_text"));
  });

  it("schedule_message tells Claude to show the owner what will be sent before calling", () => {
    const d = tool("schedule_message").description;
    expect(d).toContain("recipient");
    expect(d).toContain("repetition");
    expect(d).toContain("the AI will write the words");
    expect(d).toContain("WhatsApp formatting");
  });

  it("refuses every schedule tool when missions are not configured", async () => {
    const h = harness();
    for (const [name, input] of [
      ["schedule_message", fixedInput()],
      ["list_scheduled", {}],
      ["cancel_scheduled", { schedule_id: "x" }],
    ] as const)
      expect(await h.call(name, input, null)).toEqual({
        isError: true,
        text: MISSION_TEXTS.notConfigured,
        data: undefined,
      });
  });

  it("schedule_message reports the id, the local time and the quiet-hours note", async () => {
    const h = harness();
    const r = await h.call("schedule_message", fixedInput({ at: "2026-11-17 23:30" }));
    expect(r.isError).toBe(false);
    const id = r.data?.schedule_id as string;
    expect(h.store.get(TENANT, id)?.state).toBe("active");
    expect(r.text).toContain(id);
    expect(r.text).toContain("2026-11-17 23:30 (America/Lima)");
    expect(r.text).toContain(
      "This falls in quiet hours (22:00–08:00); it will be sent at 2026-11-18 08:00.",
    );
    expect(r.data).toMatchObject({
      chat_id: CHAT,
      kind: "fixed",
      repeat: "none",
      next_run_at: "2026-11-18T04:30:00.000Z",
      max_runs: 1,
      new_contact: false,
    });
  });

  it("schedule_message passes validation errors through", async () => {
    const h = harness();
    const r = await h.call("schedule_message", fixedInput({ at: "2026-11-17 09:00" }));
    expect(r).toMatchObject({
      isError: true,
      text: "at must be in the future (it is now 2026-11-17 10:00 in America/Lima).",
    });
  });

  it("list_scheduled shows the text or instruction and the last runs", async () => {
    const h = harness();
    const a = await h.call("schedule_message", fixedInput({ repeat: "daily", max_runs: 3 }));
    const b = await h.call("schedule_message", {
      chat_id: CHAT,
      kind: "ai",
      instruction: "Ask Ana whether the invoice was paid",
      at: "2026-11-20 09:00",
      repeat: "weekly",
    });
    const aId = a.data?.schedule_id as string;
    h.log.appendRun(aId, { at: "2026-11-16T14:00:00.000Z", outcome: "sent", text: "Hola" });
    h.log.appendRun(aId, {
      at: "2026-11-17T14:00:00.000Z",
      outcome: "skipped",
      reason: "hay una misión activa en este chat",
    });
    const r = await h.call("list_scheduled", {});
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Hola Ana, ¿confirmamos mañana?");
    expect(r.text).toContain("Ask Ana whether the invoice was paid");
    expect(r.text).toContain("skipped (hay una misión activa en este chat)");
    const list = r.data?.schedules as Record<string, unknown>[];
    expect(list.map((s) => s.id)).toEqual([b.data?.schedule_id, aId]);
    expect(list[1]).toMatchObject({
      kind: "fixed",
      text: "Hola Ana, ¿confirmamos mañana?",
      repeat: "daily",
      runs_done: 0,
      max_runs: 3,
      remaining_runs: 3,
      last_runs: [
        {
          at: "2026-11-17T14:00:00.000Z",
          outcome: "skipped",
          reason: "hay una misión activa en este chat",
        },
        { at: "2026-11-16T14:00:00.000Z", outcome: "sent" },
      ],
    });
    expect(list[0]).toMatchObject({
      kind: "ai",
      instruction: "Ask Ana whether the invoice was paid",
    });
  });

  it("list_scheduled says when there is nothing scheduled", async () => {
    const h = harness();
    expect((await h.call("list_scheduled", {})).text).toBe("No scheduled messages.");
  });

  it("cancel_scheduled cancels by id and refuses an unknown id", async () => {
    const h = harness();
    const id = (await h.call("schedule_message", fixedInput())).data?.schedule_id as string;
    expect(await h.call("cancel_scheduled", { schedule_id: "nope" })).toMatchObject({
      isError: true,
      text: "Scheduled message not found.",
    });
    const r = await h.call("cancel_scheduled", { schedule_id: id });
    expect(r).toMatchObject({
      isError: false,
      text: `Scheduled message ${id} cancelled.`,
      data: { schedule_id: id, state: "cancelled" },
    });
    expect(h.store.get(TENANT, id)?.state).toBe("cancelled");
  });
});
