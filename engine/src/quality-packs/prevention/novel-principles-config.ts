/**
 * Canonical configuration owner for the EXP455 novel-principles quality
 * packs (Le Chatelier bandaid-debt + Tierra/Avida dead-code).
 *
 * ONE source of truth for the novel-principles tunable defaults.
 * Previously these lived as scattered `const LE_CHATELIER_DEFAULT_*` and
 * `const TIERRA_DEFAULT_*` literals in
 * `src/quality-packs/prevention/le-chatelier-bandaid.ts` and
 * `src/quality-packs/prevention/tierra-dead-code.ts` — a
 * violation (configurable values outside the config owner). This file
 * is the canonical owner; both quality packs read their defaults from
 * here so the values are validated, named, documented, and overridable
 * from one place.
 *
 * Research sources:
 * Le Chatelier's principle (Gall's Systemantics adaptation): a
 * system under stress reorganizes to absorb the stress; high churn
 * with low function count = "reorganization debt" (bandaid code).
 * Tierra/Avida digital organisms: fitness = complexity × (callerCount + 1).
 * The +1 prevents zero-by-multiplication for uncalled functions.
 */

import { InputError } from "../../kernel/errors.ts";

/** Tunables for the Le Chatelier bandaid-debt detector. */
export type LeChatelierConfig = Readonly<{
  /** Churn percentile (0..1) above which a file is "under stress". */
  highChurnPercentile: number;
  /** Minimum churn count for a file to be considered "under stress". */
  minChurn: number;
}>;

/** Tunables for the Tierra/Avida dead-code detector. */
export type TierraConfig = Readonly<{
  /** Bottom percentile (0..1) below which a function is a dead-code candidate. */
  bottomPercentile: number;
  /** Minimum complexity for a function to be considered (filters trivial getters). */
  minComplexity: number;
  /** Maximum caller count for a function to be "uncalled" (0 = truly uncalled). */
  maxUncalledCallers: number;
}>;

/** The single canonical default configs. Module-private — external
 * consumers use {@link resolveLeChatelierConfig} and
 * {@link resolveTierraConfig} (the validated accessors). Mirrors the
 * `intelligence-config.ts` pattern: defaults are not exported so the
 * dead-export scanner does not flag them. */
const DEFAULT_LE_CHATELIER_CONFIG: LeChatelierConfig = Object.freeze({
  highChurnPercentile: 0.75,
  minChurn: 5,
});

const DEFAULT_TIERRA_CONFIG: TierraConfig = Object.freeze({
  bottomPercentile: 0.10,
  minComplexity: 1,
  maxUncalledCallers: 0,
});

function fraction01(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new InputError(
      `${name} must be a finite number in [0, 1]`,
      "novel_principles_config_invalid",
    );
  }
  return value;
}

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new InputError(
      `${name} must be a positive finite integer`,
      "novel_principles_config_invalid",
    );
  }
  return value;
}

function nonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new InputError(
      `${name} must be a non-negative finite integer`,
      "novel_principles_config_invalid",
    );
  }
  return value;
}

/**
 * Resolve a Le Chatelier config from a partial override, validating every
 * field at the trust boundary. Invalid bounds throw a typed `InputError`.
 */
export function resolveLeChatelierConfig(
  override: Partial<LeChatelierConfig> = {},
): LeChatelierConfig {
  const highChurnPercentile = override.highChurnPercentile ?? DEFAULT_LE_CHATELIER_CONFIG.highChurnPercentile;
  const minChurn = override.minChurn ?? DEFAULT_LE_CHATELIER_CONFIG.minChurn;
  fraction01(highChurnPercentile, "highChurnPercentile");
  nonNegativeInt(minChurn, "minChurn");
  return Object.freeze({ highChurnPercentile, minChurn });
}

/**
 * Resolve a Tierra config from a partial override, validating every field
 * at the trust boundary. Invalid bounds throw a typed `InputError`.
 */
export function resolveTierraConfig(
  override: Partial<TierraConfig> = {},
): TierraConfig {
  const bottomPercentile = override.bottomPercentile ?? DEFAULT_TIERRA_CONFIG.bottomPercentile;
  const minComplexity = override.minComplexity ?? DEFAULT_TIERRA_CONFIG.minComplexity;
  const maxUncalledCallers = override.maxUncalledCallers ?? DEFAULT_TIERRA_CONFIG.maxUncalledCallers;
  fraction01(bottomPercentile, "bottomPercentile");
  positiveInt(minComplexity, "minComplexity");
  nonNegativeInt(maxUncalledCallers, "maxUncalledCallers");
  return Object.freeze({ bottomPercentile, minComplexity, maxUncalledCallers });
}
