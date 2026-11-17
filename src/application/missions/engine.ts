import type { EngineMapper } from "../../domain/message.js";
import type { MissionLimits } from "../../domain/missions/limits.js";
import { transition } from "../../domain/missions/mission.js";
import { nextAllowedInitiatedSend, reminderDue } from "../../domain/missions/pacing.js";
import type { EventStore, StoredEvent } from "../../domain/ports/EventStore.js";
import type { LlmClient } from "../../domain/ports/LlmClient.js";
import type { MissionLog } from "../../domain/ports/MissionLog.js";
import type { MissionRow, MissionStore } from "../../domain/ports/MissionStore.js";
import type { TenantStore } from "../../domain/ports/TenantStore.js";
import type { WhatsAppSender } from "../../domain/ports/WhatsAppSender.js";
import { buildConversation, shortMessageId } from "./history.js";
import {
  chatIdsOf,
  contactContent,
  envelopePayload,
  type MediaReader,
  payloadShortId,
  timelockActive,
} from "./inbound.js";
import { notifyOwner, ownerChatId, ownerTexts } from "./notify.js";
import { type Ctx, createMissionTurns, snapshot, TURN_TEXT } from "./turns.js";

export { TURN_TEXT };

/** What the engine needs of one tenant's runtime. */
export interface MissionTenantPort extends MediaReader {
  log: MissionLog;
  sender: WhatsAppSender;
  /** The raw webhook body of a stored event (unsealed with the tenant's cipher). */
  openEvent(e: StoredEvent): string;
  mapper(): Promise<EngineMapper>;
  lookupLid(lid: string): Promise<string | null>;
}

export interface MissionEngineDeps {
  missions: MissionStore;
  events: EventStore;
  tenants: Pick<TenantStore, "getTenant" | "recordLlmUsage" | "llmSpendUsd">;
  llm: LlmClient;
  model: string;
  limits: MissionLimits;
  monthlyBudgetUsd: number;
  /** Server `TIMEZONE`: quiet hours and the monthly budget window. */
  timezone: string;
  /** Null when the tenant has no runtime (not active); the caller must `release()`. */
  acquire(tenantId: string): { port: MissionTenantPort; release(): void } | null;
  now: () => Date;
  rand: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: { info(message: string): void };
}

export interface MissionEngine {
  /** Processes pending webhook events, then due missions. Runs one at a time. */
  tick(now: Date): Promise<void>;
  /** Schedules a tick now (coalesced); never throws. */
  wake(): void;
  /** Resolves when the work queued so far is done. */
  idle(): Promise<void>;
  /** Ticks every `intervalMs` (default 5 s) until `stop()`. */
  start(intervalMs?: number): void;
  stop(): void;
  /** Owner cancel: `cancelled`, plus the closing line when set. False when not active. */
  cancel(tenantId: string, missionId: string): Promise<boolean>;
  /** Owner answer to an `ask_owner` question; the next tick runs a turn with it. */
  answer(tenantId: string, missionId: string, text: string): Promise<boolean>;
}

const EVENT_BATCH = 100;
const EVENT_ATTEMPTS = 3;
/** A message older than its mission (by more than clock skew) is history, not an event of it. */
const SKEW_MS = 1000;

/**
 * The mission engine: consumes stored webhook events and mission timers, runs agent turns on the
 * append-only history and sends paced replies. Never logs message content, prompts or secrets:
 * log lines carry mission ids and outcomes only.
 */
export function createMissionEngine(deps: MissionEngineDeps): MissionEngine {
  const { missions, events, limits, logger } = deps;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let waking = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const llmFailures = new Map<string, number>();
  const eventFailures = new Map<number, number>();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const { end, turn, closing, schedule, nextWake, append, quiet, paused, iso } = createMissionTurns(
    deps,
    { llmFailures, isStopped: () => stopped },
  );

  async function step(c: Ctx): Promise<void> {
    if (c.now.getTime() >= Date.parse(c.m.deadlineAt)) return end(c, { type: "expire" });
    if (paused(c.m.tenantId)) return;
    const conv = buildConversation(c.port.log.read(c.m.id));
    const replying = conv.pending.contactIds.length > 0;
    const later = (): void => schedule(c, nextAllowedInitiatedSend(c.now, deps.timezone, limits));
    if (conv.agentTurns === 0) {
      if (!replying && quiet(c.now)) return later();
      return turn(c, { instruction: TURN_TEXT.opening });
    }
    if (replying) return turn(c, { instruction: null });
    if (conv.pending.answers > 0) return quiet(c.now) ? later() : turn(c, { instruction: null });
    if (reminderDue(snapshot(c.m), c.now, limits))
      return quiet(c.now) ? later() : turn(c, { instruction: TURN_TEXT.reminder, reminder: true });
    schedule(c, nextWake(c.m, c.now));
  }

  /** Runs `fn` with the mission's tenant runtime; a revoked or deleted tenant stops it. */
  async function withMission(
    m: MissionRow,
    now: Date,
    fn: (c: Ctx) => Promise<void>,
  ): Promise<void> {
    const tenant = deps.tenants.getTenant(m.tenantId);
    const held = deps.acquire(m.tenantId);
    if (!held) {
      if (m.state !== "active") missions.update(m.id, { nextWakeAt: null });
      else if (!tenant || tenant.status === "revoked") {
        const next = transition(snapshot(m), { type: "stop", reason: "revoked" });
        missions.update(m.id, {
          state: next.state,
          stopReason: next.stopReason,
          endedAt: iso(now),
          nextWakeAt: null,
        });
      }
      return;
    }
    try {
      await fn({ m, port: held.port, owner: ownerChatId(tenant?.waId ?? null), now });
    } finally {
      held.release();
    }
  }

  async function handleMessage(
    e: StoredEvent,
    port: MissionTenantPort,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const active = missions.list(e.tenantId, "active");
    if (active.length === 0) return;
    const mapper = await port.mapper();
    if (mapper.reaction(payload)) return;
    const ids = await chatIdsOf(payload, (lid) => port.lookupLid(lid));
    const m = active.find((x) => ids.has(x.chatId));
    if (!m) return;
    const msg = mapper.message(payload);
    if (Date.parse(msg.timestamp) + SKEW_MS < Date.parse(m.createdAt)) return;
    const tenant = deps.tenants.getTenant(e.tenantId);
    const c: Ctx = { m, port, owner: ownerChatId(tenant?.waId ?? null), now };
    if (msg.fromMe) {
      const sent = buildConversation(port.log.read(m.id)).sentIds;
      const short = payloadShortId(payload) ?? shortMessageId(msg.id);
      if (sent.has(short)) return;
      return end(c, { type: "take_over" });
    }
    // WAHA may deliver the same message twice: one bubble enters the batch once.
    if (buildConversation(port.log.read(m.id)).contactIds.has(shortMessageId(msg.id))) return;
    const content = await contactContent(msg, port);
    if (!content) return;
    append(c, "message", { from: "contact", id: msg.id, content });
    missions.update(m.id, {
      lastInboundAt: iso(now),
      nextWakeAt: iso(new Date(now.getTime() + limits.debounceMs)),
    });
  }

  async function handleEvent(e: StoredEvent, port: MissionTenantPort, now: Date): Promise<void> {
    const payload = envelopePayload(port.openEvent(e));
    if (!payload) return;
    if (e.kind === "message") return handleMessage(e, port, payload, now);
    const lock = timelockActive(payload);
    const wasPaused = paused(e.tenantId);
    // Persisted: a restart keeps the pause until a status explicitly reports no active lock.
    if (lock === true && !wasPaused) {
      missions.setPaused(e.tenantId, true, iso(now));
      logger.info(`tenant=${e.tenantId} missions=paused`);
      const active = missions.list(e.tenantId, "active");
      const first = active[0];
      if (first) {
        const tenant = deps.tenants.getTenant(e.tenantId);
        await notifyOwner(
          { sender: port.sender, logger },
          {
            ownerChatId: ownerChatId(tenant?.waId ?? null),
            missionId: first.id,
            text: ownerTexts.paused(),
          },
        );
      }
    } else if (lock === false && wasPaused) {
      missions.setPaused(e.tenantId, false, iso(now));
      logger.info(`tenant=${e.tenantId} missions=resumed`);
    }
  }

  async function processEvents(now: Date): Promise<void> {
    for (const e of events.pending(EVENT_BATCH)) {
      let held: ReturnType<MissionEngineDeps["acquire"]>;
      try {
        held = deps.acquire(e.tenantId);
      } catch {
        // Runtime build failed (e.g. disk): keep the event for the next tick.
        logger.info(`mission-event=${e.id} tenant=${e.tenantId} outcome=unavailable`);
        continue;
      }
      if (!held) {
        events.markDone(e.id);
        continue;
      }
      try {
        await handleEvent(e, held.port, now);
        events.markDone(e.id);
        eventFailures.delete(e.id);
      } catch {
        const n = (eventFailures.get(e.id) ?? 0) + 1;
        eventFailures.set(e.id, n);
        logger.info(`mission-event=${e.id} tenant=${e.tenantId} outcome=failed attempt=${n}`);
        if (n >= EVENT_ATTEMPTS) {
          events.markDone(e.id);
          eventFailures.delete(e.id);
        }
      } finally {
        held.release();
      }
    }
  }

  async function runTick(now: Date): Promise<void> {
    if (stopped) return;
    await processEvents(now);
    for (const due of missions.due(iso(now))) {
      if (stopped) return;
      try {
        const m = missions.get(due.tenantId, due.id);
        if (m?.state === "active") await withMission(m, now, step);
      } catch {
        logger.info(`mission=${due.id} step=failed`);
      }
    }
    for (const ended of missions.dueClosings(iso(now))) {
      if (stopped) return;
      try {
        await withMission(ended, now, closing);
      } catch {
        logger.info(`mission=${ended.id} closing=failed`);
      }
    }
  }

  return {
    tick: (now) => serial(() => runTick(now)),
    wake() {
      if (stopped || waking) return;
      waking = true;
      void serial(async () => {
        waking = false;
        await runTick(deps.now());
      }).catch(() => logger.info("missions tick=failed"));
    },
    idle: () => chain,
    start(intervalMs = 5000) {
      if (timer || stopped) return;
      timer = setInterval(() => {
        void serial(() => runTick(deps.now())).catch(() => logger.info("missions tick=failed"));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    cancel: (tenantId, missionId) =>
      serial(async () => {
        const m = missions.get(tenantId, missionId);
        if (m?.state !== "active") return false;
        const now = deps.now();
        let done = false;
        await withMission(m, now, async (c) => {
          await end(c, { type: "cancel" });
          done = true;
        });
        return done;
      }),
    answer: (tenantId, missionId, text) =>
      serial(async () => {
        const m = missions.get(tenantId, missionId);
        if (m?.state !== "active") return false;
        const held = deps.acquire(tenantId);
        if (!held) return false;
        try {
          const now = deps.now();
          held.port.log.append(m.id, { kind: "answer", at: iso(now), body: { text } });
          missions.update(m.id, { nextWakeAt: iso(now) });
          return true;
        } finally {
          held.release();
        }
      }),
  };
}
