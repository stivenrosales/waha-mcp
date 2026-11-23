import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBilling, GRACE_MS, SUSPENDED_DELETE_MS } from "../../src/application/billing.js";
import { createTenantAdmin } from "../../src/application/tenantAdmin.js";
import { createAuthStore, openAuthDatabase } from "../../src/infrastructure/auth/store.js";
import { createSqliteBillingStore } from "../../src/infrastructure/billing/sqliteBillingStore.js";
import { generateDek, wrapDek } from "../../src/infrastructure/crypto/envelope.js";
import { createSqliteMissionStore } from "../../src/infrastructure/missions/sqliteMissionStore.js";
import { createSqliteTenantStore } from "../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../fakes/FakeSessionAdmin.js";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "waha-billing-"));
  dirs.push(dataDir);
  let now = T0;
  const clock = () => now;
  const db = openAuthDatabase(":memory:");
  const tenants = createSqliteTenantStore(db, clock);
  const auth = createAuthStore(db);
  const sessions = new FakeSessionAdmin();
  const evicted: string[] = [];
  const logs: string[] = [];
  const logger = { info: (m: string) => void logs.push(m) };
  const admin = createTenantAdmin({
    tenants,
    auth,
    missions: createSqliteMissionStore(db),
    sessions,
    registry: { evict: (id: string) => void evicted.push(id) },
    newWrappedDek: (id: string) => wrapDek(Buffer.alloc(32, 5), generateDek(), id),
    dataDir,
    publicBaseUrl: "https://mcp.example.com/",
    logger,
    now: clock,
  });
  const owner = tenants.createTenant({
    displayName: "Owner",
    wahaSession: "t_adminadmin",
    wrappedDek: "x",
  });
  await tenants.createUser({
    tenantId: owner.id,
    username: "admin",
    password: "correct horse battery",
    role: "admin",
  });
  tenants.setStatus(owner.id, "active");

  const store = createSqliteBillingStore(db);
  const billing = createBilling({ store, tenants, admin, sessions, logger, now: clock });

  const { tenantId } = await admin.createInvite({ displayName: "Acme" });
  const user = (await tenants.createUser({
    tenantId,
    username: "acme",
    password: "another long password",
    role: "member",
  })) as { id: string };
  tenants.setWaId(tenantId, "51999@c.us");
  tenants.setStatus(tenantId, "active");
  fs.mkdirSync(path.join(dataDir, "tenants", tenantId), { recursive: true });
  const session = tenants.getTenant(tenantId)?.wahaSession as string;
  return {
    db,
    tenants,
    auth,
    sessions,
    evicted,
    logs,
    store,
    billing,
    owner,
    tenantId,
    user,
    session,
    dataDir,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("billing lifecycle", () => {
  it("keeps a tenant usable for the 3-day grace after a failed payment", async () => {
    const s = await setup();
    s.billing.paymentSucceeded(s.tenantId);
    s.billing.paymentFailed(s.tenantId);
    expect(s.store.get(s.tenantId)).toEqual({ tenantId: s.tenantId, state: "past_due", since: T0 });
    s.advance(GRACE_MS - 1);
    await s.billing.sweep();
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("active");
    expect(s.sessions.calls).not.toContain(`logout:${s.session}`);
    expect(GRACE_MS).toBe(3 * DAY);
  });

  it("a second failed payment does not restart the grace period", async () => {
    const s = await setup();
    s.billing.paymentFailed(s.tenantId);
    s.advance(DAY);
    s.billing.paymentFailed(s.tenantId);
    expect(s.store.get(s.tenantId)?.since).toBe(T0);
  });

  it("after the grace, logs WhatsApp out, revokes the tenant and its logins", async () => {
    const s = await setup();
    s.billing.paymentFailed(s.tenantId);
    s.advance(GRACE_MS);
    await s.billing.sweep();
    expect(s.sessions.calls).toContain(`logout:${s.session}`);
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("revoked");
    expect(s.evicted).toContain(s.tenantId);
    expect(s.store.get(s.tenantId)).toEqual({
      tenantId: s.tenantId,
      state: "suspended",
      since: T0 + GRACE_MS,
    });
    expect(s.logs).toContain(`billing suspend tenant=${s.tenantId} whatsapp=logged_out outcome=ok`);
  });

  it("suspends even when the WhatsApp logout fails, and says so", async () => {
    const s = await setup();
    s.sessions.logout = async () => {
      throw new Error("WAHA down");
    };
    s.billing.paymentFailed(s.tenantId);
    s.advance(GRACE_MS);
    await s.billing.sweep();
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("revoked");
    expect(s.logs).toContain(`billing suspend tenant=${s.tenantId} whatsapp=failed outcome=ok`);
  });

  it("deletes the tenant and its data 30 days after the suspension", async () => {
    const s = await setup();
    s.billing.paymentFailed(s.tenantId);
    s.advance(GRACE_MS);
    await s.billing.sweep();
    s.advance(SUSPENDED_DELETE_MS - 1);
    await s.billing.sweep();
    expect(s.tenants.getTenant(s.tenantId)).not.toBeNull();
    s.advance(1);
    await s.billing.sweep();
    expect(SUSPENDED_DELETE_MS).toBe(30 * DAY);
    expect(s.tenants.getTenant(s.tenantId)).toBeNull();
    expect(s.sessions.calls).toContain(`remove:${s.session}`);
    expect(fs.existsSync(path.join(s.dataDir, "tenants", s.tenantId))).toBe(false);
    expect(s.store.get(s.tenantId)).toBeNull();
    expect(s.logs).toContain(`billing delete tenant=${s.tenantId} outcome=ok`);
  });

  it("a payment during the grace returns the tenant to normal", async () => {
    const s = await setup();
    s.billing.paymentFailed(s.tenantId);
    s.advance(DAY);
    s.billing.paymentSucceeded(s.tenantId);
    s.advance(GRACE_MS);
    await s.billing.sweep();
    expect(s.store.get(s.tenantId)?.state).toBe("active");
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("active");
  });

  it("a payment while suspended restores the tenant, which then re-pairs", async () => {
    const s = await setup();
    s.billing.paymentFailed(s.tenantId);
    s.advance(GRACE_MS);
    await s.billing.sweep();
    s.billing.paymentSucceeded(s.tenantId);
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("active");
    expect(s.store.get(s.tenantId)?.state).toBe("active");
    s.advance(SUSPENDED_DELETE_MS);
    await s.billing.sweep();
    expect(s.tenants.getTenant(s.tenantId)).not.toBeNull();
  });

  it("never touches tenants without billing, nor the admin tenant", async () => {
    const s = await setup();
    s.billing.paymentFailed(s.owner.id);
    expect(s.store.get(s.owner.id)).toBeNull();
    s.advance(SUSPENDED_DELETE_MS * 2);
    await s.billing.sweep();
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("active");
    expect(s.tenants.getTenant(s.owner.id)?.status).toBe("active");
    expect(s.sessions.calls.filter((c) => c.startsWith("logout:"))).toEqual([]);
  });

  it("drops the billing record of a tenant deleted by hand", async () => {
    const s = await setup();
    s.billing.paymentFailed(s.tenantId);
    s.tenants.deleteTenant(s.tenantId);
    await s.billing.sweep();
    expect(s.store.get(s.tenantId)).toBeNull();
  });
  it("does not delete a suspended tenant the admin restored by hand", async () => {
    const s = await setup();
    s.billing.paymentFailed(s.tenantId);
    s.advance(GRACE_MS);
    await s.billing.sweep();
    s.tenants.transitionStatus(s.tenantId, "revoked", "active");
    s.advance(SUSPENDED_DELETE_MS);
    await s.billing.sweep();
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("active");
    expect(s.store.get(s.tenantId)?.state).toBe("active");
  });

  it("keeps a payment that arrives while the sweep waits on WhatsApp", async () => {
    const s = await setup();
    let release = () => {};
    s.sessions.logout = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    s.billing.paymentFailed(s.tenantId);
    s.advance(GRACE_MS);
    const sweeping = s.billing.sweep();
    await Promise.resolve();
    s.billing.paymentSucceeded(s.tenantId);
    release();
    await sweeping;
    expect(s.store.get(s.tenantId)?.state).toBe("active");
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("active");
  });
  it("ends access at once when the subscription ends, and deletes 30 days later", async () => {
    const s = await setup();
    s.billing.paymentSucceeded(s.tenantId);
    await s.billing.endAccess(s.tenantId);
    expect(s.sessions.calls).toContain(`logout:${s.session}`);
    expect(s.tenants.getTenant(s.tenantId)?.status).toBe("revoked");
    expect(s.store.get(s.tenantId)).toEqual({
      tenantId: s.tenantId,
      state: "suspended",
      since: T0,
    });
    await s.billing.endAccess(s.tenantId);
    expect(s.sessions.calls.filter((c) => c.startsWith("logout:"))).toHaveLength(1);
    s.advance(SUSPENDED_DELETE_MS);
    await s.billing.sweep();
    expect(s.tenants.getTenant(s.tenantId)).toBeNull();
    await s.billing.endAccess(s.owner.id);
    expect(s.tenants.getTenant(s.owner.id)?.status).toBe("active");
  });
});
