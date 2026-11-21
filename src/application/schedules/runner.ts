import { SendOutcomeUnknownError } from "../../domain/errors.js";
import type { MissionLimits } from "../../domain/missions/limits.js";
import {
  inQuietHours,
  monthStart,
  nextAllowedInitiatedSend,
} from "../../domain/missions/pacing.js";
import type { LlmClient } from "../../domain/ports/LlmClient.js";
import type { MissionStore } from "../../domain/ports/MissionStore.js";
import type { RunOutcome, ScheduleLog, ScheduleRun } from "../../domain/ports/ScheduleLog.js";
import type { ScheduleRow, ScheduleStore } from "../../domain/ports/ScheduleStore.js";
import type { TenantStore } from "../../domain/ports/TenantStore.js";
import type { WhatsAppSender } from "../../domain/ports/WhatsAppSender.js";
import { occurrenceAt } from "../../domain/schedules/recurrence.js";
import { chatIdForms } from "../missions/inbound.js";
import { contactLabel, notifyOwner, ownerChatId } from "../missions/notify.js";
import { type PacedDeps, sendPaced } from "../missions/pacedSender.js";
import { type ContextLine, composeScheduled } from "./compose.js";
import { SKIP_REASONS, scheduleTexts } from "./texts.js";

/** One tenant's runtime, from the registry; the caller must `release()` it. */
export interface ScheduleTenantPort {
  sender: WhatsAppSender;
  log: ScheduleLog;
  readContext(chatId: string): Promise<ContextLine[]>;
  lookupLid(id: string): Promise<string | null>;
}

export interface ScheduleRunnerDeps {
  store: ScheduleStore;
  missions: MissionStore;
  tenants: Pick<TenantStore, "getTenant" | "llmSpendUsd" | "recordLlmUsage">;
  /** Null when the tenant has no runtime (revoked, deleted, evicted): its schedules wait. */
  acquire(tenantId: string): { port: ScheduleTenantPort; release(): void } | null;
  llm: LlmClient;
  model: string;
  monthlyBudgetUsd: number;
  limits: MissionLimits;
  /** A run later than this is not sent: it is logged as `missed`. */
  missedAfterMs: number;
  /** Server `TIMEZONE`: recurrence, quiet hours and the monthly budget window. */
  timezone: string;
  paced: Omit<PacedDeps, "sender">;
  now(): Date;
  logger: { info(message: string): void };
}

export interface ScheduleRunner {
  tick(now: Date): Promise<void>;
  /** Ticks every `intervalMs` (default 30 s) until `stop()`. */
  start(intervalMs?: number): void;
  stop(): void;
  /** Resolves when the work queued so far is done. */
  idle(): Promise<void>;
  /** Marks the schedule cancelled at once (a run in its typing pause sends nothing). */
  cancel(tenantId: string, id: string): boolean;
  /** After `restore_tenant`: occurrences that passed while revoked become `missed`, one note. */
  catchUp(tenantId: string, now: Date): Promise<void>;
}

const DUE_BATCH = 20;
const iso = (d: Date): string => d.toISOString();
/** The error's class name, safe to log (its message may carry message text). */
const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

interface Ctx {
  s: ScheduleRow;
  port: ScheduleTenantPort;
  owner: string | null;
  now: Date;
}

/**
 * Runs due scheduled messages. A run is attempted at most once: the row is claimed
 * (`nextRunAt = null`) before anything is sent, so a crash never resends. A claim that was
 * never recorded (shutdown, crash, database error) is found at start and on every tick and
 * logged as `unknown`, never sent. Log lines carry schedule ids, outcomes and error names
 * only, never message text or instructions.
 */
export function createScheduleRunner(deps: ScheduleRunnerDeps): ScheduleRunner {
  const { store, missions, limits, logger, timezone: tz } = deps;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Schedules claimed by a run of this process that has not finished yet. */
  const inFlight = new Set<string>();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const label = (s: ScheduleRow): string => contactLabel(null, s.chatId);
  const occurrence = (s: ScheduleRow, index: number): Date =>
    occurrenceAt(new Date(s.firstAt), s.repeat, index, tz);
  const stillActive = (s: ScheduleRow): boolean => store.get(s.tenantId, s.id)?.state === "active";

  const notify = (c: Ctx, text: string): Promise<void> =>
    notifyOwner(
      { sender: c.port.sender, logger },
      { ownerChatId: c.owner, missionId: c.s.id, text },
    );

  function appendRun(c: Ctx, run: ScheduleRun): void {
    try {
      c.port.log.appendRun(c.s.id, run);
    } catch (err) {
      logger.info(`schedule=${c.s.id} runlog=failed error=${errName(err)}`);
    }
  }

  /** Moves past `runsDone` occurrences; ends the schedule when none is left. True when ended. */
  function advance(c: Ctx, runsDone: number): boolean {
    if (!stillActive(c.s)) return false;
    if (runsDone >= c.s.maxRuns || c.s.repeat === "none") {
      store.update(c.s.id, { runsDone, state: "done", endedAt: iso(c.now), nextRunAt: null });
      return true;
    }
    store.update(c.s.id, { runsDone, nextRunAt: iso(occurrence(c.s, runsDone)) });
    return false;
  }

  const late = (s: ScheduleRow, now: Date): boolean =>
    s.nextRunAt !== null && now.getTime() - Date.parse(s.nextRunAt) > deps.missedAfterMs;

  /**
   * Logs the current occurrence and every following one already past the missed window as
   * `missed` (capped at `maxRuns`), then points at the next occurrence. Never sends.
   */
  function markMissed(c: Ctx): { n: number; ended: boolean } {
    const { s, now } = c;
    const cap = s.repeat === "none" ? 1 : s.maxRuns;
    const missedAt = [iso(occurrence(s, s.runsDone))];
    let index = s.runsDone + 1;
    while (index < cap && occurrence(s, index).getTime() + deps.missedAfterMs < now.getTime()) {
      missedAt.push(iso(occurrence(s, index)));
      index += 1;
    }
    const ended = advance(c, index);
    for (const at of missedAt) appendRun(c, { at, outcome: "missed" });
    logger.info(`schedule=${s.id} missed=${missedAt.length}`);
    return { n: missedAt.length, ended };
  }

  async function sameChat(a: string, b: string, port: ScheduleTenantPort): Promise<boolean> {
    if (a === b) return true;
    const lookup = (lid: string) => port.lookupLid(lid);
    const [fa, fb] = await Promise.all([chatIdForms(a, lookup), chatIdForms(b, lookup)]);
    return fa.some((id) => fb.includes(id));
  }

  /**
   * True when an active mission talks to the schedule's chat. When a `@lid` cannot be
   * resolved because the lookup failed, the answer is unknown: fail closed (true).
   */
  async function missionOnChat(c: Ctx): Promise<boolean> {
    const active = missions.list(c.s.tenantId, "active");
    if (active.length === 0) return false;
    let lookupFailed = false;
    const lookup = async (lid: string): Promise<string | null> => {
      try {
        return await c.port.lookupLid(lid);
      } catch (err) {
        lookupFailed = true;
        throw err;
      }
    };
    const forms = await chatIdForms(c.s.chatId, lookup);
    for (const m of active) {
      if (m.chatId === c.s.chatId) return true;
      const other = await chatIdForms(m.chatId, lookup);
      if (other.some((id) => forms.includes(id))) return true;
    }
    if (lookupFailed) logger.info(`schedule=${c.s.id} lid-lookup=failed`);
    return lookupFailed;
  }

  const overBudget = (tenantId: string, now: Date): boolean =>
    deps.tenants.llmSpendUsd({
      tenantId,
      fromIso: iso(monthStart(now, tz)),
      toIso: iso(now),
    }) >= deps.monthlyBudgetUsd;

  /**
   * Runs `fn` with the tenant runtime; a tenant with none (or whose runtime fails to open) is
   * left untouched. False when the runtime was unavailable.
   */
  async function withTenant(
    tenantId: string,
    fn: (port: ScheduleTenantPort, owner: string | null) => Promise<void>,
  ): Promise<boolean> {
    let held: ReturnType<ScheduleRunnerDeps["acquire"]>;
    try {
      held = deps.acquire(tenantId);
    } catch (err) {
      logger.info(`tenant=${tenantId} runtime=unavailable error=${errName(err)}`);
      return false;
    }
    if (!held) return false;
    try {
      const tenant = deps.tenants.getTenant(tenantId);
      await fn(held.port, ownerChatId(tenant?.waId ?? null));
    } finally {
      held.release();
    }
    return true;
  }

  /** The text to send, or the outcome when there is nothing to send. */
  async function compose(
    c: Ctx,
    instruction: string,
  ): Promise<{ send: string } | { run: ScheduleRun }> {
    const { s, now } = c;
    const at = iso(now);
    const skip = (reason: string) => ({ run: { at, outcome: "skipped" as const, reason } });
    if (overBudget(s.tenantId, now)) return skip(SKIP_REASONS.budget);
    let result: Awaited<ReturnType<typeof composeScheduled>>;
    try {
      result = await composeScheduled(
        { llm: deps.llm, readContext: (chatId) => c.port.readContext(chatId) },
        { chatId: s.chatId, instruction, now, timezone: tz },
      );
    } catch (err) {
      logger.info(`schedule=${s.id} compose=failed error=${errName(err)}`);
      return skip(SKIP_REASONS.llm);
    }
    try {
      deps.tenants.recordLlmUsage({
        tenantId: s.tenantId,
        missionId: s.id,
        at,
        model: deps.model,
        kind: "agent",
        usage: result.usage,
      });
    } catch (err) {
      logger.info(`schedule=${s.id} usage=not-recorded error=${errName(err)}`);
    }
    const d = result.decision;
    return d.action === "send" ? { send: d.text } : skip(d.reason);
  }

  /** The outcome of one claimed run, or null when it was cancelled before sending. */
  async function attempt(c: Ctx): Promise<ScheduleRun | null> {
    const { s, now } = c;
    const at = iso(now);
    if (await missionOnChat(c)) return { at, outcome: "skipped", reason: SKIP_REASONS.mission };
    const content = c.port.log.content(s.id);
    const source = s.kind === "fixed" ? content?.text : content?.instruction;
    if (!source) {
      logger.info(`schedule=${s.id} content=missing`);
      return { at, outcome: "failed" };
    }
    const composed = s.kind === "fixed" ? { send: source } : await compose(c, source);
    if ("run" in composed) return composed.run;
    const text = composed.send;
    let outcome: RunOutcome;
    try {
      const sent = await sendPaced(
        { ...deps.paced, sender: c.port.sender },
        { chatId: s.chatId, text, seenIds: [], cancelled: () => !stillActive(s) },
      );
      if (sent === null) return null;
      outcome = "sent";
    } catch (err) {
      outcome = err instanceof SendOutcomeUnknownError ? "unknown" : "failed";
    }
    return outcome === "sent" ? { at, outcome, text } : { at, outcome };
  }

  /**
   * Records the outcome of the claimed occurrence at `runsDone`, moves past it and notifies the
   * owner. When the record fails the claim stays, and the next tick reports it as `unknown`.
   */
  async function finish(c: Ctx, run: ScheduleRun): Promise<void> {
    const { s, now } = c;
    // Occurrences that came due while this one was held (quiet hours, pause) are not sent late.
    const cap = s.repeat === "none" ? 1 : s.maxRuns;
    const passed: string[] = [];
    let index = s.runsDone + 1;
    while (index < cap && occurrence(s, index).getTime() <= now.getTime()) {
      passed.push(iso(occurrence(s, index)));
      index += 1;
    }
    let ended: boolean;
    try {
      ended = advance(c, index);
    } catch (err) {
      logger.info(`schedule=${s.id} record=failed error=${errName(err)}`);
      return;
    }
    appendRun(c, run);
    for (const missedAt of passed) appendRun(c, { at: missedAt, outcome: "missed" });
    logger.info(`schedule=${s.id} run=${run.outcome}`);
    if (run.outcome === "failed") await notify(c, scheduleTexts.failed(label(s)));
    else if (run.outcome === "unknown") await notify(c, scheduleTexts.unknown(label(s)));
    else if (s.kind === "ai" && run.outcome === "sent")
      await notify(c, scheduleTexts.sent(label(s), run.text ?? ""));
    else if (s.kind === "ai" && run.outcome === "skipped")
      await notify(c, scheduleTexts.skipped(label(s), run.reason ?? ""));
    if (passed.length > 0) await notify(c, scheduleTexts.missed(label(s), passed.length));
    if (ended && s.repeat !== "none") await notify(c, scheduleTexts.ended(label(s)));
  }

  /** A claim no run of this process holds: its outcome is unknown. Never sends. */
  async function recover(claimed: ScheduleRow): Promise<void> {
    await withTenant(claimed.tenantId, async (port, owner) => {
      const s = store.get(claimed.tenantId, claimed.id);
      if (s?.state !== "active" || s.nextRunAt !== null || inFlight.has(s.id)) return;
      logger.info(`schedule=${s.id} claim=stale`);
      const run: ScheduleRun = { at: iso(occurrence(s, s.runsDone)), outcome: "unknown" };
      await finish({ s, port, owner, now: deps.now() }, run);
    });
  }

  async function recoverClaimed(): Promise<void> {
    for (const s of store.claimed()) {
      if (stopped) return;
      if (inFlight.has(s.id)) continue;
      try {
        await recover(s);
      } catch (err) {
        logger.info(`schedule=${s.id} recover=error error=${errName(err)}`);
      }
    }
  }

  /** False when the tenant runtime was unavailable (the row was left untouched). */
  async function runOne(due: ScheduleRow): Promise<boolean> {
    // Re-read: an earlier run of this batch may have paused long enough for a cancel.
    const s = store.get(due.tenantId, due.id);
    if (s?.state !== "active" || s.nextRunAt !== due.nextRunAt) return true;
    return withTenant(s.tenantId, async (port, owner) => {
      // Fresh per run: an earlier run of this batch may have taken minutes.
      const now = deps.now();
      const c: Ctx = { s, port, owner, now };
      if (late(s, now)) {
        const { n, ended } = markMissed(c);
        await notify(c, scheduleTexts.missed(label(s), n));
        if (ended && s.repeat !== "none") await notify(c, scheduleTexts.ended(label(s)));
        return;
      }
      const toOwner = owner !== null && (await sameChat(s.chatId, owner, port));
      if (!toOwner) {
        if (inQuietHours(now, tz, limits)) {
          store.update(s.id, { nextRunAt: iso(nextAllowedInitiatedSend(now, tz, limits)) });
          return;
        }
        const until = missions.pausedUntil(s.tenantId, iso(now));
        if (until) {
          store.update(s.id, { nextRunAt: until });
          return;
        }
      }
      // Claimed: from here on this occurrence is never attempted again.
      store.update(s.id, { nextRunAt: null });
      inFlight.add(s.id);
      try {
        // A throw from `attempt` happens before any send (send errors are outcomes): a failed run.
        const run = await attempt(c).catch((err: unknown): ScheduleRun => {
          logger.info(`schedule=${s.id} attempt=error error=${errName(err)}`);
          return { at: iso(now), outcome: "failed" };
        });
        if (run === null) {
          logger.info(`schedule=${s.id} run=cancelled`);
          return;
        }
        await finish(c, run);
      } finally {
        inFlight.delete(s.id);
      }
    });
  }

  /**
   * Recovers stale claims, then runs up to `DUE_BATCH` due rows. Rows of a tenant whose
   * runtime is unavailable are paged past so they cannot fill the batch.
   */
  async function runTick(now: Date): Promise<void> {
    await recoverClaimed();
    const unavailable = new Set<string>();
    let handled = 0;
    while (handled < DUE_BATCH && !stopped) {
      const batch = store.due(iso(now), DUE_BATCH, [...unavailable]);
      if (batch.length === 0) return;
      for (const s of batch) {
        if (stopped || handled >= DUE_BATCH) return;
        if (unavailable.has(s.tenantId)) continue;
        try {
          if (await runOne(s)) handled += 1;
          else unavailable.add(s.tenantId);
        } catch (err) {
          handled += 1;
          logger.info(`schedule=${s.id} run=error error=${errName(err)}`);
        }
      }
    }
  }

  return {
    tick: (now) => serial(() => runTick(now)),
    idle: () => chain,
    start(intervalMs = 30_000) {
      if (timer || stopped) return;
      void serial(recoverClaimed).catch(() => logger.info("schedules recover=failed"));
      timer = setInterval(() => {
        void serial(() => runTick(deps.now())).catch(() => logger.info("schedules tick=failed"));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    cancel(tenantId, id) {
      if (store.get(tenantId, id)?.state !== "active") return false;
      store.update(id, { state: "cancelled", endedAt: iso(deps.now()), nextRunAt: null });
      return true;
    },
    catchUp: (tenantId, now) =>
      serial(async () => {
        await withTenant(tenantId, async (port, owner) => {
          let total = 0;
          let endedCount = 0;
          for (const s of store.listActive(tenantId)) {
            if (!late(s, now)) continue;
            const { n, ended } = markMissed({ s, port, owner, now });
            total += n;
            if (ended && s.repeat !== "none") endedCount += 1;
          }
          if (total > 0)
            await notifyOwner(
              { sender: port.sender, logger },
              {
                ownerChatId: owner,
                missionId: `tenant:${tenantId}`,
                text: scheduleTexts.restoredMissed(total, endedCount),
              },
            );
        });
      }),
  };
}
