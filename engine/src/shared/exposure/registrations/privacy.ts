/**
 * Shared exposure registrations — `privacy` module.
 *
 * EVERY ENTRY HERE IS DERIVED, NOT AUTHORED. The tiers, the types, their
 * plain-language names and the sentence describing what each one does all
 * come from `privacy/pii-registry.ts`, which is also what the detector
 * itself reads. There is no second table to keep in step, and a type added
 * to the registry appears in the settings surface without anybody editing
 * this file — the same move the settings categories made, and the reason a
 * static scan can ban a hand-authored map in the settings tree.
 *
 * WHAT THE USER ASKED FOR, verbatim: *"do all tiers… expose signals, events,
 * actions. make it so its easier to edit, also make it a configurable for
 * each tier so we can enable/disable."* The tier switches below are that
 * sentence, and each one reaches the detector through exactly one function —
 * every tier but the FLOOR (the harness's own credentials, `known-values` and
 * its `known-secret` type), which no switch may turn off (cred-audit
 * CRED-F8), so none is offered.
 *
 * THE UNSUPPORTED TYPES ARE EXPOSED TOO, as a signal rather than as a
 * control. A switch for something that cannot be detected would be a button
 * that does nothing; a stated count of what is out of reach, with the reason
 * readable beside it, is the honest form of the same information.
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
} from "../index.ts";
import {
  PII_TYPES,
  PRIVACY_TIERS,
  privacyCounters,
  privacyTierEnabled,
  privacyTypeEnabled,
  isPrivacyFloor,
  setPrivacyTierEnabled,
  setPrivacyTypeEnabled,
  typesInTier,
  unsupportedTypes,
  type PrivacyTierId,
} from "../../../privacy/pii-registry.ts";
import { DEFAULT_PRIVACY_TIERS_ENABLED, DEFAULT_PRIVACY_URL_DECODE_LEVELS, MAXIMUM_PRIVACY_URL_DECODE_LEVELS } from "../../../privacy/privacy-config.ts";
import { DEFAULT_HELD_MINIMUM_LENGTH, MIN_KNOWN_SECRET_LENGTH } from "../../../privacy/secret-intelligence.ts";
import { readNumberCustomization, writeConfigCustomization } from "../config-binding.ts";
import {
  forgetLearnedTerm,
  forgetScope,
  inspectLearned,
  learnedScopeCount,
  seededLexicon,
} from "../../../privacy/credential-lexicon.ts";
import { benignExplanation } from "../../../privacy/value-intrinsic.ts";

let privacyRegistered = false;

/**
 * The web server's egress doors' own fallbacks (`server/router/egress-failures.ts`):
 * error responses answered with the fixed last-resort 503 because the error
 * could not be safely described, and live-stream frames withheld because they
 * could not be redacted. Installed by the host at boot; zero with no host
 * (nothing was measured in this process).
 */
export type EgressFailureCounts = Readonly<{ lastResortResponses: number; framesWithheld: number }>;
let egressFailureSource: (() => EgressFailureCounts) | null = null;

/** Install the live egress-failure counts (the web server, at boot). */
export function installEgressFailureSource(source: () => EgressFailureCounts): void {
  egressFailureSource = source;
}

/**
 * The sentence a tier's switch shows.
 *
 * Built from the registry's own `purpose` plus the count of what turning it
 * off stops finding, because "what do I lose" is the question a switch has
 * to answer and a purpose alone does not answer it.
 */
function tierDescription(tier: (typeof PRIVACY_TIERS)[number]): string {
  const detected = typesInTier(tier.id).filter((t) => t.support === "detected");
  const names = detected.map((t) => t.plainName).join(", ");
  return `${tier.purpose} Turning this off stops hiding: ${names}.`;
}

export function registerPrivacyExposure(): void {
  if (privacyRegistered) return;
  privacyRegistered = true;

  registerExposureModule({
    id: "privacy",
    title: "What gets hidden before your words are sent",
    purpose:
      "Which kinds of sensitive value are found and hidden before anything leaves this machine, how each one is found, and what is honestly out of reach.",
  });
  registerEgressFailureSignals();

  // ── the tier switches, one per declared tier — except the FLOOR, which
  // no switch may turn off (a control that can only refuse would be inert) ──
  for (const tier of PRIVACY_TIERS) {
    if (isPrivacyFloor(tier.id)) continue;
    registerCustomization({
      id: `privacy.${camel(tier.id)}`,
      module: "privacy",
      name: tier.title,
      description: tierDescription(tier),
      type: "boolean",
      default: DEFAULT_PRIVACY_TIERS_ENABLED[tier.id],
      current: () => privacyTierEnabled(tier.id),
      set: (v) => {
        setPrivacyTierEnabled(tier.id, Boolean(v));
      },
      contract: { effect: "immediate" },
    });
  }

  // ── one switch per detected type, for the trade-offs a tier cannot express
  //
  // A tier switch is "stop inferring from randomness". A type switch is
  // "stop hiding my network addresses" — the case where a whole tier is
  // wanted and one member of it is wrong for this person's work. The types
  // whose registry entry names a sharp trade-off are exactly the ones this
  // exists for, and the trade-off is the description.
  for (const type of PII_TYPES) {
    if (type.support !== "detected" || isPrivacyFloor(type.id)) continue;
    registerCustomization({
      id: `privacy.hide.${camel(type.id)}`,
      module: "privacy",
      name: `Hide ${type.plainName}`,
      description: `${type.method} What it will not catch: ${type.limitation}`,
      type: "boolean",
      default: true,
      current: () => privacyTypeEnabled(type.id),
      set: (v) => {
        setPrivacyTypeEnabled(type.id, Boolean(v));
      },
      contract: { effect: "immediate" },
    });
  }

  // ── signals: what has been hidden, and what is out of reach ────────────
  registerSignal({
    id: "privacy.provenCount",
    module: "privacy",
    name: "Values Hidden With Proof",
    description:
      "Values hidden because arithmetic or an exact match proved them — a card's own check digit, or a credential this machine holds.",
    type: "counter",
    unit: "count",
    value: () => privacyCounters.proven,
  });
  registerSignal({
    id: "privacy.formatCount",
    module: "privacy",
    name: "Values Hidden By Their Written Form",
    description:
      "Values hidden because they match a published written form — an email address, a service key with a documented shape.",
    type: "counter",
    unit: "count",
    value: () => privacyCounters.format,
  });
  registerSignal({
    id: "privacy.inferredCount",
    module: "privacy",
    name: "Values Hidden By Inference",
    description:
      "Values hidden because their randomness or the words around them said so. This is the only count that can be wrong in either direction.",
    type: "counter",
    unit: "count",
    value: () => privacyCounters.inferred,
  });
  registerSignal({
    id: "privacy.correctionsReported",
    module: "privacy",
    name: "Corrections You Reported",
    description:
      "How many times you said a hidden value should not have been hidden. The only measure of this system's accuracy that comes from outside it.",
    type: "counter",
    unit: "count",
    value: () => privacyCounters.correctionsReported,
  });
  registerSignal({
    id: "privacy.heldSlotOnlyCount",
    module: "privacy",
    name: "Short credentials hidden in their own place only",
    description:
      "Credentials a request carried (a password in an image link, a secret in a tool setting) that were shorter than the matching floor: each was hidden where it was given, but not searched for in the rest of the conversation, because a very short value would hide ordinary words.",
    type: "counter",
    unit: "count",
    value: () => privacyCounters.heldSlotOnly,
  });
  registerCustomization({
    id: "privacy.heldCredentialMinimumLength",
    module: "privacy",
    name: "Shortest credential searched for everywhere",
    description:
      "A credential a request carries is hidden where it was given and, when it is at least this many characters long, everywhere else it appears in the conversation. Lower = shorter credentials are also searched for, at the risk of hiding ordinary words that happen to match. Higher = fewer ordinary words hidden, but a short credential repeated elsewhere stays visible there. It can never exceed the length above which every value is a credential worth hiding.",
    type: "number",
    default: DEFAULT_HELD_MINIMUM_LENGTH,
    min: 1,
    max: MIN_KNOWN_SECRET_LENGTH,
    unit: "characters",
    current: () => readNumberCustomization("privacy.heldCredentialMinimumLength", DEFAULT_HELD_MINIMUM_LENGTH),
    set: (v) => writeConfigCustomization("privacy.heldCredentialMinimumLength", v),
    contract: { effect: "immediate" },
    measuredBy: "privacy.heldSlotOnlyCount",
    configPath: "privacy.heldCredentialMinimumLength",
  });
  registerCustomization({
    id: "privacy.urlDecodeLevels",
    module: "privacy",
    name: "How many times a link's credential is decoded",
    description:
      "A password or token inside a link a request carries is also looked for in the spellings the link's encoding can give it: decoded once, twice (a double-encoded link), up to this many times. Higher = more encoded echoes of it are hidden, at a small cost per link. It cannot exceed a bound that keeps the cost linear in the link's length.",
    type: "number",
    default: DEFAULT_PRIVACY_URL_DECODE_LEVELS,
    min: 0,
    max: MAXIMUM_PRIVACY_URL_DECODE_LEVELS,
    unit: "decodes",
    current: () => readNumberCustomization("privacy.urlDecodeLevels", DEFAULT_PRIVACY_URL_DECODE_LEVELS),
    set: (v) => writeConfigCustomization("privacy.urlDecodeLevels", v),
    contract: { effect: "immediate" },
    configPath: "privacy.urlDecodeLevels",
  });
  registerSignal({
    id: "privacy.undetectableKinds",
    module: "privacy",
    name: "Kinds Not Detected",
    description:
      "How many kinds of sensitive value are declared out of reach, with the reason recorded for each. Stated rather than left as a silent gap.",
    type: "gauge",
    unit: "count",
    value: () => unsupportedTypes().length,
  });
  registerSignal({
    id: "privacy.vocabularySize",
    module: "privacy",
    name: "Credential Words Known",
    description:
      "How many ways of naming a credential are recognised, counting the forms derived automatically from a small starting set.",
    type: "gauge",
    unit: "count",
    value: () => seededLexicon().length,
  });
  registerSignal({
    id: "privacy.learningScopes",
    module: "privacy",
    name: "Conversations That Taught Words",
    description:
      "How many separate sessions have taught this machine a credential word from their own writing. Nothing learned in one reaches another.",
    type: "gauge",
    unit: "count",
    value: () => learnedScopeCount(),
  });

  // ── actions ────────────────────────────────────────────────────────────
  registerAction({
    id: "privacy.setTier",
    module: "privacy",
    name: "Turn a kind of detection on or off",
    description:
      "Switches one whole tier of detection on or off. Takes effect on the next thing sent.",
    args: {
      tier: { type: "string", required: true, description: "Which tier to switch." },
      enabled: { type: "boolean", required: true, description: "On or off." },
    },
    execute: (args) => {
      const tier = String(args?.tier ?? "");
      if (!PRIVACY_TIERS.some((t) => t.id === tier)) {
        return { ok: false, error: `no such kind of detection: ${tier}` };
      }
      const enabled = setPrivacyTierEnabled(tier as PrivacyTierId, Boolean(args?.enabled));
      return { ok: true, data: { tier, enabled } };
    },
  });
  registerAction({
    id: "privacy.reportWrongRedaction",
    module: "privacy",
    name: "Say a hidden value should not have been hidden",
    description:
      "Records that hiding this kind of value was wrong here, and stops hiding it from now on. The count is kept so the mistake is visible rather than only corrected.",
    args: {
      type: { type: "string", required: true, description: "Which kind was wrongly hidden." },
    },
    execute: (args) => {
      const typeId = String(args?.type ?? "");
      if (!setPrivacyTypeEnabled(typeId, false)) {
        return { ok: false, error: `no such kind of value: ${typeId}` };
      }
      // RECORDED, which is the point. A correction that only changes a
      // setting leaves no trace that the engine was wrong; the count is the
      // trace, and it is the only accuracy measure that comes from a user.
      privacyCounters.correctionsReported += 1;
      return { ok: true, data: { type: typeId, hidden: false } };
    },
  });
  registerAction({
    id: "privacy.inspectLearnedWords",
    module: "privacy",
    name: "See which words this conversation taught",
    description:
      "Lists the credential words learned from your own writing in one conversation, with how often each was seen and the examples it came from.",
    args: {
      scope: { type: "string", required: true, description: "Which conversation." },
    },
    execute: (args) => {
      // `scope` is declared required, so an absent one is an error rather
      // than an empty string. Defaulting it silently reported success for a
      // conversation nobody named, and returned the empty list that a
      // conversation which genuinely taught nothing also returns — two
      // different facts wearing the same answer.
      const scope = typeof args?.scope === "string" ? args.scope.trim() : "";
      if (scope.length === 0) {
        return { ok: false, error: "name the conversation to inspect" };
      }
      return {
        ok: true,
        data: {
          terms: inspectLearned(scope).map((t) => ({
            word: t.term,
            timesSeen: t.occurrences,
            learnedFrom: t.examples,
            why: "learned as credential context, from your own words",
          })),
        },
      };
    },
  });
  registerAction({
    id: "privacy.forgetLearnedWord",
    module: "privacy",
    name: "Forget a word this conversation taught",
    description:
      "Removes one learned credential word, so it stops causing values near it to be hidden.",
    args: {
      scope: { type: "string", required: true, description: "Which conversation." },
      word: { type: "string", required: true, description: "The word to forget." },
    },
    execute: (args) => {
      const scope = typeof args?.scope === "string" ? args.scope.trim() : "";
      const word = typeof args?.word === "string" ? args.word.trim() : "";
      if (scope.length === 0 || word.length === 0) {
        return { ok: false, error: "name both the conversation and the word to forget" };
      }
      const forgotten = forgetLearnedTerm(scope, word);
      return { ok: true, data: { forgotten } };
    },
  });
  registerAction({
    id: "privacy.forgetEverythingLearned",
    module: "privacy",
    name: "Forget every word one conversation taught",
    description:
      "Removes all the credential words learned from one conversation at once, instead of one at a time. Nothing learned from other conversations is affected.",
    args: {
      scope: { type: "string", required: true, description: "Which conversation." },
    },
    execute: (args) => {
      const scope = typeof args?.scope === "string" ? args.scope.trim() : "";
      if (scope.length === 0) {
        return { ok: false, error: "name the conversation to clear" };
      }
      // `forgotten: false` means there was nothing learned there — a
      // different fact from "cleared", and reported as such rather than as
      // an unqualified success.
      return { ok: true, data: { forgotten: forgetScope(scope) } };
    },
  });
  registerAction({
    id: "privacy.explainNotHidden",
    module: "privacy",
    name: "Ask why a value was left visible",
    description:
      "Explains what a value was recognised as — a date, a version, a file path, a name in code — which is why it was not hidden. Answers the opposite question to the redaction report, and answers it without storing the value.",
    args: {
      value: { type: "string", required: true, description: "The value that stayed visible." },
    },
    execute: (args) => {
      const value = typeof args?.value === "string" ? args.value.trim() : "";
      if (value.length === 0) {
        return { ok: false, error: "give the value to explain" };
      }
      const recognisedAs = benignExplanation(value);
      return {
        ok: true,
        data: {
          recognisedAs,
          // Absence stated in words rather than as a null the caller must
          // interpret: nothing recognised it, so nothing explains it.
          why:
            recognisedAs === null
              ? "nothing ordinary matched it — if it stayed visible, some other check cleared it"
              : `recognised as ${recognisedAs}, which is an ordinary kind of value`,
        },
      };
    },
  });
}

/** The egress doors' fallback counters (see {@link installEgressFailureSource}). */
function registerEgressFailureSignals(): void {
  registerSignal({
    id: "privacy.lastResortResponses",
    module: "privacy",
    name: "Errors answered without their description",
    description:
      "How many error responses this server answered with its fixed 'could not prepare a safe description of this error' reply, because the error could not be mapped or cleaned of sensitive values. Nothing unhidden left; each one is also logged. Counted since the server started.",
    type: "counter",
    unit: "responses",
    value: () => egressFailureSource?.().lastResortResponses ?? 0,
  });
  registerSignal({
    id: "privacy.framesWithheld",
    module: "privacy",
    name: "Live updates withheld",
    description:
      "How many live-stream updates were not sent because they could not be cleaned of sensitive values. A resumable update is replaced by a gap notice and the stream stays open; each one is also logged. Counted since the server started.",
    type: "counter",
    unit: "updates",
    value: () => egressFailureSource?.().framesWithheld ?? 0,
  });
}

/** `self-validating` -> `selfValidating`; ids are camel by convention. */
function camel(id: string): string {
  return id.replace(/-([a-z])/gu, (_m, c: string) => c.toUpperCase());
}

/** Reset the per-module registration flag (test-only). */
export function resetPrivacyRegistration(): void {
  privacyRegistered = false;
}
