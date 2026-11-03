import { escapeHtml, HTML_SECURITY_HEADERS } from "../auth/loginPage.js";

/** Same hardening as the login pages, plus: the form may only post back to this server. */
export const UPLOAD_PAGE_HEADERS: Record<string, string> = {
  ...HTML_SECURITY_HEADERS,
  "Content-Security-Policy": `${HTML_SECURITY_HEADERS["Content-Security-Policy"]}; form-action 'self'`,
  "Content-Type": "text/html; charset=utf-8",
};

const STYLE = `
body{font-family:system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.3rem}
input[type=file]{display:block;margin:1rem 0;font-size:1rem}
button{padding:.5rem 1rem;font-size:1rem}
.muted{color:#666;font-size:.9rem}
`;

const layout = (title: string, body: string): string => `<!doctype html>
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

export function pickerPage(filename: string): string {
  return layout(
    "Upload a file",
    `<h1>Upload a file to send on WhatsApp</h1>
<p class="muted">Expected file: <strong>${escapeHtml(filename)}</strong>. This link works once.</p>
<form method="post" enctype="multipart/form-data">
<input type="file" name="file" required>
<button type="submit">Upload</button>
</form>`,
  );
}

export function uploadedPage(): string {
  return layout(
    "Uploaded",
    `<h1>Uploaded</h1>
<p>The file is on the server. Go back to the chat and ask to send it.</p>`,
  );
}

export function alreadyUploadedPage(): string {
  return layout(
    "Already uploaded",
    `<h1>Already uploaded</h1>
<p>This link was already used. Ask for a new upload link to send another file.</p>`,
  );
}
