import { deepFreeze } from "../kernel/integrity.ts";
import { SECRET_TEXT_SIGNAL_CATALOG } from "./secret-signals.ts";
import { InputError } from "../kernel/errors.ts";
import {
  classificationRank,
  DATA_CLASSIFICATION,
  type DataClassification,
} from "./classification-catalog.ts";

/**
 * Canonical privacy policy authority — the single owner of PII categories,
 * redaction rules, retention, and evidence exposure behavior.
 *
 * This module is the one canonical policy consumed by file viewing, logging,
 * metrics, memory, and evidence handlers. It derives its non-configurable
 * safety floor from the root policy (`DATA_CLASSIFICATION`, secret detector
 * floor) and exposes configurable limits (context window, replacement
 * format, category enablement) that central config may tighten but never
 * weaken below the floor.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 *
 * Binding authorities:
 * delivery map item 11: "Provide full/regex/semantic file
 * viewing that redacts only configured credential/PII spans while
 * retaining structure. Admission, viewing, logging, metrics, memory,
 * research, and evidence use the same central policy and typed parser
 * outcomes. Unsupported parsing blocks semantic claims; it does not
 * hide the whole file or silently pass it."
 * Canonical USR-055 / DER-041 / Gate 40: minimum-value redaction,
 * safe-name preservation, fail-closed on uncertainty, no raw egress.
 * Root policy `modelRepositoryInspectionArchitecture.authorizedTextRedaction`:
 * credential presence alone does not reject the whole authorized text;
 * replace only the detected credential value; preserve safe names,
 * syntax/structure, line count, useful context, and a stable
 * non-recoverable span map.
 */

export const PRIVACY_POLICY_SCHEMA_VERSION = schemaId("privacy-policy", 1);

/**
 * Canonical default values for the configurable privacy-policy limits. These
 * are the single source of truth for the defaults; `createPrivacyPolicy` and
 * downstream consumers (file-viewer, tool-registry) import them rather than
 * duplicating the literals. Central config may tighten any limit, but never
 * below the safety floor enforced in `createPrivacyPolicy`.
 */
import { DEFAULT_PRIVACY_MAX_CONTEXT_LINES, DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES, DEFAULT_PRIVACY_MAX_FILE_BYTES, DEFAULT_PRIVACY_MAX_MATCH_COUNT, DEFAULT_PRIVACY_MAX_LINES, DEFAULT_PII_CLASSIFICATIONS, DEFAULT_PRIVACY_URL_DECODE_LEVELS, MAXIMUM_PRIVACY_URL_DECODE_LEVELS } from "./privacy-config.ts";
import { DEFAULT_HELD_MINIMUM_LENGTH, MIN_KNOWN_SECRET_LENGTH } from "./secret-intelligence.ts";
import { schemaId } from "../kernel/product-identity.ts";
export { DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES } from "./privacy-config.ts";
export { DEFAULT_PRIVACY_MAX_FILE_BYTES } from "./privacy-config.ts";
export { DEFAULT_PRIVACY_MAX_LINES } from "./privacy-config.ts";

/**
 * The redaction category describes *why* a span was redacted. Each category
 * maps to a stable replacement label that preserves surrounding structure
 * while hiding the sensitive value.
 */
export const REDACTION_CATEGORIES = deepFreeze([
  "secret",
  "credential",
  "pii",
  "api-key",
  "token",
  "password",
  "private-key",
  "bearer-token",
  "session-token",
  "cookie",
  "unknown-sensitive",
] as const);

export type RedactionCategory = typeof REDACTION_CATEGORIES[number];

/**
 * The redaction replacement format. The default is `[REDACTED:<type>]` which
 * preserves the surrounding structure (delimiters, quotes, line position)
 * while replacing only the sensitive value.
 *
 * ── NOT EXPORTED, AND THAT IS THE ENFORCEMENT ───────────────────────────────
 *
 * A default is an INPUT TO RESOLUTION, never a value a consumer reads. The
 * resolved answer is `policy.redactionPrefix`; anything that reads the default
 * instead diverges the moment central config supplies a different one, and
 * every test in the suite runs on default config, so the divergence is
 * invisible by construction rather than merely untested.
 *
 * That is not hypothetical here. `secret-intelligence.ts` imported this
 * constant to recognise the engine's OWN replacement marker. Configure
 * `redactionPrefix: "<HIDDEN:"` and the recogniser still looked for
 * `[REDACTED:`, so the declaration layer read the redactor's own output as a
 * declared credential, verification found a "residual secret", and the
 * evidence handler returned empty content — configuring the marker destroyed
 * the evidence it was supposed to mark.
 *
 * Keeping the binding module-private makes that unreachable by shape rather
 * than merely discouraged: a consumer cannot read what it cannot name, so
 * forgetting is a compile error instead of a runtime divergence. Everything
 * that needs the format takes a resolved `PrivacyPolicy`.
 */
const DEFAULT_REDACTION_PREFIX = "[REDACTED:" as const;
const DEFAULT_REDACTION_SUFFIX = "]" as const;

/**
 * A redaction rule binds a signal category (from `secret-signals.ts` or PII
 * classification) to a redaction category and replacement format.
 */
export type RedactionRule = Readonly<{
  signalId: string;
  category: RedactionCategory;
  replacement: string;
}>;

/**
 * The canonical privacy policy. One instance is shared across all consumers
 * (viewing, logging, metrics, memory, evidence). The policy is frozen after
 * construction.
 */
export type PrivacyPolicy = Readonly<{
  schemaVersion: typeof PRIVACY_POLICY_SCHEMA_VERSION;
  redactionCategories: readonly RedactionCategory[];
  rules: readonly RedactionRule[];
  redactionPrefix: string;
  redactionSuffix: string;
  enabledCategories: ReadonlySet<RedactionCategory>;
  piiClassifications: readonly DataClassification[];
  maxContextLines: number;
  maxFileBytes: number;
  /** The full-mode line cap the file viewer enforces. */
  maxLines: number;
  maxRegexPatternBytes: number;
  maxMatchCount: number;
  semanticModeEnabled: boolean;
  preserveLineCount: boolean;
  preserveStructure: boolean;
  failClosedOnUncertainty: boolean;
  /** Held operation credentials shorter than this are replaced in their own slot only, never matched in text (the held-set owner applies it). */
  heldCredentialMinimumLength: number;
  /** How many times a URL credential is percent-decoded for the spellings a text may carry it in. */
  urlDecodeLevels: number;
}>;

/**
 * Build a redaction replacement string for a given category.
 */
export function redactionReplacement(category: RedactionCategory, policy: PrivacyPolicy): string {
  return `${policy.redactionPrefix}${category}${policy.redactionSuffix}`;
}

/**
 * The catalog entry of a published-format secret signal. An id the catalog
 * does not hold is a typed error, never a silent fallback category (a new
 * signal that forgot its entry became `unknown-sensitive` in one reader and
 * `credential` in another: wf1b2-design SC-2).
 */
export function secretTextSignal(signalId: string): (typeof SECRET_TEXT_SIGNAL_CATALOG)[number] {
  const signal = SECRET_TEXT_SIGNAL_CATALOG.find((entry) => entry.id === signalId);
  if (signal === undefined) throw new InputError(`the secret signal ${signalId} is not in the catalog`, "redaction_signal_unknown");
  return signal;
}

/**
 * Map a secret-signal id to a redaction category.
 */
export function signalIdToCategory(signalId: string): RedactionCategory {
  return secretTextSignal(signalId).category;
}

/**
 * Map a data classification to a redaction category.
 */
export function classificationToCategory(classification: DataClassification): RedactionCategory {
  switch (classification) {
    case DATA_CLASSIFICATION.credentialSecret:
      return "secret";
    case DATA_CLASSIFICATION.userPrivate:
      return "pii";
    case DATA_CLASSIFICATION.regulatedRestricted:
      return "pii";
    default:
      return "unknown-sensitive";
  }
}

const DEFAULT_RULES: readonly RedactionRule[] = deepFreeze(SECRET_TEXT_SIGNAL_CATALOG.map((signal) => ({
  signalId: signal.id, category: signal.category, replacement: `[REDACTED:${signal.category}]`,
})));

/**
 * WHICH CLASSIFICATIONS REQUIRE REDACTION when nobody says otherwise — the
 * policy's own resolution of `DEFAULT_PII_CLASSIFICATIONS` (the defaults
 * owner's declaration, and the redaction floor the config door derives its
 * narrowing refusal from). Module-private for the same reason the marker
 * default is: the resolved answer is `policy.piiClassifications`, and an
 * exported default would hand a consumer a second, configuration-blind
 * source of the same fact.
 */

/**
 * Options for constructing a privacy policy. Central config supplies these;
 * the root policy safety floor is enforced regardless of options.
 */
export type PrivacyPolicyOptions = Readonly<{
  enabledCategories?: readonly RedactionCategory[];
  piiClassifications?: readonly DataClassification[];
  maxContextLines?: number;
  maxFileBytes?: number;
  maxLines?: number;
  maxRegexPatternBytes?: number;
  maxMatchCount?: number;
  semanticModeEnabled?: boolean;
  preserveLineCount?: boolean;
  preserveStructure?: boolean;
  failClosedOnUncertainty?: boolean;
  heldCredentialMinimumLength?: number;
  urlDecodeLevels?: number;
  redactionPrefix?: string;
  redactionSuffix?: string;
}>;

/**
 * WHICH CATEGORIES ARE ON when nobody says otherwise — all of them.
 *
 * Deliberately a separate, module-private binding rather than a direct read of
 * `REDACTION_CATEGORIES`, because the two answer different questions.
 * `REDACTION_CATEGORIES` is the enumeration of what EXISTS and consumers
 * legitimately read it to know the universe; this is the POLICY DEFAULT for
 * what is enabled, and the resolved answer to that question is
 * `policy.enabledCategories`. Keeping the default distinct from the
 * enumeration means narrowing the default later cannot silently narrow what
 * every other consumer believes exists.
 */
const DEFAULT_ENABLED_CATEGORIES: readonly RedactionCategory[] = REDACTION_CATEGORIES;

const FLOOR_MAX_CONTEXT_LINES = 1;
const FLOOR_MAX_FILE_BYTES = 1;
const FLOOR_MAX_LINES = 1;
const FLOOR_MAX_REGEX_PATTERN_BYTES = 1;
const FLOOR_MAX_MATCH_COUNT = 1;
const FLOOR_HELD_CREDENTIAL_MINIMUM_LENGTH = 1;
const FLOOR_URL_DECODE_LEVELS = 0;

export function createPrivacyPolicy(options: PrivacyPolicyOptions = {}): PrivacyPolicy {
  const enabledCategories = new Set<RedactionCategory>(
    enforceNonEmptyList(
      options.enabledCategories ?? DEFAULT_ENABLED_CATEGORIES,
      "enabledCategories",
      "no category enabled means every span is skipped and the residual-secret check then certifies the unredacted text as verified",
    ),
  );
  const piiClassifications = enforceNonEmptyList(
    options.piiClassifications ?? DEFAULT_PII_CLASSIFICATIONS,
    "piiClassifications",
    "no classification listed means nothing at all requires redaction, including credential secrets",
  );
  const maxContextLines = enforceFloor(
    options.maxContextLines ?? DEFAULT_PRIVACY_MAX_CONTEXT_LINES,
    FLOOR_MAX_CONTEXT_LINES,
    "maxContextLines",
  );
  const maxFileBytes = enforceFloor(
    options.maxFileBytes ?? DEFAULT_PRIVACY_MAX_FILE_BYTES,
    FLOOR_MAX_FILE_BYTES,
    "maxFileBytes",
  );
  const maxLines = enforceFloor(
    options.maxLines ?? DEFAULT_PRIVACY_MAX_LINES,
    FLOOR_MAX_LINES,
    "maxLines",
  );
  const maxRegexPatternBytes = enforceFloor(
    options.maxRegexPatternBytes ?? DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES,
    FLOOR_MAX_REGEX_PATTERN_BYTES,
    "maxRegexPatternBytes",
  );
  const maxMatchCount = enforceFloor(
    options.maxMatchCount ?? DEFAULT_PRIVACY_MAX_MATCH_COUNT,
    FLOOR_MAX_MATCH_COUNT,
    "maxMatchCount",
  );
  const semanticModeEnabled = options.semanticModeEnabled ?? false;
  const preserveLineCount = options.preserveLineCount ?? true;
  const preserveStructure = options.preserveStructure ?? true;
  // FAIL CLOSED BY DEFAULT: an unparseable file is refused rather than shown
  // best-effort unless a caller writes `false` (the config document says true;
  // the code default used to disagree — cfg-audit §0, a security weakening).
  const failClosedOnUncertainty = options.failClosedOnUncertainty ?? true;
  // Bounded on BOTH sides here, not only by the config schema: raising the
  // held floor stops matching (a weakening), so a programmatic policy is held
  // to the same ceiling — a value the registry's own floor long is always
  // matched (a2b-design H1). The URL decode bound keeps the held spellings
  // linear in the URL (a2b-correctness H-1).
  const heldCredentialMinimumLength = enforceRange(
    options.heldCredentialMinimumLength ?? DEFAULT_HELD_MINIMUM_LENGTH,
    FLOOR_HELD_CREDENTIAL_MINIMUM_LENGTH,
    MIN_KNOWN_SECRET_LENGTH,
    "heldCredentialMinimumLength",
  );
  const urlDecodeLevels = enforceRange(
    options.urlDecodeLevels ?? DEFAULT_PRIVACY_URL_DECODE_LEVELS,
    FLOOR_URL_DECODE_LEVELS,
    MAXIMUM_PRIVACY_URL_DECODE_LEVELS,
    "urlDecodeLevels",
  );
  const redactionPrefix = enforceMarkerFloor(
    options.redactionPrefix ?? DEFAULT_REDACTION_PREFIX,
  );
  const redactionSuffix = options.redactionSuffix ?? DEFAULT_REDACTION_SUFFIX;

  const rules = DEFAULT_RULES.map((rule) => ({
    ...rule,
    replacement: `${redactionPrefix}${rule.category}${redactionSuffix}`,
  }));

  return deepFreeze({
    schemaVersion: PRIVACY_POLICY_SCHEMA_VERSION,
    redactionCategories: [...REDACTION_CATEGORIES],
    rules,
    redactionPrefix,
    redactionSuffix,
    enabledCategories,
    piiClassifications: [...piiClassifications],
    maxContextLines,
    maxFileBytes,
    maxLines,
    maxRegexPatternBytes,
    maxMatchCount,
    semanticModeEnabled,
    preserveLineCount,
    preserveStructure,
    failClosedOnUncertainty,
    heldCredentialMinimumLength,
    urlDecodeLevels,
  });
}

/**
 * A MARKER THAT CANNOT IDENTIFY ITSELF IS REFUSED, not quietly accepted.
 *
 * The redaction marker is the one configurable that the engine has to read
 * back: after masking, the same detector runs over the result to prove
 * nothing sensitive survived, and it has to be able to tell its own
 * replacement apart from a value. An EMPTY prefix makes that impossible in
 * both directions at once — the replacement `${""}${category}${""}` is a bare
 * word indistinguishable from prose, and a recogniser asking "does this token
 * contain the prefix" answers YES for every token in existence, which silently
 * disables the whole declaration layer.
 *
 * So the floor is refusal at the single door where a policy is born, matching
 * the `min(1)` the central config schema already states for this key. Deny by
 * default: an unusable marker is an error, never a value that is accepted and
 * then behaves as if a security layer had been switched off.
 */
/**
 * The same floor the marker gets, for the two list-shaped configurables.
 *
 * An empty marker disabled the declaration layer because `includes("")` is
 * true of everything. An empty CATEGORY set disables the redaction engine the
 * mirrored way: `enabledCategories.has(category)` is false of everything, so
 * every span is skipped — and the residual-secret verifier runs the same
 * disabled detector, so it then certifies the unredacted text as `verified:
 * true`. An empty `piiClassifications` does it through `.some(...)`, which is
 * false over an empty array, so `classificationRequiresRedaction` answers
 * "no" even for a credential secret.
 *
 * Both are reachable from config: the schema declares them optional arrays,
 * and an explicit `[]` survives `??`, which only replaces `undefined`. The
 * marker's floor landed on the string and not on its siblings.
 */
function enforceNonEmptyList<T>(values: readonly T[], field: string, consequence: string): readonly T[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new InputError(
      `Privacy policy ${field} must not be empty: ${consequence}`,
      "privacy_policy_empty_list_violation",
    );
  }
  return values;
}

function enforceMarkerFloor(prefix: string): string {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new InputError(
      "Privacy policy redactionPrefix must be a non-empty string: an empty marker cannot be told apart from ordinary text when the redaction is verified",
      "privacy_policy_marker_floor_violation",
    );
  }
  return prefix;
}

function enforceFloor(value: number, floor: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < floor) {
    throw new InputError(`Privacy policy ${name} must be a safe integer >= ${floor}`, "privacy_policy_floor_violation");
  }
  return value;
}

function enforceRange(value: number, floor: number, ceiling: number, name: string): number {
  if (enforceFloor(value, floor, name) > ceiling) {
    throw new InputError(`Privacy policy ${name} must be a safe integer <= ${ceiling}`, "privacy_policy_floor_violation");
  }
  return value;
}

/**
 * Validate that a classification requires redaction under the given policy.
 */
export function classificationRequiresRedaction(
  classification: DataClassification,
  policy: PrivacyPolicy,
): boolean {
  return policy.piiClassifications.some(
    (c) => classificationRank(c) <= classificationRank(classification),
  );
}

/**
 * The default shared privacy policy instance. All consumers that do not
 * supply a configured policy use this instance.
 */
export const DEFAULT_PRIVACY_POLICY: PrivacyPolicy = createPrivacyPolicy();
