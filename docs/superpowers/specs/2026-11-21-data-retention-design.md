# Data Retention, Self-Service Deletion and the Owner's Style — Design

Date: 2026-11-21. Status: written for review (project B, parity with wa-mcp.com).

## Intent

wa-mcp.com deletes cached message data after 90 days, lets each user delete their own data and
unlink themselves, and writes AI messages "in the owner's style". waha-mcp stores encrypted
copies of conversations at rest (`DATA_DIR/tenants/<id>/cache.db`), so it should offer the same
guarantees to every tenant.

## Goals

1. **Automatic retention.** A periodic job (the existing daily retention purge) deletes cached
   message data older than `CACHE_RETENTION_DAYS` (default `90`, `0` keeps it forever) for every
   active tenant: cached messages and their coverage, stored edits/deletions, reactions, poll
   votes, and voice-note transcripts. It runs whether `CACHE_ENABLED` is on or off (transcripts
   and left-over rows exist either way).
2. **Self-service deletion.** Two new MCP tools every tenant gets:
   - `delete_my_data` (`confirm: true` required): wipes the calling tenant's cached messages,
     coverage, edits, reactions, poll votes and transcripts, and the content and rows of its
     ended missions and ended scheduled messages (plus the run history of active ones).
   - `unlink_account` (`confirm: true` required): logs the tenant's WhatsApp session out in WAHA
     (the device disappears from "Linked devices"), revokes every OAuth token of the tenant's
     user (all connected MCP clients must sign in again) and drops the cached runtime. The
     account can be re-linked at `/pair`.
     Both act only on the caller's tenant: the tenant id comes from the authenticated token, never
     from an argument, and the data wiped is the caller's own runtime database.
3. **Reply in the owner's style.** AI-composed scheduled messages and missions get a style hint
   derived from the owner's own recent messages in that chat (length, emojis, formality,
   language, casing/punctuation), fed into the existing prompts.

## Non-goals

- Deleting tenant accounts, OAuth clients/data, users, keys, active missions or active
  scheduled messages through retention.
- Deleting usage logs (tool calls, transcription and LLM usage): they hold no content and the
  LLM spend is what enforces the monthly budget.
- Deleting data in WAHA itself or on the phone.

## Design

- `CacheData` port (`src/domain/ports/CacheData.ts`), implemented over `cache.db` in
  `src/infrastructure/cache/cacheData.ts`: `pruneBefore(cutoffMs)` reuses
  `MessageStore.prune` and adds a transcript prune; `wipe()` reuses the same table list as the
  owner reset (`resetCacheForOwner` now calls the shared `wipeCachedContent`), keeping
  `meta.owner`. Every `TenantRuntime` exposes `cacheData`.
- Retention runs inside `createMissionPurge` (one daily job, one tenant loop, same
  acquire/release discipline): with `cacheRetentionDays > 0` it acquires every active tenant's
  runtime and calls `cacheData.pruneBefore`. The mission purge also exposes
  `purgeTenantHistory(tenantId, now)` (its per-tenant step with cutoff "now"), which
  `delete_my_data` reuses.
- `createSelfService` (`src/application/selfService.ts`) holds `deleteMyData` and `unlink`; the
  MCP server binds it per request to `authInfo.tenantId` and that request's runtime, and hands it
  to tools as `ctx.self`.
- `ownerStyleHint(texts)` (`src/application/ownerStyle.ts`) turns the owner's message texts into
  one English paragraph, or null with fewer than 3 messages. Scheduled runs compute it from the
  context lines they already read; missions compute it once at `start_mission` from the chat's
  recent messages and append it to the stored system prompt (so the prompt cache keeps hitting).

## Assumptions

- `CACHE_RETENTION_DAYS` replaces `CACHE_MAX_AGE_DAYS`; the old variable is still read when the
  new one is unset, so an explicit `CACHE_MAX_AGE_DAYS=0` keeps data forever as before. With
  neither set the default is now 90 days (was: forever).
- Transcripts are pruned by when they were stored (`created_at`), since their row has no message
  timestamp.
- Mission and schedule sealed logs keep their existing 30-day retention after they end (shorter
  than 90 days); retention never touches active missions or schedules.
- A revoked tenant has no runtime, so its cache is pruned once it is restored (same rule as the
  mission purge) or wiped when it is deleted.
- `delete_my_data` does not touch pending uploads (they expire after `UPLOAD_TTL_SECONDS`, 15 min
  by default) nor stored webhook events (kept 7 days, needed by active missions); media files are
  never cached.
- `unlink_account` keeps the tenant active (not revoked), so the owner can sign in at `/pair` and
  link WhatsApp again without the admin. It is allowed for the admin tenant too.
- The style hint is a heuristic (no extra LLM call): Spanish/English/Portuguese detection by
  common words, formality from markers such as "usted"/"estimado" vs "jaja"/"bro".
