import { LlmUnavailableError } from "../../domain/errors.js";
import {
  type MissionEventKind,
  type MissionSnapshot,
  type StopReason,
  transition,
} from "../../domain/missions/mission.js";
import { inQuietHours, monthStart } from "../../domain/missions/pacing.js";
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

const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
const AGENT_MAX_TOKENS = 2048;
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

/** Engine state the turns share: timelocked tenants and consecutive LLM failures per mission. */
export interface TurnState {
  locked: Set<string>;
  llmFailures: Map<string, number>;
}

/**
 * Agent turns and terminal transitions of one mission: caps, the LLM call, tool effects, paced
 * sends, owner notices and the closing line. Log lines carry mission ids and outcomes only.
 */
export function createMissionTurns(deps: MissionEngineDeps, state: TurnState) {
  const { missions, limits, logger } = deps;
  const { locked, llmFailures } = state;

  const iso = (d: Date): string => d.toISOString();
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
    logger.info(
      `mission=${c.m.id} state=${next.state}${next.stopReason ? ` reason=${next.stopReason}` : ""}`,
    );
    const who = label(c);
    if (next.state === "succeeded") await notify(c, ownerTexts.succeeded(who, summary ?? ""));
    else if (next.state === "failed") await notify(c, ownerTexts.failed(who, summary ?? ""));
    else if (next.state === "expired") await notify(c, ownerTexts.expired(who));
    else if (next.state === "stopped" && next.stopReason)
      await notify(c, ownerTexts.stopped(who, next.stopReason));

    const closable =
      (next.state === "expired" || next.state === "cancelled" || next.state === "stopped") &&
      Boolean(c.m.closingMessage) &&
      !(next.stopReason && NO_CLOSING.has(next.stopReason)) &&
      !quiet(c.now) &&
      !locked.has(c.m.tenantId) &&
      c.m.sentCount < limits.maxMessagesPerMission &&
      c.m.llmCalls < limits.maxLlmCallsPerMission &&
      !overBudget(c.m.tenantId, c.now);
    if (closable) {
      const reason = next.state === "stopped" ? (next.stopReason ?? "stopped") : next.state;
      await turn(
        { ...c, m: reload(c.m) },
        { instruction: TURN_TEXT.closing(reason), closing: true },
      );
    }
  }

  async function send(c: Ctx, text: string, seenIds: string[]): Promise<boolean> {
    try {
      const sent = await sendPaced(
        { sender: c.port.sender, sleep: deps.sleep, rand: deps.rand },
        { chatId: c.m.chatId, text, seenIds },
      );
      c.port.log.append(c.m.id, { kind: "sent", at: iso(deps.now()), body: { id: sent.id } });
      const m = reload(c.m);
      missions.update(c.m.id, { sentCount: m.sentCount + 1, lastAgentAt: iso(c.now) });
      return true;
    } catch {
      // Never retried: the outcome may be unknown (it may have been delivered).
      logger.info(`mission=${c.m.id} send=failed`);
      return false;
    }
  }

  const append = (c: Ctx, kind: "message" | "notice", body: MessageBody | { text: string }): void =>
    c.port.log.append(c.m.id, { kind, at: iso(c.now), body });

  /** One agent turn: instruction and notices are logged once (a retry reuses them). */
  async function turn(
    c: Ctx,
    q: { instruction: string | null; reminder?: boolean; closing?: boolean },
  ): Promise<void> {
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
      await send(c, t.reply, conv.pending.contactIds);
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
  return { end, turn, schedule, nextWake, append, quiet, iso };
}
