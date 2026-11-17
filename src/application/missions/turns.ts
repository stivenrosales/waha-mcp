import type Anthropic from "@anthropic-ai/sdk";
import { LlmUnavailableError } from "../../domain/errors.js";
import {
  type MissionEventKind,
  type MissionSnapshot,
  type StopReason,
  transition,
} from "../../domain/missions/mission.js";
import {
  inQuietHours,
  monthStart,
  nextAllowedInitiatedSend,
} from "../../domain/missions/pacing.js";
import type { LlmTurnResult } from "../../domain/ports/LlmClient.js";
import type { MissionRow } from "../../domain/ports/MissionStore.js";
import { AGENT_TOOLS, parseAgentTurn } from "./agentTools.js";
import type { MissionEngineDeps, MissionTenantPort } from "./engine.js";
import { buildConversation, type Conversation, type MessageBody } from "./history.js";
import { contactLabel, notifyOwner, ownerTexts } from "./notify.js";
import { sendPaced } from "./pacedSender.js";

/** Agent-facing instructions inside the user turn (English, like the rest of the agent's input). */
export const TURN_TEXT = {
  opening: "The mission starts now. Send your opening message.",
  reminder: "No reply yet. Send a short, friendly reminder.",
  closing: (reason: string) => `The mission is over (${reason}). Send one short closing message.`,
  idle: "There are no new messages from the contact.",
};

/** Retry ladder of an unavailable LLM, and of a failed opening send (resent, no new LLM call). */
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
/** A closing line postponed (quiet hours, pause) longer than this is dropped: too late to help. */
const CLOSING_MAX_DELAY_MS = 24 * 3_600_000;
/** How often a closing line held by a reach-out pause is checked again. */
const PAUSE_RECHECK_MS = 60_000;
/** Haiku's thinking blocks count against it: room for thinking plus the reply (plan: 4000). */
const AGENT_MAX_TOKENS = 4000;
const NO_CLOSING = new Set<StopReason>([
  "refusal",
  "restriction",
  "revoked",
  "budget",
  "llm_cap",
  "message_cap",
]);

export const snapshot = (m: MissionRow): MissionSnapshot => ({
  state: m.state,
  stopReason: m.stopReason,
  newContact: m.newContact,
  reminderCount: m.reminderCount,
  lastAgentAt: m.lastAgentAt,
  lastInboundAt: m.lastInboundAt,
  lastReminderAt: null,
});

export interface Ctx {
  m: MissionRow;
  port: MissionTenantPort;
  owner: string | null;
  now: Date;
}

/** Engine state the turns share. */
export interface TurnState {
  /** Consecutive LLM failures per mission (retry ladder). */
  llmFailures: Map<string, number>;
  /** True once the engine is stopping: no new LLM call starts. */
  isStopped: () => boolean;
  /** True once the owner took this mission over (set before the takeover is applied). */
  ownerSteppedIn: (missionId: string) => boolean;
}

/**
 * Agent turns and terminal transitions of one mission: caps, the LLM call, tool effects, paced
 * sends, owner notices and the closing line. Log lines carry mission ids and outcomes only.
 */
export function createMissionTurns(deps: MissionEngineDeps, state: TurnState) {
  const { missions, limits, logger } = deps;
  const { llmFailures, isStopped, ownerSteppedIn } = state;
  /** Failed sends of a mission's opening line (resend ladder); reset on restart, like LLM retries. */
  const openingSendFailures = new Map<string, number>();
  const iso = (d: Date): string => d.toISOString();
  /** WhatsApp reach-out timelock: persisted per tenant (a restart never lifts it), with an end. */
  const paused = (tenantId: string, at: Date): boolean =>
    missions.pausedUntil(tenantId, iso(at)) !== null;
  const quiet = (at: Date): boolean => inQuietHours(at, deps.timezone, limits);
  const reload = (m: MissionRow): MissionRow => missions.get(m.tenantId, m.id) ?? m;

  const schedule = (c: Ctx, at: Date): void => {
    const deadline = Date.parse(c.m.deadlineAt);
    missions.update(c.m.id, { nextWakeAt: iso(new Date(Math.min(at.getTime(), deadline))) });
  };

  /** Next reminder (when one is left) or the deadline. */
  const nextWake = (m: MissionRow, now: Date): Date => {
    const deadline = new Date(m.deadlineAt);
    const cap = m.newContact ? limits.maxRemindersNewContact : limits.maxReminders;
    if (!m.lastAgentAt || m.reminderCount >= cap) return deadline;
    if (m.lastInboundAt && m.lastInboundAt >= m.lastAgentAt) return deadline;
    const at = Date.parse(m.lastAgentAt) + limits.reminderGapMs;
    return at > now.getTime() && at < deadline.getTime() ? new Date(at) : deadline;
  };

  const timeNotice = (m: MissionRow, now: Date): string => {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: deps.timezone,
      dateStyle: "short",
      timeStyle: "short",
      hourCycle: "h23",
    });
    const left = Math.max(0, Math.round((Date.parse(m.deadlineAt) - now.getTime()) / 60_000));
    return `Current time: ${fmt.format(now)} (${deps.timezone}). Deadline: ${fmt.format(new Date(m.deadlineAt))} (${left} min left).`;
  };

  const label = (c: Ctx): string =>
    contactLabel(buildConversation(c.port.log.read(c.m.id)).spec.contactName, c.m.chatId);

  const notify = (c: Ctx, text: string): Promise<void> =>
    notifyOwner(
      { sender: c.port.sender, logger },
      { ownerChatId: c.owner, missionId: c.m.id, text },
    );

  const overBudget = (tenantId: string, now: Date): boolean =>
    deps.tenants.llmSpendUsd({
      tenantId,
      fromIso: iso(monthStart(now, deps.timezone)),
      toIso: iso(now),
    }) >= deps.monthlyBudgetUsd;

  /** Terminal transition: persisted first, then the owner notice, then the closing line. */
  async function end(c: Ctx, event: MissionEventKind, summary?: string): Promise<void> {
    const next = transition(snapshot(c.m), event);
    missions.update(c.m.id, {
      state: next.state,
      stopReason: next.stopReason,
      endedAt: iso(c.now),
      nextWakeAt: null,
    });
    llmFailures.delete(c.m.id);
    openingSendFailures.delete(c.m.id);
    logger.info(
      `mission=${c.m.id} state=${next.state}${next.stopReason ? ` reason=${next.stopReason}` : ""}`,
    );
    const who = label(c);
    if (next.state === "succeeded") await notify(c, ownerTexts.succeeded(who, summary ?? ""));
    else if (next.state === "failed") await notify(c, ownerTexts.failed(who, summary ?? ""));
    else if (next.state === "expired") await notify(c, ownerTexts.expired(who));
    else if (next.state === "stopped" && next.stopReason)
      await notify(c, ownerTexts.stopped(who, next.stopReason));

    await closing({ ...c, m: reload(c.m) });
  }

  /** The `<reason>` of the closing instruction, or null when this mission gets no closing line. */
  const closingReason = (m: MissionRow): string | null => {
    if (m.state !== "expired" && m.state !== "cancelled" && m.state !== "stopped") return null;
    if (!m.closingMessage || (m.stopReason && NO_CLOSING.has(m.stopReason))) return null;
    return m.state === "stopped" ? (m.stopReason ?? "stopped") : m.state;
  };

  /**
   * The closing line of an ended mission: an agent-initiated send, so quiet hours postpone it to
   * 08:00 and a reach-out pause holds it (via `nextWakeAt`, picked up by `dueClosings`).
   */
  async function closing(c: Ctx): Promise<void> {
    const reason = closingReason(c.m);
    const endedAt = c.m.endedAt ? Date.parse(c.m.endedAt) : c.now.getTime();
    const allowed =
      reason !== null &&
      c.now.getTime() - endedAt <= CLOSING_MAX_DELAY_MS &&
      c.m.sentCount < limits.maxMessagesPerMission &&
      c.m.llmCalls < limits.maxLlmCallsPerMission &&
      !overBudget(c.m.tenantId, c.now);
    const wakeAt = (at: Date | null): void =>
      missions.update(c.m.id, { nextWakeAt: at ? iso(at) : null });
    if (!allowed) return wakeAt(null);
    // Stopping: keep it due so the next process sends it.
    if (isStopped()) return wakeAt(c.now);
    if (quiet(c.now)) return wakeAt(nextAllowedInitiatedSend(c.now, deps.timezone, limits));
    if (paused(c.m.tenantId, c.now)) return wakeAt(new Date(c.now.getTime() + PAUSE_RECHECK_MS));
    wakeAt(null);
    await turn({ ...c, m: reload(c.m) }, { instruction: TURN_TEXT.closing(reason), closing: true });
  }

  async function send(
    c: Ctx,
    text: string,
    seenIds: string[],
  ): Promise<"sent" | "skipped" | "failed"> {
    try {
      const sent = await sendPaced(
        { sender: c.port.sender, sleep: deps.sleep, rand: deps.rand },
        { chatId: c.m.chatId, text, seenIds, cancelled: () => ownerSteppedIn(c.m.id) },
      );
      if (!sent) {
        // The owner wrote in the chat during the typing pause: their message stands alone.
        logger.info(`mission=${c.m.id} send=skipped reason=taken_over`);
        return "skipped";
      }
      c.port.log.append(c.m.id, { kind: "sent", at: iso(deps.now()), body: { id: sent.id } });
      const m = reload(c.m);
      missions.update(c.m.id, { sentCount: m.sentCount + 1, lastAgentAt: iso(c.now) });
      return "sent";
    } catch {
      // Not retried, except the opening line (see `resendOpening`): the outcome may be unknown.
      logger.info(`mission=${c.m.id} send=failed`);
      return "failed";
    }
  }

  /**
   * The opening line the agent wrote but that never went out (its send failed): nothing was ever
   * sent in this mission yet the last agent turn has a reply. Null otherwise.
   */
  function unsentOpening(m: MissionRow, conv: Conversation): string | null {
    if (m.lastAgentAt !== null || m.sentCount > 0 || conv.sentIds.size > 0) return null;
    const last = [...conv.messages].reverse().find((x) => x.role === "assistant");
    if (!last || typeof last.content === "string") return null;
    const t = parseAgentTurn(last.content as Anthropic.ContentBlock[]);
    return t.reply && !t.noReply ? t.reply : null;
  }

  /**
   * A failed opening send waits on the LLM retry ladder (+30 s, +2 min, +5 min) and is resent as
   * written (no new LLM call); when the ladder runs out, the mission stops with `errors`.
   */
  async function openingSendFailed(c: Ctx): Promise<void> {
    const n = (openingSendFailures.get(c.m.id) ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[n - 1];
    if (delay === undefined) return end(c, { type: "stop", reason: "errors" });
    openingSendFailures.set(c.m.id, n);
    logger.info(`mission=${c.m.id} opening=unsent attempt=${n}`);
    schedule(c, new Date(c.now.getTime() + delay));
  }

  async function resendOpening(c: Ctx, text: string): Promise<void> {
    if (isStopped()) return;
    const r = await send(c, text, []);
    if (r === "failed") return openingSendFailed({ ...c, m: reload(c.m) });
    openingSendFailures.delete(c.m.id);
    const m = reload(c.m);
    if (m.state === "active") schedule({ ...c, m }, nextWake(m, c.now));
  }

  const append = (c: Ctx, kind: "message" | "notice", body: MessageBody | { text: string }): void =>
    c.port.log.append(c.m.id, { kind, at: iso(c.now), body });

  /** One agent turn: instruction and notices are logged once (a retry reuses them). */
  async function turn(
    c: Ctx,
    q: { instruction: string | null; reminder?: boolean; closing?: boolean },
  ): Promise<void> {
    if (isStopped()) return;
    if (!q.closing) {
      const cap: StopReason | null =
        c.m.llmCalls >= limits.maxLlmCallsPerMission
          ? "llm_cap"
          : c.m.sentCount >= limits.maxMessagesPerMission
            ? "message_cap"
            : overBudget(c.m.tenantId, c.now)
              ? "budget"
              : null;
      if (cap) return end(c, { type: "stop", reason: cap });
    }
    let conv = buildConversation(c.port.log.read(c.m.id));
    if (!conv.pending.notices.some((n) => n.startsWith("Current time:")))
      append(c, "notice", { text: timeNotice(c.m, c.now) });
    const instruction = q.instruction ?? (conv.pending.userBlocks === 0 ? TURN_TEXT.idle : null);
    if (instruction && !conv.pending.engineTexts.includes(instruction))
      append(c, "message", { from: "engine", text: instruction });
    conv = buildConversation(c.port.log.read(c.m.id));

    let result: LlmTurnResult;
    try {
      result = await deps.llm.turn({
        system: conv.system,
        messages: conv.messages,
        tools: AGENT_TOOLS,
        effort: "medium",
        maxTokens: AGENT_MAX_TOKENS,
      });
    } catch (err) {
      return failed(c, err, q.closing === true);
    }
    llmFailures.delete(c.m.id);
    try {
      deps.tenants.recordLlmUsage({
        tenantId: c.m.tenantId,
        missionId: c.m.id,
        at: iso(c.now),
        model: deps.model,
        kind: "agent",
        usage: result.usage,
      });
    } catch {
      logger.info(`mission=${c.m.id} usage=not-recorded`);
    }
    missions.update(c.m.id, { llmCalls: reload(c.m).llmCalls + 1 });
    c = { ...c, m: reload(c.m) };

    if (result.stopReason === "refusal") {
      if (!q.closing) await end(c, { type: "stop", reason: "refusal" });
      return;
    }
    if (result.stopReason === "max_tokens")
      return failed(c, new LlmUnavailableError(null), q.closing === true);
    await applyTurn(c, conv, result, q);
  }

  async function applyTurn(
    c: Ctx,
    conv: Conversation,
    result: LlmTurnResult,
    q: { reminder?: boolean; closing?: boolean },
  ): Promise<void> {
    const t = parseAgentTurn(result.content);
    append(c, "message", { from: "agent", content: result.content });
    if (t.toolResults.length > 0) append(c, "message", { from: "tool", content: t.toolResults });
    if (q.closing) {
      if (t.reply) await send(c, t.reply, []);
      return;
    }
    if (t.question) {
      c.port.log.append(c.m.id, {
        kind: "question",
        at: iso(c.now),
        body: { question: t.question },
      });
      await notify(c, ownerTexts.question(label(c), t.question));
    }
    if (t.finish) {
      c.port.log.append(c.m.id, {
        kind: "summary",
        at: iso(c.now),
        body: { outcome: t.finish.outcome, summary: t.finish.summary },
      });
      if (t.finish.collected.length > 0)
        c.port.log.append(c.m.id, { kind: "collected", at: iso(c.now), body: t.finish.collected });
    }
    if (t.reply && !t.noReply) {
      if (reload(c.m).sentCount >= limits.maxMessagesPerMission)
        return end({ ...c, m: reload(c.m) }, { type: "stop", reason: "message_cap" });
      const r = await send(c, t.reply, conv.pending.contactIds);
      if (
        r === "failed" &&
        !t.finish &&
        unsentOpening(reload(c.m), buildConversation(c.port.log.read(c.m.id)))
      )
        return openingSendFailed({ ...c, m: reload(c.m) });
    }
    if (q.reminder) {
      const m = reload(c.m);
      missions.update(c.m.id, { reminderCount: m.reminderCount + 1, lastAgentAt: iso(c.now) });
    }
    c = { ...c, m: reload(c.m) };
    if (t.finish)
      return end(
        c,
        { type: t.finish.outcome === "succeeded" ? "succeed" : "fail" },
        t.finish.summary,
      );
    schedule(c, nextWake(c.m, c.now));
  }

  async function failed(c: Ctx, err: unknown, closing: boolean): Promise<void> {
    if (closing) {
      logger.info(`mission=${c.m.id} closing=failed`);
      return;
    }
    const n = (llmFailures.get(c.m.id) ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[n - 1];
    if (err instanceof LlmUnavailableError && delay !== undefined) {
      llmFailures.set(c.m.id, n);
      logger.info(`mission=${c.m.id} llm=unavailable attempt=${n}`);
      return schedule(c, new Date(c.now.getTime() + delay));
    }
    return end(c, { type: "stop", reason: "errors" });
  }

  /** Decides what a due mission does now. */
  return {
    end,
    turn,
    closing,
    schedule,
    nextWake,
    append,
    quiet,
    paused,
    iso,
    unsentOpening,
    resendOpening,
  };
}
