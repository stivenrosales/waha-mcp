import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";

const T0 = 1_800_000_000_000;
const HOUR = 3600_000;

function setup() {
  let t = T0;
  const db = openAuthDatabase(":memory:");
  const store = createSqliteTenantStore(db, () => t);
  const tenant = store.createTenant({
    displayName: "Acme",
    wahaSession: "t_aaaaaaaaaa",
    wrappedDek: "v1.wrapped",
  });
  return {
    db,
    store,
    tenant,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("sqlite tenant store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("creates and reads tenants, wrapped DEK and status", () => {
    const { store, tenant } = setup();
    expect(tenant).toMatchObject({
      wahaSession: "t_aaaaaaaaaa",
      displayName: "Acme",
      status: "invited",
      waId: null,
      createdAt: T0,
    });
    expect(store.getTenant(tenant.id)).toEqual(tenant);
    expect(store.getTenant("missing")).toBeNull();
    expect(store.listTenants()).toEqual([tenant]);
    expect(store.getWrappedDek(tenant.id)).toBe("v1.wrapped");
    store.setWrappedDek(tenant.id, "v1.other");
    expect(store.getWrappedDek(tenant.id)).toBe("v1.other");
    store.setStatus(tenant.id, "active");
    expect(store.getTenant(tenant.id)?.status).toBe("active");
  });

  it("createUser returns username_taken for a duplicate, case-insensitively", async () => {
    const { store, tenant } = setup();
    const other = store.createTenant({
      displayName: "B",
      wahaSession: "t_bbbbbbbbbb",
      wrappedDek: "x",
    });
    const user = await store.createUser({
      tenantId: tenant.id,
      username: "Alice",
      password: "a-long-password-1",
      role: "member",
    });
    expect(user).toMatchObject({
      tenantId: tenant.id,
      username: "Alice",
      role: "member",
      lastLoginAt: null,
    });
    expect(
      await store.createUser({
        tenantId: other.id,
        username: "alice",
        password: "a-long-password-2",
        role: "member",
      }),
    ).toBe("username_taken");
  });

  it("verifyPassword returns null for unknown user and wrong password", async () => {
    const { store, tenant } = setup();
    await store.createUser({
      tenantId: tenant.id,
      username: "alice",
      password: "right-password-1",
      role: "admin",
    });
    expect(await store.verifyPassword("nobody", "right-password-1")).toBeNull();
    expect(await store.verifyPassword("alice", "wrong-password-1")).toBeNull();
    const ok = await store.verifyPassword("ALICE", "right-password-1");
    expect(ok).toMatchObject({ username: "alice", role: "admin" });
  });

  it("setPassword replaces the password; touchLogin, getUser, getUserByTenant, getAdmin work", async () => {
    const { store, tenant, advance } = setup();
    const user = await store.createUser({
      tenantId: tenant.id,
      username: "alice",
      password: "old-password-123",
      role: "admin",
    });
    if (user === "username_taken") throw new Error("unexpected");
    await store.setPassword(user.id, "new-password-123");
    expect(await store.verifyPassword("alice", "old-password-123")).toBeNull();
    expect(await store.verifyPassword("alice", "new-password-123")).not.toBeNull();
    advance(5000);
    store.touchLogin(user.id);
    expect(store.getUser(user.id)?.lastLoginAt).toBe(T0 + 5000);
    expect(store.getUserByTenant(tenant.id)?.id).toBe(user.id);
    expect(store.getAdmin()?.id).toBe(user.id);
    expect(store.getUser("missing")).toBeNull();
    expect(store.getUserByTenant("missing")).toBeNull();
  });

  it("consumeLink works once", () => {
    const { store, tenant } = setup();
    const { token } = store.issueLink(tenant.id, "invite", HOUR);
    expect(store.peekLink(token, "invite")).toEqual({ tenantId: tenant.id });
    expect(store.consumeLink(token, "invite")).toEqual({ tenantId: tenant.id });
    expect(store.consumeLink(token, "invite")).toBeNull();
    expect(store.peekLink(token, "invite")).toBeNull();
  });

  it("two consumers of one token on one DB file yield exactly one non-null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-tenants-"));
    dirs.push(dir);
    const file = path.join(dir, "auth.db");
    const a = createSqliteTenantStore(openAuthDatabase(file), () => T0);
    const b = createSqliteTenantStore(openAuthDatabase(file), () => T0);
    const tenant = a.createTenant({
      displayName: "A",
      wahaSession: "t_cccccccccc",
      wrappedDek: "x",
    });
    const { token } = a.issueLink(tenant.id, "invite", HOUR);
    const results = [a.consumeLink(token, "invite"), b.consumeLink(token, "invite")];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("expired link returns null", () => {
    const { store, tenant, advance } = setup();
    const { token, expiresAt } = store.issueLink(tenant.id, "invite", HOUR);
    expect(expiresAt).toBe(T0 + HOUR);
    advance(HOUR);
    expect(store.peekLink(token, "invite")).toBeNull();
    expect(store.consumeLink(token, "invite")).toBeNull();
  });

  it("issueLink invalidates the previous link of that tenant and kind only", () => {
    const { store, tenant } = setup();
    const first = store.issueLink(tenant.id, "invite", HOUR);
    const reset = store.issueLink(tenant.id, "reset", HOUR);
    const second = store.issueLink(tenant.id, "invite", HOUR);
    expect(store.consumeLink(first.token, "invite")).toBeNull();
    expect(store.consumeLink(second.token, "invite")).toEqual({ tenantId: tenant.id });
    expect(store.consumeLink(reset.token, "reset")).toEqual({ tenantId: tenant.id });
  });

  it("transitionStatus changes the status only from the expected one", () => {
    const { store, tenant } = setup();
    expect(store.transitionStatus(tenant.id, "pairing", "active")).toBe(false);
    expect(store.getTenant(tenant.id)?.status).toBe("invited");
    expect(store.transitionStatus(tenant.id, "invited", "pairing")).toBe(true);
    expect(store.getTenant(tenant.id)?.status).toBe("pairing");
    expect(store.transitionStatus("missing", "invited", "pairing")).toBe(false);
  });

  it("linkState tells valid, used and expired links apart", () => {
    const { store, tenant, advance } = setup();
    const used = store.issueLink(tenant.id, "reset", HOUR);
    const { token } = store.issueLink(tenant.id, "invite", HOUR);
    expect(store.linkState(token, "invite")).toEqual({ tenantId: tenant.id, state: "valid" });
    expect(store.linkState(token, "reset")).toBeNull();
    expect(store.linkState("unknown", "invite")).toBeNull();
    store.consumeLink(used.token, "reset");
    expect(store.linkState(used.token, "reset")).toEqual({ tenantId: tenant.id, state: "used" });
    advance(HOUR);
    expect(store.linkState(token, "invite")).toEqual({ tenantId: tenant.id, state: "expired" });
  });

  it("an invite token never consumes as a reset", () => {
    const { store, tenant } = setup();
    const { token } = store.issueLink(tenant.id, "invite", HOUR);
    expect(store.peekLink(token, "reset")).toBeNull();
    expect(store.consumeLink(token, "reset")).toBeNull();
    expect(store.consumeLink(token, "invite")).not.toBeNull();
  });

  it("setWaId returns taken for a waId held by another tenant", () => {
    const { store, tenant } = setup();
    const other = store.createTenant({
      displayName: "B",
      wahaSession: "t_dddddddddd",
      wrappedDek: "x",
    });
    expect(store.setWaId(tenant.id, "5491100000000@c.us")).toBe("ok");
    expect(store.setWaId(tenant.id, "5491100000000@c.us")).toBe("ok");
    expect(store.setWaId(other.id, "5491100000000@c.us")).toBe("taken");
    expect(store.getTenant(tenant.id)?.waId).toBe("5491100000000@c.us");
    expect(store.getTenant(other.id)?.waId).toBeNull();
  });

  it("deleteTenant removes the tenant, its user and links", async () => {
    const { store, tenant, db } = setup();
    await store.createUser({
      tenantId: tenant.id,
      username: "alice",
      password: "a-long-password-1",
      role: "member",
    });
    store.issueLink(tenant.id, "invite", HOUR);
    store.deleteTenant(tenant.id);
    expect(store.getTenant(tenant.id)).toBeNull();
    expect(store.getUserByTenant(tenant.id)).toBeNull();
    expect(await store.verifyPassword("alice", "a-long-password-1")).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(0);
  });

  it("stores only the hash of a link token and no raw password", async () => {
    const { store, tenant, db } = setup();
    await store.createUser({
      tenantId: tenant.id,
      username: "alice",
      password: "plain-secret-pw-1",
      role: "member",
    });
    const { token } = store.issueLink(tenant.id, "invite", HOUR);
    const dump = JSON.stringify([
      ...db.prepare("SELECT * FROM invites").all(),
      ...db.prepare("SELECT * FROM users").all(),
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("plain-secret-pw-1");
    const row = db.prepare("SELECT hash FROM invites").get() as { hash: string };
    expect(row.hash).not.toBe(token);
  });
});
