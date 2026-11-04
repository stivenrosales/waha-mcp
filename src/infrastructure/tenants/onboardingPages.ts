/** HTML pages for invite sign-up, password reset and WhatsApp pairing. No scripts. */
import { credentialFields, errorLine, escapeHtml, layout } from "../auth/loginPage.js";

export const TRUST_NOTICE =
  "The administrator of this server can technically access your WhatsApp data. Only continue if you trust them.";

/** Seconds between automatic reloads of a pairing page that is waiting on WhatsApp. */
const REFRESH_SECONDS = 5;
const refresh = `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">\n`;

const newPasswordFields = `<label for="password">Password (at least 12 characters)</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
<label for="password_confirm">Repeat the password</label>
<input id="password_confirm" name="password_confirm" type="password" autocomplete="new-password" minlength="12" required>`;

/** Forms post back to the page's own URL (no `action`), so the link token stays out of the markup. */
export function invitePage(opts: { username?: string; error?: string } = {}): string {
  return layout(
    "Create your account - waha-mcp",
    `<h1>Create your account</h1>
<p><strong>${escapeHtml(TRUST_NOTICE)}</strong></p>
<p class="muted">Choose a username and a password. Next you will link your WhatsApp by scanning a QR code.</p>
${errorLine(opts.error)}
<form method="post">
<label for="username">Username</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" value="${escapeHtml(opts.username ?? "")}" required autofocus>
${newPasswordFields}
<button type="submit">Create account</button>
</form>`,
  );
}

export function resetPage(opts: { error?: string } = {}): string {
  return layout(
    "Choose a new password - waha-mcp",
    `<h1>Choose a new password</h1>
<p class="muted">Every app connected to your account will be signed out.</p>
${errorLine(opts.error)}
<form method="post">
${newPasswordFields}
<button type="submit">Change password</button>
</form>`,
  );
}

export function pairLoginPage(opts: { username?: string; error?: string } = {}): string {
  return layout(
    "Connect WhatsApp - waha-mcp",
    `<h1>Connect WhatsApp</h1>
<p class="muted">Sign in to link your WhatsApp to this server, or to link it again after it was disconnected.</p>
${errorLine(opts.error)}
<form method="post" action="pair">
${credentialFields(opts.username)}
<button type="submit">Continue</button>
</form>`,
  );
}

export function pairQrPage(opts: { dataUri: string; showTrustNotice: boolean }): string {
  return layout(
    "Scan the QR code - waha-mcp",
    `<h1>Scan the QR code</h1>
${opts.showTrustNotice ? `<p><strong>${escapeHtml(TRUST_NOTICE)}</strong></p>\n` : ""}<p>On your phone open WhatsApp, go to <strong>Linked devices</strong>, tap <strong>Link a device</strong> and scan this code.</p>
<p><img src="${escapeHtml(opts.dataUri)}" alt="WhatsApp pairing QR code" width="264" height="264"></p>
<p class="muted">This page refreshes by itself every few seconds.</p>`,
    refresh,
  );
}

/** A pairing page that waits for WhatsApp and reloads itself. */
export function pairWaitPage(title: string, message: string): string {
  return layout(
    `${title} - waha-mcp`,
    `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="muted">This page refreshes by itself every few seconds.</p>`,
    refresh,
  );
}

export function pairDonePage(mcpUrl: string): string {
  return layout(
    "WhatsApp connected - waha-mcp",
    `<h1>WhatsApp is connected</h1>
<p>You can close this page. To use it from your MCP client, add this server URL and sign in with your username and password:</p>
<p><code>${escapeHtml(mcpUrl)}</code></p>`,
  );
}

export function pairTakenPage(message: string): string {
  return layout(
    "Number already connected - waha-mcp",
    `<h1>Number already connected</h1>
<p>${escapeHtml(message)}</p>
<p><a href="pair">Link a different number</a></p>`,
  );
}
