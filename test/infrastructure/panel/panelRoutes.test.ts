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
      stopReason: null,
      sentCount: 2,
      createdAt: new Date(T0 - 3_600_000).toISOString(),
      endedAt: null,
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
      state: "active",
      repeat: "weekly",
      runsDone: 1,
      maxRuns: 4,
      nextRunAt: new Date(T0 + 3_600_000).toISOString(),
      endedAt: null,
    },
    content: { text: "Recuerda pagar la cuota" },
    runs: [
      {
        at: new Date(T0 - 86_400_000).toISOString(),
        outcome: "sent",
        text: "Recuerda pagar la cuota (enviado)",
      },
      {
        at: new Date(T0 - 2 * 86_400_000).toISOString(),
        outcome: "failed",
        reason: "WhatsApp desconectado",
      },
    ],
  }) as unknown as ScheduleView;
const endedSchedule = (): ScheduleView =>
  ({
    row: {
      id: "s2",
      chatId: "51777@c.us",
      state: "cancelled",
      repeat: "none",
      runsDone: 0,
      maxRuns: 1,
      nextRunAt: null,
      endedAt: new Date(T0 - 3_600_000).toISOString(),
    },
    content: { instruction: "Saluda a Pedro por su cumpleaños" },
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
  const missions = [
    mission(),
    {
      ...mission({ id: "m2", state: "succeeded", endedAt: new Date(T0 - 60_000).toISOString() }),
      objective: "Pedir el presupuesto",
      outcome: { outcome: "succeeded", summary: "El técnico cobra S/ 250" },
      collected: [{ label: "Precio", value: "S/ 250" }],
    } as MissionView,
  ];
  const schedules = [schedule(), endedSchedule()];
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
                  list: (state?: string) => {
                    if (opts.failingLists) throw new Error("log unreadable");
                    return state ? missions.filter((m) => m.mission.state === state) : missions;
                  },
                  transcript: (id: string) =>
                    id === "m2"
                      ? [
                          {
                            at: new Date(T0 - 600_000).toISOString(),
                            from: "agent",
                            text: "Hola, ¿cuánto cobra?",
                          },
                          {
                            at: new Date(T0 - 300_000).toISOString(),
                            from: "contact",
                            text: "250 soles",
                          },
                        ]
                      : [],
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
                    return schedules.filter((x) => x.row.state === "active");
                  },
                  history: () => {
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
    now: () => now,
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

describe("panel tabs and metrics", () => {
  it("shows 30-day metrics on every tab", async () => {
    const s = await setup();
    for (const [tool, outcome] of [
      ["send_text", "ok"],
      ["send_text", "ok"],
      ["send_media", "WahaUnavailableError"],
      ["get_messages", "ok"],
    ])
      s.tenants.recordToolCall({
        tenantId: s.tenant.id,
        at: new Date(T0 - 60_000).toISOString(),
        tool,
        outcome,
        ms: 3,
      });
    const { cookie } = await s.login();
    const page = await (await s.dashboard(cookie)).text();
    expect(page).toMatch(/<b>4<\/b><span>Acciones de tu asistente<\/span><small>1 con error/);
    expect(page).toMatch(/<b>2<\/b><span>Mensajes que envió/);
    expect(page).toMatch(/<b>1<\/b><span>Recordatorios enviados<\/span><small>1 sin enviar/);
    expect(page).toMatch(/<b>1\/1<\/b><span>Misiones logradas<\/span><small>1 en curso/);
  });

  it("the reminders tab lists ended reminders and every run with what went out", async () => {
    const s = await setup();
    const { cookie } = await s.login();
    const page = await (
      await s.request("/panel?tab=recordatorios", { headers: { cookie } })
    ).text();
    expect(page).toContain('aria-current="page">Recordatorios');
    expect(page).toContain("Saluda a Pedro por su cumpleaños");
    expect(page).toContain("Cancelado");
    expect(page).toContain("1 de 4 envíos");
    expect(page).toContain("Recuerda pagar la cuota (enviado)");
    expect(page).toContain("Enviado");
    expect(page).toContain("WhatsApp desconectado");
    expect(page.match(/\/panel\/schedules\/[^/]+\/cancel/g)).toEqual([
      "/panel/schedules/s1/cancel",
    ]);
  });

  it("the missions tab shows outcomes, collected data and the conversation", async () => {
    const s = await setup();
    const { cookie } = await s.login();
    const page = await (await s.request("/panel?tab=misiones", { headers: { cookie } })).text();
    expect(page).toContain("Lograda");
    expect(page).toContain("El técnico cobra S/ 250");
    expect(page).toContain("Precio");
    expect(page).toContain("Hola, ¿cuánto cobra?");
    expect(page).toContain("250 soles");
    expect(page).toContain("2 mensajes enviados");
  });

  it("the activity tab totals each action over 30 days", async () => {
    const s = await setup();
    s.tenants.recordToolCall({
      tenantId: s.tenant.id,
      at: new Date(T0 - 60_000).toISOString(),
      tool: "send_text",
      outcome: "ok",
      ms: 3,
    });
    const { cookie } = await s.login();
    const page = await (await s.request("/panel?tab=actividad", { headers: { cookie } })).text();
    expect(page).toContain("Últimos 30 días");
    expect(page).toMatch(/<td>Envió un mensaje<\/td><td class="num">1<\/td>/);
  });

  it("hides the reminder and mission tabs when missions are off, and falls back to the summary", async () => {
    const s = await setup({ missionsOn: false });
    const { cookie } = await s.login();
    const page = await (await s.request("/panel?tab=misiones", { headers: { cookie } })).text();
    expect(page).not.toContain("?tab=misiones");
    expect(page).toContain('aria-current="page">Resumen');
  });

  it("an unknown tab shows the summary", async () => {
    const s = await setup();
    const { cookie } = await s.login();
    const page = await (await s.request("/panel?tab=<x>", { headers: { cookie } })).text();
    expect(page).toContain('aria-current="page">Resumen');
  });
});
