# waha-mcp — Design

Date: 2026-10-30
Status: draft, pending owner approval

## 1. Intent

An open-source, self-hosted MCP server that sits next to a [WAHA](https://waha.devlike.pro)
(WhatsApp HTTP API) instance and lets AI assistants **read and analyze WhatsApp groups** through
structured data.

Why now: the owner runs WAHA on EasyPanel with no public domain (it is reachable only on the
internal network). Neither Claude Code nor claude.ai can reach it today, so group analysis is
impossible without exposing WAHA itself. A dedicated MCP deployed on the same network solves
that without exposing WAHA, and doubles as a reusable tool for the community.

Primary user: a single owner of a WAHA instance, analyzing their own groups.
Secondary audience: the community — anyone who already runs WAHA.

## 2. Goals

- G1. Expose WAHA group and direct-chat data to MCP clients as **structured, normalized JSON** suited for analysis.
- G2. Compute deterministic **metrics in code** (counts, activity, reply graph) so the model does
  not count thousands of messages by hand and token usage stays low.
- G3. Map **every message type**, including attachments and stickers, and let the model actually
  see images/stickers on demand.
- G4. Work from **Claude (claude.ai and Claude Code), ChatGPT (Developer Mode connectors) and
  Gemini CLI**.
- G5. Be easy to self-host: one Docker container, configured by environment variables,
  deployable on EasyPanel or any VPS next to WAHA.

## 3. Non-goals (v1)

- Sending messages, reacting, editing, deleting, or any write action against WhatsApp.
- Interpreting content inside the server (topics, sentiment, summaries, voice-note
  transcription). That is the model's job; putting an LLM inside the server complicates
  deployment and adds cost for every self-hoster.
- Own message storage / sync database. v1 queries WAHA live. Storage may come later.
- Multi-user / multi-tenant access. One owner per deployment.
- The Gemini consumer app (no verified MCP support found). Target is Gemini CLI.

## 4. Anti-goals (failure even if it "works")

- Any path that lets a client send a WhatsApp message from the owner's number.
- WAHA's API key or WAHA's URL leaking to the AI client, logs, or tool output.
- Raw, noisy WAHA payloads dumped to the model (defeats G1 and burns context).
- Metrics computed by the model instead of the server.
- An install that requires the self-hoster to create accounts on third-party services.

## 5. Constraints

- **Requires a running WAHA instance.** The server needs `WAHA_API_URL`, `WAHA_API_KEY` and
  `WAHA_SESSION` (default `default`) in its environment.
- **Message history depends on the WAHA engine** (verified in WAHA docs):
  - WEBJS: `GET /api/messages` supported natively.
  - NOWEB: history only exists if `config.noweb.store.enabled=true` (off by default); ~3 months,
    or ~1 year / up to 100K messages per chat with `fullSync`.
  - GOWS: `GET /api/{session}/chats/{chatId}/messages` supported; history is stored by default
    (`gows.storage.messages` / `gows.storage.chats` stay enabled unless explicitly disabled;
    WAHA < 2026.8.1 ignored disabling them, bug #2207). GOWS syncs the full available history by
    default, cappable by env.
    The server must detect the engine at startup (WAHA session info) and report clearly when
    history is unavailable instead of returning an empty list as if the group were silent.
- **The owner's instance runs GOWS** (`Haiku-serv/CLAUDE.md:557`; `fetchGroups` measured ~5 s for
  258 groups, `Haiku-serv/src/lib/waha/client.ts:17`). Group listing on GOWS returns `{ JID, Name }`
  shapes, other engines `{ id }` / `{ id: { _serialized } }` (`client.ts:199`).
- **Engine scope for v1 (builder's call, owner may override):** GOWS is the fully supported,
  fixture-tested engine. Normalization lives behind a per-engine mapper; WEBJS and NOWEB mappers
  are added when real payloads are available. An unsupported engine is detected and reported
  explicitly, never silently mis-parsed.
- **Media retention depends on WAHA config.** An old attachment may be listed but no longer
  downloadable; this must be reported as "unavailable", not as an error of the server.
- **Client auth requirements** (secondary sources, to re-verify during implementation):
  - claude.ai and ChatGPT remote connectors accept either OAuth or no auth, over HTTPS,
    Streamable HTTP. ChatGPT registers its redirect URI dynamically (Dynamic Client
    Registration).
  - Gemini CLI supports Streamable HTTP + OAuth 2.0 with discovery on 401 and DCR.
  - Stdio is not usable by the remote clients.
- Stack must match the owner's existing MCPs (see `~/bsale-mcp`): Node >= 24, TypeScript,
  pnpm, `@modelcontextprotocol/server` v2 + `@modelcontextprotocol/hono`, Hono,
  `@hono/node-server`, zod 4, Vitest, Biome.
- Artifacts (code, comments, README, docs) in English for the community.

## 6. Approaches considered

### Access control

1. **Secret URL path** (the `bsale-mcp` pattern, `MCP_SECRET_PATH` >= 32 chars). Proven in
   production, simplest install, works in all three clients as a "no auth" connector.
   Trade-off: the URL is the password; a leaked URL (screenshot, log, shared config) gives full
   read access; rotation means reconnecting every client.
2. **Built-in OAuth 2.1, login with the WAHA API key** — **chosen**. The server is its own
   minimal authorization server. The login page asks for the WAHA API key, the server validates
   it against WAHA, and issues tokens. Trade-off: more code, and it is security code that must
   be tested carefully.
3. **OAuth delegated to an external IdP** (Auth0, Clerk, Keycloak). Most robust, but every
   self-hoster must create and configure an external account — rejected by anti-goal 5.

Why 2: the owner wants the URL alone to be worthless if leaked, plus a logout. Logging in with
the WAHA key means self-hosters invent no new credential: "if you can access your WAHA, you can
access your MCP".

### Data freshness

- **Live pass-through to WAHA** — **chosen for v1**. No database of messages; simplest.
- Own storage/sync — deferred. Design the WAHA access behind a port (interface) so a stored
  source can replace it later without touching tools.

### Base

- Reuse the community `seejux/waha-mcp` — rejected: stdio-only, includes a send tool,
  third-party code holding the WAHA key, and wrapping it (proxy + auth + fork) costs about as
  much as building our own.
- Build our own, mirroring `bsale-mcp` structure — **chosen**.

## 7. Decided design

### 7.1 Authentication

- OAuth 2.1 authorization server embedded in the MCP:
  - Protected-resource metadata and authorization-server metadata endpoints
    (`/.well-known/...`), so clients discover OAuth after a 401.
  - Dynamic Client Registration.
  - Authorization code flow with PKCE (S256 only).
  - Access tokens (short-lived) + refresh tokens.
- **Login page**: a single field, the WAHA API key. Login succeeds **only** if the submitted
  key equals the configured `WAHA_API_KEY` (constant-time compare). No live WAHA call at login,
  so other keys WAHA may accept do not grant access and login does not depend on WAHA being up
  (builder's call). Login attempts are rate-limited. On success the server issues the
  authorization code. The key is never stored in tokens or returned to the client.
- **Logout (minimal)**: an endpoint/page that revokes **all** issued tokens and registered
  clients, **effective immediately** on the next request. Protected by the same WAHA-key login.
  Connected clients must log in again.
- Token format: **opaque** tokens, stored hashed in SQLite and looked up on every request, so
  revocation is immediate (builder's call; single user, so the per-request lookup is negligible).
- Token storage: a small SQLite file on a mounted volume, so a container restart does not
  disconnect clients.
- No secret-URL fallback in v1.

### 7.2 Tools (all read-only)

| Tool             | Input                            | Output                                                                |
| ---------------- | -------------------------------- | --------------------------------------------------------------------- |
| `list_groups`    | optional name filter             | id, name, participant count, last activity                            |
| `list_chats`     | optional name filter             | direct (1:1) chats: id, contact name/phone, last activity             |
| `get_group_info` | group id                         | description, participants, admins, creation date                      |
| `get_messages`   | chat id, from, to, limit, cursor | normalized messages, next cursor                                      |
| `get_chat_stats` | chat id, from, to                | metrics (below)                                                       |
| `get_media`      | media id                         | image content for images/stickers; signed temporary link for the rest |

Every tool is marked read-only in its MCP annotations.

**Direct chats (owner's decision, 2026-10-30, after design approval: "debe también agregar
chats individuales").** `get_messages`, `get_chat_stats` and `get_media` accept any chat id, group
(`@g.us`) or direct (`@c.us` / `@s.whatsapp.net` / `@lid`). `get_group_stats` is renamed
`get_chat_stats`. For a direct chat the "participants" are the two parties, `silentMembers` is
empty, and `get_group_info` rejects a non-group id with a clear message. Direct chats are more
sensitive than community groups; the read-only and auth guarantees above are what protect them.

**Premium package (owner's decision, 2026-10-30: "Dale con todo").** Primary use case, in the
owner's words: "quiero que revises los chats de tal día y dime si hay pendientes o no, de todos
los chats, excluyendo grupos o quizá no, … y poder hacer en base a ellos todo lists o análisis".
Six more read-only tools, one stats extension and three MCP prompts:

| Tool                   | Purpose                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `list_pending_replies` | chats where the other side spoke last and the owner hasn't answered; waiting time; last messages |
| `get_activity_digest`  | every chat active on a day/range in one call, compact messages, "awaiting reply" flag            |
| `search_messages`      | text search (case/accent-insensitive) over text, captions and filenames in a range               |
| `get_thread`           | messages around one message plus its reply chain                                                 |
| `list_shared_files`    | documents, images, video, audio and links shared, filterable by chat, kind and date              |
| `get_contact`          | who a JID/phone/name is: names, phone, groups in common, last interaction                        |

- Scope for pending/digest/search: `direct` (default), `groups`, `all`. In groups a message is
  "pending" only when it mentions the owner or replies to an owner's message and the owner has
  not written in that group afterwards — so large community groups don't drown the result.
- `get_chat_stats` adds response times per party (median and average delay between a message
  from one side and the next message from the other side).
- MCP prompts: `daily-review` (pending of a day, prioritized), `pending-to-todoist` (turn pending
  items into tasks via the client's own Todoist connector — the MCP itself stays read-only),
  `group-summary` (topics, decisions, participants).
- The to-do list is produced by the model, never by the server. Deferred to v2: voice-note
  transcription (needs an AI service inside the server) and search over months of history
  (needs own storage).

**Known WAHA/GOWS limitations (observed on the owner's instance, 1,000 messages of one group):**
the messages endpoint returned no reaction events and no polls; mentions live in
`_data.Message.extendedTextMessage.contextInfo.mentionedJID`. `reactions` stays in the model but
is documented as "usually empty on GOWS" rather than promised.

### 7.3 Normalized message

- id, timestamp (ISO 8601), author (display name + phone/JID), type, text.
- Types: text, image, video, audio, voice note, document, sticker, location, contact, poll,
  system event (join/leave/etc.), deleted, unknown (with raw type name).
- Reply-to message id, reactions (emoji + who), mentions.
- Attachment **metadata only** inline: kind, mimetype, size, filename, caption, `media_id`, and
  availability. The file itself is never inlined in message lists.
- Location: lat/long/name inline. Contact: name/phone inline.

### 7.4 Metrics (`get_chat_stats`)

Computed in code over the requested range. Day and hour buckets use a timezone from the
`TIMEZONE` env var (IANA name, default `UTC`; the owner sets `America/Lima`), overridable per call
with an optional `timezone` input (builder's call).

Range size: one call processes at most a configurable cap of messages (`STATS_MAX_MESSAGES`,
default 5,000). If the range holds more, the result covers the most recent messages up to the
cap and the coverage note says so, so a busy group never times out a tool call (builder's call;
pulling caching forward is out of scope for v1).

Metrics:

- Messages per participant (and by type).
- Activity per day and per hour of day.
- Reply graph: who replies to whom (counts).
- Silent members: participants with zero messages in range.
- Coverage note: the actual date range WAHA returned, so the model knows if history was cut.

### 7.5 Media delivery

- Images and stickers: returned as MCP image content so the model can see them.
- Audio, video, documents: a signed, expiring link served by the MCP itself (proxying WAHA), so
  WAHA stays private.
- Unavailable media: explicit "no longer available on WAHA" result.

### 7.6 Deployment

- One Docker image; env vars: `WAHA_API_URL`, `WAHA_API_KEY`, `WAHA_SESSION`, `PUBLIC_BASE_URL`
  (for OAuth metadata and signed links), `DATA_DIR` (SQLite volume), `PORT`.
- Deployed on EasyPanel in the same project/network as WAHA; only the MCP gets a public domain.
- README with setup for EasyPanel/Docker and connection steps for claude.ai, Claude Code,
  ChatGPT Developer Mode and Gemini CLI.
- License: MIT.

### 7.7 Development access to WAHA

Owner's decision: during development the builder gets **temporary access to the owner's live
WAHA** (SSH tunnel to the VPS or a temporary domain) to capture real GOWS payloads as test
fixtures. The exact channel, host and credential are authorized explicitly by the owner before
first use, and the access is closed when fixtures are captured. Fixtures are scrubbed of phone
numbers, names and message text before being committed.

## 8. Left to the builder

- Exact GOWS endpoints, query parameters and the normalization mapping (verify against WAHA
  docs and real payloads from the owner's instance).
- Whether media download is available on the owner's WAHA tier (Core vs Plus) and version.
- Pagination strategy for `get_messages` and how stats handle ranges larger than one page.
- Token lifetimes, SQLite schema, rate limiting of the login page.
- Signed-link format and expiry.
- Whether ChatGPT and Gemini CLI render MCP image content (verify; fall back to signed link if
  not).
- Internal module layout (mirror `bsale-mcp`: domain / application / infrastructure).
