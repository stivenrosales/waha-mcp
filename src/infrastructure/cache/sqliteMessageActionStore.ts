import type { DatabaseSync } from "node:sqlite";
import type {
  MessageActionStore,
  MessageOverride,
  StoredVote,
} from "../../domain/ports/MessageActionStore.js";
import type { TenantCipher } from "../crypto/envelope.js";

const overrideAad = (shortId: string): string => `override:${shortId.length}:${shortId}`;
const reactionAad = (shortId: string, reactor: string): string =>
  `reaction:${shortId.length}:${shortId}:${reactor}`;
const voteAad = (pollId: string, voter: string): string =>
  `vote:${pollId.length}:${pollId}:${voter}`;

/** SQLite variable limit stays far away: ids are looked up in chunks. */
const CHUNK = 500;
function* chunks<T>(items: T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += CHUNK) yield items.slice(i, i + CHUNK);
}

/**
 * Message actions in `cache.db` (open it with `openCacheDatabase`). Text, emoji and options are
 * sealed per tenant; a revoke seals nothing and drops the old text, a removed reaction is kept as
 * a tombstone so a late, older reaction cannot resurrect it.
 */
export function createSqliteMessageActionStore(
  db: DatabaseSync,
  cipher: TenantCipher,
): MessageActionStore {
  return {
    putOverride(shortId, o) {
      const existing = db
        .prepare("SELECT kind FROM message_overrides WHERE short_id = ?")
        .get(shortId) as { kind: string } | undefined;
      if (existing?.kind === "revoked") return; // final
      if (o.kind === "revoked") {
        db.prepare(
          `INSERT INTO message_overrides (short_id, kind, sealed, at) VALUES (?, 'revoked', '', ?)
           ON CONFLICT (short_id) DO UPDATE SET kind = 'revoked', sealed = '', at = excluded.at`,
        ).run(shortId, o.at);
        return;
      }
      db.prepare(
        `INSERT INTO message_overrides (short_id, kind, sealed, at) VALUES (?, 'edited', ?, ?)
         ON CONFLICT (short_id) DO UPDATE SET sealed = excluded.sealed, at = excluded.at
         WHERE excluded.at >= message_overrides.at`,
      ).run(shortId, cipher.sealText(o.text, overrideAad(shortId)), o.at);
    },

    overrides(shortIds) {
      const out = new Map<string, MessageOverride>();
      for (const part of chunks(shortIds)) {
        const rows = db
          .prepare(
            `SELECT short_id, kind, sealed, at FROM message_overrides
             WHERE short_id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(part)) as {
          short_id: string;
          kind: string;
          sealed: string;
          at: number;
        }[];
        for (const r of rows)
          out.set(
            r.short_id,
            r.kind === "revoked"
              ? { kind: "revoked", at: Number(r.at) }
              : {
                  kind: "edited",
                  text: cipher.openText(r.sealed, overrideAad(r.short_id)),
                  at: Number(r.at),
                },
          );
      }
      return out;
    },

    putReaction(r) {
      const sealed =
        r.emoji === "" ? "" : cipher.sealText(r.emoji, reactionAad(r.messageId, r.reactor));
      db.prepare(
        `INSERT INTO message_reactions (short_id, reactor, sealed, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT (short_id, reactor) DO UPDATE SET sealed = excluded.sealed, ts = excluded.ts
         WHERE excluded.ts >= message_reactions.ts`,
      ).run(r.messageId, r.reactor, sealed, r.ts);
    },

    reactions(shortIds) {
      const out = new Map<string, { emoji: string; by: string }[]>();
      for (const part of chunks(shortIds)) {
        const rows = db
          .prepare(
            `SELECT short_id, reactor, sealed FROM message_reactions
             WHERE sealed != '' AND short_id IN (SELECT value FROM json_each(?))
             ORDER BY ts, rowid`,
          )
          .all(JSON.stringify(part)) as { short_id: string; reactor: string; sealed: string }[];
        for (const r of rows) {
          const list = out.get(r.short_id) ?? [];
          list.push({
            emoji: cipher.openText(r.sealed, reactionAad(r.short_id, r.reactor)),
            by: r.reactor,
          });
          out.set(r.short_id, list);
        }
      }
      return out;
    },

    putVote(v) {
      db.prepare(
        `INSERT INTO poll_votes (poll_id, voter, sealed, ts, failed) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (poll_id, voter) DO UPDATE SET sealed = excluded.sealed, ts = excluded.ts,
           failed = 0 WHERE excluded.ts >= poll_votes.ts`,
      ).run(
        v.pollId,
        v.voter,
        cipher.sealText(JSON.stringify(v.options), voteAad(v.pollId, v.voter)),
        v.ts,
      );
    },

    putFailedVote(q) {
      // The failure is the voter's latest event: it replaces (and erases) the earlier good vote.
      db.prepare(
        `INSERT INTO poll_votes (poll_id, voter, sealed, ts, failed) VALUES (?, ?, '', ?, 1)
         ON CONFLICT (poll_id, voter) DO UPDATE SET failed = 1, sealed = '', ts = excluded.ts
         WHERE excluded.ts >= poll_votes.ts`,
      ).run(q.pollId, q.voter, q.ts);
    },

    votes(pollId) {
      const rows = db
        .prepare(
          "SELECT voter, sealed, ts, failed FROM poll_votes WHERE poll_id = ? ORDER BY ts, rowid",
        )
        .all(pollId) as { voter: string; sealed: string; ts: number; failed: number }[];
      const votes: StoredVote[] = [];
      let failed = 0;
      for (const r of rows) {
        if (Number(r.failed) === 1) failed += 1;
        if (r.sealed !== "")
          votes.push({
            pollId,
            voter: r.voter,
            options: JSON.parse(cipher.openText(r.sealed, voteAad(pollId, r.voter))) as string[],
            ts: Number(r.ts),
          });
      }
      return { votes, failed };
    },
  };
}
