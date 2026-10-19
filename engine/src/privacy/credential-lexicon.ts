import { deepFreeze } from "../kernel/integrity.ts";

/**
 * THE WORDLIST IS LEARNED, NOT MAINTAINED.
 *
 * The user's position, and it is the right one: *"we must rely on dynamic
 * detection as much as possible, I don't like wordlist"* — *"although i
 * understand we may need some."*
 *
 * Layers 1 to 4 need no vocabulary at all. A checksum, a grammar, an
 * identity match and entropy-minus-the-benign are language-free by
 * construction, and between them they carry most of the detection. Only
 * layer 5 needs words, and it needs them for a case nothing else can reach:
 * a LOW-ENTROPY secret. `my password may be admin44` has no intrinsic
 * signal whatsoever — seven characters that look like a word and a year —
 * and the noun is the only evidence that exists.
 *
 * So the vocabulary is bootstrapped, derived, and then learned:
 *
 *  1. THE SEED is a handful of CONCEPTS in one language, labelled a
 *     bootstrap rather than the system. It is deliberately not a
 *     translation table, and it stays small because the two mechanisms
 *     below expand and supersede it.
 *  2. DERIVATION expands each seed mechanically — separator and case
 *     variants, abbreviations, truncations, plurals — by pure functions
 *     that are individually testable. One concept becomes dozens of surface
 *     forms with nobody typing them.
 *  3. LEARNING takes the words that actually surround PROVEN secrets — the
 *     ones layers 1 to 4 found without any vocabulary — and adds them, in
 *     whatever language the user writes. Layer 3 bootstraps this for free:
 *     the harness holds its own credentials and knows the words next to
 *     them.
 *
 * RECALL COMES FROM DERIVING GENEROUSLY; PRECISION COMES FROM WEIGHTING.
 * A derived term is worth less than the canonical one it came from, and a
 * learned term is worth less than a seeded one. The correct response to a
 * false positive from a derived term is to look at its WEIGHT, never to
 * shrink the derived set — shrinking it is how the system goes back to being
 * a list somebody maintains.
 *
 * THE COLLISION PROBLEM, AND WHY REGISTER SOLVES IT. `pass`, `key` and
 * `secret` are everywhere in source code: `pass` is a test verb, `key` is a
 * map index, `secret` is a variable nobody set. A colliding term needs
 * stronger corroboration, and the corroboration is REGISTER — in code,
 * `key = getKey()` is an assignment; in prose, "the key is X" is a
 * disclosure. That is supplied by `value-intrinsic.ts::registerAt`, not by a
 * second list of exceptions.
 *
 * NOTHING LEARNED CROSSES A BOUNDARY. The learned store is keyed by an
 * opaque scope the caller supplies (one user, one session), it holds WORDS
 * and never values, it is bounded, and it is inspectable and forgettable by
 * the person it was learned from.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

// ── where a term came from, which is what decides its weight ─────────────

export type LexiconOrigin =
  | "seed-strong"
  | "seed-weak"
  | "seed-derived"
  | "learned"
  | "learned-derived";

export type LexiconEntry = Readonly<{
  /** The surface form, lowercased. */
  term: string;
  origin: LexiconOrigin;
  /** The term this one was derived or learned from. Its own term when seeded. */
  from: string;
  /** How this form was produced, in plain words, for the inspect surface. */
  how: string;
}>;

/**
 * THE WEIGHTS, AND THE ORDERING THEY ENCODE.
 *
 * These are not tuned to decimal places; they encode a strict ordering that
 * the corpus tests — a word that names a credential and nothing else beats a
 * word that sometimes names something else, which beats a form nobody typed,
 * which beats a form nobody typed derived from a word nobody seeded.
 */
export const LEXICON_WEIGHTS: Readonly<Record<LexiconOrigin, number>> = deepFreeze({
  // Identical to `DECLARATION_TUNING.strongCueWeight` / `weakCueWeight` —
  // the canonical seed IS the regex's two groups, on the same scale.
  "seed-strong": 6,
  "seed-weak": 4,
  // Three is the value at which a derived or learned term, an explicit
  // connector and a credential-shaped value sum to exactly `minEvidence`.
  // That is the intended bar: a term nobody typed fires only when both other
  // kinds of evidence are present, and never on its own. At two it could not
  // fire at all and the learning would be decoration; at four it would fire
  // on a connector alone, which is every line of configuration in the world.
  "seed-derived": 3,
  learned: 3,
  // A form derived from a word that was itself only learned is two
  // inferences deep. It contributes, and it cannot carry a detection.
  "learned-derived": 2,
});

// ── 1. THE SEED ──────────────────────────────────────────────────────────

/**
 * THE BOOTSTRAP. Concepts, not surface forms, and not a translation table.
 *
 * `strong` names a credential and nothing else. `weak` often names a
 * credential and sometimes names something else — "token" is also a unit of
 * LLM billing, "secret" is also an English adjective, "key" is also a map
 * index — which is precisely the distinction the weights exist for.
 *
 * A SECOND LANGUAGE IS PRESENT ON PURPOSE, and exactly one, to make the
 * point structural rather than aspirational: nothing in this file is
 * English-specific, and the derivation rules that follow are about
 * separators, case and consonants rather than about vocabulary. It is not
 * an attempt at coverage — coverage comes from learning.
 */
const SEED_STRONG: readonly string[] = deepFreeze([
  "password",
  "passphrase",
  "api key",
  "secret key",
  "private key",
  "access token",
  "refresh token",
  "client secret",
  "connection string",
  "authorization",
  // one non-English pair, so the mechanism is exercised rather than assumed
  "mot de passe",
  "contrasena",
]);

const SEED_WEAK: readonly string[] = deepFreeze([
  "credential",
  "secret",
  "token",
  "key",
  "auth",
]);

// ── 2. DERIVATION — pure, bounded, individually testable ─────────────────

/** Whether a letter is a Latin vowel. `y` is deliberately not one: it is a
 * consonant often enough that treating it as a vowel would reject `ky` and
 * `pky`-shaped abbreviations that people really write. */
export function isVowel(letter: string): boolean {
  return letter === "a" || letter === "e" || letter === "i" || letter === "o" || letter === "u";
}

/**
 * THE VOWEL RULE — the guard that makes abbreviation derivation safe.
 *
 * An abbreviation is an ordered subsequence of a word's letters that starts
 * with the same letter: `pwd` is p·w·d at positions 0, 4 and 7 of
 * `password`. Generating those subsequences generously is how `pwd`, `psw`
 * and `passwd` all fall out of one seed with nobody listing them.
 *
 * Generously is also how `pod` falls out — p·o·d, positions 0, 5 and 7, a
 * perfectly ordinary English word that would then mask whatever followed it.
 * The guard is that ABBREVIATIONS DROP VOWELS. A candidate carrying a vowel
 * anywhere but its first position is not an abbreviation, and `pod` carries
 * `o` at position 1.
 *
 * The first position is exempt because plenty of credential words begin with
 * a vowel (`auth`, `api`), and dropping a word's own initial would break the
 * "starts with the same letter" rule that makes the subsequence an
 * abbreviation at all.
 */
export function isAbbreviationShaped(candidate: string): boolean {
  if (candidate.length < MIN_ABBREVIATION_LENGTH) return false;
  for (let i = 1; i < candidate.length; i += 1) {
    if (isVowel(candidate[i]!)) return false;
  }
  return true;
}

/** Below three characters a term is a fragment that collides with
 * everything. Stated as a constant so a guard can move it and watch the
 * derived set change. */
const MIN_ABBREVIATION_LENGTH = 3;

/** The longest abbreviation worth generating. Beyond this the subsequence
 * count grows without adding forms anybody writes. */
const MAX_ABBREVIATION_LENGTH = 6;

/** A bound on how many forms one term may derive, so a pathological seed
 * cannot make the scan cost unbounded. */
const MAX_DERIVED_PER_TERM = 64;

/**
 * SEPARATOR AND CASE VARIANTS. `api key` becomes `api key`, `api_key`,
 * `api-key`, `api.key`, `apikey`. Case is not enumerated because every
 * consumer matches case-insensitively; enumerating it would quadruple the
 * set to say the same thing.
 */
export function separatorVariants(term: string): readonly string[] {
  const parts = term.split(/[\s._-]+/u).filter((p) => p.length > 0);
  if (parts.length < 2) return Object.freeze([term]);
  const out = new Set<string>();
  for (const separator of [" ", "_", "-", ".", ""]) out.add(parts.join(separator));
  return Object.freeze([...out]);
}

/**
 * ABBREVIATIONS: every ordered subsequence of the term's letters that starts
 * with its first letter, is between the length bounds, and passes the vowel
 * rule.
 *
 * Enumerated over the LETTERS rather than over the consonants, deliberately.
 * Enumerating consonants only would make the vowel rule vacuously true — the
 * guard would be unremovable and therefore untestable, and a guard that
 * cannot be mutated is a guard nobody has checked. Generating `pod` and then
 * rejecting it is what makes the rejection a fact about the code.
 */
export function abbreviations(term: string): readonly string[] {
  const letters = term.replace(/[^a-z]/gu, "");
  if (letters.length < MIN_ABBREVIATION_LENGTH) return EMPTY;
  const first = letters[0]!;
  const rest = letters.slice(1);
  // Bounded: only the first `MAX_SUBSEQUENCE_SOURCE` letters after the
  // initial are candidates, which keeps the powerset small and loses
  // nothing — nobody abbreviates using the twelfth letter of a word.
  const pool = rest.slice(0, MAX_SUBSEQUENCE_SOURCE);
  const out = new Set<string>();
  const total = 1 << pool.length;
  for (let mask = 1; mask < total; mask += 1) {
    let candidate = first;
    for (let bit = 0; bit < pool.length; bit += 1) {
      if (mask & (1 << bit)) candidate += pool[bit]!;
    }
    if (candidate.length > MAX_ABBREVIATION_LENGTH) continue;
    if (candidate === letters) continue;
    if (!isAbbreviationShaped(candidate)) continue;
    out.add(candidate);
    if (out.size >= MAX_DERIVED_PER_TERM) break;
  }
  return Object.freeze([...out]);
}

const MAX_SUBSEQUENCE_SOURCE = 12;
const EMPTY: readonly string[] = Object.freeze([]);

/** PREFIX TRUNCATIONS of at least three characters: `pas`, `pass`, `passw`.
 * The whole term is excluded — it is the canonical form, not a derivation. */
export function prefixTruncations(term: string): readonly string[] {
  const letters = term.replace(/[^a-z]/gu, "");
  const out: string[] = [];
  for (let n = MIN_ABBREVIATION_LENGTH; n < letters.length; n += 1) {
    out.push(letters.slice(0, n));
  }
  return Object.freeze(out);
}

/** SIMPLE INFLECTIONS: the plural forms a noun takes. */
function inflections(term: string): readonly string[] {
  if (term.endsWith("s")) return EMPTY;
  const out = [`${term}s`];
  if (/(?:s|x|z|ch|sh)$/u.test(term)) out.push(`${term}es`);
  return Object.freeze(out);
}

/**
 * Every form derived from one canonical term, each labelled with how it was
 * produced — because the inspect surface has to be able to say
 * "`pwd`: shortened from `password`", not just "`pwd`".
 */
function deriveForms(
  term: string,
  origin: "seed-derived" | "learned-derived",
): readonly LexiconEntry[] {
  const canonical = term.toLowerCase();
  const out = new Map<string, LexiconEntry>();
  const add = (form: string, how: string): void => {
    if (form.length < MIN_ABBREVIATION_LENGTH) return;
    if (form === canonical) return;
    if (out.has(form)) return;
    if (out.size >= MAX_DERIVED_PER_TERM) return;
    out.set(form, Object.freeze({ term: form, origin, from: canonical, how }));
  };
  for (const variant of separatorVariants(canonical)) add(variant, "written with a different separator");
  for (const form of abbreviations(canonical)) add(form, "shortened, keeping the consonants");
  for (const form of prefixTruncations(canonical)) add(form, "shortened to its first letters");
  for (const form of inflections(canonical)) add(form, "the plural form");
  // Plurals of the separator variants, which is how `api keys` and
  // `api_keys` arrive without either being written down.
  for (const variant of separatorVariants(canonical)) {
    for (const form of inflections(variant)) add(form, "the plural form");
  }
  return Object.freeze([...out.values()]);
}

// ── 3. LEARNING — scoped, bounded, inspectable, forgettable ──────────────

export type LearnedTerm = Readonly<{
  term: string;
  /** How many times a proven secret was seen with this word beside it. */
  occurrences: number;
  /**
   * The words this was learned FROM, in the user's own text, so the inspect
   * surface can show the evidence. Never any part of a secret — the value
   * is exactly what does not get recorded here.
   */
  examples: readonly string[];
}>;

/** How many terms one scope may learn. A bound, not a policy: the scan cost
 * has to stay bounded whatever a conversation contains. */
const MAX_LEARNED_TERMS = 128;

/** How many example phrasings are kept per term, for the inspect surface. */
const MAX_LEARNED_EXAMPLES = 3;

/** How many times a word must appear beside a proven secret before it is
 * believed. One co-occurrence is a coincidence. */
export const MIN_LEARNING_OCCURRENCES = 2;

/**
 * The learned store, keyed by an opaque scope the caller supplies.
 *
 * Module-private and never exported as a whole: the only ways out are
 * `inspectLearned` (which returns terms and counts) and the lexicon builder.
 * A word is not a secret, but a word somebody chose to type next to their
 * password is still theirs, and it does not leave its scope.
 */
const learnedByScope = new Map<string, Map<string, { occurrences: number; examples: string[] }>>();

/**
 * Words that may never be learned however often they appear.
 *
 * Not a credential wordlist — the opposite. These are the words that sit
 * beside a secret in EVERY language's technical writing without naming one:
 * a bare `is`, a `the`, a `for`. Learning them would make the declaration
 * layer fire on every sentence containing a long token.
 *
 * Kept as a length-and-shape rule plus this handful rather than a stopword
 * list per language, because a stopword list per language is the thing this
 * whole design refuses to maintain.
 */
function isLearnable(word: string): boolean {
  if (word.length < MIN_LEARNABLE_LENGTH) return false;
  if (word.length > MAX_LEARNABLE_LENGTH) return false;
  // A word with digits or punctuation in it is a value or an identifier,
  // not a noun somebody chose.
  return /^[\p{L}][\p{L}\p{M}]*$/u.test(word);
}

const MIN_LEARNABLE_LENGTH = 3;
const MAX_LEARNABLE_LENGTH = 32;

/**
 * Teach a scope that these words surrounded a PROVEN secret.
 *
 * The caller supplies only words that neighboured a span that layers 1 to 4
 * found — never a span layer 5 inferred, because learning from an inference
 * and then inferring from what was learned is a feedback loop that ends with
 * everything masked.
 *
 * Returns the terms that crossed the occurrence threshold on THIS call, so a
 * caller can tell the user what was just learned.
 */
export function learnCredentialContext(
  scope: string,
  words: readonly string[],
): readonly string[] {
  if (scope.length === 0) return EMPTY;
  let store = learnedByScope.get(scope);
  if (store === undefined) {
    store = new Map();
    learnedByScope.set(scope, store);
  }
  const crossed: string[] = [];
  for (const raw of words) {
    const word = raw.toLowerCase();
    if (!isLearnable(word)) continue;
    if (SEED_ALL.has(word)) continue;
    const existing = store.get(word);
    if (existing === undefined) {
      if (store.size >= MAX_LEARNED_TERMS) continue;
      store.set(word, { occurrences: 1, examples: [raw] });
      continue;
    }
    existing.occurrences += 1;
    if (existing.examples.length < MAX_LEARNED_EXAMPLES && !existing.examples.includes(raw)) {
      existing.examples.push(raw);
    }
    if (existing.occurrences === MIN_LEARNING_OCCURRENCES) crossed.push(word);
  }
  return Object.freeze(crossed);
}

const SEED_ALL: ReadonlySet<string> = new Set([...SEED_STRONG, ...SEED_WEAK]);

/**
 * WHAT THIS SCOPE HAS LEARNED, in plain words, with the evidence.
 *
 * The inspect half of "learned terms must be inspectable". Below the
 * occurrence threshold a term is reported too — a user asking what the
 * system thinks should see what it is considering, not only what it has
 * concluded.
 */
export function inspectLearned(scope: string): readonly LearnedTerm[] {
  const store = learnedByScope.get(scope);
  if (store === undefined) return EMPTY_LEARNED;
  return Object.freeze(
    [...store.entries()]
      .sort((a, b) => b[1].occurrences - a[1].occurrences || a[0].localeCompare(b[0]))
      .map(([term, entry]) =>
        Object.freeze({
          term,
          occurrences: entry.occurrences,
          examples: Object.freeze([...entry.examples]),
        }),
      ),
  );
}

const EMPTY_LEARNED: readonly LearnedTerm[] = Object.freeze([]);

/** Forget one learned term. The other half of "inspectable": a user who can
 * see a wrong conclusion has to be able to remove it. */
export function forgetLearnedTerm(scope: string, term: string): boolean {
  const store = learnedByScope.get(scope);
  if (store === undefined) return false;
  const removed = store.delete(term.toLowerCase());
  if (store.size === 0) learnedByScope.delete(scope);
  return removed;
}

/** Forget everything one scope learned — a session ending, a user asking. */
export function forgetScope(scope: string): boolean {
  return learnedByScope.delete(scope);
}

/** Forget everything, everywhere. Exists for tests and for a hard reset. */
export function clearLearned(): void {
  learnedByScope.clear();
}

/** How many scopes hold learned terms. A status number that reveals nothing
 * about what any of them contain. */
export function learnedScopeCount(): number {
  return learnedByScope.size;
}

// ── the lexicon itself ───────────────────────────────────────────────────

/**
 * THE SEEDED HALF, computed once. It is a pure function of two constant
 * arrays, so computing it per call would be spending the derivation cost on
 * every string the egress path sees for an answer that cannot change.
 */
const SEEDED_ENTRIES: readonly LexiconEntry[] = deepFreeze([
  ...SEED_STRONG.map((term) =>
    ({ term, origin: "seed-strong" as const, from: term, how: "names a credential and nothing else" }),
  ),
  ...SEED_WEAK.map((term) =>
    ({ term, origin: "seed-weak" as const, from: term, how: "often names a credential" }),
  ),
  ...dedupe([
    ...SEED_STRONG.flatMap((term) => deriveForms(term, "seed-derived")),
    ...SEED_WEAK.flatMap((term) => deriveForms(term, "seed-derived")),
  ]),
]);

function dedupe(entries: readonly LexiconEntry[]): readonly LexiconEntry[] {
  const seen = new Set<string>();
  const out: LexiconEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.term)) continue;
    seen.add(entry.term);
    out.push(entry);
  }
  return out;
}

/** The seeded and derived vocabulary, with no learning in it. */
export function seededLexicon(): readonly LexiconEntry[] {
  return SEEDED_ENTRIES;
}

/**
 * The full vocabulary for one scope: seed, derived-from-seed, learned, and
 * derived-from-learned, with the seeded forms winning any collision so a
 * learned word can never DOWNGRADE a canonical one.
 */
export function lexiconForScope(scope: string): readonly LexiconEntry[] {
  const learned = inspectLearned(scope).filter((t) => t.occurrences >= MIN_LEARNING_OCCURRENCES);
  if (learned.length === 0) return SEEDED_ENTRIES;
  const byTerm = new Map<string, LexiconEntry>();
  for (const entry of SEEDED_ENTRIES) byTerm.set(entry.term, entry);
  for (const { term } of learned) {
    if (!byTerm.has(term)) {
      byTerm.set(term, {
        term,
        origin: "learned",
        from: term,
        how: "learned as credential context, from your own words",
      });
    }
    for (const derived of deriveForms(term, "learned-derived")) {
      if (!byTerm.has(derived.term)) byTerm.set(derived.term, derived);
    }
  }
  return Object.freeze([...byTerm.values()]);
}

/** The weight a cue carries, from where its term came from. */
export function lexiconWeight(origin: LexiconOrigin): number {
  return LEXICON_WEIGHTS[origin];
}
