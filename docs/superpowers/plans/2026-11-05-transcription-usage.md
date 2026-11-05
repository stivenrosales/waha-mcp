# Transcription Usage per Tenant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the cost and audio seconds of every paid transcription per tenant, and report them to the admin through a new `get_transcription_usage` tool.

**Architecture:** The OpenAI-compatible transcriber reports `usage` through an `onUsage` callback option, so the `Transcriber` port and the application layer stay unchanged. The tenant registry wires that callback into a new `transcription_usage` table in the central tenant store. `TenantAdmin` aggregates the rows per tenant, and a new admin tool exposes the result.

**Tech Stack:** TypeScript, Node, better-sqlite3 (central tenant store), zod, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-05-transcription-usage-design.md`

## Global Constraints

- A missing or non-numeric `usage.cost` is stored as NULL, never 0. A missing `usage.seconds` is stored as NULL.
- Record only provider calls that returned a transcript. Cache hits and failures are not recorded.
- A failure to write a usage row is logged and never fails the transcription.
- Existing tables are unchanged. The only addition is the `transcription_usage` table in the central tenant store.
- The tool is admin-only. It is read-only (`ADMIN_READ_ANNOTATIONS`), and its range defaults to the current month in the server `TIMEZONE`.
- Usage rows survive `deleteTenant`. In reports, a deleted tenant shows `displayName: null`. (Builder's call: the history is kept for internal control.)
- Log lines never include the provider key, the URL or the provider body.

## Review Focus

- The provider returns `usage` without `cost`, or with a string cost. The row is stored with `cost_usd` NULL, and the report counts it in `rowsWithoutCost`.
- The provider returns no `usage` at all (OpenAI, Groq). The row is still recorded with seconds and cost NULL.
- The usage insert throws (for example, the database is locked). The transcript is still returned and stored, and the error is logged.
- The range has no rows. The report returns zero totals and an empty `tenants` list, and the text says "No transcriptions".
- Usage from a deleted tenant inside the range. It is reported with `displayName: null`, not dropped.

---

### Task 1: Transcriber reports provider usage

**Files:**
- Modify: `src/infrastructure/transcription/openaiCompatible.ts`
- Test: `test/infrastructure/transcription/openaiCompatible.test.ts`

**Interfaces:**
- Produces: `export interface TranscriptionUsage { seconds: number | null; costUsd: number | null }`, plus a new option `onUsage?: (usage: TranscriptionUsage) => void` on `OpenAiCompatibleOptions`. It is called once, after a transcript was parsed successfully, before returning.

- [ ] **Step 1: Write the failing tests**
  - `reports usage cost and seconds from the response`: the body is `{ text: "hola", usage: { seconds: 9.2, cost: 0.000508 } }`, so `onUsage` is called once with `{ seconds: 9.2, costUsd: 0.000508 }`.
  - `reports null usage when the provider sends none`: the body is `{ text: "hola" }`, so the call is `{ seconds: null, costUsd: null }`.
  - `reports null cost when cost is not a finite number`: the body has `usage: { seconds: 3, cost: "0.1" }`, so the call is `{ seconds: 3, costUsd: null }`.
  - `does not report usage when the transcription fails`: a 500 status and a body with no `text` both throw `TranscriptionError` without calling `onUsage`.
- [ ] **Step 2: Run** `pnpm vitest run test/infrastructure/transcription/openaiCompatible.test.ts`. Expected: the 4 new tests FAIL.
- [ ] **Step 3: Implement.** Parse `usage` defensively. Use only finite numbers (`Number.isFinite`) of 0 or more. Call `opts.onUsage?.(…)` after `text` is validated. If `onUsage` throws, swallow it, because the transcript must still return. Update the doc comment to mention `usage`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: report provider usage from the transcriber`.

### Task 2: Central store records and queries usage

**Files:**
- Modify: `src/domain/ports/TenantStore.ts`, `src/infrastructure/tenants/sqliteTenantStore.ts`
- Test: `test/infrastructure/tenants/sqliteTenantStore.test.ts`

**Interfaces:**
- Produces on `TenantStore`:
  - `recordTranscriptionUsage(q: { tenantId: string; at: string; model: string; seconds: number | null; costUsd: number | null }): void`
  - `transcriptionUsage(q: { fromIso: string; toIso: string; tenantId?: string }): TranscriptionUsageRow[]`, with `fromIso` inclusive and `toIso` inclusive.
  - `export interface TranscriptionUsageRow { tenantId: string; count: number; seconds: number; costUsd: number; rowsWithoutCost: number }`. The rows are grouped by tenant and ordered by `costUsd` descending. `seconds` and `costUsd` sum non-null values only (SQL `COALESCE(SUM(x), 0)`). `rowsWithoutCost` is `COUNT(*) - COUNT(cost_usd)`.
- Table: `transcription_usage(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, at TEXT NOT NULL, model TEXT NOT NULL, seconds REAL, cost_usd REAL)`, plus `CREATE INDEX IF NOT EXISTS` on `(at, tenant_id)`. No foreign key: the rows must survive `deleteTenant`.

- [ ] **Step 1: Write the failing tests**
  - `records usage and sums it per tenant in a range`: two rows for tenant A (cost 0.01 and 0.02, seconds 10 and 20) and one for B (0.05). The query returns B first (`costUsd` 0.05), then A with `{ count: 2, seconds: 30, costUsd: 0.03 }`. Compare money with `toBeCloseTo`.
  - `counts rows without cost and never treats them as zero cost`: one row with `costUsd: null` and one with 0.01 give `{ count: 2, costUsd: 0.01, rowsWithoutCost: 1 }`.
  - `filters by range bounds and tenant`: rows outside `[fromIso, toIso]` are excluded, and `tenantId` limits the result to one tenant.
  - `keeps usage after deleteTenant`: after the delete, the row is still returned.
- [ ] **Step 2: Run** `pnpm vitest run test/infrastructure/tenants/sqliteTenantStore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the table to the existing schema block, using the `CREATE TABLE IF NOT EXISTS` pattern, so existing databases gain it on startup. Add both methods. If any other class implements `TenantStore` (`grep -rn "implements TenantStore\|: TenantStore =" src test`), add the methods there too.
- [ ] **Step 4: Run** the same command, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: store transcription usage per tenant`.

### Task 3: Wire transcriber usage into the store

**Files:**
- Modify: `src/infrastructure/tenants/runtime.ts`, `src/infrastructure/tenants/registry.ts`
- Test: `test/infrastructure/tenants/runtime.test.ts` (or `registry.test.ts`, whichever already builds a runtime with transcription on)

**Interfaces:**
- Consumes: `onUsage` (Task 1) and `TenantStore.recordTranscriptionUsage` (Task 2).
- Produces: a new optional dep on `buildTenantRuntime`, `recordUsage?: (usage: TranscriptionUsage) => void`. The registry passes `(u) => deps.tenants.recordTranscriptionUsage({ tenantId: tenant.id, at: new Date().toISOString(), model: config.transcription.model, ...u })`.

- [ ] **Step 1: Write the failing tests**
  - `records usage for the tenant after a transcription`: with transcription on, a fake fetch returns `{ text, usage: { seconds: 5, cost: 0.002 } }`. Transcribing one voice note records exactly one row for that tenant, with `costUsd` 0.002.
  - `a failing usage write does not fail the transcription`: `recordUsage` throws, yet the transcript is still returned and stored, and the logger received one line that contains neither the key nor the URL.
- [ ] **Step 2: Run** the focused test file. Expected: FAIL.
- [ ] **Step 3: Implement.** In `runtime.ts`, pass `onUsage` to `createOpenAiCompatibleTranscriber`, wrapping `deps.recordUsage` in `try/catch` that logs `transcription usage not recorded tenant=<id>`. In `registry.ts`, supply `recordUsage` when building.
- [ ] **Step 4: Run** the focused file and the full `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: record transcription usage for each tenant`.

### Task 4: `get_transcription_usage` admin tool

**Files:**
- Modify: `src/application/tenantAdmin.ts`, `src/composition.ts`, `src/infrastructure/mcp/tools/admin/index.ts`, `src/infrastructure/mcp/instructions.ts`, `README.md`
- Create: `src/infrastructure/mcp/tools/admin/getTranscriptionUsage.ts`
- Test: `test/application/tenantAdmin.test.ts`, `test/infrastructure/mcp/adminTools.test.ts`

**Interfaces:**
- Consumes: `TenantStore.transcriptionUsage` (Task 2), plus `parseRange`, `zoneFormatter`, `zoneParts` and `localMidnight` from `src/application/dates.ts`.
- Produces:
  - A new `TenantAdminDeps.timezone: string`. `composition.ts` passes `config.timezone`.
  - `TenantAdmin.transcriptionUsage(q: { from?: string; to?: string; tenantId?: string }): Promise<TranscriptionUsageReport>`.
  - `export interface TranscriptionUsageReport { from: string; to: string; tenants: Array<{ id: string; displayName: string | null; count: number; seconds: number; costUsd: number; rowsWithoutCost: number }>; total: { count: number; seconds: number; costUsd: number; rowsWithoutCost: number } }`. Here `from` and `to` are ISO instants. When both are omitted, `from` is the 1st of the current month at local midnight in `timezone` and `to` is now. An explicit `to` alone uses its end bound, and an explicit `from` alone runs to now.
  - Tool `get_transcription_usage`: title "Transcription usage", `ADMIN_READ_ANNOTATIONS`, and the input `{ from?: string, to?: string, tenant_id?: tenantIdField.optional() }`. The output schema mirrors the report.

- [ ] **Step 1: Write the failing tests**
  - tenantAdmin: `transcriptionUsage defaults to the current month in the timezone`, with a fixed clock and `timezone: "America/Lima"`: `from` is that month's first day at 05:00Z.
  - tenantAdmin: `transcriptionUsage names tenants and totals them`. Two tenants give display names and a total equal to the sum. A deleted tenant's row gives `displayName: null`.
  - tenantAdmin: `transcriptionUsage rejects from after to` with `InvalidInputError`.
  - adminTools: `get_transcription_usage is admin-only`. A member context gets the same refusal as the other admin tools.
  - adminTools: `get_transcription_usage text`. With rows, the text includes each tenant line, `$0.0300`-style USD with 4 decimals, and the total. With a row without cost, it includes the note `1 transcription(s) without cost reported`. With an empty range, the text says `No transcriptions between <from> and <to>.`
- [ ] **Step 2: Run** `pnpm vitest run test/application/tenantAdmin.test.ts test/infrastructure/mcp/adminTools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the method and the tool following `listTenants.ts`, then register it in `index.ts` after `listTenantsTool`. Add `get_transcription_usage` to the admin tool list in `ADMIN_INSTRUCTIONS`, with one line saying it reports transcription spend per tenant (costs come from the provider; spend from before this feature is not included). In the README, add a short subsection under "Voice-note transcription": what is recorded, where it is stored (the central store), that rows survive tenant deletion, that only providers returning `usage.cost` (OpenRouter) give costs, and the new tool in the tools table.
- [ ] **Step 4: Run** the focused files, then `pnpm typecheck && pnpm lint && pnpm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: add get_transcription_usage admin tool`.
