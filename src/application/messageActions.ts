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
  applyReaction(r: StoredReaction): void;
  applyVote(v: StoredVote): void;
  applyFailedVote(q: { pollId: string; voter: string; ts: number }): void;
  pollVotes(pollId: string): { votes: StoredVote[]; failed: number };
}

/**
 * Applies edits, revokes, reactions and poll votes to the action store and to cached payloads.
 * Never logs or returns message text.
 *
 * Owner seam: these write paths do not check which account the store belongs to; the caller (the
 * webhook handler) must have verified it before calling. The full owner check lands with the
 * webhook wiring.
 */
export function createMessageActions(deps: {
  store: MessageActionStore;
  messages: MessageStore | null;
  transcripts: Pick<TranscriptStore, "deleteByShortId">;
  mapper: () => Promise<EngineMapper>;
}): MessageActions {
  const { store, messages, transcripts } = deps;

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
      const rewrite = await prepareRewrite(shortId);
      store.putOverride(shortId, { kind: "edited", text, at });
      // The stored override wins: a revoke (final) or a newer edit may already be there.
      const current = store.overrides([shortId]).get(shortId);
      if (current) rewrite(current);
    },
    async applyRevoke(shortId, at) {
      const rewrite = await prepareRewrite(shortId);
      store.putOverride(shortId, { kind: "revoked", at });
      transcripts.deleteByShortId(shortId);
      rewrite({ kind: "revoked", at });
    },
    applyReaction: (r) => store.putReaction(r),
    applyVote: (v) => store.putVote(v),
    applyFailedVote: (q) => store.putFailedVote(q),
    pollVotes: (pollId) => store.votes(pollId),
  };
}
