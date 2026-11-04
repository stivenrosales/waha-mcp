import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";

const T0 = 1_800_000_000_000;

function setup() {
  let t = T0;
  const store = createAuthStore(openAuthDatabase(":memory:"), () => t);
  const client = store.registerClient({ redirectUris: ["https://app.example/cb"] });
  return {
    store,
    clientId: client.clientId,
    advance: (seconds: number) => {
      t += seconds * 1000;
    },
  };
}

const codeInput = (clientId: string) => ({
  clientId,
  redirectUri: "https://app.example/cb",
  codeChallenge: "challenge-value",
  scope: "mcp",
  resource: "https://mcp.example/mcp",
  userId: "u1",
});

/** saveCode for a client that is free or already bound to the same user. */
function save(store: ReturnType<typeof createAuthStore>, input: ReturnType<typeof codeInput>) {
  const code = store.saveCode(input);
  if (code === null) throw new Error("client bound to another user");
  return code;
}

describe("auth store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("registers and returns clients", () => {
    const { store, clientId } = setup();
    expect(store.getClient(clientId)).toEqual({
      clientId,
      redirectUris: ["https://app.example/cb"],
    });
    expect(store.getClient("nope")).toBeNull();
  });

  it("counts registered clients and revokeAll resets the count", () => {
    const { store } = setup();
    expect(store.countClients()).toBe(1);
    store.registerClient({ redirectUris: ["https://other.example/cb"] });
    expect(store.countClients()).toBe(2);
    store.revokeAll();
    expect(store.countClients()).toBe(0);
  });

  it("code is single use", () => {
    const { store, clientId } = setup();
    const code = save(store, codeInput(clientId));
    expect(store.consumeCode(code)).toEqual(codeInput(clientId));
    expect(store.consumeCode(code)).toBeNull();
  });

  it("code expires after 60 s", () => {
    const { store, clientId, advance } = setup();
    const fresh = save(store, codeInput(clientId));
    advance(59);
    expect(store.consumeCode(fresh)).not.toBeNull();
    const stale = save(store, codeInput(clientId));
    advance(60);
    expect(store.consumeCode(stale)).toBeNull();
  });

  it("access token verifies then expires after 3600 s", () => {
    const { store, clientId, advance } = setup();
    const t = store.issueTokens(clientId, "mcp", "u1");
    expect(t.expiresIn).toBe(3600);
    expect(store.verifyAccessToken(t.accessToken)).toEqual({
      clientId,
      scope: "mcp",
      userId: "u1",
    });
    expect(store.verifyAccessToken("garbage")).toBeNull();
    // a refresh token is not an access token
    expect(store.verifyAccessToken(t.refreshToken)).toBeNull();
    advance(3599);
    expect(store.verifyAccessToken(t.accessToken)).not.toBeNull();
    advance(1);
    expect(store.verifyAccessToken(t.accessToken)).toBeNull();
  });

  it("refresh rotates and old refresh fails", () => {
    const { store, clientId } = setup();
    const first = store.issueTokens(clientId, "mcp", "u1");
    const second = store.rotateRefreshToken(first.refreshToken, clientId);
    expect(second).not.toBeNull();
    expect(second?.refreshToken).not.toBe(first.refreshToken);
    expect(second && store.verifyAccessToken(second.accessToken)).toEqual({
      clientId,
      scope: "mcp",
      userId: "u1",
    });
    expect(store.rotateRefreshToken(first.refreshToken, clientId)).toBeNull();
    expect(second && store.rotateRefreshToken(second.refreshToken, clientId)).not.toBeNull();
  });

  it("refresh rotation keeps userId", () => {
    const { store, clientId } = setup();
    const first = store.issueTokens(clientId, "mcp", "u2");
    const second = store.rotateRefreshToken(first.refreshToken, clientId);
    expect(second && store.verifyAccessToken(second.accessToken)?.userId).toBe("u2");
  });

  it("revokeUser leaves other users' tokens valid", () => {
    const { store, clientId } = setup();
    const other = store.registerClient({ redirectUris: ["https://other.example/cb"] });
    const a = store.issueTokens(clientId, "mcp", "u1");
    const b = store.issueTokens(other.clientId, "mcp", "u2");
    const code = save(store, { ...codeInput(clientId), userId: "u1" });
    const otherCode = save(store, { ...codeInput(other.clientId), userId: "u2" });
    store.revokeUser("u1");
    expect(store.verifyAccessToken(a.accessToken)).toBeNull();
    expect(store.rotateRefreshToken(a.refreshToken, clientId)).toBeNull();
    expect(store.consumeCode(code)).toBeNull();
    expect(store.getClient(clientId)).toBeNull();
    expect(store.verifyAccessToken(b.accessToken)?.userId).toBe("u2");
    expect(store.getClient(other.clientId)).not.toBeNull();
    expect(store.consumeCode(otherCode)).not.toBeNull();
  });

  it("binds a client to its first user: revokeUser(B) leaves A intact and B gets no code", () => {
    const { store, clientId } = setup();
    const codeA = store.saveCode({ ...codeInput(clientId), userId: "uA" });
    expect(codeA).not.toBeNull();
    const tokensA = store.issueTokens(clientId, "mcp", "uA");
    expect(store.saveCode({ ...codeInput(clientId), userId: "uB" })).toBeNull();
    // The same user may log in again on its own client.
    expect(store.saveCode({ ...codeInput(clientId), userId: "uA" })).not.toBeNull();
    store.revokeUser("uB");
    expect(store.getClient(clientId)).not.toBeNull();
    expect(store.verifyAccessToken(tokensA.accessToken)?.userId).toBe("uA");
    expect(store.consumeCode(codeA as string)?.userId).toBe("uA");
    expect(store.rotateRefreshToken(tokensA.refreshToken, clientId)).not.toBeNull();
  });

  it("drops legacy rows without user_id when migrating an existing auth.db", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-auth-"));
    dirs.push(dir);
    const file = path.join(dir, "auth.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE clients (client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, client_name TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO tokens VALUES ('h', 'access', 'c', 'mcp', 9999999999999);
    `);
    legacy.close();
    const store = createAuthStore(openAuthDatabase(file));
    const { clientId } = store.registerClient({ redirectUris: ["https://app.example/cb"] });
    const t = store.issueTokens(clientId, "mcp", "u1");
    expect(store.verifyAccessToken(t.accessToken)?.userId).toBe("u1");
    store.close();
    const db = new DatabaseSync(file);
    const n = db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE user_id IS NULL").get() as {
      n: number;
    };
    db.close();
    expect(n.n).toBe(0);
  });

  it("refresh expires after 30 days", () => {
    const { store, clientId, advance } = setup();
    const t = store.issueTokens(clientId, "mcp", "u1");
    advance(30 * 24 * 3600);
    expect(store.rotateRefreshToken(t.refreshToken, clientId)).toBeNull();
  });

  it("refresh bound to its client", () => {
    const { store, clientId } = setup();
    const other = store.registerClient({ redirectUris: ["https://other.example/cb"] });
    const t = store.issueTokens(clientId, "mcp", "u1");
    expect(store.rotateRefreshToken(t.refreshToken, other.clientId)).toBeNull();
    expect(store.rotateRefreshToken(t.refreshToken, clientId)).not.toBeNull();
  });

  it("revokeAll invalidates every token and client", () => {
    const { store, clientId } = setup();
    const t = store.issueTokens(clientId, "mcp", "u1");
    const code = save(store, codeInput(clientId));
    store.revokeAll();
    expect(store.verifyAccessToken(t.accessToken)).toBeNull();
    expect(store.rotateRefreshToken(t.refreshToken, clientId)).toBeNull();
    expect(store.consumeCode(code)).toBeNull();
    expect(store.getClient(clientId)).toBeNull();
  });

  it("raw tokens are not stored", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-auth-"));
    dirs.push(dir);
    const file = path.join(dir, "auth.db");
    const store = createAuthStore(openAuthDatabase(file));
    const { clientId } = store.registerClient({ redirectUris: ["https://app.example/cb"] });
    const t = store.issueTokens(clientId, "mcp", "u1");
    const code = save(store, codeInput(clientId));
    const db = new DatabaseSync(file);
    const dump = JSON.stringify([
      ...db.prepare("SELECT * FROM tokens").all(),
      ...db.prepare("SELECT * FROM codes").all(),
    ]);
    db.close();
    for (const secret of [t.accessToken, t.refreshToken, code]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("store survives reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-auth-"));
    dirs.push(dir);
    const file = path.join(dir, "auth.db");
    const a = createAuthStore(openAuthDatabase(file));
    const { clientId } = a.registerClient({ redirectUris: ["https://app.example/cb"] });
    const t = a.issueTokens(clientId, "mcp", "u1");
    const b = createAuthStore(openAuthDatabase(file));
    expect(b.getClient(clientId)).not.toBeNull();
    expect(b.verifyAccessToken(t.accessToken)).toEqual({ clientId, scope: "mcp", userId: "u1" });
  });

  it("keeps tokens when the API key is unchanged and revokes them when it changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-auth-"));
    dirs.push(dir);
    const file = path.join(dir, "auth.db");
    const a = createAuthStore(openAuthDatabase(file));
    expect(a.syncApiKey("key-one")).toBe(false);
    const { clientId } = a.registerClient({ redirectUris: ["https://app.example/cb"] });
    const t = a.issueTokens(clientId, "mcp", "u1");
    a.close();

    const same = createAuthStore(openAuthDatabase(file));
    expect(same.syncApiKey("key-one")).toBe(false);
    expect(same.verifyAccessToken(t.accessToken)).not.toBeNull();
    same.close();

    const rotated = createAuthStore(openAuthDatabase(file));
    expect(rotated.syncApiKey("key-two")).toBe(true);
    expect(rotated.verifyAccessToken(t.accessToken)).toBeNull();
    expect(rotated.getClient(clientId)).toBeNull();
    expect(rotated.syncApiKey("key-two")).toBe(false);
    rotated.close();

    const db = new DatabaseSync(file);
    const dump = JSON.stringify(db.prepare("SELECT * FROM meta").all());
    db.close();
    expect(dump).not.toContain("key-one");
    expect(dump).not.toContain("key-two");
  });

  it("prunes bound clients older than 24 h that hold no live token", () => {
    let t = T0;
    const store = createAuthStore(openAuthDatabase(":memory:"), () => t);
    const uris = ["https://app.example/cb"];
    const bind = (clientId: string) =>
      store.saveCode({ ...codeInput(clientId), redirectUri: uris[0] as string });
    const idle = store.registerClient({ redirectUris: uris }).clientId;
    bind(idle);
    const active = store.registerClient({ redirectUris: uris }).clientId;
    bind(active);
    store.issueTokens(active, "mcp", "u1");
    t += 23 * 3600 * 1000;
    const fresh = store.registerClient({ redirectUris: uris }).clientId;
    bind(fresh);
    expect(store.pruneStaleClients()).toBe(0);
    t += 2 * 3600 * 1000;
    expect(store.pruneStaleClients()).toBe(1);
    expect(store.getClient(idle)).toBeNull();
    expect(store.getClient(active)).not.toBeNull();
    expect(store.getClient(fresh)).not.toBeNull();
  });

  it("prunes unbound clients after one hour and counts only unbound ones", () => {
    let t = T0;
    const store = createAuthStore(openAuthDatabase(":memory:"), () => t);
    const uris = ["https://app.example/cb"];
    const anonymous = store.registerClient({ redirectUris: uris }).clientId;
    const bound = store.registerClient({ redirectUris: uris }).clientId;
    store.saveCode({ ...codeInput(bound), redirectUri: uris[0] as string });
    expect(store.countUnboundClients()).toBe(1);
    t += 59 * 60 * 1000;
    expect(store.pruneStaleClients()).toBe(0);
    t += 2 * 60 * 1000;
    expect(store.pruneStaleClients()).toBe(1);
    expect(store.getClient(anonymous)).toBeNull();
    expect(store.getClient(bound)).not.toBeNull();
    expect(store.countUnboundClients()).toBe(0);
  });

  it("keeps auth.db and its WAL files private to the owner", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-auth-"));
    dirs.push(dir);
    const file = path.join(dir, "auth.db");
    const store = createAuthStore(openAuthDatabase(file));
    store.registerClient({ redirectUris: ["https://app.example/cb"] });
    for (const f of [file, `${file}-wal`, `${file}-shm`])
      if (fs.existsSync(f)) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    store.close();
  });
});
