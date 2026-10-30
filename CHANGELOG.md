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

TODO: the maintainer fills this in after the live smoke test (connect from Claude Code, log in with the WAHA key, `list_groups`, `get_chat_stats` with `America/Lima`, `get_media` on a sticker and a document, `/logout` re-prompts login).
