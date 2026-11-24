/** Zenbox's transactional email layout: calm, cream and sage, readable with images off. */

export interface BrandedEmailParts {
  /** Hidden preview line shown next to the subject in the inbox. */
  preheader: string;
  title: string;
  paragraphs: string[];
  button: { label: string; url: string };
  /** Small print under the button (validity, single use). */
  note: string;
  footer: string;
}

const LOGO_URL = "https://usezenbox.com/email-logo.png";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Table-based HTML (what email clients render reliably) plus a plain-text copy. */
export function brandedEmail(p: BrandedEmailParts): { text: string; html: string } {
  const text = [
    p.title,
    ...p.paragraphs,
    `${p.button.label}: ${p.button.url}`,
    p.note,
    p.footer,
  ].join("\n\n");

  const url = esc(p.button.url);
  const paragraphs = p.paragraphs
    .map((t) => `<p style="margin:0 0 14px;font:15px/1.6 ${SANS};color:#5d6366">${esc(t)}</p>`)
    .join("");

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(p.title)}</title></head>
<body style="margin:0;padding:0;background:#f6f3ec">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(p.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ec"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td style="padding:0 8px 24px"><img src="${LOGO_URL}" width="140" height="53" alt="Zenbox" style="display:block;border:0;font:600 22px ${SANS};color:#5e8b7e"></td></tr>
<tr><td style="background:#fbfaf6;border:1px solid #ece7dc;border-radius:20px;padding:36px 32px">
<h1 style="margin:0 0 18px;font:400 28px/1.25 ${SERIF};color:#2f3437">${esc(p.title)}</h1>
${paragraphs}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 18px"><tr><td style="border-radius:999px;background:#5e8b7e">
<a href="${url}" style="display:inline-block;padding:13px 28px;font:600 15px ${SANS};color:#fbfaf6;text-decoration:none;border-radius:999px">${esc(p.button.label)}</a>
</td></tr></table>
<p style="margin:0 0 22px;font:13px/1.6 ${SANS};color:#5d6366">${esc(p.note)}</p>
<p style="margin:0;padding-top:18px;border-top:1px solid #ece7dc;font:12.5px/1.6 ${SANS};color:#8a8f91">Si el botón no funciona, copia este enlace en tu navegador:<br><a href="${url}" style="color:#47695f;word-break:break-all">${url}</a></p>
</td></tr>
<tr><td style="padding:22px 8px 0;font:12.5px/1.6 ${SANS};color:#8a8f91">${esc(p.footer)}<br>Zenbox · Tu WhatsApp, en calma.</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { text, html };
}
