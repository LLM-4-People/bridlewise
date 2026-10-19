import type { HeldSet } from "./held-set.ts";
import { InputError } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import {
  SECRET_TEXT_SIGNAL_CATALOG,
  type SecretSignalProfile,
} from "./secret-signals.ts";
import {
  createUtf8OffsetMap,
  utf8ByteLengthFromMap,
  utf8ByteOffsetFromMap,
} from "../text/utf8-offsets.ts";
import {
  redactionReplacement,
  secretTextSignal,
  DEFAULT_PRIVACY_POLICY,
  type PrivacyPolicy,
  type RedactionCategory,
} from "./privacy-policy.ts";
import {
  declaredSecretSpans,
  knownSecretSpans,
  rememberableDeclaredValue,
} from "./secret-intelligence.ts";
import type { IntelligenceSpan, SecretConfidence } from "./detection-span.ts";
import { identitySpans } from "./identity-grammars.ts";
import { entropySecretSpans } from "./value-intrinsic.ts";
import { normalizeForDetection } from "./text-normalize.ts";
import { learnCredentialContext, lexiconForScope } from "./credential-lexicon.ts";
import {
  countDetection,
  currentPrivacySettings,
  enabledDetectorIds,
  piiTypeCategory,
  tierEnabled,
  type PrivacySettings,
} from "./pii-registry.ts";

/**
 * Central redaction engine — detects sensitive spans in text and replaces
 * only the detected value while preserving surrounding structure.
 *
 * This engine is the shared mechanism that file viewing, evidence handling,
 * logging, metrics, and memory all use. It does NOT implement a second
 * detector; it consumes the existing `secret-signals.ts` catalog and the
 * privacy policy's PII classification rules.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 *
 * Binding authorities:
 * USR-055 / DER-041: "keep raw bytes exclusively inside the trusted
 * safe-read/redaction gateway; for authorized supported text, minimally
 * redact detected credential values before all egress while preserving
 * safe names, syntax/structure, line count, useful context and
 * non-recoverable stable source/span mapping."
 * Root policy `authorizedTextRedaction.replacement`:
 * "minimum-detected-credential-value-or-irreducibly-sensitive-segment-before-egress"
 * Root policy `authorizedTextRedaction.preserve`:
 * safe-variable-constant-and-property-names, delimiters-indentation-and-syntax-structure,
 * line-count-and-source-identity, useful-bounded-surrounding-context,
 * non-recoverable-original-to-redacted-line-and-span-map
 */

export type RedactableSpan = Readonly<{
  startUtf16: number;
  endUtf16: number;
  startByte: number;
  endByte: number;
  category: RedactionCategory;
  signalId: string;
  reason: string;
  detectorId: string;
}>;

export type RedactionResult = Readonly<{
  redactedText: string;
  spans: readonly RedactableSpan[];
  spanCount: number;
  redactionMapHash: string;
  originalByteLength: number;
  redactedByteLength: number;
  profile: SecretSignalProfile;
}>;

export type DetectionOptions = Readonly<{
  profile?: SecretSignalProfile;
  /**
   * CREDENTIALS THE USER DECLARED EARLIER IN THIS CONVERSATION, promoted to
   * identity evidence for this call only.
   *
   * Supplied per call and never stored anywhere: see
   * `redactMessagesTogether`, which derives them from the very messages it is
   * about to redact and drops them when it returns. They exist so that a
   * value judged a credential ONCE — "my password may be admin44" — is
   * thereafter matched by byte equality rather than re-judged by heuristic,
   * in any later message, in any escaping, including a reply that repeats it.
   */
  declaredValues?: readonly string[];
  /** Intentional operation credentials (the operation's typed held set): exact ephemeral identity, including short values. */
  heldCredentials?: HeldSet;
  /**
   * WHICH TIERS AND TYPES ARE ON. Defaults to `DEFAULT_PRIVACY_SETTINGS`,
   * whose values come from the one config owner. Passed rather than read
   * from a module global so a caller can redact one payload under one
   * policy and another under another, and so a test can switch a tier off
   * without touching process state.
   */
  settings?: PrivacySettings;
  /**
   * The scope whose LEARNED credential vocabulary applies — one user, one
   * session. Omitted means the seeded vocabulary alone, which is what every
   * path that has no identity should pass.
   */
  learningScope?: string;
}>;

const DEFAULT_PROFILE: SecretSignalProfile = "admission";

/**
 * THE CATALOG'S REGEXES, COMPILED ONCE PER PROFILE.
 *
 * `detectSensitiveSpans` used to call `new RegExp(source, flags)` for every
 * signal on every string it was handed. That is six compilations per string,
 * and the egress choke point hands it every string leaf of every response —
 * measured at 6.6–77× the cost of the `JSON.stringify` it precedes
 * (DESIGN-PERFORMANCE §5).
 *
 * Compiling here changes NOTHING about what matches: the same source and the
 * same flags produce the same automaton, and a compiled regex is immutable
 * apart from `lastIndex`, which the scanner resets before every use (see
 * `detectSensitiveSpans`). A shared `g` regex whose `lastIndex` survived a
 * previous call would start mid-string and miss a secret before that point —
 * which is why the reset is a line of the algorithm and not housekeeping.
 *
 * ── WHY THIS IS MEMOISED AND NOT BUILT AT MODULE SCOPE ────────────────────
 *
 * It used to be a module-scope `const`, on the stated grounds that "a lazy
 * cache is one more thing that can be wrong about a security control". That
 * reasoning was sound about caches and wrong about this one, because it costed
 * the wrong risk: reading `SECRET_TEXT_SIGNAL_CATALOG` during MODULE EVALUATION
 * makes this file's import order load-bearing, and `secret-signals.ts` sits in
 * an import cycle with it through `errors.ts` ↔ `debug-system.ts`. Whichever of
 * the two evaluates second throws
 * `ReferenceError: Cannot access 'SECRET_TEXT_SIGNAL_CATALOG' before
 * initialization` — a TDZ break, at module load, in the detector every egress
 * path depends on.
 *
 * MEASURED, by importing each module under `src/` as an ESM entry point in its
 * own process (`node --experimental-strip-types -e "import(<abs>).then(…).catch(…)"`,
 * rc 0, unit: MODULES, population 514 — not the 515 an earlier draft of this
 * note claimed): with the eager `const`, adding one import of this file to
 * `debug-system.ts` took the count of modules whose LOAD THREW from 1 to 9.
 *
 * ⚠ THE FIGURE THAT USED TO BE HERE WAS WRONG, AND IT WAS WRONG BY A UNIT
 * SWITCH. This note read "with the memo below it returns to 1". RE-DRIVEN with
 * the memo in place and the same import re-added: it is **8**. The memo
 * restores exactly ONE module (`secret-signals.ts`), 9 → 8. The **7** that
 * appears in the commit message and in `TASKS.md` is the count of NEW breaks —
 * 8 minus the one that was already there — so a single sentence moved from a
 * TOTAL to a DELTA without saying so, and three records disagreed as a result.
 * TOTAL: 8. NEW: 7. RESTORED BY THIS MEMO: 1.
 *
 * ⚠ AND THE SENTENCE THAT FOLLOWED IT WAS WORSE. The one remaining break was
 * called "a pre-existing break in `debug-config.ts` that has nothing to do with
 * this module". It was the IDENTICAL DEFECT CLASS — a module-scope read of an
 * imported binding inside a cycle — and it was caused by `debug-system.ts`'s
 * `NO_OP_SYSTEM`, in the very file the wiring was being added to. It is fixed
 * (see `unconfiguredSystem` there), and the count at HEAD with no wiring is now
 * **0 of 514**, from 1. A defect is not unrelated because it is in a different
 * file; this one was the same sentence in a different module.
 *
 * ⚠ THE PREDICATE MATTERS. All eight of those children EXIT 0 when the import
 * is awaited with a `catch`, so a sweep keyed on `exit != 0` reports zero of
 * them. That is not an academic hole: deferring module-scope work — this memo,
 * and `debug-system.ts`'s lazy singleton — moves a failure from load time to
 * first call, which is precisely what an exit-code predicate cannot see. The
 * standing guard for the two subtrees
 * (`test/shared/debug/module-load-order.test.ts`) reads a printed marker
 * instead, and plants a TDZ break in the same run to prove it can see one.
 *
 * The memo cannot drift the way the old comment feared: it is a pure function
 * of a frozen module constant, it has no invalidation path, and both profiles
 * are still compiled exactly once. A lazy cache that can never be stale is not
 * a cache that can be wrong; a module-scope const that can never be reached is.
 */
/** One compiled catalog signal: its id, its category (carried, never looked up per match) and its pattern. */
type CompiledSignal = Readonly<{ id: string; category: RedactionCategory; regex: RegExp }>;

let compiledSignals: Readonly<
  Record<SecretSignalProfile, readonly CompiledSignal[]>
> | undefined;

function compiledSignalsFor(profile: SecretSignalProfile): readonly CompiledSignal[] {
  compiledSignals ??= Object.freeze({
    admission: compileProfile("admission"),
    classification: compileProfile("classification"),
  });
  return compiledSignals[profile];
}

function compileProfile(
  profile: SecretSignalProfile,
): readonly CompiledSignal[] {
  return SECRET_TEXT_SIGNAL_CATALOG.map((signal) => {
    const source = signal[profile];
    const flags = source.flags.includes("g") ? source.flags : source.flags + "g";
    return Object.freeze({ id: signal.id, category: signal.category, regex: new RegExp(source.source, flags) });
  });
}

/**
 * Detect all sensitive spans in the given text using the secret-signals
 * catalog and the privacy policy's PII classification rules.
 *
 * Returns spans sorted by start position, with overlaps resolved by
 * longest-match preference. Each span carries UTF-16 code-unit offsets,
 * UTF-8 byte offsets, the detection category, signal id, and detector id.
 */
function collectSensitiveSpans(
  text: string,
  policy: PrivacyPolicy,
  options: DetectionOptions = {},
): readonly RedactableSpan[] {
  if (typeof text !== "string") {
    throw new InputError("detectSensitiveSpans: text must be a string", "redaction_text_not_string");
  }
  const profile = options.profile ?? DEFAULT_PROFILE;
  // ── THE OFFSET MAP IS BUILT ONLY IF A SPAN NEEDS ONE ────────────────────
  //
  // It used to be built unconditionally, first thing: a `Uint32Array` of
  // `text.length + 1` entries filled by walking every code unit — for EVERY
  // string, including the overwhelming majority that contain no secret at
  // all. On a 75MB response that is tens of millions of allocated words to
  // answer "no".
  //
  // The map is read in exactly one place: converting a DETECTED span's
  // UTF-16 offsets to UTF-8 byte offsets. So it is built on the first span
  // and never otherwise, and a string with no secrets pays nothing.
  //
  // This is a behaviour-preserving change and that is checkable rather than
  // asserted: `createUtf8OffsetMap` throws only when `source` is not a
  // string — which this function has already rejected above — and marks
  // lone/split surrogates with a sentinel instead of throwing. There is no
  // input for which building it eagerly failed and building it lazily does
  // not.
  let map: ReturnType<typeof createUtf8OffsetMap> | null = null;
  const spans: RedactableSpan[] = [];

  for (const signal of compiledSignalsFor(profile)) {
    const regex = signal.regex;
    // The regex is SHARED across calls, so its cursor is not. A `lastIndex`
    // left behind by the previous string would start this scan in the middle
    // of this one and miss every secret before that point.
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        if (regex.lastIndex === 0) break;
        regex.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      const { category } = signal;
      if (!policy.enabledCategories.has(category)) continue;
      const offsets = (map ??= createUtf8OffsetMap(text));
      bestEffort(() => {
        const startByte = utf8ByteOffsetFromMap(offsets, start);
        const endByte = utf8ByteOffsetFromMap(offsets, end);
        spans.push({
          startUtf16: start,
          endUtf16: end,
          startByte,
          endByte,
          category,
          signalId: signal.id,
          reason: `detected:${signal.id}`,
          detectorId: "secret-signals",
        });
      });
    }
  }

  return spans;
}
export function detectSensitiveSpans(text: string, policy: PrivacyPolicy, options: DetectionOptions = {}): readonly RedactableSpan[] {
  return resolveOverlaps(collectSensitiveSpans(text, policy, options));
}

// ── THE COMPOSED DETECTOR ────────────────────────────────────────────────

/**
 * A span that carries WHY it is believed, not only that it is. See
 * `SecretConfidence`: a proven identity match and an inferred declaration
 * match are different claims and a surface that presents them identically is
 * lying by omission.
 *
 * Structurally a superset of `RedactableSpan`, so every existing consumer
 * (`applyRedactions`, the overlap resolver, the audit metadata) takes one
 * without change.
 */
export type ExplainedSpan = RedactableSpan & Readonly<{
  confidence: SecretConfidence;
  explanation: string;
}>;

/** The category an intelligence layer's finding is redacted under. */

/**
 * ONE SPAN, BEFORE ITS BYTE OFFSETS ARE COMPUTED.
 *
 * Every layer produces UTF-16 offsets; only the final result needs UTF-8
 * ones. Collecting first and converting once is what makes it affordable to
 * run the layers TWICE — over the text as written and over its normalised
 * form — because the offset map, which is the expensive part, is built once
 * for the original and never for the normalised copy.
 */
type PendingSpan = Readonly<{
  startUtf16: number;
  endUtf16: number;
  category: RedactionCategory;
  signalId: string;
  detectorId: string;
  confidence: SecretConfidence;
  explanation: string;
}>;

/**
 * EVERY LAYER OVER ONE STRING, gated by the tier switches.
 *
 * The gate is the ONLY route from a setting to a scan: a tier that is off
 * means its layer is not called, and a layer with no declared type in the
 * registry cannot be switched on at all. There is no second place where a
 * detector can be reached.
 */
function collectLayerSpans(
  text: string,
  policy: PrivacyPolicy,
  options: DetectionOptions,
  settings: PrivacySettings,
  preserveCandidates = false,
): PendingSpan[] {
  const out: PendingSpan[] = [];
  const detectors = enabledDetectorIds(settings);

  // LAYER 2, the published-format catalog. Called through the unchanged
  // `detectSensitiveSpans` so the equivalence guard that froze its behaviour
  // keeps holding.
  if (detectors.has("secret-signals")) {
    for (const span of (preserveCandidates ? collectSensitiveSpans(text, policy, options) : detectSensitiveSpans(text, policy, options))) {
      out.push({
        startUtf16: span.startUtf16,
        endUtf16: span.endUtf16,
        category: span.category,
        signalId: span.signalId,
        detectorId: span.detectorId,
        confidence: "format",
        explanation: `matches the published format of a ${describeSignal(span.signalId)}`,
      });
    }
  }

  // LAYERS 1 AND 2, the values that prove themselves and the values with one
  // grammar. Each detector id is gated individually, because these are the
  // types a user most often wants some of and not others.
  const intelligence: IntelligenceSpan[] = [];
  if (detectors.size > 0) intelligence.push(...identitySpans(text, detectors));

  // LAYER 3, identity against credentials this process holds.
  if (tierEnabled("known-values", settings)) {
    intelligence.push(...knownSecretSpans(text, options.declaredValues ?? [], options.heldCredentials === undefined ? undefined : { values: options.heldCredentials.matched(), minimumLength: options.heldCredentials.minimumLength }));
  }

  // LAYER 4, entropy minus the benign enumeration.
  if (tierEnabled("value-intrinsic", settings)) {
    intelligence.push(...entropySecretSpans(text));
  }

  // LAYER 5, a value introduced by words that name a credential — the only
  // layer that needs vocabulary, and the only one that can find a secret
  // with no intrinsic signal at all.
  if (tierEnabled("declared-values", settings)) {
    intelligence.push(
      // The RESOLVED policy, not the default: the layer has to recognise the
      // marker this policy writes, or it reads the engine's own mask as a
      // declared credential and every redaction self-reports as incomplete.
      ...declaredSecretSpans(text, undefined, lexiconForScope(options.learningScope ?? ""), policy),
    );
  }

  for (const span of intelligence) {
    const category = piiTypeCategory(span.signalId);
    if (!policy.enabledCategories.has(category)) continue;
    out.push({
      startUtf16: span.startUtf16,
      endUtf16: span.endUtf16,
      category,
      signalId: span.signalId,
      detectorId: span.detectorId,
      confidence: span.confidence,
      explanation: span.explanation,
    });
  }
  return out;
}

/**
 * ALL FOUR LAYERS, unioned — the detector every LLM-bound and user-bound
 * surface uses.
 *
 * UNION, NOT FIRST-MATCH. The layers are not ranked alternatives and no layer
 * short-circuits another: a string is scanned by all four and the findings are
 * merged. The reason is a leak this codebase has already had once, in the
 * egress choke point, where "prefer the result that found something" meant one
 * visible secret suppressed a whole pass and hid every escaped secret beside
 * it. A union has no such shape — adding evidence can only ever add spans.
 *
 * `detectSensitiveSpans` (layer 4, the format catalog) is called UNCHANGED and
 * its output is not filtered, so this function masks a superset of what it
 * masked, always. That is a property worth stating because it is the one a
 * security change has to prove.
 *
 * Ordering within the result is by position, with overlaps resolved
 * longest-first by `resolveOverlaps` — so where two layers see the same
 * secret, the one that saw MORE of it wins.
 */
function collectSecretSpans(
  text: string,
  policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
  options: DetectionOptions = {},
  preserveCandidates = false,
): readonly ExplainedSpan[] {
  if (typeof text !== "string") {
    throw new InputError("detectSecretSpans: text must be a string", "redaction_text_not_string");
  }
  // The settings IN FORCE, unless the caller named its own. Read once per
  // call and held, so both passes below judge under one policy — reading it
  // twice would let a switch flipped mid-call produce a result that was
  // never any policy's answer.
  const settings = options.settings ?? currentPrivacySettings();
  const pending = collectLayerSpans(text, policy, options, settings, preserveCandidates);

  // ── AND AGAIN, OVER THE NORMALISED TEXT ─────────────────────────────────
  //
  // A zero-width space inside a credential defeats byte matching entirely,
  // and so do full-width forms and a single Cyrillic homoglyph. The
  // normalised copy is scanned as well and its findings are mapped back to
  // where they live in the REAL text, because the real text is what gets
  // masked.
  //
  // A UNION, never a replacement. Scanning only the normalised form would
  // trade one class of miss for another — normalisation collapses distinct
  // characters, so a value that is only detectable as written would be lost.
  // Adding the second pass can therefore only ever mask more, which is the
  // same monotonicity the whole engine is built on.
  //
  // It costs nothing on ordinary text: `normalizeForDetection` returns the
  // original unchanged after one scan when there is nothing to normalise,
  // which is every ASCII string.
  const normalized = normalizeForDetection(text);
  if (normalized.changed) {
    for (const span of collectLayerSpans(normalized.text, policy, options, settings, preserveCandidates)) {
      pending.push({
        ...span,
        startUtf16: normalized.toOriginal(span.startUtf16),
        endUtf16: normalized.toOriginal(span.endUtf16),
      });
    }
  }

  if (pending.length === 0) return EMPTY_EXPLAINED;
  // The offset map is built only if some layer found something — the same
  // lazy discipline `detectSensitiveSpans` applies, for the same reason: the
  // overwhelming majority of strings find nothing.
  const offsets = createUtf8OffsetMap(text);
  const out: ExplainedSpan[] = [];
  for (const span of pending) {
    bestEffort(() => {
      countDetection(span.confidence);
      out.push({
        startUtf16: span.startUtf16,
        endUtf16: span.endUtf16,
        startByte: utf8ByteOffsetFromMap(offsets, span.startUtf16),
        endByte: utf8ByteOffsetFromMap(offsets, span.endUtf16),
        category: span.category,
        signalId: span.signalId,
        reason: `detected:${span.signalId}`,
        detectorId: span.detectorId,
        confidence: span.confidence,
        explanation: span.explanation,
      });
    });
  }
  return out;
}
export function detectSecretSpans(text: string, policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY, options: DetectionOptions = {}): readonly ExplainedSpan[] {
  return resolveOverlaps(collectSecretSpans(text, policy, options)) as readonly ExplainedSpan[];
}

/** Exact protocol identities carry their own structural meaning; randomness alone is not secret evidence.
 * This suppresses only the intrinsic entropy layer before overlap resolution. Known/declarative
 * credentials and every configured format/PII detector still run, including normalized text.
 */
export function detectProtocolIdentitySensitiveSpans(text: string, policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
  options: DetectionOptions = {}): readonly ExplainedSpan[] {
  const settings = options.settings ?? currentPrivacySettings();
  return detectSecretSpans(text, policy, { ...options, settings: { ...settings,
    tiers: { ...settings.tiers, "value-intrinsic": false } } });
}

const EMPTY_EXPLAINED: readonly ExplainedSpan[] = Object.freeze([]);

/** A human name for a catalog signal, for the explanation string. Never the
 * matched value — only what KIND of thing matched. */
function describeSignal(signalId: string): string {
  return secretTextSignal(signalId).description;
}

/**
 * REDACT A SET OF MESSAGES AS ONE BODY OF TEXT, so a credential declared in
 * any of them is masked in ALL of them.
 *
 * THE CASE THIS EXISTS FOR, reported live: a user writes "my password may be
 * admin44" and, three messages later, "what is my password". Redacting each
 * message in isolation masks the first and lets the value through wherever it
 * appears without a declaration beside it — including in a reply that repeats
 * it back. The declaration happened once; the value is a secret from then on.
 *
 * TWO PASSES, and the second is the whole point:
 *   1. Detect declarations across every message and collect the VALUES that
 *      were masked, keeping only those specific enough to be safe to match by
 *      equality (`rememberableDeclaredValue`).
 *   2. Redact every message again with those values as identity evidence —
 *      exact and escaped, the same normalisation a configured credential gets.
 *
 * WHY THIS AND NOT A SESSION REGISTRY. A registry that outlived the call would
 * have to be scoped to a user and a conversation, torn down on logout and on
 * chat switch, and kept out of the database, the ledger and every log — five
 * separate ways to leak one value, and on a multi-user server a sixth, where
 * one user's declared password starts masking another user's prose. Deriving
 * the set from the messages in front of you has none of those failure modes,
 * because there is nothing to tear down: `learned` belongs to this result's
 * redaction operation. Its `redact` function lets a structured caller apply
 * the same evidence to parsed string leaves within the turn, without learning
 * the transcript again or registering values globally. The conversation
 * history is re-sent every turn, so the
 * declaring message is present in every later call anyway — the persistence
 * comes free, from the transcript, without a store.
 *
 * NOTHING IS WRITTEN. This redacts what LEAVES; it does not touch what is
 * stored. The conversation and the ledger keep the real content, because they
 * are the user's own record on their own machine.
 */
export function redactMessagesTogether(
  texts: readonly string[],
  policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
  options: DetectionOptions = {},
): Readonly<{ redacted: readonly string[]; explanations: readonly (readonly RedactionExplanation[])[]; learnedCount: number; redact: (text: string) => string; detectProtocolIdentity: (text: string) => readonly ExplainedSpan[] }> {
  // PASS 1 — what did anyone declare?
  const learned: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (typeof text !== "string" || text.length === 0) continue;
    const spans = detectSecretSpans(text, policy, options);
    for (const span of spans) {
      if (span.signalId !== "declared-credential") continue;
      const value = text.slice(span.startUtf16, span.endUtf16);
      if (seen.has(value) || !rememberableDeclaredValue(value)) continue;
      seen.add(value);
      learned.push(value);
    }
    // ── THE VOCABULARY LEARNS HERE, AND ONLY FROM PROOF ─────────────────
    //
    // The words around a span that layers 1 to 4 found — a checksum, an
    // identity match, a published format, an unexplained random run. None of
    // those needed a word to be found, so the words beside them are evidence
    // ABOUT vocabulary rather than a product of it.
    //
    // Deliberately never from a layer-5 span. Learning a word from a
    // declaration and then declaring from the learned word is a loop with a
    // fixed point at "everything is a secret", and it would take exactly two
    // turns to get there.
    if (options.learningScope !== undefined && options.learningScope.length > 0) {
      learnFromProvenSpans(options.learningScope, text, spans);
    }
  }
  // PASS 2 — redact everything knowing what pass 1 found. When pass 1 found
  // nothing, this is exactly the single-pass behaviour and costs one extra
  // scan of a set of messages that contained no declaration.
  const withLearned: DetectionOptions = learned.length === 0
    ? options
    : { ...options, declaredValues: [...(options.declaredValues ?? []), ...learned] };
  const redact = (text: string): string =>
    typeof text === "string" && text.length > 0 ? redactForLLMContext(text, policy, withLearned) : text;
  const projected = texts.map(text => redactContextText(text, policy, withLearned));
  return deepFreeze({
    redacted: projected.map(item => item.text),
    explanations: projected.map(item => item.explanations),
    learnedCount: learned.length,
    redact,
    detectProtocolIdentity: (text: string) => detectProtocolIdentitySensitiveSpans(text, policy, withLearned),
  });
}

/**
 * THE WORDS IMMEDIATELY BEFORE A PROVEN SECRET, taught to this scope.
 *
 * Bounded by `LEARNING_LOOKBACK` characters rather than by a word count, so
 * the amount of text read is the same whatever it contains, and only the
 * words BEFORE the span are considered — a credential's introduction
 * precedes it in every language whose word order this could depend on, and
 * looking after it would pick up whatever sentence came next.
 *
 * Layer-5 spans are excluded at the call site; the confidence check here is
 * the second lock on the same door, because the two are separated by enough
 * code that one of them could be edited without the other.
 */
function learnFromProvenSpans(
  scope: string,
  text: string,
  spans: readonly ExplainedSpan[],
): void {
  const words: string[] = [];
  for (const span of spans) {
    if (span.confidence === "inferred" && span.signalId === "declared-credential") continue;
    const from = Math.max(0, span.startUtf16 - LEARNING_LOOKBACK);
    const before = text.slice(from, span.startUtf16);
    for (const word of before.split(/[^\p{L}\p{M}]+/u)) {
      if (word.length > 0) words.push(word);
    }
  }
  if (words.length > 0) learnCredentialContext(scope, words);
}

/** How far back from a proven secret its introduction can be. Roughly a
 * clause: far enough for "the staging database password for the api is",
 * short enough that a previous sentence cannot reach it. */
const LEARNING_LOOKBACK = 64;

/**
 * WHAT WAS MASKED AND WHY, with no way to recover what was masked.
 *
 * This is the accessor a surface uses to tell the user "three values were
 * hidden before this was sent, here is why each one" — the requirement that
 * a redaction be explainable, and that the model's input never changes
 * silently. It reports the position, the length, the category and the
 * confidence, and it deliberately reports NO substring of the original: a
 * "preview" of a masked secret is the secret.
 */
export type RedactionExplanation = Readonly<{
  startUtf16: number;
  endUtf16: number;
  maskedLength: number;
  category: RedactionCategory;
  confidence: SecretConfidence;
  /**
   * WHICH DECLARED PII TYPE this was, so a surface can join it back to the
   * registry — to the tier it belongs to, the switch that turns it off, and
   * the sentence stating what that type does not catch. It is an id, not a
   * value; nothing about the masked content is recoverable from it.
   */
  signalId: string;
  explanation: string;
}>;

function explainSpan(span: ExplainedSpan): RedactionExplanation {
  return { startUtf16: span.startUtf16, endUtf16: span.endUtf16, maskedLength: span.endUtf16 - span.startUtf16,
    category: span.category, confidence: span.confidence, signalId: span.signalId, explanation: span.explanation };
}

export function explainRedaction(
  text: string,
  policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
  options: DetectionOptions = {},
): readonly RedactionExplanation[] {
  return deepFreeze(
    detectSecretSpans(text, policy, options).map(explainSpan),
  );
}

/**
 * Resolve overlapping spans by preferring the longest match. When two spans
 * overlap, the longer one wins; if equal length, the earlier start wins.
 * This implements the "longest-match policy" required by the secret-span
 * qualification foundation.
 */
export function resolveOverlaps(spans: readonly RedactableSpan[]): readonly RedactableSpan[] {
  if (spans.length <= 1) return spans;
  const sorted = [...spans].sort((a, b) => {
    if (a.startUtf16 !== b.startUtf16) return a.startUtf16 - b.startUtf16;
    return b.endUtf16 - a.endUtf16;
  });
  const resolved: RedactableSpan[] = [];
  for (const span of sorted) {
    const last = resolved[resolved.length - 1];
    if (last !== undefined && span.startUtf16 < last.endUtf16) {
      const lastLen = last.endUtf16 - last.startUtf16;
      const thisLen = span.endUtf16 - span.startUtf16;
      if (thisLen > lastLen) {
        resolved[resolved.length - 1] = span;
      }
      continue;
    }
    resolved.push(span);
  }
  return deepFreeze(resolved);
}

/**
 * Is this line nothing but one of the engine's own replacement markers?
 *
 * Read from the RESOLVED policy, not from the built-in marker. The collapse
 * pass used to test `/^\s*\[REDACTED:[^\]]*\]\s*$/`, which is the built-in
 * format written out as a literal — so with any configured `redactionPrefix`
 * the engine stopped recognising its own output and the `preserveStructure:
 * false` path collapsed nothing. That is the same producer/consumer split that
 * made the marker recogniser read a configured mask as a residual secret, one
 * call site over.
 *
 * A marker line is `prefix + category + suffix` and a category is a single
 * token, so the core must be non-empty and whitespace-free. That test also
 * survives an empty suffix, where `endsWith("")` would otherwise be true of
 * every line with a marker anywhere on it.
 */
function isPureRedactionLine(line: string, policy: PrivacyPolicy): boolean {
  const trimmed = line.trim();
  const prefix = policy.redactionPrefix;
  const suffix = policy.redactionSuffix;
  if (trimmed.length < prefix.length + suffix.length) return false;
  if (!trimmed.startsWith(prefix)) return false;
  if (suffix.length > 0 && !trimmed.endsWith(suffix)) return false;
  const core = trimmed.slice(prefix.length, trimmed.length - suffix.length);
  if (core.length === 0 || /\s/u.test(core)) return false;
  return suffix.length === 0 || !core.includes(suffix);
}

/**
 * Apply redaction spans to text, replacing each sensitive span with the
 * policy's replacement string. The surrounding structure (delimiters,
 * quotes, whitespace, line count) is preserved.
 */
export function applyRedactions(
  text: string,
  spans: readonly RedactableSpan[],
  policy: PrivacyPolicy,
): string {
  if (typeof text !== "string") {
    throw new InputError("applyRedactions: text must be a string", "redaction_text_not_string");
  }
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.startUtf16 - b.startUtf16);
  const parts: string[] = [];
  let cursor = 0;
  for (const span of sorted) {
    if (span.startUtf16 < cursor) continue;
    parts.push(text.slice(cursor, span.startUtf16));
    const replacement = redactionReplacement(span.category, policy);
    // `preserveLineCount`: when true, pad the replacement to the same line count as the
    // original span (keeps line numbers stable). When false, use the bare replacement.
    if (policy.preserveLineCount) {
      const originalSegment = text.slice(span.startUtf16, span.endUtf16);
      const originalLineCount = originalSegment.split("\n").length;
      if (originalLineCount > 1) {
        parts.push(replacement + "\n".repeat(originalLineCount - 1));
      } else {
        parts.push(replacement);
      }
    } else {
      parts.push(replacement);
    }
    cursor = span.endUtf16;
  }
  parts.push(text.slice(cursor));
  let result = parts.join("");
  // `preserveStructure`: when false, collapse runs of pure redaction markers
  // (lines containing only `[REDACTED:...]`) into a single representative line.
  // When true (default), the structural context (indentation, surrounding lines,
  // delimiters) is preserved verbatim.
  if (!policy.preserveStructure) {
    const lines = result.split("\n");
    const collapsed: string[] = [];
    let inRedactionRun = false;
    for (const line of lines) {
      const isPureRedaction = isPureRedactionLine(line, policy);
      if (isPureRedaction) {
        if (!inRedactionRun) {
          collapsed.push(line);
          inRedactionRun = true;
        }
      } else {
        inRedactionRun = false;
        collapsed.push(line);
      }
    }
    result = collapsed.join("\n");
  }
  return result;
}

/**
 * Redact text: detect sensitive spans and apply replacements in one call.
 * Returns the redacted text and full metadata for audit.
 */
export function redactText(
  text: string,
  policy: PrivacyPolicy,
  options: DetectionOptions = {},
): RedactionResult {
  if (typeof text !== "string") {
    throw new InputError("redactText: text must be a string", "redaction_text_not_string");
  }
  const profile = options.profile ?? DEFAULT_PROFILE;
  // ── ONE DETECTOR, EVERYWHERE ────────────────────────────────────────────
  //
  // This used to call `detectSensitiveSpans` — the format catalog ALONE —
  // while the LLM and user-display paths ran all five layers, and the split
  // was written down as deliberate: "the intelligence layers are enforced
  // where the user asked for enforcement". That reasoning does not survive
  // being stated plainly. It means a credential is hidden when the model is
  // about to read it and VISIBLE when the same bytes are shown through the
  // file viewer or attached as evidence, and nobody can hold two different
  // answers to "is this a secret" in their head about one product.
  //
  // A split detector is also the shape every leak in this file's history has
  // had: two passes disagreeing, one suppressing the other, a layer reached
  // by one call site and not its neighbour. There is now one composed
  // detector and every path is a call to it.
  const spans = detectSecretSpans(text, policy, { ...options, profile });
  const redactedText = applyRedactions(text, spans, policy);
  const map = createUtf8OffsetMap(text);
  const originalByteLength = safeByteLength(map);
  const redactedMap = createUtf8OffsetMap(redactedText);
  const redactedByteLength = safeByteLength(redactedMap);
  return deepFreeze({
    redactedText,
    spans,
    spanCount: spans.length,
    redactionMapHash: canonicalHash(spans.map((s) => ({
      start: s.startUtf16,
      end: s.endUtf16,
      category: s.category,
      signalId: s.signalId,
    }))),
    originalByteLength,
    redactedByteLength,
    profile,
  });
}

/**
 * Redact a single line, useful for line-oriented viewing modes.
 */
export function redactLine(
  line: string,
  policy: PrivacyPolicy,
  options: DetectionOptions = {},
): RedactionResult {
  return redactText(line, policy, options);
}

/**
 * Redact multiple lines independently, returning per-line results and an
 * aggregate summary. Each line is redacted in isolation so that spans never
 * cross line boundaries (important for stable line/span mapping).
 */
export function redactLines(
  lines: readonly string[],
  policy: PrivacyPolicy,
  options: DetectionOptions = {},
): Readonly<{
  results: readonly RedactionResult[];
  totalSpans: number;
  redactedLines: readonly string[];
}> {
  const results = lines.map((line) => redactLine(line, policy, options));
  const totalSpans = results.reduce((sum, r) => sum + r.spanCount, 0);
  const redactedLines = results.map((r) => r.redactedText);
  return deepFreeze({ results, totalSpans, redactedLines });
}

/**
 * Check if text contains any sensitive spans without redacting.
 */
export function hasSensitiveContent(
  text: string,
  policy: PrivacyPolicy,
  options: DetectionOptions = {},
): boolean {
  return detectSecretSpans(text, policy, options).length > 0;
}

/**
 * Compute the redaction metadata for audit without exposing the original
 * content. The metadata contains only: span positions, categories, signal
 * ids, and detector id — never the redacted value.
 */
export function redactionMetadata(
  result: RedactionResult,
): Readonly<{
  spanCount: number;
  spans: readonly Readonly<{
    startByte: number;
    endByte: number;
    category: RedactionCategory;
    signalId: string;
    detectorId: string;
  }>[];
  redactionMapHash: string;
  originalByteLength: number;
  redactedByteLength: number;
}> {
  return deepFreeze({
    spanCount: result.spanCount,
    spans: result.spans.map((s) => ({
      startByte: s.startByte,
      endByte: s.endByte,
      category: s.category,
      signalId: s.signalId,
      detectorId: s.detectorId,
    })),
    redactionMapHash: result.redactionMapHash,
    originalByteLength: result.originalByteLength,
    redactedByteLength: result.redactedByteLength,
  });
}

/**
 * Verify that a redacted text contains no detectable secret spans. This is
 * the independent oracle check: after redaction, the same detector should
 * find zero matches. If it finds any, the redaction was incomplete.
 */
export function verifyRedaction(
  redactedText: string,
  policy: PrivacyPolicy,
  options: DetectionOptions = {},
): Readonly<{
  verified: boolean;
  residualSpans: readonly RedactableSpan[];
}> {
  const profile = options.profile ?? DEFAULT_PROFILE;
  // The oracle runs the SAME detector the redaction ran. A verifier weaker
  // than the thing it verifies reports "clean" on everything the weaker one
  // cannot see, which is the most expensive kind of green.
  const residualSpans = detectSecretSpans(redactedText, policy, { ...options, profile });
  return deepFreeze({
    verified: residualSpans.length === 0,
    residualSpans,
  });
}

function safeByteLength(map: ReturnType<typeof createUtf8OffsetMap>): number {
  try {
    return utf8ByteLengthFromMap(map);
  } catch {
    return 0;
  }
}

// ── LLM-context value-only redaction ─────────────────────────────
// The canonical `redactText` replaces each detected span (including the key
// name for credential-assignment) with `[REDACTED:<type>]`. For file viewing
// that is correct (hide the whole line content). For LLM context it is too
// aggressive: requires keeping the const/variable/env NAME so the
// model still understands the code (`const API_KEY = "sk-..."` →
// `const API_KEY = "[REDACTED:credential]"`). `redactForLLMContext` reuses the
// SAME detection engine but, for credential-assignment spans, trims the span
// to cover only the VALUE (dropping the key-name prefix). All other signal
// types (token-prefix, aws-access-key, bearer-token, private-key, makora-key)
// are already value-only — their spans start at the value — so they redact
// as-is and naturally preserve surrounding code structure.

/**
 * The key-name prefix of a credential-assignment match. Captures everything
 * up to (and including) the optional opening quote, so only the value
 * portion remains for redaction. Mirrors the credential-assignment signal's
 * key-name alternation in `secret-signals.ts` (single owner).
 */
const CREDENTIAL_KEY_PREFIX =
  /^((?:api[_ -]?key|authorization|password|private[_ -]?key|secret|session[_ -]?token)\s*[:=]\s*["']?)/iu;

/**
 * Redact sensitive VALUES from text while preserving the surrounding
 * identifiers/structure. For a
 * credential assignment like `const API_KEY = "sk-..."` the result is
 * `const API_KEY = "[REDACTED:credential]"` — the variable name is kept so
 * the LLM still understands the code context. Standalone secret values
 * (bearer tokens, private-key headers, AWS keys, token-prefix values) are
 * redacted as-is; their spans are already value-only.
 *
 * This is the function the LLM context pipeline uses (buildTrimmedHistory,
 * memory injection, extractive summarizer). It reuses `detectSensitiveSpans`
 * + `applyRedactions` — no second detector (DRY, ).
 */
export function redactForLLMContext(
  text: string,
  policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
  options: DetectionOptions = {},
): string {
  return redactContextText(text, policy, options).text;
}
/** Detection-only context candidates. The flag retains all candidates for an
 * infrastructure composition that must postpone overlap arbitration. It grants
 * no exemption and accepts no caller-provided protected ranges. */
export function collectContextRedactionCandidates(text: string, policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY,
  options: DetectionOptions = {}, preserveCandidates = false): readonly ExplainedSpan[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const spans = preserveCandidates ? collectSecretSpans(text, policy, options, true) : detectSecretSpans(text, policy, options);
  const adjusted: ExplainedSpan[] = [];
  for (const span of spans) {
    if (span.signalId === "credential-assignment") {
      const matched = text.slice(span.startUtf16, span.endUtf16);
      const split = CREDENTIAL_KEY_PREFIX.exec(matched);
      if (split !== null) {
        const prefixLen = split[1]!.length;
        if (prefixLen > 0 && span.startUtf16 + prefixLen < span.endUtf16) {
          adjusted.push({ ...span, startUtf16: span.startUtf16 + prefixLen });
          continue;
        }
      }
    }
    adjusted.push(span);
  }
  return adjusted;
}
function redactContextText(text: string, policy: PrivacyPolicy, options: DetectionOptions): Readonly<{text: string; explanations: readonly RedactionExplanation[]}> {
  if (typeof text !== "string" || text.length === 0) return {text: text ?? "", explanations: []};
  const candidates = collectContextRedactionCandidates(text, policy, options);
  const admitted = resolveOverlaps(candidates) as readonly ExplainedSpan[];
  return {text: applyRedactions(text, admitted, policy), explanations: admitted.map(explainSpan)};
}
