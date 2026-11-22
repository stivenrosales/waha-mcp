# Relative Follow-ups — Design

Date: 2026-11-21. Status: draft for owner approval.

## Intent

The owner's request, verbatim: «si no responde en N días, recuérdale con buen tono».

The owner writes to someone and wants the server to nudge them later, but only when they have
not answered. Today a scheduled message runs at an absolute time; an AI-composed one already
reads the chat at run time and may skip. What is missing is the relative trigger: "N days (or
hours) from now, unless the contact has replied by then".

## Design

A follow-up is an ordinary one-time scheduled message (`src/application/schedules`) with one
extra persisted field, `followUpSince` (the anchor instant). Everything else is reused: the
schedule store and sealed log, the runner (claim before send, quiet hours, missions pauses,
missed window, budget, owner notes), `list_scheduled` and `cancel_scheduled`.

- **Tool.** `schedule_message` gets one new optional field, `if_no_reply_within`: a whole number
  of hours or days, `"48h"` or `"3d"`, from 1 hour to 30 days. With it, `at` is not given: the
  run time is the anchor plus the window. `repeat` must stay `"none"` and the chat must be a
  direct chat (`@c.us`, `@s.whatsapp.net`, `@lid`); groups are refused. Both kinds work: `ai`
  (the expected one: "a friendly nudge") and `fixed`.
- **Anchor.** The moment the follow-up is scheduled.
- **Run.** When the run comes due, before composing or sending, the runner asks the tenant
  runtime whether the contact sent any message in that chat after the anchor (text, media or
  voice note; reactions and system messages do not count). If they did, the run is
  `skipped` with the reason "ya respondió" and the follow-up ends (`done`). If the check fails,
  the run is skipped too ("no pude revisar si respondió"): never nudge someone who may already
  have answered. Otherwise the run continues exactly like any other scheduled run; an `ai`
  follow-up still reads the chat and may skip on its own.
- **Owner note.** A skipped follow-up always sends the owner the usual "⏭️ No envié a …" note,
  also for `fixed` follow-ups (regular fixed runs stay silent when skipped).
- **List.** `list_scheduled` shows `if_no_reply_since` (ISO) and `if_no_reply_within`
  (`"3d"`/`"48h"`, derived from the stored times) for follow-ups, null otherwise; the text line
  says "only if no reply since <local time>".
- **Cancel.** `cancel_scheduled` cancels it like any schedule (same id space).
- **Persistence.** New nullable column `follow_up_since` on `schedules` in `auth.db`, added
  by a `PRAGMA table_info` check on start-up (the same pattern as `mission_pauses.until`).
  Existing rows read as `null` (regular schedules). The reply check runs at due time, so a
  restart changes nothing.

## Assumptions

- The anchor is the time of scheduling, not the owner's last message in the chat. Claude
  schedules the follow-up right after the owner's message, so they are almost the same; any
  contact message before scheduling is visible to an `ai` run, which may skip.
- A reply is detected only when the run comes due; the follow-up is not cancelled early by a
  webhook. Until then it stays listed as active.
- A reaction is not a reply.
- The window is limited to 1 hour – 30 days, with no environment variable.
- A follow-up counts toward the active-schedule cap and, for a chat with no history, the daily
  new-contact cap, like any schedule.
- The reply check reads the stored chat id only (as the AI context reader does); a chat WAHA
  has never seen counts as "no reply".

## Non-goals

- Several nudges ("remind every 2 days until they answer").
- Anchoring on a specific message or on the owner's last message.
- Follow-ups in groups.
