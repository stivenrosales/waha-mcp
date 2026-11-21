const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Exactly one grapheme (skin tones, flags and ZWJ families count as one) that is an emoji. */
export function isSingleEmoji(s: string): boolean {
  const graphemes = [...segmenter.segment(s)];
  return graphemes.length === 1 && PICTOGRAPH.test(s);
}
