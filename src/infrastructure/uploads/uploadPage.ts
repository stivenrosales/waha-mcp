import { escapeHtml, HTML_SECURITY_HEADERS, layout } from "../auth/loginPage.js";

/** Same hardening as the login pages, plus: the form may only post back to this server. */
export const UPLOAD_PAGE_HEADERS: Record<string, string> = {
  ...HTML_SECURITY_HEADERS,
  "Content-Security-Policy": `${HTML_SECURITY_HEADERS["Content-Security-Policy"]}; form-action 'self'`,
  "Content-Type": "text/html; charset=utf-8",
};

export function pickerPage(filename: string): string {
  return layout(
    "Subir un archivo",
    `<h1>Sube un archivo para enviarlo por WhatsApp</h1>
<p class="lead">Archivo esperado: <strong>${escapeHtml(filename)}</strong>. Este enlace funciona una sola vez.</p>
<form method="post" enctype="multipart/form-data">
<input type="file" name="file" required>
<button type="submit">Subir archivo</button>
</form>`,
  );
}

export function uploadedPage(): string {
  return layout(
    "Archivo subido",
    `<h1>Archivo subido</h1>
<p class="lead">El archivo ya está en el servidor. Vuelve al chat y pide que se envíe.</p>`,
  );
}

export function alreadyUploadedPage(): string {
  return layout(
    "Enlace ya usado",
    `<h1>Este enlace ya se usó</h1>
<p class="lead">Pide un nuevo enlace de subida para enviar otro archivo.</p>`,
  );
}
