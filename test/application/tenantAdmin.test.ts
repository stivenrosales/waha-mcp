import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTenantAdmin } from "../../src/application/tenantAdmin.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { createAuthStore, openAuthDatabase } from "../../src/infrastructure/auth/store.js";
import { generateDek, unwrapDek, wrapDek } from "../../src/infrastructure/crypto/envelope.js";
import { createSqliteTenantStore } from "../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../fakes/FakeSessionAdmin.js";

const KEK = Buffer.alloc(32, 5);
const T0 = 1_800_000_000_000;
const ADMIN_MESSAGE = "The admin tenant cannot be revoked, restored or deleted.";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-admin-"));
  dirs.push(dataDir);
  const db = openAuthDatabase(":memory:");
  const tenants = createSqliteTenantStore(db, () => T0);
  const auth = createAuthStore(db);
  const sessions = new FakeSessionAdmin();
  const evicted: string[] = [];
  const logs: string[] = [];
  const admin = createTenantAdmin({
    tenants,
    auth,
    sessions,
    registry: { evict: (id) => void evicted.push(id) },
    newWrappedDek: (id) => wrapDek(KEK, generateDek(), id),
    dataDir,
    publicBaseUrl: "https://mcp.example.com/",
    logger: { info: (m) => void logs.push(m) },
  });
  const adminTenant = tenants.createTenant({
    displayName: "Owner",
    wahaSession: "t_adminadmin",
    wrappedDek: "x",
  });
  const adminUser = (await tenants.createUser({
    tenantId: adminTenant.id,
    username: "admin",
    password: "correct horse battery",
    role: "admin",
  })) as { id: string };
  tenants.setStatus(adminTenant.id, "active");
  return { dataDir, db, tenants, auth, sessions, evicted, logs, admin, adminTenant, adminUser };
}

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

async function onboard(s: Awaited<ReturnType<typeof setup>>, name = "Acme", withWa = true) {
  const { tenantId } = await s.admin.createInvite({ displayName: name });
  const user = (await s.tenants.createUser({
    tenantId,
    username: `user-${name}`,
    password: "another long password",
    role: "member",
  })) as { id: string };
  if (withWa) {
    s.tenants.setWaId(tenantId, `51${name.length}@c.us`);
    s.tenants.setStatus(tenantId, "active");
  } else s.tenants.setStatus(tenantId, "pairing");
  return { tenantId, user };
}

describe("create_invite", () => {
  it("creates an invited tenant, a WAHA session and a /invite link valid for 72 h", async () => {
    const s = await setup();
    const out = await s.admin.createInvite({ displayName: "Acme" });
    const tenant = s.tenants.getTenant(out.tenantId);
    expect(tenant).toMatchObject({ displayName: "Acme", status: "invited" });
    expect(tenant?.wahaSession).toMatch(/^t_[a-z2-7]{10}$/);
    expect(s.sessions.calls).toContain(`create:${tenant?.wahaSession}`);
    expect(out.url).toBe(`https://mcp.example.com/invite/${tokenOf(out.url)}`);
    expect(out.expiresAt).toBe(new Date(T0 + 72 * 3600_000).toISOString());
    expect(s.tenants.peekLink(tokenOf(out.url), "invite")).toEqual({ tenantId: out.tenantId });
    // The stored DEK is wrapped for this tenant id.
    const wrapped = s.tenants.getWrappedDek(out.tenantId) as string;
    expect(unwrapDek(KEK, wrapped, out.tenantId)).toHaveLength(32);
    expect(s.logs).toContain(`admin create_invite tenant=${out.tenantId} outcome=ok`);
  });

  it("re-issue invalidates the previous link and keeps one WAHA session", async () => {
    const s = await setup();
    const first = await s.admin.createInvite({ displayName: "Acme" });
    const second = await s.admin.createInvite({ tenantId: first.tenantId });
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.url).not.toBe(first.url);
    expect(s.tenants.peekLink(tokenOf(first.url), "invite")).toBeNull();
    expect(s.tenants.peekLink(tokenOf(second.url), "invite")).not.toBeNull();
    expect(s.sessions.calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
  });

  it("refuses to re-issue for a tenant that already has a user", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    await expect(s.admin.createInvite({ tenantId })).rejects.toThrow(
      new InvalidInputError("This tenant already has a user; use reset_password."),
    );
  });

  it("removes the WAHA session when create throws after WAHA made it, keeping the original error", async () => {
    const s = await setup();
    s.sessions.create = async (name) => {
      s.sessions.calls.push(`create:${name}`);
      throw new Error("timeout");
    };
    s.sessions.remove = async (name) => {
      s.sessions.calls.push(`remove:${name}`);
      throw new Error("remove also failed");
    };
    await expect(s.admin.createInvite({ displayName: "Acme" })).rejects.toThrow("timeout");
    const created = s.sessions.calls.find((c) => c.startsWith("create:"));
    expect(s.sessions.calls).toContain(`remove:${created?.slice(7)}`);
    expect(s.tenants.listTenants()).toHaveLength(1);
  });

  it("requires exactly one of display_name and tenant_id", async () => {
    const s = await setup();
    await expect(s.admin.createInvite({})).rejects.toBeInstanceOf(InvalidInputError);
    await expect(s.admin.createInvite({ displayName: "A", tenantId: "x" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(s.admin.createInvite({ tenantId: "nope" })).rejects.toThrow("Tenant not found.");
  });

  it("leaves no tenant behind when the WAHA session cannot be created", async () => {
    const s = await setup();
    s.sessions.create = async () => {
      throw new Error("boom");
    };
    await expect(s.admin.createInvite({ displayName: "Acme" })).rejects.toThrow("boom");
    expect(s.tenants.listTenants()).toHaveLength(1);
    expect(s.logs.at(-1)).toMatch(/^admin create_invite tenant=\S+ outcome=error$/);
  });
});

describe("revoke / restore", () => {
  it("revoke marks the tenant revoked, kills its tokens and evicts its runtime", async () => {
    const s = await setup();
    const { tenantId, user } = await onboard(s);
    const client = s.auth.registerClient({ redirectUris: ["https://x.example/cb"] });
    const tokens = s.auth.issueTokens(client.clientId, "mcp", user.id);
    expect(s.auth.verifyAccessToken(tokens.accessToken)).not.toBeNull();

    s.admin.revoke(tenantId);

    expect(s.tenants.getTenant(tenantId)?.status).toBe("revoked");
    expect(s.auth.verifyAccessToken(tokens.accessToken)).toBeNull();
    expect(s.evicted).toContain(tenantId);
    s.admin.revoke(tenantId); // idempotent
    expect(s.tenants.getTenant(tenantId)?.status).toBe("revoked");
  });

  it("restore goes to active, pairing or invited depending on how far onboarding got", async () => {
    const s = await setup();
    const full = await onboard(s, "Full", true);
    const noWa = await onboard(s, "NoWa", false);
    const fresh = await s.admin.createInvite({ displayName: "Fresh" });
    for (const id of [full.tenantId, noWa.tenantId, fresh.tenantId]) s.admin.revoke(id);
    expect(s.admin.restore(full.tenantId)).toBe("active");
    expect(s.admin.restore(noWa.tenantId)).toBe("pairing");
    expect(s.admin.restore(fresh.tenantId)).toBe("invited");
    expect(s.tenants.getTenant(full.tenantId)?.status).toBe("active");
    expect(s.tenants.getTenant(noWa.tenantId)?.status).toBe("pairing");
    expect(s.tenants.getTenant(fresh.tenantId)?.status).toBe("invited");
  });

  it("refuses an id that is not id-shaped and never logs it", async () => {
    const s = await setup();
    const evil = "x outcome=ok\nadmin delete_tenant tenant=y";
    expect(() => s.admin.revoke(evil)).toThrow(new InvalidInputError("Invalid tenant id."));
    expect(s.logs.at(-1)).toBe("admin revoke_tenant tenant=- outcome=error");
    expect(() => s.admin.restore(evil)).toThrow(new InvalidInputError("Invalid tenant id."));
    expect(s.logs.at(-1)).toBe("admin restore_tenant tenant=- outcome=error");
    expect(() => s.admin.resetPassword(evil)).toThrow(new InvalidInputError("Invalid tenant id."));
    expect(s.logs.at(-1)).toBe("admin reset_password tenant=- outcome=error");
  });

  it("refuses the admin tenant for revoke, restore and delete", async () => {
    const s = await setup();
    const id = s.adminTenant.id;
    expect(() => s.admin.revoke(id)).toThrow(new InvalidInputError(ADMIN_MESSAGE));
    expect(() => s.admin.restore(id)).toThrow(new InvalidInputError(ADMIN_MESSAGE));
    await expect(s.admin.delete(id, "Owner")).rejects.toThrow(new InvalidInputError(ADMIN_MESSAGE));
    expect(s.tenants.getTenant(id)?.status).toBe("active");
  });
});

describe("reset_password", () => {
  it("issues a /reset link and invalidates the previous one", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    const a = s.admin.resetPassword(tenantId);
    const b = s.admin.resetPassword(tenantId);
    expect(a.url).toMatch(/^https:\/\/mcp\.example\.com\/reset\/[A-Za-z0-9_-]+$/);
    expect(s.tenants.peekLink(tokenOf(a.url), "reset")).toBeNull();
    expect(s.tenants.peekLink(tokenOf(b.url), "reset")).toEqual({ tenantId });
    expect(b.expiresAt).toBe(new Date(T0 + 72 * 3600_000).toISOString());
  });

  it("refuses a tenant without a user", async () => {
    const s = await setup();
    const { tenantId } = await s.admin.createInvite({ displayName: "Acme" });
    expect(() => s.admin.resetPassword(tenantId)).toThrow(InvalidInputError);
  });
});

describe("delete_tenant", () => {
  it("with the wrong name deletes nothing", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    const dir = path.join(s.dataDir, "tenants", tenantId);
    fs.mkdirSync(dir, { recursive: true });
    await expect(s.admin.delete(tenantId, "acme")).rejects.toBeInstanceOf(InvalidInputError);
    expect(s.tenants.getTenant(tenantId)).not.toBeNull();
    expect(fs.existsSync(dir)).toBe(true);
    expect(s.sessions.calls.some((c) => c.startsWith("remove:"))).toBe(false);
  });

  it("removes row, DEK, user tokens, runtime, WAHA session and the data directory", async () => {
    const s = await setup();
    const { tenantId, user } = await onboard(s);
    const session = s.tenants.getTenant(tenantId)?.wahaSession as string;
    const dir = path.join(s.dataDir, "tenants", tenantId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "messages.db"), "x");
    const client = s.auth.registerClient({ redirectUris: ["https://x.example/cb"] });
    const tokens = s.auth.issueTokens(client.clientId, "mcp", user.id);

    const out = await s.admin.delete(tenantId, "Acme");

    expect(out).toEqual({ whatsappCleanup: "ok", localCleanup: "ok" });
    expect(s.tenants.getTenant(tenantId)).toBeNull();
    expect(s.tenants.getWrappedDek(tenantId)).toBeNull();
    expect(s.tenants.getUser(user.id)).toBeNull();
    expect(s.auth.verifyAccessToken(tokens.accessToken)).toBeNull();
    expect(s.evicted).toContain(tenantId);
    expect(s.sessions.calls).toEqual(
      expect.arrayContaining([`logout:${session}`, `remove:${session}`]),
    );
    expect(fs.existsSync(dir)).toBe(false);
    expect(s.logs).toContain(`admin delete_tenant tenant=${tenantId} outcome=ok`);
  });

  it("still finishes local deletion when WAHA fails and reports it", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    s.sessions.logout = async () => {
      throw new Error("waha down");
    };
    const dir = path.join(s.dataDir, "tenants", tenantId);
    fs.mkdirSync(dir, { recursive: true });
    const session = s.tenants.getTenant(tenantId)?.wahaSession as string;
    const out = await s.admin.delete(tenantId, "Acme");
    expect(out).toEqual({ whatsappCleanup: "failed", localCleanup: "ok", wahaSession: session });
    expect(s.tenants.getTenant(tenantId)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
    // One non-secret line per failed step, naming the WAHA session to clean up by hand.
    expect(s.logs).toContain(
      `admin delete_tenant tenant=${tenantId} session=${session} step=waha_logout outcome=failed`,
    );
    expect(s.logs.filter((l) => l.includes("step="))).toHaveLength(1);
    expect(s.logs.join("\n")).not.toContain("waha down");
  });

  it("never touches the filesystem outside tenants/ for an unsafe id", async () => {
    const s = await setup();
    const outside = path.join(s.dataDir, "keep");
    fs.mkdirSync(outside);
    await expect(s.admin.delete("../keep", "x")).rejects.toThrow(
      new InvalidInputError("Invalid tenant id."),
    );
    expect(fs.existsSync(outside)).toBe(true);
    expect(s.logs.at(-1)).toBe("admin delete_tenant tenant=- outcome=error");
  });

  it("reports local cleanup failures instead of throwing once the row is gone", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    const logs: string[] = [];
    const session = s.tenants.getTenant(tenantId)?.wahaSession as string;
    const boom = createTenantAdmin({
      tenants: s.tenants,
      auth: s.auth,
      sessions: s.sessions,
      registry: {
        evict: () => {
          throw new Error("evict failed");
        },
      },
      newWrappedDek: () => "x",
      dataDir: s.dataDir,
      publicBaseUrl: "https://mcp.example.com",
      logger: { info: (m) => void logs.push(m) },
    });
    const out = await boom.delete(tenantId, "Acme");
    expect(out).toEqual({ whatsappCleanup: "ok", localCleanup: "failed", wahaSession: session });
    expect(s.tenants.getTenant(tenantId)).toBeNull();
    expect(logs).toContain(
      `admin delete_tenant tenant=${tenantId} session=${session} step=evict outcome=failed`,
    );
  });
});

describe("list_tenants", () => {
  it("lists status, WhatsApp state, dates and admin flag, and nothing else", async () => {
    const s = await setup();
    const { tenantId, user } = await onboard(s);
    const session = s.tenants.getTenant(tenantId)?.wahaSession as string;
    s.sessions.setState(session, "WORKING");
    s.tenants.touchLogin(user.id);

    const list = await s.admin.listTenants();

    expect(list).toHaveLength(2);
    const owner = list.find((t) => t.isAdmin);
    expect(owner).toMatchObject({ displayName: "Owner", status: "active", lastLoginAt: null });
    const acme = list.find((t) => t.id === tenantId);
    expect(acme).toMatchObject({
      displayName: "Acme",
      status: "active",
      whatsapp: "WORKING",
      isAdmin: false,
    });
    expect(acme?.createdAt).toBe(new Date(T0).toISOString());
    expect(acme?.lastLoginAt).not.toBeNull();
    expect(Object.keys(acme as object).sort()).toEqual(
      ["createdAt", "displayName", "id", "isAdmin", "lastLoginAt", "status", "whatsapp"].sort(),
    );
  });

  it("reports UNKNOWN when WAHA cannot tell", async () => {
    const s = await setup();
    s.sessions.state = async () => {
      throw new Error("down");
    };
    const list = await s.admin.listTenants();
    expect(list[0]?.whatsapp).toBe("UNKNOWN");
  });
});
