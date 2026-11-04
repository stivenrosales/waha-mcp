# waha-mcp: multi-tenant (one server, many WhatsApp accounts) — design

Date: 2026-11-04. Supersedes the "personal use only, one owner" scope of
`2026-10-30-waha-mcp-design.md` and `2026-11-02-sending-design.md`. Target release: 0.4.0.

## 1. Intent

waha-mcp today serves exactly one person: the owner. One `WAHA_SESSION`, one `cache.db`, and
the login password *is* the WAHA API key. A friend wants to use it, and more will follow. The
owner wants to keep **one** deployment and manage everyone from the MCP itself ("invite Juan"
from Claude), while each friend's WhatsApp data stays private to that friend and is encrypted
at rest. WAHA is now the Plus tier (multi-session), so every friend gets their own WAHA session
on the shared WAHA instance.

## 2. Goals

- Several **tenants** on one waha-mcp process. A tenant is one WhatsApp account = one WAHA
  session. Each tenant has exactly one user (its owner) in this version.
- **Admin invites by link.** The admin (the current owner) creates a tenant from Claude with an
  admin-only MCP tool and gets a single-use invite link. The invitee opens it, sets a password,
  and pairs their WhatsApp by scanning a QR on the same page.
- **Per-user login.** OAuth login becomes username + password. Every access token is bound to
  one user and therefore to one tenant.
- **Hard isolation.** Every tool, `/media` and `/upload` request operates only on the tenant of
  the token that made it. No tool accepts a session or tenant argument.
- **Encryption at rest** for everything that holds conversation content (message cache,
  transcripts, uploaded files), with a separate key per tenant.
- **Admin management from the MCP:** create invite, list tenants (status, not content), revoke
  a tenant's logins, delete a tenant (data destroyed).
- **Zero-loss migration:** the existing deployment becomes tenant #1 (the admin) with its
  current WAHA session and cache.

## 3. Non-goals

- Several users sharing one tenant (team access to one WhatsApp). Data model must not block it
  later, but no UI/tools for it now.
- Open self-registration.
- Billing, quotas per tenant beyond basic abuse limits.
- A web admin panel (`/admin`). Administration is MCP tools only.
- Protecting tenant data from the server operator (see §6.4).
- Per-tenant configuration of timezone, cache or transcription settings (global for now).

## 4. Anti-goals (a failure even if it works)

- Any path where a request authenticated as tenant A can read, send from, or receive links to
  tenant B's data. This includes the model passing an id from another tenant.
- An invite link that works twice, never expires, or can be guessed.
- Tenant content readable from a copy of the data volume or a backup without the master key.
- The WAHA API key or the master key appearing in a tool result, log line, page, or error.
- Losing the owner's existing cache, login or WAHA session in the migration.
- A non-admin seeing or calling admin tools.

## 5. Constraints (from the code as it is)

- Node ≥ 24, `node:sqlite` (`DatabaseSync`), Hono, `@modelcontextprotocol/server`.
  `node:sqlite` has no SQLCipher, so encryption is application-level (§6.4).
- `createMcpHandler` already builds a fresh `McpServer` per request
  (`src/infrastructure/mcp/server.ts`): per-tenant tool contexts and per-role tool lists fit
  naturally there.
- Today `main.ts` builds one gateway, one sender, one cache, one transcription service and one
  upload store, all bound to `config.wahaSession`. These become per-tenant.
- Today's login checks the password against `WAHA_API_KEY` (`oauth.ts`, `keyMatches`), and
  `/logout` revokes every client of every user. Both must change.
- The cache stores each message as a `raw` JSON text column; search and filtering happen in the
  application, not in SQL (`sqliteMessageStore.ts`). Encrypting `raw` therefore does not break
  `search_messages`.
- Media and upload links are HMAC tokens over a single `media-secret`; the payload holds only
  the media id / upload id and expiry.
- WAHA is exposed on a public domain today (`n8n-waha.swnb5v.easypanel.host`). With many
  tenants one WAHA API key reaches every session.

## 6. Design

### 6.1 Data model (`DATA_DIR/auth.db`, extended)

- `tenants(id TEXT PK, waha_session TEXT UNIQUE, display_name, status, created_at,
  wrapped_dek BLOB, dek_version INTEGER)`. `status`: `invited` → `pairing` → `active`;
  `revoked` keeps data but blocks login; deletion removes the row.
- `users(id TEXT PK, tenant_id FK, username TEXT UNIQUE, password_hash TEXT, role TEXT CHECK
  (role IN ('admin','member')), created_at)`. Exactly one user per tenant for now; the admin is
  the user of tenant #1 with `role='admin'`.
- `invites(hash TEXT PK, tenant_id FK, expires_at, used_at)`. Only the sha256 of the invite
  token is stored, like OAuth tokens today.
- `codes` and `tokens` gain `user_id` (NOT NULL after migration). `verifyAccessToken` returns
  `{ clientId, scope, userId, tenantId, role }`.
- WAHA session name for new tenants: generated, e.g. `t_<random 10 base32>`. Never derived from
  the display name or phone number.

### 6.2 Request flow and isolation

1. `bearerGuard` resolves the token to `AuthInfo { clientId, scope, userId, tenantId, role }`
   and rejects tokens of tenants whose status is not `active`.
2. A `TenantRegistry` returns the tenant's runtime: gateway, sender, cached gateway, message
   store, transcription service, upload store, engine mapper. Built lazily on first use and
   kept in an LRU (each holds an open SQLite handle); evicted runtimes close their DB.
3. `createMcpServer`'s per-request factory receives `AuthInfo`, takes the runtime from the
   registry, and registers the normal tools with that runtime's `ToolRunContext`. Admin tools
   are registered only when `role === 'admin'`, so members never see them in `tools/list`.
4. Application code (`src/application/*`) does not learn about tenants: it keeps receiving
   ports. Tenancy lives in infrastructure and composition.
5. Signed links carry the tenant: media and upload token payloads add `t: tenantId`. `/media`
   and `/upload` resolve the runtime from the token's tenant. A link is a bearer capability, as
   today; it simply cannot be replayed against another tenant's session.

### 6.3 Invite, pairing and login

- `create_invite(display_name)` (admin): creates tenant (`invited`), creates the WAHA session
  via the WAHA API (Plus: `POST /api/sessions`, GOWS engine), mints a 32-byte invite token,
  returns `PUBLIC_BASE_URL/invite/<token>` and its expiry. Default TTL 72 h.
- `GET /invite/<token>`: page to choose username + password (min length 12; hashed with
  `crypto.scrypt`, per-user salt). On submit the invite is consumed atomically, the user is
  created, the tenant moves to `pairing`.
- Pairing page (same flow, continued): shows the WAHA QR for the tenant's session, refreshing
  until WAHA reports `WORKING`; then the tenant becomes `active`. The page fetches the QR via a
  server endpoint authorised by a short-lived pairing cookie, never by exposing WAHA.
  Re-pairing later (phone changed): the member logs into the same page with username/password.
- OAuth `/authorize` login form: username + password instead of the WAHA API key. The existing
  rate limiter applies per IP and per username.
- `/logout` revokes only the logged-in user's clients and tokens.

### 6.4 Encryption

Threat model, stated plainly: protects tenant content against theft of the data volume,
backups, or a leaked `cache.db`. It does **not** protect against the server operator, who holds
the master key and the WAHA API key, and whose WAHA instance stores each WhatsApp session. The
invite page says this in one sentence so friends know who they are trusting.

- **Envelope encryption.** `MASTER_KEY` (32 bytes, base64, required env var, never in
  `DATA_DIR`) is the KEK. Each tenant has a random 32-byte DEK stored in `tenants.wrapped_dek`,
  wrapped with AES-256-GCM under the KEK. DEKs are unwrapped in memory when a runtime is built.
- **What is encrypted with the tenant DEK (AES-256-GCM, random 12-byte nonce per value, AAD =
  tenant id + table + primary key):** `messages.raw`, `transcripts.text`, and uploaded files on
  disk (`DATA_DIR/tenants/<id>/uploads`).
- **What stays plaintext** (needed for indexes and sync): chat ids, message ids, timestamps,
  sync state. This metadata (who you talk to and when) is visible to someone with the disk but
  without the key. Accepted for this version; documented.
- **Layout:** `DATA_DIR/tenants/<tenant-id>/cache.db` and `.../uploads/`. One file per tenant
  keeps isolation physical and makes deletion a directory removal.
- **Deletion = crypto-shredding:** `delete_tenant` deletes the tenant row (and its DEK), logs
  out its users, deletes the WAHA session (logout + delete via WAHA API), then removes the
  tenant directory. Without the DEK any leftover copy (backups) is unreadable.
- **Key rotation:** `dek_version` exists so rewrapping under a new `MASTER_KEY` is possible
  (`MASTER_KEY_PREVIOUS` env for one rewrap at startup). Re-encrypting data with a new DEK is
  out of scope.
- `auth.db` content (password hashes, token hashes) is not encrypted: it holds no conversation
  content and its secrets are already hashed.

### 6.5 Admin tools (registered only for `role='admin'`)

- `create_invite(display_name)` → link + expiry + tenant id.
- `list_tenants()` → id, display name, status, WAHA session status, created, last login. Never
  message content or counts from another tenant's chats.
- `revoke_tenant(tenant_id)` / `restore_tenant(tenant_id)` → block or allow login; revokes live
  tokens.
- `reset_password(tenant_id)` → single-use reset link (§9).
- `delete_tenant(tenant_id, confirm_display_name)` → irreversible destruction (§6.4). Refuses
  tenant #1 (the admin's own).
- Every admin tool call is logged (tool, target tenant id, outcome), never secrets.

The admin's own WhatsApp tools behave exactly as today, on tenant #1.

### 6.6 Migration (first start of 0.4.0 on an existing `DATA_DIR`)

1. Requires new env vars `MASTER_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` (the password is only
   read when the admin user does not exist yet; later changes go through a tool or re-seed).
2. Creates tenant #1 with `waha_session = WAHA_SESSION` (existing env var, now meaning "the
   admin's session"), status `active`, and the admin user.
3. Moves `DATA_DIR/cache.db` (+ WAL files) to `DATA_DIR/tenants/<id>/cache.db` and encrypts
   existing `raw`/`transcripts.text` rows in place, in batches, in one resumable pass.
4. Existing OAuth clients/tokens are revoked (they have no user); the admin logs in again once.
5. The migration is idempotent and recorded in `meta`.

### 6.7 Operational requirements (outside the code, documented in README)

- WAHA removed from its public domain; waha-mcp reaches it over Easypanel's internal network.
- `MASTER_KEY` stored only in Easypanel env, with an offline backup. Lost key = lost cache data
  (WhatsApp itself is unaffected; the cache rebuilds from WAHA).
- Transcription uses the single global OpenAI-compatible key, so every tenant's voice notes are
  billed to the admin. Global switch stays as today.

## 7. Approaches considered

- **A. One multi-tenant server, administered via admin-only MCP tools — chosen.** Matches "manage
  it from the same MCP server"; one deployment scales to many friends. Cost: the biggest change
  (auth, composition, cache, links).
- **B. Same, with a web `/admin` panel.** More visual, but adds HTML forms, CSRF and another
  attack surface for an admin who already lives in Claude. Rejected.
- **C. One waha-mcp container per friend, no code changes.** Best isolation and nearly free, but
  every friend is a manual deploy and nothing is managed from the MCP. Rejected for "many more".

## 8. Decided by the owner

- WAHA Plus, one session per tenant on one WAHA instance.
- Admin invites by link; no open registration.
- Approach A.
- Tenant data encrypted at rest.

## 9. Calls made by the designer (owner can override)

- One user per tenant; `role` admin/member only.
- Application-level AES-256-GCM on `raw`, transcript text and uploads; metadata stays plaintext.
- One SQLite file per tenant instead of a shared DB with `tenant_id`.
- Password login with scrypt; invite TTL 72 h; password minimum 12 chars.
- Existing OAuth sessions revoked at migration.
- Transcription stays global and billed to the admin.
- **WhatsApp disconnects after `active`:** the tenant stays `active` (the member keeps OAuth
  access). Detected on use: tools fail with a clear "WhatsApp disconnected — re-pair at
  `PUBLIC_BASE_URL/pair`" message, and `list_tenants` shows the WAHA session status. No
  background watcher, no webhooks. `/pair` is a username/password page that shows the QR.
- **Expired or abandoned invites:** no sweeper. The tenant stays `invited`/`pairing` and is
  visible in `list_tenants`. `create_invite` accepts an optional `tenant_id` to re-issue a link
  for an existing tenant that has no user yet (the previous link is invalidated). The admin
  removes unwanted tenants with `delete_tenant`, which handles tenants without a user.
- **Password reset:** admin tool `reset_password(tenant_id)` issues a single-use reset link
  (72 h) stored in the `invites` table with `kind IN ('invite','reset')`; using it revokes that
  user's tokens. The admin's own password is reset the same way, or by re-seeding
  `ADMIN_PASSWORD` with `ADMIN_PASSWORD_RESET=1`. No self-service "forgot password".
- **Admin tenant protection:** tenant #1 cannot be revoked, restored or deleted; it is the only
  admin. Admin tool tests assert members get none of them in `tools/list` and that a direct
  call is rejected.
- **Encryption boundary:** rule, not a list — every field holding conversation content or
  personal names (message bodies, captions, chat/group/contact names, transcripts, files) is
  encrypted; only opaque ids, timestamps and sync counters stay plaintext. Today that means
  `messages.raw`, `transcripts.text` and uploads.
- **One number, one tenant:** on pairing, the tenant's WhatsApp id (`me.id`) is stored in
  `tenants.wa_id` (UNIQUE). Pairing a number already active in another tenant is rejected and
  that WAHA session logged out.
- **Cache refresh:** only on use, as today; an evicted or idle tenant's cache is refreshed the
  next time that tenant calls a tool. No background sync.

## 10. Left to the builder

- Exact WAHA Plus endpoints/payloads for session create/QR/status/delete (verify against the
  running instance's `/api/version` and docs before coding), and whether WAHA offers
  session-scoped API keys worth using.
- LRU size for tenant runtimes, batch size for the migration, page wording and styling (reuse
  `loginPage.ts` patterns and `HTML_SECURITY_HEADERS`).
- How the per-tenant engine resolver is cached.
- Test strategy details, as long as cross-tenant isolation has explicit tests for every tool
  family, `/media` and `/upload`.
