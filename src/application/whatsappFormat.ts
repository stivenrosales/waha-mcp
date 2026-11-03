/**
 * Rewrites the chat Markdown models tend to write into WhatsApp's own syntax
 * (`*bold*`, `_italic_`, `~strike~`, ``` ```mono``` ```, `` `code` ``, `> quote`, lists).
 * Code fences and inline code are never touched. Idempotent: valid WhatsApp text
 * comes back unchanged.
 */

const FENCE = /(```[\s\S]*?```)/;
const INLINE_CODE = /(`[^`\n]+`)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(\S.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

const URL_TOKEN = /(https?:\/\/\S+)/;

/**
 * `**x**` → `*x*` and `~~x~~` → `~x~`, only when the markers sit at word boundaries, so
 * `a**2`, `report**v2` and URLs are left alone. `__x__` is deliberately not converted: it
 * cannot be told apart from identifiers such as `__init__`.
 */
function emphasis(text: string): string {
  return text
    .split(URL_TOKEN)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/(?<![\p{L}\p{N}_*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\p{L}\p{N}_*])/gu, "*$1*")
            .replace(/(?<![\p{L}\p{N}_~])~~(?=\S)(.+?)(?<=\S)~~(?![\p{L}\p{N}_~])/gu, "~$1~"),
    )
    .join("");
}

function inline(text: string): string {
  return text
    .split(INLINE_CODE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : emphasis(
            part.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_m, label: string, url: string) =>
              label.trim() === url ? url : `${label.trim()}: ${url}`,
            ),
          ),
    )
    .join("");
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => inline(c.trim()));

function bold(text: string): string {
  const inner = text.replace(/^\*(.+)\*$/, "$1");
  return `*${inner}*`;
}

function prose(segment: string): string {
  const lines = segment.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i] as string))
        rows.push(lines[i++] as string);
      i--;
      const hasHeader = rows.length > 1 && TABLE_SEPARATOR.test(rows[1] as string);
      rows.forEach((row, r) => {
        if (TABLE_SEPARATOR.test(row)) return;
        const joined = cells(row).join(" · ");
        out.push(hasHeader && r === 0 ? bold(joined) : joined);
      });
      continue;
    }
    if (RULE.test(line)) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      out.push(bold(inline(heading[1] as string)));
      continue;
    }
    out.push(inline(line));
  }
  return (
    out
      .join("\n")
      // Only before a line break: a segment can end right before an inline ``` fence.
      .replace(/[ \t]+(?=\n)/g, "")
      .replace(/\n{3,}/g, "\n\n")
  );
}

export function toWhatsAppText(text: string): string {
  return text
    .split(FENCE)
    .map((part, i) => (i % 2 === 1 ? part : prose(part)))
    .join("")
    .trimEnd();
}
