/**
 * Fixture scrubber. Dev-only: turns raw WAHA/GOWS payloads into shareable
 * fixtures. It FAILS CLOSED: every string value is redacted unless its key is
 * on an explicit allowlist of structural keys, and the output is verified
 * before it is returned, so an unknown field can never leak through.
 *
 * Preserved: shape, keys, booleans, numbers (except coordinates), and the
 * links between records (ids, replies, mentions) through stable fake JIDs.
 */

// user part, optional device suffix, optional JID server.
const IDENTIFIER = /(\d{7,})(:\d+)?(@(?:c\.us|s\.whatsapp\.net|g\.us|lid))?/g;
const JID_ANYWHERE = /([\d:-]*)@(?:c\.us|lid|s\.whatsapp\.net|g\.us)/g;
const DIGIT_RUN = /\d{7,}/g;
const BASE64_BLOB = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;
const DATA_URI = /^data:[^;,]+;base64,/;

/** Lowercased keys whose string values are structural (ids, enums), not content. */
const STRUCTURAL_KEYS = new Set([
  "id",
  "_serialized",
  "serialized",
  "type",
  "mimetype",
  "status",
  "engine",
  "ack",
  "ackname",
  "from",
  "to",
  "author",
  "participant",
  "chatid",
  "chat",
  "remotejid",
  "remote",
  "jid",
  "lid",
  "pn",
  "user",
  "server",
  "sender",
  "senderalt",
  "chatalt",
  "participantalt",
  "owner",
  "creator",
  "mentionedjid",
  "mentionedids",
  "quotedparticipant",
  "stanzaid",
  "messageid",
  "addressingmode",
  "category",
  "mediatype",
  "role",
  "event",
  "source",
  "kind",
]);

const URL_KEYS = new Set(["url", "mediaurl", "directpath"]);
const COORDINATE_KEYS = new Set([
  "degreeslatitude",
  "degreeslongitude",
  "latitude",
  "longitude",
  "lat",
  "lng",
  "lon",
]);

export interface Scrubber {
  scrub(value: unknown): unknown;
}

/** One scrubber = one run: the same input always maps to the same fake. */
export function createScrubber(): Scrubber {
  const phones = new Map<string, string>();
  const fakes = new Set<string>();
  const texts = new Map<string, string>();

  const fakeDigits = (digits: string): string => {
    let fake = phones.get(digits);
    if (fake === undefined) {
      const counter = String(phones.size + 1);
      // Same length as the original so shapes stay realistic.
      fake = `1${counter.padStart(Math.max(digits.length - 1, counter.length), "0")}`;
      phones.set(digits, fake);
      fakes.add(fake);
    }
    return fake;
  };

  const scrubIdentifiers = (s: string): string =>
    s.replace(IDENTIFIER, (_m, digits: string, device?: string, server?: string) => {
      return `${fakeDigits(digits)}${device ?? ""}${server ?? ""}`;
    });

  const redact = (s: string): string => {
    let fake = texts.get(s);
    if (fake === undefined) {
      fake = `<redacted-${texts.size + 1}>`;
      texts.set(s, fake);
    }
    return fake;
  };

  function scrubString(s: string, key: string | undefined): string {
    const k = key?.toLowerCase();
    if (DATA_URI.test(s) || BASE64_BLOB.test(s)) return "<base64>";
    if (k !== undefined && URL_KEYS.has(k)) return "<url>";
    if (k !== undefined && STRUCTURAL_KEYS.has(k)) return scrubIdentifiers(s);
    return redact(s);
  }

  function walk(value: unknown, key: string | undefined): unknown {
    if (typeof value === "string") return scrubString(value, key);
    if (typeof value === "number") {
      return key !== undefined && COORDINATE_KEYS.has(key.toLowerCase())
        ? Math.round(value)
        : value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[scrubIdentifiers(k)] = walk(v, k);
      return out;
    }
    return value;
  }

  const isFakeId = (part: string): boolean => fakes.has(part) || /^\d{1,6}$/.test(part);

  /** Throws (without echoing the value) if a real-looking identifier survived. */
  function assertClean(value: unknown): void {
    const check = (s: string): void => {
      for (const m of s.matchAll(DIGIT_RUN)) {
        if (!fakes.has(m[0])) throw new Error("Scrubbed output still contains a digit run.");
      }
      for (const m of s.matchAll(JID_ANYWHERE)) {
        const parts = (m[1] ?? "").split(/[-:]/);
        if (!parts.every(isFakeId)) throw new Error("Scrubbed output still contains a JID.");
      }
    };
    const visit = (node: unknown): void => {
      if (typeof node === "string") check(node);
      else if (Array.isArray(node)) for (const item of node) visit(item);
      else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          check(k);
          visit(v);
        }
      }
    };
    visit(value);
  }

  return {
    scrub(value) {
      const out = walk(value, undefined);
      assertClean(out);
      return out;
    },
  };
}

const shared = createScrubber();

/** Scrubs with a process-wide scrubber so links survive across files of one run. */
export function scrubFixture(value: unknown): unknown {
  return shared.scrub(value);
}
