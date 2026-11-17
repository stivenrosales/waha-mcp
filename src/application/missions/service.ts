import { InvalidInputError } from "../../domain/errors.js";
import type { MissionLimits } from "../../domain/missions/limits.js";
import type { MissionState } from "../../domain/missions/mission.js";
import { dayStart, inQuietHours, monthStart } from "../../domain/missions/pacing.js";
import type { MissionLog, MissionLogEntry } from "../../domain/ports/MissionLog.js";
import type { MissionRow, MissionStore } from "../../domain/ports/MissionStore.js";
import type { TenantStore } from "../../domain/ports/TenantStore.js";
import type { CollectedItem } from "./agentTools.js";
import type { MissionEngine } from "./engine.js";
import { buildConversation, startMissionContent } from "./history.js";
import { chatIdForms } from "./inbound.js";

/** What the service needs of the engine: owner actions are queued behind its ticks. */
export type MissionEnginePort = Pick<MissionEngine, "cancel" | "answer" | "takeOver" | "wake">;

export interface MissionServiceDeps {
  tenantId: string;
  store: MissionStore;
  log: MissionLog;
  tenants: Pick<TenantStore, "llmSpendUsd">;
  engine: MissionEnginePort;
  limits: MissionLimits;
  monthlyBudgetUsd: number;
  /** Server `TIMEZONE`: quiet hours, the daily new-contact window and the monthly budget. */
  timezone: string;
  now: () => Date;
  /** True when the chat already has messages (otherwise the mission is to a new contact). */
  hasHistory(chatId: string): Promise<boolean>;
  /** Phone JID behind a `@lid` (chat ids are matched in both forms). */
  lookupLid(lid: string): Promise<string | null>;
  /** Mission ids and outcomes only; never content. */
  logger: { info(message: string): void };
}

export interface StartMissionInput {
  chatId: string;
  systemPrompt: string;
  objective: string;
  doneWhen: string;
  maxDurationMinutes: number;
  expectsFiles: boolean;
  closingMessage: boolean;
}

export interface StartedMission {
  mission: MissionRow;
  /** Set when the deadline falls in quiet hours (the agent starts nothing then). */
  quietHoursNote: string | null;
  /** End of WhatsApp's reach-out limit on this account when it is on now (the agent waits). */
  pausedUntil: string | null;
  /** Says until when the agent waits for that limit; null when the account is not limited. */
  pauseNote: string | null;
}

/** A mission with what its log says: objective, questions, outcome, collected items. */
export interface MissionView {
  mission: MissionRow;
  objective: string;
  doneWhen: string;
  /** Questions the agent asked the owner after the owner's last answer. */
  pendingQuestions: string[];
  answers: number;
  outcome: { outcome: "succeeded" | "failed"; summary: string } | null;
  collected: CollectedItem[];
}

export interface MissionService {
  start(input: StartMissionInput): Promise<StartedMission>;
  get(id: string): MissionView;
  list(state?: MissionState): MissionView[];
  answer(id: string, text: string): Promise<MissionRow>;
  cancel(id: string): Promise<MissionRow>;
  /** The owner sent something to `chatId` through the MCP tools: its active mission is taken over. */
  ownerSent(chatId: string): Promise<void>;
  /** The notice for terminal missions the owner was not told about yet (then marked seen). */
  takeUnseenNotice(): string | null;
}

/** Refusals and errors shown to Claude (English, like every tool text). */
export const MISSION_TEXTS = {
  notConfigured: "Missions are not configured on this server.",
  group: "Group missions are not available yet.",
  notDirect: "Missions need a direct chat id (…@c.us or …@lid).",
  budget:
    "The monthly mission budget of this account is used up; missions can start again next month.",
  active: (n: number) =>
    `This account already has ${n} active missions; wait for one to finish or cancel one.`,
  newContacts: (n: number) =>
    `Missions to ${n} new contacts were already started today; try again tomorrow.`,
  duration: (max: number) => `max_duration_minutes can be at most ${max}.`,
  chatBusy: (id: string) => `This chat already has an active mission (${id}).`,
  notFound: "Mission not found.",
  notActive: (id: string, state: MissionState) => `Mission ${id} is not active (${state}).`,
  quietDeadline: (start: number, end: number) =>
    `The deadline falls in quiet hours (${hh(start)}–${hh(end)}); the agent will not start conversations then.`,
  paused: (until: string) =>
    `WhatsApp is limiting new conversations on this account until ${until}; the agent will wait.`,
  notice: (n: number) => `\n\nMissions: ${n} finished — call list_missions.`,
};

/** Direct chats: phone JIDs (`@c.us`, `@s.whatsapp.net`) and linked ids (`@lid`). */
const DIRECT_CHAT = /^[^@\s]+@(c\.us|s\.whatsapp\.net|lid)$/;

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "UnknownError";

/** `2026-11-18 10:00 (America/Lima)`. */
function localTime(at: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: "h23",
  });
  return `${fmt.format(at).replace(",", "")} (${timezone})`;
}

const hh = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function viewOf(mission: MissionRow, entries: MissionLogEntry[]): MissionView {
  const { spec } = buildConversation(entries);
  let pendingQuestions: string[] = [];
  let answers = 0;
  let outcome: MissionView["outcome"] = null;
  let collected: CollectedItem[] = [];
  for (const e of entries) {
    const body = isRecord(e.body) ? e.body : {};
    if (e.kind === "question" && typeof body.question === "string")
      pendingQuestions.push(body.question);
    else if (e.kind === "answer") {
      answers += 1;
      pendingQuestions = [];
    } else if (
      e.kind === "summary" &&
      (body.outcome === "succeeded" || body.outcome === "failed") &&
      typeof body.summary === "string"
    )
      outcome = { outcome: body.outcome, summary: body.summary };
    else if (e.kind === "collected" && Array.isArray(e.body)) collected = e.body as CollectedItem[];
  }
  return {
    mission,
    objective: spec.objective,
    doneWhen: spec.doneWhen,
    pendingQuestions: mission.state === "active" ? pendingQuestions : [],
    answers,
    outcome,
    collected,
  };
}

/**
 * Owner-side mission operations of one tenant (what the MCP tools call). Limits, budget and caps
 * are checked here; anything that touches a running mission goes through the engine so it never
 * interleaves with an agent turn.
 */
export function createMissionService(deps: MissionServiceDeps): MissionService {
  const { tenantId, store, log, limits, engine } = deps;
  const iso = (d: Date): string => d.toISOString();
  const forms = (chatId: string): Promise<string[]> => chatIdForms(chatId, deps.lookupLid);
  /** Active missions whose chat is `ids` under any of its forms. */
  const activeIn = async (ids: string[]): Promise<MissionRow[]> => {
    const wanted = new Set(ids);
    const out: MissionRow[] = [];
    for (const m of store.list(tenantId, "active"))
      if ((await forms(m.chatId)).some((id) => wanted.has(id))) out.push(m);
    return out;
  };

  const find = (id: string): MissionRow => {
    const m = store.get(tenantId, id);
    if (!m) throw new InvalidInputError(MISSION_TEXTS.notFound);
    return m;
  };
  const requireActive = (id: string): MissionRow => {
    const m = find(id);
    if (m.state !== "active") throw new InvalidInputError(MISSION_TEXTS.notActive(m.id, m.state));
    return m;
  };

  return {
    async start(q) {
      if (q.chatId.endsWith("@g.us")) throw new InvalidInputError(MISSION_TEXTS.group);
      if (!DIRECT_CHAT.test(q.chatId)) throw new InvalidInputError(MISSION_TEXTS.notDirect);
      if (q.maxDurationMinutes > limits.maxDurationMinutes)
        throw new InvalidInputError(MISSION_TEXTS.duration(limits.maxDurationMinutes));
      const now = deps.now();
      const spent = deps.tenants.llmSpendUsd({
        tenantId,
        fromIso: iso(monthStart(now, deps.timezone)),
        toIso: iso(now),
      });
      if (spent >= deps.monthlyBudgetUsd) throw new InvalidInputError(MISSION_TEXTS.budget);
      const ids = await forms(q.chatId);
      // Stored in its normalized form (`@s.whatsapp.net` → `@c.us`), the one webhooks match.
      const chatId = ids[0] ?? q.chatId;
      const [busy] = await activeIn(ids);
      if (busy) throw new InvalidInputError(MISSION_TEXTS.chatBusy(busy.id));
      if (store.countActive(tenantId) >= limits.maxActivePerTenant)
        throw new InvalidInputError(MISSION_TEXTS.active(limits.maxActivePerTenant));
      let known = false;
      for (const id of ids) if (!known) known = await deps.hasHistory(id);
      const newContact = !known;
      if (
        newContact &&
        store.countNewContactToday(tenantId, iso(dayStart(now, deps.timezone))) >=
          limits.maxNewContactsPerDay
      )
        throw new InvalidInputError(MISSION_TEXTS.newContacts(limits.maxNewContactsPerDay));

      const deadline = new Date(now.getTime() + q.maxDurationMinutes * 60_000);
      const mission = store.create({
        tenantId,
        chatId,
        newContact,
        deadlineAt: iso(deadline),
        expectsFiles: q.expectsFiles,
        nextWakeAt: iso(now),
        // The agent writes the closing line itself; the column only says whether to send one.
        closingMessage: q.closingMessage ? "yes" : null,
      });
      startMissionContent(
        log,
        mission.id,
        { systemPrompt: q.systemPrompt, objective: q.objective, doneWhen: q.doneWhen },
        iso(now),
      );
      engine.wake();
      const quiet = inQuietHours(deadline, deps.timezone, limits);
      const pausedUntil = store.pausedUntil(tenantId, iso(now));
      return {
        mission,
        quietHoursNote: quiet
          ? MISSION_TEXTS.quietDeadline(limits.quietStartHour, limits.quietEndHour)
          : null,
        pausedUntil,
        pauseNote: pausedUntil
          ? MISSION_TEXTS.paused(localTime(new Date(pausedUntil), deps.timezone))
          : null,
      };
    },

    get(id) {
      const m = find(id);
      return viewOf(m, log.read(m.id));
    },

    list(state) {
      return store.list(tenantId, state).map((m) => viewOf(m, log.read(m.id)));
    },

    async answer(id, text) {
      const m = requireActive(id);
      if (!(await engine.answer(tenantId, m.id, text))) {
        const now = find(id);
        throw new InvalidInputError(MISSION_TEXTS.notActive(now.id, now.state));
      }
      engine.wake();
      return find(id);
    },

    async cancel(id) {
      const m = requireActive(id);
      if (!(await engine.cancel(tenantId, m.id))) {
        const now = find(id);
        throw new InvalidInputError(MISSION_TEXTS.notActive(now.id, now.state));
      }
      // The owner asked for it: no "finished" notice about it.
      store.markSeen([m.id]);
      return find(id);
    },

    async ownerSent(chatId) {
      if (store.countActive(tenantId) === 0) return;
      let targets: MissionRow[];
      try {
        targets = await activeIn(await forms(chatId));
      } catch (error) {
        deps.logger.info(`takeover=failed error=${errorName(error)}`);
        return;
      }
      for (const m of targets) {
        // Not awaited: it queues behind a running turn, which the engine's mark already stops.
        engine.takeOver(tenantId, m.id).catch((error: unknown) => {
          deps.logger.info(`mission=${m.id} takeover=failed error=${errorName(error)}`);
        });
      }
    },

    takeUnseenNotice() {
      const unseen = store.unseenOutcomes(tenantId);
      if (unseen.length === 0) return null;
      store.markSeen(unseen.map((m) => m.id));
      return MISSION_TEXTS.notice(unseen.length);
    },
  };
}
