import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { GRACE_MS } from "../../application/billing.js";
import { contactLabel, STOP_REASONS } from "../../application/missions/notify.js";
import type { BillingStore } from "../../domain/ports/BillingStore.js";
import type { SessionAdmin, SessionState } from "../../domain/ports/SessionAdmin.js";
import type { Tenant, TenantStore, User } from "../../domain/ports/TenantStore.js";
import { authenticateLogin } from "../auth/login.js";
import { HTML_SECURITY_HEADERS, messagePage } from "../auth/loginPage.js";
import type { LoginLimiter } from "../auth/rateLimit.js";
import { type AuthStore, PANEL_SESSION_TTL_MS } from "../auth/store.js";
import type { Logger } from "../mcp/defineTool.js";
import type { TenantRegistry } from "../tenants/registry.js";
import type { TenantToolContext } from "../tenants/runtime.js";
import {
  type MissionItem,
  type PanelRow,
  type PanelTab,
  type PanelView,
  panelLoginPage,
  panelPage,
  type ReminderItem,
  type Tone,
} from "./panelPages.js";

const COOKIE = "waha_panel";
const MAX_BODY_BYTES = 16 * 1024;
const ACTIVITY_ROWS = 20;
const ACTIVITY_ROWS_FULL = 100;
const MISSION_HISTORY = 30;
const TRANSCRIPT_LINES = 40;
const METRICS_WINDOW_MS = 30 * 86_400_000;
const TABS = ["resumen", "recordatorios", "misiones", "actividad"] as const;

const SCHEDULE_STATE: Record<string, { text: string; tone: Tone }> = {
  active: { text: "Activo", tone: "ok" },
  done: { text: "Terminado", tone: "neutral" },
  cancelled: { text: "Cancelado", tone: "neutral" },
};

const RUN_OUTCOME: Record<string, { outcome: string; tone: Tone }> = {
  sent: { outcome: "Enviado", tone: "ok" },
  skipped: { outcome: "Omitido", tone: "neutral" },
  failed: { outcome: "Falló", tone: "bad" },
  missed: { outcome: "No salió a tiempo", tone: "warn" },
  unknown: { outcome: "Sin confirmar", tone: "warn" },
};

const MISSION_STATE: Record<string, { text: string; tone: Tone }> = {
  active: { text: "En curso", tone: "ok" },
  succeeded: { text: "Lograda", tone: "ok" },
  failed: { text: "No lograda", tone: "bad" },
  expired: { text: "Venció", tone: "warn" },
  cancelled: { text: "Cancelada", tone: "neutral" },
  taken_over: { text: "Tomaste el chat", tone: "neutral" },
  stopped: { text: "Detenida", tone: "warn" },
};
const CAN_LOG_IN = new Set(["active", "pairing"]);

const WHATSAPP_TEXT: Record<SessionState, string> = {
  WORKING: "WhatsApp conectado.",
  SCAN_QR_CODE: "Escanea el código QR para vincular tu WhatsApp.",
  STARTING: "Conectando con WhatsApp…",
  STOPPED: "WhatsApp desconectado.",
  FAILED: "WhatsApp desconectado.",
  UNKNOWN: "No se pudo consultar el estado de WhatsApp.",
};

/** What the assistant did, in the owner's words; unknown tools show their name. */
const TOOL_LABELS: Record<string, string> = {
  send_text: "Envió un mensaje",
  send_media: "Envió un archivo",
  send_location: "Envió una ubicación",
  send_contact: "Envió un contacto",
  send_poll: "Envió una encuesta",
  get_messages: "Leyó mensajes",
  get_thread: "Leyó una conversación",
  list_chats: "Revisó tus chats",
  list_groups: "Revisó tus grupos",
  get_group_info: "Revisó un grupo",
  search_messages: "Buscó en tus mensajes",
  list_pending_replies: "Revisó mensajes pendientes",
  get_activity_digest: "Resumió tu día",
  get_chat_stats: "Calculó estadísticas",
  get_contact: "Buscó un contacto",
  get_media: "Abrió un archivo",
  list_shared_files: "Revisó archivos compartidos",
  transcribe_audio: "Transcribió un audio",
  get_poll_results: "Revisó una encuesta",
  react_message: "Reaccionó a un mensaje",
  edit_message: "Editó un mensaje",
  delete_message: "Borró un mensaje",
  mark_read: "Marcó un chat como leído",
  mark_unread: "Marcó un chat como no leído",
  schedule_message: "Programó un mensaje",
  list_scheduled: "Revisó tus recordatorios",
  cancel_scheduled: "Canceló un recordatorio",
  start_mission: "Inició una misión",
  get_mission: "Revisó una misión",
  list_missions: "Revisó tus misiones",
  answer_mission: "Respondió a una misión",
  cancel_mission: "Canceló una misión",
};

const REPEAT_LABELS: Record<string, string> = {
  none: "Una vez",
  daily: "Cada día",
  weekly: "Cada semana",
  monthly: "Cada mes",
  yearly: "Cada año",
};

/**
 * `/panel`: each account's minimal page (WhatsApp state, reminders, missions, recent activity),
 * behind its own revocable session. The QR stays on `/pair`, which asks for the password again.
 */
export function createPanelRoutes(deps: {
  tenants: TenantStore;
  auth: AuthStore;
  sessions: Pick<SessionAdmin, "state">;
  registry: Pick<TenantRegistry, "acquire">;
  billing?: BillingStore;
  limiter: LoginLimiter;
  publicBaseUrl: string;
  timezone: string;
  /** Shown under the login form when password recovery by email is on. */
  forgotUrl?: string;
  now?: () => number;
  logger?: Logger;
}): Hono {
  const { tenants, auth } = deps;
  const now = deps.now ?? Date.now;
  const baseOrigin = new URL(deps.publicBaseUrl).origin;
  const app = new Hono();
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.text("Payload too large", 413),
  });
  const dateTime = new Intl.DateTimeFormat("es-PE", {
    timeZone: deps.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const dateOnly = new Intl.DateTimeFormat("es-PE", {
    timeZone: deps.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const html = (c: Context, body: string, status: 200 | 400 | 401 | 403 | 429 = 200) => {
    for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) c.header(name, value);
    c.header("Referrer-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    return c.html(body, status);
  };
  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header("origin");
    if (origin !== undefined) return origin === baseOrigin;
    const referer = c.req.header("referer");
    return referer !== undefined && URL.canParse(referer) && new URL(referer).origin === baseOrigin;
  };
  const crossSite = (c: Context) =>
    html(
      c,
      messagePage(
        "Solicitud bloqueada",
        "Este formulario debe enviarse desde la página de este servidor. Recarga la página e inténtalo de nuevo.",
      ),
      403,
    );
  const loginPage = (
    c: Context,
    opts: { username?: string; error?: string } = {},
    status: 200 | 401 | 403 | 429 = 200,
  ) =>
    html(
      c,
      panelLoginPage({ ...opts, ...(deps.forgotUrl ? { forgotUrl: deps.forgotUrl } : {}) }),
      status,
    );
  const toLogin = (c: Context) => c.redirect("/panel/login", 303);

  const safely = <T>(fn: () => T[]): T[] => {
    try {
      return fn();
    } catch {
      deps.logger?.info("panel list failed");
      return [];
    }
  };

  /** The signed-in user and tenant, or null (unknown, expired, or an account that can no longer log in). */
  const current = (c: Context): { user: User; tenant: Tenant; token: string } | null => {
    const token = getCookie(c, COOKIE);
    if (!token) return null;
    const session = auth.getPanelSession(token);
    const user = session ? tenants.getUser(session.userId) : null;
    const tenant = user ? tenants.getTenant(user.tenantId) : null;
    if (!user || !tenant || !CAN_LOG_IN.has(tenant.status)) return null;
    return { user, tenant, token };
  };

  app.get("/panel/login", (c) => (current(c) ? c.redirect("/panel", 303) : loginPage(c)));

  app.post("/panel/login", limitBody, async (c) => {
    if (!sameOrigin(c)) return crossSite(c);
    const form = new URLSearchParams(await c.req.text());
    const username = form.get("username") ?? "";
    const user = await authenticateLogin(c, form, { tenants, limiter: deps.limiter });
    if (user === "blocked")
      return loginPage(
        c,
        { username, error: "Demasiados intentos fallidos. Inténtalo más tarde." },
        429,
      );
    if (user === "invalid")
      return loginPage(c, { username, error: "Usuario o contraseña incorrectos." }, 401);
    const status = tenants.getTenant(user.tenantId)?.status;
    if (status === undefined || !CAN_LOG_IN.has(status))
      return loginPage(c, { username, error: "Esta cuenta está desactivada." }, 403);
    // A fresh token on every login: a token planted before login is never promoted.
    const old = getCookie(c, COOKIE);
    if (old) auth.deletePanelSession(old);
    setCookie(c, COOKIE, auth.createPanelSession(user.id), {
      path: "/panel",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      maxAge: PANEL_SESSION_TTL_MS / 1000,
    });
    deps.logger?.info(`panel login tenant=${user.tenantId}`);
    return c.redirect("/panel", 303);
  });

  app.post("/panel/logout", limitBody, (c) => {
    if (!sameOrigin(c)) return crossSite(c);
    const token = getCookie(c, COOKIE);
    if (token) auth.deletePanelSession(token);
    deleteCookie(c, COOKIE, { path: "/panel", secure: true });
    return toLogin(c);
  });

  app.get("/panel", async (c) => {
    const me = current(c);
    if (!me) return toLogin(c);
    const { user, tenant } = me;
    const requested = c.req.query("tab") ?? "resumen";
    let tab: PanelTab = (TABS as readonly string[]).includes(requested)
      ? (requested as PanelTab)
      : "resumen";

    let state: SessionState = "UNKNOWN";
    try {
      state = await deps.sessions.state(tenant.wahaSession);
    } catch {
      state = "UNKNOWN";
    }

    const nowMs = now();
    const since = new Date(nowMs - METRICS_WINDOW_MS).toISOString();
    const when = (iso: string) => dateTime.format(new Date(iso));

    let reminders: PanelRow[] | null = null;
    let missions: PanelRow[] | null = null;
    let reminderHistory: ReminderItem[] | undefined;
    let missionHistory: MissionItem[] | undefined;
    let remindersSent = 0;
    let remindersFailed = 0;
    let missionsDone = 0;
    let missionsWon = 0;
    let missionsActive = 0;
    const held = deps.registry.acquire(tenant.id);
    if (held) {
      try {
        const { missions: missionService, schedules } = held.runtime.context;
        // A failing list leaves its section out instead of failing the whole page.
        if (schedules) {
          const all = safely(() => schedules.history());
          for (const s of all)
            for (const run of s.runs)
              if (run.at >= since) {
                if (run.outcome === "sent") remindersSent++;
                else if (run.outcome === "failed" || run.outcome === "unknown") remindersFailed++;
              }
          const active = all.filter((s) => s.row.state === "active");
          reminders = active.map((s) => ({
            title: s.content.text ?? s.content.instruction ?? "",
            meta: `${contactLabel(null, s.row.chatId)} · ${s.row.nextRunAt ? when(s.row.nextRunAt) : "Enviándose ahora"} · ${REPEAT_LABELS[s.row.repeat] ?? s.row.repeat}`,
            cancelAction: `/panel/schedules/${encodeURIComponent(s.row.id)}/cancel`,
          }));
          if (tab === "recordatorios")
            reminderHistory = all.map((s) => ({
              chip: SCHEDULE_STATE[s.row.state] ?? { text: s.row.state, tone: "neutral" },
              title: s.content.text ?? s.content.instruction ?? "",
              meta: [
                contactLabel(null, s.row.chatId),
                REPEAT_LABELS[s.row.repeat] ?? s.row.repeat,
                `${s.row.runsDone} de ${s.row.maxRuns} envíos`,
                s.row.state === "active"
                  ? s.row.nextRunAt
                    ? `próximo ${when(s.row.nextRunAt)}`
                    : "enviándose ahora"
                  : s.row.endedAt
                    ? `terminó ${when(s.row.endedAt)}`
                    : "",
              ]
                .filter(Boolean)
                .join(" · "),
              ...(s.row.state === "active"
                ? { cancelAction: `/panel/schedules/${encodeURIComponent(s.row.id)}/cancel` }
                : {}),
              runs: s.runs.map((run) => ({
                when: when(run.at),
                ...(RUN_OUTCOME[run.outcome] ?? { outcome: run.outcome, tone: "neutral" as Tone }),
                detail: run.text ?? run.reason ?? "",
              })),
            }));
        }
        if (missionService) {
          const all = safely(() => missionService.list());
          for (const m of all) {
            if (m.mission.state === "active") missionsActive++;
            else if (m.mission.endedAt && m.mission.endedAt >= since) {
              missionsDone++;
              if (m.mission.state === "succeeded") missionsWon++;
            }
          }
          missions = all
            .filter((m) => m.mission.state === "active")
            .map((m) => ({
              title: m.objective,
              meta: `${contactLabel(null, m.mission.chatId)} · hasta ${when(m.mission.deadlineAt)}`,
              cancelAction: `/panel/missions/${encodeURIComponent(m.mission.id)}/cancel`,
            }));
          if (tab === "misiones")
            missionHistory = all.slice(0, MISSION_HISTORY).map((m) => {
              const stop = m.mission.stopReason ? STOP_REASONS[m.mission.stopReason] : null;
              return {
                chip: MISSION_STATE[m.mission.state] ?? { text: m.mission.state, tone: "neutral" },
                title: m.objective,
                meta: [
                  contactLabel(null, m.mission.chatId),
                  `empezó ${when(m.mission.createdAt)}`,
                  m.mission.endedAt
                    ? `terminó ${when(m.mission.endedAt)}`
                    : `hasta ${when(m.mission.deadlineAt)}`,
                  `${m.mission.sentCount} ${m.mission.sentCount === 1 ? "mensaje enviado" : "mensajes enviados"}`,
                  stop ?? "",
                ]
                  .filter(Boolean)
                  .join(" · "),
                ...(m.mission.state === "active"
                  ? { cancelAction: `/panel/missions/${encodeURIComponent(m.mission.id)}/cancel` }
                  : {}),
                summary: m.outcome?.summary ?? null,
                collected: m.collected.map((item) => ({
                  label: item.label,
                  value: item.value ?? (item.media_id ? "(archivo)" : ""),
                })),
                transcript: safely(() => missionService.transcript(m.mission.id))
                  .slice(-TRANSCRIPT_LINES)
                  .map((t) => ({ when: when(t.at), from: t.from, text: t.text })),
              };
            });
        }
      } finally {
        held.release();
      }
    }
    // Reminders and missions are off (or the account is still pairing): their tabs do not exist.
    if (!reminders && !missions && (tab === "recordatorios" || tab === "misiones")) tab = "resumen";

    const activity = tenants
      .recentToolCalls(tenant.id, tab === "actividad" ? ACTIVITY_ROWS_FULL : ACTIVITY_ROWS)
      .map((call) => ({
        title: TOOL_LABELS[call.tool] ?? call.tool,
        meta: `${when(call.at)}${call.outcome === "ok" ? "" : " · Falló"}`,
        bad: call.outcome !== "ok",
      }));
    const usage = tenants.toolUsage({
      fromIso: since,
      toIso: new Date(nowMs).toISOString(),
      tenantId: tenant.id,
    });
    const totalCalls = usage.reduce((n, r) => n + r.calls, 0);
    const totalErrors = usage.reduce((n, r) => n + r.errors, 0);
    const sends = usage
      .filter((r) => r.tool.startsWith("send_"))
      .reduce((n, r) => n + r.calls - r.errors, 0);

    const metrics: PanelView["metrics"] = [
      {
        value: String(totalCalls),
        label: "Acciones de tu asistente",
        note: totalErrors ? `${totalErrors} con error · 30 días` : "Últimos 30 días",
      },
      { value: String(sends), label: "Mensajes que envió", note: "Últimos 30 días" },
    ];
    if (reminders)
      metrics.push({
        value: String(remindersSent),
        label: "Recordatorios enviados",
        note: remindersFailed ? `${remindersFailed} sin enviar · 30 días` : "Últimos 30 días",
      });
    if (missions)
      metrics.push({
        value: missionsDone ? `${missionsWon}/${missionsDone}` : "0",
        label: "Misiones logradas",
        note: `${missionsActive} en curso`,
      });

    const record = deps.billing?.get(tenant.id) ?? null;
    const subscription =
      record === null
        ? null
        : record.state === "past_due"
          ? `Pago pendiente: actualiza tu pago antes del ${dateOnly.format(new Date(record.since + GRACE_MS))} para no perder el acceso`
          : record.state === "active"
            ? "Al día"
            : null;

    return html(
      c,
      panelPage({
        tab,
        username: user.username,
        email: user.email,
        subscription,
        whatsapp: { text: WHATSAPP_TEXT[state], connected: state === "WORKING" },
        metrics,
        activity,
        reminders,
        missions,
        ...(reminderHistory ? { reminderHistory } : {}),
        ...(missionHistory ? { missionHistory } : {}),
        ...(tab === "actividad"
          ? {
              toolTotals: usage.map((r) => ({
                label: TOOL_LABELS[r.tool] ?? r.tool,
                calls: r.calls,
                errors: r.errors,
              })),
            }
          : {}),
      }),
    );
  });

  /** Runs `fn` on the signed-in account's services, then goes back to the panel. */
  const cancelRoute = (
    path: string,
    fn: (context: TenantToolContext, id: string) => Promise<unknown> | unknown,
  ) =>
    app.post(path, limitBody, async (c) => {
      const me = current(c);
      if (!me) return toLogin(c);
      if (!sameOrigin(c)) return crossSite(c);
      const held = deps.registry.acquire(me.tenant.id);
      if (held) {
        try {
          await fn(held.runtime.context, c.req.param("id") ?? "");
        } catch {
          // Already ended or unknown: the panel simply shows the current list.
        } finally {
          held.release();
        }
      }
      return c.redirect("/panel", 303);
    });

  cancelRoute("/panel/missions/:id/cancel", (ctx, id) => ctx.missions?.cancel(id));
  cancelRoute("/panel/schedules/:id/cancel", (ctx, id) => ctx.schedules?.cancel(id));

  return app;
}
