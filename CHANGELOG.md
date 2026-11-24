# Changelog

## Unreleased

### Features

- The account panel has tabs (Resumen, Recordatorios, Misiones, Actividad), 30-day metrics, the full history of reminders (each run and what went out) and missions (result, collected data and conversation), and a more compact layout.
- Zenbox branding on every web page (login, invite, pairing, reset, recovery, panel, privacy): cream and sage palette, Newsreader titles, DM Sans text (self-hosted, OFL), the Zenbox logo and favicon, and Zenbox in titles and emails. Replaces the Satoshi font and the pixel mascot icon.
- Account panel at `/panel`: sign in with the MCP username and password to see the WhatsApp state, active reminders and missions (with a cancel button), the latest tool calls and the subscription state. Sessions are server-side, last 12 hours and end with any revocation.
- Billing with Polar (optional): `POST /webhooks/polar` verifies Standard Webhooks signatures, reads each subscription's current state from the Polar API, creates the customer's account and emails the invite on the first good state, starts the grace period on `past_due`, and ends access on `canceled`/`unpaid`. At most 20 new accounts per hour.
- Password recovery by email (optional): with `EMAIL_FROM` and `RESEND_API_KEY` set, sign-in pages link to `/forgot`, which emails a 1-hour reset link through Resend. Users can add an email on the invite form; the owner's comes from `ADMIN_EMAIL`.
- Billing lifecycle for hosted tenants: after a failed payment, 3 days of grace; then WhatsApp is logged out and the tenant revoked; 30 days later the tenant and its data are deleted. A payment restores the tenant. Tenants without billing are never touched. Payment events are not wired yet.
- Webhooks no longer depend on missions: with `WAHA_WEBHOOK_SECRET` set, `/webhooks/waha` is mounted and every WAHA session is pointed at it.
- The webhook route also stores `message.edited`, `message.revoked`, `message.reaction`, `poll.vote` and `poll.vote.failed` events, sealed per tenant, for the message cache.
- New tool `send_poll`: sends a poll (2–12 options, single or multiple answers) and takes over an active mission like any other send.
- New tool `get_poll_results`: reads a poll's question, counts per option and who voted what, from the votes received through webhooks since the server started listening (votes WhatsApp could not decrypt are reported as a count). Without webhooks it returns the options with zero counts.
- New tool `react_message`: reacts to any message with one emoji, or removes your reaction with `""`. The reaction shows up in later reads right away and does not take over a mission.
- New tool `edit_message`: edits the text of a message you sent (WhatsApp only allows recent ones). The edit shows up in later reads right away and does not take over a mission.
- New tool `delete_message`: deletes a message you sent, for everyone; it cannot be undone. The text is removed from the message cache, transcripts and overrides; mission logs, schedule history and WAHA's own storage keep their own retention.
- New tools `mark_read` and `mark_unread`: mark a whole chat as read or unread. They do not take over a mission.
- New tools `delete_my_data` and `unlink_account` (every account, `confirm: true` required): delete your own cached messages, transcripts and ended missions and schedules, or log your WhatsApp out of the server and sign out every connected app. They only ever act on the calling account. The `/privacidad` page explains them and the retention.
- Missions and AI-written scheduled messages write in the owner's style: a description of how the owner writes in that chat (length, emojis, tone, capitalization, punctuation, language), derived from the owner's own recent messages there, is added to their prompts.
- Automatic retention: cached message data (messages, edits, deletions, reactions, poll votes and voice-note transcripts) older than `CACHE_RETENTION_DAYS` (default 90) is deleted by the daily retention purge, for every active tenant, with the message cache on or off.

- Single-owner by default: a new `MULTI_TENANT` variable. A fresh install serves only the admin's account (usage tools only; `list_tenants`, `create_invite`, `reset_password`, `revoke_tenant`, `restore_tenant` and `delete_tenant` are not listed and `/invite/:token` answers 404). `MULTI_TENANT=true` turns invites on; unset, a server that already has members stays multi-tenant. The startup log shows `mode: single-owner` or `mode: multi-tenant`.
- Self-hosting with Docker Compose: `docker-compose.yml` runs WAHA (GOWS) and waha-mcp together, with an optional Caddy HTTPS proxy; `scripts/init-env.sh` generates every secret into `.env`. See `docs/self-hosting.md` and `AGENTS.md`.
- When the admin's WhatsApp was paired after the first start (a fresh install), the next start records the account (`admin tenant: WhatsApp account recorded`), so mission and schedule notices reach the owner's own chat.

### Upgrade

- `CACHE_RETENTION_DAYS` replaces `CACHE_MAX_AGE_DAYS` (still read when the new one is unset) and its default changes from "keep forever" to 90 days. To keep cached data forever, set `CACHE_RETENTION_DAYS=0`.

- The first start after upgrading reconfigures each active session's webhook (new events), and WAHA restarts each session once.
- `WAHA_WEBHOOK_SECRET` alone now turns webhooks on (no missions needed). `OPENROUTER_API_KEY` without `WAHA_WEBHOOK_SECRET` is a startup error: `OPENROUTER_API_KEY needs WAHA_WEBHOOK_SECRET (missions receive messages through webhooks).`

## 0.4.0

One server, many WhatsApp accounts: the admin invites friends, each with their own login, WhatsApp session and encrypted data.

### Features

- Multi-tenant: each tenant is one WhatsApp account (its own WAHA session) with one user. Tenant #1 is the admin's (`WAHA_SESSION`); members sign up from an invite link (`/invite/:token`), pair WhatsApp with a QR code at `/pair`, and reset passwords from single-use links (`/reset/:token`). One WhatsApp number belongs to one tenant only.
- Login with username and password (scrypt) instead of the WAHA API key; `/logout` revokes only the signed-in user's clients and tokens.
- Admin tools, listed only for the admin: `list_tenants`, `create_invite`, `reset_password`, `revoke_tenant`, `restore_tenant`, `delete_tenant`. Every call is logged (tool, target tenant, outcome).
- Encryption at rest: message bodies, transcripts and uploads are encrypted (AES-256-GCM) with a per-tenant key wrapped by `MASTER_KEY`, in `DATA_DIR/tenants/<id>/`. `delete_tenant` crypto-shreds the tenant. `MASTER_KEY_PREVIOUS` rewraps every key under a new `MASTER_KEY` at start.
- Media and upload links are bound to their tenant: a revoked tenant's links, forged links and unknown tenants all answer the same 404.

### Upgrade

- New required variables: `MASTER_KEY` (`openssl rand -base64 32`), `ADMIN_USERNAME`, `ADMIN_PASSWORD`; optional `ADMIN_PASSWORD_RESET` and `MASTER_KEY_PREVIOUS`.
- The first start migrates a 0.3.0 `DATA_DIR` once (resumable): creates the admin tenant, moves and encrypts `cache.db`, deletes pending uploads, and revokes every OAuth session. Log in again with `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
- A wrong `MASTER_KEY` stops the start with `MASTER_KEY does not match the stored tenant keys.` and changes nothing.
- `PUBLIC_BASE_URL` with a path prefix is not supported.

## 0.3.0

waha-mcp is no longer read-only: it can send messages from the owner's number.

### Features

- New tools `send_text`, `send_media`, `send_location`, `send_contact` and `create_upload_link` (18 tools in total). They are annotated as writes (`readOnlyHint: false`), so clients ask for approval on every call; read tools keep `readOnlyHint: true`.
- WhatsApp formatting: tool descriptions carry WhatsApp's syntax, and text and captions are converted from Markdown (`**bold**`, headings, links, tables) before sending. Results echo the exact text sent.
- Attachments through single-use signed upload links (`/upload/:token`: `PUT` raw body, browser form, or `GET` picker page), stored in `DATA_DIR/uploads` and deleted after the send or on expiry (`UPLOAD_MAX_BYTES`, `UPLOAD_TTL_SECONDS`). `send_media` also forwards attachments already in WhatsApp (`media_id`) and public `https` URLs.
- A send WAHA does not confirm in time is reported as "outcome unknown" so the model checks the chat instead of retrying. Media sends on WAHA builds without that feature report "update to 2026.6.1 or later".

## 0.2.0

### Features

- Message cache: a SQLite copy of read messages in `DATA_DIR/cache.db` (`CACHE_ENABLED`, `CACHE_REFRESH_HOURS`, `CACHE_MAX_AGE_DAYS`). Later reads fetch only newer messages from WAHA; the cache is keyed to the WhatsApp account and wiped when the account changes.
- Optional voice-note transcription through an OpenAI-compatible API such as OpenRouter, OpenAI or Groq (`TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_MODEL`, `TRANSCRIPTION_LANGUAGE`, `TRANSCRIPTION_MAX_SECONDS`, `TRANSCRIPTION_MAX_PER_CALL`). Voice notes carry a `transcript`, `search_messages` matches stored transcripts, and transcripts are stored so they are never paid twice.
- New tool `transcribe_audio` (13 tools in total) to transcribe a specific audio or voice note on demand.
- Server icon (favicon) advertised to clients.
- `get_media` tells the model that documents, PDFs, video and large files cannot be read through the connector and to ask the user to download the file and attach it to the chat (audio points to `transcribe_audio` when transcription is on, and otherwise gives the user the link to listen to it). The server instructions carry the same rule.

### Fixes

- WAHA message reads now request an explicit sort order instead of relying on the default.
- `TRANSCRIPTION_MAX_PER_CALL=0` gives one note ("Automatic transcription is off ...") instead of a repeated per-voice-note count.
- Whitespace-only `TRANSCRIPTION_*` values count as unset, and the rest are trimmed; `TRANSCRIPTION_LANGUAGE` must be a lowercase ISO 639-1/639-2 code (a trailing comment on the same line is a startup error).
- Transcription failures are logged (`transcription failed status=<code> kind=<kind>`, no body, URL or key); HTTP 400/404/405/422 are reported as a configuration problem ("check TRANSCRIPTION_API_URL and TRANSCRIPTION_MODEL") instead of "try again later", and the coverage note names the kind.
- Automatic transcription has a 25 s budget per tool call; voice notes not started in time are reported as "not transcribed yet (time budget)".
- `get_thread` reports the cache note only when every page it read came from the cache.

## 0.1.0

First release.

### Features

- Read-only MCP server over WAHA (WhatsApp HTTP API, GOWS engine), Streamable HTTP at `/mcp`.
- 12 tools: `list_groups`, `list_chats`, `get_group_info`, `get_messages`, `get_chat_stats`, `get_media`, `list_pending_replies`, `get_activity_digest`, `search_messages`, `get_thread`, `list_shared_files`, `get_contact`.
- 3 MCP prompts: `daily-review`, `pending-to-todoist`, `group-summary`.
- Embedded OAuth 2.1 (dynamic client registration, PKCE S256, opaque hashed tokens, refresh rotation); the login is the WAHA API key. `/logout` revokes every session.
- Rate-limited login (per client address plus a global failure budget).
- Signed, expiring media links (`/media/:token`) with streaming and a size cap.
- Unsupported engines (WEBJS, NOWEB) are detected and reported by the tools.
- Docker image (Node 24 Alpine, non-root, `/data` volume, `/health` healthcheck).

### Live verification

Checked against the owner's WAHA (GOWS engine) with a local server on 2026-10-30:

- Startup detected engine GOWS and registered 12 tools, all read-only; 3 prompts listed.
- OAuth discovery, dynamic client registration, login and PKCE token exchange worked.
- `list_groups`: 260 groups (~5 s).
- `list_chats`: 355 direct chats (~4 s); names resolved after the paging fix (181 named).
- `list_pending_replies` over the last 24 h: 8 pending (~5 s).
- `get_activity_digest` for one day: 20 active chats, ~53 KB (~5 s).
- `get_chat_stats` on a direct chat: 340 messages with response times (~1 s).
- `search_messages` for "factura" over 7 days: 11 hits (~9 s).
- `list_shared_files`: 7 documents.
- `get_media`: signed link issued and the PDF downloaded (200, `application/pdf`, ~201 KB).
- Logout: the existing token was rejected with 401 `invalid_token`.

Bug found live and fixed: WAHA answers HTTP 500 when paging past the last page, so paging now stops on a short page.
