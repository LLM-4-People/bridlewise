/** Privacy operational defaults — canonical owner for privacy-domain configurable values.
 * Also owns `DEFAULT_PRIVACY_MAX_LINES` (the file-viewer full-mode line
 * cap) which was a bare `10_000` inline literal in file-viewer.ts while its
 * sibling caps (maxFileBytes, maxRegexPatternBytes) already derived from
 * here — a scattered configurable with no owner. */
import { DATA_CLASSIFICATION, type DataClassification } from "./classification-catalog.ts";

export const DEFAULT_PRIVACY_MAX_CONTEXT_LINES = 10;
export const DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES = 4_096;
export const DEFAULT_PRIVACY_MAX_FILE_BYTES = 1_048_576;
export const DEFAULT_PRIVACY_MAX_MATCH_COUNT = 1_000;
export const DEFAULT_PRIVACY_MAX_LINES = 10_000;

/**
 * HOW MANY TIMES A URL CREDENTIAL IS PERCENT-DECODED to find the spellings a
 * text may carry it in (`secret-parts.ts` `urlCredentialSpellings`): 2 covers
 * a double-encoded value (`%2540` → `%40` → `@`). Each level adds at most one
 * spelling per part, so the held set stays linear in the URL — decoding to a
 * fixed point held every level of a nested `%25…` run, and a few-KB image
 * link stalled the request mint for seconds (a2b-correctness H-1). Config
 * leaf `privacy.urlDecodeLevels`, between 0 and the maximum below.
 */
export const DEFAULT_PRIVACY_URL_DECODE_LEVELS = 2;
/** The most decode levels the section accepts (the spellings stay a small multiple of the URL). */
export const MAXIMUM_PRIVACY_URL_DECODE_LEVELS = 8;

/**
 * THE ROOT MINIMUM of which data classifications require redaction.
 *
 * A privacy control that ships without credential secrets and user-private
 * data in scope is a redaction engine with its subject removed, so this set
 * is not merely the default — it is the floor. The config door derives its
 * narrowing refusal from this declaration (a configured
 * `piiClassifications` that drops a member of this minimum is refused), so
 * the floor and the default can never drift into two owners. Central config
 * may only ADD classifications (a tightening: more kinds of data become
 * required to redact), never remove these.
 *
 * Declared HERE and not in `privacy-policy.ts` (the module that RESOLVES
 * it): a default its own module resolves is never exported — the resolved
 * policy field is the answer, and the exported default would hand
 * consumers a second, configuration-blind source of the same fact.
 */
export const DEFAULT_PII_CLASSIFICATIONS: readonly DataClassification[] = Object.freeze([
  DATA_CLASSIFICATION.credentialSecret,
  DATA_CLASSIFICATION.userPrivate,
]);

/**
 * WHICH DETECTION TIERS ARE ON BY DEFAULT — the one owner of the answer.
 *
 * The registry (`pii-registry.ts`) declares WHAT each tier is and what it
 * costs; this file decides what a fresh install does. Two owners for two
 * different questions, and the settings surface projects both rather than
 * restating either.
 *
 * ALL FIVE ARE ON. A privacy control that ships off is a privacy control
 * nobody has; the user's instruction was "do all tiers", and the point of
 * the switches is that a user who finds one wrong for their work can turn
 * exactly that one off, not that we ship undecided.
 *
 * The keys are the tier ids from `pii-registry.ts`. They are spelled here
 * rather than imported because a default must be readable without loading
 * the registry, and the registry asserts at load that the two agree.
 */
export const DEFAULT_PRIVACY_TIERS_ENABLED: Readonly<Record<
  "self-validating" | "grammar-defined" | "known-values" | "value-intrinsic" | "declared-values",
  boolean
>> = Object.freeze({
  "self-validating": true,
  "grammar-defined": true,
  "known-values": true,
  "value-intrinsic": true,
  "declared-values": true,
});

/**
 * TYPES SWITCHED OFF INDIVIDUALLY, inside a tier that is otherwise on.
 *
 * Empty, and that is a decision rather than an oversight: every declared
 * type earns its place by default, and the ones with the sharpest trade-offs
 * (network addresses against version numbers, phone numbers against digit
 * runs) state that trade-off in their registry entry so a user who hits it
 * knows exactly which switch to flip.
 */
export const DEFAULT_PRIVACY_TYPES_DISABLED: readonly string[] = Object.freeze([]);
