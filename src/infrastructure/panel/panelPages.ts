import { credentialFields, errorLine, escapeHtml, forgotLink, layout } from "../auth/loginPage.js";

/** Wider page, compact sections and inline buttons, on top of the shared look. */
const PANEL_STYLE = `<style>
main{max-width:40rem}
section{margin:1.25rem 0 0;padding:1.25rem 1.35rem;background:var(--paper-hi);border:1px solid var(--line);border-radius:1.25rem}
section h2{margin:0 0 .75rem}
section p:last-child{margin-bottom:0}
ul.rows{list-style:none;padding:0;margin:0}
ul.rows li{display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:.7rem 0;border-top:1px solid var(--line)}
ul.rows li:first-child{border-top:0;padding-top:0}
ul.rows li:last-child{padding-bottom:0}
.row-main{flex:1;min-width:0;overflow-wrap:anywhere}
.row-meta{display:block;color:var(--muted);font-size:.85rem}
.bad{color:#a8432f}
.status{margin:0;display:flex;align-items:center;gap:.55rem}
.dot{flex:0 0 .55rem;width:.55rem;height:.55rem;border-radius:50%;background:#c9a24a}
.dot.on{background:var(--moss)}
form.inline{margin:0}
form.inline button{display:inline-block;width:auto;height:auto;margin:0;padding:.4rem .95rem;font-size:.85rem;background:transparent;color:var(--moss-deep);border:1px solid var(--moss)}
form.inline button:hover{background:var(--mist)}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:1rem}
.top h1{margin-bottom:.4rem}
.pill{display:inline-block;margin-left:.35rem;padding:.1rem .6rem;border-radius:999px;background:var(--mist);color:var(--moss-deep);font-size:.8rem;font-weight:600}
.notice.warn{margin:-1rem 0 1.5rem;background:#f3e3c4;color:#6b4a10}
.link{display:inline-block;margin-top:.75rem;font-weight:600}
</style>`;

export function panelLoginPage(
  opts: { username?: string; error?: string; forgotUrl?: string } = {},
): string {
  return layout(
    "Tu panel",
    `<h1>Entra a tu panel</h1>
<p class="lead">Usa el mismo usuario y contraseña con los que conectas tu asistente.</p>
${errorLine(opts.error)}
<form method="post" action="/panel/login">
${credentialFields(opts.username)}
<button type="submit">Entrar</button>
</form>${forgotLink(opts.forgotUrl)}`,
  );
}

export interface PanelRow {
  title: string;
  meta: string;
  bad?: boolean;
  /** POST target of a "Cancelar" button. */
  cancelAction?: string;
}

export interface PanelView {
  username: string;
  email: string | null;
  subscription: string | null;
  whatsapp: { text: string; connected: boolean };
  activity: PanelRow[];
  /** Null when missions (and reminders) are off. */
  reminders: PanelRow[] | null;
  missions: PanelRow[] | null;
}

const rows = (items: PanelRow[], empty: string): string =>
  items.length === 0
    ? `<p class="muted">${escapeHtml(empty)}</p>`
    : `<ul class="rows">${items
        .map(
          (r) =>
            `<li><span class="row-main${r.bad ? " bad" : ""}">${escapeHtml(r.title)}<span class="row-meta">${escapeHtml(r.meta)}</span></span>${
              r.cancelAction
                ? `<form class="inline" method="post" action="${escapeHtml(r.cancelAction)}"><button type="submit">Cancelar</button></form>`
                : ""
            }</li>`,
        )
        .join("")}</ul>`;

export function panelPage(v: PanelView): string {
  const status = `<p class="status"><span class="dot${v.whatsapp.connected ? " on" : ""}"></span>${escapeHtml(v.whatsapp.text)}</p>`;
  const whatsapp = v.whatsapp.connected
    ? status
    : `${status}<a class="link" href="/pair">Vincular WhatsApp</a>`;
  return layout(
    "Tu panel",
    `<div class="top"><h1>Hola, ${escapeHtml(v.username)}</h1>
<form class="inline" method="post" action="/panel/logout"><button type="submit">Salir</button></form></div>
<p class="lead">${v.email ? escapeHtml(v.email) : "Sin correo de recuperación"}${
      v.subscription === "Al día" ? `<span class="pill">Al día</span>` : ""
    }</p>${
      v.subscription && v.subscription !== "Al día"
        ? `<p class="notice warn">${escapeHtml(v.subscription)}</p>`
        : ""
    }
<section><h2>WhatsApp</h2>${whatsapp}</section>
${v.reminders ? `<section><h2>Recordatorios</h2>${rows(v.reminders, "No tienes recordatorios activos.")}</section>` : ""}
${v.missions ? `<section><h2>Misiones activas</h2>${rows(v.missions, "No hay misiones en curso.")}</section>` : ""}
<section><h2>Actividad reciente</h2>${rows(v.activity, "Tu asistente todavía no ha hecho nada.")}</section>`,
    PANEL_STYLE,
  );
}
