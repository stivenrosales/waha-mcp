/** HTML pages for invite sign-up, password reset and WhatsApp pairing. */
import { createHash } from "node:crypto";
import {
  credentialFields,
  errorLine,
  escapeHtml,
  forgotLink,
  layout,
  passwordField,
} from "../auth/loginPage.js";

export const TRUST_NOTICE =
  "Tus mensajes se guardan cifrados con una llave propia de tu cuenta y puedes borrarlos cuando quieras.";

/** Seconds between background checks of a pairing page that is waiting on WhatsApp. */
const POLL_SECONDS = 4;
/** Without JavaScript the page reloads itself instead, less often than the background check. */
const NOSCRIPT_REFRESH_SECONDS = 10;

/**
 * Fetches the page in the background and reloads it only when what it shows changes (a new QR,
 * pairing done, an error). Reloading on a timer swapped the QR while people were scanning it.
 * The CSP allows exactly this text, by its hash (see the pair routes).
 */
export const PAIR_POLL_SCRIPT = `(()=>{const key=d=>{const i=d.querySelector(".qr img");return(d.querySelector("h1")?.textContent??"")+"|"+(i?i.getAttribute("src"):"")};const now=key(document);const tick=async()=>{try{const r=await fetch(location.href,{credentials:"same-origin",cache:"no-store"});const d=new DOMParser().parseFromString(await r.text(),"text/html");if(key(d)!==now){location.reload();return}}catch{}setTimeout(tick,${POLL_SECONDS * 1000})};setTimeout(tick,${POLL_SECONDS * 1000})})()`;
export const PAIR_POLL_HASH = createHash("sha256").update(PAIR_POLL_SCRIPT).digest("base64");

const refresh = `<noscript><meta http-equiv="refresh" content="${NOSCRIPT_REFRESH_SECONDS}"></noscript>\n`;
const AUTO_REFRESH = `<p class="muted">Esta página se actualiza sola cuando hay novedades.</p>
<script>${PAIR_POLL_SCRIPT}</script>`;

/** Path of the public page that explains who can see a tenant's data. */
export const PRIVACY_PATH = "/privacidad";

const notice = `<p class="notice">${escapeHtml(TRUST_NOTICE)} <a href="${PRIVACY_PATH}">Cómo se tratan tus datos</a></p>`;

const newPasswordFields = `${passwordField("password", "Contraseña (mínimo 12 caracteres)", 'autocomplete="new-password" minlength="12"')}
${passwordField("password_confirm", "Repite la contraseña", 'autocomplete="new-password" minlength="12"')}`;

/** Forms post back to the page's own URL (no `action`), so the link token stays out of the markup. */
export function invitePage(
  opts: { username?: string; email?: string; error?: string; askEmail?: boolean } = {},
): string {
  return layout(
    "Crea tu cuenta",
    `<h1>Crea tu cuenta</h1>
${
  opts.askEmail
    ? `<p class="lead">Escribe tu correo y elige una contraseña. Con ellos entrarás a tu cuenta, y el correo te sirve para recuperarla. Después vincularás tu WhatsApp escaneando un código QR.</p>
${notice}
${errorLine(opts.error)}
<form method="post">
<label for="email">Correo</label>
<input id="email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" value="${escapeHtml(opts.email ?? "")}" required autofocus>
`
    : `<p class="lead">Elige un usuario y una contraseña. Después vincularás tu WhatsApp escaneando un código QR.</p>
${notice}
${errorLine(opts.error)}
<form method="post">
<label for="username">Usuario</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" value="${escapeHtml(opts.username ?? "")}" required autofocus>
`
}${newPasswordFields}
<button type="submit">Crear cuenta</button>
</form>`,
  );
}

export function resetPage(opts: { error?: string } = {}): string {
  return layout(
    "Nueva contraseña",
    `<h1>Elige una nueva contraseña</h1>
<p class="lead">Se cerrará la sesión en todas las aplicaciones conectadas a tu cuenta.</p>
${errorLine(opts.error)}
<form method="post">
${newPasswordFields}
<button type="submit">Cambiar contraseña</button>
</form>`,
  );
}

export function pairLoginPage(
  opts: { username?: string; error?: string; forgotUrl?: string } = {},
): string {
  return layout(
    "Conectar WhatsApp",
    `<h1>Conecta tu WhatsApp</h1>
<p class="lead">Inicia sesión para vincular tu WhatsApp con este servidor, o para volver a vincularlo si se desconectó.</p>
${errorLine(opts.error)}
<form method="post" action="pair">
${credentialFields(opts.username)}
<button type="submit">Continuar</button>
</form>${forgotLink(opts.forgotUrl)}`,
  );
}

export function pairQrPage(opts: { dataUri: string; showTrustNotice: boolean }): string {
  return layout(
    "Escanea el código QR",
    `<h1>Escanea el código QR</h1>
${opts.showTrustNotice ? `${notice}\n` : ""}<ol class="steps">
<li><span>Abre <strong>WhatsApp</strong> en tu teléfono.</span></li>
<li><span>Ve a <strong>Dispositivos vinculados</strong>.</span></li>
<li><span>Toca <strong>Vincular un dispositivo</strong> y escanea este código.</span></li>
</ol>
<div class="qr"><img src="${escapeHtml(opts.dataUri)}" alt="Código QR para vincular WhatsApp" width="264" height="264"></div>
${AUTO_REFRESH}`,
    refresh,
  );
}

/** A pairing page that waits for WhatsApp and reloads itself. */
export function pairWaitPage(title: string, message: string): string {
  return layout(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p class="lead">${escapeHtml(message)}</p>
${AUTO_REFRESH}`,
    refresh,
  );
}

export function pairDonePage(mcpUrl: string): string {
  return layout(
    "WhatsApp conectado",
    `<h1>Tu WhatsApp está conectado</h1>
<p class="lead">Ya puedes cerrar esta página. Para usarlo desde tu cliente MCP, agrega esta URL de servidor e inicia sesión con tu usuario y contraseña:</p>
<code>${escapeHtml(mcpUrl)}</code>`,
  );
}

export function pairTakenPage(message: string): string {
  return layout(
    "Número ya conectado",
    `<h1>Este número ya está conectado</h1>
<p class="lead">${escapeHtml(message)}</p>
<p><a href="pair">Vincular otro número</a></p>`,
  );
}

/**
 * Public, honest account of what the server stores and who can see it. `cacheRetentionDays` is
 * `CACHE_RETENTION_DAYS` (0: cached data is kept until deleted).
 */
export function privacyPage(opts: { cacheRetentionDays: number }): string {
  const days = opts.cacheRetentionDays;
  const retention =
    days > 0
      ? `Los mensajes guardados, sus ediciones, reacciones y votos, y las transcripciones se borran solos a los ${days} días, en una limpieza que corre una vez al día. Si tu cuenta está suspendida, se borran cuando la reactiven.`
      : "Este servidor no borra automáticamente los mensajes guardados ni las transcripciones: se guardan hasta que los borres tú o eliminen tu cuenta.";
  return layout(
    "Privacidad",
    `<h1>Cómo se tratan tus datos</h1>
<p class="lead">Para entregarle tus mensajes a tu IA, el servidor necesita leerlos, así que no tiene cifrado de extremo a extremo. Aquí está, sin letra pequeña, qué se guarda y quién puede verlo.</p>
<h2>Qué se guarda</h2>
<ul class="steps">
<li><span>Una copia de tus mensajes y de las transcripciones de tus notas de voz, cifrada con una llave propia de tu cuenta.</span></li>
<li><span>Tu usuario y tu contraseña; la contraseña solo como hash, nunca en texto.</span></li>
<li><span>Si usas misiones: las instrucciones, la conversación, las preguntas y los resúmenes de cada misión, cifrados con la misma llave de tu cuenta. Los datos de control de cada misión (con qué chat o contacto, fechas, estado y contadores) se guardan sin ese cifrado, igual que los identificadores de chat de tus mensajes.</span></li>
<li><span>Registros de uso: qué herramienta se usó, cuándo, si funcionó, cuánto costó cada transcripción y cuántos tokens usó y cuánto costó cada llamada al modelo de las misiones. Nunca el contenido de tus mensajes.</span></li>
</ul>
<h2>Quién puede verlo</h2>
<ul class="steps">
<li><span><strong>Tú</strong>, desde la aplicación que conectes con tu usuario y contraseña.</span></li>
<li><span><strong>Quien opera el servidor</strong> lo mantiene funcionando, pero no tiene herramientas para leer tus chats y se compromete a no hacerlo.</span></li>
<li><span><strong>La aplicación de IA que conectes</strong> (por ejemplo, Claude) recibe los mensajes que le pidas leer o enviar.</span></li>
<li><span><strong>El servicio de transcripción</strong> recibe el audio de tus notas de voz cuando se transcriben.</span></li>
</ul>
<h2>Misiones</h2>
<ul class="steps">
<li><span>Una misión es una conversación que un asistente de IA lleva por ti en un chat de WhatsApp. Para escribir cada respuesta, la conversación de la misión (tus instrucciones y los mensajes de ese chat, incluidos audios transcritos, imágenes y documentos que te envíen) se manda a <strong>OpenRouter</strong>, que la entrega al modelo Claude de <strong>Anthropic</strong> (o, si Anthropic falla, a otro proveedor del mismo modelo).</span></li>
<li><span>El contenido de cada misión y sus datos de control se borran 30 días después de que termina, en una limpieza que corre una vez al día. Si tu cuenta está suspendida, se guardan hasta que la reactiven (entonces se borran en el plazo de un día) o la eliminen. Si eliminan tu cuenta, se borran en ese momento junto con todo lo demás.</span></li>
<li><span>El administrador no accede al contenido de las misiones: no tiene herramientas para leerlo y se compromete a no hacerlo. Solo ve cuántas llamadas al modelo hizo cada cuenta y cuánto costaron.</span></li>
</ul>
<h2>Cuánto tiempo se guarda</h2>
<ul class="steps">
<li><span>${retention}</span></li>
<li><span>Nunca se borran solos tu cuenta, tu usuario, tus aplicaciones conectadas ni tus misiones o mensajes programados activos.</span></li>
</ul>
<h2>Cómo salir</h2>
<p>Desde la aplicación que conectes (por ejemplo, Claude) puedes pedir dos cosas, que solo actúan sobre tu cuenta, nunca sobre la de otra persona:</p>
<ul class="steps">
<li><span><strong>Borrar tus datos</strong> (<code>delete_my_data</code>): borra en el momento tus mensajes guardados, sus ediciones, reacciones y votos, las transcripciones y el contenido de tus misiones y mensajes programados que ya terminaron. Tu cuenta sigue funcionando.</span></li>
<li><span><strong>Desvincularte</strong> (<code>unlink_account</code>): cierra la sesión de tu WhatsApp en este servidor y en todas las aplicaciones conectadas. Para volver, inicia sesión en <a href="/pair">/pair</a> y escanea el código QR.</span></li>
</ul>
<p>También puedes cortar el acceso desde tu teléfono: ve a <strong>Dispositivos vinculados</strong> y cierra la sesión de este servidor. Para borrar todo, pide al administrador que elimine tu cuenta: se borran tu usuario, tu llave, los mensajes guardados, tus misiones y la sesión de WhatsApp.</p>`,
  );
}

export function forgotPage(opts: { email?: string; error?: string } = {}): string {
  return layout(
    "Recuperar contraseña",
    `<h1>Recupera tu contraseña</h1>
<p class="lead">Escribe el correo de tu cuenta y te enviaremos un enlace para elegir una contraseña nueva.</p>
${errorLine(opts.error)}
<form method="post" action="forgot">
<label for="email">Correo</label>
<input id="email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" value="${escapeHtml(opts.email ?? "")}" required autofocus>
<button type="submit">Enviar enlace</button>
</form>`,
  );
}
