import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;

export interface AuthorizationCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
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
  /** Returns the raw code. Valid for 60 s. */
  saveCode(c: AuthorizationCodeData): string;
  /** Single use: the code is deleted atomically as it is read. */
  consumeCode(code: string): AuthorizationCodeData | null;
  issueTokens(clientId: string, scope: string): IssuedTokens;
  verifyAccessToken(token: string): { clientId: string; scope: string } | null;
  /** Single use: the old refresh token is deleted atomically; bound to `clientId`. */
  rotateRefreshToken(token: string, clientId: string): IssuedTokens | null;
  /** Logout: removes every client, code and token. */
  revokeAll(): void;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const randomToken = (): string => randomBytes(32).toString("base64url");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

/**
 * @param now clock in epoch milliseconds (injectable for tests).
 */
export function createAuthStore(dbPath: string, now: () => number = Date.now): AuthStore {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
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

  const purgeExpired = (): void => {
    const t = now();
    db.prepare("DELETE FROM codes WHERE expires_at <= ?").run(t);
    db.prepare("DELETE FROM tokens WHERE expires_at <= ?").run(t);
  };

  const insertToken = (
    kind: "access" | "refresh",
    clientId: string,
    scope: string,
    ttlS: number,
  ) => {
    const raw = randomToken();
    db.prepare(
      "INSERT INTO tokens (hash, kind, client_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(sha256(raw), kind, clientId, scope, now() + ttlS * 1000);
    return raw;
  };

  const mintPair = (clientId: string, scope: string): IssuedTokens => ({
    accessToken: insertToken("access", clientId, scope, ACCESS_TTL_S),
    refreshToken: insertToken("refresh", clientId, scope, REFRESH_TTL_S),
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

    saveCode(c) {
      purgeExpired();
      const code = randomToken();
      db.prepare(
        `INSERT INTO codes (hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sha256(code),
        c.clientId,
        c.redirectUri,
        c.codeChallenge,
        c.scope,
        c.resource,
        now() + CODE_TTL_MS,
      );
      return code;
    },

    consumeCode(code) {
      const row = db
        .prepare(
          `DELETE FROM codes WHERE hash = ? AND expires_at > ?
           RETURNING client_id, redirect_uri, code_challenge, scope, resource`,
        )
        .get(sha256(code), now()) as
        | {
            client_id: string;
            redirect_uri: string;
            code_challenge: string;
            scope: string;
            resource: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
      };
    },

    issueTokens(clientId, scope) {
      return transaction(() => {
        purgeExpired();
        return mintPair(clientId, scope);
      });
    },

    verifyAccessToken(token) {
      const row = db
        .prepare(
          "SELECT client_id, scope FROM tokens WHERE hash = ? AND kind = 'access' AND expires_at > ?",
        )
        .get(sha256(token), now()) as { client_id: string; scope: string } | undefined;
      return row ? { clientId: row.client_id, scope: row.scope } : null;
    },

    rotateRefreshToken(token, clientId) {
      return transaction(() => {
        purgeExpired();
        const row = db
          .prepare(
            `DELETE FROM tokens WHERE hash = ? AND kind = 'refresh' AND client_id = ? AND expires_at > ?
             RETURNING scope`,
          )
          .get(sha256(token), clientId, now()) as { scope: string } | undefined;
        return row ? mintPair(clientId, row.scope) : null;
      });
    },

    revokeAll() {
      transaction(() => {
        db.exec("DELETE FROM tokens");
        db.exec("DELETE FROM codes");
        db.exec("DELETE FROM clients");
      });
    },
  };
}
