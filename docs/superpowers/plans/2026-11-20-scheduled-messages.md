# Scheduled Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner schedule fixed-text and AI-composed WhatsApp messages (one-time or
repeating) to people and groups, list them and cancel them; the server runs them on its own.

**Architecture:** A new `schedules` module beside `missions`, same layering: pure time rules in
`src/domain/schedules/`, a port in `src/domain/ports/`, metadata in `auth.db`
(`scheduled_messages`), sealed content and run log in the tenant `cache.db`, an application
runner driven by its own tick, and three MCP tools. It reuses `sendPaced`, `notifyOwner`, the
OpenRouter `LlmClient`, `llm_usage`, quiet hours and the mission pause state. The whole feature
exists only when `config.missions` is set (spec, amended Constraints).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), `node:sqlite` `DatabaseSync`, zod,
`@anthropic-ai/sdk` types, Vitest, Biome. pnpm.

**Spec:** `docs/superpowers/specs/2026-11-20-scheduled-messages-design.md`

## Global Constraints

- Feature available only when `config.missions !== null`; otherwise every schedule tool throws
  `InvalidInputError(MISSION_TEXTS.notConfigured)` (same as `requireMissions` in
  `src/infrastructure/mcp/tools/missions.ts:21-24`). Tools are always registered.
- All times in the server `config.timezone`. Tool input `at` format: `YYYY-MM-DD HH:mm`.
- No message text or instruction in `auth.db` or in logs. Content is sealed with the tenant
  `TenantCipher` in `cache.db`.
- `repeat`: `none | daily | weekly | monthly | yearly`.
- Limits (env, defaults): `SCHEDULES_MAX_ACTIVE_PER_TENANT=20`, `SCHEDULES_DEFAULT_RUNS=12`,
  `SCHEDULES_MAX_RUNS=52`, `SCHEDULES_MISSED_AFTER_MINUTES=60`.
- `instruction`: 1–2000 chars. `text`: `toWhatsAppText` + `assertTextLength` like `send_text`.
- Quiet hours (`inQuietHours`, `nextAllowedInitiatedSend` in `src/domain/missions/pacing.ts`)
  apply to every chat except the owner's own chat (`ownerChatId(waId)` in `notify.ts:27`).
- Never retry a send. `SendOutcomeUnknownError` → run outcome `unknown`.
- Run outcomes: `sent | skipped | failed | missed | unknown`. Every occurrence counts toward
  `max_runs`.
- Retention: run-log entries purged 30 days after their run (`MISSION_RETENTION_DAYS`); ended
  schedules purged 30 days after `ended_at`.
- Owner-facing WhatsApp notes in Spanish, in the style of `ownerTexts` (`notify.ts:15`).
- No `Co-Authored-By` or AI attribution in commits; Conventional Commits.
- Checks: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## Review Focus

1. **Server down across several occurrences** (daily schedule, server off 3 days): expect one
   `missed` run per passed occurrence, `runs_done` advanced for each, and the next run in the
   future — never a burst of catch-up sends. Test in Task 4.
2. **Monthly on the 31st through February, and Feb 29 yearly**: expect last-day clamping and
   the original day restored in the following month (31 Jan → 28/29 Feb → 31 Mar). Test in
   Task 1.
3. **Cancel during the typing pause**: nothing is sent after `cancel_scheduled` returns. Test in
   Task 4.
4. **AI composer returns no tool call or malformed input**: treat as `skipped` with reason
   "no decision", never send free text from a plain text block. Test in Task 3.
5. **Owner sends a message to the same chat a moment before**: not handled specially (spec
   does not ask); only an _active mission_ on the chat skips the run. Test that the mission
   case skips and matches `@c.us`/`@lid` forms via `chatIdForms`. Test in Task 4.

---

### Task 1: Time rules (domain)

**Files:**
- Create: `src/domain/schedules/recurrence.ts`
- Modify: `src/domain/missions/pacing.ts` (export `localParts` only if needed; do not change behaviour)
- Test: `test/domain/schedules/recurrence.test.ts`

**Interfaces:**
- Produces:
  - `export type ScheduleRepeat = "none" | "daily" | "weekly" | "monthly" | "yearly";`
  - `parseLocalDateTime(text: string, tz: string): Date` — `YYYY-MM-DD HH:mm` in `tz` → instant;
    throws `InvalidInputError('Use the format YYYY-MM-DD HH:mm, e.g. 2026-12-05 09:00.')` on bad
    input or impossible dates (2026-02-30).
  - `occurrenceAt(first: Date, repeat: ScheduleRepeat, index: number, tz: string): Date` — the
    `index`-th occurrence (0 = `first`), computed from `first`'s local date and time, never from
    the previous run. Monthly/yearly clamp to the last day of the target month.
  - `formatLocal(at: Date, tz: string): string` — `YYYY-MM-DD HH:mm`.

- [ ] **Step 1: Write failing tests** in `test/domain/schedules/recurrence.test.ts`:
  - `parses local time in Lima`: `parseLocalDateTime("2026-12-05 09:00", "America/Lima").toISOString() === "2026-12-05T14:00:00.000Z"`.
  - `rejects bad format and impossible dates`: `"2026-12-5 9:00"`, `"2026-02-30 10:00"` throw `InvalidInputError`.
  - `keeps local hour across DST`: `occurrenceAt(parse("2026-03-07 09:00","America/New_York"), "daily", 1, "America/New_York")` formats to `"2026-03-08 09:00"`.
  - `monthly clamps and restores the day`: first `2027-01-31 10:00` (Lima) → index 1 `2027-02-28 10:00`, index 2 `2027-03-31 10:00`.
  - `yearly Feb 29`: first `2028-02-29 08:00` → index 1 `2029-02-28 08:00`, index 4 `2032-02-29 08:00`.
  - `weekly adds 7 days`, `none returns first for index 0`.
- [ ] **Step 2:** `pnpm vitest run test/domain/schedules/recurrence.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement with `Intl.DateTimeFormat` (as `pacing.ts` does): convert local
  parts to an instant by guessing UTC and correcting by the zone offset twice (minute precision;
  `zonedInstant` in `pacing.ts` is hour-only and must not be reused).
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit `feat: add schedule recurrence rules`.

### Task 2: Storage (auth.db metadata + sealed tenant content)

**Files:**
- Create: `src/domain/ports/ScheduleStore.ts`, `src/domain/ports/ScheduleLog.ts`
- Create: `src/infrastructure/schedules/sqliteScheduleStore.ts`, `src/infrastructure/schedules/sealedScheduleLog.ts`
- Modify: `src/infrastructure/tenants/runtime.ts` (add `scheduleLog: ScheduleLog` to `TenantRuntime`, built from the same `cacheDb` and `cipher` as `missionLog` at `:177`)
- Test: `test/infrastructure/schedules/sqliteScheduleStore.test.ts`, `test/infrastructure/schedules/sealedScheduleLog.test.ts`

**Interfaces:**
- Produces (`ScheduleStore.ts`):

  ```ts
  export type ScheduleKind = "fixed" | "ai";
  export type ScheduleState = "active" | "done" | "cancelled";
  export interface ScheduleRow {
    id: string; tenantId: string; chatId: string; kind: ScheduleKind; repeat: ScheduleRepeat;
    firstAt: string; nextRunAt: string | null; runsDone: number; maxRuns: number;
    newContact: boolean; state: ScheduleState; createdAt: string; endedAt: string | null;
  }
  export interface ScheduleStore {
    create(q: Omit<ScheduleRow, "id" | "runsDone" | "state" | "createdAt" | "endedAt">): ScheduleRow;
    get(tenantId: string, id: string): ScheduleRow | null;
    listActive(tenantId: string): ScheduleRow[];          // newest first
    countActive(tenantId: string): number;
    due(nowIso: string, limit: number): ScheduleRow[];    // state=active AND next_run_at <= now, oldest first
    update(id: string, patch: Partial<Pick<ScheduleRow, "nextRunAt" | "runsDone" | "state" | "endedAt">>): void;
    countNewContactToday(tenantId: string, dayStartIso: string): number;
    endedBefore(tenantId: string, iso: string): string[];
    deleteSchedules(tenantId: string, ids: string[]): void;
    deleteForTenant(tenantId: string): void;
  }
  ```

  `firstAt` is the original first occurrence (input to `occurrenceAt`). Ids: `randomBytes(9).toString("base64url")`, like missions.
- Produces (`ScheduleLog.ts`):

  ```ts
  export type RunOutcome = "sent" | "skipped" | "failed" | "missed" | "unknown";
  export interface ScheduleContent { text?: string; instruction?: string }
  export interface ScheduleRun { at: string; outcome: RunOutcome; text?: string; reason?: string }
  export interface ScheduleLog {
    putContent(scheduleId: string, c: ScheduleContent): void;
    content(scheduleId: string): ScheduleContent | null;
    appendRun(scheduleId: string, run: ScheduleRun): void;
    runs(scheduleId: string, limit: number): ScheduleRun[];   // newest first
    purgeRunsBefore(iso: string): void;
    deleteSchedules(ids: string[]): void;
  }
  ```

  Tables: `schedule_content(schedule_id PK, sealed)` and `schedule_runs(schedule_id, seq, at TEXT NOT NULL, sealed, PRIMARY KEY(schedule_id, seq))` — `at` in plaintext for purging (only a timestamp). AAD `schedule:<id>:content` and `schedule:<id>:<seq>`, mirroring `sealedMissionLog.ts`.

- [ ] **Step 1: Write failing store tests** (`new DatabaseSync(":memory:")`, injected clock like `engine.test.ts:99-106`): create/get round trip; `due` returns only active rows with `next_run_at <= now` ordered oldest first and honours `limit`; `listActive` excludes `done`/`cancelled`; `countNewContactToday` counts `new_contact=1 AND created_at >= dayStart` for that tenant only; `endedBefore` + `deleteSchedules`; `deleteForTenant` leaves other tenants.
- [ ] **Step 2: Write failing log tests** with `testCipher("t1")`: content round trip; sealed column does not contain the plaintext; `runs` newest first with limit; `purgeRunsBefore` removes only older runs while content stays; opening with another tenant's cipher fails to read.
- [ ] **Step 3:** Run both → FAIL.
- [ ] **Step 4:** Implement both adapters and add `scheduleLog` to `TenantRuntime`.
- [ ] **Step 5:** Run tests + `pnpm typecheck` → PASS.
- [ ] **Step 6:** Commit `feat: add scheduled message storage`.

### Task 3: AI composer

**Files:**
- Create: `src/application/schedules/compose.ts`
- Test: `test/application/schedules/compose.test.ts`

**Interfaces:**
- Consumes: `LlmClient` (`src/domain/ports/LlmClient.ts`), `getMessages(gw, mapper, q)` (`src/application/messages.ts:57`), `toWhatsAppText`, `assertTextLength`.
- Produces:

  ```ts
  export type Decision = { action: "send"; text: string; reason: string } | { action: "skip"; reason: string };
  export async function composeScheduled(deps: { llm: LlmClient; readContext: (chatId: string) => Promise<ContextLine[]> },
    q: { chatId: string; instruction: string; now: Date; timezone: string }): Promise<{ decision: Decision; usage: LlmUsage }>;
  export interface ContextLine { at: string; fromOwner: boolean; text: string }
  ```

  `readContext` is built in Task 5 from the tenant gateway: last 40 messages within 14 days, newest last, text or transcript only (my call, left to builder by the spec).

- [ ] **Step 1: Write failing tests** with a `FakeLlm` returning scripted content blocks:
  - `sends when the tool says send`: `tool_use` `decide` `{action:"send", text:"Hola Jose…", reason:"…"}` → `decision.action === "send"`, text normalised by `toWhatsAppText`.
  - `skips when the tool says skip` → `{action:"skip", reason:"ya pagó el 3"}`.
  - `no tool call means skip`: a plain text block only → `{action:"skip", reason:"no decision"}` (Review Focus 4).
  - `malformed input means skip`: `{action:"send"}` without text → skip "no decision".
  - `prompt carries instruction, local date and context`: assert the request `system`/`messages` include the instruction, `formatLocal(now, tz)` and each context line prefixed `Owner:`/`Contact:`; `tools` has exactly one tool named `decide`; `effort: "low"`, `maxTokens: 1000`.
  - `returns usage` from the fake.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. System prompt (English): you write one WhatsApp message on the owner's behalf following the instruction, or skip when the context shows it is not needed or is unclear ("prefer skipping when unsure"); always answer by calling `decide`. Tool `decide` schema: `action` enum `send|skip`, `text` string, `reason` string (required: `action`, `reason`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: add AI composer for scheduled messages`.

### Task 4: Runner

**Files:**
- Create: `src/application/schedules/runner.ts`, `src/application/schedules/texts.ts`
- Test: `test/application/schedules/runner.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `sendPaced` + `PacedDeps`; `notifyOwner`, `ownerChatId`, `contactLabel`; `MissionStore.pausedUntil`, `MissionStore.list(tenantId, "active")`; `chatIdForms` (`inbound.ts:70`); `inQuietHours`, `nextAllowedInitiatedSend`, `monthStart`; `TenantStore.getTenant`, `llmSpendUsd`, `recordLlmUsage`.
- Produces:

  ```ts
  export interface ScheduleTenantPort {     // per tenant, from the registry (Task 5)
    sender: WhatsAppSender; log: ScheduleLog; readContext(chatId: string): Promise<ContextLine[]>;
    lookupLid(id: string): Promise<string | null>;
  }
  export interface ScheduleRunnerDeps {
    store: ScheduleStore; missions: MissionStore; tenants: TenantStore;
    acquire(tenantId: string): { port: ScheduleTenantPort; release(): void } | null;
    llm: LlmClient; model: string; monthlyBudgetUsd: number;
    limits: MissionLimits; missedAfterMs: number; timezone: string;
    paced: Omit<PacedDeps, "sender">; now(): Date; logger: { info(m: string): void };
  }
  export interface ScheduleRunner {
    tick(now: Date): Promise<void>; start(intervalMs?: number): void; stop(): void; idle(): Promise<void>;
    cancel(tenantId: string, id: string): boolean;   // marks cancelled + aborts an in-flight pause
    catchUp(tenantId: string, now: Date): Promise<void>;  // after restore_tenant
  }
  export function createScheduleRunner(deps: ScheduleRunnerDeps): ScheduleRunner;
  ```

  `texts.ts` exports `scheduleTexts` (Spanish owner notes): `sent(contact, text)` `📤 Enviado a ${contact}: «${text}»`, `skipped(contact, reason)` `⏭️ No envié a ${contact}: ${reason}`, `failed(contact)` `⚠️ No se pudo enviar el programado a ${contact}`, `unknown(contact)`, `missed(contact, n)` `⏱️ ${n} envío(s) programado(s) a ${contact} no salieron a tiempo`, `ended(contact)` `🏁 Terminó el programado a ${contact}`, `restoredMissed(n)`.

Run of one due schedule (serial, same pattern as `engine.ts` `serial`):
1. `acquire` null (revoked/evicted) → leave untouched.
2. Owner's own chat → no quiet hours, no pause. Other chats: `inQuietHours` → set `nextRunAt = nextAllowedInitiatedSend(now)`, stop. `missions.pausedUntil` → set `nextRunAt = until`, stop.
3. Lateness = `now − occurrenceAt(firstAt, repeat, runsDone)`. If `> missedAfterMs`: log `missed` for each passed occurrence (loop while late, cap at `maxRuns`), one `missed(contact, n)` note, advance (Review Focus 1). Quiet/pause postponements measure lateness from the postponed time (store the postponed `nextRunAt`; compute lateness against `nextRunAt`, not the occurrence).
4. Active mission on any `chatIdForms` of the chat → `skipped` "hay una misión activa en este chat".
5. `fixed` → `sendPaced(text)`; `ai` → budget check (`llmSpendUsd ≥ monthlyBudgetUsd` → skipped "presupuesto mensual agotado"), `composeScheduled`, `recordLlmUsage({ missionId: schedule.id, kind: "agent", ... })`, then send if `send`.
6. Outcome to log; notes: every `ai` run, every `failed`/`unknown`/`missed`. Advance: `runsDone+1`; if `runsDone ≥ maxRuns` or `repeat === "none"` → `state=done`, `endedAt`, `ended` note for recurring; else `nextRunAt = occurrenceAt(firstAt, repeat, runsDone)`.

- [ ] **Step 1: Write failing tests** (in-memory dbs, `RecordingSender`, `testCipher`, fake LLM, `sleep` resolving instantly, fixed `rand`):
  - `sends fixed text and schedules the next occurrence` (daily): one `sendText` with the exact text; `runsDone 1`; `nextRunAt` = next day same local time; no owner note.
  - `one-time schedule ends as done`.
  - `max_runs reached ends the schedule and notifies`: `maxRuns 2`, second run → `state done` + `ended` note.
  - `quiet hours postpone to 08:00 for other chats` and `owner chat ignores quiet hours`.
  - `pause postpones until the pause ends`.
  - `server down three days logs three missed and no sends` (Review Focus 1): daily, now = first + 3 days + 2h → 3 `missed` runs, one note, zero `sendText`, `nextRunAt` in the future.
  - `late under the threshold still sends` (30 min late).
  - `active mission on the chat skips` with `@lid` form of the chat (Review Focus 5).
  - `ai send notifies the owner with the text`; `ai skip notifies with the reason and sends nothing`; `ai budget used up skips without calling the llm`; `records llm usage with the schedule id`.
  - `send failure logs failed, notifies, never retries`; `SendOutcomeUnknownError logs unknown`.
  - `cancel during the typing pause sends nothing` (Review Focus 3): `sleep` blocks on a promise; call `cancel` before resolving.
  - `revoked tenant is left untouched` (`acquire` → null).
  - `catchUp marks passed occurrences missed with one summary note`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `runner.ts` and `texts.ts`.
- [ ] **Step 4:** Run → PASS; `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat: add scheduled message runner`.

### Task 5: Service, tools and wiring

**Files:**
- Create: `src/application/schedules/service.ts`, `src/infrastructure/mcp/tools/schedules.ts`
- Modify: `src/infrastructure/mcp/defineTool.ts` (`ToolRunContext.schedules: ScheduleService | null`), `src/infrastructure/mcp/tools/index.ts` (register after the send tools), `src/infrastructure/tenants/runtime.ts` (build the per-tenant `ScheduleService` and expose `ScheduleTenantPort` with `readContext` from `context.gateway` + `context.mapper()`), `src/composition.ts`, `src/main.ts` (create store on `auth.db`, start/stop runner next to the mission engine, drain on shutdown), `src/config.ts` (the four `SCHEDULES_*` vars inside `config.missions`, as `missions.schedules`), `src/application/missions/service.ts:205-211` (new-contact cap = missions + schedules count), `src/application/missions/retention.ts` (purge schedule runs and ended schedules), `src/application/tenantAdmin.ts` (delete → `deleteForTenant`; restore → `runner.catchUp`), `.env.example` (new vars, empty secrets untouched), `README.md` (tools list).
- Test: `test/application/schedules/service.test.ts`, `test/infrastructure/mcp/tools/schedules.test.ts`, extend `test/application/missions/retention.test.ts`, `test/application/tenantAdmin.test.ts` (or existing admin test file), `test/e2e/schedules.test.ts`.

**Interfaces:**
- Produces:

  ```ts
  export interface ScheduleService {   // bound to one tenant
    schedule(q: { chatId: string; kind: ScheduleKind; text?: string; instruction?: string;
      at: string; repeat: ScheduleRepeat; maxRuns?: number }): Promise<{ row: ScheduleRow; note: string | null }>;
    list(): Array<{ row: ScheduleRow; content: ScheduleContent; runs: ScheduleRun[] }>;  // last 5 runs
    cancel(id: string): ScheduleRow;
  }
  ```
- Tools: `schedule_message`, `list_scheduled`, `cancel_scheduled` (inputs as in the spec "Tools"; `schedule_message` uses `SEND_ANNOTATIONS`, the other two read-only/write as appropriate). The description of `schedule_message` includes `SEND_POLICY`-style text: show the owner recipient, local time, repetition and the text — or the instruction, saying the AI will write the words and may skip — before calling.

Validation in `schedule()` (all `InvalidInputError`, English, matching tool error style):
- `fixed` needs `text` and no `instruction`; `ai` needs `instruction` (1–2000) and no `text`.
- `at` parsed with `parseLocalDateTime`; must be after now.
- `maxRuns` only with `repeat !== "none"`; default `SCHEDULES_DEFAULT_RUNS`; `1..SCHEDULES_MAX_RUNS`.
- `countActive ≥ SCHEDULES_MAX_ACTIVE_PER_TENANT` → refuse.
- Direct chat with no history (`hasHistory` over `chatIdForms`, as in mission service) → new contact; refuse when missions + schedules new contacts today ≥ `maxNewContactsPerDay`.
- Note when the first run falls in quiet hours and the chat is not the owner's: "This falls in quiet hours (22:00–08:00); it will be sent at <local time>."

- [ ] **Step 1: Write failing service tests** for each validation rule above, the quiet-hours note, the combined new-contact cap (one mission + schedules reaching 5 refuses), and that content goes to `ScheduleLog`, not to the store row.
- [ ] **Step 2: Write failing tool tests**: not configured → `MISSION_TEXTS.notConfigured`; `schedule_message` result text shows id, local time and note; `list_scheduled` shows text/instruction and last runs; `cancel_scheduled` unknown id → error.
- [ ] **Step 3: Write failing wiring tests**: retention purges runs older than 30 days and ended schedules; admin delete removes schedules; admin restore calls `catchUp`.
- [ ] **Step 4: Write the e2e test** `test/e2e/schedules.test.ts` mirroring `test/e2e/missions.test.ts`: schedule a fixed message through the MCP tool for 1 minute ahead, advance the clock, tick, assert the fake gateway received the send and `list_scheduled` shows `sent`.
- [ ] **Step 5:** Run → FAIL.
- [ ] **Step 6:** Implement service, tools and wiring; document env vars in `.env.example` and tools in `README.md`.
- [ ] **Step 7:** `pnpm test && pnpm typecheck && pnpm lint` → all PASS.
- [ ] **Step 8:** Commit `feat: add scheduled message tools`.

## Notes for the executor

- `llm_usage` reuses `kind: "agent"` with the schedule id in `mission_id`. Spend has no kind
  filter, so the budget covers both (spec requirement). Side effect: admin `missions` counts in
  `get_tool_usage`/LLM usage rows include schedules; acceptable, mention it in the README.
- Do not touch the mission engine's timelock handling; the runner only reads `pausedUntil`.
