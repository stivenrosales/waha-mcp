import { describe, expect, it } from "vitest";
import {
  createPolarSync,
  createProvisioner,
  type PolarSubscription,
  ProvisionCapError,
} from "../../src/application/polarSync.js";
import type { OutgoingEmail } from "../../src/domain/ports/EmailSender.js";
import { openAuthDatabase } from "../../src/infrastructure/auth/store.js";
import { createSqlitePolarStore } from "../../src/infrastructure/billing/sqlitePolarStore.js";

const sub = (over: Partial<PolarSubscription> = {}): PolarSubscription => ({
  id: "sub_1",
  status: "active",
  customerId: "cus_1",
  customerEmail: "Ana@Example.com",
  ...over,
});

function setup(current: PolarSubscription) {
  let state = current;
  const calls: string[] = [];
  const provisioned: string[] = [];
  const store = createSqlitePolarStore(openAuthDatabase(":memory:"));
  const emails = new Map<string, string | null>();
  const sync = createPolarSync({
    fetchSubscription: async (id) => {
      calls.push(`fetch:${id}`);
      return state;
    },
    store,
    billing: {
      paymentSucceeded: (t) => void calls.push(`succeeded:${t}`),
      paymentFailed: (t) => void calls.push(`failed:${t}`),
      endAccess: async (t) => void calls.push(`end:${t}`),
    },
    provision: async ({ email }) => {
      provisioned.push(email);
      return `tenant_${provisioned.length}`;
    },
    users: {
      emailOfTenant: (t) => emails.get(t) ?? null,
      setTenantEmail: (t, e) => void emails.set(t, e),
    },
    logger: { info: () => {} },
  });
  return { sync, calls, provisioned, store, emails, set: (s: PolarSubscription) => (state = s) };
}

describe("polar sync", () => {
  it("provisions an account for a new active or trialing subscription, once", async () => {
    const s = setup(sub({ status: "trialing" }));
    await s.sync.handle("sub_1");
    await s.sync.handle("sub_1");
    expect(s.provisioned).toEqual(["ana@example.com"]);
    expect(s.store.tenantFor("sub_1")).toBe("tenant_1");
    expect(s.calls.filter((c) => c.startsWith("succeeded:"))).toEqual([
      "succeeded:tenant_1",
      "succeeded:tenant_1",
    ]);
  });

  it("acts on the current state fetched from Polar, not on the event", async () => {
    const s = setup(sub());
    await s.sync.handle("sub_1");
    s.set(sub({ status: "past_due" }));
    await s.sync.handle("sub_1");
    expect(s.calls).toContain("failed:tenant_1");
    s.set(sub({ status: "active" }));
    await s.sync.handle("sub_1");
    expect(s.calls.at(-1)).toBe("succeeded:tenant_1");
  });

  it("ends access for canceled, unpaid, incomplete_expired and trial_ended", async () => {
    for (const status of ["canceled", "unpaid", "incomplete_expired", "trial_ended"] as const) {
      const s = setup(sub());
      await s.sync.handle("sub_1");
      s.set(sub({ status }));
      await s.sync.handle("sub_1");
      expect(s.calls.at(-1)).toBe("end:tenant_1");
    }
  });

  it("never provisions for a past-due or ended subscription it does not know", async () => {
    for (const status of ["past_due", "canceled", "incomplete"] as const) {
      const s = setup(sub({ status }));
      await s.sync.handle("sub_1");
      expect(s.provisioned).toEqual([]);
      expect(s.calls.filter((c) => !c.startsWith("fetch:"))).toEqual([]);
    }
  });

  it("gives the customer's email to the account's user when it has none", async () => {
    const s = setup(sub());
    await s.sync.handle("sub_1");
    expect(s.emails.get("tenant_1")).toBe("ana@example.com");
    s.emails.set("tenant_1", "chosen@example.com");
    await s.sync.handle("sub_1");
    expect(s.emails.get("tenant_1")).toBe("chosen@example.com");
  });
});

describe("provisioner", () => {
  const T0 = 1_800_000_000_000;
  function make() {
    let now = T0;
    const sent: OutgoingEmail[] = [];
    const invites: string[] = [];
    const provision = createProvisioner({
      admin: {
        createInvite: async ({ displayName }) => {
          invites.push(displayName as string);
          return {
            tenantId: `t${invites.length}`,
            url: `https://mcp.example.com/invite/tok${invites.length}`,
            expiresAt: "",
          };
        },
      },
      email: { send: async (m) => void sent.push(m) },
      logger: { info: () => {} },
      now: () => now,
      maxPerHour: 2,
    });
    return { provision, sent, invites, advance: (ms: number) => (now += ms) };
  }

  it("creates an invite named after the email and emails its link", async () => {
    const p = make();
    expect(await p.provision({ email: "ana@example.com" })).toBe("t1");
    expect(p.invites).toEqual(["ana@example.com"]);
    expect(p.sent[0]?.to).toBe("ana@example.com");
    expect(p.sent[0]?.text).toContain("https://mcp.example.com/invite/tok1");
  });

  it("refuses above the hourly cap, and allows again an hour later", async () => {
    const p = make();
    await p.provision({ email: "a@example.com" });
    await p.provision({ email: "b@example.com" });
    await expect(p.provision({ email: "c@example.com" })).rejects.toBeInstanceOf(ProvisionCapError);
    expect(p.invites).toHaveLength(2);
    p.advance(3_600_001);
    expect(await p.provision({ email: "c@example.com" })).toBe("t3");
  });
});
