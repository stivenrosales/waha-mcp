import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthStore } from "../../../src/infrastructure/auth/store.js";

const T0 = 1_800_000_000_000;

function setup() {
  let t = T0;
  const store = createAuthStore(":memory:", () => t);
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
});

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
    const code = store.saveCode(codeInput(clientId));
    expect(store.consumeCode(code)).toEqual(codeInput(clientId));
    expect(store.consumeCode(code)).toBeNull();
  });

  it("code expires after 60 s", () => {
    const { store, clientId, advance } = setup();
    const fresh = store.saveCode(codeInput(clientId));
    advance(59);
    expect(store.consumeCode(fresh)).not.toBeNull();
    const stale = store.saveCode(codeInput(clientId));
    advance(60);
    expect(store.consumeCode(stale)).toBeNull();
  });

  it("access token verifies then expires after 3600 s", () => {
    const { store, clientId, advance } = setup();
    const t = store.issueTokens(clientId, "mcp");
    expect(t.expiresIn).toBe(3600);
    expect(store.verifyAccessToken(t.accessToken)).toEqual({ clientId, scope: "mcp" });
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
    const first = store.issueTokens(clientId, "mcp");
    const second = store.rotateRefreshToken(first.refreshToken, clientId);
    expect(second).not.toBeNull();
    expect(second?.refreshToken).not.toBe(first.refreshToken);
    expect(second && store.verifyAccessToken(second.accessToken)).toEqual({
      clientId,
      scope: "mcp",
    });
    expect(store.rotateRefreshToken(first.refreshToken, clientId)).toBeNull();
    expect(second && store.rotateRefreshToken(second.refreshToken, clientId)).not.toBeNull();
  });

  it("refresh expires after 30 days", () => {
    const { store, clientId, advance } = setup();
    const t = store.issueTokens(clientId, "mcp");
    advance(30 * 24 * 3600);
    expect(store.rotateRefreshToken(t.refreshToken, clientId)).toBeNull();
  });

  it("refresh bound to its client", () => {
    const { store, clientId } = setup();
    const other = store.registerClient({ redirectUris: ["https://other.example/cb"] });
    const t = store.issueTokens(clientId, "mcp");
    expect(store.rotateRefreshToken(t.refreshToken, other.clientId)).toBeNull();
    expect(store.rotateRefreshToken(t.refreshToken, clientId)).not.toBeNull();
  });

  it("revokeAll invalidates every token and client", () => {
    const { store, clientId } = setup();
    const t = store.issueTokens(clientId, "mcp");
    const code = store.saveCode(codeInput(clientId));
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
    const store = createAuthStore(file);
    const { clientId } = store.registerClient({ redirectUris: ["https://app.example/cb"] });
    const t = store.issueTokens(clientId, "mcp");
    const code = store.saveCode(codeInput(clientId));
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
    const a = createAuthStore(file);
    const { clientId } = a.registerClient({ redirectUris: ["https://app.example/cb"] });
    const t = a.issueTokens(clientId, "mcp");
    const b = createAuthStore(file);
    expect(b.getClient(clientId)).not.toBeNull();
    expect(b.verifyAccessToken(t.accessToken)).toEqual({ clientId, scope: "mcp" });
  });

  it("keeps tokens when the API key is unchanged and revokes them when it changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-auth-"));
    dirs.push(dir);
    const file = path.join(dir, "auth.db");
    const a = createAuthStore(file);
    expect(a.syncApiKey("key-one")).toBe(false);
    const { clientId } = a.registerClient({ redirectUris: ["https://app.example/cb"] });
    const t = a.issueTokens(clientId, "mcp");
    a.close();

    const same = createAuthStore(file);
    expect(same.syncApiKey("key-one")).toBe(false);
    expect(same.verifyAccessToken(t.accessToken)).not.toBeNull();
    same.close();

    const rotated = createAuthStore(file);
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

  it("prunes only old clients that hold no live token", () => {
    let t = T0;
    const store = createAuthStore(":memory:", () => t);
    const uris = ["https://app.example/cb"];
    const idle = store.registerClient({ redirectUris: uris }).clientId;
    const active = store.registerClient({ redirectUris: uris }).clientId;
    store.issueTokens(active, "mcp");
    t += 23 * 3600 * 1000;
    const fresh = store.registerClient({ redirectUris: uris }).clientId;
    expect(store.pruneStaleClients()).toBe(0);
    t += 2 * 3600 * 1000;
    expect(store.pruneStaleClients()).toBe(1);
    expect(store.getClient(idle)).toBeNull();
    expect(store.getClient(active)).not.toBeNull();
    expect(store.getClient(fresh)).not.toBeNull();
  });

  it("keeps auth.db and its WAL files private to the owner", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-auth-"));
    dirs.push(dir);
    const file = path.join(dir, "auth.db");
    const store = createAuthStore(file);
    store.registerClient({ redirectUris: ["https://app.example/cb"] });
    for (const f of [file, `${file}-wal`, `${file}-shm`])
      if (fs.existsSync(f)) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    store.close();
  });
});
