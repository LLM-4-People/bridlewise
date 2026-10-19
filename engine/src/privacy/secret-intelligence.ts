import { NORMALIZATION_REMOVED_CODE_POINTS } from "./text-normalize.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { bestEffort } from "../shared/best-effort.ts";
/**
 * The engine's own replacement marker, read from the RESOLVED policy that
 * owns it. A token containing it is not a secret — it is the RESULT of
 * masking one, and masking it again would break the idempotence the two-pass
 * egress choke point depends on.
 *
 * The policy is threaded in per call rather than read from a module constant.
 * This module used to import the DEFAULT prefix, which is correct only while
 * central config leaves the marker alone: configure `redactionPrefix` to
 * anything else and the recogniser went on looking for `[REDACTED:`, read the
 * redactor's own output as a declared credential, and every redaction
 * self-reported as an incomplete one. The default is now module-private to its
 * owner, so this file cannot make that mistake again — see the note beside it.
 */
import type { PrivacyPolicy } from "./privacy-policy.ts";

/**
 * SECRET INTELLIGENCE — the three layers a format regex cannot reach.
 *
 * The catalog in `secret-signals.ts` is a set of FORMAT regexes. A format
 * detector is permanently behind: it catches what it has already seen, and
 * misses every provider not listed, every internal or self-hosted credential,
 * and every key that is DESCRIBED rather than pasted in canonical form. The
 * answer to that is not a longer list of regexes — that is the same rigidity
 * spelled out at greater length. It is three additional kinds of evidence,
 * strongest first:
 *
 *  1. IDENTITY (`knownSecretSpans`). The harness HOLDS the real credentials:
 *     the provider API key it is about to authenticate with, `HARNESS_API_KEY`,
 *     the database passphrase. A string equal to a credential we hold is
 *     provably a secret in ANY format — no heuristic, no false positive, no
 *     false negative. Matched exact and NORMALISED, because an escaped copy is
 *     the same secret.
 *
 *  2. DECLARATION (`declaredSecretSpans`). "my api key is X", "password: X",
 *     "token = X". The declaration is evidence about X REGARDLESS of X's
 *     shape — which is precisely the case a format detector cannot see, and
 *     precisely the case that was reported.
 *
 *  3. SHAPE/ENTROPY (`isSecretShapedValue`), which exists only as SUPPORT for
 *     layer 2 and is never a detector on its own. A long high-entropy token
 *     next to a declaration is a secret; the same token in a hash column or an
 *     id column is not. Nothing in this module treats entropy alone as
 *     evidence.
 *
 * WHAT THIS MODULE PROMISES ABOUT THE VALUES IT HOLDS. Layer 1 must compare
 * against real credentials, so it must hold them. It therefore holds them in
 * a module-private map that is never exported, never enumerated into a
 * return value, never interpolated into an error, and never written into a
 * span's `reason` — a span records the LABEL ("llm-provider-api-key") and
 * never the value. `registerKnownSecret` returns a typed outcome rather than
 * throwing, because a thrown message is the classic way a secret reaches a
 * log.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

// ── the confidence of a detection, which is not the same as its category ──

/**
 * The layer contract — `SecretConfidence` and `IntelligenceSpan` — lives in
 * `detection-span.ts` so that five layers can produce the same shape without
 * importing each other. Re-exported here because this module was the
 * original owner and every consumer imports the names from it.
 */
export {
  SECRET_CONFIDENCES,
  type SecretConfidence,
  type IntelligenceSpan,
} from "./detection-span.ts";
// Re-exported above for consumers; imported here only for local use. Only
// `IntelligenceSpan` is used locally — `SecretConfidence` was imported and
// never referenced, which is the unused-symbol error the compiler reported.
import type { IntelligenceSpan } from "./detection-span.ts";
import {
  characterClassCount,
  createRegisterCache,
  registerAt,
  shannonEntropyBits,
  vowelRatio,
  type RegisterCache,
} from "./value-intrinsic.ts";
import { lexiconWeight, type LexiconEntry } from "./credential-lexicon.ts";
import { benignRegions, withinBenignRegion, type BenignRegion } from "./benign-grammars.ts";

/**
 * Shannon entropy in bits per character. Owned by `value-intrinsic.ts` (the
 * layer whose entire judgement rests on it) and re-exported here for the
 * consumers that found it at this address first.
 */
export { shannonEntropyBits } from "./value-intrinsic.ts";

// ── LAYER 1: identity ────────────────────────────────────────────────────

/**
 * The shortest credential this registry will accept. A short string
 * registered as a secret is a content shredder: registering `"true"` would
 * mask the word "true" in every message forever. Twelve is above every
 * plausible non-secret configuration value (`development` is 11) and below
 * every plausible real credential.
 */
export const MIN_KNOWN_SECRET_LENGTH = 12;

/** A bound on how many credentials may be registered, so the per-string scan
 * cost stays bounded no matter what a caller does. */
const MAX_KNOWN_SECRETS = 64;

export type RegisterOutcome =
  | Readonly<{ registered: true; label: string; variantCount: number }>
  | Readonly<{ registered: false; label: string; reason: RegisterRejection }>;

export type RegisterRejection =
  | "not-a-string"
  | "too-short"
  | "contains-whitespace"
  | "looks-like-a-url"
  | "registry-full"
  | "reserved-label";

/**
 * THE VALUES, HELD PRIVATELY. Keyed by label so re-registering a rotated
 * credential replaces the old one instead of accumulating stale variants.
 * `variants` holds the escaped forms; nothing here is exported, and the only
 * thing any caller can learn from this module is the LABEL and the COUNT.
 */
const knownSecrets = new Map<string, { readonly variants: readonly string[]; readonly held: boolean }>();

/**
 * Every registered variant, longest first, with its label — rebuilt on every
 * mutation so the hot path does no work per call beyond the scan itself.
 * Longest-first so that when one credential is a prefix of another the longer
 * match is the one found; `resolveOverlaps` would fix it downstream anyway,
 * but a detector should not depend on a later pass to be correct.
 */
let scanList: readonly Readonly<{ variant: string; label: string }>[] = [];

/** The shortest registered variant. A string shorter than this cannot contain
 * any of them, which is the whole cost of layer 1 for the overwhelming
 * majority of strings. */
let shortestVariant = Number.POSITIVE_INFINITY;

/**
 * A monotone counter bumped by EVERY mutation of this registry (register,
 * forget, clear). Detection results are a function of the registry, so a
 * consumer that memoises anything derived from detection (the web redaction
 * adapter's tool-call-argument cache) keys its validity on this number: a
 * changed generation means a previously memoised answer may no longer be the
 * redaction this process would produce now. Read-only; the mutations below
 * are the only writers.
 */
let registryGeneration = 0;

/**
 * The current registry generation — see `registryGeneration`. Exported so a
 * memoising consumer can invalidate exactly when the registry moves, and a
 * test can prove it does.
 */
export function knownSecretRegistryGeneration(): number {
  return registryGeneration;
}

/**
 * The escaped forms of one credential that are still the same credential.
 * A secret that has been through `JSON.stringify`, a URL query string, or a
 * nested tool-call argument (escaped twice) is not a different secret, and a
 * detector that only knows the raw form leaks every one of those copies.
 *
 * Surrounding quotes, backticks and whitespace need no variant: the scan
 * looks for the VALUE as a substring, so whatever wraps it is simply not part
 * of the match.
 *
 * ── THE FLOOR IS A REQUIRED ARGUMENT, AND THE LEAK IT ENDS ────────────────
 *
 * This helper serves TWO populations with two different accept floors: the
 * persistent registry (`registerKnownSecret`, floor `MIN_KNOWN_SECRET_LENGTH`
 * = 12) and the per-call ephemeral list of values the user just declared
 * (`buildEphemeralScanList`, floor `MIN_REMEMBERABLE_LENGTH` = 6). It used to
 * hardcode the REGISTRY's floor, so a declared 6-to-11-character secret was
 * accepted by `rememberableDeclaredValue`, counted in `learnedCount`, and
 * then produced ZERO variants here — accepted, reported as learned, and
 * leaked wherever it appeared without its declaration beside it. Accepting a
 * value and then silently not masking it is the worst of the three options
 * (mask it, refuse it, or leak it), because it reports success.
 *
 * So each caller passes THE FLOOR OF ITS OWN POPULATION, and the invariant
 * is one sentence: whatever a population ACCEPTS, it MASKS — the accept
 * floor and the mask floor are the same constant, per population. The two
 * floors themselves remain a deliberate pair, not a defect: the ephemeral
 * floor may sit at 6 only because those values are vetoed against the
 * placeholder list and live for one call; the registry's 12 protects every
 * future message from a short shredder (see both constants' notes).
 */
function escapeVariants(value: string, minLength: number): readonly string[] {
  const out = new Set<string>();
  out.add(value);
  const trimmed = value.trim();
  if (trimmed.length >= minLength) out.add(trimmed);
  // JSON string escaping, once and twice — `JSON.stringify` wraps in quotes,
  // and the quotes are not part of the secret.
  const jsonOnce = JSON.stringify(value).slice(1, -1);
  out.add(jsonOnce);
  out.add(JSON.stringify(jsonOnce).slice(1, -1));
  // URL/percent encoding, both the component and the whole-URI form.
  // A lone surrogate makes `encodeURIComponent` throw. The raw form is
  // already registered; the escaped forms are a bonus, not a requirement —
  // so the failure is logged rather than swallowed or propagated.
  bestEffort(() => {
    out.add(encodeURIComponent(value));
    out.add(encodeURI(value));
  });
  // Base64, the form a credential takes inside a Basic/Bearer header that was
  // built from the key alone.
  bestEffort(() => {
    out.add(Buffer.from(value, "utf8").toString("base64"));
  });
  return [...out].filter((v) => v.length >= minLength);
}

function rebuildScanList(): void {
  const entries: { variant: string; label: string }[] = [];
  for (const [label, entry] of knownSecrets) {
    for (const variant of entry.variants) entries.push({ variant, label });
  }
  entries.sort((a, b) => b.variant.length - a.variant.length);
  scanList = Object.freeze(entries.map((e) => Object.freeze(e)));
  shortestVariant = entries.length === 0
    ? Number.POSITIVE_INFINITY
    : entries[entries.length - 1]!.variant.length;
  // Every mutation funnels through this rebuild, so the generation bump
  // lives at the choke point — a new mutation path cannot forget it.
  registryGeneration += 1;
}

/**
 * Register a credential this process holds, under a label that describes
 * WHERE it came from ("llm-provider-api-key", "db-encryption-key"). The
 * label is the only thing that ever surfaces.
 *
 * Returns an outcome instead of throwing: a rejection message that quoted the
 * value would put the credential in whatever log caught the error, which is
 * the exact failure this layer exists to prevent.
 */
/**
 * THE ADMISSION GRAMMAR of a value held as a credential (the registry's, and
 * every per-operation held set that masks by equality): a string of at least
 * the floor's length, with no whitespace, that is not a URL — a shorter or
 * ordinary value would mask every harmless occurrence of itself. Undefined
 * when admitted.
 */
export function knownSecretShapeRefusal(value: unknown): "not-a-string" | "too-short" | "contains-whitespace" | "looks-like-a-url" | undefined {
  if (typeof value !== "string") return "not-a-string";
  const trimmed = value.trim();
  if (trimmed.length < MIN_KNOWN_SECRET_LENGTH) return "too-short";
  if (/\s/u.test(trimmed)) return "contains-whitespace";
  // A base URL is not a credential, and masking every occurrence of the
  // provider's hostname would destroy legitimate content for no security gain.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return "looks-like-a-url";
  return undefined;
}

export function registerKnownSecret(value: unknown, label?: string): RegisterOutcome {
  const held = label === undefined;
  // Provider identities and header names are untrusted provenance. An omitted
  // label uses this existing registry's opaque slot, never a value-derived hash.
  // Repeated registration shares an existing entry without replacing another
  // live client's credential. Explicit labels retain their rotation semantics.
  if (label === undefined) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    label = [...knownSecrets].find(([, entry]) => entry.held && entry.variants.includes(trimmed))?.[0];
    if (label !== undefined) return { registered: true, label, variantCount: knownSecrets.get(label)!.variants.length };
    if (label === undefined) {
      let slot = knownSecrets.size;
      do { label = `held-credential:${slot++}`; } while (knownSecrets.has(label));
    }
  }
  if (!held && knownSecrets.get(label)?.held) return { registered: false, label, reason: "reserved-label" };
  const refusal = knownSecretShapeRefusal(value);
  if (refusal !== undefined) return { registered: false, label, reason: refusal };
  const trimmed = (value as string).trim();
  if (!knownSecrets.has(label) && knownSecrets.size >= MAX_KNOWN_SECRETS) {
    return { registered: false, label, reason: "registry-full" };
  }
  const variants = escapeVariants(trimmed, MIN_KNOWN_SECRET_LENGTH);
  knownSecrets.set(label, { variants, held });
  rebuildScanList();
  return { registered: true, label, variantCount: variants.length };
}

/** Forget one credential (rotation, or a test tearing down). */
export function forgetKnownSecret(label: string): boolean {
  const had = knownSecrets.delete(label);
  if (had) rebuildScanList();
  return had;
}

/** Forget everything. Exists for tests; production rotates by re-registering. */
export function clearKnownSecrets(): void {
  knownSecrets.clear();
  rebuildScanList();
}

/**
 * WHICH credentials are known, by label only. This is the accessor a status
 * surface can call: it answers "the redactor knows about your provider key
 * and your database key" without answering "and here they are".
 */
export function knownSecretLabels(): readonly string[] {
  return Object.freeze([...knownSecrets.keys()].sort());
}

/** How many credentials are registered. */
export function knownSecretCount(): number {
  return knownSecrets.size;
}

/**
 * LAYER 1. Every region of `text` that IS a credential this process holds.
 *
 * Costs one `indexOf` per registered variant, and nothing at all when the
 * registry is empty or the string is shorter than the shortest variant —
 * which is every string on a normal page.
 */
export function knownSecretSpans(
  text: string,
  /** EPHEMERAL values, supplied per call and never stored — see
   * `rememberableDeclaredValue`. These are credentials the USER declared in
   * the conversation being redacted, promoted to identity evidence for the
   * duration of that one call. */
  additional: readonly string[] = [],
  /** Explicit credentials held by this operation (never persisted), as the held-set owner hands them over: at or above its floor. */
  held?: HeldMatch,
): readonly IntelligenceSpan[] {
  const ephemeral = [...buildEphemeralScanList(additional, MIN_REMEMBERABLE_LENGTH, "declared"), ...(held === undefined ? [] : buildEphemeralScanList(held.values, held.minimumLength, "held"))];
  if (scanList.length === 0 && ephemeral.length === 0) return EMPTY_SPANS;
  const spans: IntelligenceSpan[] = [];
  for (const { variant, label, detectorId } of ephemeral) {
    if (variant.length > text.length) continue;
    let at = text.indexOf(variant);
    while (at !== -1) {
      spans.push({
        startUtf16: at,
        endUtf16: at + variant.length,
        signalId: "known-secret",
        detectorId,
        // PROVEN, and the word is earned: this is a byte-equality test
        // against a value that was ALREADY judged a credential earlier in
        // this same conversation. The inference happened once, upstream; what
        // happens here is an exact match.
        confidence: "proven",
        explanation: label,
      });
      at = text.indexOf(variant, at + variant.length);
    }
  }
  if (scanList.length === 0 || text.length < shortestVariant) return spans;
  for (const { variant, label } of scanList) {
    if (variant.length > text.length) continue;
    let at = text.indexOf(variant);
    while (at !== -1) {
      spans.push({
        startUtf16: at,
        endUtf16: at + variant.length,
        signalId: "known-secret",
        detectorId: "known-secret",
        confidence: "proven",
        // The LABEL, never the value. This string is designed to be shown to
        // the user and written to a log.
        explanation: `equals the ${label} this server holds`,
      });
      at = text.indexOf(variant, at + variant.length);
    }
  }
  return spans;
}

const EMPTY_SPANS: readonly IntelligenceSpan[] = Object.freeze([]);

/**
 * The escaped forms of a value the USER declared, built per call and thrown
 * away with the call. Same normalisation as a registered credential — an
 * escaped copy of the user's password is still the user's password.
 */
/**
 * The exact forms an intentionally HELD value is matched in (raw, trimmed,
 * JSON-escaped once and twice, percent-encoded, base64), longest first — the
 * variants `knownSecretSpans` scans for its `held` argument. Exported for the
 * held-set owner (`held-set.ts`), whose streaming scrubber must know how far
 * back a match can reach.
 */
export function heldScanVariants(held: HeldMatch): readonly string[] {
  return buildEphemeralScanList(held.values, held.minimumLength, "held").map((entry) => entry.variant);
}

function buildEphemeralScanList(values: readonly string[], minimumLength: number, population: "declared" | "held"): readonly Readonly<{ variant: string; label: string; detectorId: string }>[] {
  const seen = new Set<string>();
  const out: { variant: string; label: string; detectorId: string }[] = [];
  for (const value of values) {
    // The EPHEMERAL population's own floor — the same constant that accepted
    // the value in `rememberableDeclaredValue`, so a value this list accepts
    // is a value this list can match. Passing the registry's higher floor
    // here was the accepted-then-leaked defect recorded on `escapeVariants`.
    if (value.length === 0) continue;
    for (const variant of escapeVariants(value, minimumLength)) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      out.push({
        variant,
        label: population === "held" ? "equals an intentionally held operation credential" : "was declared as a credential earlier in this conversation",
        detectorId: population === "held" ? "known-secret" : "declared-then-known",
      });
    }
  }
  out.sort((a, b) => b.variant.length - a.variant.length);
  return Object.freeze(out.map((e) => Object.freeze(e)));
}

/**
 * ── THE SPECIFICITY FLOOR FOR REMEMBERING, WHICH IS NOT THE DETECTION FLOOR ──
 *
 * Detecting `admin44` after "my password may be" is right. REMEMBERING it —
 * so that every later occurrence is masked by identity — is a different and
 * much sharper instrument, and it cuts both ways: a value that is too short
 * or too common becomes a permanent shredder for legitimate content. "my
 * password is `test`" must never turn every occurrence of the word "test"
 * into `[REDACTED:secret]`.
 *
 * So remembering requires MORE than detecting did:
 *   - at least `MIN_REMEMBERABLE_LENGTH` characters,
 *   - not a value from the small set of placeholders people actually type,
 *   - not purely numeric (a year, a port, a PIN),
 *   - and either two character classes or real length behind it.
 *
 * The floor can be as low as it is ONLY because the scope is one call. These
 * values are never registered, never persisted and never shared between
 * conversations — see `redactMessagesTogether`. A PERSISTENT registry would
 * need a much higher bar, because its blast radius is every future message
 * from every user rather than the turn in front of you.
 */
export const MIN_REMEMBERABLE_LENGTH = 6;

/**
 * THE HELD POPULATION'S FLOOR — values an operation holds on purpose: a
 * request's credential slots, a provider's key and credential headers, a
 * parent response's credentials, an MCP server's own. A held value shorter
 * than it is replaced where it was given, exactly, but never searched for in
 * text: a one-letter password masked every "a" in the turn and refused the
 * request whose JSON keys contain one (a2-correctness §2). Its default is the
 * declared population's bar (one operation's scope, like one call's); the
 * operator moves it with `privacy.heldCredentialMinimumLength`, never above
 * {@link MIN_KNOWN_SECRET_LENGTH} (a value that long is always matched).
 * Applied by THE held-set owner (`held-set.ts`), so every producer inherits
 * it (a2b-design H1); its accept floor is its mask floor.
 */
export const DEFAULT_HELD_MINIMUM_LENGTH = MIN_REMEMBERABLE_LENGTH;

/** The held population as the held-set owner hands it to the scan: its values at or above its floor, and the floor. */
export type HeldMatch = Readonly<{ values: readonly string[]; minimumLength: number }>;

/** Placeholders people actually type when they mean "not a real secret".
 * Masking any of these everywhere would be worse than the miss. */
const UNREMEMBERABLE_VALUES: ReadonlySet<string> = new Set([
  "password", "passwd", "secret", "changeme", "change-me", "letmein",
  "admin", "administrator", "root", "toor", "guest", "default",
  "test", "testing", "example", "sample", "demo", "dummy", "placeholder",
  "hunter2", "qwerty", "abc123", "123456", "12345678", "iloveyou",
  "true", "false", "null", "undefined", "none", "nil", "empty",
  "localhost", "redacted", "your-key-here", "xxxxxxxx", "todo",
]);

/**
 * Whether a value the declaration layer masked is specific enough to be
 * promoted to identity evidence for the rest of this call.
 */
export function rememberableDeclaredValue(value: string): boolean {
  if (value.length < MIN_REMEMBERABLE_LENGTH) return false;
  if (value.length > MAX_DECLARED_VALUE_LENGTH) return false;
  if (/\s/u.test(value)) return false;
  if (UNREMEMBERABLE_VALUES.has(value.toLowerCase())) return false;
  // Purely numeric: a year, a port, a build number, an order id.
  if (/^\d+$/u.test(value)) return false;
  return characterClassCount(value) >= 2 || value.length >= 12;
}

// ── LAYER 2: declaration ─────────────────────────────────────────────────

/**
 * THE DECLARATION CUE — the noun that names a credential.
 *
 * The alternation is the SEED of the credential lexicon, not the lexicon
 * itself: `credential-lexicon.ts` derives separator and case variants,
 * abbreviations and truncations from these stems, and learns more from what
 * the user actually writes. What is spelled out here is deliberately a
 * handful of concepts in one language, labelled a bootstrap.
 *
 * The separator class `[\s._-]?` makes `apiKey`, `api_key`, `api-key`,
 * `api.key` and `api key` one cue rather than five, and the case-insensitive
 * flag makes `ApiKey` and `API_KEY` the same cue again.
 *
 * THE BOUNDARY IS NOT IN THIS PATTERN, and that is a fix rather than an
 * omission — see `cueBoundaryOk`. A lookaround written here would be subject
 * to the `i` flag, under which `[A-Z]` also matches lowercase, and the
 * camel-hump rule the boundary needs is precisely a statement about case.
 *
 * ── THE QUALIFIER IS A SHAPE, NOT A LIST ────────────────────────────────
 *
 * `key` on its own is not a cue and must not become one: it is a map index,
 * a YAML field, "the key point", and admitting it bare was measured at 5.7x
 * the false positives for +0.3pp. So the STRONG branch qualifies it with a
 * list — `api`, `secret`, `access`, `private`, … — and that list is exactly
 * the kind of thing that is permanently behind, because the qualifier is
 * whatever the vendor happens to be called:
 *
 *     HEROKU_KEY   SNYK_KEY   hubspot-key   heroku.key
 *
 * The WEAK branch therefore takes the qualifier STRUCTURALLY instead:
 * any single word joined to `key` by `.`, `_` or `-`. That is a compound
 * IDENTIFIER, which is a shape, and it needs no maintenance as providers
 * come and go.
 *
 * WHITESPACE IS DELIBERATELY NOT A JOINER HERE, and it is the whole safety
 * of the rule. `[A-Za-z]+[\s._-]?key` would match "the key" and "a key" in
 * ordinary prose, which is the bare-`key` failure with extra steps. Only
 * the punctuation that builds an identifier counts, so `monkey` (no joiner)
 * and "the key" (a space) are both refused, and the weak weight means the
 * value must still look like a credential before anything is masked.
 *
 * AND THE COMPOUND MUST BE THE WHOLE NAME. Without the lookbehind this
 * matched the tail of a longer identifier, and psf/requests supplied the
 * false positive immediately:
 *
 *     ("a_new_key", "192.168.0.0/24,127.0.0.1,localhost.localdomain"),
 *
 * `new_key` is a suffix of `a_new_key`, and a suffix is not a name — the
 * qualifier there is "a", which qualifies nothing. Anchoring to the start of
 * the identifier run keeps `MY_HEROKU_KEY` (every component is a word) and
 * refuses `a_new_key` (the first component is one letter), which is the
 * distinction that matters and it is still a shape rather than a list.
 */
const DECLARATION_CUE =
  /((?:api|secret|access|private|publishable|signing|encryption|licen[cs]e|master|root)[\s._-]?keys?|(?:access|refresh|bearer|session|auth|personal[\s._-]?access)[\s._-]?tokens?|client[\s._-]?secrets?|webhook[\s._-]?secrets?|connection[\s._-]?strings?|authorization|passphrases?|passwds?|passwords?)|(credentials?|secrets?|tokens?|id[\s._-]?tokens?|dsn|pat|(?<![A-Za-z0-9_.-])[A-Za-z][A-Za-z0-9]{1,20}(?:[._-][A-Za-z][A-Za-z0-9]{0,20})*[._-]keys?)/giu;

/**
 * THE PERSONAL-IDENTIFIER CUE — the same mechanism, a different noun.
 *
 * A passport number is not a credential and its value has none of the
 * properties `valueShapeSupport` looks for: `933932951` has no entropy, no
 * mixed case and no internal capital. It is found the only way it can be
 * found deterministically — by the words that introduce it — which is
 * exactly what layer 5 already does for `password`. So this is a second CUE
 * CLASS through the one scanner, not a second scanner.
 *
 * A BOOTSTRAP IN ONE LANGUAGE, and the limit is measured rather than
 * guessed. English cues reach about 60% of the English spans in the
 * ai4privacy held-out set and 15-25% of the French, German, Italian, Spanish
 * and Dutch ones — the non-English hits are English field labels embedded in
 * non-English prose. The derivation rules in `credential-lexicon.ts`
 * generalise across MORPHOLOGY (`passport` -> `passports`, `pass_port`), not
 * across LANGUAGES: matching is whole-word, so the prefix `pass` never meets
 * `passeport`. Multilingual coverage has to come from the learning path,
 * from a user-supplied lexicon, or from a translation table that this
 * project has decided not to hand-author.
 *
 * THE GENERIC NOUNS ARE DELIBERATELY ABSENT. `name`, `address`, `city`,
 * `id`, `user` and `login` name a personal detail often and name an ordinary
 * field far more often — `{ name: "lodash" }` is in every package.json.
 * Every cue here is a compound that means one thing.
 */
const PII_DECLARATION_CUE =
  /\b(passport(?:[\s._-]?numbers?)?|driv(?:er|ing)[\s._-]?licen[cs]e(?:[\s._-]?numbers?)?|social[\s._-]?security(?:[\s._-]?numbers?)?|national[\s._-]?insurance(?:[\s._-]?numbers?)?|tax[\s._-]?(?:payer[\s._-]?)?id(?:entification)?[\s._-]?numbers?|identity[\s._-]?card(?:[\s._-]?numbers?)?|id[\s._-]?card(?:[\s._-]?numbers?)?|dates?[\s._-]?of[\s._-]?birth|birth[\s._-]?dates?|date[\s._-]?de[\s._-]?naissance|telephone(?:[\s._-]?numbers?)?|phone[\s._-]?numbers?|mobile[\s._-]?numbers?|fax[\s._-]?numbers?)\b/giu;

/**
 * THE SHAPE OF A PERSONAL IDENTIFIER, which is the opposite of a credential's.
 *
 * A credential is believed because it looks RANDOM. An identifier is believed
 * because it looks ISSUED: grouped digits, a country-style alphanumeric code,
 * or a date. Every one of these shapes is far too common to detect on its own
 * — a bare nine-digit run is an order number far more often than it is a
 * social security number — so this function is never consulted without a cue
 * that named the thing, and the evidence threshold still has to be cleared.
 */
const GROUPED_DIGITS = /^\d{2,5}(?:[.\-/ ]\d{2,5}){1,4}$/u;
const BARE_DIGIT_RUN = /^\d{6,15}$/u;
const ISSUED_CODE = /^(?:[A-Z]{1,6}[0-9]{2,10}){1,3}[A-Z]{0,6}$/u;
const DOTTED_CODE = /^[A-Z]{2,8}(?:[.\-][A-Z0-9]{1,8}){2,5}$/u;
const NUMERIC_DATE = /^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}$/u;

function personalIdentifierShape(token: string): ValueShapeSupport {
  if (token.length < 4 || token.length > 40) return "veto";
  const bare = token.replace(/^[("'`\[]+|[)"'`\],.;:]+$/gu, "");
  if (bare.length < 4) return "veto";
  if (NUMERIC_DATE.test(bare)) return "strong";
  if (GROUPED_DIGITS.test(bare)) return "strong";
  if (DOTTED_CODE.test(bare)) return "strong";
  if (ISSUED_CODE.test(bare) && /[0-9]/u.test(bare) && /[A-Z]/u.test(bare)) return "strong";
  if (BARE_DIGIT_RUN.test(bare)) return "strong";
  return "veto";
}

/**
 * WHAT A DECLARATION IS LOOKING FOR — the one thing that differs between a
 * credential cue and a personal-identifier cue.
 *
 * Everything else about the scan is shared: the window, the line and clause
 * bounds, the connector, the possessive, the benign regions, the register,
 * the evidence arithmetic and the threshold. Only the noun set and the shape
 * test change, so they are the only two things this record carries.
 */
type DeclarationKind = Readonly<{
  signalId: string;
  shapeOf: (
    token: string,
    tuning: DeclarationTuning,
    inCode: boolean,
    cueIsUnambiguous: boolean,
    /**
     * The policy in force. Only the credential shape test consults it — to
     * recognise the marker THIS policy writes — but it is part of the shared
     * signature so a kind added later cannot be written against the default.
     */
    policy: PrivacyPolicy,
  ) => ValueShapeSupport;
}>;

const CREDENTIAL_DECLARATION: DeclarationKind = Object.freeze({
  signalId: "declared-credential",
  shapeOf: valueShapeSupport,
});

/**
 * AN ISSUED NUMBER IS NOT READ DIFFERENTLY IN CODE. `valueShapeSupport`
 * takes `inCode` because a random-looking token in source is usually an
 * identifier; a passport number is the same nine digits wherever it is
 * written, and the cue is what carries the claim either way. The register
 * still matters — it discounts DERIVED cues in `valueIntroducedAt` — it just
 * does not change what an identifier looks like.
 */
const IDENTIFIER_DECLARATION: DeclarationKind = Object.freeze({
  signalId: "declared-personal-identifier",
  shapeOf: (token: string) => personalIdentifierShape(token),
});

function isAsciiLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}
function isUpperAscii(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

/**
 * WHERE A CUE IS ALLOWED TO START AND STOP, and the 2,967 misses that were
 * one rule away.
 *
 * The previous boundary was `(?<![A-Za-z]) … (?![A-Za-z])`, chosen over `\b`
 * because `\b` does not fire between `_` and a letter and so could not see
 * the `API_KEY` inside `OPENAI_API_KEY` — the most common way a key is named
 * in configuration. That reasoning was right and it stopped one step short.
 *
 * The step it stopped short of is CAMEL CASE. `adafruitToken`,
 * `1passwordToken`, `stripeSecretKey` — a letter sits immediately before or
 * after the cue, so a letter-only boundary refuses every one of them. On the
 * held-out corpus that single rule accounted for 2,967 of 4,379 misses, more
 * than every other cause combined.
 *
 * A camel hump is a boundary in exactly the way an underscore is: it is how
 * the writer separated two words. It is also completely language-free — the
 * convention is about case transitions, not about English — which is why it
 * belongs here rather than in a longer list of nouns.
 *
 *   left  ok if: nothing before it, a non-letter before it, OR a lowercase
 *                or digit before it and the cue itself starts uppercase.
 *   right ok if: nothing after it, a non-letter after it, OR the cue ends
 *                lowercase-or-digit and an uppercase letter follows.
 *
 * Written as a predicate rather than a lookaround because the cue pattern
 * carries `i`, under which `[A-Z]` matches lowercase and the whole rule
 * silently degrades to "any letter" — a mutation that changes nothing
 * visible and removes the entire guard.
 */
function cueBoundaryOk(text: string, start: number, end: number): boolean {
  const cue = text.slice(start, end);
  if (cue.length === 0) return false;
  const before = start > 0 ? text[start - 1]! : "";
  const after = end < text.length ? text[end]! : "";
  // A capitalised cue — `Token`, `Password` — is a camel COMPONENT whatever
  // precedes it, which is what reaches `AWSToken` where the hump sits
  // between two capitals (`S` then `T`) and case alone cannot mark it.
  const capitalisedCue = isUpperAscii(cue[0]!) && cue.length > 1 && !isUpperAscii(cue[1]!);
  const leftOk =
    before === "" ||
    !isAsciiLetter(before) ||
    (isUpperAscii(cue[0]!) && (!isUpperAscii(before) || capitalisedCue));
  const rightOk =
    after === "" ||
    !isAsciiLetter(after) ||
    (!isUpperAscii(cue[cue.length - 1]!) && isUpperAscii(after));
  return leftOk && rightOk;
}

/** Which capture group of `DECLARATION_CUE` holds the STRONG alternation. A
 * strong cue names a credential and nothing else ("password", "client
 * secret"); a weak one often names something else too ("token" is also a unit
 * of LLM billing, "secret" is also an English adjective). */
const STRONG_CUE_GROUP = 1;

/**
 * THE POSSESSIVE — the strongest signal in natural language, and the one the
 * first version of this layer ignored completely.
 *
 * "MY password", "OUR api key", "the user's token". A speaker who attaches a
 * possessive to a credential noun is telling you, in so many words, whose
 * credential it is. Nothing else short of an exact identity match is worth as
 * much, and crucially it is evidence about the DECLARATION rather than about
 * the value — so it still counts when the value itself looks like nothing at
 * all. That is what makes `my password may be admin44` reachable.
 *
 * Matched by looking BACKWARD from the cue across a short run of words, so
 * "my openai api key" and "our staging database password" both carry it.
 */
const POSSESSIVE_BEFORE_CUE = /(?:\b(?:my|our|your|their|his|her|its)\b|\b[A-Za-z]+'s\b)[\sA-Za-z0-9_-]*$/iu;

/**
 * THE CONNECTOR — the thing that says the cue INTRODUCES what follows.
 *
 * `api key: X` and `my api key is X` declare X. "the api key rotation policy"
 * declares nothing, and without a connector the cue alone would reach forward
 * and mask the next long token in the sentence.
 *
 * HEDGES COUNT AS CONNECTORS, and that was a live leak. `my password may be
 * admin44` went out intact because "may be" was not in this list, while "is"
 * was. But a hedge is not a weaker declaration — "my password may be X" tells
 * you exactly as much about X as "my password is X" does. Someone unsure
 * WHICH of their passwords it is has still told you it is a password.
 */
const CONNECTOR =
  /\b(?:is|are|was|were|equals?|reads?|becomes?|being|(?:may|might|could|should|would|shall|will|must)\s+be|(?:seems?|appears?)\s+to\s+be|looks?\s+like|set\s+to|begins?\s+with|starts?\s+with)\b|[=:]|->|=>/iu;

/**
 * THE SAME CONNECTORS PLUS THE COMMA, AND THE COMMA IS CODE-ONLY.
 *
 * `System.setProperty("ADAFRUIT_TOKEN", "ffle19b0aw10e6av64xxc750d0j7sw8b")`
 * is a declaration in every language that has function calls: a name, a
 * comma, its value. 231 held-out positives are exactly that shape, and no
 * word introduces them.
 *
 * In PROSE the same character is a clause separator and means the opposite.
 * Measured on this repository's own strings, admitting it everywhere cost
 * two false positives immediately:
 *
 *     2. SESSION: a random 32-byte token stored in an HttpOnly, SameSite=Lax
 *     passphrase set -> scrypt-derived key, persisted=true, keyFilePath=null
 *
 * — a weak cue, a comma four words later, and the next token masked. The
 * comma had joined a noun to an unrelated list item.
 *
 * So the register decides, which is the first of the four fixes applied to
 * the smallest possible thing: one character, one meaning per register.
 */
const CONNECTOR_IN_CODE =
  /\b(?:is|are|was|were|equals?|reads?|becomes?|being|(?:may|might|could|should|would|shall|will|must)\s+be|(?:seems?|appears?)\s+to\s+be|looks?\s+like|set\s+to|begins?\s+with|starts?\s+with)\b|[=:,]|->|=>/iu;

/**
 * A SENTENCE ENDED, so the declaration did too.
 *
 * "I lost my api key. Anyway, unfortunately-the-build-is-broken today." has a
 * possessive, a strong cue, and — thirty characters later, in a DIFFERENT
 * SENTENCE — the word "is". Without this bound the scanner joined them and
 * masked "-broken". A full stop, question mark or exclamation followed by
 * whitespace ends the window, exactly as a newline already did.
 */
const SENTENCE_END = /[.!?](?=\s|$)/u;

/**
 * THE GAP BETWEEN A CUE AND THE VALUE IT INTRODUCES, when no listed
 * connector sits in it: punctuation and whitespace, and at most ONE short
 * word.
 *
 * One word, and short. Two words is a clause ("the api key rotation policy
 * for …") and a long word is a noun rather than a function word. Five
 * characters covers `is`, `est`, `es`, `ist`, `war`, `sono`, `este`, `heeft`
 * — and excludes `rotation`, `endpoint`, `expires`.
 */
const FILLER_GAP = /^[\s:=>|-]*(?:\p{L}{1,5}[\s:=>|-]*)?/u;

/**
 * THE TUNABLE PART OF THE INFERENCE, IN ONE PLACE AND MEASURABLE.
 *
 * Layer 2 is the only layer that can be wrong, so its constants are the only
 * ones worth arguing about — and an argument about a threshold is worthless
 * without the sweep that produced it. These are parameters rather than
 * literals so the guard can re-run the sweep over the corpus and FAIL if a
 * different setting would do better: a threshold nobody can re-derive is a
 * threshold that rots.
 *
 * The shipped values are `DECLARATION_TUNING`, chosen by that sweep.
 */
export type DeclarationTuning = Readonly<{
  /** How far past the cue a connector may begin. Beyond this the two are
   * probably not about each other; "the api key rotation policy for the
   * staging cluster is documented in …" must not reach its verb. */
  maxCueToConnector: number;
  /** How far past the connector the value may begin. Enough for an opening
   * quote, a bracket and a little whitespace, not enough to cross a clause. */
  maxConnectorToValue: number;
  /** How far past the cue a value may sit with NO connector at all — ``api
   * key `X` ``. Short, because adjacency is the whole claim. */
  maxBareAdjacency: number;
  /** How wide the punctuation-and-one-short-word gap may be before it stops
   * standing in for a connector. */
  maxFillerGap: number;
  /** How far past the first candidate the value search may run, looking for
   * a token that is not provably ordinary. Roughly a clause. */
  maxValueSearch: number;
  /** How far back from the cue a possessive may sit: "my openai api key" is
   * three words wide, "my key" is one. */
  maxPossessiveLookback: number;
  /** Shorter than this and a token is punctuation, not a value. This is an
   * absolute floor, NOT a shape requirement — see `minShapeQualifyingLength`. */
  minValueLength: number;
  /** Above this length a value's SHAPE counts as strong support. Below it the
   * value contributes little and the declaration has to carry the claim. */
  minShapeQualifyingLength: number;
  /** Shannon entropy, in bits per character, above which a token reads as a
   * key rather than a word. */
  minEntropyBits: number;
  /** The length at which a two-character-class token qualifies on length even
   * if its entropy is low, which is how a repeated-word passphrase
   * (`hunter2hunter2hunter2hunter2`) is caught. */
  lowEntropyLengthFloor: number;

  // ── the weights ──
  /** A noun that names a credential and nothing else: "password", "api key",
   * "client secret". */
  strongCueWeight: number;
  /** A noun that OFTEN names a credential and sometimes does not: "token"
   * (also a unit of LLM billing), "secret" (also an English adjective). */
  weakCueWeight: number;
  /** A possessive before the cue — "MY password", "OUR api key". The single
   * strongest natural-language signal there is, because the speaker is
   * telling you whose credential it is. */
  possessiveWeight: number;
  /** An explicit connector: `=`, `:`, "is", "was", "may be", "set to". */
  connectorWeight: number;
  /** No connector at all, just adjacency: ``api key `X` ``. */
  bareAdjacencyWeight: number;
  /** The cue's line ended in structure and the value is the line below:
   * `<adafruitToken>` then the token, `"asana_token":` then the number. */
  continuationWeight: number;
  /** How many lines the continuation may cross before giving up. */
  maxContinuationLines: number;
  /** The value looks like a credential: long, entropic, mixed alphabet. */
  strongShapeWeight: number;
  /** The value is long enough to be worth something but not conclusive. */
  weakShapeWeight: number;
  /** The evidence required to mask. */
  minEvidence: number;
}>;

/**
 * THE SHIPPED WEIGHTS, and the case that produced them.
 *
 * The first version of this layer was a conjunction: cue AND connector AND a
 * value that passed every shape rule. It was tested live and it leaked
 * immediately, on `my password may be admin44` — which failed on TWO
 * independent conditions at once (`admin44` is 7 characters, under a
 * 12-character floor; "may be" was not in the connector list).
 *
 * Adding "may be" and lowering the floor would have been the wrong fix, and
 * not because it is inelegant: it is the same conjunction with a longer list,
 * and the next phrasing defeats it just as cheaply. The DEFECT WAS THE
 * CONJUNCTION. Under an AND, every condition is a veto, so the weakest
 * condition decides — and the weakest condition is always the one nobody
 * thought of.
 *
 * Evidence ACCUMULATES instead. "my password may be X" carries a possessive,
 * a strong credential noun and a connector; that is a person telling you, in
 * so many words, that X is their password, and at that point the shape of X
 * is not required to agree. `admin44` is a password because they said so.
 * Conversely "the model produced 512 tokens" has a weak noun, no connector
 * and no shape, and never reaches the bar.
 *
 * The weights are small integers on purpose. They are not a model and they
 * are not tuned to four decimal places; they encode an ordering — a
 * possessive outweighs a connector, a connector outweighs adjacency — and the
 * ordering is what the corpus tests.
 */
export const DECLARATION_TUNING: DeclarationTuning = deepFreeze({
  maxCueToConnector: 48,
  maxConnectorToValue: 24,
  maxBareAdjacency: 4,
  maxFillerGap: 8,
  maxValueSearch: 48,
  maxPossessiveLookback: 28,
  minValueLength: 5,
  minShapeQualifyingLength: 12,
  minEntropyBits: 3.0,
  lowEntropyLengthFloor: 20,
  // ── THE SCALE, AND WHY IT IS THREE TIMES WHAT IT WAS ──────────────────
  //
  // Every weight below is exactly 3x the value the corpus originally chose,
  // and `minEvidence` with it, so every judgement the old scale made the new
  // one makes identically — a uniform scaling of an integer sum cannot
  // reorder anything.
  //
  // The room is what it buys. A vocabulary that DERIVES and LEARNS produces
  // cues of four different provenances (canonical-strong, canonical-weak,
  // derived, learned, learned-and-derived), and "derived weighs less than
  // canonical, learned less than seeded" cannot be said at all in a scale
  // where the two cue weights are 1 and 2. The weights are in
  // `credential-lexicon.ts::LEXICON_WEIGHTS`, on this scale, and
  // `seed-strong` there IS `strongCueWeight` here.
  strongCueWeight: 6,
  weakCueWeight: 4,
  possessiveWeight: 9,
  connectorWeight: 6,
  bareAdjacencyWeight: 3,
  continuationWeight: 6,
  maxContinuationLines: 2,
  strongShapeWeight: 6,
  weakShapeWeight: 3,
  minEvidence: 15,
});

/**
 * Characters that open or close a value without being part of it.
 *
 * `#` is here for a reason worth recording. `# Composition API FAQ
 * {#composition-api-faq}` matched the derived cue `api`, and the value
 * scanner — having skipped `{` but not `#` — read the token as
 * `#composition-api-faq`. That is a hyphenated word phrase, which
 * `allPartsAreWords` vetoes on sight; but with the `#` still attached, the
 * first part is `#composition`, which is not `[A-Za-z]+`, so the veto did
 * not fire and twenty-six markdown headings in the vue docs were masked.
 *
 * The tempting fix was to delete the derived terms that collide with
 * ordinary acronyms (`api` from `apikey`, `cdn` from `credential`). That is
 * the wrong instinct and the one this design refuses: precision comes from
 * WEIGHTING and from vetoes that are correct, never from shrinking the
 * derived set back towards a list somebody maintains.
 */
const VALUE_DELIMITERS = "\"'`([{<#";

/**
 * Punctuation that may sit between the connector and the value without being
 * part of either: `the secret is: X`, `password => X`. Skipped alongside
 * whitespace and opening delimiters.
 *
 * The corpus caught this too. `the secret is: 9f2c…` matched the cue and the
 * connector `is`, then read the token starting at `:` — which strips to
 * nothing, so the whole declaration was discarded and a real secret went out.
 * A connector followed by a SECOND connector is still a connector.
 */
const POST_CONNECTOR_PUNCTUATION = ":=>";

function stripLeading(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i]!)) i += 1;
  return s.slice(i);
}

/**
 * Whether a candidate token is the engine's own output rather than a value.
 *
 * THE MARKER COMES FROM THE POLICY IN FORCE, never from the default. The
 * writer is `redactionReplacement`, which formats from `policy.redactionPrefix`;
 * this is the reader, and it reads the same field. One configurable, one
 * answer — which is exactly what broke when this read a module constant
 * instead: with a configured prefix the writer wrote `<HIDDEN:token>` and the
 * reader was still looking for `[REDACTED:`, so the engine flagged its own
 * mask as a residual secret.
 *
 * TWO FORMS, because the value scanner has already eaten the opening
 * delimiter by the time a token reaches here. `[REDACTED:credential]` arrives
 * as `REDACTED:credential`, so the prefix with its leading delimiters stripped
 * is tested as well as the prefix itself. That stripping is this scanner's own
 * business — `VALUE_DELIMITERS` is its notion of what opens a value — which is
 * why the predicate lives here and only the FORMAT comes from the policy.
 *
 * Two earlier attempts at this check failed silently: the first tested the
 * UNWRAPPED token (`unwrap` strips the marker's brackets, so the prefix was
 * already gone), the second tested only the raw token (already delimiter-
 * stripped, so it never contained `[REDACTED:` either). Only the corpus said
 * so — nothing about the code looked wrong on either pass.
 */
function isRedactionMarker(rawToken: string, policy: PrivacyPolicy): boolean {
  const prefix = policy.redactionPrefix;
  // `createPrivacyPolicy` refuses an empty prefix, because `includes("")` is
  // true of every token and would veto the entire declaration layer. The
  // guard is restated here rather than assumed: this predicate decides
  // whether a layer runs at all, and a caller that hand-built a policy object
  // must not be able to switch that layer off by accident.
  if (prefix.length === 0) return false;
  if (rawToken.includes(prefix)) return true;
  // ── AND THE SAME HAZARD ONE STEP LATER ──────────────────────────────────
  //
  // Stripping the opening delimiters can leave NOTHING. A prefix of `[[` is
  // two delimiters and strips to the empty string, and `startsWith("")` is
  // true of every token in existence — so a marker made entirely of
  // delimiters would silently switch this whole layer off, which is the empty
  // prefix hazard wearing a different hat. Found by running the round trip
  // under adversarial markers rather than by reading this function.
  //
  // With no core to test, the `includes` test above is the whole answer, and
  // that is the conservative direction: the layer keeps looking rather than
  // stopping.
  const core = stripLeading(prefix, VALUE_DELIMITERS);
  return core.length > 0 && rawToken.startsWith(core);
}
/**
 * Characters that terminate a value token.
 *
 * `&`, `?` and `#` are here so a credential declared at the HEAD of a URL
 * query string masks only its own parameter. They are the web's own value
 * separators (`?` opens the query, `&` separates parameters, `#` opens the
 * fragment), so a token that runs THROUGH one is running through a
 * structural boundary, not through credential bytes — and a mask that
 * crosses the boundary swallows every later parameter into one span,
 * destroying exactly the neighbouring parameter names and values the
 * capture lanes exist to keep readable. The end of the string terminates a
 * value by construction (the reader stops at the window's edge), so a
 * credential at the query's TAIL always masked only itself; these three
 * give the HEAD the same calibrated boundary.
 *
 * THE SCOPE IS THE WHOLE DECLARED-CREDENTIAL LANE, NOT QUERY STRINGS
 * ONLY. This set bounds every value the declaration scanner reads,
 * wherever the declaration appears — prose and code as much as URLs — so
 * a credential declared in prose that itself carries a raw `&`, `?` or
 * `#` masks only up to the FIRST terminator, and the tail after the
 * boundary stays readable. That residual is deliberate and bounded from
 * both sides: a credential this process HOLDS is registered at its mint
 * and is masked byte-exact by the known-secret layer wherever its exact
 * bytes appear, whatever this set does; and inside a query string one of
 * these bytes genuinely cannot be part of a value unescaped. What remains
 * is an UNREGISTERED value declared in prose with a raw terminator byte
 * in it — a shape no registered credential needs, pinned as a stated
 * limit beside the declaration-lane tests.
 */
const VALUE_TERMINATORS = new Set([
  ..." \t\r\n\"'`,;)]}>&?#",
]);
/**
 * Punctuation that is sentence furniture when it TRAILS a value.
 *
 * `-`, `_` and `.` are included because a token that ENDS in a separator is a
 * fragment, not a credential — and the corpus proved it. Lowering the length
 * floor for `admin44` made `sk-...` (from a doc comment reading ``const
 * API_KEY = "sk-..."``) strip to `sk-`, three characters that then scored
 * just high enough to mask. Real credentials do not end in a separator; the
 * ellipsis in a piece of prose does.
 *
 * `=` is deliberately NOT here: it is base64 padding and part of the value.
 */
const TRAILING_PUNCTUATION = new Set([...".,;:!?)]}>-_"]);

/**
 * LAYER 2 (+3). Every region introduced by a declaration phrase whose shape
 * supports the reading.
 *
 * Deliberately procedural rather than one large regex. The rule has four
 * independent parts — find the cue, find the connector within a bound, skip
 * the delimiters, read and qualify the token — and each of them is a place a
 * defect can hide. Written out, each is separately testable and separately
 * mutable; folded into a single pattern, none of them are.
 */
export function declaredSecretSpans(
  text: string,
  tuning: DeclarationTuning = DECLARATION_TUNING,
  /**
   * The DERIVED and LEARNED vocabulary. The seed's canonical forms are the
   * regex below; everything a derivation rule produced and everything the
   * user's own writing taught arrives here, each carrying the weight of
   * where it came from.
   *
   * Optional, and omitting it is the seeded behaviour exactly — which is
   * what every call site that has no user scope should do.
   */
  lexicon: readonly LexiconEntry[] = EMPTY_LEXICON,
  /**
   * THE RESOLVED POLICY, REQUIRED — the layer has to know what the redactor
   * writes so it does not read the mask as the thing it masked. No default:
   * see `valueShapeSupport`.
   */
  policy: PrivacyPolicy,
): readonly IntelligenceSpan[] {
  if (text.length < tuning.minValueLength) return EMPTY_SPANS;
  const spans: IntelligenceSpan[] = [];
  // THE BENIGN REGIONS, COMPUTED ONCE FOR THE WHOLE STRING. A value that
  // lies inside a URL or a path is a LOCATION, whatever noun precedes it —
  // and the same enumeration that keeps layer 4 off `https://play.vuejs.org/
  // #eNo9jUEOgyAQ…` keeps this layer off `[useTemplateRef()](/api/composition
  // -api-helpers#usetemplateref)`, where the cue is the `api` in the path
  // itself. One enumeration, two layers, no second list.
  const regions = benignRegions(text);
  // One register answer per line, for the whole scan. See `RegisterCache`.
  const registers = createRegisterCache();
  // The cue regex is a module constant with the `g` flag, so its cursor
  // survives between calls. Reset it — the same discipline, and the same
  // reason, as `detectSensitiveSpans`: a `lastIndex` left by the previous
  // string starts this scan in the middle of this one.
  DECLARATION_CUE.lastIndex = 0;
  let cue: RegExpExecArray | null;
  while ((cue = DECLARATION_CUE.exec(text)) !== null) {
    if (cue[0].length === 0) {
      DECLARATION_CUE.lastIndex += 1;
      continue;
    }
    const cueEnd = cue.index + cue[0].length;
    if (!cueBoundaryOk(text, cue.index, cueEnd)) continue;
    const span = valueIntroducedAt(
      text,
      cue.index,
      cueEnd,
      cue[0],
      cue[STRONG_CUE_GROUP] !== undefined ? tuning.strongCueWeight : tuning.weakCueWeight,
      tuning,
      policy,
      regions,
      registers,
    );
    if (span !== null) spans.push(span);
  }
  // ── THE PERSONAL-IDENTIFIER CUES, THROUGH THE SAME SCANNER ─────────────
  //
  // Same window, same connector, same possessive, same benign regions, same
  // register, same evidence arithmetic and the same threshold. Only the noun
  // set and the shape test differ, which is what `DeclarationKind` carries.
  // Every cue here is unambiguous, so they all score `strongCueWeight`.
  PII_DECLARATION_CUE.lastIndex = 0;
  let piiCue: RegExpExecArray | null;
  while ((piiCue = PII_DECLARATION_CUE.exec(text)) !== null) {
    if (piiCue[0].length === 0) {
      PII_DECLARATION_CUE.lastIndex += 1;
      continue;
    }
    const cueEnd = piiCue.index + piiCue[0].length;
    if (!cueBoundaryOk(text, piiCue.index, cueEnd)) continue;
    const span = valueIntroducedAt(
      text,
      piiCue.index,
      cueEnd,
      piiCue[0],
      tuning.strongCueWeight,
      tuning,
      policy,
      regions,
      registers,
      IDENTIFIER_DECLARATION,
    );
    if (span !== null) spans.push(span);
  }

  // ── THE DERIVED AND LEARNED VOCABULARY, SECOND, AND THE ORDER MATTERS ──
  //
  // Both scans can find the same value: `my api key is X` carries the
  // canonical `api key` AND the derived `api`, and they introduce the same
  // token. `resolveOverlaps` keeps the FIRST of two equal-length spans, so
  // whichever scan ran first owns the explanation the user reads.
  //
  // Caught by a guard rather than by reasoning: the explanation went from
  // `follows "api key"` to `follows "api"` — same redaction, strictly worse
  // account of it. The canonical form is the better answer, so the canonical
  // scan goes first.
  spans.push(...lexiconCueSpans(text, lexicon, tuning, policy, regions, registers));
  return spans;
}

const EMPTY_LEXICON: readonly LexiconEntry[] = Object.freeze([]);
const NO_REGIONS: readonly BenignRegion[] = Object.freeze([]);

/**
 * THE LEXICON AS AN INDEX, NOT AS AN ALTERNATION.
 *
 * The obvious implementation is one regex with a branch per term, and it is
 * the wrong one: the seeded vocabulary alone derives to nearly six hundred
 * forms, and a six-hundred-branch automaton runs over every string leaf of
 * every response on the egress path. The measured budget for the whole
 * redaction pass is around a millisecond.
 *
 * A word scan plus a hash lookup is the same answer for a fraction of the
 * cost: one simple automaton over the text, then O(1) per word. It is also
 * EXACT rather than approximate — an alternation has to worry about one term
 * being a prefix of another, and a set lookup does not.
 *
 * Cached against the lexicon array's identity, which is a module constant in
 * the common case, so the index is built once per process for the seeded
 * vocabulary and once per scope for a learned one.
 */
type LexiconIndex = Readonly<{
  weights: ReadonlyMap<string, number>;
  minLength: number;
  maxLength: number;
  /**
   * A 26-bit mask of the first letters every term starts with.
   *
   * The lexicon holds a few hundred terms and a payload holds tens of
   * thousands of words, so the question asked most often by far is "is this
   * word NOT a cue". Answering it with a bit test costs one shift; answering
   * it with `toLowerCase()` and a hash lookup allocates a string per word.
   * Measured: the lexicon scan was the single most expensive layer on the
   * egress path at 1.27 microseconds per string leaf.
   */
  firstLetters: number;
}>;

const lexiconIndexCache = new WeakMap<object, LexiconIndex>();

function lexiconIndex(lexicon: readonly LexiconEntry[]): LexiconIndex {
  const cached = lexiconIndexCache.get(lexicon);
  if (cached !== undefined) return cached;
  const index = new Map<string, number>();
  for (const entry of lexicon) {
    // The canonical seed forms are the regex's job; indexing them here as
    // well would double every seeded detection and say nothing new.
    if (entry.origin === "seed-strong" || entry.origin === "seed-weak") continue;
    // Multi-word forms cannot match a single scanned word. They are the
    // separator variants, and the regex already carries `[\s._-]?`.
    if (/[^a-z0-9]/u.test(entry.term)) continue;
    const weight = lexiconWeight(entry.origin);
    const existing = index.get(entry.term);
    if (existing === undefined || weight > existing) index.set(entry.term, weight);
  }
  let minLength = Number.POSITIVE_INFINITY;
  let maxLength = 0;
  let firstLetters = 0;
  for (const term of index.keys()) {
    if (term.length < minLength) minLength = term.length;
    if (term.length > maxLength) maxLength = term.length;
    const first = term.charCodeAt(0);
    if (first >= 97 && first <= 122) firstLetters |= 1 << (first - 97);
  }
  const built: LexiconIndex = Object.freeze({
    weights: index,
    minLength: index.size === 0 ? Number.POSITIVE_INFINITY : minLength,
    maxLength,
    firstLetters,
  });
  lexiconIndexCache.set(lexicon, built);
  return built;
}

/** Whether a word could possibly be a lexicon term, by length and initial. */
function couldBeTerm(index: LexiconIndex, word: string): boolean {
  if (word.length < index.minLength || word.length > index.maxLength) return false;
  const first = word.charCodeAt(0);
  const lower = first >= 65 && first <= 90 ? first + 32 : first;
  if (lower < 97 || lower > 122) return false;
  return (index.firstLetters & (1 << (lower - 97))) !== 0;
}

/** Consume the complete Unicode word before lookup; digits and combining
 * marks or normalization-removed characters cannot expose a suffix as a
 * standalone lexicon cue. Letter-led camel components still use the existing
 * boundary owner below. */
const WORD_CHARACTER = new RegExp(
  `[\\p{L}\\p{N}\\p{M}${String.fromCodePoint(...NORMALIZATION_REMOVED_CODE_POINTS)}]`,
  "u",
);

/** Iterate complete runs without a quantified Unicode regexp's native stack.
 * Offsets stay in UTF16 units, including for astral code points. */
function* wordRuns(text: string): Iterable<Readonly<{ text: string; at: number }>> {
  let offset = 0;
  let start = -1;
  for (const character of text) {
    if (WORD_CHARACTER.test(character)) {
      if (start < 0) start = offset;
    } else if (start >= 0) {
      yield { text: text.slice(start, offset), at: start };
      start = -1;
    }
    offset += character.length;
  }
  if (start >= 0) yield { text: text.slice(start), at: start };
}

/** Whether a letter-led run contains an eligible camel transition. */
function hasCamelHump(run: string): boolean {
  // Lexicon cue candidates start with a letter. A digit-led token cannot acquire a cue
  // by splitting off its capitalized suffix; letter-led words still can.
  if (!/^\p{L}/u.test(run)) return false;
  for (let i = 1; i < run.length; i += 1) {
    if (isUpperAscii(run[i]!) && !isUpperAscii(run[i - 1]!)) return true;
  }
  return false;
}

/** The camel components of a run, with their offsets inside it. */
function* camelParts(run: string): Iterable<Readonly<{ text: string; at: number }>> {
  let start = 0;
  for (let i = 1; i < run.length; i += 1) {
    const previous = run[i - 1]!;
    const current = run[i]!;
    const hump = isUpperAscii(current) && !isUpperAscii(previous);
    if (!hump) continue;
    yield { text: run.slice(start, i), at: start };
    start = i;
  }
  if (start > 0) yield { text: run.slice(start), at: start };
}

function* wordCandidates(run: string): Iterable<Readonly<{ text: string; at: number }>> {
  yield { text: run, at: 0 };
  if (hasCamelHump(run)) yield* camelParts(run);
}

/**
 * Declarations introduced by a DERIVED or LEARNED term.
 *
 * THE COLLISION GUARD IS REGISTER, not a list of exceptions. `pass`, `key`
 * and `secret` are everywhere in source — `pass` is a test verb, `key` is a
 * map index — so a derived term found in CODE is worth a fraction of the
 * same term found in PROSE, where "the pass is X" is a person telling you
 * something. That is the whole answer to the collision problem, and it costs
 * no vocabulary at all.
 */
function lexiconCueSpans(
  text: string,
  lexicon: readonly LexiconEntry[],
  tuning: DeclarationTuning,
  policy: PrivacyPolicy,
  regions: readonly BenignRegion[],
  registers: RegisterCache,
): readonly IntelligenceSpan[] {
  if (lexicon.length === 0) return EMPTY_SPANS;
  const index = lexiconIndex(lexicon);
  if (index.weights.size === 0) return EMPTY_SPANS;
  const spans: IntelligenceSpan[] = [];
  for (const run of wordRuns(text)) {
    // Stream camel candidates too: a large alternating-case word must not
    // become an unbounded function-argument spread or a candidate array.
    for (const candidate of wordCandidates(run.text)) {
      // Two integer tests before the string is lowercased at all.
      if (!couldBeTerm(index, candidate.text)) continue;
      const weight = index.weights.get(candidate.text.toLowerCase());
      if (weight === undefined) continue;
      const start = run.at + candidate.at;
      const end = start + candidate.text.length;
      if (!cueBoundaryOk(text, start, end)) continue;
      const inCode = registerAt(text, start, undefined, registers) === "code";
      const effective = inCode ? Math.floor(weight / CODE_REGISTER_DIVISOR) : weight;
      if (effective <= 0) continue;
      const span = valueIntroducedAt(text, start, end, candidate.text, effective, tuning, policy, regions, registers);
      if (span !== null) spans.push(span);
    }
  }
  return spans;
}

/** How much a derived or learned term is discounted in code. Two, because
 * the claim is "worth materially less", not "worth nothing" — a derived cue
 * in code plus a possessive and a credential-shaped value still clears the
 * bar, and that combination is not something ordinary source produces. */
const CODE_REGISTER_DIVISOR = 2;

/**
 * Given a cue ending at `cueEnd`, the value it introduces — or null.
 *
 * The window stops at the first newline: a declaration and its value are on
 * one line, and letting the search cross a line break is how a cue in a
 * prose paragraph reaches the first token of the next code block.
 */
function valueIntroducedAt(
  text: string,
  cueStart: number,
  cueEnd: number,
  cueText: string,
  cueWeight: number,
  tuning: DeclarationTuning,
  /** The resolved policy, threaded to the shape test so the layer can tell
   * the redactor's own marker apart from a value. Required, and placed
   * before the defaulted parameters so it cannot be forgotten. */
  policy: PrivacyPolicy,
  regions: readonly BenignRegion[] = NO_REGIONS,
  registers: RegisterCache = createRegisterCache(),
  kind: DeclarationKind = CREDENTIAL_DECLARATION,
): IntelligenceSpan | null {
  // ── THE WINDOW: one line, one sentence, one clause ──────────────────────
  const hardEnd = Math.min(
    text.length,
    cueEnd + tuning.maxCueToConnector + tuning.maxConnectorToValue + MAX_DECLARED_VALUE_LENGTH,
  );
  // A line break in EITHER SPELLING ends the window — see `nextLineBreak`.
  const lineBreak = nextLineBreak(text, cueEnd);
  const newline = lineBreak === null ? -1 : lineBreak.index;
  let windowEnd = newline === -1 ? hardEnd : Math.min(hardEnd, newline);
  let endedByLine = newline !== -1 && newline <= hardEnd;
  const tail = text.slice(cueEnd, windowEnd);
  const sentence = SENTENCE_END.exec(tail);
  if (sentence !== null) {
    windowEnd = cueEnd + sentence.index;
    endedByLine = false;
  }
  // A CUE INSIDE A URL OR A PATH INTRODUCES NOTHING. `[useTemplateRef()](/api/
  // composition-api-helpers#usetemplateref)` carries the derived cue `api`
  // in the middle of a documentation link, and whatever follows it is the
  // rest of the link. Checked on the CUE rather than only on the value,
  // because a region can end before the value does — the fragment after `#`
  // is outside the path region, so a value-only check let exactly this case
  // through.
  if (withinBenignRegion(regions, cueStart, cueEnd) !== null) return null;
  const clause = unmatchedCloserIn(text.slice(cueEnd, windowEnd));
  if (clause !== -1) {
    windowEnd = cueEnd + clause;
    endedByLine = false;
  }
  let window = text.slice(cueEnd, windowEnd);
  let continued = false;

  // ── THE DECLARATION THAT CONTINUES ONTO THE NEXT LINE ───────────────────
  //
  // `<adafruitToken>\n    ffle19b0aw10e6av64xxc750d0j7sw8b\n</adafruitToken>`
  // and `"asana_token":\n  "0914220299320103"` are the same shape, and 576 of
  // the held-out misses were it: the cue's own line ends in nothing but
  // STRUCTURE — a closing angle bracket, a colon, a brace, an equals — and
  // the value is the next line.
  //
  // Permitted only when the line is what ended the window. If a full stop or
  // a closing bracket ended it, the declaration is over and the next line is
  // a different statement; without that condition "I lost my token.\nAnyway,
  // qX9f2c…" would join across a paragraph break.
  if (endedByLine && isStructuralOnly(window)) {
    const nextLine = firstNonBlankLineAfter(text, windowEnd, tuning);
    if (nextLine === null) return null;
    windowEnd = nextLine.end;
    window = text.slice(nextLine.start, nextLine.end);
    continued = true;
    cueEnd = nextLine.start;
  }
  if (window.length === 0) return null;

  // ── THE EVIDENCE, ACCUMULATED ───────────────────────────────────────────
  //
  // Read this as addition, not as a checklist. Under the conjunction this
  // replaced, every clause below was a VETO, so the weakest clause decided
  // the outcome — and the weakest clause is always the one nobody thought
  // of. `my password may be admin44` failed two of them at once (a
  // 12-character length floor, and a connector list without "may be") and
  // went to the provider intact. Extending either list would have restored
  // exactly the same fragility one phrasing further out.
  //
  // ANYONE TIDYING THIS BACK INTO A GATE SHOULD READ THAT PARAGRAPH TWICE.
  // An `if (!shaped) return null` here is not a simplification; it is the
  // original defect.
  const reasons: string[] = [];
  let evidence = 0;
  let fillerConnected = false;

  evidence += cueWeight;

  // A possessive BEFORE the cue: "my password", "our api key", "the user's
  // token". Evidence about the declaration, not about the value — which is
  // why it still counts when the value looks like nothing at all.
  const lookbackFrom = Math.max(0, cueStart - tuning.maxPossessiveLookback);
  const possessive = POSSESSIVE_BEFORE_CUE.test(text.slice(lookbackFrom, cueStart));
  if (possessive) {
    evidence += tuning.possessiveWeight;
    reasons.push("is described as yours");
  }

  const inCode = registerAt(text, cueStart, undefined, registers) === "code";
  const connectorPattern = inCode ? CONNECTOR_IN_CODE : CONNECTOR;
  connectorPattern.lastIndex = 0;
  const connector = continued ? null : connectorPattern.exec(window);
  let connected = connector !== null && connector.index <= tuning.maxCueToConnector;

  // ── PROXIMITY REPLACES THE CONNECTOR LIST ───────────────────────────────
  //
  // THE SECOND OF THE FOUR FIXES. `my password may be admin44` leaked
  // because "may be" was not in the connector list, and the response was to
  // add "may be" — which is the same fragility one phrasing further out, and
  // in a second language it is the whole list further out. `ma clef est X`
  // and `mi contrasena es X` fail identically, and no amount of English
  // verbs repairs them.
  //
  // WORD ORDER VARIES ACROSS LANGUAGES; PROXIMITY DOES NOT. Every language
  // this could be written in puts the value NEAR the noun that names it, and
  // what sits between them is a function word — `is`, `est`, `es`, `ist`,
  // `wa`, or nothing at all. So the rule stops asking WHICH word it is and
  // asks only whether the gap is small and shaped like a function word:
  // punctuation, whitespace, and at most one short word.
  //
  // The listed connectors are kept, and they still outrank this — an
  // explicit `=` or "is set to" is a stronger statement than adjacency. This
  // is the FALLBACK that stops the list from being load-bearing.
  if (!connected && !continued) {
    const gap = FILLER_GAP.exec(window);
    if (gap !== null && gap[0].length > 0 && gap[0].length <= tuning.maxFillerGap) {
      connected = true;
      fillerConnected = true;
    }
  }

  // The introduction is worth the same however it was made — a listed
  // connector, or a gap too small and too plain to be anything else. THE
  // EVIDENCE IS ADDED HERE, AFTER BOTH HAVE BEEN DECIDED. The first version
  // added it above, before the proximity fallback ran, so the fallback moved
  // where the value was READ from and contributed nothing to whether it was
  // BELIEVED — every proximity detection scored three points short of the
  // bar and none of them fired. Nothing about the code looked wrong; only a
  // case that should have been caught and was not said so.
  if (continued) {
    // The structure IS the connector: a line that ends in `>` or `:` or `=`
    // and hands the next line a lone value has introduced it as explicitly
    // as the word "is" does, in any markup language and in none.
    evidence += tuning.continuationWeight;
    reasons.push("is the value on the line below it");
  } else {
    evidence += connected ? tuning.connectorWeight : tuning.bareAdjacencyWeight;
    if (fillerConnected) reasons.push("sits where a value is introduced");
  }

  // ── THE VALUE ───────────────────────────────────────────────────────────
  const valueSearchFrom = connected
    ? (fillerConnected ? 0 : connector!.index + connector![0].length)
    : 0;
  let at = valueSearchFrom;
  const skipLimit = connected
    ? Math.min(window.length, valueSearchFrom + tuning.maxConnectorToValue + (fillerConnected ? tuning.maxFillerGap : 0))
    : Math.min(window.length, tuning.maxBareAdjacency);
  if (fillerConnected) {
    // The filler itself — punctuation, whitespace and at most one short word
    // — is what stands in for the connector, so the value starts after it.
    at = FILLER_GAP.exec(window)![0].length;
  }
  while (
    at < skipLimit &&
    (isSpace(window[at]!) ||
      VALUE_DELIMITERS.includes(window[at]!) ||
      (connected && POST_CONNECTOR_PUNCTUATION.includes(window[at]!)))
  ) at += 1;
  if (at >= window.length || at >= skipLimit) return null;

  // ── BARE ADJACENCY NEEDS AN ACTUAL BOUNDARY ─────────────────────────────
  //
  // With no connector, the only claim is that the value sits NEXT TO the cue —
  // so it has to be a separate token. `at === 0` means nothing was skipped,
  // i.e. the "value" is glued to the cue and is really the rest of one word.
  //
  // Measured: "the growth of recorded prompt sizes across this conversation's
  // token-usage" scored 6 and masked `-usage`. A possessive ("conversation's")
  // and a weak cue ("token") carried it, and `-usage` looked like a short
  // mixed-class token. It is a hyphenated word, and a hyphen is not a
  // declaration.
  if (!connected && !continued && at === 0) return null;

  // ── THE VALUE IS NOT ALWAYS THE NEXT WORD ───────────────────────────────
  //
  // REPORTED, in the user's own words: *"the password to be used is this one
  // I think like beauChev!"* — and it went out intact. The scanner read the
  // FIRST token after the connector, which is `this`, vetoed it as an
  // English word, and stopped. Five filler words stood between "is" and the
  // credential.
  //
  // This is the same defect as the connector list, one level in. There, the
  // rule assumed the introduction was a word we had listed; here it assumed
  // the value was in a fixed POSITION. Both are assumptions about phrasing,
  // and phrasing is exactly what varies — "is this one I think like X",
  // "est probablement X", "は多分Xです".
  //
  // So every token in the window is a candidate and the SHAPE decides which
  // one is the value, bounded by the same distance the connector was bounded
  // by. The vetoes are what make this safe rather than reckless: an English
  // word, an identifier, a path, a number, a hyphenated label and a call
  // expression are each provably not credentials, so a sentence of ordinary
  // words offers no candidate at all and the scan ends where it began.
  // Bounded by the SAME distance a connector was bounded by. Widening it
  // beyond that was measured and reverted: reaching 48 characters further
  // took ordinary-source hits from 1 to 14 across lodash, the vue docs and
  // psf/requests, because a long enough sentence eventually offers some
  // token that is not provably ordinary.
  const searchLimit = skipLimit;
  let token = "";
  let shape: ValueShapeSupport = "veto";
  let skipped = 0;
  let cursor = at;
  while (cursor < searchLimit) {
    while (
      cursor < searchLimit &&
      (isSpace(window[cursor]!) ||
        VALUE_DELIMITERS.includes(window[cursor]!) ||
        VALUE_TERMINATORS.has(window[cursor]!) ||
        (connected && POST_CONNECTOR_PUNCTUATION.includes(window[cursor]!)))
    ) cursor += 1;
    if (cursor >= searchLimit) break;
    let end = cursor;
    while (end < window.length && !VALUE_TERMINATORS.has(window[end]!)) end += 1;
    let trimmed = end;
    while (trimmed > cursor && TRAILING_PUNCTUATION.has(window[trimmed - 1]!)) trimmed -= 1;
    if (trimmed > cursor) {
      const candidate = window.slice(cursor, trimmed);
      // A BACKTICK IS THE AUTHOR SAYING "THIS IS CODE", and it is the only
      // register marker a person writes deliberately. In a doc comment,
      // `onAuthGate` is an identifier however prose-like the sentence around
      // it reads — which is exactly the case the line-level signals cannot
      // see, because the line IS a sentence.
      const backticked = cursor > 0 && window[cursor - 1] === "`";
      const candidateShape = kind.shapeOf(
        candidate, tuning, inCode || backticked, cueWeight >= tuning.strongCueWeight, policy,
      );
      if (candidateShape !== "veto") {
        at = cursor;
        token = candidate;
        shape = candidateShape;
        break;
      }
      skipped += 1;
    }
    cursor = end + 1;
  }
  if (token.length === 0) return null;

  // ── A VALUE WE HAD TO LOOK FOR MUST CARRY MORE ──────────────────────────
  //
  // A declaration normally puts the value immediately after the
  // introduction. When the first candidates were provably ordinary and the
  // scan walked past them, the value is no longer WHERE a declaration puts
  // it — so the position has stopped being evidence and the value's own
  // shape has to make the case alone.
  //
  // Measured: without this, `password = password.encode("latin1")` masks
  // `latin1` — a strong cue, a connector, and the first token that was not
  // an English word. With it, `latin1` is weak-shaped and refused, while
  // `beauChev` five words further out is strong-shaped and caught.
  //
  // AND ONLY A CANONICAL CUE MAY DO IT AT ALL. Measured: allowing any cue to
  // walk took ordinary-source hits from 1 to 25, because a camelCase
  // IDENTIFIER has the same internal capital a chosen password does —
  // `getAllKeysIn`, `keysFunc`, `symbolsFunc` — and the derived cue `keys`
  // sits right beside them in every line of the lodash source. A word that
  // names a credential and nothing else is entitled to look past a few
  // ordinary words for its value; a form nobody typed is not.
  if (skipped > 0 && (shape !== "strong" || cueWeight < tuning.strongCueWeight)) return null;

  evidence += shape === "strong" ? tuning.strongShapeWeight : tuning.weakShapeWeight;
  if (shape === "strong") reasons.push("has the shape of a credential");

  if (evidence < tuning.minEvidence) return null;

  const absoluteStart = cueEnd + at;
  // A LOCATION IS NOT A CREDENTIAL, whatever introduced it. Checked here,
  // after the token has been read, because the region a value falls in is a
  // fact about the value rather than about the cue.
  if (withinBenignRegion(regions, absoluteStart, absoluteStart + token.length) !== null) return null;
  return {
    startUtf16: absoluteStart,
    endUtf16: absoluteStart + token.length,
    signalId: kind.signalId,
    detectorId: "declaration",
    confidence: "inferred",
    // Value-free. The cue text is the USER'S OWN WORDS, quoted back so they
    // can check the judgement against what they actually typed — never any
    // part of the value that was masked.
    explanation:
      `follows "${collapseWhitespace(cueText)}"` +
      (reasons.length > 0 ? ` and ${reasons.join(", ")}` : "") +
      ` (evidence ${evidence}/${tuning.minEvidence})`,
  };
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r";
}

/**
 * A CLAUSE ENDED, which is what a sentence end looks like in code: the offset
 * of the first closing bracket in `tail` that has no matching opener inside
 * `tail`, or -1.
 *
 * `SENTENCE_END` is the prose form of this rule. Code has no full stops, and
 * the last measured false positive on ordinary source was exactly that gap:
 *
 *     auth = (unquote(parsed.username), unquote(parsed.password))  # type: ignore[arg-type]
 *
 * A strong cue (`password`), then — eleven characters and TWO CLOSING
 * PARENTHESES later, in a trailing comment — the `:` of `type:`, read as the
 * connector introducing `ignore[arg-type`. The noun's clause had ended twice
 * over before the connector appeared.
 *
 * "UNMATCHED" IS THE WHOLE RULE, and it is why a bare `/[)\]}]/` will not do —
 * that weaker form was written first and left unused beside this one.
 * `password: fn(a)` closes a bracket it also opened, so the clause has not
 * ended and the value search may continue; `…parsed.password))` closes
 * brackets opened before the cue, so the cue was an operand in something
 * already finished. Structural and language-free, and the same shape of bound
 * as the newline and the full stop.
 */
function unmatchedCloserIn(tail: string): number {
  let depth = 0;
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * Whether the remainder of the cue's line carries STRUCTURE and no value.
 *
 * The character set is punctuation only — no letters, no digits — so a line
 * that ends with any content at all is not structural, and the continuation
 * rule cannot reach past a value that is already there.
 */
function isStructuralOnly(window: string): boolean {
  for (const ch of window) {
    if (isSpace(ch)) continue;
    if (!STRUCTURAL_CHARACTERS.includes(ch)) return false;
  }
  return true;
}

/**
 * Punctuation a markup or configuration language puts between a name and
 * the value on the next line: `<tag>`, `"key":`, `key =`, `key: |`.
 *
 * A COMMA AND A SEMICOLON ARE DELIBERATELY ABSENT, because they TERMINATE an
 * item rather than introduce one. With them present, psf/requests produced
 * the only remaining false positive on ordinary source:
 *
 *     password=password,
 *     num_pools=self._pool_connections,
 *
 * The cue is the `password` on the right of the first line; its window is
 * the single character `,`, which read as "structure only, value is on the
 * next line" — and the next line's whole expression was masked. But that
 * comma closed the argument. `key:` and `key =` are still waiting for a
 * value; `key,` has already had one.
 */
const STRUCTURAL_CHARACTERS = "<>\"'`:={}[]()|-_.#/\\*+";

/**
 * THE NEXT LINE BREAK, IN EITHER SPELLING — real, or escaped.
 *
 * A declaration and its value sit on one line, and the window that looks for
 * the value stops at the line's end. That rule was written against a REAL
 * newline, and the corpus showed what it costs: a `.env` fragment carried
 * inside a JSON string, a log line, or a shell heredoc spells its line breaks
 * `\` `n` — two ordinary characters — and the window then ran on past the
 * value into the next assignment and found nothing it would accept.
 *
 *     ADOBE_TOKEN=708266cfeab817aaed88d81c23391298          (real \n)  FOUND
 *     {"config.ini": "ADOBE_TOKEN=708266…\nBACKUP_ENABLED=true"}       MISSED
 *
 * Same declaration, same value, same cue — only the spelling of the line
 * break differed. THIS IS THE ESCAPED-CONTENT FAILURE THIS CODEBASE HAS
 * ALREADY HAD ONCE, in the egress path, where escaped copies of a secret
 * went out beside a masked visible one.
 *
 * Structural and language-free: it is a fact about how text is encoded, not
 * about any provider or any vocabulary, so it costs nothing to maintain and
 * ages with nothing.
 *
 * ENDING A WINDOW EARLY IS THE SAFE DIRECTION. A Windows path (`C:\new`) and
 * a regex literal (`"\\n"`) both contain the escape by accident; treating
 * them as a line end can only make the window SHORTER, which can lose a
 * detection but can never invent one.
 */
type LineBreak = Readonly<{ index: number; width: number }>;

function nextLineBreak(text: string, from: number): LineBreak | null {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\n") return { index: i, width: 1 };
    if (ch !== "\\") continue;
    const next = text[i + 1];
    if (next === "n") return { index: i, width: 2 };
    if (next === "r" && text[i + 2] === "\\" && text[i + 3] === "n") return { index: i, width: 4 };
  }
  return null;
}

/**
 * The first line after `from` that carries something other than whitespace,
 * as the bounds of its content with the indentation stripped.
 *
 * Bounded by `maxContinuationLines` so a cue followed by a run of blank or
 * decorative lines cannot reach an unrelated paragraph.
 */
function firstNonBlankLineAfter(
  text: string,
  from: number,
  tuning: DeclarationTuning,
): Readonly<{ start: number; end: number }> | null {
  let cursor = from;
  for (let line = 0; line < tuning.maxContinuationLines; line += 1) {
    // `from` must sit exactly ON a break for the next line to be a
    // CONTINUATION of this declaration rather than an unrelated later line.
    const atBreak = cursor >= text.length ? null : nextLineBreak(text, cursor);
    if (atBreak === null || atBreak.index !== cursor) return null;
    cursor = atBreak.index + atBreak.width;
    const lineEnd = nextLineBreak(text, cursor);
    const end = lineEnd === null ? text.length : lineEnd.index;
    let start = cursor;
    while (start < end && isSpace(text[start]!)) start += 1;
    if (start < end) return { start, end };
    cursor = end;
  }
  return null;
}

/**
 * A capital letter after a lowercase one, inside a single word.
 *
 * `beauChev`, `myPassW`, `HunterTwo` — a shape prose does not produce and a
 * chosen password produces constantly. Deliberately requires the transition
 * to be INTERNAL: `Password` and `HTTP` are ordinary capitalisation.
 */
function hasInternalCapital(token: string): boolean {
  for (let i = 1; i < token.length; i += 1) {
    const previous = token[i - 1]!;
    const current = token[i]!;
    if (previous >= "a" && previous <= "z" && current >= "A" && current <= "Z") return true;
  }
  return false;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

// ── LAYER 3: shape, as support only ──────────────────────────────────────

/** Above this it is a document, not a credential. Not tunable: it bounds the
 * scan window, not the inference. */
const MAX_DECLARED_VALUE_LENGTH = 4096;

/** Strip the quotes/backticks/brackets a value may be wrapped in. */
function unwrap(token: string): string {
  let out = token;
  const pairs: readonly (readonly [string, string])[] = [
    ['"', '"'], ["'", "'"], ["`", "`"], ["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"],
  ];
  let changed = true;
  while (changed && out.length >= 2) {
    changed = false;
    for (const [open, close] of pairs) {
      if (out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(1, -1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * The parts of a token, split on the separators a human phrase uses. A token
 * whose parts are ALL alphabetic words is a hyphenated phrase
 * (`state-of-the-art-solution`) or a path (`src/cockpit/flow/Flow.svelte`) or
 * a dotted identifier (`process.env.OPENAI_API_KEY`) — never a credential,
 * because every real credential carries digits or a non-word alphabet
 * somewhere.
 */
/** Above this a word-then-number part is not label vocabulary. */
const MAX_LABEL_PART = 6;
/** At or above this length a part is long enough to BE a credential. */
const MIN_RANDOM_PART = 12;
/** Below this proportion of vowels a run reads as random rather than as a
 * word — the same rule, and the same number, the value-intrinsic layer uses. */
const MAX_LABEL_VOWEL_RATIO = 0.25;

function allPartsAreWords(token: string): boolean {
  // The separator class includes the SIGILS a package or handle carries.
  // Measured: `[pass via \`@vitejs/plugin-vue\` options](…)` matched the
  // derived cue `pass` and masked `@vitejs/plugin-vue`, because splitting on
  // `/` alone left `@vitejs`, which is not `[A-Za-z]+`, so the phrase failed
  // to look like a phrase. The same shape as the `#` fix in
  // `VALUE_DELIMITERS`: a leading sigil is punctuation, not content.
  const parts = token.split(/[-_./\\@#$%~+ ]+/u).filter((p) => p.length > 0);
  if (parts.length < 2) return false;
  // A NUMERIC PART DOES NOT STOP IT BEING A PHRASE. `A-private-memory-blob-
  // XYZ-12345` reached the derived cue `private` and masked
  // `memory-blob-XYZ-12345`, because the trailing `12345` is not
  // `[A-Za-z]+` and the whole thing therefore failed to look like a phrase.
  // Words and numbers joined by punctuation are a label; a credential's
  // segments are neither — `sk-ant-api03-Ab3xQ9zLmN2p` has `api03`, which is
  // a word and a number FUSED, and that is the difference.
  const isWord = (p: string): boolean => /^[A-Za-z]+$/u.test(p);
  const isNumber = (p: string): boolean => /^[0-9]+$/u.test(p);
  // A SHORT WORD-THEN-NUMBER PART is still label vocabulary: `v2`, `utf8`,
  // `sha256`, `part3`. Found by scanning every token in the window instead
  // of only the first — `my api key is in the file config-v2.json` then
  // reached `config-v2.json`, whose `v2` is neither a word nor a number, so
  // the label veto missed and a filename was masked.
  //
  // Bounded at six characters, and that bound is what keeps a credential
  // out: `api03` in `sk-ant-api03-Ab3xQ9zLmN2p…` is also word-then-number,
  // but the segment BESIDE it is sixty random characters, and a long
  // low-vowel run is refused below whatever its neighbours look like.
  const isShortWordNumber = (p: string): boolean =>
    p.length <= MAX_LABEL_PART && /^[A-Za-z]+[0-9]+$/u.test(p);
  if (!parts.every((p) => isWord(p) || isNumber(p) || isShortWordNumber(p))) return false;
  if (parts.some((p) => p.length >= MIN_RANDOM_PART && vowelRatio(p) < MAX_LABEL_VOWEL_RATIO)) {
    return false;
  }
  return parts.some(isWord);
}

/**
 * LAYER 3, as support only. Whether a token NEXT TO A DECLARATION has the
 * shape of a credential.
 *
 * This function is deliberately not exported as a detector and is never
 * called except from `declaredSecretSpans`. Called on its own it would be
 * exactly the entropy-alone detector that false-positives on every id, hash
 * and base64 blob in a payload.
 *
 * The rejections are each a false positive that was measured, not imagined:
 * `process.env.OPENAI_API_KEY` (a dotted identifier — masking it destroys the
 * code and hides nothing), `src/keys/id_rsa` (a path), `not-configured` (a
 * hyphenated phrase), `https://api.example.com/v1` (a URL).
 */
export type ValueShapeSupport = "veto" | "weak" | "strong";

export function valueShapeSupport(
  rawToken: string,
  tuning: DeclarationTuning = DECLARATION_TUNING,
  /** Whether the value sits on a line written as code. Defaults to true —
   * the conservative reading, so a caller that does not know the register
   * gets the veto rather than the exception. */
  inCode = true,
  /** Whether the noun that introduced it names a credential and nothing
   * else. Defaults to false, the conservative reading. */
  cueIsUnambiguous = false,
  /**
   * THE RESOLVED POLICY, AND IT HAS NO DEFAULT ON PURPOSE.
   *
   * The idempotence check below has to know what the redactor writes, and
   * that is `policy.redactionPrefix` — a configurable. Giving this parameter
   * a default would restore exactly the bug it exists to prevent: a caller
   * that forgot to thread the configured policy would silently be judged
   * against the built-in marker. Required, so forgetting is a compile error.
   */
  policy: PrivacyPolicy,
): ValueShapeSupport {
  // ── IDEMPOTENCE, WHICH THE CORPUS CAUGHT AND THE AUTHOR DID NOT ─────────
  //
  // `const API_KEY = "[REDACTED:credential]"` is a declaration followed by a
  // token that passes every shape rule: 19 characters, three character
  // classes, high entropy. So the first version of this function masked the
  // MARKER — meaning a second redaction pass changed the output of the
  // first, and the egress choke point runs exactly two passes. Idempotence is
  // not a nicety here; it is what makes the second pass affordable at all.
  //
  // Found by running the shape test over 7,450 real strings from this
  // repository, where it fired on a doc comment in `server/redaction.ts` that
  // shows a before/after example. One false positive in 7,450, and it was a
  // structural defect rather than a threshold being slightly wrong.
  //
  // Tested BEFORE `unwrap`, and that ordering is the whole fix: `unwrap`
  // strips the marker's own square brackets, so an unwrapped
  // `[REDACTED:credential]` is `REDACTED:credential`, which no longer
  // contains the prefix being looked for. See `MARKER_CORE` for the two
  // silent failures this one predicate went through.
  if (isRedactionMarker(rawToken, policy)) return "veto";
  const token = unwrap(rawToken);
  if (token.length < tuning.minValueLength) return "veto";
  if (token.length > MAX_DECLARED_VALUE_LENGTH) return "veto";
  if (/\s/u.test(token)) return "veto";
  // A URL is a location, not a credential. (A URL WITH a credential in it is
  // caught by the credential the cue introduces, not by the URL.)
  //
  // `^\/\/` is the same rule for a URL whose scheme has already been eaten.
  // Measured on psf/requests: `use the \`http://user:password@host/\`` matched
  // the cue `Auth`, took the `:` of `http:` as its connector, and masked
  // `//user:password@host/` — the veto missed because the `http` was on the
  // other side of the connector.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(token) || token.startsWith("//")) return "veto";
  // ── LETTERS ONLY, AND THE ONE CASE THAT IS NOT A WORD ──────────────────
  //
  // Letters and underscores with no digits is usually an identifier
  // (`OPENAI_API_KEY`, `accessToken`) or an English word ("unfortunately",
  // "missing", "documented"), and masking one of those destroys a sentence
  // to hide nothing.
  //
  // BUT NOT ALWAYS, and the exception was reported rather than imagined:
  // *"the password to be used is this one I think like beauChev!"*. The
  // value is eight letters, and it went out intact.
  //
  // What separates `beauChev` from `missing` is a CASE TRANSITION INSIDE THE
  // WORD. Prose does not capitalise a letter in the middle of a word — not
  // in English, not in German, not in any Latin-script language — and people
  // choosing a memorable password do it constantly. It is a structural fact
  // about the token, with no vocabulary in it.
  //
  // REGISTER DECIDES WHETHER THE EXCEPTION APPLIES. In CODE, an internal
  // capital is camelCase and the token is an identifier, which is the single
  // most common false positive shape there is (`accessToken`, `apiKey`). In
  // PROSE it is a chosen word. Same characters, opposite meanings, and the
  // register is what tells them apart.
  //
  // STATED LIMITATION, unchanged: an all-lowercase passphrase is still
  // refused — `my password is correcthorse` is NOT masked. There is nothing
  // in those letters to distinguish them from the sentence around them.
  if (/^[A-Za-z_$]+$/u.test(token)) {
    if (inCode) return "veto";
    if (!hasInternalCapital(token)) return "veto";
    // AND ONLY BEHIND AN UNAMBIGUOUS NOUN. Measured on this repository's own
    // doc comments: `authCookieAttributes`, `rateLimitPerMinute`,
    // `adapterIds` and `setAuthCookie` are camelCase identifiers sitting in
    // prose sentences next to derived cues (`auth`, `tokens`, `keys`) — the
    // same shape as a chosen password and none of the meaning.
    //
    // A word that names a credential and NOTHING else is entitled to make an
    // all-letters value believable. `password` is; `auth` and `keys` are not.
    if (!cueIsUnambiguous) return "veto";
    // AN UPPERCASE RUN IS AN ACRONYM, and an acronym inside a word is a
    // compound identifier. `SharedLLMClient` carries `LLM`; a person
    // choosing a password they have to type does not hold shift for three
    // letters in the middle of it.
    if (/[A-Z]{2,}/u.test(token.slice(1))) return "veto";
    // STRONG, and the word is earned. Prose does not capitalise mid-word in
    // any Latin-script language; a person choosing a memorable password does
    // it constantly. It is as sharp a distinction as a digit would be, and
    // it is the only reason `beauChev` is separable from `beauchev`.
    return "strong";
  }
  // A short pure number is a count, a port or a version — "my token count is
  // 512", "the model produced 512 tokens". Deliberately vetoed even though it
  // means a numeric PIN is not caught: masking `512` everywhere costs more
  // than missing a four-digit secret that should never have been one.
  if (/^\d{1,4}$/u.test(token)) return "veto";
  // ── A LONG DIGIT RUN INTRODUCED BY A CREDENTIAL NOUN IS A CREDENTIAL ────
  //
  // `asanaToken = "0914220299320103"` and `discordToken =
  // "09481738041738042946125612627580"` are all-digit keys, and a
  // digits-only token has ONE character class, so it scored the weak weight
  // and fell two points short of the bar. Together they are a quarter of
  // what remained unmasked on the held-out corpus.
  //
  // Safe HERE and nowhere else: this function is only ever reached when a
  // word naming a credential already introduced the value, so it is not
  // "mask long numbers", it is "a number this long, called a token, is a
  // token". The value-intrinsic layer still refuses digit runs outright,
  // which is why counts, ids and row numbers elsewhere are untouched.
  //
  // Epoch timestamps are excluded by shape, because `token_expires =
  // 1753000000000` is the one plausible way a credential noun legitimately
  // introduces a long number.
  if (/^\d{12,}$/u.test(token)) {
    return /^1\d{9}$|^1\d{12}$/u.test(token) ? "weak" : "strong";
  }
  // A CALL EXPRESSION IS CODE, NOT A CREDENTIAL.
  //
  // Found on held-out data — 14 of the 14 false positives in `psf/requests`
  // were this one shape:
  //
  //     username, password = get_auth_from_url(proxy)
  //     headers["Proxy-Authorization"] = _basic_auth_str(username, password)
  //
  // A strong cue (`password`), an explicit connector (`=`) and a token with
  // mixed classes and high entropy — the score clears the bar easily, and
  // masking it destroys the line while hiding nothing, because the secret is
  // not there at all. No credential contains a parenthesis.
  // Extended from parentheses to EVERY bracket by the same evidence, one
  // corpus later: `# type: ignore[arg-type]` in a psf/requests type comment
  // reached the cue `Auth`, took the `:` of `type:` and masked
  // `ignore[arg-type`. No credential contains a bracket of any kind.
  if (/[()[\]{}]/u.test(token)) return "veto";
  // AN INTERIOR `=` FOLLOWED BY A WORD is an assignment, not a value.
  // `persisted=true`, `keyFilePath=null` — pairs that happen to sit after a
  // credential noun in a doc comment.
  //
  // NARROWED TO A WORD ON THE RIGHT, and the narrowing was measured rather
  // than reasoned: vetoing every interior `=` cost 3.2 percentage points of
  // held-out detection, because plenty of real keys carry `=` inside them
  // (`Y?tzmBZBThgFVginAOiy_.PirbsD-U5rf=L9HUXS-ZdKhyqACHEig8n0raz9ucrqyXp=`).
  // What an assignment has and a key does not is an ordinary WORD after the
  // equals sign.
  if (/=[A-Za-z]{2,}$/u.test(token) && !/[0-9]/u.test(token.split("=").pop() ?? "")) {
    return "veto";
  }
  // A hyphenated phrase, a path, or a dotted identifier.
  if (allPartsAreWords(token)) return "veto";

  // ── NOT A VETO — SUPPORT ────────────────────────────────────────────────
  // Everything below is evidence to be WEIGHED, not a requirement to be met.
  // A token that fails all of it is still masked when the declaration around
  // it is strong enough, which is the entire point of the scoring model and
  // the whole reason `admin44` is caught.
  const classes = characterClassCount(token);
  if (classes < 2) return "weak";
  if (token.length < tuning.minShapeQualifyingLength) return "weak";
  if (shannonEntropyBits(token) >= tuning.minEntropyBits) return "strong";
  // Low entropy but long and mixed: a repeated-word passphrase. Length is
  // carrying the claim here, and the declaration is still what licenses it.
  return token.length >= tuning.lowEntropyLengthFloor ? "strong" : "weak";
}

/**
 * Whether a token could be a credential at all — i.e. is not VETOED.
 *
 * Kept as a named predicate because "provably not a credential" is a
 * different and much stronger statement than "does not look like one", and
 * the guards assert against the first.
 */
export function isSecretShapedValue(
  rawToken: string,
  tuning: DeclarationTuning = DECLARATION_TUNING,
  /** The policy in force — see `valueShapeSupport`, which deliberately gives
   * this no default so a caller cannot be judged against the built-in
   * marker while central config is using a different one. */
  policy: PrivacyPolicy,
): boolean {
  return valueShapeSupport(rawToken, tuning, true, false, policy) !== "veto";
}
