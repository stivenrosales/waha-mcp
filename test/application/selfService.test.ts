import { describe, expect, it } from "vitest";
import { createSelfService } from "../../src/application/selfService.js";
import { InvalidInputError } from "../../src/domain/errors.js";
import type { CacheData } from "../../src/domain/ports/CacheData.js";
import { openAuthDatabase } from "../../src/infrastructure/auth/store.js";
import { createSqliteTenantStore } from "../../src/infrastructure/tenants/sqliteTenantStore.js";
import { FakeSessionAdmin } from "../fakes/FakeSessionAdmin.js";

const NOW = new Date("2026-11-21T12:00:00.000Z");

async function world(opts: { logoutFails?: boolean } = {}) {
  const tenants = createSqliteTenantStore(openAuthDatabase(":memory:"));
  const add = async (name: string) => {
    const t = tenants.createTenant({
      displayName: name,
      wahaSession: `t_${name}`,
      wrappedDek: "x",
    });
    tenants.setStatus(t.id, "active");
    const user = await tenants.createUser({
      tenantId: t.id,
      username: name.toLowerCase(),
      password: "a long enough password",
      role: "member",
    });
    if (user === "username_taken") throw new Error("taken");
    return { tenant: t, user };
  };
  const alice = await add("Alice");
  const bob = await add("Bob");
  const sessions = new FakeSessionAdmin();
  if (opts.logoutFails)
    sessions.logout = async (name: string) => {
      sessions.calls.push(`logout:${name}`);
      throw new Error("waha down");
    };
  const revoked: string[] = [];
  const evicted: string[] = [];
  const history: string[] = [];
  const lines: string[] = [];
  const service = createSelfService({
    tenants,
    auth: { revokeUser: (id) => revoked.push(id) },
    sessions,
    registry: { evict: (id) => evicted.push(id) },
    history: {
      purgeTenantHistory: (tenantId, now) => {
        history.push(`${tenantId}@${now.toISOString()}`);
        return { missions: 2, schedules: 1 };
      },
    },
    logger: { info: (m) => lines.push(m) },
    now: () => NOW,
  });
  const wiped: string[] = [];
  const cacheOf = (name: string): Pick<CacheData, "wipe"> => ({
    wipe: () => {
      wiped.push(name);
      return { messages: 5, transcripts: 3 };
    },
  });
  return {
    tenants,
    alice,
    bob,
    sessions,
    revoked,
    evicted,
    history,
    lines,
    service,
    wiped,
    cacheOf,
  };
}

describe("self service", () => {
  it("deleteMyData wipes only the caller's cache and history, and reports the counts", async () => {
    const w = await world();
    const report = await w.service.forTenant(w.alice.tenant.id, w.cacheOf("Alice")).deleteMyData();
    expect(report).toEqual({ messages: 5, transcripts: 3, missions: 2, schedules: 1 });
    expect(w.wiped).toEqual(["Alice"]);
    expect(w.history).toEqual([`${w.alice.tenant.id}@${NOW.toISOString()}`]);
    // Nothing else is touched: no sign-out, no WhatsApp logout, no eviction.
    expect(w.revoked).toEqual([]);
    expect(w.sessions.calls).toEqual([]);
    expect(w.evicted).toEqual([]);
    expect(w.lines).toEqual([
      `self delete_my_data tenant=${w.alice.tenant.id} messages=5 transcripts=3 missions=2 schedules=1 outcome=ok`,
    ]);
  });

  it("deleteMyData without mission history wiring still wipes the cache", async () => {
    const w = await world();
    const service = createSelfService({
      tenants: w.tenants,
      auth: { revokeUser: () => {} },
      sessions: w.sessions,
      registry: { evict: () => {} },
      logger: { info: () => {} },
    });
    const report = await service.forTenant(w.bob.tenant.id, w.cacheOf("Bob")).deleteMyData();
    expect(report).toEqual({ messages: 5, transcripts: 3, missions: 0, schedules: 0 });
    expect(w.wiped).toEqual(["Bob"]);
  });

  it("unlink logs out only the caller's WhatsApp session, signs out only its user, drops its runtime", async () => {
    const w = await world();
    const report = await w.service.forTenant(w.bob.tenant.id, w.cacheOf("Bob")).unlink();
    expect(report).toEqual({ whatsapp: "logged_out", signedOut: true });
    expect(w.sessions.calls).toEqual(["logout:t_Bob"]);
    expect(w.revoked).toEqual([w.bob.user.id]);
    expect(w.evicted).toEqual([w.bob.tenant.id]);
    // The account stays: it can sign in at /pair and link WhatsApp again.
    expect(w.tenants.getTenant(w.bob.tenant.id)?.status).toBe("active");
    expect(w.tenants.getTenant(w.alice.tenant.id)?.status).toBe("active");
    expect(w.wiped).toEqual([]);
    expect(w.lines).toEqual([
      `self unlink_account tenant=${w.bob.tenant.id} whatsapp=logged_out outcome=ok`,
    ]);
  });

  it("unlink still signs out when WAHA cannot log the session out, and says so", async () => {
    const w = await world({ logoutFails: true });
    const report = await w.service.forTenant(w.bob.tenant.id, w.cacheOf("Bob")).unlink();
    expect(report).toEqual({ whatsapp: "failed", signedOut: true });
    expect(w.revoked).toEqual([w.bob.user.id]);
    expect(w.evicted).toEqual([w.bob.tenant.id]);
    // Never the error text (it may name the WAHA URL).
    expect(w.lines.join("\n")).not.toContain("waha down");
  });

  it("an unknown tenant is refused and nothing is done", async () => {
    const w = await world();
    const self = w.service.forTenant("nope", w.cacheOf("x"));
    await expect(self.unlink()).rejects.toBeInstanceOf(InvalidInputError);
    await expect(self.deleteMyData()).rejects.toBeInstanceOf(InvalidInputError);
    expect(w.sessions.calls).toEqual([]);
    expect(w.revoked).toEqual([]);
    expect(w.wiped).toEqual([]);
  });
});
