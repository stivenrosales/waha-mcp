import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTenantAdmin } from "../../src/application/tenantAdmin.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import { createAuthStore, openAuthDatabase } from "../../src/infrastructure/auth/store.js";
import { openCacheDatabase } from "../../src/infrastructure/cache/sqliteMessageStore.js";
import {
  createTenantCipher,
  generateDek,
  unwrapDek,
  wrapDek,
} from "../../src/infrastructure/crypto/envelope.js";
import { createSealedMissionLog } from "../../src/infrastructure/missions/sealedMissionLog.js";
import { createSqliteEventStore } from "../../src/infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "../../src/infrastructure/missions/sqliteMissionStore.js";
import { createSqliteScheduleStore } from "../../src/infrastructure/schedules/sqliteScheduleStore.js";
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
  const scheduleStore = createSqliteScheduleStore(db);
  const catchUps: string[] = [];
  const deps = {
    tenants,
    auth,
    missions: createSqliteMissionStore(db),
    events: createSqliteEventStore(db),
    schedules: {
      deleteForTenant: (id: string) => scheduleStore.deleteForTenant(id),
      catchUp: async (id: string, now: Date) => {
        catchUps.push(`${id}@${now.toISOString()}`);
      },
    },
    sessions,
    registry: { evict: (id: string) => void evicted.push(id) },
    newWrappedDek: (id: string) => wrapDek(KEK, generateDek(), id),
    dataDir,
    publicBaseUrl: "https://mcp.example.com/",
    logger: { info: (m: string) => void logs.push(m) },
    timezone: "America/Lima",
    now: () => T0,
  };
  const admin = createTenantAdmin(deps);
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
  return {
    deps,
    scheduleStore,
    catchUps,
    dataDir,
    db,
    tenants,
    auth,
    sessions,
    evicted,
    logs,
    admin,
    adminTenant,
    adminUser,
  };
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

  it("creates the session with the missions webhook only when one is configured", async () => {
    const off = await setup();
    const a = await off.admin.createInvite({ displayName: "Acme" });
    const sessionA = off.tenants.getTenant(a.tenantId)?.wahaSession as string;
    expect(off.sessions.createdWith.get(sessionA)).toBeUndefined();

    const s = await setup();
    const webhook = { url: "https://mcp.example.com/webhooks/waha", secret: "whsec-1" };
    const admin = createTenantAdmin({ ...s.deps, webhook });
    const b = await admin.createInvite({ displayName: "Beta" });
    const sessionB = s.tenants.getTenant(b.tenantId)?.wahaSession as string;
    expect(s.sessions.createdWith.get(sessionB)).toEqual({ webhook });
    expect(s.logs.join("\n")).not.toContain("whsec-1");
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

  it("restore lifts the tenant's mission reach-out pause and keeps other tenants'", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    const other = await onboard(s, "Other", true);
    const missions = s.deps.missions;
    missions.pause(tenantId, "2026-11-17T10:00:00.000Z", "2026-11-18T10:00:00.000Z");
    missions.pause(other.tenantId, "2026-11-17T10:00:00.000Z", "2026-11-18T10:00:00.000Z");
    s.admin.revoke(tenantId);
    s.admin.restore(tenantId);
    expect(missions.pausedUntil(tenantId, "2026-11-17T11:00:00.000Z")).toBeNull();
    expect(missions.pausedUntil(other.tenantId, "2026-11-17T11:00:00.000Z")).not.toBeNull();
  });

  it("restore catches up the scheduled messages of a tenant that is active again", async () => {
    const s = await setup();
    const full = await onboard(s, "Full", true);
    const noWa = await onboard(s, "NoWa", false);
    for (const id of [full.tenantId, noWa.tenantId]) s.admin.revoke(id);
    s.admin.restore(full.tenantId);
    s.admin.restore(noWa.tenantId);
    expect(s.catchUps).toEqual([`${full.tenantId}@${new Date(T0).toISOString()}`]);
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

  it("deletes the tenant's mission rows and its sealed mission log", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    const store = createSqliteMissionStore(s.db);
    const m = store.create({
      tenantId,
      chatId: "c",
      newContact: false,
      deadlineAt: "2026-11-20T00:00:00.000Z",
      expectsFiles: false,
    });
    const dir = path.join(s.dataDir, "tenants", tenantId);
    fs.mkdirSync(dir, { recursive: true });
    const cacheDb = openCacheDatabase(path.join(dir, "cache.db"));
    createSealedMissionLog(cacheDb, createTenantCipher(generateDek(), tenantId)).append(m.id, {
      kind: "prompt",
      at: "2026-11-17T10:00:00.000Z",
      body: "secret",
    });
    cacheDb.close();

    await s.admin.delete(tenantId, "Acme");

    expect(store.get(tenantId, m.id)).toBeNull();
    expect(fs.existsSync(path.join(dir, "cache.db"))).toBe(false);
  });

  it("deletes the tenant's scheduled messages and keeps other tenants'", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    const schedule = (tenant: string) =>
      s.scheduleStore.create({
        tenantId: tenant,
        chatId: "51911111111@c.us",
        kind: "fixed",
        repeat: "none",
        firstAt: "2026-11-18T14:00:00.000Z",
        nextRunAt: "2026-11-18T14:00:00.000Z",
        maxRuns: 1,
        newContact: false,
      });
    const mine = schedule(tenantId);
    const theirs = schedule(s.adminTenant.id);

    await s.admin.delete(tenantId, "Acme");

    expect(s.scheduleStore.get(tenantId, mine.id)).toBeNull();
    expect(s.scheduleStore.get(s.adminTenant.id, theirs.id)).not.toBeNull();
  });

  it("deletes the tenant's webhook events and mission pause, and keeps other tenants'", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    const missions = createSqliteMissionStore(s.db);
    const events = createSqliteEventStore(s.db);
    const event = (tenant: string, eventId: string) => ({
      tenantId: tenant,
      eventId,
      kind: "message" as const,
      receivedAt: "2026-11-17T10:00:00.000Z",
      payloadSealed: "sealed",
    });
    events.put(event(tenantId, "evt_1"));
    events.put(event(s.adminTenant.id, "evt_2"));
    missions.pause(tenantId, "2026-11-17T10:00:00.000Z", "2026-11-18T10:00:00.000Z");
    missions.pause(s.adminTenant.id, "2026-11-17T10:00:00.000Z", "2026-11-18T10:00:00.000Z");

    await s.admin.delete(tenantId, "Acme");

    const rows = s.db.prepare("SELECT tenant_id FROM webhook_events").all() as {
      tenant_id: string;
    }[];
    expect(rows.map((r) => r.tenant_id)).toEqual([s.adminTenant.id]);
    expect(missions.pausedUntil(tenantId, "2026-11-17T11:00:00.000Z")).toBeNull();
    expect(missions.pausedUntil(s.adminTenant.id, "2026-11-17T11:00:00.000Z")).not.toBeNull();
  });

  it("still cleans WAHA and the directory when deleting mission rows fails", async () => {
    const s = await setup();
    const { tenantId } = await onboard(s);
    const dir = path.join(s.dataDir, "tenants", tenantId);
    fs.mkdirSync(dir, { recursive: true });
    const session = s.tenants.getTenant(tenantId)?.wahaSession as string;
    const admin = createTenantAdmin({
      ...s.deps,
      missions: {
        deleteForTenant: () => {
          throw new Error("db locked");
        },
        resume: () => {},
      },
    });
    const out = await admin.delete(tenantId, "Acme");
    expect(out).toMatchObject({ whatsappCleanup: "ok", localCleanup: "failed" });
    expect(s.sessions.calls).toEqual(
      expect.arrayContaining([`logout:${session}`, `remove:${session}`]),
    );
    expect(fs.existsSync(dir)).toBe(false);
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
      missions: createSqliteMissionStore(s.db),
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

describe("transcriptionUsage", () => {
  // T0 is 2027-01-15T08:00:00Z, i.e. 03:00 on 2027-01-15 in Lima (UTC-5).
  const use = (tenantId: string, at: string, costUsd: number | null) => ({
    tenantId,
    at,
    model: "m",
    seconds: 10,
    costUsd,
  });

  it("defaults to the current month in the timezone", async () => {
    const { admin } = await setup();
    const report = await admin.transcriptionUsage({});
    expect(report.from).toBe("2027-01-01T05:00:00.000Z");
    expect(report.to).toBe(new Date(T0).toISOString());
    expect(report.tenants).toEqual([]);
    expect(report.total).toEqual({ count: 0, seconds: 0, costUsd: 0, rowsWithoutCost: 0 });
  });

  it("names tenants and totals them, keeping deleted tenants", async () => {
    const { admin, tenants, adminTenant } = await setup();
    const jose = tenants.createTenant({
      displayName: "Jose",
      wahaSession: "t_josejosejo",
      wrappedDek: "x",
    });
    tenants.recordTranscriptionUsage(use(adminTenant.id, "2027-01-10T12:00:00.000Z", 0.01));
    tenants.recordTranscriptionUsage(use(jose.id, "2027-01-11T12:00:00.000Z", 0.04));
    tenants.recordTranscriptionUsage(use("gone-tenant", "2027-01-12T12:00:00.000Z", null));
    const report = await admin.transcriptionUsage({ from: "2027-01-01", to: "2027-01-31" });
    expect(report.tenants.map((t) => [t.id, t.displayName])).toEqual([
      [jose.id, "Jose"],
      [adminTenant.id, "Owner"],
      ["gone-tenant", null],
    ]);
    expect(report.total.count).toBe(3);
    expect(report.total.seconds).toBe(30);
    expect(report.total.costUsd).toBeCloseTo(0.05, 10);
    expect(report.total.rowsWithoutCost).toBe(1);
  });

  it("filters one tenant", async () => {
    const { admin, tenants, adminTenant } = await setup();
    tenants.recordTranscriptionUsage(use(adminTenant.id, "2027-01-10T12:00:00.000Z", 0.01));
    tenants.recordTranscriptionUsage(use("other", "2027-01-10T12:00:00.000Z", 0.02));
    const report = await admin.transcriptionUsage({ tenantId: adminTenant.id });
    expect(report.tenants.map((t) => t.id)).toEqual([adminTenant.id]);
  });

  it("a to before the current month starts the range at that month", async () => {
    const { admin } = await setup();
    const report = await admin.transcriptionUsage({ to: "2026-10-15" });
    expect(report.from).toBe("2026-10-01T05:00:00.000Z");
    expect(report.to).toBe("2026-10-16T04:59:59.999Z");
  });

  it("rejects from after to", async () => {
    const { admin } = await setup();
    await expect(
      admin.transcriptionUsage({ from: "2027-01-10", to: "2027-01-01" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("toolUsage", () => {
  // T0 is 2027-01-15T08:00:00Z, i.e. 03:00 on 2027-01-15 in Lima (UTC-5).
  const call = (tenantId: string, at: string, tool: string, outcome = "ok") => ({
    tenantId,
    at,
    tool,
    outcome,
    ms: 5,
  });

  it("defaults to the current month in the timezone", async () => {
    const { admin } = await setup();
    const report = await admin.toolUsage({});
    expect(report.from).toBe("2027-01-01T05:00:00.000Z");
    expect(report.to).toBe(new Date(T0).toISOString());
    expect(report.tenants).toEqual([]);
    expect(report.total).toEqual({ calls: 0, errors: 0 });
  });

  it("groups tools per tenant, busiest tenant first, keeping deleted tenants", async () => {
    const { admin, tenants, adminTenant } = await setup();
    const jose = tenants.createTenant({
      displayName: "Jose",
      wahaSession: "t_josejosejo",
      wrappedDek: "x",
    });
    tenants.recordToolCall(call(adminTenant.id, "2027-01-10T12:00:00.000Z", "list_chats"));
    tenants.recordToolCall(call(jose.id, "2027-01-11T12:00:00.000Z", "list_chats"));
    tenants.recordToolCall(call(jose.id, "2027-01-12T12:00:00.000Z", "send_text", "Boom"));
    tenants.recordToolCall(call(jose.id, "2027-01-12T13:00:00.000Z", "list_chats"));
    tenants.recordToolCall(call("gone-tenant", "2027-01-09T12:00:00.000Z", "get_media"));
    const report = await admin.toolUsage({ from: "2027-01-01", to: "2027-01-31" });
    expect(report.tenants).toEqual([
      {
        id: jose.id,
        displayName: "Jose",
        calls: 3,
        errors: 1,
        lastAt: "2027-01-12T13:00:00.000Z",
        tools: [
          { tool: "list_chats", calls: 2, errors: 0, lastAt: "2027-01-12T13:00:00.000Z" },
          { tool: "send_text", calls: 1, errors: 1, lastAt: "2027-01-12T12:00:00.000Z" },
        ],
      },
      {
        id: adminTenant.id,
        displayName: "Owner",
        calls: 1,
        errors: 0,
        lastAt: "2027-01-10T12:00:00.000Z",
        tools: [{ tool: "list_chats", calls: 1, errors: 0, lastAt: "2027-01-10T12:00:00.000Z" }],
      },
      {
        id: "gone-tenant",
        displayName: null,
        calls: 1,
        errors: 0,
        lastAt: "2027-01-09T12:00:00.000Z",
        tools: [{ tool: "get_media", calls: 1, errors: 0, lastAt: "2027-01-09T12:00:00.000Z" }],
      },
    ]);
    expect(report.total).toEqual({ calls: 5, errors: 1 });
  });

  it("filters one tenant", async () => {
    const { admin, tenants, adminTenant } = await setup();
    tenants.recordToolCall(call(adminTenant.id, "2027-01-10T12:00:00.000Z", "a"));
    tenants.recordToolCall(call("other", "2027-01-10T12:00:00.000Z", "a"));
    const report = await admin.toolUsage({ tenantId: adminTenant.id });
    expect(report.tenants.map((t) => t.id)).toEqual([adminTenant.id]);
  });

  it("rejects from after to", async () => {
    const { admin } = await setup();
    await expect(admin.toolUsage({ from: "2027-01-10", to: "2027-01-01" })).rejects.toThrow(
      '"from" must not be later than "to".',
    );
  });
});
