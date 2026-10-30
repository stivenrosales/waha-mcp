# Changelog

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
