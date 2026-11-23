import { credentialFields, errorLine, escapeHtml, forgotLink, layout } from "../auth/loginPage.js";

/**
 * The panel's own layout on top of the shared look: one column on phones; on wider screens two
 * summary cards side by side, then reminders and missions beside the activity feed.
 */
const PANEL_STYLE = `<style>
body>main{max-width:72rem}
.top{display:flex;justify-content:space-between;align-items:center;gap:1rem}
.top h1{margin:0}
.summary,.cols,.stack{display:grid;gap:1.25rem}
.summary{margin-top:1.75rem}
.cols{margin-top:1.25rem}
section{margin:0;padding:1.35rem 1.5rem;background:var(--paper-hi);border:1px solid var(--line);border-radius:1.25rem;min-width:0}
section h2{margin:0 0 .85rem}
section p:last-child{margin-bottom:0}
ul.rows{list-style:none;padding:0;margin:0}
ul.rows li{display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:.75rem 0;border-top:1px solid var(--line)}
ul.rows li:first-child{border-top:0;padding-top:0}
ul.rows li:last-child{padding-bottom:0}
.row-main{flex:1;min-width:0;overflow-wrap:anywhere}
.row-meta{display:block;color:var(--muted);font-size:.85rem}
.activity ul.rows li{padding:.55rem 0}
.activity ul.rows li:first-child{padding-top:0}
.bad{color:#a8432f}
.status{margin:0;display:flex;align-items:center;gap:.55rem;font-size:1.05rem}
.dot{flex:0 0 .6rem;width:.6rem;height:.6rem;border-radius:50%;background:#c9a24a}
.dot.on{background:var(--moss)}
.account{margin:0;font-size:1.05rem;overflow-wrap:anywhere}
.account-meta{margin:.35rem 0 0;color:var(--muted);font-size:.88rem}
form.inline{margin:0}
form.inline button{display:inline-block;width:auto;height:auto;margin:0;padding:.4rem .95rem;font-size:.85rem;background:transparent;color:var(--moss-deep);border:1px solid var(--moss)}
form.inline button:hover{background:var(--mist)}
.pill{display:inline-block;padding:.1rem .6rem;border-radius:999px;background:var(--mist);color:var(--moss-deep);font-size:.8rem;font-weight:600}
.notice.warn{margin:1.25rem 0 0;background:#f3e3c4;color:#6b4a10}
.link{display:inline-block;margin-top:.85rem;font-weight:600}
@media (min-width:56rem){
.summary{grid-template-columns:1fr 1fr}
.cols{grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);align-items:start}
.cols.single{grid-template-columns:minmax(0,1fr)}
}
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
  const upToDate = v.subscription === "Al día";
  const lists = [
    v.reminders
      ? `<section><h2>Recordatorios</h2>${rows(v.reminders, "No tienes recordatorios activos.")}</section>`
      : "",
    v.missions
      ? `<section><h2>Misiones activas</h2>${rows(v.missions, "No hay misiones en curso.")}</section>`
      : "",
  ].join("");
  const activity = `<section class="activity"><h2>Actividad reciente</h2>${rows(v.activity, "Tu asistente todavía no ha hecho nada.")}</section>`;
  return layout(
    "Tu panel",
    `<div class="top"><h1>Hola, ${escapeHtml(v.username)}</h1>
<form class="inline" method="post" action="/panel/logout"><button type="submit">Salir</button></form></div>${
      v.subscription && !upToDate ? `<p class="notice warn">${escapeHtml(v.subscription)}</p>` : ""
    }
<div class="summary">
<section><h2>WhatsApp</h2>${whatsapp}</section>
<section><h2>Tu cuenta</h2><p class="account">${v.email ? escapeHtml(v.email) : "Sin correo de recuperación"}</p><p class="account-meta">Usuario ${escapeHtml(v.username)}${
      upToDate ? ` · Suscripción <span class="pill">Al día</span>` : ""
    }</p></section>
</div>
<div class="cols${lists ? "" : " single"}">${lists ? `<div class="stack">${lists}</div>` : ""}${activity}</div>`,
    PANEL_STYLE,
  );
}
