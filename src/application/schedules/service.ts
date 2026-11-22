import { InvalidInputError } from "../../domain/errors.js";
import type { MissionLimits } from "../../domain/missions/limits.js";
import { dayStart, inQuietHours, nextAllowedInitiatedSend } from "../../domain/missions/pacing.js";
import type { MissionStore } from "../../domain/ports/MissionStore.js";
import type { ScheduleContent, ScheduleLog, ScheduleRun } from "../../domain/ports/ScheduleLog.js";
import type {
  ScheduleKind,
  ScheduleRow,
  ScheduleState,
  ScheduleStore,
} from "../../domain/ports/ScheduleStore.js";
import { parseReplyWindow } from "../../domain/schedules/followUp.js";
import type { ScheduleLimits } from "../../domain/schedules/limits.js";
import {
  formatLocal,
  parseLocalDateTime,
  type ScheduleRepeat,
} from "../../domain/schedules/recurrence.js";
import { chatIdForms } from "../missions/inbound.js";
import { assertTextLength } from "../send.js";
import { toWhatsAppText } from "../whatsappFormat.js";

export interface ScheduleServiceDeps {
  tenantId: string;
  store: ScheduleStore;
  log: ScheduleLog;
  /** Missions to new contacts started today count toward the same daily cap. */
  missions: Pick<MissionStore, "countNewContactToday">;
  /** The runner's cancel: a run already in its typing pause then sends nothing. */
  cancel(tenantId: string, id: string): boolean;
  limits: ScheduleLimits;
  /** Quiet hours and the daily new-contact cap, shared with missions. */
  missionLimits: MissionLimits;
  /** Server `TIMEZONE`: the `at` input, quiet hours and the daily new-contact window. */
  timezone: string;
  now(): Date;
  /** The owner's own chat (quiet hours do not apply to it); null when not paired. */
  ownerChatId: string | null;
  /** True when the chat already has messages (otherwise the schedule is to a new contact). */
  hasHistory(chatId: string): Promise<boolean>;
  /** Phone JID behind a `@lid` (chat ids are matched in both forms). */
  lookupLid(lid: string): Promise<string | null>;
}

export interface ScheduleInput {
  chatId: string;
  kind: ScheduleKind;
  text?: string;
  instruction?: string;
  /** Local date-time in the server timezone, `YYYY-MM-DD HH:mm`. Not given for a follow-up. */
  at?: string;
  repeat: ScheduleRepeat;
  maxRuns?: number;
  /**
   * A follow-up: `"48h"` or `"3d"`. It runs once, that long after now, only when the contact
   * has not written in the chat since now. Direct chats only; replaces `at`.
   */
  ifNoReplyWithin?: string;
}

export interface ScheduleView {
  row: ScheduleRow;
  content: ScheduleContent;
  /** Newest first, at most five. */
  runs: ScheduleRun[];
}

/** Owner-side scheduled-message operations of one tenant (what the MCP tools call). */
export interface ScheduleService {
  schedule(q: ScheduleInput): Promise<{ row: ScheduleRow; note: string | null }>;
  list(): ScheduleView[];
  cancel(id: string): ScheduleRow;
}

/** Refusals and notes shown to Claude (English, like every tool text). */
export const SCHEDULE_TEXTS = {
  chatId: "Scheduled messages need a chat id: …@c.us or …@lid for a person, …@g.us for a group.",
  fixed: 'kind "fixed" needs text and no instruction.',
  ai: 'kind "ai" needs an instruction and no text.',
  instructionLength: "instruction can be at most 2000 characters.",
  past: (now: string, timezone: string) =>
    `at must be in the future (it is now ${now} in ${timezone}).`,
  maxRunsOnce: 'max_runs is only for repeating schedules (repeat is "none").',
  maxRuns: (max: number) => `max_runs must be between 1 and ${max}.`,
  active: (n: number) =>
    `This account already has ${n} active scheduled messages; cancel one before adding another.`,
  newContacts: (n: number) =>
    `Missions and scheduled messages to ${n} new contacts were already created today; try again tomorrow.`,
  quietHours: (start: string, end: string, at: string) =>
    `This falls in quiet hours (${start}–${end}); it will be sent at ${at}.`,
  needAt: "at is required (or if_no_reply_within, for a follow-up).",
  followUpAt:
    "A follow-up (if_no_reply_within) runs that long after now: leave out at, or drop if_no_reply_within.",
  followUpDirect:
    "Follow-ups (if_no_reply_within) are for direct chats only (…@c.us or …@lid), not groups.",
  followUpOnce: 'A follow-up (if_no_reply_within) runs once: repeat must be "none".',
  replyWindow:
    'if_no_reply_within must be a whole number of hours or days, like "48h" or "3d", from 1h to 30d.',
  notFound: "Scheduled message not found.",
  notActive: (id: string, state: ScheduleState) =>
    `Scheduled message ${id} is not active (${state}).`,
};

const MAX_INSTRUCTION = 2000;
const LAST_RUNS = 5;
/** Direct chats: phone JIDs (`@c.us`, `@s.whatsapp.net`) and linked ids (`@lid`). */
const DIRECT_CHAT = /^[^@\s]+@(c\.us|s\.whatsapp\.net|lid)$/;
const GROUP_CHAT = /^[^@\s]+@g\.us$/;

const hh = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

/** The sealed content of a schedule, checked like `send_text` checks its text. */
function contentOf(q: ScheduleInput): ScheduleContent {
  if (q.kind === "fixed") {
    if (q.instruction !== undefined || !q.text?.trim())
      throw new InvalidInputError(SCHEDULE_TEXTS.fixed);
    const text = toWhatsAppText(q.text);
    assertTextLength(text);
    return { text };
  }
  if (q.text !== undefined || !q.instruction?.trim())
    throw new InvalidInputError(SCHEDULE_TEXTS.ai);
  if (q.instruction.length > MAX_INSTRUCTION)
    throw new InvalidInputError(SCHEDULE_TEXTS.instructionLength);
  return { instruction: q.instruction };
}

/**
 * Validates and stores scheduled messages for one tenant. Metadata goes to the store; the text or
 * instruction only to the sealed schedule log. Cancelling goes through the runner.
 */
export function createScheduleService(deps: ScheduleServiceDeps): ScheduleService {
  const { tenantId, store, log, limits, missionLimits: ml, timezone: tz } = deps;
  const forms = (chatId: string): Promise<string[]> => chatIdForms(chatId, deps.lookupLid);

  const find = (id: string): ScheduleRow => {
    const s = store.get(tenantId, id);
    if (!s) throw new InvalidInputError(SCHEDULE_TEXTS.notFound);
    return s;
  };

  function maxRunsOf(q: ScheduleInput): number {
    if (q.repeat === "none") {
      if (q.maxRuns !== undefined) throw new InvalidInputError(SCHEDULE_TEXTS.maxRunsOnce);
      return 1;
    }
    const n = q.maxRuns ?? limits.defaultRuns;
    if (!Number.isInteger(n) || n < 1 || n > limits.maxRuns)
      throw new InvalidInputError(SCHEDULE_TEXTS.maxRuns(limits.maxRuns));
    return n;
  }

  return {
    async schedule(q) {
      const direct = DIRECT_CHAT.test(q.chatId);
      if (!direct && !GROUP_CHAT.test(q.chatId)) throw new InvalidInputError(SCHEDULE_TEXTS.chatId);
      const content = contentOf(q);
      const now = deps.now();
      const followUp = q.ifNoReplyWithin !== undefined;
      let first: Date;
      if (followUp) {
        if (!direct) throw new InvalidInputError(SCHEDULE_TEXTS.followUpDirect);
        if (q.repeat !== "none") throw new InvalidInputError(SCHEDULE_TEXTS.followUpOnce);
        if (q.at !== undefined) throw new InvalidInputError(SCHEDULE_TEXTS.followUpAt);
        const window = parseReplyWindow(q.ifNoReplyWithin ?? "");
        if (window === null) throw new InvalidInputError(SCHEDULE_TEXTS.replyWindow);
        first = new Date(now.getTime() + window);
      } else {
        if (q.at === undefined) throw new InvalidInputError(SCHEDULE_TEXTS.needAt);
        first = parseLocalDateTime(q.at, tz);
        if (first.getTime() <= now.getTime())
          throw new InvalidInputError(SCHEDULE_TEXTS.past(formatLocal(now, tz), tz));
      }
      const maxRuns = maxRunsOf(q);
      if (store.countActive(tenantId) >= limits.maxActivePerTenant)
        throw new InvalidInputError(SCHEDULE_TEXTS.active(limits.maxActivePerTenant));

      const ids = direct ? await forms(q.chatId) : [q.chatId];
      // Stored in its normalized form (`@s.whatsapp.net` → `@c.us`), as missions store theirs.
      const chatId = ids[0] ?? q.chatId;
      let known = !direct;
      for (const id of ids) if (!known) known = await deps.hasHistory(id);
      const newContact = !known;
      if (newContact) {
        const since = dayStart(now, tz).toISOString();
        const today =
          deps.missions.countNewContactToday(tenantId, since) +
          store.countNewContactToday(tenantId, since);
        if (today >= ml.maxNewContactsPerDay)
          throw new InvalidInputError(SCHEDULE_TEXTS.newContacts(ml.maxNewContactsPerDay));
      }

      const owner = deps.ownerChatId ? await forms(deps.ownerChatId) : [];
      const toOwner = owner.some((id) => ids.includes(id));
      const note =
        !toOwner && inQuietHours(first, tz, ml)
          ? SCHEDULE_TEXTS.quietHours(
              hh(ml.quietStartHour),
              hh(ml.quietEndHour),
              formatLocal(nextAllowedInitiatedSend(first, tz, ml), tz),
            )
          : null;

      const row = store.create({
        tenantId,
        chatId,
        kind: q.kind,
        repeat: q.repeat,
        firstAt: first.toISOString(),
        nextRunAt: first.toISOString(),
        maxRuns,
        newContact,
        followUpSince: followUp ? now.toISOString() : null,
      });
      try {
        log.putContent(row.id, content);
      } catch (error) {
        // Without its content the schedule could only fail: it is not kept.
        store.deleteSchedules(tenantId, [row.id]);
        throw error;
      }
      return { row, note };
    },

    list() {
      return store.listActive(tenantId).map((row) => ({
        row,
        content: log.content(row.id) ?? {},
        runs: log.runs(row.id, LAST_RUNS),
      }));
    },

    cancel(id) {
      const s = find(id);
      if (s.state !== "active" || !deps.cancel(tenantId, s.id)) {
        const current = find(id);
        throw new InvalidInputError(SCHEDULE_TEXTS.notActive(current.id, current.state));
      }
      return find(id);
    },
  };
}
