# Changelog

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
