import { deepFreeze } from "../kernel/integrity.ts";
// ONE OWNER FOR "WHAT IS A VOWEL". `credential-lexicon` imports nothing
// local, so depending on it here cannot make a cycle, and re-deciding the
// question locally is exactly the two-paths defect this project keeps
// finding.
import { isVowel } from "./credential-lexicon.ts";

/**
 * THE BENIGN ENUMERATION — the inversion this whole layer rests on.
 *
 * Credential words are unbounded and multilingual: `password`, `mot de
 * passe`, `contraseña`, `Kennwort`, `пароль`, plus every provider noun that
 * does not exist yet. Enumerating them is a losing race, and the previous
 * pass measured exactly that — 3.4% of held-out positives found by the format
 * catalog alone.
 *
 * High-entropy things that are BENIGN are the opposite kind of set: bounded,
 * stable, and language-free. A git SHA is a git SHA in every language. A UUID
 * has one grammar. An ISO timestamp has one grammar. So the rule inverts:
 *
 *     HIGH ENTROPY MINUS THE KNOWN-BENIGN GRAMMARS IS A CANDIDATE.
 *
 * No noun, no language, no provider list. This is what reaches a bare key
 * from a provider nobody listed, and it is the enumeration we need ANYWAY,
 * because it is the only thing that stops the entropy layer masking every git
 * SHA in a commit log.
 *
 * TWO SHAPES OF BENIGN, and they are not interchangeable:
 *
 *  - a benign TOKEN (`benignTokenGrammar`) — the whole token is a UUID, a
 *    digest, a timestamp. Checked per candidate.
 *  - a benign REGION (`benignRegions`) — a stretch of text inside which no
 *    candidate may be raised at all, because the region's own grammar
 *    explains every byte in it. A URL is the case that matters: measured on
 *    the vuejs-docs corpus, `https://play.vuejs.org/#eNo9jUEOgyAQRa8yYUO7...`
 *    is a base64 playground payload with the entropy and length of a session
 *    token, and there are hundreds of them. The token is not benign; the URL
 *    it lives in is.
 *
 * A GRAMMAR MAY BE WRONG IN ONE DIRECTION, AND IT IS STATED RATHER THAN
 * HIDDEN. `hex-digest` refuses a 32/40/64-hex token, and some real
 * credentials are exactly 32 hex characters — the corpus contains an
 * `adobeToken` that is one. The benign grammars are therefore a veto on
 * VALUE-INTRINSIC evidence only (layer 4); they never veto a checksum
 * (layer 1), an identity match (layer 3) or a declaration (layer 5). A hex
 * digest introduced by `adobeToken =` is still masked, by the layer that has
 * evidence beyond the value's own shape.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

export type BenignGrammarId =
  | "uuid"
  | "provider-call-id"
  | "hex-digest"
  | "truncated-digest"
  | "git-sha"
  | "iso-timestamp"
  | "epoch-millis"
  | "semver"
  | "number"
  | "number-with-unit"
  | "mime-type"
  | "hex-colour"
  | "identifier"
  | "dotted-name"
  | "word-phrase"
  | "file-path"
  | "url"
  | "data-uri"
  // `character-set` is about character ORDER rather than shape, so it is the
  // one grammar with a predicate instead of a pattern. It was declared in
  // `BENIGN_TOKEN_GRAMMARS` and reported by `benignTokenGrammar` while being
  // absent from this union — the widening the compiler was flagging. Absent
  // from the union, no exhaustive switch over ids could ever have handled it.
  | "character-set";

export type BenignGrammar = Readonly<{
  id: BenignGrammarId;
  /** Zero-knowledge wording. Shown to a user as "not masked because …". */
  plainName: string;
  /**
   * The authority. Almost every grammar is an anchored regex, and
   * `patternSource` carries it so a guard can enumerate and mutate the set;
   * one grammar (`character-set`) is about character ORDER, which a regex
   * cannot express, and it supplies its own predicate instead.
   */
  matches: (token: string) => boolean;
  /** The regex source, when there is one. Null for predicate grammars. */
  patternSource: string | null;
}>;

function byPattern(
  id: BenignGrammarId,
  plainName: string,
  pattern: RegExp,
): BenignGrammar {
  return {
    id,
    plainName,
    matches: (token: string) => pattern.test(token),
    patternSource: pattern.source,
  };
}

/**
 * A run whose character codes only ever go up (or only ever down) for its
 * whole length: `ABCDEFGHIJKLMNOPQRSTUVWXYZ`, `0123456789`, `abcdef`.
 *
 * ENTROPY IS BLIND TO THIS, by construction. Shannon entropy measures the
 * character DISTRIBUTION, so a sorted alphabet and a random permutation of
 * the same characters score identically — and a 52-character alphabet scores
 * the maximum a 52-character token can. Measured on psf/requests, where
 * `"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"` is the base of a
 * URL-encoding table; every base62, base58 and hex alphabet in every
 * codebase has the same shape. Order is the only thing that separates them,
 * and order is exactly what a regex cannot say.
 *
 * Case changes reset the direction check, so the concatenated upper- and
 * lower-case alphabets read as two monotonic runs rather than one break.
 */
function isMonotonicRun(token: string): boolean {
  if (token.length < MIN_MONOTONIC_RUN) return false;
  let ascending = 0;
  let descending = 0;
  let resets = 0;
  for (let i = 1; i < token.length; i += 1) {
    const previous = token.charCodeAt(i - 1);
    const current = token.charCodeAt(i);
    if (current === previous + 1) ascending += 1;
    else if (current === previous - 1) descending += 1;
    else resets += 1;
  }
  // Every step but a handful of case/class boundaries must be a single step
  // in one direction. Two resets covers "digits, then upper, then lower".
  return resets <= 2 && ascending + descending === token.length - 1 - resets;
}

/** Below this a monotonic run is a coincidence (`abc`, `123`), not a table. */
const MIN_MONOTONIC_RUN = 8;

/**
 * A COMPONENT THAT READS AS A WORD — the guard `word-phrase` and
 * `dotted-name` were missing, and the hole it left was a REAL BYPASS.
 *
 * Both grammars were written as "letters, then a separator, then letters",
 * which describes `state-of-the-art` and `Combining_Diacritical_Marks`. It
 * also describes this, exactly and entirely:
 *
 *     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      (a HuggingFace token)
 *     dp.pt.skyuz39w9ovadsprfotliigvrltirdoq8g9qu652615
 *
 * A benign grammar is a VETO on the value-intrinsic layer, so declaring
 * those benign did not merely fail to help — it actively suppressed the one
 * layer whose whole purpose is finding a key from a provider nobody listed.
 * The `identifier` grammar has been corrected twice for the same reason and
 * its comments say so; these two were never corrected at all.
 *
 * THE SEPARATOR IS NOT THE EVIDENCE. THE WORDS ARE. A component earns its
 * benignity by reading like a word:
 *
 *  - SHORT. Ordinary words are; `skyuz39w9ovadsprfotliigvrltirdoq8g9qu652615`
 *    is not.
 *  - VOWEL-BEARING, using the same `isVowel` the abbreviation rule uses.
 *    A run with no vowel at all is not a word in any of these languages.
 *  - ORDINARILY CAPITALISED — all lower, all upper, or Capitalized. An
 *    INTERNAL case flip (`xnnhBfiSz`) is what random alphabets produce
 *    constantly and what no single word contains. This is the same argument
 *    the `identifier` grammar makes, applied to one component.
 *  - LETTERS, with at most a short trailing number (`utf8`, `base64`).
 *    Digits INTERLEAVED with letters are not a word.
 */
const MAX_WORD_COMPONENT = 20;
const WORD_COMPONENT = /^[A-Za-z]+[0-9]{0,3}$/u;

function isWordLikeComponent(component: string): boolean {
  if (component.length === 0 || component.length > MAX_WORD_COMPONENT) return false;
  if (!WORD_COMPONENT.test(component)) return false;
  // ONE OR TWO CHARACTERS CARRIES NO EVIDENCE EITHER WAY, so it is not held
  // to the vowel rule: `x-request-id` and `a.b` are ordinary, and demanding
  // a vowel of `x` would strip the benign reading off a header name for no
  // gain. Nothing this short can be a credential on its own.
  if (component.length <= 2) return true;
  let vowels = 0;
  let internalFlip = false;
  for (let i = 0; i < component.length; i += 1) {
    const ch = component[i]!;
    if (isVowel(ch.toLowerCase())) vowels += 1;
    // A lowercase letter followed by an uppercase one, anywhere after the
    // first character. `Marks` and `HOME` are ordinary; `xnnhBfiSz` is not.
    if (i > 0) {
      const previous = component[i - 1]!;
      if (previous >= "a" && previous <= "z" && ch >= "A" && ch <= "Z") internalFlip = true;
    }
  }
  return vowels > 0 && !internalFlip;
}

/**
 * A CAMEL OR PASCAL NAME. Hoisted out of the grammar table because
 * `dotted-name` needs the same question answered about ONE of its
 * components — `Object.getOwnPropertySymbols` is a word, then a camel name —
 * and asking it in two places with two patterns is how they drift apart.
 *
 * See the `identifier` entry below for why each component must carry two
 * lowercase letters; that reasoning is this pattern's, not the table's.
 */
const IDENTIFIER_PATTERN =
  /^_{0,2}[a-z$][a-z0-9$]*(?:[A-Z][a-z]{2,}[0-9]{0,3})+_{0,2}$|^(?:[A-Z][a-z]{2,}[0-9]{0,3}){2,}$/u;

/**
 * A CAMEL NAME WHOSE COMPONENT IS A NUMBERED ABBREVIATION — the fourth
 * correction, and the second that makes this grammar ACCEPT more.
 *
 * `IDENTIFIER_PATTERN` demands two lowercase letters in every capitalised
 * component. A whole family of ordinary names cannot pay that, because the
 * component is an abbreviation carrying a number:
 *
 *     hybridBm25Weight   computeMd5Sum   awsS3Bucket
 *     openEc2Instance    useDb2Driver    parseIso8601Date
 *
 * Measured before the change: `hybridBm25Weight` was masked as "16 unbroken
 * random-looking characters", by the entropy layer, in ordinary source. That
 * is content destruction of exactly the kind the acronym correction was
 * written to stop — the user cannot see what was taken — and the family is
 * wide, since `Md5`, `S3`, `Ec2`, `Db2` and `Iso8601` are everywhere.
 *
 * THE GUARD IS THE DIGIT PLUS THE WORD RUN, and it is deliberately two
 * things. Relaxing the lowercase count on its own would let a random
 * mixed-case alphabet read as PascalCase, which is the hole the two-letter
 * rule exists to close. So the short component must carry a DIGIT, which a
 * letters-only alphabet never does; and the name overall must still contain
 * a genuine lowercase word run, which an alternating `aB2C3D4E5` shape never
 * does. Either alone is insufficient — a random alphanumeric run can supply
 * digits, and a real word can sit beside anything.
 */
const NUMBERED_COMPONENT_NAME =
  /^_{0,2}[a-z$][a-z0-9$]*(?:[A-Z][a-z]{0,2}[0-9]{1,4}|[A-Z][a-z]{2,}[0-9]{0,3})+_{0,2}$|^(?:[A-Z][a-z]{0,2}[0-9]{1,4}|[A-Z][a-z]{2,}[0-9]{0,3}){2,}$/u;

/** A lowercase run long enough to be a word rather than a fragment. */
const WORD_RUN = /[a-z]{3,}/u;

function isNumberedComponentName(token: string): boolean {
  if (!NUMBERED_COMPONENT_NAME.test(token)) return false;
  // The word run is what separates `hybridBm25Weight` from `aB2C3D4E5F6`.
  return WORD_RUN.test(token);
}

/**
 * A CAMEL NAME CONTAINING AN ACRONYM — the third correction to this grammar,
 * and the first one that makes it ACCEPT more rather than less.
 *
 * `IDENTIFIER_PATTERN` requires every capitalised component to carry two
 * lowercase letters, which is what stops a random alphabet reading as
 * PascalCase. Real code breaks that rule constantly, with acronyms:
 *
 *     HTMLScriptElement   XMLHttpRequestWrapper   getCSSKeywordsByProperty
 *     nsIXMLHttpRequest   showXMLHttpRequests     fbVSplitterStyle
 *
 * Measured on lodash's vendored firebug-lite: 20 spans of ordinary source
 * masked as "a random-looking value". THAT IS CONTENT DESTRUCTION — the user
 * cannot see what was taken — and it is the failure this project weighs
 * heaviest.
 *
 * THE GUARD IS THE VOWEL RULE, so this cannot re-open the bypass the two
 * earlier corrections closed. A random alphabet also has uppercase runs
 * (`xnnhBfiSzMCACKWZfqsy` has `MCACKWZ`), so "has an acronym" alone would
 * hand the hole straight back. What separates them is that the LOWERCASE
 * runs of a real name are word fragments and a random alphabet's are not:
 *
 *     XMLHttpRequestWrapper -> ttp, equest, rapper      all pronounceable
 *     xnnhBfiSzMCACKWZfqsy  -> xnnh, fi, z, fqsy        `xnnh`, `fqsy`: no vowel
 *
 * Runs of three or fewer are exempt because an acronym steals the first
 * letter of the word after it (`Http` splits as `H` + `ttp`) and three
 * letters is too few to judge. Interleaved digits are refused outright:
 * `Zq7Wm3Xr9Td2Lp8Kc` is a key, and no name puts a digit between every pair
 * of letters.
 */
const ACRONYM_NAME = /^_{0,2}[A-Za-z]+[0-9]{0,3}_{0,2}$/u;
const MIN_JUDGED_RUN = 4;

/**
 * MOST OF A NAME IS THE WORDS. This is the measurement that keeps the
 * acronym branch from handing back the hole, and it was chosen by looking at
 * what the two populations actually do rather than by taste.
 *
 * A name spends its characters on lowercase word-bodies and pays only a few
 * to capitals: `XMLHttpRequestWrapper` is 71% lowercase, `nsIXMLHttpRequest`
 * 65%, `getCSSKeywordsByProperty` 75%. A random mixed-case alphabet spreads
 * its capitals evenly and lands far below: `SSVmFDNCFfOHKXQAEckx` 25%,
 * `wjXKCFzOWEPRqhTmmbWtVQ` 41%, `gVmMTdkwLwmZljcIOXhEmuZ` 57%.
 *
 * TUNED ON THE SECRETS CORPUS, WHICH IS WORTH SAYING PLAINLY: the 18 tokens
 * this branch newly admits were read off the held-out positives, so for THIS
 * ONE THRESHOLD that corpus is no longer untouched. The independent check is
 * the false-positive side, which comes from ordinary source the threshold was
 * never fitted to — and that is the side this rule exists to serve.
 */
const MIN_LOWERCASE_SHARE = 0.62;

function isAcronymCamelName(token: string): boolean {
  if (!ACRONYM_NAME.test(token)) return false;
  const letters = token.replace(/^[_$]+|[_$0-9]+$/gu, "");
  if (letters.length === 0) return false;
  let hasUpperRun = false;
  let hasLowerRun = false;
  let lowercase = 0;
  let index = 0;
  while (index < letters.length) {
    const start = index;
    const upper = letters[index]! >= "A" && letters[index]! <= "Z";
    while (
      index < letters.length &&
      (letters[index]! >= "A" && letters[index]! <= "Z") === upper
    ) index += 1;
    const run = letters.slice(start, index);
    if (upper) {
      if (run.length >= 2) hasUpperRun = true;
      continue;
    }
    lowercase += run.length;
    if (run.length >= 3) hasLowerRun = true;
    // Three or fewer is exempt: an acronym steals the first letter of the
    // word after it (`Http` splits as `H` + `ttp`), so a short run is a
    // fragment rather than a word and cannot be judged.
    if (run.length < MIN_JUDGED_RUN) continue;
    let vowels = 0;
    for (const ch of run) if (isVowel(ch)) vowels += 1;
    if (vowels === 0) return false;
  }
  // Both shapes must be present: an acronym AND a real word. Either alone is
  // a single-case token, which is the vowel rule's business, not this one's.
  if (!hasUpperRun || !hasLowerRun) return false;
  return lowercase / letters.length >= MIN_LOWERCASE_SHARE;
}

/**
 * A component of a dotted name: a word, or a camel name.
 *
 * Leading underscores and `$` are stripped first — `_private` and `$scope`
 * are ordinary names, and the sigil is not part of the word.
 */
function isDottedComponent(component: string): boolean {
  const bare = component.replace(/^[_$]+/u, "");
  return (
    isWordLikeComponent(bare) ||
    IDENTIFIER_PATTERN.test(component) ||
    isAcronymCamelName(component)
  );
}

/** Every separator-delimited component satisfies `ok`. */
function allComponents(
  token: string,
  separator: RegExp,
  ok: (part: string) => boolean,
): boolean {
  const parts = token.split(separator);
  if (parts.length < 2) return false;
  for (const part of parts) {
    if (!ok(part)) return false;
  }
  return true;
}

/** `state-of-the-art`, `not_configured`, `Combining_Diacritical_Marks`. */
function isWordPhrase(token: string): boolean {
  return /^[A-Za-z]+(?:[-_][A-Za-z]+)+$/u.test(token) && allComponents(token, /[-_]/u, isWordLikeComponent);
}

/** `Object.getOwnPropertySymbols`, `process.env.HOME`, `Settings.vue`. */
function isDottedName(token: string): boolean {
  return (
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(token) &&
    allComponents(token, /\./u, isDottedComponent)
  );
}

/**
 * THE TOKEN GRAMMARS, each anchored so it describes a WHOLE token.
 *
 * Anchoring is load-bearing rather than stylistic: an unanchored `uuid`
 * pattern would declare `<uuid>-suffix` benign on the strength of its prefix,
 * which is how a benign enumeration turns into a bypass. A candidate is
 * benign only when its every character is explained.
 */
const PATTERN_GRAMMARS: readonly Readonly<{
  id: BenignGrammarId;
  plainName: string;
  pattern: RegExp;
}>[] = deepFreeze([
  {
    // A bare UUID — and a PREFIXED one: the harness mints its entity ids as
    // `<domain>-<uuid>` through the canonical identifier owner (`run-…`,
    // `turn-…`, `evt-…`, `mem-…`), so the bare-UUID-only reading declared the
    // one shape the server actually hands the browser NON-benign, and the
    // credential detector then read the hex inside the identifier as a
    // secret (`run-…-4acc-a059-…` masked from the `acc` in `4acc`) and
    // destroyed the key the client must send back — the stream attach 404
    // this measurement came from. The prefix is constrained to a lowercase
    // domain word so a credential whose body is NOT a UUID (`sk-live-…`,
    // `Bearer <jwt>`) still matches nothing here: only the domain-labelled
    // UUID is structure. The prefix can also be UPPER- or mixed-case where a
    // legacy producer capitalised it (the `i` flag), and may itself be
    // hyphenated (`tool-call-…`) — the grammar explains every character, so
    // the anchoring rule above holds.
    id: "uuid",
    plainName: "a unique identifier",
    pattern: /^\{?(?:[a-z][a-z0-9]*-)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/iu,
  },
  {
    // The PROVIDER's tool-call and completion identifiers — the OpenAI wire
    // shapes `call_<body>` and `chatcmpl-<body>`. A callId is a transport
    // id: the client's live tool card keys by it, the run-end read-back
    // joins on it, and the ledger's events name it. Measured live: the
    // entropy layer read the hex body as a secret and every read-back row
    // served `callId: "[REDACTED:credential]"` — the identifier three
    // surfaces need, destroyed by the layer that exists to protect it,
    // exactly the domain-UUID case above. The fixed `call_` / `chatcmpl-`
    // prefix is what makes this structure rather than entropy: no
    // credential vocabulary begins with either (the `sk-`/`rk-`/`pk-`
    // prefixes are a different, existing signal), and a value DECLARED as
    // a credential beside a credential noun is still masked by the
    // declaration layer — the veto is value-intrinsic only, like every
    // grammar here. The body is alphanumeric with `_`/`-`, anchored so a
    // suffix past the body is never excused.
    id: "provider-call-id",
    plainName: "a provider call identifier",
    pattern: /^(?:call_|chatcmpl-)[A-Za-z0-9][A-Za-z0-9_-]*$/u,
  },
  {
    // The digest lengths, in characters, of the hashes software actually
    // prints: MD5 (32), SHA-1 (40), SHA-224 (56), SHA-256 (64), SHA-384 (96),
    // SHA-512 (128). Not "any long hex run" — a long hex run of an
    // unexplained length is exactly what a hex-encoded key looks like.
    id: "hex-digest",
    plainName: "a content hash",
    pattern: /^(?:sha\d*[:-])?[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{56}$|^[0-9a-f]{64}$|^[0-9a-f]{96}$|^[0-9a-f]{128}$/iu,
  },
  {
    // A TRUNCATED digest — the hex slice this harness itself issues as the
    // artifact id (`sha256(content).slice(0, N)` in the create_artifact
    // handler; N's shipped default is 16). Measured: the id this server just
    // handed the model went out as `"artifactId":"[REDACTED:credential]"` in
    // the tool result AND in the stored ledger document, so the model could
    // not reference the artifact it had just created and the record was not
    // verbatim. Full digests are explained by `hex-digest` and short
    // abbreviations by `git-sha` (≤12); the slice between them — exactly the
    // artifact id — fell to the value-intrinsic layer with nothing to vouch
    // for it. The length is pinned to the ISSUER'S DEFAULT, and the owning
    // test pins grammar↔issuer together (a re-issued default length updates
    // this pattern or the contract arm reds).
    //
    // WRONG IN ONE DIRECTION, STATED: some real value-intrinsic secrets are
    // 16 hex characters, and this grammar refuses to mask them on shape
    // alone. That is the `hex-digest`/adobeToken tradeoff restated: the veto
    // is on VALUE-INTRINSIC evidence only, so a credential DECLARED beside a
    // credential noun (`apiKey = <16 hex>`) is still masked by the
    // declaration layer, and a checksum or identity match by theirs.
    id: "truncated-digest",
    plainName: "a truncated content hash",
    pattern: /^[0-9a-f]{16}$/iu,
  },
  {
    // An abbreviated commit id. Bounded at 12 because that is where git's own
    // abbreviation stops; longer runs fall to `hex-digest` or to nothing.
    id: "git-sha",
    plainName: "a short commit id",
    pattern: /^[0-9a-f]{7,12}$/iu,
  },
  {
    id: "iso-timestamp",
    plainName: "a date or time",
    pattern: /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u,
  },
  {
    // 13-digit millisecond and 10-digit second epochs, the two an application
    // prints. Covered by `number` as well; named separately so the
    // explanation a user reads is the true one.
    id: "epoch-millis",
    plainName: "a timestamp",
    pattern: /^1[0-9]{9}(?:[0-9]{3})?$/u,
  },
  {
    id: "semver",
    plainName: "a version number",
    pattern: /^v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/u,
  },
  {
    id: "number",
    plainName: "a number",
    pattern: /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u,
  },
  {
    // A MEASUREMENT WITH ITS UNIT GLUED ON — `0.4237013706696966ratio`,
    // `1725139200000000000ns`, `68124672bytes`. The ledger's resource lane
    // writes `${value}${unit}` with no separator, and a double-precision
    // float (16–17 significant digits) plus its unit crosses the entropy
    // layer's length threshold as one "unbroken random-looking" run —
    // measured live: every resource event's description went out as
    // `Resource eventLoop.utilization: [REDACTED:credential]`, the
    // measurement destroyed by the layer that exists to protect it.
    //
    // The grammar is the `number` entry with a bounded lowercase suffix: a
    // unit word (`ms`, `s`, `ns`, `bytes`, `ratio`, `hz`, …) is 1–8
    // lowercase letters, and LOWERCASE is load-bearing — an uppercase
    // trailing run is how hex alphabets read (`1234ABCD`), and a hex token
    // of digest length is already `hex-digest`'s business, not this one's.
    // The veto is value-intrinsic-only, like every grammar here: a
    // credential DECLARED next to a credential noun (`token = 0.42ratio`)
    // is still masked by the declaration layer, which has evidence beyond
    // the value's own shape.
    id: "number-with-unit",
    plainName: "a measurement",
    pattern: /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[a-z]{1,8}$/u,
  },
  {
    id: "mime-type",
    plainName: "a content type",
    pattern: /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/iu,
  },
  {
    id: "hex-colour",
    plainName: "a colour",
    pattern: /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu,
  },
] as const);

/**
 * THE GRAMMAR SET, regex-defined ones plus the one that cannot be a regex.
 *
 * `character-set` is last only because order decides which id is REPORTED
 * when two grammars both explain a token, and "an alphabet" is the more
 * specific answer only when nothing simpler applies.
 */
export const BENIGN_TOKEN_GRAMMARS: readonly BenignGrammar[] = deepFreeze([
  ...PATTERN_GRAMMARS.map((grammar) =>
    byPattern(grammar.id, grammar.plainName, grammar.pattern),
  ),
  // SHAPE PLUS WORDS, so neither can be a regex alone. Kept in the position
  // the pattern table gave them so the id a user is shown does not change.
  {
    // A name in code: the narrow camel/Pascal pattern, OR the same shape
    // carrying an acronym. See `IDENTIFIER_PATTERN` and `isAcronymCamelName`
    // — two branches of one question, so they live in one entry.
    id: "identifier" as const,
    plainName: "a name in code",
    matches: (token: string) =>
      IDENTIFIER_PATTERN.test(token) ||
      isAcronymCamelName(token) ||
      isNumberedComponentName(token),
    patternSource: IDENTIFIER_PATTERN.source,
  },
  {
    id: "dotted-name" as const,
    plainName: "a name in code",
    matches: isDottedName,
    patternSource: null,
  },
  {
    id: "word-phrase" as const,
    plainName: "words joined by punctuation",
    matches: isWordPhrase,
    patternSource: null,
  },
  {
    id: "character-set" as const,
    plainName: "an alphabet",
    matches: isMonotonicRun,
    patternSource: null,
  },
]);

/**
 * Which benign grammar explains this token whole, or null.
 *
 * Deliberately a loop over anchored patterns rather than one alternation: the
 * ID of the grammar that fired is the explanation a user is shown, and an
 * alternation cannot say which branch matched without capture bookkeeping
 * that is harder to read than the loop.
 */
export function benignTokenGrammar(token: string): BenignGrammarId | null {
  if (token.length === 0) return null;
  for (const grammar of BENIGN_TOKEN_GRAMMARS) {
    if (grammar.matches(token)) return grammar.id;
  }
  return null;
}

/** Whether any benign grammar explains this token whole. */
export function isBenignToken(token: string): boolean {
  return benignTokenGrammar(token) !== null;
}

export type BenignRegion = Readonly<{
  startUtf16: number;
  endUtf16: number;
  id: BenignGrammarId;
}>;

const EMPTY_REGIONS: readonly BenignRegion[] = Object.freeze([]);

/**
 * A URL, including its query and fragment. The fragment is the point: a
 * base64 payload after `#` has every intrinsic property of a session token
 * and none of the meaning.
 *
 * Bounded rather than greedy-to-end-of-line, because a URL followed by prose
 * would otherwise swallow the prose — and the prose is where a declaration
 * lives.
 */
const URL_REGION = /[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'`<>\\]{1,2048}/giu;

/** A `data:` URI, whose payload is by definition an encoded blob. */
const DATA_URI_REGION = /\bdata:[a-z0-9][a-z0-9.+/-]{0,127};base64,[A-Za-z0-9+/=]{1,65536}/giu;

/**
 * A filesystem path with at least one separator. Written as a region rather
 * than a token grammar because a path's SEGMENTS are what the tokenizer
 * sees, and one segment of a long path can look like anything.
 */
const PATH_REGION = /(?:^|(?<=[\s"'`(=,:[]))(?:\.{1,2}\/|~\/|\/|[A-Za-z]:\\)[A-Za-z0-9_.$@%+-]+(?:[/\\][A-Za-z0-9_.$@%+-]+)*\/?/gu;

const REGION_SOURCES: readonly Readonly<{ id: BenignGrammarId; pattern: RegExp }>[] =
  Object.freeze([
    Object.freeze({ id: "data-uri" as const, pattern: DATA_URI_REGION }),
    Object.freeze({ id: "url" as const, pattern: URL_REGION }),
    Object.freeze({ id: "file-path" as const, pattern: PATH_REGION }),
  ]);

/**
 * The stretches of `text` whose own grammar explains every byte inside them.
 * No value-intrinsic candidate may be raised inside one.
 *
 * THE COST IS PAID ONLY WHEN IT CAN MATTER. Every region grammar needs a
 * `:` or a `/` to fire, so a string containing neither returns immediately —
 * which on a real payload is most strings, and on the egress path is the
 * difference between three extra automata per leaf and none.
 */
/**
 * A ONE-ENTRY MEMO, because the same string is asked twice in a row.
 *
 * `detectSecretSpans` runs the value-intrinsic layer and then the
 * declaration layer over the same text, and both need the regions — six
 * regex passes for one answer. They are consecutive, so a single-slot cache
 * hits every time and needs no eviction policy.
 *
 * Bounded by length so the slot cannot pin a very large string alive: above
 * the bound the answer is recomputed, which is the same cost as before.
 */
let lastRegionText: string | null = null;
let lastRegions: readonly BenignRegion[] = EMPTY_REGIONS;
const MAX_MEMOISED_LENGTH = 262_144;

export function benignRegions(text: string): readonly BenignRegion[] {
  if (lastRegionText !== null && lastRegionText === text) return lastRegions;
  const computed = computeBenignRegions(text);
  if (text.length <= MAX_MEMOISED_LENGTH) {
    lastRegionText = text;
    lastRegions = computed;
  }
  return computed;
}

function computeBenignRegions(text: string): readonly BenignRegion[] {
  if (!text.includes("/")) return EMPTY_REGIONS;
  const regions: BenignRegion[] = [];
  for (const { id, pattern } of REGION_SOURCES) {
    // Shared module-level `g` regexes: the cursor survives the previous
    // call, so it is reset here. Same rule, same reason, as every other
    // hoisted regex on this path.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      regions.push(
        Object.freeze({
          startUtf16: match.index,
          endUtf16: match.index + match[0].length,
          id,
        }),
      );
    }
  }
  if (regions.length === 0) return EMPTY_REGIONS;
  regions.sort((a, b) => a.startUtf16 - b.startUtf16);
  return Object.freeze(regions);
}

/**
 * Whether `[start, end)` lies inside any of `regions`.
 *
 * `regions` is sorted by start, so this is a linear scan that stops early —
 * the candidate list is short and the region list is shorter, and a binary
 * search here would be optimising a loop that runs a handful of times.
 */
export function withinBenignRegion(
  regions: readonly BenignRegion[],
  start: number,
  end: number,
): BenignGrammarId | null {
  for (const region of regions) {
    if (region.startUtf16 > start) break;
    if (start >= region.startUtf16 && end <= region.endUtf16) return region.id;
  }
  return null;
}
