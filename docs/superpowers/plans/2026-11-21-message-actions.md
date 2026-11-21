# Message Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner react to messages, edit and delete their own messages, send polls and
read their votes, and mark chats read or unread; keep the encrypted cache true to WhatsApp after
edits, deletions, reactions and votes by anyone.

**Architecture:** Seven per-tenant MCP tools over new `WhatsAppSender` methods. A sealed
`message_overrides` / `message_reactions` / `poll_votes` set of tables in the tenant `cache.db`
(`MessageActionStore`), written by the tools (own actions, right away) and by a new webhook
**cache event processor** (everyone's actions), independent of the mission engine. A gateway
decorator (`withMessageActions`) sits directly on the WAHA gateway, _inside_ the cache, so every
WAHA read (refresh, backfill, cache-off reads, fallbacks) is rewritten by the overrides before it
is stored or returned. Webhooks turn on with `WAHA_WEBHOOK_SECRET` alone.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), `node:sqlite` `DatabaseSync`, zod, Hono,
Vitest, Biome. pnpm.

**Spec:** `docs/superpowers/specs/2026-11-21-message-actions-design.md`

## Global Constraints

- Tools: `react_message`, `edit_message`, `delete_message`, `send_poll`, `get_poll_results`,
  `mark_read`, `mark_unread`. Input names exactly as in the spec table (`message_id`, `emoji`,
  `text`, `chat_id`, `question`, `options`, `multiple_answers`, `reply_to`).
- Message ids are the full id `{fromMe}_{chatId}_{ID}[_{participant}]`; the chat is parsed from
  it; an id that does not parse is an `InvalidInputError`.
- Edit and delete: own messages only (`true_` prefix). Edit text goes through `toWhatsAppText` +
  `assertTextLength` like `send_text`.
- `send_poll`: `options` 2–12, unique, each ≤100 chars; `question` ≤255; `multiple_answers`
  default `false`; uses `SEND_POLICY` and `noteOwnerSend`. Reactions, edits, deletes and read
  marks never call `noteOwnerSend`.
- Annotations: `delete_message` destructive; `react_message`, `edit_message`, `send_poll` use
  `SEND_ANNOTATIONS`; `mark_read`/`mark_unread` idempotent writes; `get_poll_results` read-only.
- WAHA paths: path segments URL-encoded with `encodeURIComponent` (`@` → `%40`). Endpoints:
  `PUT /api/reaction` `{session, messageId, reaction}`; `PUT|DELETE
  /api/{session}/chats/{chatId}/messages/{messageId}` (edit body `{text}`); `POST /api/sendPoll`
  `{session, chatId, poll:{name, options, multipleAnswers}, reply_to?}`; `POST
  /api/{session}/chats/{chatId}/messages/read`; `POST /api/{session}/chats/{chatId}/unread`.
- New webhook events: `message.edited`, `message.revoked`, `message.reaction`, `poll.vote`,
  `poll.vote.failed`. Matching by the bare `<ID>` (`shortMessageId`).
- Deleted text is removed, not hidden: the cached row becomes a minimal `deleted` payload, its
  transcript row is deleted, no copy of the old text is kept in `cache.db`.
- New tables sealed with the tenant cipher; pruned with `CACHE_MAX_AGE_DAYS`; wiped by the cache
  owner reset; reactions and votes stored even with `CACHE_ENABLED=false`.
- Webhooks on ⇔ `WAHA_WEBHOOK_SECRET` set. Missions still need `OPENROUTER_API_KEY` + the secret.
  Mission behaviour must not change when webhooks are on.
- Logs never carry message text, emoji, option text or payloads (tenant, kind, outcome only).
- No `Co-Authored-By` or AI attribution in commits; Conventional Commits.
- Checks: `pnpm test` (vitest run), `pnpm typecheck` (tsc --noEmit), `pnpm lint` (biome check .).
  Focused: `pnpm vitest run <file>`.

## Review Focus

1. **Same message under two chat ids** (cached under `…@lid`, revoke event names `…@c.us`, or
   the reverse): the revoke must still blank the cached row. Matching is by short id across all
   chats. Test in Task 4 (`findByShortId` ignores chat) and Task 7 (processor end to end).
2. **WAHA keeps serving the original text after a delete or edit**: the next refresh must not
   bring it back into `cache.db` or into a read. Test in Task 6 (`refresh after revoke stores the
   deleted payload`), with the cache on and off.
3. **Account change on the same tenant** (`resetForOwner`): overrides, reactions and votes of the
   old account must be wiped with the messages. Test in Task 4.
4. **Out-of-order or duplicated events** (old reaction after a newer one, an edit after the
   revoke, a vote replayed): latest `ts` per reactor/voter wins; a revoke is final. Test in Task 4.
5. **First boot after upgrading**: the webhook event list changes, so every active session is
   reconfigured (and WAHA restarts it once). Expect one PUT per session, then none on the next
   boot. Test in Task 3; README/CHANGELOG "Upgrade" note in Task 3.

---

### Task 0: Live spike on the owner's number (manual, no code)

**Files:**
- Modify: `docs/superpowers/specs/2026-11-21-message-actions-design.md` (append `## Spike results`)

No later task waits on this, but run it first: its outcome sets the **wording** of
`delete_message`, `edit_message` and `get_poll_results` (Tasks 9, 10, 12, marked "Wording
(spike)") and the server instructions. Owner decision (spec, Spike first): a failed check never
drops a tool; the tool ships describing what does work.

Environment (shell, values from the owner's `.env`, never pasted into the doc): `W=$WAHA_API_URL`,
`K=$WAHA_API_KEY`, `S=<admin session>`, `ME=<owner number>@c.us` (the self-chat; the owner's
phone is "the other side"). Scratch dir: `SP=$(mktemp -d)`.

- [ ] **Step 1: Save the session config** (restored in Step 9):
  `curl -s -H "X-Api-Key: $K" "$W/api/sessions/$S" > $SP/session-before.json`
- [ ] **Step 2: Start a local listener** reachable from WAHA (same host or docker network):
  `node -e "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{require('fs').appendFileSync('$SP/events.ndjson',b+'\n');s.end('ok')})}).listen(8099)"`
- [ ] **Step 3: Add a temporary webhook** with `PUT $W/api/sessions/$S` whose `config.webhooks` is
  the saved list plus `{url: "http://<host reachable from WAHA>:8099", events: ["message.any",
  "message.edited", "message.revoked", "message.reaction", "poll.vote", "poll.vote.failed"]}`.
  This restarts the session once; wait for `WORKING`.
- [ ] **Step 4: Edit (check 2, 5).** `POST $W/api/sendText {session:S, chatId:ME, text:"spike 1"}`
  → note `id`. `PUT $W/api/$S/chats/<ME url-encoded>/messages/<id url-encoded> {text:"spike 1 edited"}`.
  Record: HTTP status; whether `message.edited` arrived with `body` = new text and
  `editedMessageId` = bare id; what `GET $W/api/$S/chats/<ME>/messages/<id>` and `GET
  …/messages?limit=5` return for it (text, any edit container).
- [ ] **Step 5: Reaction (check 3).** `PUT $W/api/reaction {session:S, messageId:<id>, reaction:"👍"}`,
  then `reaction:""`. Record status and both `message.reaction` payload shapes; check the phone.
- [ ] **Step 6: Delete (check 1, 5).** Send `"spike 2"`, then `DELETE
  $W/api/$S/chats/<ME>/messages/<id>`. Record status; whether `message.revoked` arrived (and its
  `revokedMessageId`); whether the phone shows "You deleted this message" (revoked for everyone)
  or still shows the text (for me only); what `GET …/messages/<id>` and the list return after.
- [ ] **Step 7: Too-late errors (optional).** Edit and delete a self-chat message older than 15
  minutes / older than 3 days if one exists. Record the status code and the scrubbed `message`.
- [ ] **Step 8: Poll (check 4).** `POST $W/api/sendPoll {session:S, chatId:ME, poll:{name:"Spike?",
  options:["Sí","No"], multipleAnswers:false}}` → record the response shape (`id` location).
  Vote "Sí" from the phone, then change to "No". Record whether `poll.vote` arrived decrypted
  (`selectedOptions` texts, `vote.timestamp`) or as `poll.vote.failed`.
- [ ] **Step 9: Restore** `PUT $W/api/sessions/$S` with the saved `config` from Step 1; stop the
  listener; `rm -rf $SP` after copying the scrubbed shapes.
- [ ] **Step 10: Write `## Spike results (2026-11-..)`** in the spec: a table, checks 1–5, pass /
  fail / partial, one line of evidence each; scrubbed payload shapes (phone numbers → `<n>`,
  texts kept only for the spike strings); the edit/delete error texts from Step 7; the resulting
  wording per tool (owner decision). No numbers, keys or URLs in the doc.
- [ ] **Step 11: Commit** `docs: record message actions spike results`.

### Task 1: Message ids and sender request plumbing

**Files:**
- Create: `src/domain/messageId.ts`
- Modify: `src/application/missions/history.ts:58-63` (re-export `shortMessageId` from the domain;
  no behaviour change), `src/infrastructure/waha/WahaHttpSender.ts:62-130` (generalize `post`),
  `src/infrastructure/mcp/defineTool.ts:122` (new annotation constants)
- Test: `test/domain/messageId.test.ts`, `test/infrastructure/waha/WahaHttpSender.test.ts`

**Interfaces:**
- Produces (`messageId.ts`):

  ```ts
  export interface ParsedMessageId { id: string; fromMe: boolean; chatId: string; shortId: string; participant: string | null }
  export function parseMessageId(id: string): ParsedMessageId;  // InvalidInputError otherwise
  export function shortMessageId(id: string): string;            // moved verbatim from history.ts
  ```

  Valid: `parts[0]` is `true|false`, `parts[1]` contains `@`, `parts[2]` non-empty without `@`,
  optional `parts[3]` contains `@`, nothing more. Error text:
  `'"message_id" must be a full message id from get_messages, search_messages or get_thread (e.g. true_51999888777@c.us_3EB0…).'`
- Produces (`WahaHttpSender.ts`, internal):
  `request(q: { method: "POST" | "PUT" | "DELETE"; path: string; body: Json | null; sessionInBody: boolean; media: boolean; notFound: "chat" | "message" }): Promise<SentMessage>`;
  `post(path, body, media)` becomes a thin call with `POST`, `sessionInBody: true`, `notFound: "chat"`.
  `const seg = (s: string) => encodeURIComponent(s)` for path segments. `DELETE` and bodyless
  calls send no `Content-Type` body. Error mapping unchanged except the 404 label.
- Produces (`defineTool.ts`):
  `DESTRUCTIVE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }`,
  `IDEMPOTENT_WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.

- [ ] **Step 1: Write failing tests** in `test/domain/messageId.test.ts`:
  - `parses a direct id`: `parseMessageId("true_51999888777@c.us_3EB0ABC")` →
    `{ fromMe: true, chatId: "51999888777@c.us", shortId: "3EB0ABC", participant: null }`.
  - `parses a group id with participant`: `"false_123-456@g.us_AAA_51911@c.us"` → `fromMe false`,
    `chatId "123-456@g.us"`, `participant "51911@c.us"`; `@lid` chats parse too.
  - `rejects`: `""`, `"3EB0ABC"`, `"maybe_x@c.us_A"`, `"true_nochat_A"`, `"true_x@c.us_"`,
    `"true_x@c.us_A_b@c.us_extra"` throw `InvalidInputError`.
  - `shortMessageId` keeps the existing cases (copy them from wherever history tests cover it).
- [ ] **Step 2: Write failing sender tests** (existing `fakeFetch` style): a test-only call through
  `sendText` still sends `POST` with `session` in the body (regression); `request` is exercised
  by Task 8+ tests, so here only assert `post` behaviour is unchanged for 404 → `WahaNotFoundError`
  with message `"WAHA chat not found."`.
- [ ] **Step 3:** `pnpm vitest run test/domain/messageId.test.ts` → FAIL (module not found).
- [ ] **Step 4:** Implement `messageId.ts`, the history re-export, `request`, the constants.
- [ ] **Step 5:** `pnpm vitest run test/domain test/infrastructure/waha test/application/missions && pnpm typecheck` → PASS.
- [ ] **Step 6:** Commit `refactor: add message id parsing and generic WAHA write requests`.

### Task 2: Webhooks without missions

**Files:**
- Modify: `src/config.ts` (`Config.webhookSecret: string | null` at ~`:49`; validation at
  `:328-334`; value at `:394`), `src/composition.ts:90-97,189-203` (webhook target and route from
  `config.webhookSecret`; `events` required when it is set), `src/main.ts:87,135-137` (comments;
  `onWebhookEvent` routing stays engine-only until Task 7), `README.md` (Setup at `:240`, env table
  `:331-332`, `:353`), `CHANGELOG.md` (new `## Unreleased` section at the top)
- Test: `test/config.test.ts:337-350`, `test/e2e/missions.test.ts` or a new `test/composition.test.ts` if none covers composition

**Interfaces:**
- Produces: `config.webhookSecret` (`WAHA_WEBHOOK_SECRET` trimmed, or `null`).
  `config.missions.webhookSecret` stays (same value) so mission code is untouched.
- Validation: `OPENROUTER_API_KEY` without `WAHA_WEBHOOK_SECRET` → issue on path
  `WAHA_WEBHOOK_SECRET`, message `"OPENROUTER_API_KEY needs WAHA_WEBHOOK_SECRET (missions receive messages through webhooks)."`.
  Secret alone is valid (`missions: null`, `webhookSecret` set).
- Composition: `webhook: WebhookTarget | null` built when `config.webhookSecret` is set;
  `composeApp` throws `"Webhooks need the webhook event store."` when the secret is set and
  `deps.events` is missing; the route is created whenever `webhook && deps.events`.

- [ ] **Step 1: Write failing config tests**: replace the "setting only one of them fails" test
  with `key without secret fails with "OPENROUTER_API_KEY needs WAHA_WEBHOOK_SECRET …"` and
  `secret alone turns webhooks on and missions off` (`webhookSecret === "s"`, `missions === null`);
  `neither: webhookSecret null`.
- [ ] **Step 2: Write a failing composition test**: with `WAHA_WEBHOOK_SECRET` only, a signed
  `session.status` POST to `/webhooks/waha` answers 200 (route exists); `configureWebhooks()`
  calls `FakeSessionAdmin.configureWebhook` once per active tenant; with no secret the route
  answers 404.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement. README: webhooks are their own feature ("set `WAHA_WEBHOOK_SECRET` to
  keep edits, deletions, reactions and poll votes in sync; missions also need
  `OPENROUTER_API_KEY`"); env table rows updated. CHANGELOG `## Unreleased` → `### Features` /
  `### Upgrade` with "`WAHA_WEBHOOK_SECRET` alone now turns webhooks on (no missions needed)."
- [ ] **Step 5:** `pnpm test && pnpm typecheck` → PASS (existing mission e2e unchanged).
- [ ] **Step 6:** Commit `feat: turn webhooks on without missions`.

### Task 3: New webhook event kinds

**Files:**
- Modify: `src/domain/ports/EventStore.ts:2,23` (union; `pending` kinds filter),
  `src/infrastructure/missions/sqliteEventStore.ts:48-55`, `src/infrastructure/webhooks/wahaWebhook.ts:28-31,37-51`,
  `src/infrastructure/waha/WahaSessionAdmin.ts:24` (`WEBHOOK_EVENTS`), `src/application/missions/engine.ts:256`
  (engine reads only its kinds), `src/composition.ts` (route `kinds`), `README.md:240`, `CHANGELOG.md`
- Test: `test/infrastructure/webhooks/wahaWebhook.test.ts`, `test/infrastructure/missions/sqliteEventStore.test.ts`
  (or wherever the event store is tested), `test/infrastructure/waha/WahaSessionAdmin.test.ts:194,242`,
  `test/application/missions/engine.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export type MissionEventKind = "message" | "session.status";
  export type CacheEventKind = "message.edited" | "message.revoked" | "message.reaction" | "poll.vote" | "poll.vote.failed";
  export type WebhookEventKind = MissionEventKind | CacheEventKind;
  export const MISSION_EVENT_KINDS: readonly MissionEventKind[];   // in EventStore.ts
  export const CACHE_EVENT_KINDS: readonly CacheEventKind[];
  // EventStore
  pending(limit: number, kinds?: readonly WebhookEventKind[]): StoredEvent[];   // no kinds = all
  ```

  Kind values equal WAHA's event names; `message.any` stays mapped to `"message"`.
- Route: `WahaWebhookDeps.kinds: ReadonlySet<WebhookEventKind>` (required). An accepted WAHA event
  whose kind is not in `kinds` → `ignored reason=event`. Composition passes `CACHE_EVENT_KINDS`
  plus `MISSION_EVENT_KINDS` only when `config.missions` is set.
- `WEBHOOK_EVENTS` = `["message.any", "session.status", "message.edited", "message.revoked",
  "message.reaction", "poll.vote", "poll.vote.failed"]`, one fixed list whether missions are on
  or not (_my call_: toggling missions later never reconfigures sessions).
- Engine: `events.pending(EVENT_BATCH, MISSION_EVENT_KINDS)`.

- [ ] **Step 1: Write failing tests**:
  - Route: `stores message.revoked sealed when missions are off` (kinds = cache kinds; event
    stored with kind `"message.revoked"`, `onEvent` called with that kind); `ignores message.any
    when missions are off` (log `ignored reason=event`, nothing stored, 200 `{ok:true}`);
    `stores all five cache kinds` (table over the five names).
  - Event store: `pending filters by kinds` — store one `message` and one `message.reaction`;
    `pending(10, ["message"])` returns only the first; `pending(10)` returns both in id order.
  - Session admin: update `OURS.events` to the seven names; `configureWebhook rewrites ours when it
    has the old two-event list` (one PUT) — Review Focus 5; the "already there" test with the
    seven names in another order → GET only.
  - Engine: `leaves cache events for the cache processor` — a pending `message.reaction` event is
    not marked done after `tick` (`events.pending(10)` still returns it).
- [ ] **Step 2:** Run the four files → FAIL.
- [ ] **Step 3:** Implement. README Setup: list the seven events and why. CHANGELOG `### Upgrade`:
  "The first start after upgrading reconfigures each active session's webhook (new events), and
  WAHA restarts each session once."
- [ ] **Step 4:** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: receive edit, revoke, reaction and poll vote webhooks`.

### Task 4: Message action storage

**Files:**
- Create: `src/domain/ports/MessageActionStore.ts`, `src/infrastructure/cache/sqliteMessageActionStore.ts`
- Modify: `src/infrastructure/cache/sqliteMessageStore.ts:14-41` (three tables in `SCHEMA`),
  `:88-95` (`resetCacheForOwner` wipes them), `prune` (prunes them), add `findByShortId`;
  `src/domain/ports/MessageStore.ts` (new method); `src/domain/ports/TranscriptStore.ts` +
  `src/infrastructure/cache/sqliteTranscriptStore.ts` (`deleteByShortId`)
- Test: `test/infrastructure/cache/sqliteMessageActionStore.test.ts`,
  `test/infrastructure/cache/sqliteMessageStore.test.ts`, `test/infrastructure/cache/sqliteTranscriptStore.test.ts`

**Interfaces:**
- Produces (`MessageActionStore.ts`):

  ```ts
  export type MessageOverride = { kind: "edited"; text: string; at: number } | { kind: "revoked"; at: number };
  export interface StoredReaction { messageId: string; reactor: string; emoji: string; ts: number }   // messageId = short id; emoji "" = removal
  export interface StoredVote { pollId: string; voter: string; options: string[]; ts: number }       // pollId = short id
  export interface MessageActionStore {
    putOverride(shortId: string, o: MessageOverride): void;   // revoked is final; edited: newer `at` wins
    overrides(shortIds: string[]): Map<string, MessageOverride>;
    putReaction(r: StoredReaction): void;                     // newer ts per (messageId, reactor) wins; "" deletes
    reactions(shortIds: string[]): Map<string, { emoji: string; by: string }[]>;
    putVote(v: StoredVote): void;                             // newer ts per (pollId, voter) wins
    putFailedVote(q: { pollId: string; voter: string; ts: number }): void;
    votes(pollId: string): { votes: StoredVote[]; failed: number };   // failed = distinct voters with only failed votes after their last good one
  }
  ```

  `ts`/`at` are unix seconds. Owner as reactor/voter is stored as `"me"` (_my call_, WAHA's own
  convention in event payloads).
- Tables (in `cache.db` `SCHEMA`): `message_overrides(short_id PK, kind TEXT, sealed TEXT, at INTEGER)`,
  `message_reactions(short_id, reactor, sealed, ts, PK(short_id, reactor))`,
  `poll_votes(poll_id, voter, sealed, ts, failed INTEGER, PK(poll_id, voter))`. Text, emoji and
  options are sealed (AAD `override:<shortId>`, `reaction:<shortId>:<reactor>`,
  `vote:<pollId>:<voter>`); a revoked override seals nothing (`sealed = ''`). Reactor/voter ids
  stay plaintext (like chat ids in `messages`).
- `MessageStore.findByShortId(shortId: string): { chatId: string; id: string; ts: number; raw: unknown }[]`
  — every chat (_my call_: robust to `@lid`/`@c.us`); SQL prefilter `id = ? OR id LIKE ? ESCAPE '\'`
  (`%\_<ID>` and `%\_<ID>\_%`), then keep rows whose `shortMessageId(id) === shortId`.
  Rewriting uses the existing `upsertRaw` (keeps rowid and `ts`).
- `TranscriptStore.deleteByShortId(shortId: string): void` — same matching on `message_id`.
- `prune(olderThanTs)` also deletes overrides with `at <`, reactions/votes with `ts <` the cutoff.

- [ ] **Step 1: Write failing action store tests** (`openCacheDatabase(":memory:")`, `testCipher("t1")`):
  - `override round trip and sealed at rest`: the raw `sealed` column does not contain the text.
  - `revoke is final`: `putOverride(A, revoked)` then `putOverride(A, edited later)` → still revoked (Review Focus 4).
  - `newer edit wins, older edit ignored`.
  - `reaction latest per reactor wins; older ignored; "" removes`: two reactors on one message →
    two entries; reactor 1 sends 👍 ts 10, ❤️ ts 12, 😂 ts 11 → ❤️; then `""` ts 13 → only reactor 2.
  - `votes latest per voter`; `failed vote counted, then cleared by a later good vote`.
  - `another tenant's cipher cannot read` (open with `testCipher("t2")` → throws on read).
- [ ] **Step 2: Write failing message/transcript store tests**:
  - `findByShortId finds the row under any chat`: rows `true_1@lid_ABC` in `1@lid` and
    `false_2@c.us_ABC_3@c.us` in `2@g.us`… returns both; `ABCD` not matched by `ABC`.
  - `resetForOwner wipes overrides, reactions and votes` (Review Focus 3).
  - `prune removes old overrides, reactions and votes`.
  - `deleteByShortId deletes only that message's transcript`.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** `pnpm vitest run test/infrastructure/cache && pnpm typecheck` → PASS.
- [ ] **Step 6:** Commit `feat: store message overrides, reactions and poll votes`.

### Task 5: Applying actions to cached payloads

**Files:**
- Create: `src/application/messageActions.ts`
- Modify: `src/domain/message.ts:41-60,83-91` (`edited?: true` on `NormalizedMessage`; two mapper
  methods), `src/infrastructure/waha/engines/gows.ts` (implement them; flag edits),
  `src/infrastructure/mcp/tools/schemas.ts:45-62` (`edited: z.literal(true).optional()`)
- Test: `test/infrastructure/waha/engines/gows.test.ts` (existing mapper tests), `test/application/messageActions.test.ts`

**Interfaces:**
- Produces (`EngineMapper`):

  ```ts
  /** Copy of `raw` whose mapped text (or media caption) is `text`, mapped with `edited: true`. */
  editedPayload(raw: unknown, text: string): unknown;
  /** Minimal payload of the same message mapping to type "deleted": id, chat, sender, fromMe, timestamp only. */
  revokedPayload(raw: unknown): unknown;
  ```

  GOWS: `editedPayload` sets a top-level `waMcpEdited: true` marker that `message()` turns into
  `edited: true`; `message()` also flags `edited: true` when `unwrap` passed through an
  `editedMessage` / `protocolMessage.editedMessage` container (WAHA's own edited copy).
- Produces (`messageActions.ts`):

  ```ts
  export interface MessageActions {
    applyEdit(shortId: string, text: string, at: number): Promise<void>;   // override + rewrite cached rows
    applyRevoke(shortId: string, at: number): Promise<void>;               // override + deleted payload + transcript gone
    applyReaction(r: StoredReaction): void;
    applyVote(v: StoredVote): void;
    applyFailedVote(q: { pollId: string; voter: string; ts: number }): void;
    pollVotes(pollId: string): { votes: StoredVote[]; failed: number };
  }
  export function createMessageActions(deps: {
    store: MessageActionStore; messages: MessageStore | null;
    transcripts: Pick<TranscriptStore, "deleteByShortId">; mapper: () => Promise<EngineMapper>;
  }): MessageActions;
  ```

  `applyEdit` on a row already revoked (override is revoked) leaves it deleted.

- [ ] **Step 1: Write failing mapper tests** (start from an existing GOWS text fixture and an
  image-with-caption fixture):
  - `editedPayload replaces text`: `m.message(m.editedPayload(raw, "nuevo"))` → `text "nuevo"`,
    `edited true`, same `id`, `timestamp`, `author`, `fromMe`.
  - `editedPayload replaces a caption`: `attachment.caption === "nuevo"`, `attachment.mediaId` unchanged.
  - `revokedPayload maps to deleted and drops content`: `type "deleted"`, `text null`,
    `attachment null`, same id/timestamp/author; `JSON.stringify(payload)` contains neither the
    original text nor the media URL.
  - `unedited messages have no edited key` (output schema unchanged for them).
- [ ] **Step 2: Write failing service tests** (real sqlite stores in memory, GOWS mapper):
  - `applyRevoke blanks every cached copy and the transcript`: row cached under two chats →
    both map to `deleted`; `transcripts.get` → null; `cache.db` text search
    (`SELECT raw FROM messages`) opened with the cipher contains no old text.
  - `applyEdit rewrites the cached row text and keeps ts and order`.
  - `applyEdit after applyRevoke stays deleted`.
  - `works with the cache off` (`messages: null`): override stored, no throw.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** `pnpm vitest run test/infrastructure/waha test/application/messageActions.test.ts && pnpm typecheck` → PASS.
- [ ] **Step 6:** Commit `feat: rewrite cached messages after edits and deletions`.

### Task 6: Read path and runtime wiring

**Files:**
- Create: `src/application/actionsGateway.ts`
- Modify: `src/domain/ports/WahaGateway.ts` (optional `storedReactions?`),
  `src/application/cachedMessages.ts:~228` (pass `storedReactions` through),
  `src/application/messages.ts:36-50,~107` (merge stored reactions in `mapAndAttach`),
  `src/infrastructure/tenants/runtime.ts:197-205,268-282` (wrap the WAHA gateway, build
  `MessageActions`, expose it), `src/infrastructure/mcp/defineTool.ts:37-56,88-108`
  (`ToolRunContext.messageActions`), `test/e2e/mcp-client.test.ts:215-260` and other test
  contexts that build a `TenantToolContext` (add `messageActions`)
- Test: `test/application/actionsGateway.test.ts`, `test/application/cachedMessages.test.ts`,
  `test/application/messages.test.ts`, `test/application/search.test.ts`

**Interfaces:**
- Consumes: Task 4 store, Task 5 mapper methods and `MessageActions`.
- Produces:

  ```ts
  export function withMessageActions(gw: WahaGateway, deps: { store: MessageActionStore; mapper: () => Promise<EngineMapper> }): WahaGateway;
  // WahaGateway
  storedReactions?(shortIds: string[]): Map<string, Reaction[]>;
  // ToolRunContext / TenantToolContext
  messageActions: MessageActions;
  ```

  `withMessageActions` rewrites `getMessages` pages and `getMessage` results (revoked →
  `revokedPayload`, edited → `editedPayload`), passes everything else through, and implements
  `storedReactions`. Runtime order: `actionsGw = withMessageActions(wahaGateway, …)`;
  `gateway = cacheEnabled ? createCachedGateway(actionsGw, …) : actionsGw`; the engine resolver
  is built once over `wahaGateway` and shared by both. The action store and a transcript store
  over the same `cacheDb` are always built (cache on or off).
- `mapAndAttach` merge rule: stored reactions replace the engine's for the same `by`; order:
  engine-only reactions first, then stored ones.

- [ ] **Step 1: Write failing tests**:
  - `actionsGateway`: `revoked rows come back deleted from getMessages and getMessage`;
    `edited rows come back with the new text and edited`; `rows without overrides are untouched
    (same object)`; `storedReactions returns the stored map`.
  - `cachedMessages` (Review Focus 2): `refresh after revoke stores the deleted payload` — WAHA
    fake keeps serving the original text; after `applyRevoke` and a refresh (advance clock past
    `FRESH_MS`), the sealed row opened with the cipher maps to `deleted` and contains no old
    text; same for an edit. `storedReactions passes through the cache`.
  - `messages`: `get_messages fills reactions from the store` (fake gateway with
    `storedReactions`); `a stored reaction by the same author replaces the engine one`.
  - `search`: `a revoked message is not found` (search for its old text through the decorated
    gateway → zero hits), cache on and off.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement and wire; update test contexts.
- [ ] **Step 4:** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: apply edits, deletions and reactions to every message read`.

### Task 7: Cache event processor

**Files:**
- Create: `src/application/cacheEvents.ts`, `src/infrastructure/webhooks/cacheEventPort.ts`
- Modify: `src/composition.ts` (`composeCacheEventProcessor`), `src/main.ts:79-115,143-160`
  (create when `config.webhookSecret`; start with the 5 s tick constant the engine uses; wake on
  cache kinds; stop and drain on shutdown), `README.md` (what webhooks keep in sync)
- Test: `test/application/cacheEvents.test.ts`, `test/e2e/` webhook flow (extend
  `test/e2e/missions.test.ts` style, or a new `test/e2e/messageActions.test.ts`)

**Interfaces:**
- Consumes: `CACHE_EVENT_KINDS`, `EventStore.pending(limit, kinds)`, `envelopePayload`
  (`inbound.ts:15`), `shortMessageId`, `MessageActions`.
- Produces:

  ```ts
  export type CacheEffect =
    | { kind: "edit"; shortId: string; text: string; at: number }
    | { kind: "revoke"; shortId: string; at: number }
    | { kind: "reaction"; reaction: StoredReaction }
    | { kind: "vote"; vote: StoredVote }
    | { kind: "vote_failed"; pollId: string; voter: string; ts: number };
  export function cacheEffectOf(kind: CacheEventKind, payload: Record<string, unknown>, receivedAt: number): CacheEffect | null;
  export interface CacheEventPort { openEvent(e: StoredEvent): string; actions: MessageActions }
  export interface CacheEventProcessor { tick(): Promise<void>; wake(): void; start(intervalMs: number): void; stop(): void; idle(): Promise<void> }
  export function createCacheEventProcessor(deps: {
    events: EventStore; acquire(tenantId: string): { port: CacheEventPort; release(): void } | null;
    logger: { info(m: string): void };
  }): CacheEventProcessor;
  export function composeCacheEventProcessor(deps: { config: Config; registry: TenantRegistry; events: EventStore; logger: Logger }): CacheEventProcessor | null;
  ```

  Field mapping: edited → `editedMessageId` (bare), `body`, `at = payload.timestamp ?? receivedAt`;
  revoked → `revokedMessageId` (bare); reaction → `shortMessageId(reaction.messageId)`, emoji
  `reaction.text`, reactor `fromMe ? "me" : participant ?? from`, `ts = timestamp`; vote →
  `shortMessageId(poll.id)`, voter `vote.fromMe ? "me" : vote.participant ?? vote.from`,
  `options = vote.selectedOptions` (strings only), `ts = vote.timestamp`. Anything missing →
  `null` (event marked done, log `outcome=ignored`). Same batch/attempt rules as the engine
  (`EVENT_BATCH` 100, 3 attempts, unavailable tenant → keep, revoked tenant → mark done).
- `cacheEventPort.ts`: `cacheEventPort(runtime: TenantRuntime): CacheEventPort` — `openEvent`
  exactly as `missionTenantPort` (`runtime.cipher.openText(e.payloadSealed,
  \`webhook:${e.tenantId}:${e.eventId}\`)`), `actions: runtime.context.messageActions`.
- `onWebhookEvent` in `main.ts`: cache kinds wake the processor, mission kinds wake the engine.

- [ ] **Step 1: Write failing `cacheEffectOf` tests**, one per kind with the spec's payload
  shapes, plus: `vote by owner is "me"`, `reaction removal keeps ""`, `missing editedMessageId → null`,
  `non-string selectedOptions dropped`.
- [ ] **Step 2: Write failing processor tests** (in-memory event store, `testCipher`, real
  action stores): `applies and marks done`; `revoke matches a row cached under the @lid chat`
  (Review Focus 1); `ignores mission kinds` (a pending `message` event stays pending);
  `failure retries then gives up after 3`; `unknown tenant marks done`; `logs carry no text`
  (logger lines never contain the body or emoji).
- [ ] **Step 3: Write a failing e2e test**: webhooks on, missions off; POST a signed
  `message.revoked` for a message the fake gateway serves; after `processor.tick()`,
  `get_messages` shows it as `deleted` and `search_messages` no longer finds its text; a signed
  `message.reaction` makes `get_messages` show the reaction.
- [ ] **Step 4:** Run → FAIL.
- [ ] **Step 5:** Implement and wire.
- [ ] **Step 6:** `pnpm test && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 7:** Commit `feat: sync the message cache from webhook events`.

### Task 8: `react_message`

**Files:**
- Create: `src/infrastructure/mcp/tools/reactMessage.ts`, `src/application/emoji.ts`
- Modify: `src/domain/ports/WhatsAppSender.ts`, `src/infrastructure/waha/WahaHttpSender.ts`,
  `test/fakes/InMemoryWahaGateway.ts` (`RecordingSender.react`), `src/infrastructure/mcp/tools/index.ts`
  (after `sendContactTool`), `src/infrastructure/mcp/instructions.ts:23` (replace the GOWS
  reactions line), `README.md` (Send table row), `CHANGELOG.md`, `test/e2e/mcp-client.test.ts:177` (`SEND_TOOLS`)
- Test: `test/infrastructure/waha/WahaHttpSender.test.ts`, `test/application/emoji.test.ts`,
  `test/infrastructure/mcp/tools/reactMessage.test.ts`

**Interfaces:**
- Produces: `WhatsAppSender.react(q: { messageId: string; emoji: string }): Promise<void>` →
  `PUT /api/reaction` `{session, messageId, reaction}`. `isSingleEmoji(s: string): boolean` —
  exactly one grapheme (`Intl.Segmenter`) matching `/\p{Extended_Pictographic}|\p{Regional_Indicator}/u`.
- Tool: input `message_id` (full id), `emoji` (`""` removes); `parseMessageId` validates; invalid
  emoji → `InvalidInputError('"emoji" must be one emoji, or "" to remove your reaction.')`.
  After a successful call, `ctx.messageActions.applyReaction({ messageId: shortId, reactor: "me", emoji, ts: now })`.
  Result text: `Reacted 👍 to message <id>.` / `Removed your reaction from message <id>.`
  Description: react only when the owner asked; any message, own or not. Annotations `SEND_ANNOTATIONS`.
- Instructions: replace "Reactions are usually unavailable on the GOWS engine…" with "Reactions
  come from webhooks; when the server has no WAHA_WEBHOOK_SECRET they may be missing, so do not
  conclude that nobody reacted." and add under a new "Message actions" block: "React only when
  the owner asked."

- [ ] **Step 1: Write failing tests**: sender `react PUTs /api/reaction with session in the body`
  (method, URL, body `{session:"default", messageId:"true_1@c.us_A", reaction:"👍"}`), `404 →
  WahaNotFoundError("message")`; emoji table (`👍`, `❤️`, `👍🏽`, `🇵🇪`, `👨‍👩‍👧` true; `ok`,
  `👍👍`, `a👍`, `" "` false); tool: `reacts and stores the own reaction`, `"" removes`, `bad id`
  and `bad emoji` errors, `does not take over a mission` (fake `missions.ownerSent` not called).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; README row `| 😀 | \`react_message\` | Reacts to a message with an emoji, or removes your reaction. |`; CHANGELOG bullet; e2e list.
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 5:** Commit `feat: add react_message tool`.

### Task 9: `edit_message`

**Files:**
- Create: `src/infrastructure/mcp/tools/editMessage.ts`
- Modify: sender port/adapter/fake, `tools/index.ts`, `instructions.ts:2` and the "Message
  actions" block, `README.md`, `CHANGELOG.md`, `test/e2e/mcp-client.test.ts` (`SEND_TOOLS`;
  the `not.toMatch` instruction check keeps passing)
- Test: `WahaHttpSender.test.ts`, `test/infrastructure/mcp/tools/editMessage.test.ts`

**Interfaces:**
- Produces: `WhatsAppSender.editMessage(q: { chatId: string; messageId: string; text: string }): Promise<void>`
  → `PUT /api/{session}/chats/{seg(chatId)}/messages/{seg(messageId)}` body `{text}`,
  `sessionInBody: false`, `notFound: "message"`.
- Tool: `message_id`, `text`. Not own (`fromMe false`) →
  `InvalidInputError("You can only edit your own messages (ids that start with true_).")`.
  Text: `toWhatsAppText` + `assertTextLength`. WAHA 400/422 → rethrow `InvalidInputError` with
  the scrubbed reason plus " WhatsApp only allows editing recent messages." Then
  `messageActions.applyEdit(shortId, text, nowSec)`; if that throws, still succeed and append
  "The local copy will update on the next sync." Result echoes the new text like `sentResult`.
  Annotations `SEND_ANNOTATIONS`. **Wording (spike):** edit window and "text and captions only"
  per Task 0 results.
- Instructions: first line becomes "…read chats, send messages from the owner's number, and edit
  or delete the owner's own messages." Message actions block: "Edit or delete only when the owner
  explicitly asked in this conversation; first show the message (text and chat) and, for edits,
  the new text. Only the owner's own messages."

- [ ] **Step 1: Write failing tests**: sender `editMessage PUTs the encoded path without session
  in the body` (URL `…/api/default/chats/51999%40c.us/messages/true_51999%40c.us_ABC`, body
  `{"text":"x"}`), `422 → InvalidInputError`; tool: `edits own message with WhatsApp formatting`
  (`**hola**` → sender gets `*hola*`), `refuses someone else's message` (no sender call),
  `updates the cache right away` (spy `applyEdit` called with short id and text), `too-late error
  is explained`, `does not take over a mission`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; README row `| ✏️ | \`edit_message\` | Edits the text of a message you sent. |`; CHANGELOG; e2e list.
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 5:** Commit `feat: add edit_message tool`.

### Task 10: `delete_message`

**Files:**
- Create: `src/infrastructure/mcp/tools/deleteMessage.ts`
- Modify: sender port/adapter/fake, `tools/index.ts`, `instructions.ts`, `README.md` (row and a
  privacy paragraph), `CHANGELOG.md`, `test/e2e/mcp-client.test.ts:394-405` (`SEND_TOOLS`, and the
  annotation loop becomes a per-tool expectation: `delete_message` →
  `DESTRUCTIVE_ANNOTATIONS`, `mark_read`/`mark_unread` (Task 13) → `IDEMPOTENT_WRITE_ANNOTATIONS`)
- Test: `WahaHttpSender.test.ts`, `test/infrastructure/mcp/tools/deleteMessage.test.ts`, e2e

**Interfaces:**
- Produces: `WhatsAppSender.deleteMessage(q: { chatId: string; messageId: string }): Promise<void>`
  → `DELETE` same path, no body.
- Tool: `message_id`; own only (same error text as edit, "delete"). Then
  `messageActions.applyRevoke(shortId, nowSec)` (failure: still succeed, append the sync note).
  Result: `Deleted message <id> for everyone. This cannot be undone.` Annotations
  `DESTRUCTIVE_ANNOTATIONS`. **Wording (spike):** if Task 0 check 1 failed, description and
  result say "for you only (WhatsApp may still show it to others)".
- README privacy: what "deleted" removes (cache, transcripts, overrides) and what it does not
  (mission logs, schedule history, WAHA's own storage), per the spec's scope paragraph.

- [ ] **Step 1: Write failing tests**: sender `deleteMessage sends DELETE with no body`, `404 →
  WahaNotFoundError("message")`; tool: `deletes own message and blanks the cache`
  (`applyRevoke` called), `refuses someone else's message`, `result says it cannot be undone`;
  e2e: `delete_message then get_messages shows deleted and search_messages finds nothing`
  (runs with cache on and off), annotations per tool.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; README row `| 🗑️ | \`delete_message\` | Deletes a message you sent, for everyone. |`; CHANGELOG; e2e.
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 5:** Commit `feat: add delete_message tool`.

### Task 11: `send_poll`

**Files:**
- Create: `src/infrastructure/mcp/tools/sendPoll.ts`
- Modify: sender port/adapter/fake, `tools/index.ts`, `instructions.ts` (Sending list includes
  `send_poll`), `README.md`, `CHANGELOG.md`, e2e `SEND_TOOLS`
- Test: `WahaHttpSender.test.ts`, `test/infrastructure/mcp/tools/sendPoll.test.ts`

**Interfaces:**
- Produces: `WhatsAppSender.sendPoll(q: { chatId: string; replyTo?: string; question: string; options: string[]; multipleAnswers: boolean }): Promise<SentMessage>`
  → `POST /api/sendPoll` `{session, chatId, poll:{name, options, multipleAnswers}, reply_to}`;
  id read like `post` already does.
- Tool: `chat_id` (`chatIdField`), `question` (1–255), `options` (2–12 strings, each 1–100 after
  trim; duplicates after trim and case-folding → `InvalidInputError('Poll options must be different from each other.')`, _my call_),
  `multiple_answers` (default false), `reply_to` (`replyToField`). `noteOwnerSend` after the send.
  Output `sendOutputSchema`; text `Sent poll to <chat> (message <id>). Read votes with get_poll_results.`
  Description includes `SEND_POLICY`. Annotations `SEND_ANNOTATIONS`.

- [ ] **Step 1: Write failing tests**: sender body shape; tool: `sends and returns the poll id`,
  `1 option and 13 options rejected`, `duplicate options rejected ("Sí" and " sí ")`,
  `101-char option rejected`, `takes over an active mission` (`missions.ownerSent` called with the chat).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; README row `| 📊 | \`send_poll\` | Sends a poll (2–12 options, single or multiple answers). |`; CHANGELOG; e2e.
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 5:** Commit `feat: add send_poll tool`.

### Task 12: `get_poll_results`

**Files:**
- Create: `src/application/pollResults.ts`, `src/infrastructure/mcp/tools/getPollResults.ts`
- Modify: `tools/index.ts` (after `getThreadTool`), `instructions.ts` (Reading: one line),
  `README.md` (Read table), `CHANGELOG.md`, e2e `read` list (`:376`)
- Test: `test/application/pollResults.test.ts`, `test/infrastructure/mcp/tools/getPollResults.test.ts`

**Interfaces:**
- Consumes: `parseMessageId`, `gateway.getMessage`, `mapper.message`, `MessageActions.pollVotes`,
  `loadContacts` (`groups.ts:79`), `joinKey`.
- Produces:

  ```ts
  export interface PollResults {
    question: string;
    options: { option: string; votes: number }[];          // poll order
    voters: { id: string; name: string | null; options: string[] }[];   // newest vote first; "me" for the owner
    failedVotes: number;
    webhooks: boolean;
  }
  export async function getPollResults(deps: { gateway: WahaGateway; mapper: EngineMapper; actions: MessageActions; webhooksOn: boolean; now: () => number },
    messageId: string): Promise<PollResults>;
  ```

  Not a poll → `InvalidInputError("That message is not a poll.")`. A selected option not in the
  poll is listed under the voter but not counted. Webhooks off (`ctx.config.webhookSecret === null`)
  → question and options with `votes: 0`, empty voters, `webhooks: false`, and the result text
  says "Votes are not available: this server has no webhooks (WAHA_WEBHOOK_SECRET)." (_my call_:
  not an error). Read-only annotations. **Wording (spike):** if votes arrive undecrypted (Task 0
  check 4), the description says counts may be incomplete and `failedVotes` explains why.

- [ ] **Step 1: Write failing tests**: `counts votes per option`, `multiple answers count once per
  option`, `latest vote per voter`, `names from contacts (@c.us and @s.whatsapp.net)`, `failed
  votes reported`, `not a poll`, `webhooks off note`, `deleted poll message → not a poll`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; README row `| 🗳️ | \`get_poll_results\` | Votes of a poll: counts per option and who voted what (needs webhooks). |`; CHANGELOG; e2e.
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 5:** Commit `feat: add get_poll_results tool`.

### Task 13: `mark_read` and `mark_unread`

**Files:**
- Create: `src/infrastructure/mcp/tools/markChat.ts` (both tools)
- Modify: sender port/adapter/fake, `tools/index.ts`, `instructions.ts` (Message actions: "Mark
  chats read or unread only when asked."), `README.md`, `CHANGELOG.md`, e2e `SEND_TOOLS` + annotations
- Test: `WahaHttpSender.test.ts`, `test/infrastructure/mcp/tools/markChat.test.ts`

**Interfaces:**
- Produces: `WhatsAppSender.markRead(chatId: string): Promise<void>` → `POST
  /api/{session}/chats/{seg(chatId)}/messages/read` (no query, WAHA defaults);
  `markUnread(chatId: string): Promise<void>` → `POST /api/{session}/chats/{seg(chatId)}/unread`;
  both `sessionInBody: false`, `notFound: "chat"`. `sendSeen` is not used (_my call_: the spec
  names the chat endpoints).
- Tools: `chat_id` (`chatIdField`); result `Marked <chat> as read.` / `as unread.`;
  `IDEMPOTENT_WRITE_ANNOTATIONS`; no mission takeover.

- [ ] **Step 1: Write failing tests**: sender paths encoded, POST without session in body;
  tools: success texts, `does not take over a mission`, 404 → "Chat or message not found.".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; README rows `| 👁️ | \`mark_read\` | Marks a chat as read. |`, `| 🔵 | \`mark_unread\` | Marks a chat as unread. |`; CHANGELOG; e2e.
- [ ] **Step 4:** `pnpm test && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 5:** Commit `feat: add mark_read and mark_unread tools`.

## Notes for the executor

- Do not change mission behaviour: the engine only stops seeing cache kinds (Task 3); its
  `message.any` handling, takeover rules and pause logic stay as they are.
- `cache.db` already runs `PRAGMA secure_delete = ON`, so overwritten and deleted rows are zeroed;
  rely on it for "deletion removes the text".
- Pruning of the new tables runs only through `MessageStore.prune`, i.e. with the cache on and
  `CACHE_MAX_AGE_DAYS > 0`; with the cache off they are kept (small, sealed). Mention in README.
- Tool order in `createTools`: reads (`get_poll_results` after `get_thread`), then writes
  `send_text … send_contact, send_poll, react_message, edit_message, delete_message, mark_read,
  mark_unread, schedule_message …`.
