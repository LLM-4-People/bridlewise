/**
 * Canonical configuration owner for the action-affinity re-ranker.
 *
 * ONE source of truth for the action-affinity tunable defaults (the
 * same-verb bonus and the same-class bonus). Previously these lived as
 * scattered `const ACTION_AFFINITY_DEFAULT_SAME_VERB_BONUS = 0.15` /
 * `ACTION_AFFINITY_DEFAULT_SAME_CLASS_BONUS = 0.05` literals in
 * `src/intelligence/action-affinity.ts` — a violation
 * (configurable values outside the config owner). This file is the
 * canonical owner; the re-ranker reads its defaults from here so the
 * values are validated, named, documented, and overridable from one
 * place.
 */

import { InputError } from "../kernel/errors.ts";

/** Tunables for the action-affinity re-ranker. */
export type ActionAffinityConfig = Readonly<{
  /** Bonus added when the query verb matches the symbol's action class. */
  sameVerbBonus: number;
  /** Bonus added when the query verb's class matches the symbol's class. */
  sameClassBonus: number;
  /**
   * Bonus per query subject-word found in a candidate's name, used to break
   * ties when picking one representative. Owned here with the other two so
   * all three tuning weights are read from one place; it was a literal at its
   * call site, which is a second place to look for the same kind of answer.
   */
  subjectKeywordBonus: number;
}>;

/** The single canonical default config. Module-private — external
 * consumers use {@link resolveActionAffinityConfig} (the validated
 * accessor). Mirrors the `intelligence-config.ts` pattern: defaults are
 * not exported so the dead-export scanner does not flag them. */
const DEFAULT_ACTION_AFFINITY_CONFIG: ActionAffinityConfig = Object.freeze({
  sameVerbBonus: 0.15,
  sameClassBonus: 0.05,
  subjectKeywordBonus: 0.05,
});

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InputError(
      `${name} must be a finite non-negative number`,
      "action_affinity_config_invalid",
    );
  }
  return value;
}

/**
 * Resolve an action-affinity config from a partial override, validating
 * every field at the trust boundary. Invalid bounds throw a typed
 * `InputError` (`action_affinity_config_invalid`) — never a silent
 * fallback that would silently degrade the re-ranker.
 */
export function resolveActionAffinityConfig(
  override: Partial<ActionAffinityConfig> = {},
): ActionAffinityConfig {
  const sameVerbBonus = override.sameVerbBonus ?? DEFAULT_ACTION_AFFINITY_CONFIG.sameVerbBonus;
  const sameClassBonus = override.sameClassBonus ?? DEFAULT_ACTION_AFFINITY_CONFIG.sameClassBonus;
  const subjectKeywordBonus = override.subjectKeywordBonus ?? DEFAULT_ACTION_AFFINITY_CONFIG.subjectKeywordBonus;
  finiteNonNegative(sameVerbBonus, "sameVerbBonus");
  finiteNonNegative(sameClassBonus, "sameClassBonus");
  finiteNonNegative(subjectKeywordBonus, "subjectKeywordBonus");
  return Object.freeze({ sameVerbBonus, sameClassBonus, subjectKeywordBonus });
}
