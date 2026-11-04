/** HTML pages for invite sign-up, password reset and WhatsApp pairing. No scripts. */
import { credentialFields, errorLine, escapeHtml, layout } from "../auth/loginPage.js";

export const TRUST_NOTICE =
  "El administrador de este servidor puede acceder técnicamente a tus datos de WhatsApp. Continúa solo si confías en quien lo administra.";

/** Seconds between automatic reloads of a pairing page that is waiting on WhatsApp. */
const REFRESH_SECONDS = 5;
const refresh = `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">\n`;
const AUTO_REFRESH = `<p class="muted">Esta página se actualiza sola cada pocos segundos.</p>`;

const notice = `<p class="notice">${escapeHtml(TRUST_NOTICE)}</p>`;

const newPasswordFields = `<label for="password">Contraseña (mínimo 12 caracteres)</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
<label for="password_confirm">Repite la contraseña</label>
<input id="password_confirm" name="password_confirm" type="password" autocomplete="new-password" minlength="12" required>`;

/** Forms post back to the page's own URL (no `action`), so the link token stays out of the markup. */
export function invitePage(opts: { username?: string; error?: string } = {}): string {
  return layout(
    "Crea tu cuenta",
    `<h1>Crea tu cuenta</h1>
<p class="lead">Elige un usuario y una contraseña. Después vincularás tu WhatsApp escaneando un código QR.</p>
${notice}
${errorLine(opts.error)}
<form method="post">
<label for="username">Usuario</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" value="${escapeHtml(opts.username ?? "")}" required autofocus>
${newPasswordFields}
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

export function pairLoginPage(opts: { username?: string; error?: string } = {}): string {
  return layout(
    "Conectar WhatsApp",
    `<h1>Conecta tu WhatsApp</h1>
<p class="lead">Inicia sesión para vincular tu WhatsApp con este servidor, o para volver a vincularlo si se desconectó.</p>
${errorLine(opts.error)}
<form method="post" action="pair">
${credentialFields(opts.username)}
<button type="submit">Continuar</button>
</form>`,
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
