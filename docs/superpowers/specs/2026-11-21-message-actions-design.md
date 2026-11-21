# Message Actions — Design

Date: 2026-11-21. Status: approved by the owner.

## Intent

The owner wants Claude to do more with existing WhatsApp messages than read them: react to a
message, edit or delete a message they sent, send a poll and read its votes, and mark a chat
read or unread. These are the actions wa-mcp.com sells in its Pro plan; waha-mcp is open
source and self-hosted, so they should be here too, limited to what the GOWS engine supports.

This is project A of three agreed on 2026-11-21: A message actions (this document), B the
remaining wa-mcp.com features, C agent-friendly self-hosted install (VPS first, laptop if it
is not hard; single owner by default, invitations optional).

## Goals

- New MCP tools: `react_message`, `edit_message`, `delete_message`, `send_poll`,
  `get_poll_results`, `mark_read`, `mark_unread`.
- What the tools read stays true to WhatsApp: after an edit or a delete (by the owner or by
  anyone else) the encrypted message cache shows the new text or the deletion, and reactions
  and poll votes become visible. This is the approach the owner picked (approach 2 below).
- Webhooks work without missions, so the cache stays in sync on a server that has no LLM key.

## Non-goals

- Forward, star, pin, archive, delete chat: WAHA does not support them on GOWS
  (engines matrix, https://waha.devlike.pro/docs/how-to/engines/).
- Voting in polls (`sendPollVote`), typing indicators as a tool, lists, buttons, events,
  status/stories, labels, channels. They can come later; none was asked for.
- Deleting or editing other people's messages, including as a group admin.
- Showing the original text of a message someone deleted.

## Anti-goals (a failure even if it technically works)

- A deleted message stays readable or searchable through any tool, or stays in `cache.db`
  in readable form. Deletion must remove the text, not just hide it.
- The model deletes or edits without the owner asking, or deletes the wrong message because
  the id was ambiguous.
- Turning on webhooks for cache sync changes how missions behave.

## Constraints from the existing system

- The sender port `WhatsAppSender` (`src/domain/ports/WhatsAppSender.ts`) is called directly
  by the tools; there is no application send service. `WahaHttpSender.post` already maps
  errors (`SendOutcomeUnknownError`, `WahaNotFoundError`, `InvalidInputError`…). `sendSeen`
  already exists on the port.
- The message cache (`src/infrastructure/cache/sqliteMessageStore.ts`) stores each message as
  the sealed raw WAHA payload in `messages(chat_id, id, ts, raw)`. There are no columns for
  edits, deletions or reactions. Edits and revokes reach it today only through polling
  (`cachedMessages.refresh` + `deleteMissing`). The GOWS mapper already turns REVOKE into
  `type: "deleted"`, unwraps edits and maps poll creation; `reactions` is always `[]`.
- Webhooks (`src/infrastructure/webhooks/wahaWebhook.ts`) accept only `message.any` and
  `session.status`, are registered on WAHA by `WahaSessionAdmin.WEBHOOK_EVENTS`, and exist
  only when missions are configured (`MISSIONS_REQUIRED = OPENROUTER_API_KEY,
  WAHA_WEBHOOK_SECRET`). Events are stored sealed and deduped in `webhook_events`, then
  processed by the mission engine (`engine.processEvents`).
- WAHA 2026.10.1 API (verified in https://waha.devlike.pro/swagger/openapi.json):
  - Reaction: `PUT /api/reaction` `{session, messageId, reaction}`; `""` removes it.
  - Edit: `PUT /api/{session}/chats/{chatId}/messages/{messageId}` `{text, linkPreview?, mentions?}`.
    Text messages and media captions only.
  - Delete: `DELETE /api/{session}/chats/{chatId}/messages/{messageId}`. Whether it revokes for
    everyone is **not documented**.
  - Poll: `POST /api/sendPoll` `{session, chatId, poll: {name ≤255, options[] each ≤100,
    multipleAnswers}, reply_to?}`; the reply carries the poll message id.
  - Read: `POST /api/{session}/chats/{chatId}/messages/read` (query `messages`, `days`).
    Unread: `POST /api/{session}/chats/{chatId}/unread`.
  - Events: `message.edited` (target `editedMessageId`, bare id, new text in `body`),
    `message.revoked` (target `revokedMessageId`, bare id), `message.reaction`
    (`reaction.messageId` full id, `reaction.text` `""` = removed), `poll.vote`
    (`poll.id`, `vote.from`/`vote.participant`, `vote.selectedOptions` = full current
    selection, order by `vote.timestamp`), `poll.vote.failed` (could not decrypt). All ✔️ on GOWS.
  - Session webhook events are set through `config.webhooks[].events` on create and
    `PUT /api/sessions/{session}`.

## Approaches considered

1. **One tool per action, write only.** Fast, but the cache keeps old text after edits and
   deletions (so `search_messages` finds deleted messages), and poll votes cannot be read.
2. **One tool per action, plus webhook ingestion that updates the cache.** Edits, deletions,
   reactions and votes from anyone flow into the cache; reads match WhatsApp; deleted text is
   gone. More work. **Picked by the owner**, mainly for the privacy reason above.
3. **A single `message_action` tool with an action enum.** Fewer tools, but a harmless reaction
   and an irreversible delete share one description and one set of rules, which makes the
   confirmation rules harder for the model to follow. Dropped.

## Design

### Tools (MCP, per tenant)

All take the full message id as returned by `get_messages`, `search_messages` or `get_thread`
(`{fromMe}_{chatId}_{ID}[_{participant}]`). *My call:* the chat is parsed from that id instead
of asking for a separate `chat_id`, so the model cannot pair an id with the wrong chat; an id
that does not parse is an input error.

| Tool | Input | Behaviour |
|------|-------|-----------|
| `react_message` | `message_id`, `emoji` (one emoji, or `""` to remove) | Any message, own or not. |
| `edit_message` | `message_id`, `text` | Own messages only (`fromMe` prefix `true_`). Text goes through `toWhatsAppText` and the length check like `send_text`. WhatsApp's own time limit is enforced by WhatsApp; its error is mapped to a clear message. |
| `delete_message` | `message_id` | Own messages only. Deletes for everyone (see spike). Result says it cannot be undone. |
| `send_poll` | `chat_id`, `question`, `options` (2–12, unique, each ≤100), `multiple_answers` (default false), `reply_to?` | A send: same `SEND_POLICY` and `noteOwnerSend` (mission takeover) as `send_text`. Returns the poll message id. |
| `get_poll_results` | `message_id` (a poll) | Question, options with vote counts, and who voted what (names via contacts). Notes failed-to-decrypt votes. Needs webhooks; without them it says so. |
| `mark_read` | `chat_id` | Marks the chat read. |
| `mark_unread` | `chat_id` | Marks the chat unread. |

Annotations: `delete_message` is destructive; `react_message`, `edit_message`, `send_poll` are
send-like; `mark_*` are idempotent writes.

*My call (mission interplay):* `send_poll` takes over an active mission in that chat, like any
owner send. Reactions, edits, deletes and read marks do not.

### Server instructions

Replace "Nothing can be edited or deleted." with rules in the same style as Sending:

- Edit or delete only when the owner explicitly asked in this conversation; show the message
  (text and chat) and, for edits, the new text first. Only the owner's own messages.
- React only when asked. Polls follow the sending rules.
- Drop the line "Reactions are usually unavailable on the GOWS engine" once reactions come from
  webhooks; keep a coverage note when webhooks are off.

### Cache updates

Two paths keep the cache true:

1. **Own actions, right away.** After a successful edit or delete, the tool updates the cached
   row itself, so the next read is correct without waiting for a webhook.
2. **Everyone's actions, by webhook.** New event kinds: `message.edited`, `message.revoked`,
   `message.reaction`, `poll.vote`, `poll.vote.failed`, added to the accepted `KINDS`, the
   `WebhookEventKind` union and `WEBHOOK_EVENTS` (existing sessions are reconfigured on the next
   boot because `sameWebhook` compares the event list).

Effects:

- **Edited:** the cached message keeps its id and timestamp and gets the new text (and an
  `edited` marker shown in outputs).
- **Revoked:** the cached row's raw payload is replaced by a minimal `deleted` payload (id, chat,
  from, timestamp, no body, no media). Any transcript row for it is deleted. The old text is not
  kept anywhere.
- **Reaction:** stored in a new per-tenant table (chat, message, reactor, emoji, timestamp;
  latest per reactor wins; `""` removes). `get_messages`/`get_thread` fill `reactions` from it.
- **Poll vote:** stored in a new per-tenant table (poll id, voter, selected options, timestamp;
  latest per voter by `vote.timestamp`). Failed votes are counted separately.

**Edits and deletions survive refresh** (*my call*). The polling refresh writes WAHA's copy over
cached rows, and WAHA may keep serving the original text. So edits and revokes are also recorded
in a per-tenant, sealed `message_overrides` table (message id → deleted, or new text) that
refresh and backfill apply on top of what WAHA returns, and that the read path applies even when
the cache is off. Overrides are kept as long as the cache keeps messages.

**Scope of "the old text is gone"** (*my call*): waha-mcp's message cache, transcripts and
overrides. Pending webhook events are purged once processed, as today. Mission logs and schedule
history are the owner's own audit records and keep their own retention; WAHA's own storage is
outside waha-mcp's control, and the README says so.

Event ids differ in format (edited/revoked carry a bare id, reaction/vote the full id); matching
uses the bare `<ID>` part, the same way `shortMessageId` does today.

New tables are sealed with the tenant cipher like messages (emoji and option texts are content).
`CACHE_MAX_AGE_DAYS` pruning covers them. If the cache is disabled (`CACHE_ENABLED=false`),
reactions and votes are still stored (they cannot be re-read from WAHA on GOWS).

### Webhooks without missions

Webhooks turn on when `WAHA_WEBHOOK_SECRET` is set, independently of missions. Missions still
need `OPENROUTER_API_KEY` and the secret. A small event processor (outside the mission engine)
handles the cache event kinds; `message` and `session.status` events keep going to the mission
engine when missions are on. With no secret set, everything works as today: the polling refresh
keeps edits and deletions eventually correct, while `get_poll_results` and reactions answer that
webhooks are off.

### Spike first (before the build)

The docs leave four things unverified on GOWS. Check them on the owner's own number before
building, and adjust this design if one fails:

1. `DELETE …/messages/{id}` revokes for everyone (the other side sees "This message was deleted").
2. `PUT …/messages/{id}` edits and emits `message.edited` with the new text.
3. `PUT /api/reaction` works and emits `message.reaction`.
4. `poll.vote` arrives decrypted with `selectedOptions`.
5. What `GET …/messages` returns for a message after it was edited or revoked.

Each tool is its own work unit. Owner decision (2026-11-21): if a check fails, the tool still
ships with the behaviour that does work, described honestly in its description and the server
instructions (for example `delete_message` as "deletes for you only" if GOWS does not revoke for
everyone, or `get_poll_results` with counts of failed votes if votes arrive undecrypted). No tool
is dropped and no tool promises more than it does.

## Left to the builder

- Exact table and module names, and how the event processor is wired next to the mission engine.
- Mapping WhatsApp's "too late to edit/delete" errors to messages.
- Tool descriptions and output schemas, following `schemas.ts` and existing tools.
- Tests: mirror `WahaHttpSender.test.ts`, `wahaWebhook.test.ts`, `sqliteMessageStore.test.ts`,
  `cachedMessages.test.ts`, and update the ordered tool list in `test/e2e/mcp-client.test.ts`.
- README tool table and CHANGELOG.
