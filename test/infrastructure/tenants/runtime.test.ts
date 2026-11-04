import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import type { Tenant } from "../../../src/domain/ports/TenantStore.js";
import { generateDek } from "../../../src/infrastructure/crypto/envelope.js";
import { buildTenantRuntime } from "../../../src/infrastructure/tenants/runtime.js";

/** Every cache database the runtime opens, so tests can check it was closed. */
const opened = vi.hoisted(() => [] as DatabaseSync[]);
vi.mock("../../../src/infrastructure/cache/sqliteMessageStore.js", async (importOriginal) => {
  const mod =
    await importOriginal<
      typeof import("../../../src/infrastructure/cache/sqliteMessageStore.js")
    >();
  return {
    ...mod,
    openCacheDatabase: (p: string) => {
      const db = mod.openCacheDatabase(p);
      opened.push(db);
      return db;
    },
  };
});

const SECRET = new Uint8Array(32).fill(4);

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-runtime-"));
  scratchDirs.push(dir);
  return dir;
};
afterEach(() => {
  opened.splice(0);
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const configFor = (dataDir: string) =>
  loadConfig({
    WAHA_API_URL: "http://waha:3000",
    WAHA_API_KEY: "k-secret",
    PUBLIC_BASE_URL: "https://mcp.example.com",
    MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "correct horse battery",
    DATA_DIR: dataDir,
  });

const tenant = (id: string): Tenant => ({
  id,
  wahaSession: "t_abcdefghij",
  displayName: "Acme",
  status: "active",
  waId: null,
  createdAt: 0,
});

const build = (dataDir: string, id: string) =>
  buildTenantRuntime({
    config: configFor(dataDir),
    tenant: tenant(id),
    dek: generateDek(),
    mediaSecret: SECRET,
    logger: { info: () => {} },
  });

describe("buildTenantRuntime", () => {
  it("creates the tenant directory 0700 with its cache and uploads", () => {
    const dataDir = scratch();
    const runtime = build(dataDir, "tid1");
    const dir = path.join(dataDir, "tenants", "tid1");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(dir, "cache.db"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "uploads"))).toBe(true);
    expect(runtime.tenantId).toBe("tid1");
    const token = runtime.context.links.sign("m1");
    expect(runtime.context.links.verify(token)).toBe("m1");
    runtime.close();
    expect(opened[0]?.isOpen).toBe(false);
  });

  it("tightens an existing tenant directory to 0700", () => {
    const dataDir = scratch();
    const dir = path.join(dataDir, "tenants", "tid1");
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    build(dataDir, "tid1").close();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("closes the cache database when a later step of the build fails", () => {
    const dataDir = scratch();
    const dir = path.join(dataDir, "tenants", "tid1");
    fs.mkdirSync(dir, { recursive: true });
    // A file where the uploads directory should be: the upload store cannot be created.
    fs.writeFileSync(path.join(dir, "uploads"), "");
    expect(() => build(dataDir, "tid1")).toThrow();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.isOpen).toBe(false);
  });

  it("refuses a tenant id that is not a plain path segment", () => {
    const dataDir = scratch();
    for (const id of ["../x", "a/b", "", "."]) {
      expect(() => build(dataDir, id)).toThrow("Invalid tenant id.");
    }
    expect(fs.existsSync(path.join(dataDir, "x"))).toBe(false);
    expect(opened).toHaveLength(0);
  });
});
