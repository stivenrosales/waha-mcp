import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config.js";
import type { SessionAdmin } from "../../../src/domain/ports/SessionAdmin.js";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import {
  createSqliteMessageStore,
  openCacheDatabase,
} from "../../../src/infrastructure/cache/sqliteMessageStore.js";
import { createSqliteTranscriptStore } from "../../../src/infrastructure/cache/sqliteTranscriptStore.js";
import {
  createTenantCipher,
  isSealedText,
  unwrapDek,
} from "../../../src/infrastructure/crypto/envelope.js";
import { migrateToMultiTenant } from "../../../src/infrastructure/tenants/migrate.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../../fakes/FakeSessionAdmin.js";

const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 8);
const WRONG_KEY_MESSAGE = "MASTER_KEY does not match the stored tenant keys.";
const MESSAGE_ROWS = 1100;
const CHAT = "51999000111@c.us";

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-migrate-"));
  scratchDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const configFor = (dataDir: string, extra: Record<string, string> = {}) =>
  loadConfig({
    WAHA_API_URL: "http://waha:3000",
    WAHA_API_KEY: "k-secret",
    PUBLIC_BASE_URL: "https://mcp.example.com",
    MASTER_KEY: KEY_A.toString("base64"),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "correct horse battery",
    WAHA_SESSION: "default",
    DATA_DIR: dataDir,
    ...extra,
  });

const rawOf = (i: number) => ({ id: `m${i}`, timestamp: 1_790_000_000 + i, body: `hola ${i}` });

/** A DATA_DIR as 0.3.0 left it: pre-user auth tables with a live token, a plaintext cache, uploads. */
function build030DataDir(): string {
  const dir = scratch();
  const auth = openAuthDatabase(path.join(dir, "auth.db"));
  auth.exec(`
    CREATE TABLE clients (client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, client_name TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
    CREATE TABLE tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
  auth
    .prepare("INSERT INTO clients VALUES ('old-client', '[\"https://claude.ai/cb\"]', 'Claude', 0)")
    .run();
  auth
    .prepare("INSERT INTO tokens VALUES ('h', 'access', 'old-client', 'mcp', 99999999999999)")
    .run();
  auth.close();

  const cache = openCacheDatabase(path.join(dir, "cache.db"));
  const insert = cache.prepare("INSERT INTO messages (chat_id, id, ts, raw) VALUES (?, ?, ?, ?)");
  cache.exec("BEGIN");
  for (let i = 0; i < MESSAGE_ROWS; i++)
    insert.run(CHAT, `m${i}`, 1_790_000_000 + i, JSON.stringify(rawOf(i)));
  cache.exec("COMMIT");
  cache
    .prepare("INSERT INTO transcripts (chat_id, message_id, text, created_at) VALUES (?, ?, ?, 0)")
    .run(CHAT, "m1", "nos vemos mañana");
  cache.prepare("INSERT INTO meta (key, value) VALUES ('owner', ?)").run("51999000999@c.us");
  cache.close();

  fs.mkdirSync(path.join(dir, "uploads"));
  fs.writeFileSync(path.join(dir, "uploads", "slot.bin"), "plaintext upload");
  return dir;
}

interface Opened {
  authDb: DatabaseSync;
  tenants: ReturnType<typeof createSqliteTenantStore>;
  auth: ReturnType<typeof createAuthStore>;
}

/** Opens auth.db the way main.ts does. */
function open(dir: string): Opened {
  const authDb = openAuthDatabase(path.join(dir, "auth.db"));
  return { authDb, auth: createAuthStore(authDb), tenants: createSqliteTenantStore(authDb) };
}

function sessionsWithMe(): FakeSessionAdmin {
  const sessions = new FakeSessionAdmin();
  sessions.setMe("default", "51999000999@c.us");
  return sessions;
}

async function migrate(
  dir: string,
  opts: {
    env?: Record<string, string>;
    sessions?: SessionAdmin;
    onBatch?: () => void;
    logs?: string[];
  } = {},
): Promise<void> {
  const config = configFor(dir, opts.env);
  const o = open(dir);
  try {
    await migrateToMultiTenant({
      authDb: o.authDb,
      tenants: o.tenants,
      auth: o.auth,
      config,
      kek: config.masterKey,
      dataDir: dir,
      sessions: opts.sessions ?? sessionsWithMe(),
      logger: { info: (m) => opts.logs?.push(m) },
      ...(opts.onBatch ? { onBatch: opts.onBatch } : {}),
    });
  } finally {
    o.auth.close();
  }
}

const sha = (file: string) =>
  fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;

/** Every file under `dir` with its hash. */
function snapshot(dir: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = sha(full);
    }
  };
  walk(dir);
  return out;
}

/** Reads the admin tenant's cache back through the real stores, with the key from auth.db. */
function readCache(dir: string, kek: Buffer) {
  const o = open(dir);
  const admin = o.tenants.getAdmin();
  if (!admin) throw new Error("no admin");
  const tenant = o.tenants.getTenant(admin.tenantId);
  const dek = unwrapDek(kek, o.tenants.getWrappedDek(admin.tenantId) as string, admin.tenantId);
  o.auth.close();
  const db = openCacheDatabase(path.join(dir, "tenants", admin.tenantId, "cache.db"));
  const cipher = createTenantCipher(dek, admin.tenantId);
  const rows = db.prepare("SELECT raw FROM messages").all() as { raw: string }[];
  const transcripts = db.prepare("SELECT text FROM transcripts").all() as { text: string }[];
  const messages = createSqliteMessageStore(db, cipher).readRange(CHAT, {
    limit: MESSAGE_ROWS + 10,
    offset: 0,
  });
  const transcript = createSqliteTranscriptStore(db, cipher).get(CHAT, "m1");
  db.close();
  return { tenant, admin, rows, transcripts, messages, transcript };
}

describe("migrateToMultiTenant", () => {
  it("migrates a 0.3.0 DATA_DIR: seeds the admin, moves and seals the cache, revokes old sessions", async () => {
    const dir = build030DataDir();
    const logs: string[] = [];
    await migrate(dir, { logs });

    // The cache moved into the admin tenant's directory; the old files are gone.
    expect(fs.existsSync(path.join(dir, "cache.db"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "cache.db-wal"))).toBe(false);
    // 0.3.0 uploads were plaintext and live 15 minutes: they are deleted, not carried over.
    expect(fs.existsSync(path.join(dir, "uploads"))).toBe(false);

    const c = readCache(dir, KEY_A);
    expect(c.tenant).toMatchObject({
      wahaSession: "default",
      status: "active",
      waId: "51999000999@c.us",
    });
    expect(c.admin).toMatchObject({ username: "admin", role: "admin" });
    expect(fs.statSync(path.join(dir, "tenants", c.admin.tenantId)).mode & 0o777).toBe(0o700);
    // Every row is sealed and still reads back as the original (same AAD as the stores).
    expect(c.rows).toHaveLength(MESSAGE_ROWS);
    expect(c.rows.every((r) => isSealedText(r.raw))).toBe(true);
    expect(c.transcripts.every((r) => isSealedText(r.text))).toBe(true);
    expect(c.messages).toHaveLength(MESSAGE_ROWS);
    expect(c.messages).toContainEqual(rawOf(0));
    expect(c.messages).toContainEqual(rawOf(MESSAGE_ROWS - 1));
    expect(c.transcript).toBe("nos vemos mañana");

    const o = open(dir);
    // Old OAuth clients and tokens are gone; the admin logs in with ADMIN_USERNAME/ADMIN_PASSWORD.
    expect(o.auth.countClients()).toBe(0);
    expect(o.authDb.prepare("SELECT COUNT(*) AS n FROM tokens").get()).toEqual({ n: 0 });
    expect(await o.tenants.verifyPassword("admin", "correct horse battery")).toMatchObject({
      role: "admin",
      tenantId: c.admin.tenantId,
    });
    expect(o.authDb.prepare("SELECT value FROM meta WHERE key = 'multi_tenant'").get()).toEqual({
      value: "1",
    });
    o.auth.close();
    // Logs never carry keys or passwords.
    for (const line of logs) {
      expect(line).not.toContain("correct horse battery");
      expect(line).not.toContain(KEY_A.toString("base64"));
    }
  });

  it("leaves no 0.3.0 plaintext anywhere in the migrated cache files", async () => {
    const dir = build030DataDir();
    const cache = openCacheDatabase(path.join(dir, "cache.db"));
    cache
      .prepare("INSERT INTO messages (chat_id, id, ts, raw) VALUES (?, ?, ?, ?)")
      .run(
        CHAT,
        "marker",
        1_800_000_000,
        JSON.stringify({ id: "marker", body: "PLAINMARKER-msg-7f3a" }),
      );
    cache
      .prepare(
        "INSERT INTO transcripts (chat_id, message_id, text, created_at) VALUES (?, ?, ?, 0)",
      )
      .run(CHAT, "marker", "PLAINMARKER-tr-7f3a");
    cache.close();
    await migrate(dir);

    const o = open(dir);
    const tenantDir = path.join(dir, "tenants", o.tenants.getAdmin()?.tenantId as string);
    o.auth.close();
    const files = ["cache.db", "cache.db-wal"].map((f) => path.join(tenantDir, f));
    for (const file of files.filter((f) => fs.existsSync(f))) {
      const bytes = fs.readFileSync(file);
      expect(bytes.includes("PLAINMARKER")).toBe(false);
      expect(bytes.includes("nos vemos")).toBe(false);
    }
  });

  it("seeds the admin on a fresh DATA_DIR, with wa_id null when WAHA is unreachable", async () => {
    const dir = scratch();
    const unreachable = new FakeSessionAdmin();
    unreachable.me = async () => {
      throw new Error("WAHA down");
    };
    await migrate(dir, { sessions: unreachable });
    const o = open(dir);
    const admin = o.tenants.getAdmin();
    expect(o.tenants.listTenants()).toHaveLength(1);
    expect(o.tenants.getTenant(admin?.tenantId as string)).toMatchObject({
      status: "active",
      waId: null,
      wahaSession: "default",
    });
    o.auth.close();
  });

  it("is idempotent: a second run changes neither auth.db nor cache.db", async () => {
    const dir = build030DataDir();
    await migrate(dir);
    const before = snapshot(dir);
    const tenantCount = (() => {
      const o = open(dir);
      const n = o.tenants.listTenants().length;
      o.auth.close();
      return n;
    })();
    await migrate(dir);
    expect(snapshot(dir)).toEqual(before);
    const o = open(dir);
    expect(o.tenants.listTenants()).toHaveLength(tenantCount);
    o.auth.close();
  });

  it("resumes after a crash mid-pass and finishes sealing", async () => {
    const dir = build030DataDir();
    let batches = 0;
    await expect(
      migrate(dir, {
        onBatch: () => {
          batches += 1;
          throw new Error("crash after first batch");
        },
      }),
    ).rejects.toThrow("crash after first batch");
    expect(batches).toBe(1);
    // Part sealed, part plaintext, not yet recorded as done.
    const o = open(dir);
    const admin = o.tenants.getAdmin();
    expect(o.authDb.prepare("SELECT value FROM meta WHERE key = 'multi_tenant'").get()).toBe(
      undefined,
    );
    o.auth.close();
    const db = openCacheDatabase(path.join(dir, "tenants", admin?.tenantId as string, "cache.db"));
    const rows = db.prepare("SELECT raw FROM messages").all() as { raw: string }[];
    db.close();
    const sealed = rows.filter((r) => isSealedText(r.raw)).length;
    expect(sealed).toBe(500);

    await migrate(dir);
    const c = readCache(dir, KEY_A);
    expect(c.rows.every((r) => isSealedText(r.raw))).toBe(true);
    expect(c.messages).toHaveLength(MESSAGE_ROWS);
    expect(c.transcript).toBe("nos vemos mañana");
    const again = open(dir);
    expect(again.tenants.listTenants()).toHaveLength(1);
    again.auth.close();
  });

  it("fails fast with the exact error and changes no file when MASTER_KEY is wrong", async () => {
    const dir = build030DataDir();
    await migrate(dir);
    const before = snapshot(dir);
    await expect(
      migrate(dir, {
        env: {
          MASTER_KEY: KEY_B.toString("base64"),
          ADMIN_PASSWORD_RESET: "1",
          ADMIN_PASSWORD: "another long password",
        },
      }),
    ).rejects.toThrow(new Error(WRONG_KEY_MESSAGE));
    expect(snapshot(dir)).toEqual(before);
  });

  it("rewraps every key under MASTER_KEY when MASTER_KEY_PREVIOUS opens them", async () => {
    const dir = build030DataDir();
    await migrate(dir);
    const logs: string[] = [];
    await migrate(dir, {
      env: { MASTER_KEY: KEY_B.toString("base64"), MASTER_KEY_PREVIOUS: KEY_A.toString("base64") },
      logs,
    });
    const c = readCache(dir, KEY_B);
    expect(c.messages).toHaveLength(MESSAGE_ROWS);
    expect(() => readCache(dir, KEY_A)).toThrow();
    expect(logs.join("\n")).toContain("rewrapped 1");
    // The new key alone now opens them.
    await migrate(dir, { env: { MASTER_KEY: KEY_B.toString("base64") } });
  });

  it("ADMIN_PASSWORD_RESET overwrites the admin's password and revokes its tokens on every start", async () => {
    const dir = scratch();
    await migrate(dir);
    /** Signs the admin in on one client and returns its access token. */
    const signIn = () => {
      const o = open(dir);
      const userId = o.tenants.getAdmin()?.id as string;
      const { clientId } = o.auth.registerClient({ redirectUris: ["https://claude.ai/cb"] });
      o.auth.saveCode({
        clientId,
        redirectUri: "https://claude.ai/cb",
        codeChallenge: "c",
        scope: "mcp",
        resource: null,
        userId,
      });
      const { accessToken } = o.auth.issueTokens(clientId, "mcp", userId);
      o.auth.close();
      return accessToken;
    };
    const verifies = (token: string) => {
      const o = open(dir);
      const ok = o.auth.verifyAccessToken(token) !== null;
      o.auth.close();
      return ok;
    };
    const reset = { ADMIN_PASSWORD_RESET: "1", ADMIN_PASSWORD: "another long password" };

    const first = signIn();
    const logs: string[] = [];
    await migrate(dir, { env: reset, logs });
    const o = open(dir);
    expect(await o.tenants.verifyPassword("admin", "correct horse battery")).toBeNull();
    expect(await o.tenants.verifyPassword("admin", "another long password")).not.toBeNull();
    o.auth.close();
    expect(verifies(first)).toBe(false);
    expect(logs).toContain("admin password reset from ADMIN_PASSWORD; admin sessions revoked");

    // Still set on the next start: applied (and sessions revoked) again.
    const second = signIn();
    await migrate(dir, { env: reset });
    expect(verifies(second)).toBe(false);
  });
});
