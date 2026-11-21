import { z } from "zod";
import { MISSION_TEXTS } from "../../../application/missions/service.js";
import type { ScheduleService, ScheduleView } from "../../../application/schedules/service.js";
import { InvalidInputError } from "../../../domain/errors.js";
import type { ScheduleRow } from "../../../domain/ports/ScheduleStore.js";
import { formatLocal } from "../../../domain/schedules/recurrence.js";
import { SEND_ANNOTATIONS, type ToolDefinition, type ToolRunContext } from "../defineTool.js";
import { chatIdField, WHATSAPP_FORMAT_RULES } from "./sendShared.js";

const KINDS = ["fixed", "ai"] as const;
const REPEATS = ["none", "daily", "weekly", "monthly", "yearly"] as const;
const OUTCOMES = ["sent", "skipped", "failed", "missed", "unknown"] as const;
const STATES = ["active", "done", "cancelled"] as const;

/** Scheduled messages exist only with missions configured (they share its limits and budget). */
const requireSchedules = (ctx: ToolRunContext): ScheduleService => {
  if (!ctx.schedules) throw new InvalidInputError(MISSION_TEXTS.notConfigured);
  return ctx.schedules;
};

/** `2026-11-18 09:00 (America/Lima)`, or a note while the run is in progress. */
const localNext = (s: ScheduleRow, tz: string): string =>
  s.nextRunAt ? `${formatLocal(new Date(s.nextRunAt), tz)} (${tz})` : "running now";

const repeatLabel = (s: ScheduleRow): string =>
  s.repeat === "none" ? "once" : `${s.repeat}, ${s.maxRuns} runs`;

/* schedule_message */

const scheduleInput = z.object({
  chat_id: chatIdField,
  kind: z
    .enum(KINDS)
    .describe(
      '"fixed": send `text` exactly. "ai": at each run the server\'s AI reads the recent chat and writes the message from `instruction` in the owner\'s own writing style in that chat, or skips the run when it is no longer needed.',
    ),
  text: z
    .string()
    .min(1)
    .optional()
    .describe('For kind "fixed": the message, in WhatsApp formatting.'),
  instruction: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('For kind "ai": what the message must say or achieve, as the owner put it.'),
  at: z
    .string()
    .min(1)
    .describe(
      "First run, local date-time in the server timezone: YYYY-MM-DD HH:mm (e.g. 2026-12-05 09:00). Must be in the future.",
    ),
  repeat: z.enum(REPEATS).default("none").describe("Repetition after the first run."),
  max_runs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Repeating schedules only: how many dates it runs before it ends (default 12, at most 52). Every date counts, sent or not.",
    ),
});

const scheduleOutput = z.object({
  schedule_id: z.string(),
  chat_id: z.string(),
  kind: z.enum(KINDS),
  repeat: z.enum(REPEATS),
  /** ISO instant of the first run. */
  next_run_at: z.string(),
  max_runs: z.number(),
  new_contact: z.boolean(),
  note: z.string().nullable(),
});

export const scheduleMessageTool: ToolDefinition<typeof scheduleInput, typeof scheduleOutput> = {
  name: "schedule_message",
  title: "Schedule a WhatsApp message",
  description: `Schedules a message from the owner's WhatsApp to a person or group, once or repeating; the server sends it at that time. Schedule only when the owner explicitly asked for it. Before calling, show the owner the recipient, the local time, the repetition and the text — or, for kind "ai", the instruction, saying the AI will write the words at send time and may skip a run when the chat shows it is not needed. Never retry on your own.

For kind "fixed", the text: ${WHATSAPP_FORMAT_RULES}

The server avoids quiet hours for chats other than the owner's own (the run moves to their end), does not send a run more than an hour late (it is logged as missed), skips a run while a mission is active in that chat, and tells the owner on WhatsApp about AI-written, failed, missed and finished runs. Caps: active schedules per account, new contacts per day (shared with missions), the monthly AI budget (shared with missions). See list_scheduled and cancel_scheduled.`,
  inputSchema: scheduleInput,
  outputSchema: scheduleOutput,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const { row, note } = await requireSchedules(ctx).schedule({
      chatId: input.chat_id,
      kind: input.kind,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
      at: input.at,
      repeat: input.repeat,
      ...(input.max_runs !== undefined ? { maxRuns: input.max_runs } : {}),
    });
    const tz = ctx.config.timezone;
    const lines = [
      `Scheduled message ${row.id} to ${row.chatId}${row.newContact ? " (new contact)" : ""}: first run ${localNext(row, tz)}, ${repeatLabel(row)}.`,
    ];
    if (note) lines.push(note);
    return {
      text: lines.join("\n"),
      data: {
        schedule_id: row.id,
        chat_id: row.chatId,
        kind: row.kind,
        repeat: row.repeat,
        next_run_at: row.firstAt,
        max_runs: row.maxRuns,
        new_contact: row.newContact,
        note,
      },
    };
  },
};

/* list_scheduled */

const runSchema = z.object({
  at: z.string(),
  outcome: z.enum(OUTCOMES),
  reason: z.string().optional(),
});

const scheduledSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  kind: z.enum(KINDS),
  text: z.string().optional(),
  instruction: z.string().optional(),
  repeat: z.enum(REPEATS),
  /** ISO; null while a run is in progress. */
  next_run_at: z.string().nullable(),
  runs_done: z.number(),
  max_runs: z.number(),
  remaining_runs: z.number(),
  created_at: z.string(),
  /** Newest first. */
  last_runs: z.array(runSchema),
});

function toData(v: ScheduleView): z.input<typeof scheduledSchema> {
  const s = v.row;
  return {
    id: s.id,
    chat_id: s.chatId,
    kind: s.kind,
    ...(v.content.text !== undefined ? { text: v.content.text } : {}),
    ...(v.content.instruction !== undefined ? { instruction: v.content.instruction } : {}),
    repeat: s.repeat,
    next_run_at: s.nextRunAt,
    runs_done: s.runsDone,
    max_runs: s.maxRuns,
    remaining_runs: Math.max(0, s.maxRuns - s.runsDone),
    created_at: s.createdAt,
    last_runs: v.runs.map((r) => ({
      at: r.at,
      outcome: r.outcome,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    })),
  };
}

function describeSchedule(v: ScheduleView, tz: string): string {
  const s = v.row;
  const lines = [
    `- ${s.id} · ${s.chatId} · ${s.kind} · ${repeatLabel(s)} · next ${localNext(s, tz)} · ${s.runsDone}/${s.maxRuns} done`,
  ];
  if (v.content.text !== undefined) lines.push(`  Text: ${v.content.text}`);
  if (v.content.instruction !== undefined) lines.push(`  Instruction: ${v.content.instruction}`);
  if (v.runs.length > 0)
    lines.push(
      `  Last runs: ${v.runs
        .map(
          (r) =>
            `${formatLocal(new Date(r.at), tz)} ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`,
        )
        .join("; ")}`,
    );
  return lines.join("\n");
}

const listInput = z.object({});
const listOutput = z.object({ schedules: z.array(scheduledSchema) });

export const listScheduledTool: ToolDefinition<typeof listInput, typeof listOutput> = {
  name: "list_scheduled",
  title: "List scheduled messages",
  description:
    "This account's active scheduled messages, newest first: recipient, text or instruction, repetition, next run (server timezone), runs left and the last runs (sent, skipped, failed, missed or unknown, with the reason).",
  inputSchema: listInput,
  outputSchema: listOutput,
  async run(_input, ctx) {
    const views = requireSchedules(ctx).list();
    const tz = ctx.config.timezone;
    const text =
      views.length === 0
        ? "No scheduled messages."
        : views.map((v) => describeSchedule(v, tz)).join("\n");
    return { text, data: { schedules: views.map(toData) } };
  },
};

/* cancel_scheduled */

const cancelInput = z.object({
  schedule_id: z
    .string()
    .min(1)
    .describe("Scheduled message id (from schedule_message or list_scheduled)."),
});
const cancelOutput = z.object({ schedule_id: z.string(), state: z.enum(STATES) });

export const cancelScheduledTool: ToolDefinition<typeof cancelInput, typeof cancelOutput> = {
  name: "cancel_scheduled",
  title: "Cancel a scheduled message",
  description:
    "Cancels a scheduled message: no further run is sent, including one that is about to go out.",
  inputSchema: cancelInput,
  outputSchema: cancelOutput,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const s = requireSchedules(ctx).cancel(input.schedule_id);
    return {
      text: `Scheduled message ${s.id} cancelled.`,
      data: { schedule_id: s.id, state: s.state },
    };
  },
};
