# Transcription usage per tenant: design

## Intent

One provider key (`TRANSCRIPTION_API_KEY`, OpenRouter in production) serves every tenant, so the admin pays for every voice-note transcription. The admin wants to see, for internal control only, how much each tenant costs.

## Goals

- Record every paid transcription with its tenant, time, model, audio seconds and cost in USD.
- Add an admin-only MCP tool that reports usage per tenant for a date range, plus the total.

## Non-goals

- Spending caps, quotas, and billing tenants.
- Backfilling spend from before the deploy. That data exists only in the OpenRouter dashboard.
- "Code mode" (exposing a code-execution tool instead of discrete tools). Considered and rejected for now: clients already defer tool definitions, results are already aggregated on the server, and running model-written code on a multi-tenant server needs a sandbox.

## Approaches

1. **Per-transcription rows plus an admin report tool (chosen).** This keeps the full detail, answers any range ("this month", "since yesterday", "who spends most"), and needs no redesign later.
2. Running totals on `list_tenants`. Less code, but there are no ranges and no detail, so it would be rebuilt later.
3. Log lines only. No storage, the logs are lost on redeploy, and summing them is manual. Rejected.

## Decisions

- **Capture:** the OpenAI-compatible transcriber parses `usage.cost` (USD) and `usage.seconds` when present (OpenRouter sends both). A missing or non-numeric cost is stored as NULL, never 0. A missing `seconds` is stored as NULL.
- **What is recorded:** only provider calls that returned a transcript. Cache hits cost nothing and are not recorded. Failed calls are not recorded (builder's call: OpenRouter does not bill them).
- **Where:** a new table `transcription_usage` in the central tenant store (`sqliteTenantStore`), not the per-tenant `cache.db`. It survives cache wipes, and the admin reads one place. Columns: `id`, `tenant_id`, `at` (ISO), `model`, `seconds` (REAL, nullable), `cost_usd` (REAL, nullable). Existing tables are unchanged.
- **Tool:** `get_transcription_usage`, admin-only like the other tenant tools. Optional `from` and `to` take ISO dates, read in the server `TIMEZONE`. The range defaults to the current month. Optional `tenant_id` filters one tenant. The tool returns, per tenant (id and display name), the count, total seconds and total cost in USD, plus a grand total. It notes how many rows have no cost, so a total is never presented as complete when it is not.
- **Recording failures:** a failure to write a usage row is logged and never fails the transcription.

## Left to the builder

The exact output shape and wording follow the existing admin tools (`list_tenants`). Error handling and indexing (`tenant_id`, `at`) are also left to the builder.
