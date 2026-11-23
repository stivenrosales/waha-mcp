import { describe, expect, it } from "vitest";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

function setup() {
  let now = T0;
  const db = openAuthDatabase(":memory:");
  const auth = createAuthStore(db, () => now);
  return { db, auth, advance: (ms: number) => (now += ms) };
}

describe("panel sessions", () => {
  it("returns the user of a live token and nothing for unknown ones", () => {
    const s = setup();
    const token = s.auth.createPanelSession("u1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.auth.getPanelSession(token)).toEqual({ userId: "u1" });
    expect(s.auth.getPanelSession("nope")).toBeNull();
  });

  it("stores only a hash of the token", () => {
    const s = setup();
    const token = s.auth.createPanelSession("u1");
    const rows = s.db.prepare("SELECT * FROM panel_sessions").all();
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("expires after 12 hours", () => {
    const s = setup();
    const token = s.auth.createPanelSession("u1");
    s.advance(12 * HOUR - 1);
    expect(s.auth.getPanelSession(token)).toEqual({ userId: "u1" });
    s.advance(1);
    expect(s.auth.getPanelSession(token)).toBeNull();
  });

  it("is deleted on logout, revokeUser and revokeAll, without touching other users", () => {
    const s = setup();
    const a = s.auth.createPanelSession("u1");
    const b = s.auth.createPanelSession("u2");
    s.auth.deletePanelSession(a);
    expect(s.auth.getPanelSession(a)).toBeNull();
    const a2 = s.auth.createPanelSession("u1");
    s.auth.revokeUser("u1");
    expect(s.auth.getPanelSession(a2)).toBeNull();
    expect(s.auth.getPanelSession(b)).toEqual({ userId: "u2" });
    s.auth.revokeAll();
    expect(s.auth.getPanelSession(b)).toBeNull();
  });
});

describe("recent tool calls", () => {
  it("lists one tenant's latest calls, newest first, up to the limit", () => {
    const tenants = createSqliteTenantStore(openAuthDatabase(":memory:"), () => T0);
    for (let i = 0; i < 3; i++)
      tenants.recordToolCall({
        tenantId: "t1",
        at: new Date(T0 + i * 1000).toISOString(),
        tool: `tool${i}`,
        outcome: "ok",
        ms: 5,
      });
    tenants.recordToolCall({
      tenantId: "t2",
      at: new Date(T0 + 9000).toISOString(),
      tool: "other",
      outcome: "ok",
      ms: 5,
    });
    expect(tenants.recentToolCalls("t1", 2)).toEqual([
      { at: new Date(T0 + 2000).toISOString(), tool: "tool2", outcome: "ok" },
      { at: new Date(T0 + 1000).toISOString(), tool: "tool1", outcome: "ok" },
    ]);
  });
});
