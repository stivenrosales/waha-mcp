/**
 * Fixture scrubber. Dev-only: turns raw WAHA/GOWS payloads into shareable
 * fixtures by replacing personal data while preserving shape, types, numbers,
 * booleans, timestamps and the links between records (ids, replies, mentions).
 */

const PHONE_OR_JID = /\d{8,15}(@(c\.us|s\.whatsapp\.net|g\.us|lid))?/g;
const BASE64_BLOB = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;
const DATA_URI = /^data:[^;,]+;base64,/;

const REDACTED_KEYS = new Set([
  "pushName",
  "name",
  "subject",
  "notifyName",
  "Name",
  "Topic",
  "description",
  "body",
  "caption",
  "text",
  "conversation",
  "filename",
]);
const URL_KEYS = new Set(["url", "mediaUrl", "directPath"]);

export interface Scrubber {
  scrub(value: unknown): unknown;
}

/** One scrubber = one run: the same input always maps to the same fake. */
export function createScrubber(): Scrubber {
  const phones = new Map<string, string>();
  const texts = new Map<string, string>();

  const fakeDigits = (digits: string): string => {
    let fake = phones.get(digits);
    if (fake === undefined) {
      // Same length as the original; the counter keeps fakes distinct.
      const counter = String(phones.size + 1);
      fake = `1${counter.padStart(Math.max(digits.length - 1, counter.length), "0")}`.slice(
        0,
        Math.max(digits.length, counter.length + 1),
      );
      phones.set(digits, fake);
    }
    return fake;
  };

  const scrubIdentifiers = (s: string): string =>
    s.replace(PHONE_OR_JID, (match) => {
      const at = match.indexOf("@");
      const digits = at === -1 ? match : match.slice(0, at);
      const suffix = at === -1 ? "" : match.slice(at);
      return `${fakeDigits(digits)}${suffix}`;
    });

  const redact = (s: string): string => {
    let fake = texts.get(s);
    if (fake === undefined) {
      fake = `<redacted-${texts.size + 1}>`;
      texts.set(s, fake);
    }
    return fake;
  };

  const scrubString = (s: string): string => {
    if (DATA_URI.test(s) || BASE64_BLOB.test(s)) return "<base64>";
    return scrubIdentifiers(s);
  };

  function walk(value: unknown, key: string | undefined): unknown {
    if (typeof value === "string") {
      if (key !== undefined && URL_KEYS.has(key)) return "<url>";
      if (key !== undefined && REDACTED_KEYS.has(key)) return redact(value);
      return scrubString(value);
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[scrubIdentifiers(k)] = walk(v, k);
      return out;
    }
    return value;
  }

  return { scrub: (value) => walk(value, undefined) };
}

const shared = createScrubber();

/** Scrubs with a process-wide scrubber so links survive across files of one run. */
export function scrubFixture(value: unknown): unknown {
  return shared.scrub(value);
}
