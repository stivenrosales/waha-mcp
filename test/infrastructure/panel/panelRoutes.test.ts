import { describe, expect, it } from "vitest";
import type { MissionView } from "../../../src/application/missions/service.js";
import type { ScheduleView } from "../../../src/application/schedules/service.js";
import type { SessionState } from "../../../src/domain/ports/SessionAdmin.js";
import { createLoginLimiter } from "../../../src/infrastructure/auth/rateLimit.js";
import { createAuthStore, openAuthDatabase } from "../../../src/infrastructure/auth/store.js";
import { createSqliteBillingStore } from "../../../src/infrastructure/billing/sqliteBillingStore.js";
import { createPanelRoutes } from "../../../src/infrastructure/panel/panelRoutes.js";
import { createSqliteTenantStore } from "../../../src/infrastructure/tenants/sqliteTenantStore.js";

const BASE = "https://mcp.example.com";
const PASSWORD = "a long enough password";
const T0 = Date.UTC(2026, 10, 23, 15, 0);

const mission = (over: Partial<MissionView["mission"]> = {}): MissionView =>
  ({
    mission: {
      id: "m1",
      chatId: "51999@c.us",
      state: "active",
      deadlineAt: new Date(T0 + 86_400_000).toISOString(),
      ...over,
    },
    objective: "Confirmar la cita del <martes>",
    doneWhen: "",
    pendingQuestions: [],
    answers: 0,
    outcome: null,
    collected: [],
  }) as unknown as MissionView;
const schedule = (): ScheduleView =>
  ({
    row: {
      id: "s1",
      chatId: "51888@c.us",
      repeat: "weekly",
      maxRuns: 4,
      nextRunAt: new Date(T0 + 3_600_000).toISOString(),
    },
    content: { text: "Recuerda pagar la cuota" },
    runs: [],
  }) as unknown as ScheduleView;

async function setup(
  opts: { missionsOn?: boolean; state?: SessionState; failingLists?: boolean } = {},
) {
  let now = T0;
  const db = openAuthDatabase(":memory:");
  const auth = createAuthStore(db, () => now);
  const tenants = createSqliteTenantStore(db, () => now);
  const billing = createSqliteBillingStore(db);
  const tenant = tenants.createTenant({
    displayName: "Acme",
    wahaSession: "t_acme",
    wrappedDek: "x",
  });
  const user = (await tenants.createUser({
    tenantId: tenant.id,
    username: "alice",
    password: PASSWORD,
    role: "member",
  })) as { id: string };
  tenants.setStatus(tenant.id, "active");
  tenants.setEmail(user.id, "alice@example.com");
  const cancelled: string[] = [];
  const missions = [mission()];
  const schedules = [schedule()];
  const missionsOn = opts.missionsOn ?? true;
  const app = createPanelRoutes({
    tenants,
    auth,
    sessions: { state: async () => opts.state ?? "WORKING" },
    registry: {
      acquire: () => ({
        runtime: {
          context: {
            missions: missionsOn
              ? {
                  list: () => {
                    if (opts.failingLists) throw new Error("log unreadable");
                    return missions;
                  },
                  cancel: async (id: string) => {
                    cancelled.push(`mission:${id}`);
                    return missions[0]?.mission;
                  },
                }
              : null,
            schedules: missionsOn
              ? {
                  list: () => {
                    if (opts.failingLists) throw new Error("log unreadable");
                    return schedules;
                  },
                  cancel: (id: string) => {
                    cancelled.push(`schedule:${id}`);
                    return schedules[0]?.row;
                  },
                }
              : null,
          },
        },
        release: () => {},
      }),
    } as never,
    billing,
    limiter: createLoginLimiter({ now: () => now }),
    publicBaseUrl: BASE,
    timezone: "America/Lima",
  });
  const request = (path: string, init?: RequestInit) => app.request(path, init);
  const post = (
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  const login = async (password = PASSWORD) => {
    const res = await post("/panel/login", { username: "alice", password });
    return { res, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };
  const dashboard = async (cookie: string) => request("/panel", { headers: { cookie } });
  return {
    app,
    auth,
    tenants,
    billing,
    tenant,
    user,
    cancelled,
    post,
    login,
    dashboard,
    request,
    advance: (ms: number) => (now += ms),
  };
}

describe("panel login", () => {
  it("sends visitors without a session to the login page", async () => {
    const s = await setup();
    const res = await s.request("/panel");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/panel/login");
    const page = await (await s.request("/panel/login")).text();
    expect(page).toContain('name="username"');
  });

  it("logs in with the MCP password and sets a strict, path-scoped cookie", async () => {
    const s = await setup();
    const { res } = await s.login();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/panel");
    const cookie = res.headers.get("set-cookie") ?? "";
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/panel", "Max-Age=43200"])
      expect(cookie).toContain(attr);
  });

  it("rejects a wrong password, a suspended account and a cross-site post", async () => {
    const s = await setup();
    expect((await s.login("wrong password here")).res.status).toBe(401);
    expect(
      (
        await s.post(
          "/panel/login",
          { username: "alice", password: PASSWORD },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    s.tenants.setStatus(s.tenant.id, "revoked");
    expect((await s.login()).res.status).toBe(403);
  });

  it("logout and any revocation end the session", async () => {
    const s = await setup();
    const { cookie } = await s.login();
    expect((await s.dashboard(cookie)).status).toBe(200);
    expect((await s.post("/panel/logout", {}, { cookie })).status).toBe(303);
    expect((await s.dashboard(cookie)).status).toBe(303);
    const again = (await s.login()).cookie;
    s.auth.revokeUser(s.user.id);
    expect((await s.dashboard(again)).status).toBe(303);
  });

  it("a session of an account suspended later no longer opens the panel", async () => {
    const s = await setup();
    const { cookie } = await s.login();
    s.tenants.setStatus(s.tenant.id, "revoked");
    expect((await s.dashboard(cookie)).status).toBe(303);
  });
});

describe("panel dashboard", () => {
  it("shows the account, WhatsApp connected, activity, reminders and missions", async () => {
    const s = await setup();
    s.tenants.recordToolCall({
      tenantId: s.tenant.id,
      at: new Date(T0 - 60_000).toISOString(),
      tool: "send_text",
      outcome: "ok",
      ms: 3,
    });
    s.tenants.recordToolCall({
      tenantId: s.tenant.id,
      at: new Date(T0 - 30_000).toISOString(),
      tool: "get_messages",
      outcome: "WahaUnavailableError",
      ms: 3,
    });
    const { cookie } = await s.login();
    const page = await (await s.dashboard(cookie)).text();
    expect(page).toContain("alice");
    expect(page).toContain("alice@example.com");
    expect(page).toContain("WhatsApp conectado");
    expect(page).toContain("Envió un mensaje");
    expect(page).toContain("Leyó mensajes");
    expect(page).toContain("Falló");
    expect(page).toContain("Recuerda pagar la cuota");
    expect(page).toContain("+51888");
    expect(page).toContain("Cada semana");
    expect(page).toContain("Confirmar la cita del &lt;martes&gt;");
    expect(page).not.toContain("<martes>");
    expect(page).toContain("+51999");
  });

  it("links to /pair when WhatsApp is not connected", async () => {
    const s = await setup({ state: "SCAN_QR_CODE" });
    const { cookie } = await s.login();
    const page = await (await s.dashboard(cookie)).text();
    expect(page).toContain("Escanea el código QR");
    expect(page).toContain('href="/pair"');
  });

  it("hides reminders and missions when missions are off", async () => {
    const s = await setup({ missionsOn: false });
    const { cookie } = await s.login();
    const page = await (await s.dashboard(cookie)).text();
    expect(page).not.toContain("Recordatorios");
    expect(page).not.toContain("Misiones");
  });

  it("shows the subscription state of a billed account", async () => {
    const s = await setup();
    s.billing.set({ tenantId: s.tenant.id, state: "past_due", since: T0 });
    const { cookie } = await s.login();
    const page = await (await s.dashboard(cookie)).text();
    expect(page).toContain("Pago pendiente");
    expect(page).toContain("26/11/2026");
    s.billing.set({ tenantId: s.tenant.id, state: "active", since: T0 });
    expect(await (await s.dashboard(cookie)).text()).toContain("Al día");
  });

  it("cancels a mission and a reminder through the services, same-origin only", async () => {
    const s = await setup();
    const { cookie } = await s.login();
    expect(
      (await s.post("/panel/missions/m1/cancel", {}, { cookie, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(s.cancelled).toEqual([]);
    expect((await s.post("/panel/missions/m1/cancel", {}, { cookie })).status).toBe(303);
    expect((await s.post("/panel/schedules/s1/cancel", {}, { cookie })).status).toBe(303);
    expect(s.cancelled).toEqual(["mission:m1", "schedule:s1"]);
    expect((await s.post("/panel/missions/m1/cancel", {})).status).toBe(303);
    expect(s.cancelled).toHaveLength(2);
  });

  it("still renders when the reminder or mission list fails, without those items", async () => {
    const s = await setup({ failingLists: true });
    const { cookie } = await s.login();
    const res = await s.dashboard(cookie);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("No tienes recordatorios activos.");
    expect(page).not.toContain("Recuerda pagar la cuota");
  });

  it("carries the Zenbox brand", async () => {
    const s = await setup();
    const page = await (await s.request("/panel/login")).text();
    expect(page).toContain("<title>Tu panel · Zenbox</title>");
    expect(page).toContain('class="brand"');
    expect(page).toContain("usezenbox.com");
  });
});
