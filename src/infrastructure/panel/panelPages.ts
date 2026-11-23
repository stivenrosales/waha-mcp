import { credentialFields, errorLine, escapeHtml, forgotLink, layout } from "../auth/loginPage.js";

/** Wider page, compact sections and inline buttons, on top of the shared look. */
const PANEL_STYLE = `<style>
main{max-width:40rem}
section{margin:2rem 0 0}
section h2{font-size:1.05rem;margin:0 0 .6rem}
ul.rows{list-style:none;padding:0;margin:0}
ul.rows li{display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:.6rem 0;border-top:1px solid rgba(0,0,0,.08)}
ul.rows li:first-child{border-top:0}
.row-main{flex:1;min-width:0;overflow-wrap:anywhere}
.row-meta{display:block;color:var(--muted);font-size:.85rem}
.bad{color:#b3261e}
form.inline{margin:0}
form.inline button{display:inline-block;width:auto;height:auto;padding:.35rem .8rem;font-size:.85rem}
.status{margin:.2rem 0 0}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:1rem}
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
  const whatsapp = v.whatsapp.connected
    ? `<p class="status">${escapeHtml(v.whatsapp.text)}</p>`
    : `<p class="status">${escapeHtml(v.whatsapp.text)}</p><p><a href="/pair">Vincular WhatsApp</a></p>`;
  return layout(
    "Tu panel",
    `<div class="top"><h1>Hola, ${escapeHtml(v.username)}</h1>
<form class="inline" method="post" action="/panel/logout"><button type="submit">Salir</button></form></div>
<p class="lead">${v.email ? escapeHtml(v.email) : "Sin correo de recuperación"}${v.subscription ? ` · ${escapeHtml(v.subscription)}` : ""}</p>
<section><h2>WhatsApp</h2>${whatsapp}</section>
${v.reminders ? `<section><h2>Recordatorios</h2>${rows(v.reminders, "No tienes recordatorios activos.")}</section>` : ""}
${v.missions ? `<section><h2>Misiones activas</h2>${rows(v.missions, "No hay misiones en curso.")}</section>` : ""}
<section><h2>Actividad reciente</h2>${rows(v.activity, "Tu asistente todavía no ha hecho nada.")}</section>`,
    PANEL_STYLE,
  );
}
