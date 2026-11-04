/** Self-contained HTML pages for login, logout and onboarding. No scripts; one self-hosted font. */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/**
 * Security headers for every HTML page: no framing (clickjacking), no scripts,
 * no external resources (only the page font, served by this server), no caching,
 * no referrer leaking query parameters.
 * `form-action` is deliberately not set: browsers apply it to the redirect that
 * follows a successful login, which would block the redirect to the client.
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** Path of the self-hosted UI font (see `src/infrastructure/http/fonts.ts`). */
export const FONT_PATH = "/assets/satoshi.woff2";

/**
 * Visual system: warm paper background, ink text, fine lines, one moss accent,
 * rectangular controls. Neutral-first; no red (errors use ink on sand).
 */
const STYLE = `
@font-face{font-family:Satoshi;src:url(${FONT_PATH}) format("woff2");font-weight:300 900;font-display:swap}
:root{--ink:#1a1a18;--paper:#f6f4ef;--sand:#e4dfd3;--line:#cfc8b8;--moss:#3e5a3a;--muted:#5f5d56}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font:400 1rem/1.55 Satoshi,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{flex:1;width:100%;max-width:27rem;margin:0 auto;padding:clamp(2.5rem,10vh,6.5rem) 1.5rem 3rem;animation:rise .9s cubic-bezier(.22,1,.36,1) both}
.eyebrow{display:flex;align-items:center;gap:.55rem;margin:0 0 1.75rem;font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.eyebrow::before{content:"";width:.5rem;height:.5rem;border-radius:50%;background:var(--moss)}
h1{margin:0 0 .85rem;font-size:clamp(1.85rem,6vw,2.35rem);line-height:1.1;font-weight:500;letter-spacing:-.028em}
p{margin:0 0 1rem}
.lead{color:var(--muted);margin-bottom:2rem}
strong{font-weight:600;color:var(--ink)}
.notice{margin:0 0 2rem;padding:.95rem 1.1rem;border-left:2px solid var(--moss);background:rgba(228,223,211,.55);font-size:.92rem}
.error{margin:0 0 1.5rem;padding:.8rem 1.1rem;background:var(--sand);border-left:2px solid var(--ink);font-weight:600;font-size:.92rem}
form{margin:0}
label{display:block;margin:0 0 .45rem;font-size:.8rem;font-weight:600;letter-spacing:.01em}
input[type=text],input[type=password]{display:block;width:100%;height:3rem;margin:0 0 1.35rem;padding:0 .95rem;border:1px solid var(--line);border-radius:0;background:#fbfaf7;color:var(--ink);font:inherit;transition:border-color .2s,background .2s}
input[type=text]:hover,input[type=password]:hover{border-color:#b9b19f}
input:focus{outline:none;border-color:var(--moss);background:#fff;box-shadow:0 0 0 3px rgba(62,90,58,.14)}
input[type=file]{display:block;width:100%;margin:0 0 1.35rem;padding:1.1rem;border:1px dashed var(--line);background:#fbfaf7;font:inherit;font-size:.9rem;color:var(--muted)}
input[type=file]::file-selector-button{margin-right:.9rem;padding:.5rem .9rem;border:1px solid var(--ink);background:transparent;color:var(--ink);font:inherit;font-weight:500;cursor:pointer}
button{display:block;width:100%;height:3.1rem;margin-top:.5rem;border:0;border-radius:0;background:var(--ink);color:var(--paper);font:inherit;font-weight:500;letter-spacing:.01em;cursor:pointer;transition:background .2s}
button:hover{background:var(--moss)}
button:focus-visible,a:focus-visible{outline:2px solid var(--moss);outline-offset:3px}
a{color:var(--ink);text-underline-offset:.22em;text-decoration-color:var(--line)}
a:hover{text-decoration-color:var(--moss)}
.muted{color:var(--muted);font-size:.88rem}
.qr{display:flex;justify-content:center;margin:0 0 1.5rem;padding:1.4rem;background:#fff;border:1px solid var(--line)}
.qr img{display:block;width:100%;max-width:16.5rem;height:auto;image-rendering:pixelated}
.steps{margin:0 0 1.75rem;padding:0;list-style:none;counter-reset:s;border-top:1px solid var(--line)}
.steps li{counter-increment:s;display:flex;gap:.9rem;padding:.8rem 0;border-bottom:1px solid var(--line);font-size:.93rem}
.steps li::before{content:counter(s,decimal-leading-zero);flex:0 0 1.5rem;font-variant-numeric:tabular-nums;font-size:.75rem;font-weight:700;color:var(--moss);padding-top:.15rem}
code{display:block;margin:0 0 1rem;padding:.85rem 1rem;border:1px solid var(--line);background:#fbfaf7;font:500 .88rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
footer{padding:1.4rem 1.5rem 1.8rem;border-top:1px solid var(--line);text-align:center;font-size:.75rem;letter-spacing:.04em;color:var(--muted)}
footer strong{font-weight:600;letter-spacing:0}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){main{animation:none}*{transition:none!important}}
`;

/** Small label above every page title. */
const EYEBROW = "WhatsApp · MCP";

/**
 * A full page. `body` is trusted markup; `head` is trusted markup added to `<head>`
 * (e.g. a refresh `<meta>`).
 */
export const layout = (title: string, body: string, head = ""): string =>
  `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
${head}<title>${escapeHtml(title)}</title>
<link rel="preload" href="${FONT_PATH}" as="font" type="font/woff2" crossorigin>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">${EYEBROW}</p>
${body}
</main>
<footer>Powered by <strong>Stiven Rosales</strong></footer>
</body>
</html>`;

export const errorLine = (error?: string): string =>
  error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";

/** Username and current-password fields shared by every sign-in form. */
export const credentialFields = (username = ""): string =>
  `<label for="username">Usuario</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" value="${escapeHtml(username)}" required autofocus>
<label for="password">Contraseña</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>`;

export function loginPage(opts: {
  params: Record<string, string>;
  redirectHost: string;
  username?: string;
  error?: string;
}): string {
  const hidden = Object.entries(opts.params)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("\n");
  return layout(
    "Iniciar sesión",
    `<h1>Inicia sesión</h1>
<p class="lead">Una aplicación en <strong>${escapeHtml(opts.redirectHost)}</strong> quiere acceder a tus chats de WhatsApp y enviar mensajes desde tu número.</p>
${errorLine(opts.error)}
<form method="post" action="authorize">
${hidden}
${credentialFields(opts.username)}
<button type="submit">Autorizar acceso</button>
</form>`,
  );
}

export function logoutPage(opts: { username?: string; error?: string } = {}): string {
  return layout(
    "Cerrar sesión",
    `<h1>Cerrar sesión</h1>
<p class="lead">Se revocan los accesos de tu cuenta. Tus aplicaciones conectadas tendrán que iniciar sesión otra vez; las demás cuentas no se ven afectadas.</p>
${errorLine(opts.error)}
<form method="post" action="logout">
${credentialFields(opts.username)}
<button type="submit">Cerrar sesión</button>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1>\n<p class="lead">${escapeHtml(message)}</p>`);
}
