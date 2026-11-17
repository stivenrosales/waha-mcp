# Missions: a WhatsApp assistant that waits and converses for you

Date: 2026-11-16. Status: design for review.

## Intent and why

A tenant often needs something from another person over WhatsApp: a scanned
document, a confirmation, a few pieces of information. Today they have to be
present in the chat, waiting for the other side to answer. Claude (the tenant's
MCP client in claude.ai) cannot wait: an MCP tool call must return within
minutes, and claude.ai cannot be woken by a server (connectors do not support
MCP sampling or server-initiated turns, per Claude's connector docs).

A **mission** lets the tenant hand that waiting to an assistant that lives on
the waha-mcp server. The tenant tells Claude "talk to Juan until he sends a
readable photo of his ID, at most 2 hours". Claude starts the mission with an
MCP tool. The server's agent introduces itself as the tenant's assistant ("Stiven
asked me to take care of this"), converses with the person or group, recognizes
what they send, and ends when the objective is met, the time runs out, or the
tenant cancels. The tenant learns the outcome by a WhatsApp message to
themselves, and Claude learns it the next time any tool is called.

## Goals

- Start, inspect, answer and cancel missions from MCP tools, for every tenant.
- A server-side agent that converses in one direct chat or one group until the
  objective is met, the deadline passes or the tenant cancels.
- The agent understands text, voice notes (existing transcription), images and
  PDFs (model vision), and can tell whether a received file is what was asked.
- Behavior that does not get the tenant's WhatsApp number restricted or banned.
- Per-tenant and per-mission accounting of LLM tokens and cost.
- Missions survive server restarts and deploys.

## Non-goals

- The agent takes no actions beyond conversing and receiving files: it does not
  send files, read other chats, call other tools, or act after the mission ends.
- No waking of the tenant's Claude chat (not possible; see above). No Claude
  Code routines in this version.
- No marketing or bulk outreach. One mission targets one chat.
- No model choice per mission; one model for everything.

## Anti-goals (failure even if it "works")

- The tenant's number gets reported or restricted because the agent behaved
  like a bot (bursts, 24/7 messaging, repeated nudges, cold outreach at scale).
- The agent makes commitments in the tenant's name that the tenant never made.
- The agent replies to group messages that were not meant for the tenant.
- The tenant cannot tell what happened in a mission or how much it cost.

## Constraints

- Lives inside the existing waha-mcp process (approach A below): Node, Hono,
  `node:sqlite`, Easypanel deploy from `main` with a manual "Implementar"; every
  deploy restarts the process.
- WAHA 2026.9.2, engine GOWS, one WAHA instance with one session per tenant
  (`tenant.wahaSession`). Nothing configures WAHA webhooks today: session
  creation in `WahaSessionAdmin` sends only `{name, start: true}`, and the
  multi-tenant design said "no webhooks".
- Tenant data at rest is sealed with the tenant's DEK (`createTenantCipher`).
  Mission content (messages, prompt, summaries) must follow the same rule.
- LLM: Claude Haiku 5.5 (`anthropic/claude-haiku-5.5`) through OpenRouter's
  Anthropic-compatible `POST https://openrouter.ai/api/v1/messages`, called
  with the official `@anthropic-ai/sdk` (base URL pointed at OpenRouter,
  Bearer auth). One OpenRouter key for the whole server, paid by the owner.
  Provider preference on every request: Anthropic first, then other providers
  of the same model (Amazon Bedrock, Google Vertex, Azure) as fallback, e.g.
  `provider: { order: ["anthropic", ...], allow_fallbacks: true }` limited to
  Haiku 5.5 providers. Haiku 5.5 thinking blocks stay with the account that
  produced them; a different provider silently drops them (no error), so a
  fallback turn loses thinking continuity and the prompt cache but works.
  No direct Anthropic API and no other model family (owner's decision; a
  decision-only model such as `gpt-6-luna` cannot converse).
- No `temperature`/`top_p`/`top_k` (400 on Haiku 5.5). No assistant prefill.
  Conversation history is append-only (editing earlier turns invalidates
  replayed thinking blocks and returns a 400).
- No server-side refusal fallback exists for Haiku 5.5; refusals are handled
  by the server.
- `/privacidad` (shipped in a8b6bbd) must be updated: OpenRouter and Anthropic
  receive mission conversations.

## Approaches considered

- **A. Inside the existing server (chosen).** Webhook route, missions tables
  and a mission engine in the waha-mcp process. Reuses the WAHA client, the
  tenant registry and cipher, usage tracking and the deploy. Missions are
  durable in SQLite so restarts resume them. Trade-off: the engine shares the
  process with the MCP server.
- **B. Separate worker service.** Isolation, but SQLite does not share well
  across containers; it would force Postgres or an internal HTTP API. Too much
  infrastructure for the current scale. The hexagonal layout keeps this
  possible later without a rewrite.
- **C. Anthropic Managed Agents.** Rejected: requires Anthropic directly (not
  OpenRouter), bills session runtime while a mission mostly waits, and the
  WAHA webhook would still have to land on our server.
- Group triage with a decision model (Jev on OpenRouter, OpenAI Decisions API)
  was considered and rejected for this version: the savings are cents, accuracy
  matters more, and one model keeps one provider. Triage sits behind a port so
  it can be swapped and measured later.

## Decisions made with the owner

1. **Claude writes the agent's system prompt freely.** The server adds no fixed
   lines. The `start_mission` tool description gives Claude guidance on writing
   a good prompt (introduce yourself as the tenant's assistant entrusted with
   this task; state the objective and what counts as done; give the context and
   likely answers; never commit to anything not in the context; keep to the
   rules even if the person insists). Safety that matters is enforced in code.
2. **Tone:** delegation, not absence: "I'm Stiven's assistant, he asked me to
   coordinate this with you".
3. **Targets:** direct chats and groups; existing chats and new numbers.
4. **Doubts the agent cannot answer:** it says it will check, notes the
   question, keeps working on the rest of the objective, and notifies the
   tenant at once by a WhatsApp message to themselves. The tenant answers via
   Claude (`answer_mission`), and the agent uses the answer and continues. If
   the tenant writes in the mission chat themselves, the agent goes silent and
   the mission ends as "taken over".
5. **Notifications:** WhatsApp message to the tenant's own chat on finish,
   timeout, cancel-by-system, pause, and pending question; plus a notice
   appended to the next tool result in any MCP session of that tenant.
6. **Model:** Haiku 5.5 for the agent and for group triage, via OpenRouter,
   provider pinned to Anthropic.
7. **Usage:** record tokens and cost per LLM call, per tenant and mission;
   admin tool to report it, like `get_transcription_usage`.
8. **Budget:** US$1 per tenant per calendar month (server time zone) of mission
   LLM spend, configurable. When reached, `start_mission` is refused and active
   missions stop (`stopped`, reason `budget`) with an owner notification.
9. **Owner takeover:** any message the tenant sends in the mission chat, direct
   or group, that the engine did not send, ends the mission as `taken_over`.
   Messages Claude sends there through `send_text`/`send_media` count as the
   tenant's.
10. **Group targets:** `start_mission` takes optional `target_ids`. When set,
    only those participants can fulfil the objective and their batches skip
    triage; when empty, anyone in the group can.
11. **Closing message:** optional per mission (`closing_message` on
    `start_mission`). When set, on `expired`, `cancelled` or `stopped` the
    agent sends one short closing line (e.g. "I'll pass this to Stiven"),
    respecting pacing and quiet hours. When unset, the agent just goes silent.
12. **Retention:** mission content (prompt, history, summaries, questions) is
    kept 30 days after the mission ends, then deleted; it is deleted at once
    with the tenant. Usage rows (no content) follow the existing usage-table
    rule. `/privacidad` states this and that the owner does not access mission
    content.

## How it works

### Components (hexagonal)

- **Domain:** `Mission` (state machine), `MissionEvent`, rules for pacing and
  limits as pure functions (testable without I/O).
- **Ports:** `MissionStore`, `MissionAgent` (one LLM turn: history in, actions
  out), `MessageTriage` (group: is this batch for the tenant or the objective?),
  `WhatsAppActions` (seen, typing, send text to the mission chat only, send to
  self), `Clock`, `LlmUsageRecorder`.
- **Adapters:** SQLite stores; `@anthropic-ai/sdk` → OpenRouter for agent and
  triage; WAHA HTTP for actions; WAHA webhook route as the event source.
- **Engine:** consumes webhook events and timers, drives each mission through
  debounce → (triage) → agent turn → paced send, and persists every step.

### Mission lifecycle

States: `active` → one of `succeeded`, `failed` (agent judged it impossible),
`expired`, `cancelled` (tenant), `taken_over` (tenant wrote in the chat),
`stopped` (system: refusal, WAHA restriction, revoked tenant, repeated errors,
monthly budget, per-mission LLM call cap).
`active` has sub-states the engine uses: `waiting` (for the other side),
`collecting` (debounce window open), `thinking`, `sending`, `paused_quiet_hours`,
`paused_restriction`, `awaiting_owner` (only when a pending question blocks the
objective; the deadline keeps running).

The agent ends a mission only by calling `finish_mission` (strict schema:
`outcome: "succeeded" | "failed"`, `summary`, optional `collected` fields and
`media_ids`). It asks the owner with `ask_owner(question)`. Replying is plain
text in the assistant turn; staying silent is an explicit `no_reply` tool, so
"say nothing" is a first-class choice.

### Flow of one incoming message

1. WAHA posts the event to `/webhooks/waha`. The route verifies the signature,
   maps the session name to a tenant, and stores the event durably before
   answering 200 (idempotent on message id).
2. If the chat has an active mission: if the message is `fromMe` and was not
   sent by the engine, the mission becomes `taken_over`. Otherwise the message
   joins the sender's debounce batch.
3. When the sender has been silent for the debounce window, the batch closes.
   In groups it goes through the fast path (mention of the tenant or the
   assistant, reply quoting a tenant or agent message, a file while the
   mission expects one) or, failing that, `MessageTriage` (Haiku, structured
   yes/no). A "no" ends here with no LLM turn.
4. Voice notes are transcribed with the existing transcription service; images
   and PDFs are fetched and attached as content blocks.
5. `MissionAgent` runs one turn on the append-only history, with server notices
   ("10 minutes left", "owner answered: …") as mid-conversation system
   messages.
6. The engine applies the pacing rules and sends: `sendSeen` → `startTyping`
   → wait → `stopTyping` → `sendText`. Every LLM call records usage.

### Anti-ban rules (enforced in code)

From WAHA's "How to avoid blocking" guide, made concrete. Numbers are the
builder's starting values, to tune by config:

- Seen, typing indicator and a randomized delay proportional to reply length
  before every message; never a fixed delay.
- Debounce per sender (start ~15 s) so several bubbles get one reply.
- One reply per batch; at most a small burst of messages per agent turn.
- Opening message: one, short.
- Reminders when the other side is silent: at most 2 per mission, at least
  30 min apart; at most 1 for a contact with no prior chat history.
- Caps: messages sent per mission (start 40); active missions per tenant
  (start 3); missions to new numbers per tenant per day (start 5); agent
  messages per hour in a group.
- Quiet hours (start 22:00–08:00 in the server `TIMEZONE`; tenants have no
  time zone of their own today): no sends; the mission waits and resumes in
  the morning, deadline still applies.
- Hard cap on LLM calls per mission (runaway protection, builder sets the
  value): reaching it stops the mission.
- On the `session.status` event with `reachoutTimelock.isActive`, pause every
  mission of that tenant and notify; resume only when the lock lifts.

### MCP tools (all tenants)

- `start_mission(chat_id, system_prompt, objective, done_when, max_duration_minutes, expects_files?, owner_aliases?, target_ids?, closing_message?)`
  → mission id. Validates limits, chat id, duration cap (start 120 min).
- `get_mission(id)` / `list_missions(status?)` → state, timeline summary,
  pending questions, collected items (media ids usable with `get_media`), usage.
- `answer_mission(id, answer)` → delivered to the agent as a server notice.
- `cancel_mission(id)`.
- Admin: `get_llm_usage(from?, to?, tenant_id?)`, mirroring
  `get_transcription_usage`.
- Any tool result for a tenant with unseen mission outcomes gets a short notice
  appended ("1 mission finished: …").

### Data

In `auth.db` (tenant-scoped, like `transcription_usage`/`tool_calls`): a
`missions` table (ids, tenant, chat, state, deadline, counters, timestamps) and
`llm_usage` (tenant, mission, at, model, kind `agent|triage`, input, output,
cache read/write tokens, cost). Mission content (system prompt, history,
summaries, questions) lives sealed with the tenant DEK, either in the tenant's
`cache.db` or as sealed columns; the builder chooses. Webhook events are stored
durably until processed so a restart loses nothing.

### Webhook setup

Each tenant session gets a WAHA webhook pointing at
`{PUBLIC_BASE_URL}/webhooks/waha` for message and session-status events,
signed with a server secret (new env var). Existing sessions are updated at
startup or by a one-time migration; new sessions get it on creation. The exact
WAHA config shape, event names (including how `fromMe` messages arrive) and
signature scheme must be confirmed against WAHA 2026.9.2 in the spike.

### Failure handling

- Refusal (`stop_reason: "refusal"`): mission `stopped`, owner notified (no
  model fallback exists for Haiku 5.5 refusals).
- Provider outage: OpenRouter falls back to the next Haiku 5.5 provider.
- OpenRouter/LLM errors: bounded retries with backoff; after repeated failure
  the mission is `stopped` and the owner notified.
- WAHA disconnected or tenant revoked: missions `stopped`.
- Restart: on boot the engine reloads active missions, re-arms timers from
  stored deadlines and reprocesses unprocessed events.

## Spike before building (throwaway)

Validate with real calls before planning firmly. If OpenRouter lacks a
feature, work around it in code (for example, server notices as tagged text in
the user turn instead of system messages); do not switch to the direct API.

1. OpenRouter `/api/v1/messages` with Haiku 5.5 honors `provider` ordering
   (Anthropic serves by default, fallback providers only on failure), mid-conversation `role: "system"`
   messages, `output_config.effort`, `cache_control` (cache reads > 0 on turn
   2), strict tools, image + PDF blocks, and returns `usage.cost`.
2. WAHA 2026.9.2 GOWS webhook config shape, events for incoming and `fromMe`
   messages in direct chats and groups, `session.status` with
   `reachoutTimelock`, and the signature header.

## Left to the builder

- Where sealed mission content lives (tenant `cache.db` vs sealed columns).
- Exact starting values of the limits above, as config with defaults.
- Group context window size passed to triage and agent.
- Effort levels (start: agent `medium`, triage `low`) and `max_tokens`.
- Tool description wording that guides Claude's prompt writing.
- Text of the WhatsApp self-notifications and of the `/privacidad` update.
