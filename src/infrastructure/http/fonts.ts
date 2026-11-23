import { readFileSync } from "node:fs";

/**
 * Zenbox's typefaces (SIL Open Font License, see assets/fonts/OFL-*.txt), served to the HTML
 * pages from this server so the CSP stays `font-src 'self'`. Resolved relative to this module so
 * it works from `src/` (tests, dev) and `dist/` (production): both sit three levels below the
 * project root, where `assets/` lives. Each file is read once, lazily; a missing file answers
 * 404 and the pages fall back to the system fonts.
 */
export const FONT_FILES: Readonly<Record<string, URL>> = {
  "/assets/dm-sans.woff2": new URL("../../../assets/fonts/DMSans-Variable.woff2", import.meta.url),
  "/assets/newsreader.woff2": new URL(
    "../../../assets/fonts/Newsreader-Variable.woff2",
    import.meta.url,
  ),
};

const cache = new Map<string, Uint8Array | null>();

/** The bytes of the font served at `path`; null when the file is missing. */
export function fontBytes(path: string): Uint8Array | null {
  if (!cache.has(path)) {
    const url = FONT_FILES[path];
    try {
      cache.set(path, url ? new Uint8Array(readFileSync(url)) : null);
    } catch {
      cache.set(path, null);
    }
  }
  return cache.get(path) ?? null;
}

export const FONT_HEADERS = {
  "content-type": "font/woff2",
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
};
