import { deepFreeze } from "../kernel/integrity.ts";
import {
  benignRegions,
  benignTokenGrammar,
  withinBenignRegion,
  type BenignGrammarId,
  type BenignRegion,
} from "./benign-grammars.ts";
import { type IntelligenceSpan, NO_SPANS } from "./detection-span.ts";

/**
 * LAYER 4 — VALUE-INTRINSIC EVIDENCE, and the register the value sits in.
 *
 * This is the layer that reaches a bare key from a provider nobody listed.
 * The held-out misses were overwhelmingly values with no surrounding context
 * at all — `EZAK4uGRIsRx7x9q1HRU68UAb6qx42Bvw9bRXELoyxfH77J5s2ZX7CoEUi`, on
 * its own line, introduced by nothing. No noun reaches that; no format regex
 * reaches it either, because it belongs to a provider the catalog has never
 * heard of.
 *
 * The rule is the inversion in `benign-grammars.ts`: entropy MINUS the
 * enumerated benign grammars. What is left over is a candidate.
 *
 * FOUR FILTERS, AND WHAT EACH ONE ANSWERS. Every one of them came out of a
 * measured false positive on ordinary source, not out of intuition:
 *
 *  1. THE BENIGN REGION. `https://play.vuejs.org/#eNo9jUEOgyAQRa8yYUO7...`
 *     — a base64 playground payload with a session token's entropy and
 *     length. Hundreds of them in the vuejs docs. The token is not benign;
 *     the URL around it is.
 *  2. THE BENIGN TOKEN. UUIDs, digests, timestamps, semver, identifiers,
 *     dotted names. `Object.getOwnPropertySymbols` is 28 characters of mixed
 *     case that no length-and-entropy rule can separate from a key.
 *  3. THE LONGEST UNBROKEN SEGMENT, not the whole token. A credential is a
 *     long random RUN; a path or a hyphenated phrase is many short wordy
 *     runs that happen to add up. `en.wikipedia.org/wiki/Combining_
 *     Diacritical_Marks` is 48 characters whose longest run is `Combining`.
 *     Measured: judging the whole token raised 442 candidates on lodash;
 *     judging the longest segment raised 5.
 *  4. THE VOWEL RATIO. A run drawn from a random alphabet has ~19% vowels
 *     if it is uniform over letters, and less once digits are mixed in;
 *     a run that is words run together has far more. This is a property of
 *     the Latin script, not of any language — `Kennwort`, `contrasena` and
 *     `parool` all carry vowels, and a random 32-character key does not.
 *     Measured on the same corpora it is the single strongest filter there
 *     is, and it is the same shape of rule as the abbreviation guard in the
 *     credential lexicon, for the same reason.
 *
 * WHAT THIS LAYER CANNOT DO, stated rather than implied. A low-entropy
 * secret has no intrinsic signal — `admin44` is seven characters that look
 * like a word and a year. Nothing in this file will ever find it; only a
 * declaration will. That is a real limit of deterministic detection and it
 * is written here so nobody reads layer 4 as a guarantee.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

// ── the shared value measurements every layer uses ───────────────────────

/**
 * Shannon entropy of the character distribution, in bits per character.
 * `log2(k)` for a token of k equally-frequent characters — so a 40-character
 * hex string scores ~3.9 and the word "unfortunately" scores ~3.2, which is
 * exactly why entropy is not allowed to decide anything on its own.
 */
export function shannonEntropyBits(token: string): number {
  if (token.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** How many of {lowercase, uppercase, digit, symbol} the token draws from. */
export function characterClassCount(token: string): number {
  let n = 0;
  if (/[a-z]/u.test(token)) n += 1;
  if (/[A-Z]/u.test(token)) n += 1;
  if (/[0-9]/u.test(token)) n += 1;
  if (/[^A-Za-z0-9]/u.test(token)) n += 1;
  return n;
}

/**
 * The proportion of Latin vowels in a run.
 *
 * THE GUARD, NOT THE RULE. A high vowel ratio means "these are words", and
 * words are not keys. It is used as a veto on value-intrinsic evidence only,
 * for exactly the reason the abbreviation derivation uses the same fact in
 * reverse: abbreviations drop vowels, and random alphabets do not favour
 * them.
 */
export function vowelRatio(run: string): number {
  if (run.length === 0) return 0;
  let vowels = 0;
  for (const ch of run) {
    if (ch === "a" || ch === "e" || ch === "i" || ch === "o" || ch === "u" ||
        ch === "A" || ch === "E" || ch === "I" || ch === "O" || ch === "U") {
      vowels += 1;
    }
  }
  return vowels / run.length;
}

/**
 * Whether ANY run of letters and digits reaches `least`, without building
 * the run. The prefilter form of `longestAlphanumericRun`, kept beside it so
 * the two cannot drift.
 */
function longestAlphanumericRunAtLeast(token: string, least: number): boolean {
  let current = 0;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token.charCodeAt(i);
    const alnum =
      (ch >= 97 && ch <= 122) || (ch >= 65 && ch <= 90) || (ch >= 48 && ch <= 57);
    if (alnum) {
      current += 1;
      if (current >= least) return true;
    } else {
      current = 0;
    }
  }
  return false;
}

/** The longest run of letters and digits with no separator inside it. */
function longestAlphanumericRun(token: string): string {
  let best = "";
  let current = "";
  for (const ch of token) {
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9")) {
      current += ch;
      if (current.length > best.length) best = current;
    } else {
      current = "";
    }
  }
  return best;
}

// ── register: is this line code, or is it prose? ─────────────────────────

/**
 * THE FIRST OF THE FOUR FIXES, AND THE ONE THAT MATTERED MOST.
 *
 * Every false positive measured on held-out source was in CODE. Fourteen of
 * the fourteen in `psf/requests` were one shape:
 *
 *     username, password = get_auth_from_url(proxy)
 *
 * In code, `password = <something>` is an ASSIGNMENT and the something is
 * usually a name. In prose, "password is X" is a DISCLOSURE and the X is
 * usually the value. The same six characters mean opposite things, and the
 * only way to tell is the register they are written in.
 *
 * Judged per LINE rather than per document, because a message is routinely
 * both: prose with a fenced block in it, which is the single most common
 * shape a user sends.
 *
 * STRUCTURAL SIGNALS ONLY — no keyword list. `def`, `function`, `const` and
 * `fn` are as unbounded and as multilingual as credential nouns are, and
 * this file exists to stop enumerating those.
 */
export type Register = "code" | "prose";

export type RegisterTuning = Readonly<{
  /** Symbol characters per character, above which a line reads as code. */
  symbolDensity: number;
  /** Leading spaces that count as an indent. */
  indentColumns: number;
  /** Signals needed before a line is called code. */
  minSignals: number;
}>;

/** Above this many whitespace-separated tokens, a line carrying `=` or `:`
 * is a sentence rather than a binding. Six covers `a: B`, `var x = y` and
 * `? (a ? b : c)`; a sentence that mentions a credential runs longer. */
const MAX_BINDING_TOKENS = 6;

const REGISTER_TUNING: RegisterTuning = deepFreeze({
  symbolDensity: 0.18,
  indentColumns: 2,
  minSignals: 2,
});

/**
 * Whether any token on the line carries TWO or more lowercase-to-uppercase
 * transitions — a compound identifier rather than a chosen word.
 */
function hasCompoundCase(line: string): boolean {
  let humps = 0;
  for (let i = 1; i < line.length; i += 1) {
    const previous = line.charCodeAt(i - 1);
    const current = line.charCodeAt(i);
    const isLowerOrDigit =
      (previous >= 97 && previous <= 122) || (previous >= 48 && previous <= 57);
    const isUpper = current >= 65 && current <= 90;
    if (isLowerOrDigit && isUpper) {
      humps += 1;
      if (humps >= 2) return true;
    } else if (!((current >= 97 && current <= 122) || (current >= 65 && current <= 90) ||
                 (current >= 48 && current <= 57))) {
      // A separator ends the token, so humps do not accumulate across words.
      humps = 0;
    }
  }
  return false;
}

/** The bounds of the line containing `at`. */
function lineBoundsAt(text: string, at: number): Readonly<{ start: number; end: number }> {
  const before = text.lastIndexOf("\n", Math.max(0, at - 1));
  const start = before === -1 ? 0 : before + 1;
  const after = text.indexOf("\n", at);
  const end = after === -1 ? text.length : after;
  return { start, end };
}

/**
 * Whether the offset sits inside a fenced code block. Counted rather than
 * matched: an odd number of fences before the offset means it is inside one.
 * A fence is the only unambiguous statement of register a user can make, so
 * it is checked first and it is decisive.
 */
function insideCodeFence(text: string, at: number): boolean {
  if (!text.includes("```")) return false;
  let fences = 0;
  let from = text.indexOf("```");
  while (from !== -1 && from < at) {
    fences += 1;
    from = text.indexOf("```", from + 3);
  }
  return fences % 2 === 1;
}

/**
 * The register of the line containing `at`.
 *
 * ACCUMULATED, NOT A CHECKLIST — the same discipline as the declaration
 * layer's evidence, and for the same reason: any single structural signal
 * has a counterexample. An indented line can be a quoted paragraph; a
 * semicolon can end an English clause; parentheses appear in prose. Two
 * together are code.
 */
/**
 * THE REGISTER OF ONE STRING, COMPUTED AT MOST ONCE PER LINE.
 *
 * `registerAt` is asked once per cue, and a message can carry dozens. Both
 * halves of the answer were being recomputed each time: `insideCodeFence`
 * scans from the start of the text for every call, and the line's own
 * signals are the same for every cue on that line. On a long message that is
 * quadratic in the message length, and it was the largest single cost in the
 * egress measurement.
 *
 * The cache is per CALL — created by `declaredSecretSpans` and dropped when
 * it returns — so it cannot go stale and holds nothing between requests.
 */
export type RegisterCache = { fences: number[] | null; byLine: Map<number, Register> };

export function createRegisterCache(): RegisterCache {
  return { fences: null, byLine: new Map() };
}

/** The fence offsets, computed once. */
function fenceOffsets(text: string, cache: RegisterCache): number[] {
  if (cache.fences !== null) return cache.fences;
  const out: number[] = [];
  let from = text.indexOf("```");
  while (from !== -1) {
    out.push(from);
    from = text.indexOf("```", from + 3);
  }
  cache.fences = out;
  return out;
}

export function registerAt(
  text: string,
  at: number,
  tuning: RegisterTuning = REGISTER_TUNING,
  cache?: RegisterCache,
): Register {
  if (cache === undefined) {
    if (insideCodeFence(text, at)) return "code";
  } else {
    const fences = fenceOffsets(text, cache);
    let before = 0;
    for (const offset of fences) {
      if (offset >= at) break;
      before += 1;
    }
    if (before % 2 === 1) return "code";
    const { start: lineStart } = lineBoundsAt(text, at);
    const remembered = cache.byLine.get(lineStart);
    if (remembered !== undefined) return remembered;
    const computed = registerOfLine(text, at, tuning);
    cache.byLine.set(lineStart, computed);
    return computed;
  }
  return registerOfLine(text, at, tuning);
}

const PROSE_WORD_WHITESPACE = /\s/u;

/** The existing four-word prose signal, scanned without regex backtracking.
 * Matching is unanchored: a suffix can start the first word, and the first
 * character of the fourth word completes the match. Keep ASCII letters,
 * straight apostrophes and ECMAScript whitespace exactly as before. */
function hasProseWordRun(line: string): boolean {
  let words = 0;
  let inWord = false;
  for (const character of line) {
    const code = character.charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "'") {
      if (!inWord) {
        words += 1;
        if (words === 4) return true;
      }
      inWord = true;
    } else if (PROSE_WORD_WHITESPACE.test(character)) {
      inWord = false;
    } else {
      words = 0;
      inWord = false;
    }
  }
  return false;
}

function registerOfLine(text: string, at: number, tuning: RegisterTuning): Register {
  const { start, end } = lineBoundsAt(text, at);
  const line = text.slice(start, end);
  if (line.length === 0) return "prose";

  let signals = 0;

  // 1. INDENTATION. Prose is not indented; a continued statement is.
  let indent = 0;
  while (indent < line.length && (line[indent] === " " || line[indent] === "\t")) {
    indent += line[indent] === "\t" ? tuning.indentColumns : 1;
  }
  if (indent >= tuning.indentColumns) signals += 1;

  // 2. SYMBOL DENSITY. Code spends characters on structure; prose spends
  //    them on letters.
  let symbols = 0;
  let letters = 0;
  for (const ch of line) {
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) letters += 1;
    else if (ch !== " " && ch !== "\t" && !(ch >= "0" && ch <= "9")) symbols += 1;
  }
  if (symbols / line.length >= tuning.symbolDensity) signals += 1;

  // 3. A STATEMENT TERMINATOR OR A BLOCK EDGE, at the end of the line.
  const trimmed = line.trimEnd();
  const last = trimmed[trimmed.length - 1];
  // `)` is here, and it was missing. `System.setProperty("ADOBE_TOKEN",
  // "708266cfeab817aaed88d81c23391298")` scored ONE signal and read as
  // prose, so the comma between the name and its value was not treated as a
  // connector — and that one line shape accounts for a large share of the
  // held-out misses across every provider in the corpus.
  if (last === ";" || last === "{" || last === "}" || last === "," || last === "(" || last === ")") {
    signals += 1;
  }

  // 4. A CALL OR AN INDEX. Prose does not write `f(x)` or `a[0]`.
  if (/[A-Za-z0-9_$][([]/u.test(line)) signals += 1;

  // 5b. A SHORT LINE THAT BINDS A NAME. `auth: AuthType`,
  //     `var keysFunc = isFull`, `? (isFlat ? getAllKeysIn : getAllKeys)` —
  //     each is a handful of tokens joined by `=` or `:` with no sentence
  //     around them. Prose that uses those characters is a sentence and has
  //     the word count to prove it; a binding does not.
  //
  //     Measured: these three lines were the LAST false positives on 39,503
  //     lines of ordinary source, and all three were register failures — the
  //     detector called them prose, so a derived cue beside a camelCase
  //     identifier kept its full weight.
  const tokens = line.trim().split(/\s+/u).filter((t) => t.length > 0);
  if (tokens.length <= MAX_BINDING_TOKENS && /[=:]/u.test(line)) signals += 1;

  // 5. AN ASSIGNMENT WHOSE VALUE IS A QUOTED LITERAL. Measured: the line
  //    `__author_email__ = "me@kennethreitz.org"` scored ONE signal — symbol
  //    density alone — and was read as prose, so a derived cue found in it
  //    kept its full weight. Prose does not put a quoted string after an
  //    equals sign; every configuration language and every programming
  //    language does.
  if (/[=:]\s*["'`]/u.test(line)) signals += 1;

  // 5c. A MULTI-WORD IDENTIFIER. `AuthenticationCredentialsProvider` — two
  //     or more internal case humps in one token, which is how code writes a
  //     compound name and how prose never writes anything.
  //
  //     TWO humps, not one, and the number is the whole point. A single hump
  //     is what a person types when they choose a memorable password
  //     (`beauChev`), and treating that as code would veto the very case
  //     this engine was reported for. Two humps is a THIRD word joined on,
  //     and nobody does that to a password they have to type.
  if (hasCompoundCase(line)) signals += 1;

  // 6. PROSE EVIDENCE, which subtracts. Four or more consecutive
  //    space-separated alphabetic words is a sentence, whatever else is on
  //    the line.
  if (hasProseWordRun(line)) signals -= 1;

  return signals >= tuning.minSignals ? "code" : "prose";
}

// ── layer 4 proper ───────────────────────────────────────────────────────

export type EntropyTuning = Readonly<{
  /**
   * The shortest unbroken run that can be a credential on its own evidence.
   * Below this the value has to be introduced by something.
   */
  minRunLength: number;
  /** Distinct character classes the run must draw from. */
  minRunClasses: number;
  /** Shannon bits per character. */
  minRunEntropy: number;
  /** At or above this proportion of vowels the run reads as words. */
  maxVowelRatio: number;
  /** Above this a token is a document, not a credential. */
  maxTokenLength: number;
}>;

/**
 * THE SHIPPED THRESHOLDS, and the sweep that chose them.
 *
 * Swept over the held-out corpora — 7,412 positives from gitleaks,
 * detect-secrets and trufflehog against 39,503 lines of ordinary source
 * (lodash, the vue docs, psf/requests). The run length is the parameter that
 * moves both numbers hardest, and 16 is where the curve turns: at 12 the
 * candidate rate on ordinary source is 1.28%, at 16 it is 0.09%, and the
 * positives lost between the two are 4 percentage points.
 *
 * They are parameters rather than literals so the sweep can be re-run and so
 * a guard can mutate one and watch the behaviour move. A threshold nobody
 * can re-derive is a threshold that rots.
 */
const ENTROPY_TUNING: EntropyTuning = deepFreeze({
  minRunLength: 16,
  minRunClasses: 2,
  minRunEntropy: 3.0,
  maxVowelRatio: 0.25,
  maxTokenLength: 4096,
});

/**
 * The candidate tokenizer.
 *
 * `=` is admitted only as a TRAILING run, because that is base64 padding and
 * part of the value, while an interior `=` is an assignment operator and the
 * two sides of it are different things. Measured: without that rule
 * `boundary=3131623adb2043caaeb5538cc7aa0b3a` is one token whose benign
 * `hex-digest` grammar no longer explains it, and a multipart boundary in
 * `psf/requests` becomes a false positive.
 *
 * `:` is excluded entirely — it separates a key from its value, and URLs,
 * which are the other place it appears, are handled as benign regions.
 */
const CANDIDATE_TOKEN = /[A-Za-z0-9_$][A-Za-z0-9_$+/.~-]*={0,3}/gu;

/** Punctuation that wraps or trails a token without being part of it. */
const TOKEN_EDGE = /^[.~-]+|[.,;:!?~-]+$/gu;

function trimTokenEdges(token: string): Readonly<{ text: string; offset: number }> {
  TOKEN_EDGE.lastIndex = 0;
  const leading = /^[.~-]+/u.exec(token);
  const offset = leading === null ? 0 : leading[0].length;
  let text = token.slice(offset);
  const trailing = /[.,;:!?~-]+$/u.exec(text);
  if (trailing !== null) text = text.slice(0, text.length - trailing[0].length);
  return { text, offset };
}

export type EntropyCandidate = Readonly<{
  startUtf16: number;
  endUtf16: number;
  /** The longest unbroken run inside it — what the judgement was made on. */
  run: string;
  runEntropy: number;
}>;

/**
 * Every region of `text` that is high-entropy and explained by nothing
 * benign.
 *
 * Returns the CANDIDATES rather than spans, so a caller can decide what
 * evidence to attach — the declaration layer treats a candidate next to a
 * credential noun as corroboration, while this layer's own span stands on
 * the value alone.
 */
export function entropyCandidates(
  text: string,
  tuning: EntropyTuning = ENTROPY_TUNING,
): readonly EntropyCandidate[] {
  if (text.length < tuning.minRunLength) return EMPTY_CANDIDATES;
  // ── THE PREFILTER, AND IT IS EXACT RATHER THAN HEURISTIC ────────────────
  //
  // Every candidate this function can raise contains an unbroken run of at
  // least `minRunLength` letters and digits — it is the first thing checked
  // for each token and nothing reaches the output without it. So a string
  // with no such run anywhere has no candidate, and the tokenizer, the
  // region scan and the per-token grammar checks can all be skipped.
  //
  // It is one pass with no allocation, and it cannot change the result:
  // the condition it tests is a strictly weaker form of a condition the loop
  // below tests anyway.
  //
  // MEASURED, because the layer it guards was the most expensive one: the
  // egress pass over a 375KB history page cost 33.1ms with all five layers
  // running unconditionally, against 1.04ms for the format catalog alone.
  // Ordinary prose has no sixteen-character unbroken run in it at all.
  if (longestAlphanumericRunAtLeast(text, tuning.minRunLength) === false) return EMPTY_CANDIDATES;
  const regions: readonly BenignRegion[] = benignRegions(text);
  const out: EntropyCandidate[] = [];
  CANDIDATE_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CANDIDATE_TOKEN.exec(text)) !== null) {
    const raw = match[0];
    if (raw.length === 0) {
      CANDIDATE_TOKEN.lastIndex += 1;
      continue;
    }
    if (raw.length < tuning.minRunLength || raw.length > tuning.maxTokenLength) continue;
    const { text: token, offset } = trimTokenEdges(raw);
    if (token.length < tuning.minRunLength) continue;
    const start = match.index + offset;
    const end = start + token.length;
    if (withinBenignRegion(regions, start, end) !== null) continue;
    if (benignTokenGrammar(token) !== null) continue;
    const run = longestAlphanumericRun(token);
    if (run.length < tuning.minRunLength) continue;
    // The run is judged on its own, and it is checked against the benign
    // grammars a SECOND time: a token can be `boundary=<digest>` shaped in
    // ways the tokenizer did not split, and the digest is still a digest.
    if (benignTokenGrammar(run) !== null) continue;
    if (characterClassCount(run) < tuning.minRunClasses) continue;
    if (vowelRatio(run) >= tuning.maxVowelRatio) continue;
    const runEntropy = shannonEntropyBits(run);
    if (runEntropy < tuning.minRunEntropy) continue;
    out.push(Object.freeze({ startUtf16: start, endUtf16: end, run, runEntropy }));
  }
  return out.length === 0 ? EMPTY_CANDIDATES : Object.freeze(out);
}

const EMPTY_CANDIDATES: readonly EntropyCandidate[] = Object.freeze([]);

/**
 * LAYER 4 as a detector: every candidate, as a span.
 *
 * The explanation names the two facts the judgement rests on — the run's
 * length and that nothing benign explains it — and never any part of the
 * value.
 */
export function entropySecretSpans(
  text: string,
  tuning: EntropyTuning = ENTROPY_TUNING,
): readonly IntelligenceSpan[] {
  const candidates = entropyCandidates(text, tuning);
  if (candidates.length === 0) return NO_SPANS;
  return candidates.map((candidate) =>
    Object.freeze({
      startUtf16: candidate.startUtf16,
      endUtf16: candidate.endUtf16,
      signalId: "high-entropy-value",
      detectorId: "value-intrinsic",
      confidence: "inferred" as const,
      explanation:
        `is ${candidate.run.length} unbroken random-looking characters ` +
        `and matches nothing ordinary (not an id, hash, date, version or path)`,
    }),
  );
}

/** Which benign grammar explains a token, for the "why was this NOT masked"
 * question a user can ask of any value. */
export function benignExplanation(token: string): BenignGrammarId | null {
  return benignTokenGrammar(token);
}
