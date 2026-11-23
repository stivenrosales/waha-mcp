import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";

async function withUser(username = "ana") {
  const db = openAuthDatabase(":memory:");
  const tenants = createSqliteTenantStore(db, () => 1);
  const t = tenants.createTenant({
    displayName: username,
    wahaSession: `t_${username}`,
    wrappedDek: "x",
  });
  const user = (await tenants.createUser({
    tenantId: t.id,
    username,
    password: "a long enough password",
    role: "member",
  })) as { id: string };
  return { db, tenants, user };
}

describe("user email", () => {
  it("starts empty and is found case-insensitively once set", async () => {
    const { tenants, user } = await withUser();
    expect(tenants.getUser(user.id)?.email).toBeNull();
    expect(tenants.setEmail(user.id, "Ana@Example.com")).toBe("ok");
    expect(tenants.getUser(user.id)?.email).toBe("ana@example.com");
    expect(tenants.getUserByEmail("ANA@example.COM")?.id).toBe(user.id);
    expect(tenants.getUserByEmail("other@example.com")).toBeNull();
  });

  it("refuses an email another user already has", async () => {
    const { tenants, user } = await withUser();
    const t2 = tenants.createTenant({ displayName: "Bo", wahaSession: "t_bo", wrappedDek: "x" });
    const bo = (await tenants.createUser({
      tenantId: t2.id,
      username: "bo",
      password: "a long enough password",
      role: "member",
    })) as { id: string };
    tenants.setEmail(user.id, "same@example.com");
    expect(tenants.setEmail(bo.id, "SAME@example.com")).toBe("taken");
    expect(tenants.getUser(bo.id)?.email).toBeNull();
    expect(tenants.setEmail(user.id, "same@example.com")).toBe("ok");
  });

  it("adds the column to a database created before emails existed", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE tenants (id TEXT PRIMARY KEY, waha_session TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, status TEXT NOT NULL, wa_id TEXT UNIQUE, wrapped_dek TEXT NOT NULL,
      created_at INTEGER NOT NULL);
      CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, last_login_at INTEGER);
      INSERT INTO tenants VALUES ('t1', 's1', 'Old', 'active', NULL, 'x', 1);
      INSERT INTO users VALUES ('u1', 't1', 'old', 'h', 'member', 1, NULL);`);
    const tenants = createSqliteTenantStore(db, () => 1);
    expect(tenants.getUser("u1")?.email).toBeNull();
    expect(tenants.setEmail("u1", "old@example.com")).toBe("ok");
    createSqliteTenantStore(db, () => 1);
    expect(tenants.getUserByEmail("old@example.com")?.id).toBe("u1");
  });
});
