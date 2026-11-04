import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTenantAdmin } from "../../../src/application/tenantAdmin.js";
import { loadConfig } from "../../../src/config.js";
import type { Tenant, TenantStatus, TenantStore } from "../../../src/domain/ports/TenantStore.js";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { generateDek, wrapDek } from "../../../src/infrastructure/crypto/envelope.js";
import { createTenantRegistry } from "../../../src/infrastructure/tenants/registry.js";
import type {
  buildTenantRuntime,
  TenantRuntime,
} from "../../../src/infrastructure/tenants/runtime.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../../fakes/FakeSessionAdmin.js";

const KEK = Buffer.alloc(32, 9);
const SECRET = new Uint8Array(32).fill(4);

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-registry-"));
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
    MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "correct horse battery",
    DATA_DIR: dataDir,
    ...extra,
  });

/** Only the two reads the registry uses; everything else is not needed here. */
function fakeTenants() {
  const rows = new Map<string, { tenant: Tenant; wrapped: string }>();
  const add = (id: string, status: TenantStatus = "active", wrapped?: string) => {
    rows.set(id, {
      tenant: {
        id,
        wahaSession: `t_${id}`,
        displayName: id,
        status,
        waId: null,
        createdAt: 0,
      },
      wrapped: wrapped ?? wrapDek(KEK, generateDek(), id),
    });
  };
  const store = {
    getTenant: (id: string) => rows.get(id)?.tenant ?? null,
    getWrappedDek: (id: string) => rows.get(id)?.wrapped ?? null,
  } as unknown as TenantStore;
  const setStatus = (id: string, status: TenantStatus) => {
    const row = rows.get(id);
    if (row) row.tenant = { ...row.tenant, status };
  };
  return { store, add, setStatus };
}

/** A `build` that records every runtime it makes and how often each was closed. */
function fakeBuild() {
  const built: { tenantId: string; closed: number; runtime: TenantRuntime }[] = [];
  const build: typeof buildTenantRuntime = ({ tenant }) => {
    const entry = {
      tenantId: tenant.id,
      closed: 0,
      runtime: undefined as unknown as TenantRuntime,
    };
    entry.runtime = {
      tenantId: tenant.id,
      context: {} as TenantRuntime["context"],
      media: async () => new Response(null),
      upload: async () => new Response(null),
      close: () => {
        entry.closed += 1;
      },
    };
    built.push(entry);
    return entry.runtime;
  };
  return { build, built };
}

function setup(maxOpen?: number) {
  const tenants = fakeTenants();
  const { build, built } = fakeBuild();
  const lines: string[] = [];
  const registry = createTenantRegistry({
    config: configFor(scratch()),
    tenants: tenants.store,
    kek: KEK,
    mediaSecret: SECRET,
    logger: { info: (m) => lines.push(m) },
    build,
    ...(maxOpen === undefined ? {} : { maxOpen }),
  });
  return { registry, tenants, built, lines };
}

describe("TenantRegistry", () => {
  it("acquire builds once and reuses", () => {
    const { registry, tenants, built } = setup();
    tenants.add("a");
    const first = registry.acquire("a");
    const second = registry.acquire("a");
    expect(first?.runtime.tenantId).toBe("a");
    expect(second?.runtime).toBe(first?.runtime);
    expect(built).toHaveLength(1);
    first?.release();
    second?.release();
    expect(registry.acquire("a")?.runtime).toBe(first?.runtime);
    expect(built).toHaveLength(1);
  });

  it("acquire returns null for a revoked or unknown tenant", () => {
    const { registry, tenants, built } = setup();
    tenants.add("revoked", "revoked");
    tenants.add("pairing", "pairing");
    expect(registry.acquire("nobody")).toBeNull();
    expect(registry.acquire("revoked")).toBeNull();
    expect(registry.acquire("pairing")).toBeNull();
    expect(built).toHaveLength(0);
  });

  it("acquire returns null and logs without secrets when the DEK cannot be unwrapped", () => {
    const { registry, tenants, built, lines } = setup();
    tenants.add("broken", "active", "v1.not-a-real-wrap");
    expect(registry.acquire("broken")).toBeNull();
    expect(built).toHaveLength(0);
    expect(lines.join("\n")).toContain("broken");
    expect(lines.join("\n")).not.toContain("v1.not-a-real-wrap");
    expect(lines.join("\n")).not.toContain(KEK.toString("base64"));
  });

  it("a tenant revoked while cached is evicted and acquire returns null", () => {
    const { registry, tenants, built } = setup();
    tenants.add("a");
    registry.acquire("a")?.release();
    tenants.setStatus("a", "revoked");
    expect(registry.acquire("a")).toBeNull();
    expect(built[0]?.closed).toBe(1);
  });

  it("LRU over maxOpen evicts the least recent and closes it", () => {
    const { registry, tenants, built } = setup(2);
    for (const id of ["a", "b", "c"]) tenants.add(id);
    registry.acquire("a")?.release();
    registry.acquire("b")?.release();
    registry.acquire("a")?.release(); // a is now the most recent; b the least
    registry.acquire("c")?.release();
    const closed = Object.fromEntries(built.map((b) => [b.tenantId, b.closed]));
    expect(closed).toEqual({ a: 0, b: 1, c: 0 });
    // b is rebuilt on its next acquire; a stays cached.
    registry.acquire("a")?.release();
    registry.acquire("b")?.release();
    expect(built.map((b) => b.tenantId)).toEqual(["a", "b", "c", "b"]);
  });

  it("an evicted runtime with an unreleased acquire is closed only after release", () => {
    const { registry, tenants, built } = setup(1);
    tenants.add("a");
    tenants.add("b");
    const held = registry.acquire("a");
    registry.acquire("b")?.release(); // evicts a while it is still held
    expect(built[0]?.closed).toBe(0);
    held?.release();
    expect(built[0]?.closed).toBe(1);
    held?.release(); // a second release is a no-op
    expect(built[0]?.closed).toBe(1);
  });

  it("an evicted runtime still held is revived on acquire, never built twice", () => {
    const { registry, tenants, built } = setup(1);
    tenants.add("a");
    tenants.add("b");
    const held = registry.acquire("a");
    registry.acquire("b")?.release(); // a evicted but still held
    const again = registry.acquire("a");
    expect(again?.runtime).toBe(held?.runtime);
    expect(built.filter((b) => b.tenantId === "a")).toHaveLength(1);
    held?.release();
    expect(built[0]?.closed).toBe(0); // revived: back in the LRU and still held
    again?.release();
    expect(built[0]?.closed).toBe(0); // cached, not evicted
    expect(built.find((b) => b.tenantId === "b")?.closed).toBe(1); // b made room for a
  });

  it("evict closes the runtime", () => {
    const { registry, tenants, built } = setup();
    tenants.add("a");
    registry.acquire("a")?.release();
    registry.evict("a");
    expect(built[0]?.closed).toBe(1);
    registry.evict("a");
    registry.evict("unknown");
    expect(built[0]?.closed).toBe(1);
    registry.acquire("a")?.release();
    expect(built).toHaveLength(2);
  });

  it("a build that throws registers nothing and the next acquire builds again", () => {
    const tenants = fakeTenants();
    tenants.add("a");
    const { build, built } = fakeBuild();
    let fail = true;
    const registry = createTenantRegistry({
      config: configFor(scratch()),
      tenants: tenants.store,
      kek: KEK,
      mediaSecret: SECRET,
      logger: { info: () => {} },
      build: (d) => {
        if (fail) throw new Error("disk full");
        return build(d);
      },
    });
    expect(() => registry.acquire("a")).toThrow("disk full");
    fail = false;
    const lease = registry.acquire("a");
    expect(lease?.runtime.tenantId).toBe("a");
    expect(built).toHaveLength(1);
  });

  it("closeAll closes every runtime", () => {
    const { registry, tenants, built } = setup();
    tenants.add("a");
    tenants.add("b");
    registry.acquire("a")?.release();
    registry.acquire("b")?.release();
    registry.closeAll();
    expect(built.map((b) => b.closed)).toEqual([1, 1]);
  });
});

describe("revoke through the admin service", () => {
  it("makes acquire return null and closes the cached runtime", async () => {
    const dataDir = scratch();
    const db = openAuthDatabase(":memory:");
    const tenants = createSqliteTenantStore(db);
    const { build, built } = fakeBuild();
    const registry = createTenantRegistry({
      config: configFor(dataDir),
      tenants,
      kek: KEK,
      mediaSecret: SECRET,
      logger: { info: () => {} },
      build,
    });
    const admin = createTenantAdmin({
      tenants,
      auth: createAuthStore(db),
      sessions: new FakeSessionAdmin(),
      registry,
      newWrappedDek: (id) => wrapDek(KEK, generateDek(), id),
      dataDir,
      publicBaseUrl: "https://mcp.example.com",
      logger: { info: () => {} },
    });
    const owner = tenants.createTenant({
      displayName: "Owner",
      wahaSession: "t_o",
      wrappedDek: "x",
    });
    await tenants.createUser({
      tenantId: owner.id,
      username: "admin",
      password: "correct horse battery",
      role: "admin",
    });
    const { tenantId } = await admin.createInvite({ displayName: "Acme" });
    tenants.setStatus(tenantId, "active");

    const held = registry.acquire(tenantId);
    expect(held).not.toBeNull();
    held?.release();
    expect(built).toHaveLength(1);

    admin.revoke(tenantId);

    expect(registry.acquire(tenantId)).toBeNull();
    expect(built[0]?.closed).toBe(1);
  });
});
