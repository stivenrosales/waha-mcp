# Missions in Direct Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant's Claude start a mission that a server-side Haiku 5.5 agent carries out in one WhatsApp direct chat (converse, receive a file) until the objective is met, the deadline passes, the tenant cancels or takes over.

**Architecture:** Inside the existing waha-mcp process (spec approach A). WAHA posts events to a new signed `/webhooks/waha` route that stores them durably. A mission engine, driven by a periodic tick over `missions.next_wake_at`, debounces incoming batches, runs one agent turn through `@anthropic-ai/sdk` pointed at OpenRouter, and sends with human pacing. Mission metadata and usage live in `auth.db`; mission content is sealed with the tenant DEK in the tenant's `cache.db`. Groups are out of scope here (plan 2).

**Tech Stack:** TypeScript, Node `node:sqlite`, Hono, zod, `@anthropic-ai/sdk`, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-16-missions-design.md`

## Global Constraints

- Model `anthropic/claude-haiku-5.5` via `https://openrouter.ai/api/v1/messages`, Bearer auth, request body `provider: { order: ["anthropic", ...], allow_fallbacks: true }` restricted to Haiku 5.5 providers. No direct Anthropic API, no other model family.
- No `temperature`, `top_p`, `top_k`, no assistant prefill. Conversation history is append-only; server notices are appended, never edited in.
- Effort: agent `medium`. `max_tokens` 4000 per agent turn.
- Claude writes the agent's system prompt; the server prepends or appends nothing to it.
- The agent can only: reply in the mission chat, `finish_mission`, `ask_owner`, `no_reply`. It never reads or writes other chats.
- Budget: US$1 per tenant per calendar month in the server `TIMEZONE` (`MISSIONS_MONTHLY_BUDGET_USD`, default `1`).
- Limits (config with these defaults): 40 messages sent per mission; 3 active missions per tenant; 5 missions to new numbers per tenant per day; 2 reminders per mission (1 for a chat with no prior history), at least 30 min apart; debounce 15 s; max duration 120 min; 60 LLM calls per mission; quiet hours 22:00–08:00 server `TIMEZONE`.
- Quiet hours block only agent-initiated sends (opening message, reminders), which are postponed to 08:00. Replies to a message the other side sent are allowed at any hour.
- Pacing per send: `sendSeen` → `startTyping` → randomized delay proportional to text length → `stopTyping` → `sendText`. Never a fixed delay.
- Any `fromMe` message in the mission chat not sent by the engine ends the mission as `taken_over`.
- Mission content is sealed with the tenant DEK; it is deleted 30 days after the mission ends and at once with the tenant. Usage rows carry no content and survive tenant deletion, like `transcription_usage`.
- Missions are enabled only when `OPENROUTER_API_KEY` and `WAHA_WEBHOOK_SECRET` are both set; otherwise the mission tools report "missions are not configured" and no webhook is configured.
- Log lines never include message text, prompts, keys or provider bodies.

## Review Focus

- The same WAHA event is delivered twice (retry). It is stored once (unique on tenant + message id) and processed once.
- The server restarts mid-mission (deploy). On boot, active missions resume from `next_wake_at` and unprocessed events are processed; nothing is sent twice.
- The other side sends three bubbles within 15 s. The agent replies once, to all three.
- The monthly budget is reached during an agent turn. The turn's usage is recorded, the mission stops with reason `budget`, and `start_mission` is refused afterwards.
- OpenRouter returns `stop_reason: "refusal"`, an HTTP 5xx, or malformed tool input. Refusal stops the mission with a notice; errors retry with backoff and stop after 3 consecutive failures; nothing is sent to the contact from a failed turn.

---

### Task 1: Spike (throwaway) — confirm OpenRouter and WAHA behavior

**Files:**
- Create: `docs/superpowers/specs/2026-11-16-missions-spike.md` (findings; the only kept artifact)
- Scratch scripts live in the session scratchpad, never in the repo.

**Interfaces:**
- Produces: the findings document, which later tasks read for the exact WAHA webhook config shape, event names, signature header, and which OpenRouter features work.

Requires from the owner: an `OPENROUTER_API_KEY` exported in the shell, and the WAHA URL/key already used for live tests (`WAHA_API_URL=<public domain>`).

- [ ] **Step 1: OpenRouter checks.** With `@anthropic-ai/sdk` (`baseURL: "https://openrouter.ai/api"`, `authToken`), send to `anthropic/claude-haiku-5.5` and record, per item, works / fails / workaround: provider ordering (which provider served, from response metadata or `/generation`), a `role: "system"` message mid-`messages`, `output_config.effort`, `cache_control` (turn 2 has `cache_read_input_tokens > 0`), a `strict: true` tool with `tool_choice: auto`, an image block and a base64 PDF block, `usage.cost` presence and unit.
- [ ] **Step 2: WAHA checks.** On a throwaway session or the admin session: the session config shape that registers a webhook URL, events, HMAC key and custom headers; the payload of an incoming direct message, of a `fromMe` message sent from the phone, of a message sent through `/api/sendText`, and of `session.status`; the signature header name and algorithm; whether the payload's message object is accepted by the existing GOWS `EngineMapper.message`.
- [ ] **Step 3: Write the findings document** with the exact shapes and a "decisions" list (e.g. "notices go as `role: system`" or "as tagged user text"). Commit it.

```bash
git add docs/superpowers/specs/2026-11-16-missions-spike.md
git commit -m "docs: record missions spike findings"
```

### Task 2: Config and the LLM client

**Files:**
- Modify: `src/config.ts`, `package.json` (add `@anthropic-ai/sdk`), `.env.example`, `README.md` (env table)
- Create: `src/domain/ports/LlmClient.ts`, `src/infrastructure/llm/openRouterClaude.ts`
- Test: `test/config.test.ts`, `test/infrastructure/llm/openRouterClaude.test.ts`

**Interfaces:**
- Produces: `config.missions: { openRouterApiKey: string; webhookSecret: string; model: string; monthlyBudgetUsd: number; limits: MissionLimits } | null` where `MissionLimits = { maxMessagesPerMission: 40; maxActivePerTenant: 3; maxNewContactsPerDay: 5; maxReminders: 2; maxRemindersNewContact: 1; reminderGapMs: 1_800_000; debounceMs: 15_000; maxDurationMinutes: 120; maxLlmCallsPerMission: 60; quietStartHour: 22; quietEndHour: 8 }` (each overridable by a `MISSIONS_*` env var).
- Produces: `interface LlmClient { turn(q: LlmTurnRequest): Promise<LlmTurnResult> }`, `LlmTurnRequest = { system: string; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[]; effort: "low" | "medium"; maxTokens: number }`, `LlmTurnResult = { content: Anthropic.ContentBlock[]; stopReason: string; usage: LlmUsage }`, `LlmUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null }`.
- Produces: `createOpenRouterClaude(opts: { apiKey: string; model: string; fetch?: typeof fetch }): LlmClient`.

- [ ] **Step 1: Write failing tests.** `config.test.ts`: "missions is null when neither OPENROUTER_API_KEY nor WAHA_WEBHOOK_SECRET is set"; "setting only one of them fails with 'OPENROUTER_API_KEY and WAHA_WEBHOOK_SECRET must be set together.'"; "defaults: model anthropic/claude-haiku-5.5, budget 1, limits as above". `openRouterClaude.test.ts` with an injected fake fetch: the request goes to `https://openrouter.ai/api/v1/messages` with `authorization: Bearer <key>`, body has `model`, `output_config.effort`, `provider.order[0] === "anthropic"`, no `temperature`; `usage.cost` 0.0012 maps to `costUsd 0.0012`, a missing `cost` maps to `null`; a 500 throws `LlmUnavailableError`.
- [ ] **Step 2: Run** `pnpm vitest run test/config.test.ts test/infrastructure/llm` — expected FAIL.
- [ ] **Step 3: Implement** the config group with a `superRefine` like the TRANSCRIPTION_* trio, and `createOpenRouterClaude` with the SDK client (`baseURL`, `authToken`, injected `fetch`), passing `provider` and `output_config` in the body exactly as the spike's findings say. Typed SDK errors map to `LlmUnavailableError` (retryable) or `LlmRejectedError` (4xx).
- [ ] **Step 4: Run** the same tests — expected PASS. Run `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: add OpenRouter Claude client and missions config`.

### Task 3: LLM usage, monthly budget and `get_llm_usage`

**Files:**
- Modify: `src/domain/ports/TenantStore.ts`, `src/infrastructure/tenants/sqliteTenantStore.ts`, `src/application/tenantAdmin.ts`, `src/infrastructure/mcp/tools/admin/index.ts`
- Create: `src/infrastructure/mcp/tools/admin/getLlmUsage.ts`
- Test: `test/infrastructure/tenants/sqliteTenantStore.test.ts`, `test/infrastructure/mcp/tools/admin/getLlmUsage.test.ts`

**Interfaces:**
- Produces on `TenantStore`: `recordLlmUsage(q: { tenantId: string; missionId: string; at: string; model: string; kind: "agent" | "triage"; usage: LlmUsage }): void`; `llmSpendUsd(q: { tenantId: string; fromIso: string; toIso: string }): number` (sum of non-null cost); `llmUsage(q: { fromIso: string; toIso: string; tenantId?: string }): LlmUsageRow[]` with `LlmUsageRow = { tenantId; displayName: string | null; calls; missions; inputTokens; outputTokens; cacheReadTokens; costUsd; rowsWithoutCost }`.
- Table `llm_usage(id, tenant_id, mission_id, at, model, kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)`, no foreign key, index `(at, tenant_id)`.
- Admin tool `get_llm_usage` with input `from?`, `to?`, `tenant_id?`, range defaulting to the current month in `TIMEZONE`, mirroring `get_transcription_usage` (copy its range handling, including the to-only rule from commit b7d990f).

- [ ] **Step 1: Write failing tests:** usage rows aggregate per tenant most-expensive-first; `llmSpendUsd` ignores null costs and other tenants; rows survive `deleteTenant` with `displayName: null`; the tool's text says "No mission LLM usage" for an empty range.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the table, store methods, `TenantAdmin.llmUsage` and the tool (`ADMIN_READ_ANNOTATIONS`).
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat: record mission LLM usage per tenant`.

### Task 4: Webhook ingest and WAHA webhook configuration

**Files:**
- Modify: `src/domain/ports/SessionAdmin.ts`, `src/infrastructure/waha/WahaSessionAdmin.ts`, `src/domain/ports/TenantStore.ts` (+ sqlite), `src/infrastructure/http/app.ts`, `src/composition.ts`, `src/main.ts`
- Create: `src/infrastructure/webhooks/wahaWebhook.ts`, `src/infrastructure/missions/sqliteEventStore.ts`
- Test: `test/infrastructure/webhooks/wahaWebhook.test.ts`, `test/fakes/FakeSessionAdmin.ts`

**Interfaces:**
- Produces: `SessionAdmin.configureWebhook(name: string, q: { url: string; secret: string }): Promise<void>` (shape from the spike); `TenantStore.getTenantBySession(session: string): Tenant | null`.
- Produces: `EventStore` with `put(q: { tenantId: string; eventId: string; kind: "message" | "session.status"; receivedAt: string; payloadSealed: string }): "stored" | "duplicate"`, `pending(limit: number): StoredEvent[]`, `markDone(id: number): void`. Table `webhook_events` in `auth.db`, unique `(tenant_id, event_id)`. Payloads are sealed with the tenant cipher (acquire the runtime) before storing.
- Produces: `createWahaWebhookRoute(deps): Hono` mounted at `POST /webhooks/waha` (only when `config.missions`), and `onEvent` callback to wake the engine.
- Startup: for every active tenant, `configureWebhook(session, { url: \`${publicBaseUrl}/webhooks/waha\`, secret })`; pairing (`/pair` session create/start) configures it too.

- [ ] **Step 1: Write failing tests:** a bad or missing signature → 401 and nothing stored; unknown session → 200 and nothing stored (do not leak); a valid message event → stored sealed, 200; the same event twice → stored once; body over the route's size limit → 413.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** signature verification per the spike (constant-time compare), the route, the event store, `configureWebhook` and the startup/pairing calls.
- [ ] **Step 4: Run** — expected PASS; run the e2e suite.
- [ ] **Step 5: Commit** `feat: receive WAHA webhooks for missions`.

### Task 5: Mission domain rules (pure)

**Files:**
- Create: `src/domain/missions/mission.ts`, `src/domain/missions/pacing.ts`
- Test: `test/domain/missions/mission.test.ts`, `test/domain/missions/pacing.test.ts`

**Interfaces:**
- Produces: `MissionState = "active" | "succeeded" | "failed" | "expired" | "cancelled" | "taken_over" | "stopped"`; `StopReason = "refusal" | "restriction" | "revoked" | "errors" | "budget" | "llm_cap" | "message_cap"`; `isTerminal(state): boolean`; `transition(m: MissionSnapshot, event: MissionEventKind): MissionSnapshot` (throws on a transition out of a terminal state).
- Produces: `typingDelayMs(text: string, rand: () => number): number` — base 1500 ms + 50 ms per character, ±25 % jitter, clamped to [2000, 15000]; `inQuietHours(at: Date, tz: string, limits: MissionLimits): boolean`; `nextAllowedInitiatedSend(at: Date, tz: string, limits): Date` (08:00 next morning when quiet); `reminderDue(m: MissionSnapshot, now: Date, limits): boolean` (no reply since last agent message, under the reminder cap — 1 when `newContact`, else 2 — and ≥ 30 min since the last agent message or reminder).

- [ ] **Step 1: Write failing tests** with the exact values above: `typingDelayMs("hola", () => 0.5)` is 2000 (clamped); a 1000-char text clamps to 15000; 23:30 Lima is quiet, 08:00 is not; `nextAllowedInitiatedSend` at 23:30 returns 08:00 next day Lima; reminders: 0 after 29 min, 1 after 30 min, none for a new contact after its first.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** both files with no I/O (time zone math via `Intl.DateTimeFormat`, as `getTranscriptionUsage` does).
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat: add mission state and pacing rules`.

### Task 6: Mission store (metadata + sealed content)

**Files:**
- Create: `src/domain/ports/MissionStore.ts`, `src/infrastructure/missions/sqliteMissionStore.ts`, `src/infrastructure/missions/sealedMissionLog.ts`
- Modify: `src/infrastructure/tenants/runtime.ts` (open the log in `cache.db`), `src/application/tenantAdmin.ts` (delete content with the tenant)
- Test: `test/infrastructure/missions/sqliteMissionStore.test.ts`, `test/infrastructure/missions/sealedMissionLog.test.ts`

**Interfaces:**
- Produces: `missions` table in `auth.db`: `id, tenant_id, chat_id, state, stop_reason, new_contact, deadline_at, next_wake_at, created_at, ended_at, sent_count, reminder_count, llm_calls, last_agent_at, last_inbound_at, closing_message, expects_files, notice_seen`. `MissionStore`: `create`, `get(tenantId, id)`, `list(tenantId, state?)`, `update(id, patch)`, `due(now: string): MissionRow[]` (active with `next_wake_at <= now`), `countActive(tenantId)`, `countNewContactToday(tenantId, dayStartIso)`, `unseenOutcomes(tenantId)`, `markSeen(ids)`.
- Produces: `MissionLog` per tenant (`cache.db` table `mission_log(mission_id, seq, kind, sealed)` where `kind` is `prompt | spec | message | notice | question | answer | summary | collected`): `append(missionId, entry)`, `read(missionId): MissionLogEntry[]`, `purgeEndedBefore(iso)`, `deleteAll()`. Entries are sealed with AAD `mission:<missionId>:<seq>`.

- [ ] **Step 1: Write failing tests:** `due` returns only active missions whose wake time passed; `countActive` ignores terminal missions; log entries round-trip and are unreadable with another tenant's cipher; `purgeEndedBefore` removes only content of missions ended before the cutoff; `deleteTenant` path deletes the tenant's log.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat: store missions and their sealed log`.

### Task 7: Human-paced WhatsApp actions

**Files:**
- Modify: `src/domain/ports/WhatsAppSender.ts`, `src/infrastructure/waha/WahaHttpSender.ts`, `test/fakes/` (`RecordingSender`)
- Create: `src/application/missions/pacedSender.ts`
- Test: `test/infrastructure/waha/WahaHttpSender.test.ts`, `test/application/missions/pacedSender.test.ts`

**Interfaces:**
- Produces on `WhatsAppSender`: `sendSeen(q: { chatId: string; messageIds?: string[] }): Promise<void>`, `startTyping(chatId: string): Promise<void>`, `stopTyping(chatId: string): Promise<void>` (WAHA `POST /api/sendSeen`, `/api/startTyping`, `/api/stopTyping`).
- Produces: `sendPaced(deps: { sender: WhatsAppSender; sleep: (ms: number) => Promise<void>; rand: () => number }, q: { chatId: string; text: string; seenIds: string[] }): Promise<SentMessage>` — exact order seen → startTyping → sleep(`typingDelayMs`) → stopTyping → sendText; a typing failure does not block the send.

- [ ] **Step 1: Write failing tests:** the recorded call order is exactly `[sendSeen, startTyping, stopTyping, sendText]` with the sleep between typing calls; `startTyping` throwing still sends; the HTTP sender posts the right paths and session.
- [ ] **Step 2–4: Run FAIL, implement, run PASS.**
- [ ] **Step 5: Commit** `feat: send mission replies with human pacing`.

### Task 8: Mission engine

**Files:**
- Create: `src/application/missions/engine.ts`, `src/application/missions/agentTools.ts`, `src/application/missions/notify.ts`
- Modify: `src/composition.ts`, `src/main.ts` (start the tick after migrations; stop on SIGTERM)
- Test: `test/application/missions/engine.test.ts`

**Interfaces:**
- Consumes: `LlmClient` (Task 2), `TenantStore.recordLlmUsage`/`llmSpendUsd` (Task 3), `EventStore` (Task 4), pacing (Task 5), `MissionStore`/`MissionLog` (Task 6), `sendPaced` (Task 7), the tenant `EngineMapper` and `TranscriptionService`.
- Produces: `createMissionEngine(deps): { tick(now: Date): Promise<void>; wake(): void; stop(): void }`. `tick` (every 5 s, and on `wake`) processes pending events, then due missions.
- Agent tools (strict schemas, `tool_choice: auto`): `finish_mission({ outcome: "succeeded" | "failed", summary: string, collected?: { label: string; media_id?: string; value?: string }[] })`, `ask_owner({ question: string })`, `no_reply({})`. Assistant text = the reply to send.
- Behavior, each covered by a test with fake LLM, fake sender and a controllable clock:
  - Start: the opening turn runs (spec as the first user turn: "The mission starts now. Send your opening message.") and the opening is sent paced, or scheduled for 08:00 in quiet hours.
  - Inbound message in the mission chat: appended to the sender's batch; `next_wake_at = now + debounce`; three bubbles within 15 s produce one agent turn containing all three.
  - Voice notes are transcribed; images and PDFs fetched via the gateway and attached as content blocks.
  - `fromMe` message whose id the engine did not send → `taken_over`, no further sends.
  - `finish_mission` → `succeeded`/`failed`, summary and collected items logged, owner notified.
  - `ask_owner` → question logged, owner notified with "❓ <contact>: <question>"; the agent's text reply (if any) is still sent.
  - Deadline passed → `expired`; reminder due → reminder turn ("No reply yet. Send a short, friendly reminder.") respecting quiet hours and caps.
  - Caps: `sent_count` ≥ 40, `llm_calls` ≥ 60 or monthly spend ≥ budget → `stopped` with the matching reason.
  - `stop_reason: "refusal"` → `stopped` (`refusal`). `LlmUnavailableError` → retry at +30 s, +2 min, +5 min, then `stopped` (`errors`). Nothing is sent from a failed turn.
  - `session.status` with `reachoutTimelock.isActive` → every active mission of the tenant paused (no sends, deadline running); resumed when the lock lifts.
  - Terminal transition with `closing_message` set and state in `expired | cancelled | stopped` → one paced closing line (agent turn "The mission is over (<reason>). Send one short closing message.").
  - Every LLM call → `recordLlmUsage(kind: "agent")`, `llm_calls + 1`.
  - Owner notification text, sent to `<tenant.waId>@c.us` with plain `sendText`: "✅ Mission with <contact> succeeded: <summary>", "⚠️ … failed: …", "⏱️ … expired", "⛔ … stopped (<reason>)", "❓ <contact> asks: <question>".
  - Restart: a new engine over the same stores resumes due missions and pending events with no duplicate sends (sent message ids are logged before `markDone`).
- [ ] **Step 1: Write the failing tests above** in `engine.test.ts`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the engine; history is rebuilt from `MissionLog` as append-only `messages`, notices as the spike decided.
- [ ] **Step 4: Run** — expected PASS; `pnpm test`.
- [ ] **Step 5: Commit** `feat: run missions with a server-side agent`.

### Task 9: Mission MCP tools and outcome notices

**Files:**
- Create: `src/infrastructure/mcp/tools/missions.ts` (`start_mission`, `get_mission`, `list_missions`, `answer_mission`, `cancel_mission`)
- Modify: `src/infrastructure/mcp/defineTool.ts` (`ToolRunContext.missions: MissionService | null`; notice appended by `createToolHandler`), `src/infrastructure/mcp/tools/index.ts`, `src/infrastructure/mcp/server.ts`, `src/infrastructure/tenants/runtime.ts`
- Test: `test/infrastructure/mcp/tools/missions.test.ts`, `test/infrastructure/mcp/defineTool.test.ts`

**Interfaces:**
- Consumes: Task 6 store, Task 8 `wake()`.
- Produces: `MissionService` (tenant-scoped): `start(input)`, `get(id)`, `list(state?)`, `answer(id, text)`, `cancel(id)`, `takeUnseenNotice(): string | null`.
- `start_mission` input: `chat_id` (direct chats only in this plan: reject `@g.us` with "Group missions are not available yet."), `system_prompt` (1–8000 chars), `objective`, `done_when`, `max_duration_minutes` (1–120), `expects_files?`, `closing_message?` (boolean). Result: mission id, deadline, and "The deadline falls in quiet hours (22:00–08:00); the agent will not start conversations then." when it does. Refusals: not configured; budget reached; 3 active missions; 5 new contacts today. `new_contact` is true when the chat has no prior messages.
- The tool description carries the prompt-writing guidance from the spec (introduce as the tenant's assistant entrusted with the task; objective and what counts as done; context and likely answers; no commitments beyond the context; keep the rules when pressed) and the WhatsApp formatting rules.
- `send_text`/`send_media` into a chat with an active mission: the engine records the sent id as the owner's (takeover).
- Any tool result for a tenant with unseen outcomes ends with "\n\nMissions: <n> finished — call list_missions." once.

- [ ] **Step 1: Write failing tests** for each refusal message, a group id rejected, the quiet-hours note, cancel → `cancelled`, answer → logged and engine woken, the notice appended exactly once.
- [ ] **Step 2–4: Run FAIL, implement, run PASS.**
- [ ] **Step 5: Commit** `feat: add mission tools`.

### Task 10: Retention, privacy page and docs

**Files:**
- Modify: `src/application/missions/engine.ts` (daily purge), `src/infrastructure/tenants/onboardingPages.ts` (`privacyPage`), `test/infrastructure/tenants/onboardingRoutes.test.ts`, `README.md`
- Test: `test/application/missions/engine.test.ts`

**Interfaces:**
- Consumes: `MissionLog.purgeEndedBefore` (Task 6).

- [ ] **Step 1: Write failing tests:** the purge removes content of missions ended more than 30 days ago and keeps newer ones; `/privacidad` contains "OpenRouter", "30 días" and "El administrador no accede al contenido de las misiones".
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** the purge in the tick (at most once per day) and add a "Misiones" section to `privacyPage`: who receives mission conversations (OpenRouter and Anthropic), 30-day retention, deletion with the account, and the promise above. Document the tools, env vars and limits in `README.md`.
- [ ] **Step 4: Run** — expected PASS; `pnpm test`, `pnpm typecheck`, `pnpm lint`.
- [ ] **Step 5: Commit** `feat: purge mission content and document missions`.

### Task 11: End-to-end mission over the real app

**Files:**
- Test: `test/e2e/missions.test.ts`

- [ ] **Step 1: Write the test** over `composeApp` with a temporary `DATA_DIR`, in-memory WAHA, recording sender, fake LLM and a controllable clock: a member tenant starts a mission via the MCP client; a signed webhook delivers two bubbles; the agent replies once (paced call order recorded); a third webhook delivers an image; the fake LLM calls `finish_mission`; the owner receives "✅ …"; `get_mission` shows `succeeded`, the collected `media_id`, and usage; the admin's `get_llm_usage` shows the tenant's calls.
- [ ] **Step 2: Run** — expected PASS (all earlier tasks done). If it fails, fix the owning task's code, not the test.
- [ ] **Step 3: Commit** `test: cover a full mission end to end`.
