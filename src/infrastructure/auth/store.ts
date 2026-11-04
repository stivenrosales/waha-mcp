import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
/** A registered client with no live token is dropped after this long. */
const STALE_CLIENT_MS = 24 * 3600 * 1000;

export interface AuthorizationCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  userId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthStore {
  registerClient(c: { redirectUris: string[]; clientName?: string }): { clientId: string };
  getClient(clientId: string): { clientId: string; redirectUris: string[] } | null;
  countClients(): number;
  /** Deletes clients older than 24 h that hold no live token or pending code; returns how many. */
  pruneStaleClients(): number;
  /**
   * Binds the stored sessions to the current WAHA API key (only its sha256 is kept). When the key
   * differs from the one seen before, every client, code and token is revoked and `true` is returned.
   */
  syncApiKey(apiKey: string): boolean;
  /**
   * Returns the raw code (valid for 60 s). A client is bound to the first user that obtains a code
   * on it; a code for another user is refused with `null` and nothing is stored.
   */
  saveCode(c: AuthorizationCodeData): string | null;
  /** Single use: the code is deleted atomically as it is read. */
  consumeCode(code: string): AuthorizationCodeData | null;
  issueTokens(clientId: string, scope: string, userId: string): IssuedTokens;
  verifyAccessToken(token: string): { clientId: string; scope: string; userId: string } | null;
  /** Single use: the old refresh token is deleted atomically; bound to `clientId`. */
  rotateRefreshToken(token: string, clientId: string): IssuedTokens | null;
  /** Removes the clients, codes and tokens of one user; other users are untouched. */
  revokeUser(userId: string): void;
  /** Removes every client, code and token (migrations, legacy logout). */
  revokeAll(): void;
  /** Closes the database; the store must not be used afterwards. */
  close(): void;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const randomToken = (): string => randomBytes(32).toString("base64url");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name TEXT,
  created_at INTEGER NOT NULL,
  user_id TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  user_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  user_id TEXT NOT NULL
);
`;

/**
 * Databases created before multi-tenancy lack `user_id`. Codes and tokens issued back then belong
 * to no user, so they are dropped (the 0.4.0 migration revokes them anyway); clients keep a NULL.
 */
function migrateUserColumns(db: DatabaseSync): void {
  for (const table of ["clients", "codes", "tokens"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "user_id"))
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
  }
  db.exec("DELETE FROM codes WHERE user_id IS NULL");
  db.exec("DELETE FROM tokens WHERE user_id IS NULL");
}

/** Opens the auth database (WAL, busy timeout) and keeps its files private to the owner. */
export function openAuthDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  if (dbPath !== ":memory:") {
    // The database holds token and password hashes: keep it, and its WAL side files, private.
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
      if (existsSync(file)) chmodSync(file, 0o600);
  }
  return db;
}

/**
 * @param db handle from {@link openAuthDatabase}; the store owns it and closes it on `close()`.
 * @param now clock in epoch milliseconds (injectable for tests).
 */
export function createAuthStore(db: DatabaseSync, now: () => number = Date.now): AuthStore {
  db.exec(SCHEMA);
  migrateUserColumns(db);

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

  const purgeExpired = (): void => {
    const t = now();
    db.prepare("DELETE FROM codes WHERE expires_at <= ?").run(t);
    db.prepare("DELETE FROM tokens WHERE expires_at <= ?").run(t);
  };

  const insertToken = (
    kind: "access" | "refresh",
    clientId: string,
    scope: string,
    userId: string,
    ttlS: number,
  ) => {
    const raw = randomToken();
    db.prepare(
      "INSERT INTO tokens (hash, kind, client_id, scope, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sha256(raw), kind, clientId, scope, userId, now() + ttlS * 1000);
    return raw;
  };

  const mintPair = (clientId: string, scope: string, userId: string): IssuedTokens => ({
    accessToken: insertToken("access", clientId, scope, userId, ACCESS_TTL_S),
    refreshToken: insertToken("refresh", clientId, scope, userId, REFRESH_TTL_S),
    expiresIn: ACCESS_TTL_S,
  });

  return {
    registerClient({ redirectUris, clientName }) {
      const clientId = randomToken();
      db.prepare(
        "INSERT INTO clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)",
      ).run(clientId, JSON.stringify(redirectUris), clientName ?? null, now());
      return { clientId };
    },

    getClient(clientId) {
      const row = db
        .prepare("SELECT redirect_uris FROM clients WHERE client_id = ?")
        .get(clientId) as { redirect_uris: string } | undefined;
      if (!row) return null;
      return { clientId, redirectUris: JSON.parse(row.redirect_uris) as string[] };
    },

    countClients() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number };
      return Number(row.n);
    },

    pruneStaleClients() {
      const t = now();
      const result = db
        .prepare(
          `DELETE FROM clients
           WHERE created_at < ?
             AND client_id NOT IN (SELECT client_id FROM tokens WHERE expires_at > ?)
             AND client_id NOT IN (SELECT client_id FROM codes WHERE expires_at > ?)`,
        )
        .run(t - STALE_CLIENT_MS, t, t);
      return Number(result.changes);
    },

    syncApiKey(apiKey) {
      const hash = sha256(apiKey);
      return transaction(() => {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'api_key_hash'").get() as
          | { value: string }
          | undefined;
        if (row?.value === hash) return false;
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('api_key_hash', ?)").run(hash);
        if (row === undefined) return false; // first run: nothing was issued against another key
        db.exec("DELETE FROM tokens");
        db.exec("DELETE FROM codes");
        db.exec("DELETE FROM clients");
        return true;
      });
    },

    saveCode(c) {
      return transaction(() => {
        purgeExpired();
        // First user wins: a client shared by two users would let revokeUser(B) remove A's client.
        const bound = db
          .prepare(
            "UPDATE clients SET user_id = ? WHERE client_id = ? AND (user_id IS NULL OR user_id = ?)",
          )
          .run(c.userId, c.clientId, c.userId);
        if (Number(bound.changes) === 0) return null;
        const code = randomToken();
        db.prepare(
          `INSERT INTO codes (hash, client_id, redirect_uri, code_challenge, scope, resource, user_id, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sha256(code),
          c.clientId,
          c.redirectUri,
          c.codeChallenge,
          c.scope,
          c.resource,
          c.userId,
          now() + CODE_TTL_MS,
        );
        return code;
      });
    },

    consumeCode(code) {
      const row = db
        .prepare(
          `DELETE FROM codes WHERE hash = ? AND expires_at > ?
           RETURNING client_id, redirect_uri, code_challenge, scope, resource, user_id`,
        )
        .get(sha256(code), now()) as
        | {
            client_id: string;
            redirect_uri: string;
            code_challenge: string;
            scope: string;
            resource: string | null;
            user_id: string;
          }
        | undefined;
      if (!row) return null;
      return {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
        userId: row.user_id,
      };
    },

    issueTokens(clientId, scope, userId) {
      return transaction(() => {
        purgeExpired();
        return mintPair(clientId, scope, userId);
      });
    },

    verifyAccessToken(token) {
      const row = db
        .prepare(
          "SELECT client_id, scope, user_id FROM tokens WHERE hash = ? AND kind = 'access' AND expires_at > ?",
        )
        .get(sha256(token), now()) as
        | { client_id: string; scope: string; user_id: string }
        | undefined;
      return row ? { clientId: row.client_id, scope: row.scope, userId: row.user_id } : null;
    },

    rotateRefreshToken(token, clientId) {
      return transaction(() => {
        purgeExpired();
        const row = db
          .prepare(
            `DELETE FROM tokens WHERE hash = ? AND kind = 'refresh' AND client_id = ? AND expires_at > ?
             RETURNING scope, user_id`,
          )
          .get(sha256(token), clientId, now()) as { scope: string; user_id: string } | undefined;
        return row ? mintPair(clientId, row.scope, row.user_id) : null;
      });
    },

    revokeUser(userId) {
      transaction(() => {
        db.prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM codes WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM clients WHERE user_id = ?").run(userId);
      });
    },

    revokeAll() {
      transaction(() => {
        db.exec("DELETE FROM tokens");
        db.exec("DELETE FROM codes");
        db.exec("DELETE FROM clients");
      });
    },

    close() {
      db.close();
    },
  };
}
