import { credentialFields, errorLine, escapeHtml, forgotLink, layout } from "../auth/loginPage.js";

/**
 * The panel's own layout on top of the shared look: compact cards, tabs as plain links (the CSP
 * allows no scripts) and `<details>` for history, so everything works without JavaScript. One
 * column on phones; on wider screens metrics in a row and lists beside the activity feed.
 */
const PANEL_STYLE = `<style>
body>main{max-width:74rem;padding-top:clamp(1.5rem,5vh,3rem)}
.brand{margin-bottom:1.1rem}
.top{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
.top h1{margin:0;font-size:clamp(1.7rem,4vw,2.2rem)}
nav.tabs{display:flex;gap:.35rem;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:1.1rem 0 0;padding:.3rem;border:1px solid var(--line);border-radius:999px;background:var(--paper-hi);width:fit-content;max-width:100%}
nav.tabs::-webkit-scrollbar{display:none}
nav.tabs a{flex:0 0 auto;padding:.35rem .95rem;border-radius:999px;color:var(--muted);text-decoration:none;font-size:.88rem;font-weight:500}
nav.tabs a[aria-current=page]{background:var(--moss);color:var(--paper-hi)}
nav.tabs a:not([aria-current]):hover{background:var(--mist);color:var(--moss-deep)}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;margin-top:1rem}
.metric{padding:.8rem 1rem;background:var(--paper-hi);border:1px solid var(--line);border-radius:1rem;min-width:0}
.metric b{display:block;font:400 1.65rem/1.1 Newsreader,Georgia,serif;font-variant-numeric:tabular-nums}
.metric span{display:block;margin-top:.2rem;font-size:.8rem;color:var(--muted)}
.metric small{display:block;font-size:.75rem;color:var(--muted)}
.grid,.stack{display:grid;gap:.75rem}
.grid{margin-top:.75rem}
section{margin:0;padding:.95rem 1.1rem;background:var(--paper-hi);border:1px solid var(--line);border-radius:1rem;min-width:0}
section h2{margin:0 0 .55rem;font-size:.72rem}
section p:last-child{margin-bottom:0}
ul.feed{list-style:none;padding:0;margin:0}
ul.feed li{display:flex;justify-content:space-between;gap:.75rem;padding:.32rem 0;border-top:1px solid var(--line);font-size:.88rem}
ul.feed li:first-child{border-top:0;padding-top:0}
ul.feed li span:first-child{min-width:0;overflow-wrap:anywhere}
ul.feed time{flex:0 0 auto;color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}
ul.rows{list-style:none;padding:0;margin:0}
ul.rows>li{display:flex;gap:.6rem;align-items:flex-start;justify-content:space-between;padding:.5rem 0;border-top:1px solid var(--line);font-size:.92rem}
ul.rows>li:first-child{border-top:0;padding-top:0}
ul.rows>li:last-child{padding-bottom:0}
.row-main{flex:1;min-width:0;overflow-wrap:anywhere}
.row-meta{display:block;color:var(--muted);font-size:.8rem}
.bad{color:#a8432f}
.status{margin:0;display:flex;align-items:center;gap:.5rem}
.dot{flex:0 0 .55rem;width:.55rem;height:.55rem;border-radius:50%;background:#c9a24a}
.dot.on{background:var(--moss)}
.chip{display:inline-block;margin-right:.35rem;padding:0 .5rem;border-radius:999px;font-size:.72rem;font-weight:600;line-height:1.55;white-space:nowrap;vertical-align:.05em;background:var(--sand);color:var(--muted)}
.chip.ok{background:var(--mist);color:var(--moss-deep)}
.chip.warn{background:#f3e3c4;color:#6b4a10}
.chip.bad{background:#f4d9d2;color:#8a3322}
form.inline{margin:0}
form.inline button{display:inline-block;width:auto;height:auto;margin:0;padding:.25rem .75rem;font-size:.8rem;background:transparent;color:var(--moss-deep);border:1px solid var(--moss)}
form.inline button:hover{background:var(--mist)}
.notice.warn{margin:1rem 0 0;padding:.7rem 1rem;background:#f3e3c4;color:#6b4a10}
.link{display:inline-block;margin-top:.5rem;font-weight:600;font-size:.9rem}
details{border-top:1px solid var(--line)}
details:first-of-type{border-top:0}
summary{display:flex;gap:.6rem;align-items:flex-start;padding:.6rem 0;cursor:pointer;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"›";flex:0 0 .7rem;color:var(--muted);transition:transform .15s;line-height:1.5}
details[open]>summary::before{transform:rotate(90deg)}
.detail{margin:0 0 .75rem 1.3rem;padding:.6rem .8rem;border-radius:.75rem;background:var(--paper);font-size:.86rem}
.detail h3{margin:.6rem 0 .3rem;font-size:.7rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.detail h3:first-child{margin-top:0}
.detail p{margin:0 0 .4rem}
table{width:100%;border-collapse:collapse;font-size:.84rem}
td,th{padding:.35rem .4rem;text-align:left;vertical-align:top;border-top:1px solid var(--line)}
th{font-size:.7rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-top:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.when{white-space:nowrap;color:var(--muted)}
.scroll{overflow-x:auto}
.chat{display:grid;gap:.35rem}
.msg{max-width:85%;padding:.4rem .65rem;border-radius:.75rem;background:#fff;border:1px solid var(--line);overflow-wrap:anywhere}
.msg.agent{justify-self:end;background:var(--mist);border-color:transparent}
.msg small{display:block;color:var(--muted);font-size:.72rem}
.empty{margin:0;color:var(--muted);font-size:.86rem}
@media (min-width:48rem){
.metrics{grid-template-columns:repeat(4,minmax(0,1fr))}
.grid.two{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.grid.main{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);align-items:start}
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

export type Tone = "ok" | "warn" | "bad" | "neutral";
export type PanelTab = "resumen" | "recordatorios" | "misiones" | "actividad";

export interface PanelRow {
  title: string;
  meta: string;
  bad?: boolean;
  chip?: { text: string; tone: Tone };
  /** POST target of a "Cancelar" button. */
  cancelAction?: string;
}

export interface ReminderItem extends PanelRow {
  runs: { when: string; outcome: string; tone: Tone; detail: string }[];
}

export interface MissionItem extends PanelRow {
  summary: string | null;
  collected: { label: string; value: string }[];
  transcript: { when: string; from: "contact" | "agent"; text: string }[];
}

export interface PanelView {
  tab: PanelTab;
  username: string;
  email: string | null;
  subscription: string | null;
  whatsapp: { text: string; connected: boolean };
  metrics: { value: string; label: string; note?: string }[];
  activity: PanelRow[];
  /** Null when missions (and reminders) are off: their tabs and sections disappear. */
  reminders: PanelRow[] | null;
  missions: PanelRow[] | null;
  reminderHistory?: ReminderItem[];
  missionHistory?: MissionItem[];
  toolTotals?: { label: string; calls: number; errors: number }[];
}

const e = escapeHtml;

const chip = (c?: { text: string; tone: Tone }): string =>
  c ? `<span class="chip${c.tone === "neutral" ? "" : ` ${c.tone}`}">${e(c.text)}</span>` : "";

const cancelForm = (action?: string): string =>
  action
    ? `<form class="inline" method="post" action="${e(action)}"><button type="submit">Cancelar</button></form>`
    : "";

const rows = (items: PanelRow[], empty: string): string =>
  items.length === 0
    ? `<p class="empty">${e(empty)}</p>`
    : `<ul class="rows">${items
        .map(
          (r) =>
            `<li><span class="row-main${r.bad ? " bad" : ""}">${chip(r.chip)}${e(r.title)}<span class="row-meta">${e(r.meta)}</span></span>${cancelForm(r.cancelAction)}</li>`,
        )
        .join("")}</ul>`;

/** One line per item (activity): the title, and its time on the right. */
const feed = (items: PanelRow[], empty: string): string =>
  items.length === 0
    ? `<p class="empty">${e(empty)}</p>`
    : `<ul class="feed">${items
        .map(
          (r) =>
            `<li><span${r.bad ? ' class="bad"' : ""}>${e(r.title)}</span><time>${e(r.meta)}</time></li>`,
        )
        .join("")}</ul>`;

const section = (title: string, body: string, cls = ""): string =>
  `<section${cls ? ` class="${cls}"` : ""}><h2>${e(title)}</h2>${body}</section>`;

function reminderHistory(items: ReminderItem[]): string {
  if (items.length === 0) return `<p class="empty">Todavía no has programado recordatorios.</p>`;
  return items
    .map(
      (
        r,
        i,
      ) => `<details${i === 0 ? " open" : ""}><summary><span class="row-main">${chip(r.chip)}${e(r.title)}<span class="row-meta">${e(r.meta)}</span></span>${cancelForm(r.cancelAction)}</summary>
<div class="detail">${
        r.runs.length === 0
          ? `<p class="empty">Aún no se ha enviado.</p>`
          : `<div class="scroll"><table><thead><tr><th>Cuándo</th><th>Resultado</th><th>Qué salió</th></tr></thead><tbody>${r.runs
              .map(
                (run) =>
                  `<tr><td class="when">${e(run.when)}</td><td>${chip({ text: run.outcome, tone: run.tone })}</td><td>${e(run.detail)}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
      }</div></details>`,
    )
    .join("");
}

function missionHistory(items: MissionItem[]): string {
  if (items.length === 0) return `<p class="empty">Todavía no has iniciado misiones.</p>`;
  // Open the first mission that has something to read (a conversation or a result).
  const first = Math.max(
    0,
    items.findIndex((m) => m.transcript.length > 0 || m.summary !== null),
  );
  return items
    .map((m, i) => {
      const parts: string[] = [];
      if (m.summary) parts.push(`<h3>Resultado</h3><p>${e(m.summary)}</p>`);
      if (m.collected.length)
        parts.push(
          `<h3>Datos obtenidos</h3><div class="scroll"><table><tbody>${m.collected
            .map((c) => `<tr><td>${e(c.label)}</td><td>${e(c.value)}</td></tr>`)
            .join("")}</tbody></table></div>`,
        );
      parts.push(
        `<h3>Conversación</h3>${
          m.transcript.length
            ? `<div class="chat">${m.transcript
                .map(
                  (t) =>
                    `<div class="msg${t.from === "agent" ? " agent" : ""}"><small>${t.from === "agent" ? "Tu asistente" : "Contacto"} · ${e(t.when)}</small>${e(t.text)}</div>`,
                )
                .join("")}</div>`
            : `<p class="empty">Sin mensajes todavía.</p>`
        }`,
      );
      return `<details${i === first ? " open" : ""}><summary><span class="row-main">${chip(m.chip)}${e(m.title)}<span class="row-meta">${e(m.meta)}</span></span>${cancelForm(m.cancelAction)}</summary><div class="detail">${parts.join("")}</div></details>`;
    })
    .join("");
}

function toolTable(totals: { label: string; calls: number; errors: number }[]): string {
  if (totals.length === 0) return `<p class="empty">Sin actividad en los últimos 30 días.</p>`;
  return `<div class="scroll"><table><thead><tr><th>Acción</th><th class="num">Veces</th><th class="num">Fallos</th></tr></thead><tbody>${totals
    .map(
      (t) =>
        `<tr><td>${e(t.label)}</td><td class="num">${t.calls}</td><td class="num">${t.errors || ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

export function panelPage(v: PanelView): string {
  const status = `<p class="status"><span class="dot${v.whatsapp.connected ? " on" : ""}"></span>${e(v.whatsapp.text)}</p>`;
  const whatsapp = v.whatsapp.connected
    ? status
    : `${status}<a class="link" href="/pair">Vincular WhatsApp</a>`;
  const upToDate = v.subscription === "Al día";
  const missionsOn = v.reminders !== null || v.missions !== null;
  const tabs: [PanelTab, string][] = [
    ["resumen", "Resumen"],
    ...(missionsOn
      ? ([
          ["recordatorios", "Recordatorios"],
          ["misiones", "Misiones"],
        ] as [PanelTab, string][])
      : []),
    ["actividad", "Actividad"],
  ];
  const nav = `<nav class="tabs" aria-label="Secciones">${tabs
    .map(
      ([id, label]) =>
        `<a href="/panel${id === "resumen" ? "" : `?tab=${id}`}"${v.tab === id ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("")}</nav>`;
  const metrics = `<div class="metrics">${v.metrics
    .map(
      (m) =>
        `<div class="metric"><b>${e(m.value)}</b><span>${e(m.label)}</span>${m.note ? `<small>${e(m.note)}</small>` : ""}</div>`,
    )
    .join("")}</div>`;

  let body: string;
  if (v.tab === "recordatorios" && v.reminderHistory)
    body = `<div class="grid">${section("Todos tus recordatorios", reminderHistory(v.reminderHistory))}</div>`;
  else if (v.tab === "misiones" && v.missionHistory)
    body = `<div class="grid">${section("Todas tus misiones", missionHistory(v.missionHistory))}</div>`;
  else if (v.tab === "actividad")
    body = `<div class="grid main">${section("Últimas acciones", feed(v.activity, "Tu asistente todavía no ha hecho nada."))}${section("Últimos 30 días", toolTable(v.toolTotals ?? []))}</div>`;
  else {
    const lists = [
      v.reminders
        ? section("Recordatorios activos", rows(v.reminders, "No tienes recordatorios activos."))
        : "",
      v.missions ? section("Misiones en curso", rows(v.missions, "No hay misiones en curso.")) : "",
    ].join("");
    body = `<div class="grid two">${section("WhatsApp", whatsapp)}${section(
      "Tu cuenta",
      `<p class="status">${v.email ? e(v.email) : "Sin correo de recuperación"}</p><p class="row-meta">Usuario ${e(v.username)}${upToDate ? ` · Suscripción <span class="chip ok">Al día</span>` : ""}</p>`,
    )}</div>
<div class="grid${lists ? " main" : ""}">${lists ? `<div class="stack">${lists}</div>` : ""}${section("Actividad reciente", feed(v.activity, "Tu asistente todavía no ha hecho nada."), "activity")}</div>`;
  }

  return layout(
    "Tu panel",
    `<div class="top"><h1>Hola, ${e(v.username)}</h1>
<form class="inline" method="post" action="/panel/logout"><button type="submit">Salir</button></form></div>${
      v.subscription && !upToDate ? `<p class="notice warn">${e(v.subscription)}</p>` : ""
    }
${nav}
${metrics}
${body}`,
    PANEL_STYLE,
  );
}
