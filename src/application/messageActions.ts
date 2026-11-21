import type { EngineMapper } from "../domain/message.js";
import type {
  MessageActionStore,
  MessageOverride,
  StoredReaction,
  StoredVote,
} from "../domain/ports/MessageActionStore.js";
import type { MessageStore } from "../domain/ports/MessageStore.js";
import type { TranscriptStore } from "../domain/ports/TranscriptStore.js";

export interface MessageActions {
  /** Stores the edit and rewrites every cached copy of the message. */
  applyEdit(shortId: string, text: string, at: number): Promise<void>;
  /** Stores the revoke, replaces every cached copy by a deleted payload and drops its transcript. */
  applyRevoke(shortId: string, at: number): Promise<void>;
  applyReaction(r: StoredReaction): Promise<void>;
  applyVote(v: StoredVote): Promise<void>;
  applyFailedVote(q: { pollId: string; voter: string; ts: number }): Promise<void>;
  pollVotes(pollId: string): Promise<{ votes: StoredVote[]; failed: number }>;
}

/**
 * Applies edits, revokes, reactions and poll votes to the action store and to cached payloads.
 * Never logs or returns message text.
 *
 * Every call first runs `ensureOwner` (shared with the gateways over the same `cache.db`), so a
 * store left by another account is wiped before anything is written or read. When the owner
 * cannot be resolved the call throws with nothing written and the caller can retry.
 */
export function createMessageActions(deps: {
  store: MessageActionStore;
  messages: MessageStore | null;
  transcripts: Pick<TranscriptStore, "deleteByShortId">;
  mapper: () => Promise<EngineMapper>;
  ensureOwner: () => Promise<void>;
}): MessageActions {
  const { store, messages, transcripts, ensureOwner } = deps;

  /**
   * Resolves everything that can fail (cached rows, mapper lookup) BEFORE any write, so a failure
   * throws with nothing written and the caller can retry. The returned function only writes.
   */
  async function prepareRewrite(shortId: string): Promise<(o: MessageOverride) => void> {
    if (!messages) return () => {};
    const rows = messages.findByShortId(shortId);
    if (rows.length === 0) return () => {};
    const mapper = await deps.mapper();
    return (override) => {
      for (const row of rows) {
        const raw =
          override.kind === "revoked"
            ? mapper.revokedPayload(row.raw)
            : mapper.editedPayload(row.raw, override.text);
        messages.upsertRaw(row.chatId, [{ id: row.id, ts: row.ts, raw }]);
      }
    };
  }

  return {
    async applyEdit(shortId, text, at) {
      await ensureOwner();
      const rewrite = await prepareRewrite(shortId);
      store.putOverride(shortId, { kind: "edited", text, at });
      // The stored override wins: a revoke (final) or a newer edit may already be there.
      const current = store.overrides([shortId]).get(shortId);
      if (current) rewrite(current);
    },
    async applyRevoke(shortId, at) {
      await ensureOwner();
      const rewrite = await prepareRewrite(shortId);
      store.putOverride(shortId, { kind: "revoked", at });
      transcripts.deleteByShortId(shortId);
      rewrite({ kind: "revoked", at });
    },
    async applyReaction(r) {
      await ensureOwner();
      store.putReaction(r);
    },
    async applyVote(v) {
      await ensureOwner();
      store.putVote(v);
    },
    async applyFailedVote(q) {
      await ensureOwner();
      store.putFailedVote(q);
    },
    async pollVotes(pollId) {
      await ensureOwner();
      return store.votes(pollId);
    },
  };
}
