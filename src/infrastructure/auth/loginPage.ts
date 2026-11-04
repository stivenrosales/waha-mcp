/** Minimal, self-contained HTML pages for login, logout and onboarding. No external assets. */

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
input[type=password],input[type=text]{width:100%;padding:.5rem;box-sizing:border-box;font-size:1rem}
button{margin-top:1rem;padding:.5rem 1rem;font-size:1rem}
.error{color:#b00020}
.muted{color:#666;font-size:.9rem}
`;

/** A full page. `head` is trusted markup added to `<head>` (e.g. a refresh `<meta>`). */
export const layout = (title: string, body: string, head = ""): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;

export const errorLine = (error?: string): string =>
  error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";

/** Username and current-password fields shared by every sign-in form. */
export const credentialFields = (username = ""): string =>
  `<label for="username">Username</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" value="${escapeHtml(username)}" required autofocus>
<label for="password">Password</label>
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
    "Sign in - waha-mcp",
    `<h1>Sign in to waha-mcp</h1>
<p class="muted">An application at <strong>${escapeHtml(opts.redirectHost)}</strong> is requesting access to read your WhatsApp chats and send messages from your number.</p>
${errorLine(opts.error)}
<form method="post" action="authorize">
${hidden}
${credentialFields(opts.username)}
<button type="submit">Authorize</button>
</form>`,
  );
}

export function logoutPage(opts: { username?: string; error?: string } = {}): string {
  return layout(
    "Log out - waha-mcp",
    `<h1>Log out</h1>
<p class="muted">This revokes the tokens and registered clients of your account. Your connected apps must sign in again; other accounts are not affected.</p>
${errorLine(opts.error)}
<form method="post" action="logout">
${credentialFields(opts.username)}
<button type="submit">Log out</button>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(
    `${title} - waha-mcp`,
    `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`,
  );
}
