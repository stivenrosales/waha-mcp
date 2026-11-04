import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../../config.js";
import type { SessionAdmin } from "../../domain/ports/SessionAdmin.js";
import type { Tenant, TenantStore } from "../../domain/ports/TenantStore.js";
import type { AuthStore } from "../auth/store.js";
import {
  inTransaction,
  messageAad,
  openCacheDatabase,
  transcriptAad,
} from "../cache/sqliteMessageStore.js";
import {
  createTenantCipher,
  generateDek,
  isSealedText,
  type TenantCipher,
  unwrapDek,
  wrapDek,
} from "../crypto/envelope.js";
import type { Logger } from "../mcp/defineTool.js";

export const WRONG_MASTER_KEY_MESSAGE = "MASTER_KEY does not match the stored tenant keys.";

const MIGRATED_KEY = "multi_tenant";
const BATCH_SIZE = 500;
/** Side files first, the database last: a crash in between leaves no database without its WAL. */
const CACHE_FILES = ["cache.db-wal", "cache.db-shm", "cache.db"];

export interface MigrateDeps {
  /** The auth database; its `meta` table records the migration. */
  authDb: DatabaseSync;
  tenants: TenantStore;
  auth: Pick<AuthStore, "revokeAll">;
  config: Config;
  /** `MASTER_KEY`. */
  kek: Buffer;
  dataDir: string;
  sessions: SessionAdmin;
  logger: Logger;
  /** Test seam: called after each committed batch of sealed rows. */
  onBatch?: () => void;
}

/**
 * Runs on every start, before anything is served.
 *
 * 1. Every tenant key must open with `MASTER_KEY` (or `MASTER_KEY_PREVIOUS`, then it is rewrapped
 *    under `MASTER_KEY`). If one opens with neither, it throws {@link WRONG_MASTER_KEY_MESSAGE}
 *    before anything is written.
 * 2. Once (recorded as `meta.multi_tenant = "1"`, resumable after a crash): seeds tenant #1 for
 *    `WAHA_SESSION` with the admin user, moves the 0.3.0 `DATA_DIR/cache.db` into
 *    `DATA_DIR/tenants/<id>/`, seals its plaintext rows in batches, deletes the 0.3.0 uploads
 *    (plaintext, 15-minute slots) and revokes every OAuth client and token.
 * 3. `ADMIN_PASSWORD_RESET` overwrites the admin's password with `ADMIN_PASSWORD`.
 */
export async function migrateToMultiTenant(deps: MigrateDeps): Promise<void> {
  const { authDb, tenants, config, logger } = deps;
  checkTenantKeys(deps);

  authDb.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const migrated =
    (
      authDb.prepare("SELECT value FROM meta WHERE key = ?").get(MIGRATED_KEY) as
        | { value: string }
        | undefined
    )?.value === "1";

  let seeded = false;
  if (!migrated) {
    const { tenant, created } = await seedAdmin(deps);
    seeded = created;
    moveLegacyFiles(deps.dataDir, tenant.id);
    sealLegacyRows(deps, tenant.id);
    deps.auth.revokeAll();
    authDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')").run(MIGRATED_KEY);
    logger.info("migration: 0.4.0 multi-tenant layout ready; existing OAuth sessions revoked");
  }

  const admin = tenants.getAdmin();
  if (admin && config.adminPasswordReset && !seeded) {
    await tenants.setPassword(admin.id, config.adminPassword);
    logger.info("admin password reset from ADMIN_PASSWORD");
  }
}

/** Unwraps every stored key; rewraps (after checking all of them) those that needed the old one. */
function checkTenantKeys(deps: MigrateDeps): void {
  const previous = deps.config.masterKeyPrevious;
  const rewrap: { id: string; wrapped: string }[] = [];
  for (const tenant of deps.tenants.listTenants()) {
    const wrapped = deps.tenants.getWrappedDek(tenant.id);
    // A placeholder left by a crash between createTenant and setWrappedDek protects no data.
    if (wrapped === null || !isSealedText(wrapped)) continue;
    if (opens(deps.kek, wrapped, tenant.id)) continue;
    const dek = previous ? tryUnwrap(previous, wrapped, tenant.id) : null;
    if (!dek) throw new Error(WRONG_MASTER_KEY_MESSAGE);
    rewrap.push({ id: tenant.id, wrapped: wrapDek(deps.kek, dek, tenant.id) });
  }
  for (const { id, wrapped } of rewrap) deps.tenants.setWrappedDek(id, wrapped);
  if (rewrap.length > 0)
    deps.logger.info(`master key: rewrapped ${rewrap.length} tenant key(s) under MASTER_KEY`);
}

function tryUnwrap(kek: Buffer, wrapped: string, tenantId: string): Buffer | null {
  try {
    return unwrapDek(kek, wrapped, tenantId);
  } catch {
    return null;
  }
}

const opens = (kek: Buffer, wrapped: string, tenantId: string): boolean =>
  tryUnwrap(kek, wrapped, tenantId) !== null;

/** Tenant #1 and its admin user; picks up a half-done seed after a crash. */
async function seedAdmin(deps: MigrateDeps): Promise<{ tenant: Tenant; created: boolean }> {
  const { tenants, config, sessions, logger, kek } = deps;
  const existingAdmin = tenants.getAdmin();
  let tenant =
    (existingAdmin && tenants.getTenant(existingAdmin.tenantId)) ||
    tenants.listTenants().find((t) => t.wahaSession === config.wahaSession) ||
    null;
  if (!tenant)
    tenant = tenants.createTenant({
      displayName: config.adminUsername,
      wahaSession: config.wahaSession,
      wrappedDek: "pending",
    });
  const wrapped = tenants.getWrappedDek(tenant.id);
  if (wrapped === null || !isSealedText(wrapped))
    tenants.setWrappedDek(tenant.id, wrapDek(kek, generateDek(), tenant.id));
  if (tenant.status !== "active") tenants.setStatus(tenant.id, "active");

  let created = false;
  if (!existingAdmin) {
    const user = await tenants.createUser({
      tenantId: tenant.id,
      username: config.adminUsername,
      password: config.adminPassword,
      role: "admin",
    });
    if (user === "username_taken") throw new Error("ADMIN_USERNAME is already taken.");
    created = true;
  }

  if (tenant.waId === null) {
    const me = await sessions.me(tenant.wahaSession).catch(() => null);
    if (me) tenants.setWaId(tenant.id, me.id);
  }
  logger.info(`migration: admin tenant ${tenant.id} ready`);
  return { tenant: tenants.getTenant(tenant.id) as Tenant, created };
}

/** Moves the 0.3.0 cache into the tenant directory and drops the 0.3.0 uploads. */
function moveLegacyFiles(dataDir: string, tenantId: string): void {
  const dir = join(dataDir, "tenants", tenantId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const name of CACHE_FILES) {
    const from = join(dataDir, name);
    const to = join(dir, name);
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  }
  // 0.3.0 stored uploads in plaintext and they expire after 15 minutes: delete, do not carry.
  rmSync(join(dataDir, "uploads"), { recursive: true, force: true });
}

/** Seals every plaintext `messages.raw` and `transcripts.text`, one transaction per batch. */
function sealLegacyRows(deps: MigrateDeps, tenantId: string): void {
  const file = join(deps.dataDir, "tenants", tenantId, "cache.db");
  if (!existsSync(file)) return;
  const wrapped = deps.tenants.getWrappedDek(tenantId) as string;
  const cipher = createTenantCipher(unwrapDek(deps.kek, wrapped, tenantId), tenantId);
  const db = openCacheDatabase(file);
  try {
    const messages = sealTable(db, cipher, deps.onBatch, {
      table: "messages",
      idColumn: "id",
      valueColumn: "raw",
      aad: messageAad,
    });
    const transcripts = sealTable(db, cipher, deps.onBatch, {
      table: "transcripts",
      idColumn: "message_id",
      valueColumn: "text",
      aad: transcriptAad,
    });
    deps.logger.info(`migration: sealed ${messages} message(s), ${transcripts} transcript(s)`);
  } finally {
    db.close();
  }
}

function sealTable(
  db: DatabaseSync,
  cipher: TenantCipher,
  onBatch: (() => void) | undefined,
  t: {
    table: string;
    idColumn: string;
    valueColumn: string;
    aad: (chatId: string, id: string) => string;
  },
): number {
  const select = db.prepare(
    `SELECT rowid AS r, chat_id AS chatId, ${t.idColumn} AS id, ${t.valueColumn} AS value
     FROM ${t.table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const update = db.prepare(`UPDATE ${t.table} SET ${t.valueColumn} = ? WHERE rowid = ?`);
  let after = 0;
  let sealed = 0;
  for (;;) {
    const rows = select.all(after, BATCH_SIZE) as {
      r: number;
      chatId: string;
      id: string;
      value: string;
    }[];
    if (rows.length === 0) return sealed;
    after = Number(rows[rows.length - 1]?.r);
    const plain = rows.filter((row) => !isSealedText(row.value));
    if (plain.length === 0) continue;
    inTransaction(db, () => {
      for (const row of plain)
        update.run(cipher.sealText(row.value, t.aad(row.chatId, row.id)), row.r);
    });
    sealed += plain.length;
    onBatch?.();
  }
}
