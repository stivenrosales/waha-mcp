# Multi-tenant waha-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn waha-mcp into one server for many WhatsApp accounts (tenants), each isolated, encrypted at rest, onboarded by admin invite, administered through admin-only MCP tools.

**Architecture:** `auth.db` gains tenants, users and single-use links; every token resolves to a user → tenant → role. A `TenantRegistry` lazily builds a per-tenant runtime (gateway, sender, encrypted cache, encrypted uploads, tenant-bound signed links) and the per-request MCP factory registers tools against that runtime, plus admin tools for the admin only. Application code (`src/application/*`) stays tenant-agnostic.

**Tech Stack:** Node ≥ 24, TypeScript, `node:sqlite`, `node:crypto` (AES-256-GCM, scrypt), Hono, `@modelcontextprotocol/server` v2, Vitest, Biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-multi-tenant-design.md` (read it whole, especially §6 and §9).

## Global Constraints

- No new runtime dependencies; crypto via `node:crypto` only.
- Release version `0.4.0` (`package.json` and `SERVER_VERSION` in `src/infrastructure/mcp/server.ts`).
- No tool accepts a session or tenant argument except admin tools, which take `tenant_id` of the tenant they manage.
- `MASTER_KEY`: 32 bytes, base64, env only, never written to `DATA_DIR`, never logged.
- Encrypted values: AES-256-GCM, random 12-byte nonce, AAD = tenant id + table/kind + primary key. Text format `v1.<base64url(nonce|ciphertext|tag)>`.
- WAHA session name for new tenants: `t_` + 10 random base32 chars (lowercase).
- Invite and reset links: 32 random bytes, only sha256 stored, single use, TTL 72 h.
- Password minimum 12 characters, hashed with `crypto.scrypt` and a per-user random salt.
- Tenant #1 (the admin's) cannot be revoked, restored or deleted.
- Error messages, logs and pages never contain `WAHA_API_KEY`, `MASTER_KEY`, DEKs, passwords or link tokens.
- Engine stays GOWS only; WAHA endpoints for sessions must be verified against the running instance (`GET /api/version`, WAHA Plus docs) before coding Task 8.
- Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`. Scratch state in `mktemp -d`, never in the worktree.

## Review Focus

1. **Cross-tenant ids from the model** — tenant B calls `get_media`/`get_messages`/`send_text` with an id that belongs to tenant A: it must only ever hit B's WAHA session; a media/upload link minted for A must 404 when its tenant field is altered to B. (Task 6, Task 12)
2. **Revocation mid-session** — after `revoke_tenant`, the tenant's next `/mcp` call is 401 and its existing `/media` and `/upload` links 404. (Task 4, Task 12)
3. **Eviction under use** — the registry must not close a tenant's SQLite handle while a request for that tenant is still running. (Task 7)
4. **Double submit of an invite** — two concurrent POSTs of the same invite create exactly one user; the second sees "link already used". (Task 3, Task 9)
5. **Wrong or rotated `MASTER_KEY`** — startup fails with `MASTER_KEY does not match the stored tenant keys.` instead of wiping or regenerating anything; with `MASTER_KEY_PREVIOUS` set, DEKs are rewrapped and startup succeeds. (Task 11)

---

### Task 1: Envelope encryption primitives

**Files:**
- Create: `src/infrastructure/crypto/envelope.ts`
- Test: `test/infrastructure/crypto/envelope.test.ts`

**Interfaces:**
- Produces:
  - `parseMasterKey(base64: string): Buffer` — throws `Error("MASTER_KEY must be 32 bytes encoded in base64.")`.
  - `generateDek(): Buffer` (32 random bytes).
  - `wrapDek(kek: Buffer, dek: Buffer, tenantId: string): string` / `unwrapDek(kek: Buffer, wrapped: string, tenantId: string): Buffer` — AAD `dek:<tenantId>`; unwrap throws `DecryptionError`.
  - `class DecryptionError extends Error`.
  - `interface TenantCipher { sealText(text: string, aad: string): string; openText(sealed: string, aad: string): string; seal(data: Uint8Array, aad: string): Buffer; open(sealed: Uint8Array, aad: string): Buffer }` — all AADs internally prefixed with `<tenantId>:`.
  - `createTenantCipher(dek: Buffer, tenantId: string): TenantCipher`.
  - `isSealedText(value: string): boolean` — true iff it starts with `v1.`.

- [ ] **Step 1: Write failing tests**: `roundtrips text and bytes`; `sealText output starts with "v1." and differs on each call` (random nonce); `open with a different aad throws DecryptionError`; `open with another tenant's cipher (same DEK, other tenantId) throws DecryptionError`; `a flipped ciphertext byte throws DecryptionError`; `unwrapDek with the wrong KEK throws DecryptionError`; `parseMasterKey rejects 31 and 33 bytes and non-base64`.
- [ ] **Step 2: Run** `pnpm test test/infrastructure/crypto` → FAIL (module missing).
- [ ] **Step 3: Implement** with `createCipheriv("aes-256-gcm")`; binary layout `nonce(12) | ciphertext | tag(16)`.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat: add envelope encryption primitives`.

### Task 2: Configuration for multi-tenancy

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces on `Config`: `masterKey: Buffer`, `masterKeyPrevious: Buffer | null`, `adminUsername: string`, `adminPassword: string`, `adminPasswordReset: boolean`. `wahaSession` stays and now means "the admin tenant's session".

- [ ] **Step 1: Write failing tests**: `requires MASTER_KEY, ADMIN_USERNAME and ADMIN_PASSWORD` (one error listing all three); `rejects ADMIN_PASSWORD shorter than 12 chars`; `rejects a MASTER_KEY that is not 32 bytes` without echoing the value (assert the message does not contain the input); `ADMIN_PASSWORD_RESET defaults to false and accepts "1"/"true"`; `MASTER_KEY_PREVIOUS optional, same validation`. Update the existing valid-env fixture in the file with the new vars.
- [ ] **Step 2: Run** `pnpm test test/config.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `envSchema` / `loadConfig`, reusing `parseMasterKey` from Task 1 inside a `transform`.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck` passes after updating every `loadConfig` caller fixture (e2e test env).
- [ ] **Step 5: Commit** `feat: add master key and admin seed configuration`.

### Task 3: Tenant store and passwords

**Files:**
- Create: `src/domain/ports/TenantStore.ts`, `src/infrastructure/auth/passwords.ts`, `src/infrastructure/tenants/sqliteTenantStore.ts`
- Modify: `src/infrastructure/auth/store.ts` (export `openAuthDatabase(path): DatabaseSync`; `createAuthStore(db: DatabaseSync, now?)`)
- Test: `test/infrastructure/auth/passwords.test.ts`, `test/infrastructure/tenants/sqliteTenantStore.test.ts`; update `test/infrastructure/auth/store.test.ts` to the new constructor.

**Interfaces:**
- Produces (`TenantStore.ts`):

  ```ts
  type TenantStatus = "invited" | "pairing" | "active" | "revoked";
  type Role = "admin" | "member";
  interface Tenant { id: string; wahaSession: string; displayName: string; status: TenantStatus; waId: string | null; createdAt: number }
  interface User { id: string; tenantId: string; username: string; role: Role; lastLoginAt: number | null }
  type LinkKind = "invite" | "reset";
  interface TenantStore {
    createTenant(q: { displayName: string; wahaSession: string; wrappedDek: string }): Tenant;
    getTenant(id: string): Tenant | null;
    listTenants(): Tenant[];
    getWrappedDek(id: string): string | null;
    setWrappedDek(id: string, wrapped: string): void;
    setStatus(id: string, status: TenantStatus): void;
    /** "taken" when another tenant already holds this WhatsApp id. */
    setWaId(id: string, waId: string): "ok" | "taken";
    /** Deletes tenant, its user and links. */
    deleteTenant(id: string): void;
    createUser(q: { tenantId: string; username: string; password: string; role: Role }): Promise<User | "username_taken">;
    /** Null on unknown user or wrong password; runs a dummy hash for unknown users. */
    verifyPassword(username: string, password: string): Promise<User | null>;
    setPassword(userId: string, password: string): Promise<void>;
    getUser(userId: string): User | null;
    getUserByTenant(tenantId: string): User | null;
    getAdmin(): User | null;
    touchLogin(userId: string): void;
    /** Invalidates earlier links of the same kind for the tenant. */
    issueLink(tenantId: string, kind: LinkKind, ttlMs: number): { token: string; expiresAt: number };
    peekLink(token: string, kind: LinkKind): { tenantId: string } | null;
    /** Atomic single use. */
    consumeLink(token: string, kind: LinkKind): { tenantId: string } | null;
  }
  ```
- `passwords.ts`: `hashPassword(pw: string): Promise<string>` (format `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`), `verifyPasswordHash(pw: string, stored: string): Promise<boolean>` (timing-safe).
- Tables per spec §6.1 plus `tenants.wa_id TEXT UNIQUE`, `users.last_login_at`, `invites.kind`.

- [ ] **Step 1: Write failing tests**: passwords — `verifies the right password, rejects a wrong one, two hashes of one password differ`. Store — `createUser returns "username_taken" for a duplicate`; `verifyPassword null for unknown user and wrong password`; `consumeLink works once` and `two concurrent consumeLink calls → exactly one non-null`; `expired link → null`; `issueLink invalidates the previous invite of that tenant`; `an invite token never consumes as a reset`; `setWaId returns "taken" for a waId held by another tenant`; `deleteTenant removes user and links`; DB stores no raw token (`SELECT hash FROM invites` ≠ token).
- [ ] **Step 2: Run** `pnpm test test/infrastructure/tenants test/infrastructure/auth` → FAIL.
- [ ] **Step 3: Implement**; tables created in the auth DB opened by `openAuthDatabase` (same 0600 handling as today).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add tenant store with users and single-use links`.

### Task 4: User-bound tokens and tenant-aware bearer guard

**Files:**
- Modify: `src/infrastructure/auth/store.ts`, `src/infrastructure/auth/bearer.ts`
- Test: `test/infrastructure/auth/store.test.ts`, new `test/infrastructure/auth/bearer.test.ts`

**Interfaces:**
- Consumes: `TenantStore` (Task 3).
- Produces:
  - `AuthorizationCodeData` gains `userId: string`; `issueTokens(clientId, scope, userId)`; `verifyAccessToken(token): { clientId; scope; userId } | null`; refresh rotation keeps `userId`; `revokeUser(userId: string): void` (clients, codes, tokens of that user); `revokeAll` kept for migration. `codes`/`tokens` gain `user_id`; `clients` gain `user_id` (nullable until the code is issued).
  - `AuthInfo = { clientId: string; scope: string; userId: string; tenantId: string; role: Role }`.
  - `bearerGuard({ store, tenants, publicBaseUrl })` — 401 `invalid_token` when the user is gone or its tenant status ≠ `active`.

- [ ] **Step 1: Write failing tests**: `refresh rotation keeps userId`; `revokeUser leaves other users' tokens valid`; guard — `sets AuthInfo with tenantId and role`; `401 for a token of a revoked tenant`; `401 after the user's tenant is deleted`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test test/infrastructure/auth` → PASS.
- [ ] **Step 5: Commit** `feat: bind tokens to users and resolve tenant in bearer guard`.

### Task 5: Encrypted cache and uploads

**Files:**
- Modify: `src/infrastructure/cache/sqliteMessageStore.ts`, `src/infrastructure/cache/sqliteTranscriptStore.ts`, `src/infrastructure/uploads/fsUploadStore.ts`
- Test: `test/infrastructure/cache/sqliteMessageStore.test.ts`, new `test/infrastructure/cache/sqliteTranscriptStore.test.ts`, `test/infrastructure/uploads/fsUploadStore.test.ts`

**Interfaces:**
- Consumes: `TenantCipher` (Task 1).
- Produces: `createSqliteMessageStore(db, cipher: TenantCipher)` (AAD `messages:<chatId>:<id>`), `createSqliteTranscriptStore(db, cipher, now?)` (AAD `transcripts:<chatId>:<messageId>`), `createFsUploadStore({ dir, ttlSeconds, maxBytes, cipher, now? })` (AAD `uploads:<id>`; `maxBytes` counts plaintext bytes).
- Rows whose value fails `isSealedText` are read as legacy plaintext (migration window only); writes always seal.

- [ ] **Step 1: Write failing tests**: `raw column on disk starts with "v1." and does not contain the message text`; `reads back the same messages`; `a store with another tenant's cipher cannot read rows` (throws `DecryptionError`); `a legacy plaintext row is still readable`; transcript equivalents; uploads — `the .bin file does not contain the uploaded bytes`, `read returns the original bytes`, `a tampered .bin reads as null`, `too_large still enforced at maxBytes`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Uploads: stream the body through a GCM cipher into `.part` (header `v1|nonce`, tag appended), check plaintext size while streaming; `read`/`claim` buffer and open the whole file.
- [ ] **Step 4: Run** `pnpm test test/infrastructure/cache test/infrastructure/uploads test/application` → PASS.
- [ ] **Step 5: Commit** `feat: encrypt cached messages, transcripts and uploads per tenant`.

### Task 6: Tenant-bound signed links

**Files:**
- Modify: `src/infrastructure/media/signedLink.ts`, `src/infrastructure/uploads/uploadLinks.ts`
- Test: `test/infrastructure/media/signedLink.test.ts`, `test/infrastructure/uploads/uploadLinks.test.ts`

**Interfaces:**
- Produces: `createSignedLinks({ secret, ttlSeconds, tenantId, now? })` — payload `{ m, e, t }`; `verify` returns the id only when `t === tenantId`. `createUploadLinks(mediaSecret, ttlSeconds, tenantId)`. `peekLinkTenant(token: string): string | null` — reads `t` from the unverified payload (routing only; authentication stays in `verify`). The `SignedLinks` interface used by tools is unchanged.

- [ ] **Step 1: Write failing tests**: `a link issued for tenant A does not verify with tenant B's links`; `peekLinkTenant returns A`; `a payload edited to t=B fails verify on B` (signature mismatch); existing tests updated with a `tenantId`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test test/infrastructure/media test/infrastructure/uploads` → PASS.
- [ ] **Step 5: Commit** `feat: bind media and upload links to a tenant`.

### Task 7: Tenant registry and runtime

**Files:**
- Create: `src/infrastructure/tenants/runtime.ts`, `src/infrastructure/tenants/registry.ts`
- Modify: `src/infrastructure/waha/WahaHttpGateway.ts`, `src/domain/errors.ts`, `src/infrastructure/mcp/defineTool.ts`
- Test: `test/infrastructure/tenants/registry.test.ts`, `test/infrastructure/waha/WahaHttpGateway.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 5, 6.
- Produces:

  ```ts
  interface TenantRuntime {
    tenantId: string;
    context: Omit<ToolRunContext, "mediaIdleTimeoutMs">; // gateway, mapper, config, links, transcription, sender, uploads, uploadLinks
    media(token: string): Promise<Response>;
    upload(req: Request, token: string): Promise<Response>;
    close(): void;
  }
  function buildTenantRuntime(deps: { config: Config; tenant: Tenant; dek: Buffer; mediaSecret: Uint8Array; logger: Logger }): TenantRuntime;
  interface TenantRegistry {
    /** Null when the tenant does not exist or is not active. Caller must call release(). */
    acquire(tenantId: string): { runtime: TenantRuntime; release(): void } | null;
    evict(tenantId: string): void;
    closeAll(): void;
  }
  function createTenantRegistry(deps: { config: Config; tenants: TenantStore; kek: Buffer; mediaSecret: Uint8Array; logger: Logger; maxOpen?: number /* default 32 */; build?: typeof buildTenantRuntime }): TenantRegistry;
  ```

  `buildTenantRuntime` is the per-tenant part of today's `main.ts` (gateway, cached gateway, transcription, sender, uploads in `DATA_DIR/tenants/<id>/uploads`, cache in `DATA_DIR/tenants/<id>/cache.db`, per-tenant links, media and upload handlers).
  - `WhatsAppDisconnectedError` in `src/domain/errors.ts`; the gateway throws it when WAHA answers that the session is not `WORKING` (verify the exact status code/body on the instance — WAHA uses 422 for this). `defineTool` maps it to: `WhatsApp is disconnected for this account. Re-pair at <PUBLIC_BASE_URL>/pair.`

- [ ] **Step 1: Write failing tests**: `acquire builds once and reuses`; `acquire returns null for a revoked or unknown tenant`; `LRU over maxOpen evicts the least recent and closes it`; `an evicted runtime with an unreleased acquire is closed only after release` (Review Focus 3); `evict closes the runtime`; gateway — `not-WORKING response → WhatsAppDisconnectedError`; defineTool — message contains `/pair` and no API key.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (refcount per runtime). **Step 4: Run** `pnpm test test/infrastructure` → PASS.
- [ ] **Step 5: Commit** `feat: add per-tenant runtime registry`.

### Task 8: WAHA session administration

**Files:**
- Create: `src/domain/ports/SessionAdmin.ts`, `src/infrastructure/waha/WahaSessionAdmin.ts`, `test/fakes/FakeSessionAdmin.ts`
- Test: `test/infrastructure/waha/WahaSessionAdmin.test.ts`

**Interfaces:**
- Produces:

  ```ts
  type SessionState = "STOPPED" | "STARTING" | "SCAN_QR_CODE" | "WORKING" | "FAILED" | "UNKNOWN";
  interface SessionAdmin {
    create(name: string): Promise<void>;          // creates and starts
    state(name: string): Promise<SessionState>;
    qr(name: string): Promise<{ mimetype: string; base64: string } | null>; // null unless SCAN_QR_CODE
    me(name: string): Promise<{ id: string } | null>;
    logout(name: string): Promise<void>;
    remove(name: string): Promise<void>;          // idempotent: 404 is success
  }
  function createWahaSessionAdmin(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): SessionAdmin;
  ```

  `FakeSessionAdmin` keeps states in memory and lets tests set `state`/`me` per session.

- [ ] **Step 0: Verify** the endpoints against the instance (`/api/version` shows Plus; `POST /api/sessions`, `GET /api/sessions/{name}`, `GET /api/{name}/auth/qr`, `GET /api/sessions/{name}/me`, `POST /api/sessions/{name}/logout`, `DELETE /api/sessions/{name}`) and record the result in the commit message body. Needs the owner's authorization to call the live instance.
- [ ] **Step 1: Write failing tests** with a stub `fetch`: request paths, `X-Api-Key` header, `remove` treats 404 as success, unknown WAHA status maps to `UNKNOWN`, errors never include the API key.
- [ ] **Step 2–4:** run FAIL → implement → `pnpm test test/infrastructure/waha` PASS.
- [ ] **Step 5: Commit** `feat: add WAHA session administration client`.

### Task 9: Username/password OAuth login and onboarding pages

**Files:**
- Modify: `src/infrastructure/auth/oauth.ts`, `src/infrastructure/auth/loginPage.ts`
- Create: `src/infrastructure/tenants/onboardingRoutes.ts`, `src/infrastructure/tenants/onboardingPages.ts`
- Test: `test/infrastructure/auth/oauth.test.ts`, `test/infrastructure/tenants/onboardingRoutes.test.ts`

**Interfaces:**
- Consumes: `TenantStore`, `AuthStore.revokeUser`, `SessionAdmin`, `LoginLimiter`.
- Produces:
  - `createOAuthRoutes({ store, tenants, publicBaseUrl, limiter })` — login form fields `username`, `password`; success only when the user's tenant is `active`; `touchLogin`; limiter keyed per IP and per username. `/logout` (username + password) calls `revokeUser` for that user only.
  - `createOnboardingRoutes({ tenants, auth: AuthStore, sessions: SessionAdmin, cookieSecret: Uint8Array, publicBaseUrl, limiter, now? }): Hono` with:
    - `GET/POST /invite/:token` — choose username + password; atomic `consumeLink(token,"invite")`; creates member user; tenant → `pairing`; sets pairing cookie; redirects to `/pair`. Page includes, verbatim: `The administrator of this server can technically access your WhatsApp data. Only continue if you trust them.`
    - `GET/POST /reset/:token` — new password; `consumeLink(token,"reset")`; `setPassword`; `revokeUser`.
    - `GET/POST /pair` — login with username + password (rate limited) or valid cookie; shows the QR as a data-URI `<img>` with `<meta http-equiv="refresh" content="5">` while `SCAN_QR_CODE`; when `WORKING`: `setWaId(me.id)` → `"taken"` ⇒ `logout` the session and show `This WhatsApp number is already connected to another account.`; `"ok"` ⇒ status `active` (unless `revoked`) and show a done page.
    - Pairing cookie: HMAC-signed `{ u: userId, e }`, 15 min, `HttpOnly; Secure; SameSite=Strict; Path=/pair`.
    - Pages use `HTML_SECURITY_HEADERS`; the `/pair` page CSP adds `img-src data:`.

- [ ] **Step 1: Write failing tests**: OAuth — `login with username/password issues a code bound to the user`; `wrong password → 401 page`; `user of a pairing tenant cannot log in`; `logout revokes only that user`. Onboarding — `invite creates the user and moves tenant to pairing`; `second POST of the same invite → "This link was already used."` (and two concurrent POSTs → one user, Review Focus 4); `expired invite → 404 page`; `password under 12 chars re-renders with an error`; `pair shows QR while SCAN_QR_CODE`; `pair WORKING with a free waId → tenant active`; `pair WORKING with a taken waId → session logged out, tenant stays pairing`; `reset changes the password and revokes old tokens`; pages contain the trust sentence and never the WAHA API key.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test test/infrastructure` PASS.
- [ ] **Step 5: Commit** `feat: per-user login, invite, reset and pairing pages`.

### Task 10: Admin service and admin tools

**Files:**
- Create: `src/application/tenantAdmin.ts`, `src/infrastructure/mcp/tools/admin/{createInvite,listTenants,revokeTenant,restoreTenant,resetPassword,deleteTenant,index}.ts`
- Modify: `src/infrastructure/mcp/defineTool.ts` (`ToolRunContext` gains `admin: TenantAdmin | null`)
- Test: `test/application/tenantAdmin.test.ts`

**Interfaces:**
- Consumes: `TenantStore`, `AuthStore.revokeUser`, `SessionAdmin`, `TenantRegistry.evict`, envelope `generateDek`/`wrapDek`.
- Produces:

  ```ts
  interface TenantAdmin {
    createInvite(q: { displayName?: string; tenantId?: string }): Promise<{ tenantId: string; url: string; expiresAt: string }>;
    listTenants(): Promise<Array<{ id; displayName; status; whatsapp: SessionState; createdAt: string; lastLoginAt: string | null; isAdmin: boolean }>>;
    revoke(tenantId: string): void; restore(tenantId: string): void;
    resetPassword(tenantId: string): { url: string; expiresAt: string };
    delete(tenantId: string, confirmDisplayName: string): Promise<void>;
  }
  function createTenantAdmin(deps: { tenants; auth; sessions; registry; kek: Buffer; dataDir: string; publicBaseUrl: string; logger; now? }): TenantAdmin;
  ```

  Tools: `create_invite({ display_name?, tenant_id? })` (exactly one), `list_tenants()`, `revoke_tenant({ tenant_id })`, `restore_tenant({ tenant_id })`, `reset_password({ tenant_id })`, `delete_tenant({ tenant_id, confirm_display_name })`. Annotations: `delete_tenant` destructive; list read-only.
  Rules: re-issue only for a tenant with no user (else `InvalidInputError("This tenant already has a user; use reset_password.")`); admin tenant refused by revoke/restore/delete (`InvalidInputError("The admin tenant cannot be revoked, restored or deleted.")`); delete requires exact display name; delete order per spec §6.4 (row + DEK, `revokeUser`, registry `evict`, WAHA `logout`+`remove`, `rm -r DATA_DIR/tenants/<id>`); every call logs `admin <tool> tenant=<id> outcome=<ok|error>`.

- [ ] **Step 1: Write failing tests** (fakes for sessions and registry): invite creates tenant `invited`, WAHA session `t_[a-z2-7]{10}`, URL `<base>/invite/<token>`; re-issue invalidates the old link; re-issue refused when a user exists; revoke makes `acquire` null and revokes tokens; admin tenant protected on all three; delete with wrong name refused and nothing deleted; delete removes directory, row and WAHA session; `listTenants` output has no message content fields.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test test/application` PASS.
- [ ] **Step 5: Commit** `feat: add admin tenant management tools`.

### Task 11: Composition, migration and release

**Files:**
- Modify: `src/main.ts`, `src/infrastructure/mcp/server.ts`, `src/infrastructure/http/app.ts`, `src/infrastructure/mcp/instructions.ts`, `README.md`, `package.json`
- Create: `src/infrastructure/tenants/migrate.ts`
- Test: `test/infrastructure/tenants/migrate.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `createMcpServer({ tools, adminTools, instructions, config, registry, admin, logger })` — the `createMcpHandler` factory reads the request's `authInfo` from its `McpRequestContext` (verify the field name in `@modelcontextprotocol/server` v2), acquires the tenant runtime, registers `tools` with its context and `adminTools` only when `role === "admin"`, releases on response end. `handler(req, { authInfo })` passes the full `AuthInfo`.
  - `createApp` mounts onboarding routes; `/media/:token` and `/upload/:token` route by `peekLinkTenant` → `registry.acquire` → `runtime.media/upload`, 404 when null.
  - `migrateToMultiTenant(deps: { authDb; tenants; auth; config; kek; dataDir; sessions; logger }): Promise<void>` — idempotent, recorded as `meta.multi_tenant = "1"`: seed tenant #1 (`waha_session = WAHA_SESSION`, `active`, admin user from `ADMIN_USERNAME`/`ADMIN_PASSWORD`, `wa_id` from `sessions.me`, null if unreachable); move `DATA_DIR/cache.db{,-wal,-shm}` and `DATA_DIR/uploads` into `DATA_DIR/tenants/<id>/`; seal every non-`v1.` `messages.raw` and `transcripts.text` in batches of 500, one transaction per batch; `auth.revokeAll()` once. Every start: `ADMIN_PASSWORD_RESET` ⇒ `setPassword(admin)`; unwrap every DEK with `MASTER_KEY`, else with `MASTER_KEY_PREVIOUS` and rewrap; if neither opens one, throw `Error("MASTER_KEY does not match the stored tenant keys.")`.
  - `SERVER_VERSION = "0.4.0"`; startup log adds `tenants: <n>`, drops `session:`.

- [ ] **Step 1: Write failing tests**: migration on a copy of a 0.3.0-shaped `DATA_DIR` (built in `mktemp -d`) — cache moved, rows sealed, old tokens revoked, admin can log in; running it twice changes nothing (hash of auth.db and cache.db unchanged); a crash mid-pass (throw after first batch) resumes and finishes; wrong `MASTER_KEY` → that exact error and no files changed; `MASTER_KEY_PREVIOUS` rewraps.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test` PASS, `pnpm typecheck` and `pnpm lint` clean.
- [ ] **Step 5: Docs:** README — new env vars, multi-tenant section, threat model sentence from spec §6.4, operational requirements §6.7 (move WAHA to internal network, back up `MASTER_KEY` offline, transcription billed to admin), admin tools list.
- [ ] **Step 6: Commit** `feat: compose multi-tenant server and migrate 0.3.0 data` and `docs: document multi-tenant setup and release 0.4.0`.

### Task 12: End-to-end isolation

**Files:**
- Modify: `test/e2e/mcp-client.test.ts` (or create `test/e2e/multi-tenant.test.ts` reusing its harness)

**Interfaces:**
- Consumes: the composed app with two tenants on two `InMemoryWahaGateway` instances (inject via `TenantRegistry.build`) and `FakeSessionAdmin`.

- [ ] **Step 1: Write tests**: admin `tools/list` includes the six admin tools, member's has none and a direct `tools/call` of `list_tenants` as member fails; member B `get_messages` with a chat id that exists only in A → not found, A's gateway untouched; member B `get_media` with A's media id → not found; a media link of A with `t` edited to B → 404; send tools of B hit only B's `RecordingSender`; after `revoke_tenant(B)` B's `/mcp` → 401 and B's existing media/upload links → 404; full invite → pair → OAuth login → `list_chats` flow for a new tenant.
- [ ] **Step 2: Run** `pnpm test test/e2e` → PASS (fix the owning task's code if a test fails, not the test).
- [ ] **Step 3: Commit** `test: cover cross-tenant isolation end to end`.
