/**
 * NORMALISE BEFORE MATCHING — the fix that is invisible until it is not.
 *
 * A zero-width space defeats byte matching entirely. `sk-ant​-api03-…`
 * is the same credential to every human reader, to the clipboard, and to the
 * provider that will accept it — and to a regex it is two unrelated
 * fragments. So is a full-width `ｐａｓｓｗｏｒｄ`, and so is a Cyrillic `о` in
 * `pаssword` where only one letter was swapped.
 *
 * None of these is exotic. Full-width forms arrive from Japanese and Chinese
 * input methods by accident; Cyrillic homoglyphs arrive from copying out of
 * a document; zero-width joiners arrive from rich-text editors that use them
 * for line-breaking hints. Every one of them silently costs a detection.
 *
 * THE OFFSET MAP IS THE WHOLE DIFFICULTY. Normalising is easy; normalising
 * while still being able to say WHERE IN THE ORIGINAL a detected span lives
 * is what makes it usable, because the thing that gets masked is the user's
 * real text, not the normalised copy. Every emitted code unit records the
 * original index it came from, so a span on the normalised text maps back
 * exactly — and a span that spans a deleted zero-width character maps to a
 * WIDER original span, which is right: the invisible character is part of
 * the secret and has to go with it.
 *
 * THE FAST PATH IS THE COMMON PATH. Almost every string is plain ASCII with
 * nothing to normalise, and it returns in one scan with no allocation and an
 * identity map. The cost of this module on a normal payload is one
 * character-code comparison per character.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

export type NormalizedText = Readonly<{
  /** The normalised text. Identical to the original on the fast path. */
  text: string;
  /** Whether anything actually changed. */
  changed: boolean;
  /**
   * The index in the ORIGINAL that a normalised index came from. Total on
   * `[0, text.length]` — `toOriginal(text.length)` is the original length,
   * so a span's end maps as cleanly as its start.
   */
  toOriginal: (normalizedIndex: number) => number;
}>;

/**
 * Characters that are invisible and carry no meaning inside a value: the
 * zero-width space/non-joiner/joiner, the word joiner, the BOM used
 * mid-string, and the soft hyphen.
 *
 * The soft hyphen (U+00AD) is the one worth naming: it RENDERS as nothing
 * until a line breaks on it, so a credential carrying one looks completely
 * ordinary and matches nothing.
 */
export const NORMALIZATION_REMOVED_CODE_POINTS: readonly number[] = Object.freeze([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e,
]);
const ZERO_WIDTH = new Set(NORMALIZATION_REMOVED_CODE_POINTS);

/**
 * ASCII LOOKALIKES, one direction only.
 *
 * Deliberately small and deliberately one-way: this maps a confusable to the
 * ASCII character it imitates, so that a mixed-script value collapses onto
 * the form the detector already understands. It is NOT a transliteration
 * table and must never grow into one — folding `ñ` to `n` or `ü` to `u`
 * would rewrite ordinary words in ordinary languages, and this module runs
 * over the user's prose.
 *
 * The entries are the Cyrillic and Greek letters that are visually identical
 * to a Latin letter in almost every typeface, plus the fullwidth block,
 * which is handled arithmetically below rather than enumerated.
 */
const HOMOGLYPHS: ReadonlyMap<number, string> = new Map([
  // Cyrillic
  [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"],
  [0x0445, "x"], [0x0443, "y"], [0x0456, "i"], [0x0458, "j"], [0x0455, "s"],
  [0x04bb, "h"], [0x0410, "A"], [0x0412, "B"], [0x0415, "E"], [0x041a, "K"],
  [0x041c, "M"], [0x041d, "H"], [0x041e, "O"], [0x0420, "P"], [0x0421, "C"],
  [0x0422, "T"], [0x0425, "X"], [0x0405, "S"], [0x0406, "I"], [0x0408, "J"],
  // Greek
  [0x03b1, "a"], [0x03bf, "o"], [0x03c1, "p"], [0x03bd, "v"], [0x03c5, "u"],
  [0x0391, "A"], [0x0392, "B"], [0x0395, "E"], [0x0396, "Z"], [0x0397, "H"],
  [0x0399, "I"], [0x039a, "K"], [0x039c, "M"], [0x039d, "N"], [0x039f, "O"],
  [0x03a1, "P"], [0x03a4, "T"], [0x03a5, "Y"], [0x03a7, "X"],
  // Miscellaneous punctuation that stands in for ASCII inside a value
  [0x2010, "-"], [0x2011, "-"], [0x2012, "-"], [0x2013, "-"], [0x2014, "-"],
  [0x2018, "'"], [0x2019, "'"], [0x201c, '"'], [0x201d, '"'],
  [0x00a0, " "], [0x2007, " "], [0x202f, " "],
]);

/** The fullwidth ASCII block: U+FF01–U+FF5E map to U+0021–U+007E. */
const FULLWIDTH_FIRST = 0xff01;
const FULLWIDTH_LAST = 0xff5e;
const FULLWIDTH_OFFSET = 0xff01 - 0x21;

/** Whether the code point needs any of the transforms above. */
function needsNormalizing(code: number): boolean {
  if (code < 0x80) return false;
  if (ZERO_WIDTH.has(code)) return true;
  if (code >= FULLWIDTH_FIRST && code <= FULLWIDTH_LAST) return true;
  return HOMOGLYPHS.has(code);
}

const IDENTITY = (index: number): number => index;

/**
 * The normalised form of `original`, with a map back to it.
 *
 * ONE PASS TO DECIDE, ONE PASS TO BUILD. The first pass only asks whether
 * anything needs doing, and on the overwhelming majority of strings the
 * answer is no and nothing is allocated at all.
 */
export function normalizeForDetection(original: string): NormalizedText {
  let dirty = false;
  for (let i = 0; i < original.length; i += 1) {
    if (needsNormalizing(original.charCodeAt(i))) {
      dirty = true;
      break;
    }
  }
  if (!dirty) {
    return Object.freeze({ text: original, changed: false, toOriginal: IDENTITY });
  }

  const pieces: string[] = [];
  // `sources[k]` is the original index that produced normalised code unit k.
  const sources: number[] = [];
  let produced = 0;
  for (let i = 0; i < original.length; i += 1) {
    const code = original.charCodeAt(i);
    if (ZERO_WIDTH.has(code)) continue;
    let replacement: string;
    if (code >= FULLWIDTH_FIRST && code <= FULLWIDTH_LAST) {
      replacement = String.fromCharCode(code - FULLWIDTH_OFFSET);
    } else {
      replacement = HOMOGLYPHS.get(code) ?? original[i]!;
    }
    pieces.push(replacement);
    for (let k = 0; k < replacement.length; k += 1) sources.push(i);
    produced += replacement.length;
  }
  // The end sentinel: an index one past the last code unit maps to one past
  // the last original index, so `toOriginal(span.end)` is total.
  sources.push(original.length);
  const text = pieces.join("");
  return Object.freeze({
    text,
    changed: text !== original,
    toOriginal: (normalizedIndex: number): number => {
      if (normalizedIndex <= 0) return 0;
      if (normalizedIndex >= produced) return original.length;
      return sources[normalizedIndex]!;
    },
  });
}
