/** What replaced a message's text: an edit (new text) or a revoke ("delete for everyone"). */
export type MessageOverride =
  | { kind: "edited"; text: string; at: number }
  | { kind: "revoked"; at: number };

/** `messageId` is the short id; `emoji` "" means the reaction was removed. `ts` is unix seconds. */
export interface StoredReaction {
  messageId: string;
  reactor: string;
  emoji: string;
  ts: number;
}

/** `pollId` is the short id of the poll message. `ts` is unix seconds. */
export interface StoredVote {
  pollId: string;
  voter: string;
  options: string[];
  ts: number;
}

/**
 * Edits, revokes, reactions and poll votes received after a message was cached, keyed by short
 * id. The owner as reactor/voter is stored as `"me"`. Ties on `ts`/`at` are last-write-wins.
 */
export interface MessageActionStore {
  /** A revoke is final (and drops any text); an edit only replaces an older-or-equal one. */
  putOverride(shortId: string, o: MessageOverride): void;
  overrides(shortIds: string[]): Map<string, MessageOverride>;
  /** The newer `ts` per (messageId, reactor) wins; an empty emoji removes. */
  putReaction(r: StoredReaction): void;
  reactions(shortIds: string[]): Map<string, { emoji: string; by: string }[]>;
  /** The newer `ts` per (pollId, voter) wins. */
  putVote(v: StoredVote): void;
  /** A vote that could not be decrypted; counted until a later good vote from the same voter. */
  putFailedVote(q: { pollId: string; voter: string; ts: number }): void;
  /** `failed` = distinct voters whose latest event is a failed vote. */
  votes(pollId: string): { votes: StoredVote[]; failed: number };
}
