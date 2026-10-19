import { deepFreeze } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { IDENTITY_DETECTOR_IDS } from "./identity-grammars.ts";
import type { SecretConfidence } from "./detection-span.ts";
import type { RedactionCategory } from "./privacy-policy.ts";
import {
  DEFAULT_PRIVACY_TIERS_ENABLED,
  DEFAULT_PRIVACY_TYPES_DISABLED,
} from "./privacy-config.ts";

/**
 * THE REGISTRY — breadth made auditable, and every gap made a stated fact.
 *
 * A detector that is a pile of regexes can only answer "does it catch X?"
 * one X at a time, and it can never answer "what does it NOT catch?" — the
 * question a user actually has. Declaring each type, with the layer it is
 * found by and the method that finds it, turns both questions into a table
 * lookup. The same move the settings categories made: derive the surface
 * from the declaration instead of hand-authoring a parallel list that drifts.
 *
 * Three things hang off this file and none of them may be typed out
 * separately:
 *
 *  - WHAT IS DETECTED, and by which of the five layers.
 *  - WHAT IS CONFIGURABLE. Every type belongs to a tier, and every tier can
 *    be switched off. The defaults live in `privacy-config.ts` — one owner —
 *    and the settings the user sees are PROJECTED from here.
 *  - WHAT IS NOT DETECTED, and why not. `unsupported` entries are the honest
 *    half: personal names and street addresses are declared undetectable
 *    with the reason attached, so a reader finds a stated limit rather than
 *    a silent hole.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

/**
 * THE FIVE LAYERS, strongest evidence first.
 *
 * The order is the argument. Each layer is a different KIND of evidence, not
 * a different pattern, and they are combined by union rather than by
 * precedence — so a weaker layer can never suppress a stronger one, and
 * adding evidence can only ever mask more.
 */
export const PRIVACY_TIERS = deepFreeze([
  {
    id: "self-validating",
    layer: 1,
    title: "Numbers that check themselves",
    purpose:
      "Card, bank and national numbers that carry their own check digit. Arithmetic proves these, in any language.",
  },
  {
    id: "grammar-defined",
    layer: 2,
    title: "Values with one written form",
    purpose:
      "Email addresses, network addresses and phone numbers. One published shape each.",
  },
  {
    id: "known-values",
    layer: 3,
    title: "Credentials this machine holds",
    purpose:
      "Anything equal to a credential this program itself uses. Matched exactly, in any format or escaping.",
  },
  {
    id: "value-intrinsic",
    layer: 4,
    title: "Random-looking values",
    purpose:
      "Long unbroken runs of randomness that match nothing ordinary — no id, hash, date, version or path. This is what finds a key from a service nobody listed.",
  },
  {
    id: "declared-values",
    layer: 5,
    title: "Values you said were secret",
    purpose:
      "A value introduced by words that name a credential. The only way a short, ordinary-looking password can be found at all.",
  },
] as const);

export type PrivacyTierId = typeof PRIVACY_TIERS[number]["id"];

/** Whether a type is found, or declared out of reach with a reason. */
export type PiiSupport = "detected" | "unsupported";

export type PiiType = Readonly<{
  /** Stable id. Also the signal id the spans carry. */
  id: string;
  /**
   * The redaction category a span of this type is masked under (and moves
   * with when that category is switched): declared HERE, per type, so a new
   * type cannot silently fall into another category (wf1b2-design SC-1: a
   * per-id switch defaulted every unlisted type to `credential`).
   */
  category: RedactionCategory;
  tier: PrivacyTierId;
  support: PiiSupport;
  /** Plain words, zero-knowledge — no internal ids, no registry vocabulary. */
  plainName: string;
  /** How it is found, in one sentence a non-engineer can check. */
  method: string;
  /** The strongest confidence a detection of this type can carry. */
  confidence: SecretConfidence;
  /**
   * The detector ids that produce this type. Empty for `unsupported`, and
   * the join that lets a tier switch reach the actual code.
   */
  detectorIds: readonly string[];
  /**
   * What this type does NOT catch. Required on every entry, because the
   * limit is the part a user cannot discover by testing.
   */
  limitation: string;
}>;

/**
 * THE TYPES. Every one names its layer, its method, its confidence and its
 * limit.
 *
 * `unsupported` entries carry `detectorIds: []` and are never switched on by
 * anything — they exist so the table is a complete answer rather than a list
 * of successes.
 */
export const PII_TYPES: readonly PiiType[] = deepFreeze([
  {
    id: "payment-card",
    category: "pii",
    tier: "self-validating",
    support: "detected",
    plainName: "payment card number",
    method: "The card's own check digit is recomputed and must match, and the number must begin with a real issuer range.",
    confidence: "proven",
    detectorIds: ["luhn-checksum"],
    limitation:
      "A card number written with letters between the digits, or split across two messages, is not recognised.",
  },
  {
    id: "bank-account",
    category: "pii",
    tier: "self-validating",
    support: "detected",
    plainName: "bank account number (IBAN)",
    method: "The account number's own check digits are recomputed against the rest of the number.",
    confidence: "proven",
    detectorIds: ["iban-mod97"],
    limitation:
      "Account numbers in national formats without check digits — a bare UK sort code and account number — are not recognised.",
  },
  {
    id: "bank-routing",
    category: "pii",
    tier: "self-validating",
    support: "detected",
    plainName: "bank routing number",
    method: "The routing number's check digit is recomputed and the district prefix must be one that is issued.",
    confidence: "proven",
    detectorIds: ["aba-checksum"],
    limitation: "Only the US format. Other countries' bank codes carry no check digit.",
  },
  {
    id: "national-id",
    category: "pii",
    tier: "self-validating",
    support: "detected",
    plainName: "social security number",
    method: "Written with dashes, and the number must not be one of the ranges that are never issued.",
    confidence: "format",
    detectorIds: ["us-ssn-rules"],
    limitation:
      "There is no check digit to verify, so only the dashed form is recognised — nine bare digits are indistinguishable from any other nine digits.",
  },
  {
    id: "email-address",
    category: "pii",
    tier: "grammar-defined",
    support: "detected",
    plainName: "email address",
    method: "The published address grammar: a local part, an at sign, and a domain ending in a real suffix.",
    confidence: "format",
    detectorIds: ["email-grammar"],
    limitation: "An address written as 'name at example dot com' is not recognised.",
  },
  {
    id: "ip-address",
    category: "pii",
    tier: "grammar-defined",
    support: "detected",
    plainName: "network address",
    method: "A four-part or eight-part address, with private and loopback ranges left alone because they identify nobody.",
    confidence: "format",
    detectorIds: ["ipv4-grammar", "ipv6-grammar"],
    limitation:
      "A four-part version number is written exactly like a four-part address, so one can be mistaken for the other.",
  },
  {
    id: "phone-number",
    category: "pii",
    tier: "grammar-defined",
    support: "detected",
    plainName: "phone number",
    method: "An international number: a leading plus sign, a country code, and 7 to 14 more digits.",
    confidence: "format",
    detectorIds: ["e164-grammar"],
    limitation:
      "A number written without the leading plus sign is not recognised — bare digit runs are order numbers and identifiers far more often than they are phone numbers.",
  },
  {
    id: "known-secret",
    category: "secret",
    tier: "known-values",
    support: "detected",
    plainName: "a credential this machine holds",
    method: "Compared for exact equality against the credentials this server uses, including escaped and encoded copies.",
    confidence: "proven",
    detectorIds: ["known-secret", "declared-then-known"],
    limitation: "Only credentials this server was told about. It cannot know a credential it has never held.",
  },
  {
    id: "provider-credential",
    category: "credential",
    tier: "grammar-defined",
    support: "detected",
    plainName: "a known service key",
    method: "Matches the published shape of a key from a service that publishes one.",
    confidence: "format",
    detectorIds: ["secret-signals"],
    limitation:
      "Only services whose key format is published and listed. This is the layer that is permanently behind, which is why it is not the one relied on.",
  },
  {
    id: "high-entropy-value",
    category: "credential",
    tier: "value-intrinsic",
    support: "detected",
    plainName: "a random-looking value",
    method:
      "A long unbroken run of random-looking characters that matches nothing ordinary — not an id, hash, date, version, address or name.",
    confidence: "inferred",
    detectorIds: ["value-intrinsic"],
    limitation:
      "A secret that is short, or that reads like words, has nothing random about it and cannot be found this way. A value that looks exactly like a content hash is left alone unless something names it.",
  },
  {
    id: "declared-credential",
    category: "credential",
    tier: "declared-values",
    support: "detected",
    plainName: "a value you called a secret",
    method:
      "Words that name a credential, near the value, in the writing style of ordinary prose rather than code.",
    confidence: "inferred",
    detectorIds: ["declaration"],
    limitation:
      "It depends on the words used. Unfamiliar words are learned from your own writing over time, but a value introduced by nothing at all can only be found by its randomness.",
  },
  {
    id: "declared-personal-identifier",
    category: "pii",
    tier: "declared-values",
    support: "detected",
    plainName: "an identity number you named",
    method:
      "A passport, licence, social security or phone number, found by the words that introduce it — the same way a password is found.",
    confidence: "inferred",
    detectorIds: ["declaration"],
    limitation:
      "It depends on the words used, and the words seeded are English. Measured on a six-language corpus it reaches about 60% of the English cases and 15-25% of the French, German, Italian, Spanish and Dutch ones — those hits being English field labels inside other languages. A number written with no noun near it cannot be found this way, because nine digits with nothing around them are an order number far more often than a national id.",
  },
  {
    id: "person-name",
    category: "pii",
    tier: "declared-values",
    support: "unsupported",
    plainName: "a person's name",
    method: "Not detected, and not detectable — there is no rule that separates a name from an ordinary word.",
    confidence: "inferred",
    detectorIds: [],
    limitation:
      "Names are not deterministically solvable. 'Mr Baker went to the baker' needs the world to tell the two apart, and a name list is a wordlist with worse coverage and a built-in bias about whose names count. Stated rather than half-attempted.",
  },
  {
    id: "street-address",
    category: "pii",
    tier: "declared-values",
    support: "unsupported",
    plainName: "a street address",
    method: "Not detected, and not detectable — address formats differ by country and collide with ordinary sentences.",
    confidence: "inferred",
    detectorIds: [],
    limitation:
      "Address formats differ by country and collide with ordinary sentences — '12 High Street' and '12 high scores' differ only by a dictionary that does not exist for every language.",
  },
] as const);

/**
 * The redaction category of an intelligence span's type (its `signalId` is
 * the type's id). A signal id with no registered type is a typed error,
 * never a default category.
 */
export function piiTypeCategory(signalId: string): RedactionCategory {
  const type = PII_TYPES.find((entry) => entry.id === signalId);
  if (type === undefined) throw new InputError(`the detected signal ${signalId} is not a registered type`, "redaction_signal_unknown");
  return type.category;
}

/** Every type in a tier. The projection a settings surface renders. */
export function typesInTier(tier: PrivacyTierId): readonly PiiType[] {
  return PII_TYPES.filter((type) => type.tier === tier);
}

/** The types that are honestly out of reach, with their reasons. */
export function unsupportedTypes(): readonly PiiType[] {
  return PII_TYPES.filter((type) => type.support === "unsupported");
}

// ── the configuration, derived from the registry ─────────────────────────

/**
 * WHICH DETECTION IS ON. Constructed from the tier switches and the
 * per-type switches, never typed out.
 *
 * TWO LEVELS, because they answer different questions. A tier switch is
 * "stop inferring from randomness"; a type switch is "stop masking my IP
 * addresses". Both are needed and neither expresses the other.
 */
export type PrivacySettings = Readonly<{
  tiers: Readonly<Record<PrivacyTierId, boolean>>;
  /** Types switched off individually, inside a tier that is on. */
  disabledTypes: ReadonlySet<string>;
}>;

export type PrivacySettingsOptions = Readonly<{
  tiers?: Partial<Record<PrivacyTierId, boolean>>;
  disabledTypes?: readonly string[];
}>;

/**
 * Build the settings from the defaults in `privacy-config.ts`, with any
 * overrides applied. The defaults have ONE owner and this is the only
 * function that reads them.
 */
export function createPrivacySettings(
  options: PrivacySettingsOptions = {},
): PrivacySettings {
  const tiers = {} as Record<PrivacyTierId, boolean>;
  for (const tier of PRIVACY_TIERS) {
    tiers[tier.id] = options.tiers?.[tier.id] ?? DEFAULT_PRIVACY_TIERS_ENABLED[tier.id];
  }
  const disabled = new Set<string>(options.disabledTypes ?? DEFAULT_PRIVACY_TYPES_DISABLED);
  return deepFreeze({ tiers: Object.freeze(tiers), disabledTypes: disabled }) as PrivacySettings;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = createPrivacySettings();

/**
 * ── THE LIVE SETTINGS, WHICH ARE WHAT A SWITCH IN THE UX ACTUALLY MOVES ──
 *
 * `DEFAULT_PRIVACY_SETTINGS` is what a fresh process starts with; this is
 * what it is using now. Held here rather than in the engine so there is one
 * answer to "what is on" for the detector, the settings surface and the
 * status signals alike.
 *
 * DETERMINISM IS UNAFFECTED, and the distinction is worth being exact
 * about. The engine's output is a pure function of (text, policy, settings):
 * the same three inputs give byte-identical output across calls, processes
 * and machines. What this holds is one of those inputs, not a hidden mode —
 * every call site can pass its own `settings` and none of them observe
 * anything else about this module.
 */
const liveSettings = {
  tiers: { ...DEFAULT_PRIVACY_SETTINGS.tiers } as Record<PrivacyTierId, boolean>,
  disabledTypes: new Set<string>(DEFAULT_PRIVACY_SETTINGS.disabledTypes),
};

/**
 * The settings in force, as a frozen snapshot the engine can hold.
 *
 * CACHED, and the cache is the point rather than a nicety: this is called
 * once per string leaf on the egress path, and building a fresh object and a
 * fresh Set each time allocated twice per leaf for an answer that changes
 * only when somebody flips a switch. The snapshot is rebuilt on mutation, so
 * a caller can still never observe a half-applied change.
 */
let settingsSnapshot: PrivacySettings | null = null;

export function currentPrivacySettings(): PrivacySettings {
  if (settingsSnapshot === null) {
    settingsSnapshot = Object.freeze({
      tiers: Object.freeze({ ...liveSettings.tiers }),
      disabledTypes: new Set(liveSettings.disabledTypes),
    }) as PrivacySettings;
  }
  return settingsSnapshot;
}

/** Drop the snapshot and the derived detector set. Called by every mutator,
 * so "the settings changed" has one place it can be forgotten rather than
 * four. */
function invalidateSettings(): void {
  settingsSnapshot = null;
  detectorSetCache = new WeakMap();
}

/**
 * THE MASKING FLOOR: what no switch may turn off (cred-audit CRED-F8). The
 * `known-values` tier and its `known-secret` type mask the credentials THIS
 * harness holds — its keys, its tool servers' tokens — in everything it logs,
 * shows and sends; switching them off (an admin toggle, an action, a "wrong
 * redaction" report) disabled that for every user at once. Refused typed;
 * every other tier and type stays the operator's trade-off to make.
 */
// DELIBERATE SUBSET: 1 of 5 PrivacyTierId members — only the tier that masks the harness's own credentials is a floor.
const MASKING_FLOOR_TIERS: ReadonlySet<PrivacyTierId> = new Set<PrivacyTierId>(["known-values"]);
const MASKING_FLOOR_TYPES: ReadonlySet<string> = new Set(["known-secret"]);

function refuseBelowFloor(what: string): never {
  throw new InputError(`${what} cannot be turned off: it hides the credentials this harness itself holds, for every user`, "privacy_floor_refused");
}

/** Whether a tier or a type is part of the floor — the settings surface offers no switch for it. */
export function isPrivacyFloor(id: string): boolean {
  return MASKING_FLOOR_TIERS.has(id as PrivacyTierId) || MASKING_FLOOR_TYPES.has(id);
}

/** Turn a whole tier on or off. Returns the value that took effect. Refuses to switch the floor off. */
export function setPrivacyTierEnabled(tier: PrivacyTierId, enabled: boolean): boolean {
  if (!enabled && MASKING_FLOOR_TIERS.has(tier)) refuseBelowFloor(`The "${tier}" detection`);
  liveSettings.tiers[tier] = enabled;
  invalidateSettings();
  return enabled;
}

/** Whether a tier is on right now. */
export function privacyTierEnabled(tier: PrivacyTierId): boolean {
  return liveSettings.tiers[tier];
}

/**
 * Turn one declared type on or off inside a tier that is on.
 *
 * Refuses a type that is declared `unsupported`: switching on something the
 * engine cannot detect would put a control in the UX that does nothing,
 * which is the one thing a settings surface must never contain.
 */
export function setPrivacyTypeEnabled(typeId: string, enabled: boolean): boolean {
  const type = PII_TYPES.find((t) => t.id === typeId);
  if (type === undefined || type.support !== "detected") return false;
  if (!enabled && MASKING_FLOOR_TYPES.has(typeId)) refuseBelowFloor(`Hiding ${type.plainName}`);
  if (enabled) liveSettings.disabledTypes.delete(typeId);
  else liveSettings.disabledTypes.add(typeId);
  invalidateSettings();
  return true;
}

/** Whether one declared type is on right now. */
export function privacyTypeEnabled(typeId: string): boolean {
  return !liveSettings.disabledTypes.has(typeId);
}

/** Back to the config owner's defaults. */
export function resetPrivacySettings(): void {
  for (const tier of PRIVACY_TIERS) {
    liveSettings.tiers[tier.id] = DEFAULT_PRIVACY_TIERS_ENABLED[tier.id];
  }
  liveSettings.disabledTypes = new Set(DEFAULT_PRIVACY_TYPES_DISABLED);
  invalidateSettings();
  privacyCounters.proven = 0;
  privacyCounters.format = 0;
  privacyCounters.inferred = 0;
  privacyCounters.correctionsReported = 0;
  privacyCounters.heldSlotOnly = 0;
}

/**
 * WHAT HAS BEEN MASKED, SPLIT BY WHAT THE CLAIM WAS.
 *
 * One number would flatten "matched a credential this server holds" and
 * "looked like a credential after the words 'api key is'" into the same
 * statement, which is the dishonesty the confidence split exists to prevent.
 * Counted per SPAN, so the cost is three increments per detection and
 * nothing at all for the strings that find nothing.
 */
export const privacyCounters = {
  proven: 0,
  format: 0,
  inferred: 0,
  /** How many times a user said a redaction was wrong. The honest measure
   * of this engine's precision in the field, and the only one that comes
   * from outside it. */
  correctionsReported: 0,
  /** Held request credentials shorter than `privacy.heldCredentialMinimumLength`:
   * replaced in their own slot only, never matched in text. */
  heldSlotOnly: 0,
};

/** Record one detection, by the strength of the claim behind it. */
export function countDetection(confidence: SecretConfidence): void {
  privacyCounters[confidence] += 1;
}

/** Whether a declared type is currently detected. */
export function typeEnabled(type: PiiType, settings: PrivacySettings): boolean {
  if (type.support !== "detected") return false;
  if (!settings.tiers[type.tier]) return false;
  return !settings.disabledTypes.has(type.id);
}

/**
 * THE DETECTOR IDS THAT ARE ON, derived by joining the registry to the
 * settings.
 *
 * This is the single place a tier switch turns into behaviour. A detector
 * whose id is not declared by any type is unreachable by construction —
 * there is no other route from a switch to a scan.
 */
let detectorSetCache = new WeakMap<PrivacySettings, ReadonlySet<string>>();

export function enabledDetectorIds(settings: PrivacySettings): ReadonlySet<string> {
  // MEMOISED BY THE SETTINGS OBJECT. This is a join over every declared type
  // and it was being recomputed — and a Set reallocated — once per string
  // leaf of every response. The answer is a pure function of `settings`, so
  // it is cached against that object's identity and dropped whenever the
  // live settings change.
  const cached = detectorSetCache.get(settings);
  if (cached !== undefined) return cached;
  const out = new Set<string>();
  for (const type of PII_TYPES) {
    if (!typeEnabled(type, settings)) continue;
    for (const detectorId of type.detectorIds) out.add(detectorId);
  }
  const frozen: ReadonlySet<string> = out;
  detectorSetCache.set(settings, frozen);
  return frozen;
}

/** Whether a whole tier is on. */
export function tierEnabled(tier: PrivacyTierId, settings: PrivacySettings): boolean {
  return settings.tiers[tier];
}

/**
 * EVERY DETECTOR ID THE IDENTITY GRAMMARS OFFER IS DECLARED BY SOME TYPE.
 *
 * A detector nothing declares can never be switched on, and a detector
 * nothing declares also never appears in the settings a user reads — so it
 * would run, or fail to run, with no way to see it either way. Checked here,
 * at module load, so the failure is a startup error rather than a silent
 * hole; the guard in the test suite proves the same thing for the other
 * direction.
 */
const DECLARED_DETECTORS = new Set(PII_TYPES.flatMap((type) => type.detectorIds));
for (const detectorId of IDENTITY_DETECTOR_IDS) {
  if (!DECLARED_DETECTORS.has(detectorId)) {
    throw new InputError(
      `privacy registry: detector "${detectorId}" exists but no PII type declares it, so no setting can reach it`,
      "privacy_detector_undeclared",
      { detectorId },
    );
  }
}
