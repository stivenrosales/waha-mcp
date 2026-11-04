import { readFileSync } from "node:fs";

/**
 * Satoshi (ITF Free Font License), the UI font of the HTML pages. Resolved relative to this
 * module so it works from `src/` (tests, dev) and `dist/` (production): both sit three levels
 * below the project root, where `assets/` lives. Read once, lazily; null when the file is missing,
 * in which case the pages fall back to the system font.
 */
const FONT_URL = new URL("../../../assets/fonts/Satoshi-Variable.woff2", import.meta.url);

let cached: Uint8Array | null | undefined;

export function pageFont(): Uint8Array | null {
  if (cached === undefined) {
    try {
      cached = new Uint8Array(readFileSync(FONT_URL));
    } catch {
      cached = null;
    }
  }
  return cached;
}

export const FONT_HEADERS = {
  "content-type": "font/woff2",
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
};
