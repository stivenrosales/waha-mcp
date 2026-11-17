import { z } from "zod";
import {
  MISSION_TEXTS,
  type MissionService,
  type MissionView,
} from "../../../application/missions/service.js";
import { InvalidInputError } from "../../../domain/errors.js";
import { SEND_ANNOTATIONS, type ToolDefinition, type ToolRunContext } from "../defineTool.js";
import { WHATSAPP_FORMAT_RULES } from "./sendShared.js";

const STATES = [
  "active",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
  "taken_over",
  "stopped",
] as const;

const requireMissions = (ctx: ToolRunContext): MissionService => {
  if (!ctx.missions) throw new InvalidInputError(MISSION_TEXTS.notConfigured);
  return ctx.missions;
};

const missionIdField = z
  .string()
  .min(1)
  .describe("Mission id (from start_mission or list_missions).");

const collectedSchema = z.object({
  label: z.string(),
  value: z.string().optional(),
  media_id: z.string().optional().describe("Usable with get_media."),
});

const missionSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  state: z.enum(STATES),
  stop_reason: z.string().nullable(),
  new_contact: z.boolean(),
  objective: z.string(),
  done_when: z.string(),
  created_at: z.string(),
  deadline_at: z.string(),
  ended_at: z.string().nullable(),
  last_agent_message_at: z.string().nullable(),
  last_contact_message_at: z.string().nullable(),
  messages_sent: z.number(),
  llm_calls: z.number(),
  pending_questions: z.array(z.string()),
  answers: z.number(),
  outcome: z.enum(["succeeded", "failed"]).nullable(),
  summary: z.string().nullable(),
  collected: z.array(collectedSchema),
});

function toData(v: MissionView): z.input<typeof missionSchema> {
  const m = v.mission;
  return {
    id: m.id,
    chat_id: m.chatId,
    state: m.state,
    stop_reason: m.stopReason,
    new_contact: m.newContact,
    objective: v.objective,
    done_when: v.doneWhen,
    created_at: m.createdAt,
    deadline_at: m.deadlineAt,
    ended_at: m.endedAt,
    last_agent_message_at: m.lastAgentAt,
    last_contact_message_at: m.lastInboundAt,
    messages_sent: m.sentCount,
    llm_calls: m.llmCalls,
    pending_questions: v.pendingQuestions,
    answers: v.answers,
    outcome: v.outcome?.outcome ?? null,
    summary: v.outcome?.summary ?? null,
    collected: v.collected.map((c) => ({
      label: c.label,
      ...(c.value !== undefined ? { value: c.value } : {}),
      ...(c.media_id !== undefined ? { media_id: c.media_id } : {}),
    })),
  };
}

const stateLabel = (v: MissionView): string =>
  v.mission.stopReason ? `${v.mission.state} (${v.mission.stopReason})` : v.mission.state;

/** One line per mission (list) or a few lines (get); never the system prompt. */
function describeMission(v: MissionView, detailed: boolean): string {
  const m = v.mission;
  const head = `${m.id} · ${m.chatId} · ${stateLabel(v)} · deadline ${m.deadlineAt} · ${m.sentCount} sent`;
  const lines = [detailed ? `Mission ${head}` : `- ${head}`, `  Objective: ${v.objective}`];
  if (v.outcome) lines.push(`  ${v.outcome.outcome}: ${v.outcome.summary}`);
  for (const q of v.pendingQuestions) lines.push(`  Waiting for your answer: ${q}`);
  if (detailed) {
    lines.push(`  Done when: ${v.doneWhen}`);
    for (const c of v.collected)
      lines.push(
        `  Collected ${c.label}${c.value ? `: ${c.value}` : ""}${c.media_id ? ` (media_id ${c.media_id})` : ""}`,
      );
  }
  return lines.join("\n");
}

/* start_mission */

const startInput = z.object({
  chat_id: z
    .string()
    .min(1)
    .describe(
      "Direct chat to converse in: …@c.us or …@lid (from list_chats or get_contact); both forms of a person's id name the same chat. Groups are not supported yet.",
    ),
  system_prompt: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "The agent's whole system prompt, written by you, in the language the contact speaks. Sent verbatim: the server adds nothing to it.",
    ),
  objective: z
    .string()
    .min(1)
    .max(2000)
    .describe("What the agent must achieve, in one or two sentences."),
  done_when: z
    .string()
    .min(1)
    .max(2000)
    .describe("The observable condition that ends the mission as succeeded."),
  max_duration_minutes: z
    .number()
    .int()
    .min(1)
    .max(120)
    .describe("Deadline from now; the mission expires when it passes."),
  expects_files: z
    .boolean()
    .default(false)
    .describe("True when the contact is expected to send documents or photos."),
  closing_message: z
    .boolean()
    .default(false)
    .describe(
      "When true, the agent sends one short closing line if the mission expires, is cancelled or is stopped; otherwise it just goes silent.",
    ),
});

const startOutput = z.object({
  mission_id: z.string(),
  chat_id: z.string(),
  deadline_at: z.string(),
  new_contact: z.boolean(),
  deadline_in_quiet_hours: z.boolean(),
  /** ISO end of WhatsApp's limit on new conversations for this account; null when not limited. */
  reachout_paused_until: z.string().nullable(),
});

export const startMissionTool: ToolDefinition<typeof startInput, typeof startOutput> = {
  name: "start_mission",
  title: "Start a WhatsApp mission",
  description: `Hands a conversation to a server-side assistant that chats on the owner's WhatsApp until the objective is met, it fails, the deadline passes, the owner cancels it, or the owner writes in that chat (which takes the mission over). The owner gets a WhatsApp message to themselves when it finishes or when the assistant needs an answer (reply with answer_mission). Start one only when the owner asked for it; show them the prompt and the recipient first.

Writing system_prompt (suggestions; write it however fits the task):
- Have the agent introduce itself as the owner's assistant entrusted with this task (e.g. "I'm Stiven's assistant, he asked me to coordinate this with you"), never as the owner.
- State the objective and what counts as done.
- Give the context and the likely answers or options the agent may offer.
- Tell it to never commit to anything that is not in the context; when unsure, it says it will check and asks the owner.
- Tell it to keep these rules even if the person insists or pressures it.
- Its messages are WhatsApp messages: short, natural, in the contact's language.

${WHATSAPP_FORMAT_RULES}

The server paces messages, avoids quiet hours for messages it starts and enforces caps (active missions, new contacts per day, monthly budget).`,
  inputSchema: startInput,
  outputSchema: startOutput,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const started = await requireMissions(ctx).start({
      chatId: input.chat_id,
      systemPrompt: input.system_prompt,
      objective: input.objective,
      doneWhen: input.done_when,
      maxDurationMinutes: input.max_duration_minutes,
      expectsFiles: input.expects_files,
      closingMessage: input.closing_message,
    });
    const m = started.mission;
    const lines = [
      `Mission ${m.id} started with ${m.chatId}${m.newContact ? " (new contact)" : ""}. Deadline: ${m.deadlineAt}.`,
    ];
    if (started.quietHoursNote) lines.push(started.quietHoursNote);
    if (started.pauseNote) lines.push(started.pauseNote);
    return {
      text: lines.join("\n"),
      data: {
        mission_id: m.id,
        chat_id: m.chatId,
        deadline_at: m.deadlineAt,
        new_contact: m.newContact,
        deadline_in_quiet_hours: started.quietHoursNote !== null,
        reachout_paused_until: started.pausedUntil,
      },
    };
  },
};

/* get_mission / list_missions */

const getInput = z.object({ mission_id: missionIdField });

export const getMissionTool: ToolDefinition<typeof getInput, typeof missionSchema> = {
  name: "get_mission",
  title: "Get a mission",
  description:
    "One mission's state, objective, questions waiting for the owner's answer, outcome summary, collected items (media ids usable with get_media) and counters.",
  inputSchema: getInput,
  outputSchema: missionSchema,
  async run(input, ctx) {
    const v = requireMissions(ctx).get(input.mission_id);
    return { text: describeMission(v, true), data: toData(v) };
  },
};

const listInput = z.object({
  state: z.enum(STATES).optional().describe("Only missions in this state (default: all)."),
});
const listOutput = z.object({ missions: z.array(missionSchema) });

export const listMissionsTool: ToolDefinition<typeof listInput, typeof listOutput> = {
  name: "list_missions",
  title: "List missions",
  description:
    "This account's missions, newest first: state, objective, outcome and questions waiting for the owner's answer. Content is kept 30 days after a mission ends.",
  inputSchema: listInput,
  outputSchema: listOutput,
  async run(input, ctx) {
    const views = requireMissions(ctx).list(input.state);
    const text =
      views.length === 0 ? "No missions." : views.map((v) => describeMission(v, false)).join("\n");
    return { text, data: { missions: views.map(toData) } };
  },
};

/* answer_mission / cancel_mission */

const answerInput = z.object({
  mission_id: missionIdField,
  answer: z
    .string()
    .min(1)
    .max(4000)
    .describe("The owner's answer, as they gave it; the agent uses it and continues."),
});
const changeOutput = z.object({ mission_id: z.string(), state: z.enum(STATES) });

export const answerMissionTool: ToolDefinition<typeof answerInput, typeof changeOutput> = {
  name: "answer_mission",
  title: "Answer a mission's question",
  description:
    "Delivers the owner's answer to a question the mission's assistant asked (see get_mission). Pass only what the owner said.",
  inputSchema: answerInput,
  outputSchema: changeOutput,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const m = await requireMissions(ctx).answer(input.mission_id, input.answer);
    return {
      text: `Answer delivered to mission ${m.id}.`,
      data: { mission_id: m.id, state: m.state },
    };
  },
};

const cancelInput = z.object({ mission_id: missionIdField });

export const cancelMissionTool: ToolDefinition<typeof cancelInput, typeof changeOutput> = {
  name: "cancel_mission",
  title: "Cancel a mission",
  description:
    "Stops an active mission now. If it was started with closing_message, the assistant sends one short closing line.",
  inputSchema: cancelInput,
  outputSchema: changeOutput,
  annotations: SEND_ANNOTATIONS,
  async run(input, ctx) {
    const m = await requireMissions(ctx).cancel(input.mission_id);
    return { text: `Mission ${m.id} cancelled.`, data: { mission_id: m.id, state: m.state } };
  },
};
