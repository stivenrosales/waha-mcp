/**
 * "Reply in the owner's style": a short English description of how the owner writes in one chat,
 * derived from the owner's own recent messages there, fed into the prompts of AI-composed
 * messages (scheduled AI messages and missions). A heuristic, no LLM call: length, emojis, tone,
 * laughter, capitalization, final punctuation and language.
 */

/** Fewer owner messages than this say too little to imitate. */
export const STYLE_MIN_MESSAGES = 3;
/** Only the owner's latest messages count (the input is oldest first). */
export const STYLE_MAX_MESSAGES = 50;

const EMOJI = /\p{Extended_Pictographic}/gu;
const HAS_EMOJI = /\p{Extended_Pictographic}/u;
const LETTER = /\p{L}/u;
const WORD = /[\p{L}\p{N}]/u;

/** Words that mark one language and not the others (lowercase, whole words). */
const LANGUAGES: { name: string; words: Set<string> }[] = [
  {
    name: "Spanish",
    words: new Set(
      "el los las y pero con una está estoy tengo gracias hola nos te lo muy bien sí también mañana hoy ya eso esto vamos dale qué cómo usted ustedes aviso".split(
        " ",
      ),
    ),
  },
  {
    name: "English",
    words: new Set(
      "the and you is it of for that this with on are be have not i we my your please thank thanks when what hi hello".split(
        " ",
      ),
    ),
  },
  {
    name: "Portuguese",
    words: new Set(
      "você não tudo bem com gente vou obrigado obrigada tá também amanhã hoje olá oi muito isso".split(
        " ",
      ),
    ),
  },
];

const FORMAL = [
  /\busted(es)?\b/u,
  /\bestimad[oa]s?\b/u,
  /\bcordialmente\b/u,
  /\batentamente\b/u,
  /\bbuen[oa]s (días|tardes|noches)\b/u,
  /\bdear\b/u,
  /\bregards\b/u,
  /\bsincerely\b/u,
  /\bgood (morning|afternoon|evening)\b/u,
  /\bprezad[oa]\b/u,
  /\batenciosamente\b/u,
];
const INFORMAL = [
  /\b(ja){2,}j?\b/u,
  /\b(je){2,}j?\b/u,
  /\b(ha){2,}h?\b/u,
  /\b(k){3,}\b/u,
  /\blol\b/u,
  /\bxd\b/u,
  /\bbro\b/u,
  /\bdale\b/u,
  /\boye\b/u,
  /\bwey\b/u,
  /\bxq\b/u,
  /\bq\b/u,
  /\btmb\b/u,
  /\bvaleu\b/u,
];
const LAUGH = /\b((?:ja){2,}|(?:je){2,}|(?:ha){2,}|k{3,})\b/u;

const ratio = (n: number, of: number): number => (of === 0 ? 0 : n / of);

function lengthOf(words: number): string {
  const about = `(about ${words} words)`;
  if (words <= 5) return `very short messages ${about}`;
  if (words <= 12) return `short messages ${about}`;
  if (words <= 25) return `medium-length messages ${about}`;
  return `long messages ${about}`;
}

/** Most used first; ties keep first-seen order. */
function topEmojis(texts: string[], max: number): string[] {
  const counts = new Map<string, number>();
  for (const t of texts)
    for (const e of t.match(EMOJI) ?? []) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([e]) => e);
}

function language(texts: string[]): string | null {
  const hits = LANGUAGES.map(({ name, words }) => {
    let n = 0;
    for (const t of texts)
      for (const w of t.toLowerCase().split(/[^\p{L}]+/u)) if (words.has(w)) n += 1;
    return { name, n };
  }).sort((a, b) => b.n - a.n);
  const [first, second] = hits;
  if (!first || first.n < 2 || (second && second.n >= first.n)) return null;
  return first.name;
}

/**
 * The owner's style in one chat from the owner's own message texts (oldest first), or null with
 * fewer than `STYLE_MIN_MESSAGES` non-empty ones. Contacts' messages must not be passed in.
 */
export function ownerStyleHint(ownerTexts: string[]): string | null {
  const texts = ownerTexts
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .slice(-STYLE_MAX_MESSAGES);
  if (texts.length < STYLE_MIN_MESSAGES) return null;
  const lower = texts.map((t) => t.toLowerCase());
  const traits: string[] = [];

  const words = texts.map((t) => t.split(/\s+/).filter((w) => WORD.test(w)).length);
  traits.push(lengthOf(Math.round(words.reduce((a, b) => a + b, 0) / texts.length)));

  const withEmoji = ratio(texts.filter((t) => HAS_EMOJI.test(t)).length, texts.length);
  const top = topEmojis(texts, 3).join(" ");
  if (withEmoji === 0) traits.push("uses no emojis");
  else if (withEmoji < 0.25) traits.push(`uses emojis rarely (${top})`);
  else traits.push(`uses emojis often (${top})`);

  const formal = lower.filter((t) => FORMAL.some((r) => r.test(t))).length;
  const informal = lower.filter((t) => INFORMAL.some((r) => r.test(t))).length;
  if (informal > formal) traits.push("informal, casual tone");
  else if (formal > informal) traits.push("formal tone");

  const laugh = lower.map((t) => LAUGH.exec(t)?.[1]).find((l) => l !== undefined);
  if (laugh) traits.push(`laughs with "${laugh}"`);

  const firstLetters = texts
    .map((t) => [...t].find((c) => LETTER.test(c)))
    .filter((c): c is string => c !== undefined);
  const lowerStart = ratio(
    firstLetters.filter((c) => c === c.toLowerCase() && c !== c.toUpperCase()).length,
    firstLetters.length,
  );
  if (lowerStart >= 0.6) traits.push("usually starts in lowercase");
  else if (lowerStart <= 0.2) traits.push("starts with a capital letter");

  const withPeriod = ratio(
    texts.filter((t) => t.replace(EMOJI, "").trimEnd().endsWith(".")).length,
    texts.length,
  );
  if (withPeriod < 0.3) traits.push("rarely ends with a period");
  else if (withPeriod >= 0.7) traits.push("ends sentences with a period");

  const lang = language(texts);
  if (lang) traits.push(`writes in ${lang}`);

  return `Owner's writing style in this chat, from their last ${texts.length} messages (imitate it in every message you write; never mention it): ${traits.join("; ")}.`;
}
