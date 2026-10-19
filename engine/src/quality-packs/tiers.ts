import { deepFreeze } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import {
  type QualityPack,
  type QualityContext,
  type QualityResult,
  runQualityPackWithCheckIds,
} from "./quality-pack.ts";

/**
 * Execution tiers for quality packs.
 *
 * Per the quality-packs research (README.md): "Incremental success never
 * substitutes for the full gate. A full run is required after tool, lockfile,
 * runtime, config, entrypoint, or generated-code-policy changes."
 *
 * | Tier | Purpose | Typical checks |
 * |---|---|---|
 * | fast | Interactive feedback | syntax + type check (runs on every save) |
 * | incremental | Pre-commit | + dead symbols + unused exports |
 * | full | Whole-repo gate (CI) | + duplicate logic + schema drift + bug zoo |
 * | holdout | Pack qualification (release) | frozen test cases not used during dev |
 */

export type QualityTier = "fast" | "incremental" | "full" | "holdout";

export const QUALITY_TIERS = deepFreeze([
  "fast", "incremental", "full", "holdout",
] as const);

/**
 * Which checks each tier runs.
 *
 * This is an ALLOWLIST over the checks a pack declares: `runQualityPackWithCheckIds`
 * keeps a check only when its id is named here, and a check named nowhere is
 * skipped without a word. That made three implemented checks — `duplicate-body`,
 * `esm-cjs-mismatch` and `duplicated-literals` — unreachable from every tier and
 * therefore from the CLI, which is the only way a pack is ever run. They were
 * written, registered on the pack, and covered by their own tests, and no run
 * could reach them.
 *
 * The whole-repo checks belong to `full` and above, because they read the entire
 * tree rather than the changed file; the interactive and pre-commit tiers stay
 * cheap deliberately. `assertEveryPackCheckIsReachable` enforces that a check
 * declared by a pack appears in at least one tier, so a check added tomorrow
 * cannot go unreachable by nobody remembering this table.
 */
export const TIER_CHECK_MAP = deepFreeze({
  fast: ["syntax-errors", "type-errors"] as const,
  incremental: ["syntax-errors", "type-errors", "dead-symbols", "unused-exports"] as const,
  full: [
    "syntax-errors", "type-errors", "dead-symbols", "unused-exports",
    "dead-branches", "duplicate-logic", "duplicate-body", "duplicated-literals",
    "esm-cjs-mismatch", "schema-drift", "config-outside-contract",
  ] as const,
  holdout: [
    "syntax-errors", "type-errors", "dead-symbols", "unused-exports",
    "dead-branches", "duplicate-logic", "duplicate-body", "duplicated-literals",
    "esm-cjs-mismatch", "schema-drift", "config-outside-contract",
    "undefined-symbols",
  ] as const,
} as const);

/**
 * Every check a pack declares must be reachable from some tier, and every id a
 * tier names must be declared by some pack.
 *
 * Both halves matter and they fail differently. An unreachable check is silent
 * capability loss — the check runs nowhere and nothing says so. An id naming no
 * check is a typo that also fails silently, because the filter is a `Set.has`
 * and a name that matches nothing simply never matches.
 *
 * Returns the two shortfalls rather than throwing, so a caller can decide
 * whether an incomplete pack set is an error (a guard) or expected (a partial
 * run over one pack).
 */
export function findTierCoverageGaps(
  packs: readonly QualityPack[],
): Readonly<{ checksInNoTier: readonly string[]; tierIdsMatchingNoCheck: readonly string[] }> {
  const declared = new Set<string>();
  for (const pack of packs) for (const check of pack.checks) declared.add(check.id);
  const named = new Set<string>();
  for (const tier of QUALITY_TIERS) for (const id of TIER_CHECK_MAP[tier]) named.add(id);
  return deepFreeze({
    checksInNoTier: deepFreeze([...declared].filter((id) => !named.has(id)).sort()),
    tierIdsMatchingNoCheck: deepFreeze([...named].filter((id) => !declared.has(id)).sort()),
  });
}

export type TierExecutionResult = Readonly<{
  tier: QualityTier;
  results: readonly QualityResult[];
  summary: Readonly<{
    totalPacks: number;
    totalChecks: number;
    passed: number;
    failed: number;
    notApplicable: number;
    toolErrors: number;
    totalDiagnostics: number;
    errors: number;
    warnings: number;
    infos: number;
  }>;
  exitCode: 0 | 1;
}>;

export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === "string" && (QUALITY_TIERS as readonly string[]).includes(value);
}

export function getTierCheckIds(tier: QualityTier): readonly string[] {
  if (!isQualityTier(tier)) {
    throw new InputError(`Invalid quality tier: ${tier}`, "quality_tier_invalid");
  }
  return TIER_CHECK_MAP[tier];
}

export function getTiersForCheckId(checkId: string): readonly QualityTier[] {
  const tiers: QualityTier[] = [];
  for (const tier of QUALITY_TIERS) {
    if (getTierCheckIds(tier).includes(checkId)) {
      tiers.push(tier);
    }
  }
  return deepFreeze(tiers);
}

export function runTier(
  tier: QualityTier,
  packs: readonly QualityPack[],
  context: QualityContext,
): TierExecutionResult {
  if (!isQualityTier(tier)) {
    throw new InputError(`Invalid quality tier: ${tier}`, "quality_tier_invalid");
  }
  const checkIds = getTierCheckIds(tier);
  const allResults: QualityResult[] = [];
  for (const pack of packs) {
    if (!pack.detect(context.files)) continue;
    const result = runQualityPackWithCheckIds(pack, checkIds, context);
    if (result.checkResults.length > 0) {
      allResults.push(result);
    }
  }
  let totalChecks = 0;
  let passed = 0;
  let failed = 0;
  let notApplicable = 0;
  let toolErrors = 0;
  let totalDiagnostics = 0;
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const result of allResults) {
    totalChecks += result.summary.totalChecks;
    passed += result.summary.passed;
    failed += result.summary.failed;
    notApplicable += result.summary.notApplicable;
    toolErrors += result.summary.toolErrors;
    totalDiagnostics += result.summary.totalDiagnostics;
    errors += result.summary.errors;
    warnings += result.summary.warnings;
    infos += result.summary.infos;
  }
  const exitCode: 0 | 1 = (failed > 0 || toolErrors > 0) ? 1 : 0;
  return deepFreeze({
    tier,
    results: deepFreeze(allResults),
    summary: deepFreeze({
      totalPacks: allResults.length,
      totalChecks,
      passed,
      failed,
      notApplicable,
      toolErrors,
      totalDiagnostics,
      errors,
      warnings,
      infos,
    }),
    exitCode,
  });
}

export function runAllTiers(
  packs: readonly QualityPack[],
  context: QualityContext,
): Readonly<Record<QualityTier, TierExecutionResult>> {
  return deepFreeze({
    fast: runTier("fast", packs, context),
    incremental: runTier("incremental", packs, context),
    full: runTier("full", packs, context),
    holdout: runTier("holdout", packs, context),
  });
}

export function tierIncludesCheck(tier: QualityTier, checkId: string): boolean {
  return getTierCheckIds(tier).includes(checkId);
}

export function compareTiers(lower: QualityTier, higher: QualityTier): Readonly<{
  addedChecks: readonly string[];
  isSuperset: boolean;
}> {
  const lowerChecks = new Set(getTierCheckIds(lower));
  const higherChecks = getTierCheckIds(higher);
  const added = higherChecks.filter((c) => !lowerChecks.has(c));
  return deepFreeze({
    addedChecks: deepFreeze(added),
    isSuperset: added.length === higherChecks.length - lowerChecks.size,
  });
}
