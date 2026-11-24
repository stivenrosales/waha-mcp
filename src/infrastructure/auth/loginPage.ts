import { createHash } from "node:crypto";

/**
 * Self-contained HTML pages for login, logout and onboarding. One inline script (the show-password
 * toggle, allowed by its hash) and self-hosted fonts.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/**
 * The only script any page runs: the show-password toggle next to each password field. Without
 * it the fields work as plain password inputs. The CSP allows exactly this text, by its hash.
 */
export const TOGGLE_SCRIPT =
  'for(const b of document.querySelectorAll(".pw-toggle"))b.addEventListener("click",()=>{const i=b.previousElementSibling;const show=i.type==="password";i.type=show?"text":"password";b.setAttribute("aria-pressed",String(show));b.setAttribute("aria-label",show?"Ocultar contraseña":"Mostrar contraseña")})';
const TOGGLE_HASH = createHash("sha256").update(TOGGLE_SCRIPT).digest("base64");

/**
 * Security headers for every HTML page: no framing (clickjacking), no scripts but the toggle,
 * no external resources (only the page font, served by this server), no caching,
 * no referrer leaking query parameters.
 * `form-action` is deliberately not set: browsers apply it to the redirect that
 * follows a successful login, which would block the redirect to the client.
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  // img-src 'self' lets the tab icon (/favicon.svg) load; browsers apply img-src to favicons.
  "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${TOGGLE_HASH}'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** Path of the self-hosted UI font (see `src/infrastructure/http/fonts.ts`). */
/** Body text face (DM Sans), preloaded by every page. */
export const FONT_PATH = "/assets/dm-sans.woff2";
const DISPLAY_FONT_PATH = "/assets/newsreader.woff2";

/**
 * Zenbox's visual system (usezenbox.com): cream paper, ink text, one sage accent, Newsreader
 * for titles and DM Sans for text, soft corners and pill buttons.
 */
const STYLE = `
@font-face{font-family:"DM Sans";src:url(${FONT_PATH}) format("woff2");font-weight:100 1000;font-display:swap}
@font-face{font-family:Newsreader;src:url(${DISPLAY_FONT_PATH}) format("woff2");font-weight:200 800;font-display:swap}
:root{--ink:#2f3437;--muted:#5d6366;--paper:#f6f3ec;--paper-hi:#fbfaf6;--sand:#ece7dc;--line:#e0dbcf;--moss:#5e8b7e;--moss-deep:#47695f;--mist:#dfe8e3}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font:400 1rem/1.6 "DM Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{flex:1;width:100%;max-width:27rem;margin:0 auto;padding:clamp(2.5rem,9vh,5.5rem) 1.5rem 3rem;animation:rise .9s cubic-bezier(.22,1,.36,1) both}
.brand{display:flex;align-items:center;gap:.6rem;margin:0 0 2rem;color:var(--ink);text-decoration:none;font:500 1.35rem/1 Newsreader,Georgia,serif;letter-spacing:-.01em}
.brand svg{flex:0 0 auto}
h1{margin:0 0 .85rem;font:400 clamp(2rem,6.5vw,2.6rem)/1.08 Newsreader,Georgia,serif;letter-spacing:-.015em;text-wrap:balance}
h2{margin:2.25rem 0 .75rem;font-size:.78rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--moss-deep)}
p{margin:0 0 1rem}
.lead{color:var(--muted);margin-bottom:2rem}
strong{font-weight:600;color:var(--ink)}
.notice{margin:0 0 2rem;padding:.95rem 1.1rem;border-radius:.9rem;background:var(--mist);color:var(--moss-deep);font-size:.92rem}
.error{margin:0 0 1.5rem;padding:.8rem 1.1rem;border-radius:.9rem;background:var(--sand);font-weight:600;font-size:.92rem}
form{margin:0}
label{display:block;margin:0 0 .45rem;font-size:.82rem;font-weight:600}
input[type=text],input[type=password],input[type=email]{display:block;width:100%;height:3rem;margin:0 0 1.35rem;padding:0 1rem;border:1px solid var(--line);border-radius:.75rem;background:var(--paper-hi);color:var(--ink);font:inherit;transition:border-color .2s,background .2s}
input[type=text]:hover,input[type=password]:hover,input[type=email]:hover{border-color:#c9c2b2}
input:focus{outline:none;border-color:var(--moss);background:#fff;box-shadow:0 0 0 3px rgba(94,139,126,.18)}
input[type=file]{display:block;width:100%;margin:0 0 1.35rem;padding:1.1rem;border:1px dashed var(--line);border-radius:.75rem;background:var(--paper-hi);font:inherit;font-size:.9rem;color:var(--muted)}
input[type=file]::file-selector-button{margin-right:.9rem;padding:.5rem 1rem;border:1px solid var(--moss);border-radius:999px;background:transparent;color:var(--moss-deep);font:inherit;font-weight:500;cursor:pointer}
.pw{position:relative;margin:0 0 1.35rem}
.pw input{margin:0;padding-right:3rem}
.pw .pw-toggle{position:absolute;top:0;right:0;width:3rem;height:3rem;margin:0;padding:0;display:flex;align-items:center;justify-content:center;border-radius:.75rem;background:transparent;color:var(--muted)}
.pw .pw-toggle:hover{background:transparent;color:var(--moss-deep)}
.pw .pw-toggle[aria-pressed=true]{color:var(--moss)}
button{display:block;width:100%;height:3.1rem;margin-top:.5rem;border:0;border-radius:999px;background:var(--moss);color:var(--paper-hi);font:inherit;font-weight:500;cursor:pointer;transition:background .2s}
button:hover{background:var(--moss-deep)}
button:focus-visible,a:focus-visible{outline:2px solid var(--moss);outline-offset:3px}
a{color:var(--moss-deep);text-underline-offset:.22em;text-decoration-color:rgba(71,105,95,.35)}
a:hover{text-decoration-color:var(--moss-deep)}
.muted{color:var(--muted);font-size:.88rem}
.qr{display:flex;justify-content:center;margin:0 0 1.5rem;padding:1.4rem;background:#fff;border:1px solid var(--line);border-radius:1.25rem}
.qr img{display:block;width:100%;max-width:16.5rem;height:auto;image-rendering:pixelated}
.steps{margin:0 0 1.75rem;padding:0;list-style:none;counter-reset:s;border-top:1px solid var(--line)}
ul.steps li::before{content:"";flex:0 0 .4rem;width:.4rem;height:.4rem;padding:0;margin-top:.6rem;border-radius:50%;background:var(--moss)}
.steps li{counter-increment:s;display:flex;gap:.9rem;padding:.8rem 0;border-bottom:1px solid var(--line);font-size:.93rem}
.steps li::before{content:counter(s,decimal-leading-zero);flex:0 0 1.5rem;font-variant-numeric:tabular-nums;font-size:.75rem;font-weight:600;color:var(--moss);padding-top:.15rem}
code{display:block;margin:0 0 1rem;padding:.85rem 1rem;border:1px solid var(--line);border-radius:.75rem;background:var(--paper-hi);font:500 .88rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
footer{padding:1.4rem 1.5rem 1.8rem;border-top:1px solid var(--line);text-align:center;font-size:.8rem;color:var(--muted)}
footer a{color:var(--muted)}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){main{animation:none}*{transition:none!important}}
`;

/** The Zenbox ensō, inline so the page logo needs no image request. */
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="73.3 52.8 880.4 880.4" width="28" height="28" aria-hidden="true" focusable="false">  <g transform="translate(0.000000,1024.000000) scale(0.100000,-0.100000)" fill="#5E8B7E" stroke="none"> <path d="M4910 8854 c-747 -41 -1474 -318 -2030 -772 -1112 -910 -1535 -2457 -980 -3587 135 -276 258 -371 470 -363 160 5 292 92 363 237 50 102 47 246 -7 381 -249 627 -226 1214 73 1823 376 768 1063 1254 1921 1361 1057 131 2004 -270 2546 -1080 465 -696 550 -1619 219 -2395 -364 -852 -1147 -1430 -2080 -1534 -515 -58 -1001 31 -1470 268 -77 39 -174 88 -215 109 -154 78 -310 68 -438 -26 -65 -47 -87 -78 -162 -221 -224 -428 -500 -810 -761 -1049 -76 -70 -88 -89 -89 -140 0 -63 51 -106 127 -106 265 0 883 213 1373 474 l125 67 125 -50 c575 -228 1196 -279 1810 -150 1471 310 2550 1436 2757 2879 25 177 25 718 0 900 -211 1499 -1348 2661 -2862 2925 -226 39 -592 61 -815 49z"/> </g> <g transform="translate(0.000000,1024.000000) scale(0.100000,-0.100000)" fill="#2F3437" stroke="none"> <path d="M3810 5736 c-126 -27 -229 -109 -284 -226 -47 -98 -46 -244 1 -341 39 -80 120 -159 200 -197 90 -42 241 -40 335 5 357 169 288 689 -102 763 -64 12 -79 12 -150 -4z"/> <path d="M5032 5735 c-120 -27 -222 -109 -276 -225 -46 -98 -45 -245 1 -341 39 -80 120 -159 200 -197 90 -41 241 -40 334 4 162 77 252 245 227 425 -31 232 -255 386 -486 334z"/> <path d="M6264 5735 c-375 -81 -434 -594 -87 -758 101 -48 247 -48 344 0 80 40 159 120 197 200 40 85 40 241 0 326 -58 124 -153 203 -278 231 -81 19 -95 19 -176 1z"/> </g> </svg>`;

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
${head}<title>${escapeHtml(title)} · Zenbox</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="${FONT_PATH}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${DISPLAY_FONT_PATH}" as="font" type="font/woff2" crossorigin>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">${MARK}Zenbox</p>
${body}
</main>
<footer>Zenbox · <a href="https://usezenbox.com">usezenbox.com</a></footer>
${body.includes('class="pw-toggle"') ? `<script>${TOGGLE_SCRIPT}</script>\n` : ""}</body>
</html>`;

export const errorLine = (error?: string): string =>
  error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";

/** A password input with its show/hide button (the button does nothing without the script). */
export const passwordField = (id: string, label: string, attrs: string): string =>
  `<label for="${id}">${escapeHtml(label)}</label>
<div class="pw"><input id="${id}" name="${id}" type="password" ${attrs} required><button type="button" class="pw-toggle" aria-label="Mostrar contraseña" aria-pressed="false"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button></div>`;

/** Email-or-username and current-password fields shared by every sign-in form. */
export const credentialFields = (username = ""): string =>
  `<label for="username">Correo o usuario</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254" value="${escapeHtml(username)}" required autofocus>
${passwordField("password", "Contraseña", 'autocomplete="current-password"')}`;

/** "Forgot password?" link under a sign-in form; empty when password recovery is off. */
export const forgotLink = (forgotUrl?: string): string =>
  forgotUrl
    ? `\n<p class="muted" style="margin-top:1rem;text-align:center"><a href="${escapeHtml(forgotUrl)}">¿Olvidaste tu contraseña?</a></p>`
    : "";

export function loginPage(opts: {
  params: Record<string, string>;
  redirectHost: string;
  username?: string;
  error?: string;
  /** Shown when password recovery by email is on. */
  forgotUrl?: string;
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
</form>${forgotLink(opts.forgotUrl)}`,
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
