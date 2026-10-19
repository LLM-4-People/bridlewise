import { z } from "zod";

import { DATA_CLASSIFICATION_VALUES } from "./classification-catalog.ts";
import { InputError } from "../kernel/errors.ts";
import { type DeepReadonly } from "../kernel/integrity.ts";
import { DEFAULT_PII_CLASSIFICATIONS, MAXIMUM_PRIVACY_URL_DECODE_LEVELS } from "./privacy-config.ts";
import { REDACTION_CATEGORIES, type PrivacyPolicyOptions } from "./privacy-policy.ts";
import { MIN_KNOWN_SECRET_LENGTH } from "./secret-intelligence.ts";

/**
 * The privacy CONFIG SECTION — the operator-facing half of the privacy
 * policy's birth, and the one place the document's `privacy` section and
 * the policy's options meet.
 *
 * The section's leaves ARE `PrivacyPolicyOptions`' fields, by name and by
 * meaning: the options type is the policy's declared input surface
 * ("Options for constructing a privacy policy. Central config supplies
 * these" — privacy-policy.ts), and this schema is what central config is
 * allowed to supply. The identity is enforced, not assumed: the
 * config-consumption census walks this schema's zod shape and reds on any
 * leaf that is not a `PrivacyPolicyOptions` key, so a leaf added here
 * without a policy field to receive it cannot land silently, and a policy
 * field renamed here cannot orphan its config leaf.
 *
 * WHAT THIS MODULE OWNS, and why it is not inside `config-contracts.ts`:
 * the section is the privacy domain's own exported section schema (the
 * module-exports-its-section idiom the performance section established),
 * because its safety floors speak privacy facts — which categories are the
 * redaction minimum, which classifications are the policy's floor — that
 * the privacy domain declares. `config-contracts.ts` splices the exported
 * schema into the document composition and owns nothing privacy-specific.
 * And it is not inside `privacy-config.ts` because that file is imported by
 * `privacy-policy.ts` for the policy defaults; a schema evaluated at module
 * scope reading `REDACTION_CATEGORIES` from `privacy-policy.ts` would close
 * an import cycle whose evaluation order nobody should depend on.
 *
 * THE SAFETY FLOORS. Two leaves can weaken what the masker hides, and the
 * deny-by-default security posture says the config may not do that:
 *
 *  - `enabledCategories` narrows WHICH redaction categories still mask.
 *    Every category in `REDACTION_CATEGORIES` is a sensitive class — the
 *    credential family, PII, and the unknown-sensitive fallback — and each
 *    one is load-bearing: disabling `credential` switches off
 *    credential-assignment spans AND every value-intrinsic and declared
 *    span (they redact under the `credential` category); disabling
 *    `secret` switches off exact matches against credentials this process
 *    holds; disabling `pii` switches off payment cards, emails and phone
 *    numbers. The list exists so the replacement marker can NAME the kind
 *   of thing it hides, not so kinds of secret can be switched off. The
 *   root minimum is therefore the full enumeration, and a configured
 *   narrowing is refused — the root-policy precedent of
 *   `configurableNegationOfRootMinimumAllowed: false` applied to the
 *   masker: the config may never negate the redaction minimum.
 *
 *  - `piiClassifications` narrows which data classifications require
 *    redaction. The policy's declared minimum
 *    (`DEFAULT_PII_CLASSIFICATIONS` — credential secrets and user-private
 *    data) is the floor: a configured list that drops a member of it is
 *    refused. ADDING classifications is accepted and is a tightening (more
 *    kinds of data become required to redact).
 *
 * The floors fire at BOTH doors that can put a section in front of a
 * policy birth: the section schema's own refinement (so the deny-by-default
 * config write gate, which validates whole documents through the document
 * schema, refuses the write before a byte reaches disk) and
 * `resolvePrivacyPolicyOptions` (so a hand-edited file that never passed
 * the write gate is refused, fail-closed, at the policy's birth).
 *
 * The other leaves cannot weaken the masker and carry no floors here: the
 * caps bound how much already-redacted content the viewer shows, the mode
 * and shape flags change the FORM of the redaction output (the same spans
 * are masked either way), `failClosedOnUncertainty` only tightens (true
 * refuses unparseable files rather than showing them best-effort), and the
 * marker leaves change how the replacement is SPELLED. Each leaf's
 * disposition is recorded with the round that wired it.
 *
 * NOT a section leaf: `maxLines` (the viewer's full-mode line cap) is a
 * policy option but deliberately not a config leaf — the document that
 * ships today never declared it, and adding it is a separate decision, not
 * a side effect of this wiring.
 *
 * Layer: domain. Owner: privacy-and-redaction.
 */

export const PRIVACY_CONFIG_SCHEMA = z.strictObject({
  maxContextLines: z.number().int().positive().max(1_000_000),
  maxFileBytes: z.number().int().positive().max(1_073_741_824),
  maxRegexPatternBytes: z.number().int().positive().max(1_048_576),
  maxMatchCount: z.number().int().positive().max(10_000_000),
  semanticModeEnabled: z.boolean(),
  preserveLineCount: z.boolean(),
  preserveStructure: z.boolean(),
  failClosedOnUncertainty: z.boolean(),
  // Raising it can only stop matching held credentials in text, so it is
  // capped at the registry's own floor: a held value that long is always
  // matched. Lowering it only masks more.
  heldCredentialMinimumLength: z.number().int().min(1).max(MIN_KNOWN_SECRET_LENGTH).optional(),
  // Bounded: each level adds at most one spelling per URL part (a2b H-1).
  urlDecodeLevels: z.number().int().min(0).max(MAXIMUM_PRIVACY_URL_DECODE_LEVELS).optional(),
  // Non-empty for the same reason `redactionPrefix` is: an empty list does
  // not narrow the redaction engine, it switches it off. No enabled category
  // means every span is skipped and the residual-secret verifier — which
  // consults the same disabled detector — then reports the untouched text as
  // verified. An empty classification list makes `.some(...)` false of
  // everything, so nothing requires redaction at all.
  enabledCategories: z.array(z.enum(REDACTION_CATEGORIES)).min(1).optional(),
  piiClassifications: z.array(z.enum(DATA_CLASSIFICATION_VALUES)).min(1).optional(),
  redactionPrefix: z.string().min(1).max(64).optional(),
  redactionSuffix: z.string().min(0).max(64).optional(),
}).superRefine((section, ctx) => {
  for (const violation of privacyConfigViolations(section)) {
    ctx.addIssue({
      code: "custom",
      message: privacyConfigRefusalMessage(violation, section),
    });
  }
});

// Deep-readonly like every other exported section type (the performance
// section's own precedent): the document a process resolves is frozen, and
// a resolver that demanded a mutable copy would force one.
export type PrivacyConfigSection = DeepReadonly<z.infer<typeof PRIVACY_CONFIG_SCHEMA>>;

export type PrivacyConfigViolationCode =
  | "privacy_enabled_categories_minimum_required"
  | "privacy_pii_classifications_minimum_required";

/**
 * THE ONE OWNER of the section's safety floors. Pure: the same function
 * feeds the schema refinement (the write gate's refusal) and
 * `resolvePrivacyPolicyOptions` (the policy birth's refusal), so the two
 * doors can never disagree about what weakening means.
 */
export function privacyConfigViolations(
  section: PrivacyConfigSection,
): readonly PrivacyConfigViolationCode[] {
  const codes: PrivacyConfigViolationCode[] = [];
  if (
    section.enabledCategories !== undefined &&
    REDACTION_CATEGORIES.some((category) => !section.enabledCategories!.includes(category))
  ) {
    codes.push("privacy_enabled_categories_minimum_required");
  }
  if (
    section.piiClassifications !== undefined &&
    DEFAULT_PII_CLASSIFICATIONS.some(
      (classification) => !section.piiClassifications!.includes(classification),
    )
  ) {
    codes.push("privacy_pii_classifications_minimum_required");
  }
  return codes;
}

/**
 * The refusal message for one violation: the machine identity and the rule's
 * own sentence in one string, naming the values that were refused — the
 * settings sheet renders zod issue messages verbatim, so this is the
 * sentence a refused save shows. An empty-prefix marker or an empty list is
 * refused by the schema's own bounds with zod's message; these sentences
 * own the narrowing refusals only.
 */
export function privacyConfigRefusalMessage(
  code: PrivacyConfigViolationCode,
  section: PrivacyConfigSection,
): string {
  // The code rides beside the sentence (the grammar the performance
  // checker established): the settings sheet renders this verbatim, the
  // code answers WHO refused for tooling, and the sentence says WHY in the
  // operator's words.
  switch (code) {
    case "privacy_enabled_categories_minimum_required": {
      const missing = REDACTION_CATEGORIES.filter(
        (category) => !section.enabledCategories?.includes(category),
      );
      return `privacy_enabled_categories_minimum_required — privacy.enabledCategories may not disable a redaction category: every category is a sensitive class with no safe off state, so the configured list must keep them all (missing: ${missing.join(", ")})`;
    }
    case "privacy_pii_classifications_minimum_required": {
      const missing = DEFAULT_PII_CLASSIFICATIONS.filter(
        (classification) => !section.piiClassifications?.includes(classification),
      );
      return `privacy_pii_classifications_minimum_required — privacy.piiClassifications may not drop a classification the redaction floor requires: credential secrets and user-private data must always require redaction (missing: ${missing.join(", ")})`;
    }
  }
}

/**
 * THE CONFIG DOOR TO A POLICY BIRTH — the one function a process that
 * resolves the document calls to turn the `privacy` section into policy
 * options.
 *
 * Enforces the same safety floors as the section schema, because the file
 * can reach this door without ever passing the write gate: an operator's
 * hand edit is parsed by whatever process reads it, and the masker must
 * refuse to run weakened, not run silently clamped and not honor the
 * write either. A violating section is a typed `InputError` naming the
 * refused values — fail closed at the policy's birth, the same stance the
 * web debug bridge takes for `debug.redaction.enabled=false`.
 *
 * A section that passes the floors flows to `createPrivacyPolicy` by its
 * own keys: the field names here ARE the options' names (the census
 * enforces the identity), so there is no per-leaf mapping to maintain —
 * and the policy's own birth floors (non-empty lists, a self-identifying
 * marker, numeric minimums) still apply on top, whatever produced the
 * options. An absent section resolves to no options at all, which is the
 * defaults-only policy — byte-identical to what every consumer built
 * before this wiring existed.
 */
export function resolvePrivacyPolicyOptions(
  section: PrivacyConfigSection | undefined,
): PrivacyPolicyOptions {
  if (section === undefined) return {};
  const violations = privacyConfigViolations(section);
  const violation = violations[0];
  if (violation !== undefined) {
    throw new InputError(
      privacyConfigRefusalMessage(violation, section),
      violation,
    );
  }
  // OMITTED, never `undefined`: the policy's options type declares its
  // leaves as `field?: T` under `exactOptionalPropertyTypes`, where an
  // explicit `undefined` is a VALUE the resolver would have to interpret
  // rather than an absence. The section's parse yields `T | undefined` for
  // its optional leaves, so each one present is copied and each absent one
  // is left off entirely — the same omitted-not-undefined contract the
  // server's config readers hold. The copy is by the section's OWN keys
  // (never a hand-enumerated leaf list): a leaf added to the schema flows
  // through with no edit here, and the census reds if no policy field
  // exists to receive it.
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(section)) {
    if (value !== undefined) options[key] = value;
  }
  return options as PrivacyPolicyOptions;
}
