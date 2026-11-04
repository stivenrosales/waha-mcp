import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  LinkKind,
  Role,
  Tenant,
  TenantStatus,
  TenantStore,
  User,
} from "../../domain/ports/TenantStore.js";
import { hashPassword, verifyPasswordHash } from "../auth/passwords.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  waha_session TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('invited', 'pairing', 'active', 'revoked')),
  wa_id TEXT UNIQUE,
  wrapped_dek TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS invites (
  hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
/** 128 random bits, base64url: unguessable and not tied to any tenant data. */
const newId = (): string => randomBytes(16).toString("base64url");

interface TenantRow {
  id: string;
  waha_session: string;
  display_name: string;
  status: TenantStatus;
  wa_id: string | null;
  created_at: number;
}
interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  role: Role;
  last_login_at: number | null;
}

const toTenant = (r: TenantRow): Tenant => ({
  id: r.id,
  wahaSession: r.waha_session,
  displayName: r.display_name,
  status: r.status,
  waId: r.wa_id,
  createdAt: Number(r.created_at),
});
const toUser = (r: UserRow): User => ({
  id: r.id,
  tenantId: r.tenant_id,
  username: r.username,
  role: r.role,
  lastLoginAt: r.last_login_at === null ? null : Number(r.last_login_at),
});

const TENANT_COLS = "id, waha_session, display_name, status, wa_id, created_at";
const USER_COLS = "id, tenant_id, username, role, last_login_at";

/**
 * Tenants, their user and single-use links, stored in the auth database.
 * The caller owns `db` (see `openAuthDatabase`).
 * @param now clock in epoch milliseconds (injectable for tests).
 */
export function createSqliteTenantStore(
  db: DatabaseSync,
  now: () => number = Date.now,
): TenantStore {
  db.exec(SCHEMA);

  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  let dummyHash: Promise<string> | undefined;
  const getDummyHash = (): Promise<string> => {
    dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    return dummyHash;
  };

  const usernameExists = (username: string): boolean =>
    db.prepare("SELECT 1 FROM users WHERE username = ?").get(username) !== undefined;

  return {
    createTenant({ displayName, wahaSession, wrappedDek }) {
      const id = newId();
      db.prepare(
        `INSERT INTO tenants (id, waha_session, display_name, status, wrapped_dek, created_at)
         VALUES (?, ?, ?, 'invited', ?, ?)`,
      ).run(id, wahaSession, displayName, wrappedDek, now());
      return this.getTenant(id) as Tenant;
    },

    getTenant(id) {
      const row = db.prepare(`SELECT ${TENANT_COLS} FROM tenants WHERE id = ?`).get(id) as
        | TenantRow
        | undefined;
      return row ? toTenant(row) : null;
    },

    listTenants() {
      const rows = db
        .prepare(`SELECT ${TENANT_COLS} FROM tenants ORDER BY created_at, rowid`)
        .all() as unknown as TenantRow[];
      return rows.map(toTenant);
    },

    getWrappedDek(id) {
      const row = db.prepare("SELECT wrapped_dek FROM tenants WHERE id = ?").get(id) as
        | { wrapped_dek: string }
        | undefined;
      return row ? row.wrapped_dek : null;
    },

    setWrappedDek(id, wrapped) {
      db.prepare("UPDATE tenants SET wrapped_dek = ? WHERE id = ?").run(wrapped, id);
    },

    setStatus(id, status) {
      db.prepare("UPDATE tenants SET status = ? WHERE id = ?").run(status, id);
    },

    setWaId(id, waId) {
      return transaction(() => {
        const holder = db
          .prepare("SELECT id FROM tenants WHERE wa_id = ? AND id <> ?")
          .get(waId, id);
        if (holder) return "taken";
        db.prepare("UPDATE tenants SET wa_id = ? WHERE id = ?").run(waId, id);
        return "ok";
      });
    },

    deleteTenant(id) {
      transaction(() => {
        db.prepare("DELETE FROM invites WHERE tenant_id = ?").run(id);
        db.prepare("DELETE FROM users WHERE tenant_id = ?").run(id);
        db.prepare("DELETE FROM tenants WHERE id = ?").run(id);
      });
    },

    async createUser({ tenantId, username, password, role }) {
      const passwordHash = await hashPassword(password);
      const id = newId();
      try {
        db.prepare(
          `INSERT INTO users (id, tenant_id, username, password_hash, role, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, tenantId, username, passwordHash, role, now());
      } catch (error) {
        if (usernameExists(username)) return "username_taken";
        throw error;
      }
      return this.getUser(id) as User;
    },

    async verifyPassword(username, password) {
      const row = db
        .prepare(`SELECT ${USER_COLS}, password_hash FROM users WHERE username = ?`)
        .get(username) as (UserRow & { password_hash: string }) | undefined;
      if (!row) {
        // Spend the same hashing time as a real check so unknown users are not distinguishable.
        await verifyPasswordHash(password, await getDummyHash());
        return null;
      }
      return (await verifyPasswordHash(password, row.password_hash)) ? toUser(row) : null;
    },

    async setPassword(userId, password) {
      const passwordHash = await hashPassword(password);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
    },

    getUser(userId) {
      const row = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId) as
        | UserRow
        | undefined;
      return row ? toUser(row) : null;
    },

    getUserByTenant(tenantId) {
      const row = db.prepare(`SELECT ${USER_COLS} FROM users WHERE tenant_id = ?`).get(tenantId) as
        | UserRow
        | undefined;
      return row ? toUser(row) : null;
    },

    getAdmin() {
      const row = db
        .prepare(
          `SELECT ${USER_COLS} FROM users WHERE role = 'admin' ORDER BY created_at, rowid LIMIT 1`,
        )
        .get() as UserRow | undefined;
      return row ? toUser(row) : null;
    },

    touchLogin(userId) {
      db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), userId);
    },

    issueLink(tenantId, kind, ttlMs) {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      transaction(() => {
        db.prepare("DELETE FROM invites WHERE tenant_id = ? AND kind = ?").run(tenantId, kind);
        db.prepare(
          "INSERT INTO invites (hash, tenant_id, kind, expires_at) VALUES (?, ?, ?, ?)",
        ).run(sha256(token), tenantId, kind, expiresAt);
      });
      return { token, expiresAt };
    },

    peekLink(token: string, kind: LinkKind) {
      const row = db
        .prepare(
          `SELECT tenant_id FROM invites
           WHERE hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .get(sha256(token), kind, now()) as { tenant_id: string } | undefined;
      return row ? { tenantId: row.tenant_id } : null;
    },

    consumeLink(token: string, kind: LinkKind) {
      return transaction(() => {
        const row = db
          .prepare(
            `UPDATE invites SET used_at = ?
             WHERE hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?
             RETURNING tenant_id`,
          )
          .get(now(), sha256(token), kind, now()) as { tenant_id: string } | undefined;
        return row ? { tenantId: row.tenant_id } : null;
      });
    },
  };
}
