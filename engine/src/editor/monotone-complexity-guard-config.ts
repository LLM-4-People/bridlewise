/**
 * Canonical configuration owner for the AL5 monotone-complexity guard.
 *
 * ONE source of truth for the monotone-complexity tunable defaults (the
 * Jaccard threshold, the minimum body size, and the minimum token count).
 * Previously these lived as scattered `const AL5_DEFAULT_*` literals in
 * `src/editor/monotone-complexity-guard.ts` — a violation
 * (configurable values outside the config owner). This file is the
 * canonical owner; the guard reads its defaults from here so the values
 * are validated, named, documented, and overridable from one place.
 */

import { InputError } from "../kernel/errors.ts";

/** Tunables for the AL5 monotone-complexity guard. */
export type MonotoneComplexityConfig = Readonly<{
  /** Jaccard threshold above which two function bodies are "duplicates". */
  jaccardThreshold: number;
  /** Minimum body size (chars) before the duplicate check is applied. */
  minBodySize: number;
  /** Minimum token count before the duplicate check is applied. */
  minTokenCount: number;
}>;

/** The single canonical default config. Module-private — external
 * consumers use {@link resolveMonotoneComplexityConfig} (the validated
 * accessor). Mirrors the `intelligence-config.ts` pattern: defaults are
 * not exported so the dead-export scanner does not flag them. */
const DEFAULT_MONOTONE_COMPLEXITY_CONFIG: MonotoneComplexityConfig = Object.freeze({
  jaccardThreshold: 0.9,
  minBodySize: 80,
  minTokenCount: 100,
});

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InputError(
      `${name} must be a finite non-negative number`,
      "monotone_complexity_config_invalid",
    );
  }
  return value;
}

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new InputError(
      `${name} must be a positive finite integer`,
      "monotone_complexity_config_invalid",
    );
  }
  return value;
}

/**
 * Resolve a monotone-complexity config from a partial override,
 * validating every field at the trust boundary. Invalid bounds throw a
 * typed `InputError` (`monotone_complexity_config_invalid`) — never a
 * silent fallback that would silently degrade the guard.
 */
export function resolveMonotoneComplexityConfig(
  override: Partial<MonotoneComplexityConfig> = {},
): MonotoneComplexityConfig {
  const jaccardThreshold = override.jaccardThreshold ?? DEFAULT_MONOTONE_COMPLEXITY_CONFIG.jaccardThreshold;
  const minBodySize = override.minBodySize ?? DEFAULT_MONOTONE_COMPLEXITY_CONFIG.minBodySize;
  const minTokenCount = override.minTokenCount ?? DEFAULT_MONOTONE_COMPLEXITY_CONFIG.minTokenCount;
  finiteNonNegative(jaccardThreshold, "jaccardThreshold");
  positiveInt(minBodySize, "minBodySize");
  positiveInt(minTokenCount, "minTokenCount");
  return Object.freeze({ jaccardThreshold, minBodySize, minTokenCount });
}
