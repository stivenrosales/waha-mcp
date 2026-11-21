import { shortMessageId } from "../domain/messageId.js";
import {
  CACHE_EVENT_KINDS,
  type CacheEventKind,
  type EventStore,
  type StoredEvent,
} from "../domain/ports/EventStore.js";
import type { StoredReaction, StoredVote } from "../domain/ports/MessageActionStore.js";
import type { MessageActions } from "./messageActions.js";
import { envelopePayload } from "./missions/inbound.js";
import { WEBHOOK_EVENT_RETENTION_DAYS } from "./missions/retention.js";

/** What one cache-sync webhook event does to the stored messages. */
export type CacheEffect =
  | { kind: "edit"; shortId: string; text: string; at: number }
  | { kind: "revoke"; shortId: string; at: number }
  | { kind: "reaction"; reaction: StoredReaction }
  | { kind: "vote"; vote: StoredVote }
  | { kind: "vote_failed"; pollId: string; voter: string; ts: number };

type Raw = Record<string, unknown>;
const rec = (v: unknown): Raw | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const secs = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Who acted: the owner is "me", in a group the participant, else the chat the event came from. */
function actor(o: Raw): string | null {
  return o.fromMe === true ? "me" : (str(o.participant) ?? str(o.from));
}

/**
 * The effect of one stored event's WAHA payload (GOWS shapes), or null when a field it needs is
 * missing. `receivedAt` (unix seconds) stands in for a payload without its own time.
 */
export function cacheEffectOf(
  kind: CacheEventKind,
  payload: Raw,
  receivedAt: number,
): CacheEffect | null {
  switch (kind) {
    case "message.edited": {
      const id = str(payload.editedMessageId);
      if (!id || typeof payload.body !== "string") return null;
      return {
        kind: "edit",
        shortId: shortMessageId(id),
        text: payload.body,
        at: secs(payload.timestamp, receivedAt),
      };
    }
    case "message.revoked": {
      const id = str(payload.revokedMessageId);
      if (!id) return null;
      return {
        kind: "revoke",
        shortId: shortMessageId(id),
        at: secs(payload.timestamp, receivedAt),
      };
    }
    case "message.reaction": {
      const r = rec(payload.reaction);
      const id = str(r?.messageId);
      const reactor = actor(payload);
      if (!r || !id || !reactor || typeof r.text !== "string") return null;
      return {
        kind: "reaction",
        reaction: {
          messageId: shortMessageId(id),
          reactor,
          emoji: r.text,
          ts: secs(payload.timestamp, receivedAt),
        },
      };
    }
    case "poll.vote":
    case "poll.vote.failed": {
      const vote = rec(payload.vote);
      const pollId = str(rec(payload.poll)?.id);
      const voter = vote ? actor(vote) : null;
      if (!vote || !pollId || !voter) return null;
      const ts = secs(vote.timestamp, receivedAt);
      if (kind === "poll.vote.failed")
        return { kind: "vote_failed", pollId: shortMessageId(pollId), voter, ts };
      const options = Array.isArray(vote.selectedOptions)
        ? vote.selectedOptions.filter((o): o is string => typeof o === "string")
        : [];
      return { kind: "vote", vote: { pollId: shortMessageId(pollId), voter, options, ts } };
    }
  }
}

/** The cache processor's view of one tenant runtime. */
export interface CacheEventPort {
  /** The raw webhook body of a stored event (unsealed with the tenant's cipher). */
  openEvent(e: StoredEvent): string;
  actions: MessageActions;
}

export interface CacheEventProcessor {
  /** Handles the pending cache events once, after any tick already running. */
  tick(): Promise<void>;
  /** A cache event arrived: tick soon (several wakes before it runs share one tick). */
  wake(): void;
  start(intervalMs: number): void;
  /** No tick starts after this. */
  stop(): void;
  /** Resolves when the tick in flight (and those queued behind it) is done. */
  idle(): Promise<void>;
}

const EVENT_BATCH = 100;
/** Wait before the next attempt of a failed event: 5 s, 30 s, 2 min, 10 min, then every 30 min. */
const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
/**
 * A failing event is retried until this long after it was received (the webhook retention), so a
 * brief WAHA outage or a session still starting never drops an edit or a deletion.
 */
const GIVE_UP_AFTER_MS = WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

async function apply(actions: MessageActions, effect: CacheEffect): Promise<void> {
  switch (effect.kind) {
    case "edit":
      return actions.applyEdit(effect.shortId, effect.text, effect.at);
    case "revoke":
      return actions.applyRevoke(effect.shortId, effect.at);
    case "reaction":
      return actions.applyReaction(effect.reaction);
    case "vote":
      return actions.applyVote(effect.vote);
    case "vote_failed":
      return actions.applyFailedVote({
        pollId: effect.pollId,
        voter: effect.voter,
        ts: effect.ts,
      });
  }
}

/**
 * Applies stored edit, deletion, reaction and poll-vote events to each tenant's message cache.
 * Log lines carry the event id, tenant, kind and outcome only: never text, emoji or options.
 */
export function createCacheEventProcessor(deps: {
  events: EventStore;
  /** Null when the tenant has no runtime (not active); the caller must `release()`. */
  acquire(tenantId: string): { port: CacheEventPort; release(): void } | null;
  logger: { info(message: string): void };
  /** Clock in ms (tests). */
  now?: () => number;
}): CacheEventProcessor {
  const { events, logger } = deps;
  const now = deps.now ?? Date.now;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let waking = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Failed events in memory: attempts so far and when the next one may run. */
  const failures = new Map<number, { attempts: number; nextAt: number }>();

  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  async function process(): Promise<void> {
    // Events backing off are skipped below; reading that many more keeps them from filling the
    // batch, so one tenant's failing events never hold back another tenant's.
    for (const e of events.pending(EVENT_BATCH + failures.size, CACHE_EVENT_KINDS)) {
      if (stopped) return;
      const retry = failures.get(e.id);
      if (retry && retry.nextAt > now()) continue;
      const tag = `cache-event=${e.id} tenant=${e.tenantId} kind=${e.kind}`;
      let held: ReturnType<typeof deps.acquire>;
      try {
        held = deps.acquire(e.tenantId);
      } catch {
        // Runtime build failed (e.g. disk): keep the event for the next tick.
        logger.info(`${tag} outcome=unavailable`);
        continue;
      }
      if (!held) {
        events.markDone(e.id);
        continue;
      }
      try {
        const payload = envelopePayload(held.port.openEvent(e));
        const effect = payload
          ? cacheEffectOf(
              e.kind as CacheEventKind,
              payload,
              Math.floor(Date.parse(e.receivedAt) / 1000),
            )
          : null;
        if (effect) await apply(held.port.actions, effect);
        events.markDone(e.id);
        failures.delete(e.id);
        logger.info(`${tag} outcome=${effect ? "applied" : "ignored"}`);
      } catch {
        const attempts = (retry?.attempts ?? 0) + 1;
        const at = now();
        if (at - Date.parse(e.receivedAt) >= GIVE_UP_AFTER_MS) {
          events.markDone(e.id);
          failures.delete(e.id);
          logger.info(`${tag} outcome=gave-up attempt=${attempts}`);
        } else {
          const wait = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1] ?? 0;
          failures.set(e.id, { attempts, nextAt: at + wait });
          logger.info(`${tag} outcome=failed attempt=${attempts}`);
        }
      } finally {
        held.release();
      }
    }
  }

  const run = (): Promise<void> => serial(async () => (stopped ? undefined : process()));
  const background = (): void => {
    void run().catch(() => logger.info("cache-events tick=failed"));
  };

  return {
    tick: run,
    wake() {
      if (stopped || waking) return;
      waking = true;
      void serial(async () => {
        waking = false;
        if (!stopped) await process();
      }).catch(() => logger.info("cache-events tick=failed"));
    },
    idle: () => chain,
    start(intervalMs) {
      if (timer || stopped) return;
      timer = setInterval(background, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
