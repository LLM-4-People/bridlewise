/**
 * Exposure metadata — the vocabulary every primitive shares.
 *
 * WHY METADATA IS THE PRODUCT
 *
 * A bare default value cannot generate a good interface. `threshold: 0.7`
 * tells a UI nothing: not what it means, not whether changing it takes effect
 * now or on the next run, not whether an operator should ever see it, not
 * whether it is even relevant given the rest of the configuration. The
 * registry already carries name/description/type/range/unit, which is why
 * generating a labelled, validated control is possible at all. These four
 * fields are what turn "possible" into "good", and each one unlocks something
 * concrete rather than being documentation for its own sake.
 *
 * Every field here is OPTIONAL. Roughly 250 registrations already exist; a
 * required field would break all of them at once, and a migration that big
 * would land as a mechanical sweep whose reviewers cannot tell a considered
 * value from a copy-pasted one. Optional means each module opts in when
 * someone who understands that module classifies it. `unspecified` is an
 * honest answer and is reported as such.
 */

import { InputError } from "../../kernel/errors.ts";

/**
 * How a capability produces its result — the field that operationalises "the
 * LLM is in the passenger seat, not the driver".
 *
 * Stated as data, this stops being a slogan and becomes checkable: a
 * mechanical guard can assert that nothing in the deterministic core reaches
 * an `llm` capability, and the timeline can show which spans of a run were
 * deterministic and which were creative — an honest picture of how the
 * harness actually reached an answer.
 */
export const DETERMINISM_CLASSES = ["deterministic", "heuristic", "llm", "unspecified"] as const;
export type DeterminismClass = (typeof DETERMINISM_CLASSES)[number];

/**
 * When a change takes effect. The interface must tell the truth about this:
 * a control that silently requires a restart teaches the operator that the
 * interface lies, which is expensive to unlearn.
 */
export const EFFECT_TIMINGS = ["immediate", "next-run", "restart", "unspecified"] as const;
export type EffectTiming = (typeof EFFECT_TIMINGS)[number];

/**
 * Who a capability is for.
 *
 * This is the honest fix for the settings surface. There are 88 registered
 * customizations; presenting them as one flat list is not "exposing
 * everything", it is hiding everything in plain sight. Audience lets the
 * generator lead with what an operator actually turns, while keeping the rest
 * one disclosure away — exposure and legibility at the same time, rather than
 * traded against each other.
 */
export const AUDIENCES = ["operator", "advanced", "internal", "unspecified"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * Metadata shared by every exposure primitive.
 *
 * `when` is a visibility predicate in the same tiny expression language the
 * UI already evaluates for panels, so a dependent option can hide until it is
 * relevant. It is deliberately the SAME language rather than a second one:
 * a parallel predicate dialect would be exactly the kind of scattered
 * duplicate the architecture forbids.
 */
export type ExposureContract = Readonly<{
  determinism?: DeterminismClass;
  effect?: EffectTiming;
  audience?: Audience;
  /** Visibility predicate, e.g. `"memory.enabled"`. Empty/absent = always shown. */
  when?: string;
}>;

/** The contract with every field resolved — `unspecified` where unstated. */
export type ResolvedContract = Readonly<{
  determinism: DeterminismClass;
  effect: EffectTiming;
  audience: Audience;
  when: string;
}>;

const UNSPECIFIED: ResolvedContract = Object.freeze({
  determinism: "unspecified",
  effect: "unspecified",
  audience: "unspecified",
  when: "",
});

/**
 * Resolve a possibly-absent contract to a total one.
 *
 * Consumers (the reporter, the schema builder, the UI generator) read the
 * resolved shape so none of them re-implements the defaulting. Unstated is
 * reported as `unspecified` rather than guessed: inventing `"operator"` for
 * an unclassified knob would put unreviewed settings in front of a user,
 * which is worse than admitting the gap.
 */
export function resolveContract(contract?: ExposureContract): ResolvedContract {
  if (contract === undefined) return UNSPECIFIED;
  return Object.freeze({
    determinism: contract.determinism ?? "unspecified",
    effect: contract.effect ?? "unspecified",
    audience: contract.audience ?? "unspecified",
    when: contract.when ?? "",
  });
}

/** Whether a contract states anything at all (used for coverage reporting). */
export function isContractSpecified(contract?: ExposureContract): boolean {
  const r = resolveContract(contract);
  return (
    r.determinism !== "unspecified" ||
    r.effect !== "unspecified" ||
    r.audience !== "unspecified" ||
    r.when !== ""
  );
}

/**
 * The enumerated contract fields and their permitted values.
 *
 * ONE table rather than one hand-written `if` per field. The three `if`s this
 * replaces were byte-identical apart from the noun, which is the shape in
 * which a fourth field gets added WITHOUT its validation — the metadata
 * vocabulary is explicitly expected to grow (see the module header). Deriving
 * the check from the table makes "declared but unvalidated" unrepresentable:
 * a new enumerated field is validated the moment it appears here, and the
 * `satisfies` clause below makes the compiler reject a table key that is not
 * an actual contract field.
 */
export const CONTRACT_ENUMS = Object.freeze({
  determinism: DETERMINISM_CLASSES,
  effect: EFFECT_TIMINGS,
  audience: AUDIENCES,
}) satisfies Readonly<Record<string, readonly string[]>> &
  Readonly<Partial<Record<keyof ExposureContract, readonly string[]>>>;

/**
 * Validate a contract's fields. Unknown values are rejected at registration.
 *
 * Throws the typed {@link InputError} rather than a bare `Error`: an operator
 * registering an unknown audience is an INPUT fault, and `safeError()` maps an
 * untyped throw to `internal_error`, which would report an operator's typo as
 * a harness bug.
 */
export function validateContract(id: string, contract: ExposureContract | undefined): void {
  if (contract === undefined) return;
  for (const [field, allowed] of Object.entries(CONTRACT_ENUMS)) {
    const value = (contract as Readonly<Record<string, unknown>>)[field];
    if (value === undefined) continue;
    if (!(allowed as readonly string[]).includes(value as string)) {
      throw new InputError(
        `exposure: "${id}" has unknown ${field} "${String(value)}" ` +
          `(expected one of ${allowed.join(", ")})`,
        "exposure_contract_invalid",
        { exposureId: id, field, value: String(value) },
      );
    }
  }
}
