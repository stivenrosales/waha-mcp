/** Minimal, self-contained HTML pages for login and logout. No external assets. */

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
 * no external resources, no caching, no referrer leaking query parameters.
 * `form-action` is deliberately not set: browsers apply it to the redirect that
 * follows a successful login, which would block the redirect to the client.
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const STYLE = `
body{font-family:system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.3rem}
label{display:block;margin:1rem 0 .3rem}
input[type=password]{width:100%;padding:.5rem;box-sizing:border-box;font-size:1rem}
button{margin-top:1rem;padding:.5rem 1rem;font-size:1rem}
.error{color:#b00020}
.muted{color:#666;font-size:.9rem}
`;

const layout = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;

const errorLine = (error?: string): string =>
  error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";

const keyField = `<label for="waha_key">WAHA API key</label>
<input id="waha_key" name="waha_key" type="password" autocomplete="current-password" required autofocus>`;

export function loginPage(opts: {
  params: Record<string, string>;
  redirectHost: string;
  error?: string;
}): string {
  const hidden = Object.entries(opts.params)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("\n");
  return layout(
    "Sign in - waha-mcp",
    `<h1>Sign in to waha-mcp</h1>
<p class="muted">An application at <strong>${escapeHtml(opts.redirectHost)}</strong> is requesting read-only access to your WhatsApp data.</p>
${errorLine(opts.error)}
<form method="post" action="authorize">
${hidden}
${keyField}
<button type="submit">Authorize</button>
</form>`,
  );
}

export function logoutPage(opts: { error?: string } = {}): string {
  return layout(
    "Log out - waha-mcp",
    `<h1>Log out all clients</h1>
<p class="muted">This revokes every token and registered client. Connected apps must sign in again.</p>
${errorLine(opts.error)}
<form method="post" action="logout">
${keyField}
<button type="submit">Log out everywhere</button>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(
    `${title} - waha-mcp`,
    `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`,
  );
}
