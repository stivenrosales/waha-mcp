# Scheduled Messages — Design

Date: 2026-11-20. Status: draft for owner approval.

## Intent

The owner wants to tell Claude "send this to X on Friday at 9" or "every month, ask Jose for
his payment", leave it scheduled, and forget about it. The server sends it at that time even
when nobody is looking: the phone, the computer and Claude can all be off. The owner can list
what is scheduled and cancel it. The idea comes from wa-mcp.com, which offers scheduled and
recurring messages, sent from the user's own number, to people and groups.

Two kinds of scheduled message, both wanted by the owner:

1. **Fixed text.** The owner writes and approves the text now. It goes out exactly as written
   at the scheduled time, and again on every repetition.
2. **AI-composed.** The owner stores an instruction ("ask Jose for this month's payment,
   friendly but clear"). At each scheduled time the server reads the recent context of that
   chat and decides: **send** a message it writes right then, or **skip** when it is no longer
   needed (for example, Jose already paid). It sends without asking the owner first. The owner
   was explicit that it should send on its own, based on what the context shows that day.

## Goals

- Schedule fixed-text and AI-composed messages to a person (direct chat) or a group.
- One-time or repeating: daily, weekly, monthly, yearly.
- List scheduled messages with their recent run history, and cancel them.
- After every AI-composed run, write a short log line to the owner's own WhatsApp chat
  ("Sent to Jose: «…»" / "Did not send to Jose: he already paid on the 3rd").
- Works while the owner's devices are off (it runs on the server, like missions).

## Non-goals

- **Reminders that alert the owner.** A message from the owner's number to the owner's own
  chat does not ring the phone; it shows as sent by them. The owner agreed this is not
  important. Scheduling to the own chat is allowed but is a silent note. wa-mcp.com does not
  do this either: it sends only from the user's own number and shows no self-reminder feature
  or second number.
- A second WhatsApp number or bot account.
- Media, locations, contacts or mentions in scheduled messages (text only for now).
- Follow-up conversation. If the person answers a scheduled message, nobody answers back
  automatically; the reply lands in the owner's chat as usual. ("Schedule a mission" can be
  added later on top of this design.)
- Bulk sending (one schedule targets one chat).
- Editing a schedule. Cancel it and create a new one.

## Anti-goals (a failure even if it technically works)

- The number gets restricted by WhatsApp because of scheduled traffic.
- An AI-composed message that is clearly wrong for the context (asking for a payment that the
  chat shows was already made) and is sent anyway.
- A schedule that keeps sending forever after the owner forgot it exists.
- Message text or instructions stored in plaintext.

## Constraints from the existing system

- The send tools (`send_text`, `send_media`, …) send at once. The rule "show the owner the
  final text and recipient first" lives in the tool descriptions (`SEND_POLICY` in
  `src/infrastructure/mcp/tools/sendShared.ts`) and is followed by Claude; the server does not
  enforce it. For scheduled messages, that approval happens **when scheduling**. For the
  AI-composed kind the owner approves the instruction, not the final words.
- Missions (`src/application/missions/`) already provide the parts to reuse: the periodic tick
  pattern (`engine.ts`, `setInterval` with a serial chain), `sendPaced` (read → type → send),
  quiet hours 22:00–08:00 in the server `TIMEZONE`, `notifyOwner` (writes to the owner's own
  chat), the OpenRouter client (`src/infrastructure/llm/openRouterClaude.ts`), the
  `llm_usage` table and the monthly budget `MISSIONS_MONTHLY_BUDGET_USD`.
- Mission metadata lives in `auth.db` (`missions` table, no content). Mission content is sealed
  with the tenant key in the tenant's `cache.db` (`mission_log`, `sealedMissionLog.ts`).
  Scheduled messages follow the same split.
- `llm_usage.kind` has `CHECK (kind IN ('agent', 'triage'))` and a `mission_id` column. Adding
  AI-composed runs needs a new kind (SQLite cannot alter a CHECK, so the table must be rebuilt
  by a migration) or a separate usage table. Left to the builder; budget accounting must include
  the scheduled runs either way.
- Only one timezone exists: the server `TIMEZONE`. All schedule times are in that timezone.
- An unknown send outcome is never retried (existing rule for all sends).
- **Amended 2026-11-20 (planning):** scheduled messages, both kinds, need missions configured
  (`OPENROUTER_API_KEY` and `WAHA_WEBHOOK_SECRET`). Restriction detection, quiet hours, the
  new-contact cap and the budget all live in the missions setup and its webhook; making them
  work without it would mean decoupling the webhook from missions, which is a separate change.
  Production has missions configured. Without them, the schedule tools refuse with the same
  "not configured" message the mission tools use.

## Approaches considered

- **A. Own scheduled-messages module that reuses mission parts (chosen).** A new table of
  schedules and its own tick. Fixed text is sent with `sendPaced`. The AI-composed kind makes
  one model call per run that returns "send this text" or "skip, because…". A schedule is a
  one-shot event per run: it never stays in a conversation and does not count toward the
  3-active-missions cap. Trade-off: replies are not answered automatically.
- **B. A schedule that starts a mission at the given time.** Almost no new code, and a reply
  from the person would be followed up. Rejected for now: it brings reminders, deadlines and
  the 3-active cap into what is meant as "send one message", a monthly payment request would
  become a monthly autonomous conversation, and missions do not support groups yet. Can be
  added later on top of A.
- **C. An external cron (n8n) calling the MCP.** Rejected: extra infrastructure, and it would
  need the decrypted chat context outside the server.

The owner chose A.

## Design

### Tools (MCP, per tenant)

- `schedule_message`
  - `chat_id`: a direct chat (`…@c.us` / `…@lid`) or a group (`…@g.us`). The owner's own chat
    is allowed (silent note).
  - `kind`: `fixed` | `ai`.
  - `text` (for `fixed`, WhatsApp formatting, same length rules as `send_text`) or
    `instruction` (for `ai`, 1–2000 chars).
  - `at`: first run, local date-time in the server timezone (`YYYY-MM-DD HH:mm`). Must be in
    the future.
  - `repeat`: `none` | `daily` | `weekly` | `monthly` | `yearly`.
  - `max_runs` (optional, recurring only): see limits.
  - Result: schedule id, next run time, and any note (for example "moved out of quiet hours").
  - The description carries the send policy: show the owner the recipient, the time, the
    repetition and the text (or the instruction, saying the AI will write the words) before
    calling it.
- `list_scheduled`: active schedules of the tenant (newest first), each with next run,
  repetition, kind, remaining runs and its last few runs (time, sent / skipped / failed /
  missed, short reason). The text or instruction is included so the owner can recognise it.
- `cancel_scheduled`: by id. A run that is already in its typing pause must not send after a
  cancel (same `cancelled()` check `sendPaced` already supports).

### Storage

- `auth.db`, table `scheduled_messages`: id, tenant_id, chat_id, kind, repeat, next_run_at,
  runs_done, max_runs, state (`active` / `done` / `cancelled`), created_at, ended_at. No
  content.
- Tenant `cache.db`: sealed content (text or instruction) and a sealed run log (time, outcome,
  sent text or skip reason), with the tenant key, like `mission_log`.
- Retention: each run-log entry carries its own time and is purged 30 days after that run (the
  same 30 days missions use in `application/missions/retention.ts`), even while the schedule is
  still active. An ended schedule's row and content are purged 30 days after it ends.
- Revoke, restore and delete: see "Limits and safety".

### Runtime

- A tick (same pattern as the mission engine) picks schedules with `next_run_at <= now`.
- **Fixed:** send with `sendPaced`. **AI:** read the recent context of the chat, make one model
  call with the instruction, the current date and the context, and get back either
  `send(text)` or `skip(reason)`. If it sends, use `sendPaced`.
- After each run: append to the sealed run log, compute the next run (or mark `done`).
- `notifyOwner` after every AI-composed run (sent or skipped), and after any failed or missed
  run of either kind. Fixed runs that succeed are not notified (they are exactly what was
  approved).

### Recurrence rules (my calls, the owner can change them)

- Monthly on a day the month does not have (31, 30, 29) runs on the last day of that month.
  Yearly on 29 February runs on 28 February in other years.
- The next run is computed from the scheduled time, not from when the run actually happened,
  so the time does not drift.

### Limits and safety (my calls, configurable through env like mission limits)

- At most 20 active schedules per tenant.
- Recurring schedules have an end: `max_runs` defaults to 12 and cannot exceed 52. When it is
  reached the schedule ends and the owner gets a note. This is the guard against "sending
  forever after forgetting it".
- Quiet hours (22:00–08:00) apply to chats other than the owner's own: a run that falls inside
  them is moved to the end of quiet hours, and the schedule result says so when it is created.
- **Missed runs:** if the server was down and a run is more than 60 minutes late, it is not
  sent; it is logged as `missed`, the owner is notified, and the schedule moves on to its next
  run. Less than 60 minutes late: it is sent.
- If a mission is active on the same chat at run time, the run is skipped and logged ("a
  mission is active on this chat"), so two automated senders do not talk over each other.
- AI-composed runs spend from the same monthly budget as missions. If the budget is used up,
  the run is skipped, logged and notified.
- **WhatsApp restriction pause.** When WhatsApp limits the account (the reach-out timelock that
  missions already detect and store in `mission_pauses`), runs to chats other than the owner's
  own are held until the pause ends, then sent if they are still within the 60-minute missed
  window counted from the pause end; otherwise logged as `missed`. Detection and the pause
  state must work for fixed-text schedules even when missions are not configured, so the
  builder moves restriction detection and the pause store out of the mission engine into a
  shared piece that both use. _(Amended: since schedules need missions configured, the
  mission engine keeps detecting the timelock and the schedule runner reads the same pause
  state.)_
- **New contacts.** A schedule to a direct chat with no prior messages counts once, at
  scheduling time, toward the same daily new-contact cap missions use
  (`MISSIONS_MAX_NEW_CONTACTS_PER_DAY`), and is refused when the cap is reached. Later runs do
  not count again.
- **What `max_runs` counts.** Every scheduled occurrence counts, whatever its outcome (sent,
  skipped, failed, missed). It is "this many dates", so a monthly schedule with 12 runs ends
  after a year no matter what happened on each date. The owner gets a note when it ends.
- **Revoke and restore.** Revoking a tenant leaves its schedules `active` but the runner skips
  revoked tenants. On restore, occurrences that passed while revoked count as `missed`, the
  owner gets one summary note (not one per occurrence), and each schedule continues from its
  next future occurrence. Deleting a tenant removes its schedules.
- A send failure is logged and notified, never retried. An unknown outcome is logged as such.
- The AI-composed call is told to prefer skipping when the context is unclear, and its output
  text goes through the same WhatsApp formatting and length checks as `send_text`.

## Left to the builder

- How much chat context the AI call reads (number of messages and age), and whether it reads
  from the message cache or WAHA.
- How to account usage (`llm_usage` migration vs. a separate table), as long as the monthly
  budget covers both missions and scheduled runs.
- Tick interval, table and file names, and how the module plugs into `composition.ts`.
- Exact wording of tool descriptions and owner notes (Spanish for owner-facing WhatsApp text,
  as the existing mission notes in `application/missions/notify.ts` are).
- Where the shared restriction-pause piece lives and how it is wired in `composition.ts`.
