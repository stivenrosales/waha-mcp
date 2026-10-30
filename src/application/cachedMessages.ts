import { createHash } from "node:crypto";
import type { ChatSyncState, MessageStore, RawMessageRow } from "../domain/ports/MessageStore.js";
import type { WahaGateway } from "../domain/ports/WahaGateway.js";

/** WAHA page size used for every sync read. */
const PAGE = 200;
/** A chat synced less than this long ago is answered from the cache without calling WAHA. */
export const FRESH_MS = 60_000;
const PRUNE_EVERY_MS = 3600 * 1000;
/** Pages one call may read to extend a chat's cache downwards before it falls back to WAHA. */
const DEFAULT_BACKFILL_MAX_PAGES = 25;
/** Pages one refresh may read; beyond that the cache cannot prove there is no gap. */
const REFRESH_MAX_PAGES = 100;

export interface CachedGatewayOptions {
  /** Every sync re-reads messages newer than (newest cached − this), picking up edits and revokes. */
  refreshHours: number;
  /** Prune messages older than this many days (0 = keep forever). */
  maxAgeDays: number;
  /** Default 25 pages (5000 events). */
  backfillMaxPages?: number;
  /** WAHA session name; with `getMe().id` it identifies the account the cache belongs to. */
  session: string;
  /** Clock in epoch milliseconds (injectable for tests). */
  now?: () => number;
}

type Query = { limit: number; offset: number; from?: number; to?: number };

/** Keys raw payloads; `null` when one has no usable timestamp (the cache cannot place it). */
function toRows(page: unknown[]): RawMessageRow[] | null {
  const rows: RawMessageRow[] = [];
  for (const raw of page) {
    const o = (typeof raw === "object" && raw !== null ? raw : {}) as {
      id?: unknown;
      timestamp?: unknown;
    };
    const ts =
      typeof o.timestamp === "number"
        ? o.timestamp
        : typeof o.timestamp === "string" && /^\d+$/.test(o.timestamp)
          ? Number(o.timestamp)
          : Number.NaN;
    if (!Number.isFinite(ts)) return null;
    const id =
      typeof o.id === "string" && o.id !== ""
        ? o.id
        : `nokey:${createHash("sha256").update(JSON.stringify(raw)).digest("hex")}`;
    rows.push({ id, ts: Math.floor(ts), raw });
  }
  return rows;
}

const maxOf = (a: number | null, values: number[]): number | null =>
  values.reduce<number | null>((acc, v) => (acc === null || v > acc ? v : acc), a);

/**
 * WAHA gateway whose `getMessages` is answered from a SQLite copy of each chat (lazy: a chat is
 * cached the first time it is read). Same contract as WAHA: newest first, `limit`/`offset`
 * over raw events, inclusive unix-second bounds; so `getMessages` / `fetchRange` and every tool
 * above them keep their semantics. Per call, holding a per-chat lock:
 *
 * 1. Head: a chat synced ≥ 60 s ago re-reads WAHA from (newest cached − `refreshHours`), so new
 *    messages, edits and revokes in that window replace the stored payloads.
 * 2. Coverage: the cache proves it holds every message with `ts >= oldestTs`. When the request
 *    needs older data (its `from` is older, or fewer than `offset + limit` covered messages
 *    match), WAHA is read downwards from `oldestTs`, bounded by the request's `from` and by the
 *    rows it needs, at most `backfillMaxPages` pages. If that is not enough, this one request
 *    goes straight to WAHA (progress made is kept).
 * 3. The page is read from SQLite.
 */
export function createCachedGateway(
  gw: WahaGateway,
  store: MessageStore,
  opts: CachedGatewayOptions,
): WahaGateway {
  const now = opts.now ?? Date.now;
  const windowS = opts.refreshHours * 3600;
  const budget = opts.backfillMaxPages ?? DEFAULT_BACKFILL_MAX_PAGES;
  const locks = new Map<string, Promise<unknown>>();
  /** Coverage note of each page answered from the cache, keyed by the returned array. */
  const notes = new WeakMap<unknown[], string>();
  /** True once the cache is known to belong to the current account (wiped otherwise). */
  let ownerChecked = false;
  let ownerCheck: Promise<boolean> | null = null;
  let lastPrune = Number.NEGATIVE_INFINITY;

  const prune = (): void => {
    if (opts.maxAgeDays <= 0) return;
    lastPrune = now();
    store.prune(Math.floor(lastPrune / 1000) - opts.maxAgeDays * 86400);
  };
  prune(); // startup
  const maybePrune = (): void => {
    if (now() - lastPrune >= PRUNE_EVERY_MS) prune();
  };

  /**
   * Resolves the account (session + `getMe().id`) before anything is served from the cache.
   * A different or unrecorded owner wipes the cache. While `getMe` fails, the cache is not used.
   */
  const ensureOwner = (): Promise<boolean> => {
    if (ownerChecked) return Promise.resolve(true);
    ownerCheck ??= gw
      .getMe()
      .then((me) => {
        const owner = `${opts.session}|${me.id}`;
        if (store.getOwner() !== owner) store.resetForOwner(owner);
        ownerChecked = true;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        ownerCheck = null;
      });
    return ownerCheck;
  };

  /** Runs `fn` after every earlier call on the same chat settled (success or failure). */
  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  };

  /** Re-reads the head window. `null` when WAHA returned payloads the cache cannot key. */
  async function refresh(chatId: string, st: ChatSyncState): Promise<ChatSyncState | null> {
    const from = st.newestTs !== null ? st.newestTs - windowS : (st.oldestTs ?? undefined);
    const ids: string[] = [];
    let newestTs = st.newestTs;
    let oldestSeen: number | null = null;
    for (let page = 0; page < REFRESH_MAX_PAGES; page++) {
      const raws = await gw.getMessages(chatId, { limit: PAGE, offset: page * PAGE, from });
      const rows = toRows(raws);
      if (!rows) return null;
      store.upsertRaw(chatId, rows);
      for (const r of rows) {
        ids.push(r.id);
        if (oldestSeen === null || r.ts < oldestSeen) oldestSeen = r.ts;
      }
      newestTs = maxOf(
        newestTs,
        rows.map((r) => r.ts),
      );
      if (raws.length < PAGE) {
        // The whole window came in one read: anything cached in it that WAHA no longer has is
        // gone. Across several offset pages rows may shift between reads, so absence proves nothing.
        if (page === 0) store.deleteMissing(chatId, from, ids);
        const next: ChatSyncState = {
          newestTs,
          oldestTs: st.oldestTs === null || from === undefined ? null : Math.min(st.oldestTs, from),
          lastSyncAt: now(),
        };
        store.setSyncState(chatId, next);
        return next;
      }
    }
    // Too many new messages to prove there is no gap below them: trust only what was read.
    const next: ChatSyncState = {
      newestTs,
      oldestTs: (oldestSeen ?? 0) + 1,
      lastSyncAt: now(),
    };
    store.setSyncState(chatId, next);
    return next;
  }

  /** Lower bound of the covered rows a request may read. */
  const readFrom = (st: ChatSyncState, q: Query): number | undefined =>
    st.oldestTs === null ? q.from : Math.max(q.from ?? st.oldestTs, st.oldestTs);

  /** True when the cache can answer `q` exactly as WAHA would. */
  const satisfies = (chatId: string, st: ChatSyncState, q: Query): boolean =>
    st.oldestTs === null ||
    (q.from !== undefined && st.oldestTs <= q.from) ||
    store.countRange(chatId, { fromTs: readFrom(st, q), toTs: q.to }) >= q.offset + q.limit;

  /** Extends coverage downwards until `q` is answerable; false when the budget ran out. */
  async function cover(chatId: string, st: ChatSyncState | null, q: Query): Promise<boolean> {
    if (st && satisfies(chatId, st, q)) return true;
    // Never synced: start at the newest message so the covered range always reaches the head.
    const upper = st ? (st.oldestTs as number) - 1 : undefined;
    let state = st;
    for (let page = 0; page < budget; page++) {
      const raws = await gw.getMessages(chatId, {
        limit: PAGE,
        offset: page * PAGE,
        from: q.from,
        to: upper,
      });
      const rows = toRows(raws);
      if (!rows) return false;
      store.upsertRaw(chatId, rows);
      const tss = rows.map((r) => r.ts);
      const short = raws.length < PAGE;
      state = {
        newestTs: maxOf(state?.newestTs ?? null, tss),
        // A full page may cut its oldest second in two: only the seconds after it are proven.
        oldestTs: short ? (q.from ?? null) : Math.min(...tss) + 1,
        lastSyncAt: state?.lastSyncAt ?? now(),
      };
      store.setSyncState(chatId, state);
      if (short || satisfies(chatId, state, q)) return true;
    }
    return false;
  }

  const noteFor = (st: ChatSyncState): string => {
    const recheck =
      st.newestTs === null
        ? ""
        : ` Edits and deletions are re-checked only for messages since ${new Date((st.newestTs - windowS) * 1000).toISOString()}.`;
    return `Read from the local message cache (last synced with WAHA at ${new Date(st.lastSyncAt).toISOString()}).${recheck}`;
  };

  return {
    getSession: () => gw.getSession(),
    getMe: () => gw.getMe(),
    lookupLid: (lid) => gw.lookupLid(lid),
    listGroups: () => gw.listGroups(),
    getGroup: (groupId) => gw.getGroup(groupId),
    listChats: (q) => gw.listChats(q),
    listContacts: (q) => gw.listContacts(q),
    getMessage: (chatId, messageId) => gw.getMessage(chatId, messageId),
    openMedia: (url) => gw.openMedia(url),

    getMessages(chatId, q) {
      return withLock(chatId, async () => {
        if (!(await ensureOwner())) return gw.getMessages(chatId, q);
        maybePrune();
        let st = store.getSyncState(chatId);
        let usable = true;
        if (st && now() - st.lastSyncAt >= FRESH_MS) {
          const refreshed = await refresh(chatId, st);
          if (refreshed) st = refreshed;
          else usable = false;
        }
        if (!usable || !(await cover(chatId, st, q))) return gw.getMessages(chatId, q);
        const current = store.getSyncState(chatId) as ChatSyncState;
        const page = store.readRange(chatId, {
          fromTs: readFrom(current, q),
          toTs: q.to,
          limit: q.limit,
          offset: q.offset,
        });
        notes.set(page, noteFor(current));
        return page;
      });
    },

    cacheNote(page) {
      return notes.get(page) ?? null;
    },
  };
}
