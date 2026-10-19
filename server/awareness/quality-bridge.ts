/**
 * Quality bridge — provides codebase quality indicators using the
 * awareness engine's quality signal (regex-based, no tree-sitter WASM
 * dependency) and the intelligence module's repository map for structural
 * analysis.
 *
 * The full quality aggregator (`src/quality/aggregator.ts`) requires
 * tree-sitter WASM parsers which are not available in the web UI server.
 * This bridge provides a quality score derived from the awareness engine's
 * signals — issue density, complexity distribution, clone stats, and
 * type-level coverage.
 */

import { getAwarenessSnapshot, getAwarenessSnapshotAsync } from "./awareness-bridge.ts";
import { getRepositoryMapSummary, getRepositoryMapAsync } from "../intelligence/intelligence-bridge.ts";
import { assertProjectPathOwnership, type FsGate } from "../filesystem/fs-gate.ts";
import { getQualityConfig, getLintGateConfig, type QualityConfig } from "../kernel/harness-config.ts";

// ── Quality scoring model (single owner) ──
// The awareness-derived quality score starts at a perfect score and subtracts
// bounded penalties for each signal. Each penalty is capped so one signal
// cannot single-handedly zero the score. The scoring WEIGHTS are owned by the
// harness config file (`webUi.quality`) and read through `getQualityConfig`
// The grade BOUNDARIES (A/B/C/D/F at
// 90/80/70/60) are display semantics, not tunable weights — they stay here as
// named constants. The `no-hardcoded-values` prevention test enforces no
// inline `Math.min(<literal>)` redeclares the config-driven weights.

/** Grade-letter boundaries (display semantics, NOT configurable weights). */
const GRADE_A_MIN = 90;
const GRADE_B_MIN = 80;
const GRADE_C_MIN = 70;
const GRADE_D_MIN = 60;

/**
 * Compute the configured composite index over the MEASURED signals. A `null`
 * sub-metric means "not measured" — its penalty is SKIPPED, never computed
 * from a fabricated 0 (a `?? 0` here previously turned a failed quality
 * computation into a zero-penalty — i.e. a high score). The score is
 * informational only; pass/fail decisions read the measured sub-metrics
 * against the declared lint gate, never this composite.
 */
function computeScore(
  cfg: QualityConfig,
  issueDensity: number | null,
  issuesPerKloc: number | null,
  hotspotCount: number | null,
  cloneRatio: number | null,
  typedFraction: number | null,
): number {
  let score = cfg.scoreMax;
  if (issuesPerKloc !== null) score -= Math.min(cfg.penaltyCapIssuesPerKloc, issuesPerKloc * cfg.penaltyWeightIssuesPerKloc);
  if (hotspotCount !== null) score -= Math.min(cfg.penaltyCapHotspots, hotspotCount * cfg.penaltyWeightHotspots);
  if (cloneRatio !== null) score -= Math.min(cfg.penaltyCapClones, cloneRatio * cfg.penaltyWeightClones);
  if (typedFraction !== null) score -= Math.min(cfg.penaltyCapUntyped, (1 - typedFraction) * cfg.penaltyWeightUntyped);
  if (issueDensity !== null) score -= Math.min(cfg.penaltyCapIssueDensity, issueDensity * cfg.penaltyWeightIssueDensity);
  return Math.max(cfg.scoreMin, Math.min(cfg.scoreMax, Math.round(score)));
}

export { computeScore };

function gradeOf(score: number): string {
  if (score >= GRADE_A_MIN) return "A";
  if (score >= GRADE_B_MIN) return "B";
  if (score >= GRADE_C_MIN) return "C";
  if (score >= GRADE_D_MIN) return "D";
  return "F";
}

export type QualityIndicator = Readonly<{
  overallScore: number;
  grade: string;
  issueDensity: number;
  issuesPerKloc: number;
  totalIssues: number;
  topCategories: readonly Readonly<{ category: string; count: number }>[];
  complexity: Readonly<{ mean: number; median: number; p95: number; max: number; hotspotCount: number }> | null;
  typeLevel: Readonly<{ level: string; typedFileFraction: number; typedParameterFraction: number }> | null;
  cloneStats: Readonly<{ cloneGroupCount: number; clonedFunctionCount: number; cloneRatio: number }> | null;
  fileCount: number;
  functionCount: number;
  totalLoc: number;
  moduleCount: number;
  recommendations: readonly string[];
  /** Which sub-metrics were ACTUALLY measured this snapshot. A `false`
   * flag means the corresponding figures are absent/placeholder — a
   * consumer must never treat them as measurements (deny-by-default: the
   * lint auto-check FAILS when any required flag is false). Additive
   * field — the rest of the wire shape is unchanged. */
  measured: Readonly<{ quality: boolean; complexity: boolean; clones: boolean; typeLevel: boolean }>;
}>;

/**
 * Build the recommendation list from the MEASURED sub-metrics against the
 * DECLARED lint-gate thresholds (`webUi.quality.lintGate` via
 * `getLintGateConfig` — the single owner; these used to be inline
 * 10/5/0.15/0.5 literals that could drift from the gate). A `null`
 * sub-metric was not measured: no recommendation is invented for it, and
 * the "looks good" line is withheld (an unmeasured signal is not a clean
 * signal).
 */
function buildRecommendations(
  issuesPerKloc: number | null,
  hotspotCount: number | null,
  cloneRatio: number | null,
  typedFraction: number | null,
  quality: { topCategories: readonly Readonly<{ category: string; count: number }>[] } | null,
): readonly string[] {
  const gate = getLintGateConfig();
  const recs: string[] = [];
  if (issuesPerKloc !== null && issuesPerKloc > gate.maxIssuesPerKloc) recs.push("High issue density — consider running the quality pack to identify and fix the most common issues.");
  if (hotspotCount !== null && hotspotCount > gate.maxComplexityHotspots) recs.push(`${hotspotCount} complexity hotspots detected — refactor high-complexity functions to reduce maintenance burden.`);
  if (cloneRatio !== null && cloneRatio > gate.maxCloneRatio) recs.push(`${(cloneRatio * 100).toFixed(1)}% clone ratio — extract shared logic to reduce duplication.`);
  if (typedFraction !== null && typedFraction < gate.minTypedFileFraction) recs.push("Low type annotation coverage — add type annotations to improve safety and IDE support.");
  if (quality?.topCategories !== undefined) {
    for (const cat of quality.topCategories.slice(0, getQualityConfig().topCategoriesCount)) {
      if (cat.count > 0) recs.push(`${cat.category}: ${cat.count} issues — address this category for the highest impact.`);
    }
  }
  const anyUnmeasured = issuesPerKloc === null || hotspotCount === null || cloneRatio === null || typedFraction === null;
  if (anyUnmeasured) {
    recs.push("Some quality signals could not be measured this time, so this list may be incomplete.");
  } else if (recs.length === 0) {
    recs.push("Codebase health looks good — no major quality issues detected.");
  }
  return recs;
}

export function getQualityIndicator(projectPath: string, gate?: FsGate): QualityIndicator {
  if (gate !== undefined) assertProjectPathOwnership(projectPath, gate);
  const snap = getAwarenessSnapshot(projectPath);
  const mapSummary = getRepositoryMapSummary(projectPath);
  return buildQualityIndicator(snap, mapSummary);
}

/**
 * Async quality indicator — awaits the off-thread awareness + repository-
 * map worker builds so the compute NEVER blocks the event loop. Used by
 * the post-run quality call (run.ts) and the lint auto-check so a large
 * codebase's quality compute (which previously wedged the server for tens
 * of seconds) runs off-thread. The awaited workers yield the event loop
 * while building, so HTTP requests stay served.
 */
export async function getQualityIndicatorAsync(projectPath: string, gate?: FsGate): Promise<QualityIndicator> {
  if (gate !== undefined) assertProjectPathOwnership(projectPath, gate);
  // Await both off-thread builds (shared promises — concurrent callers
  // for the same path share one worker each). A worker failure propagates
  // as a typed error the caller can catch (honest, not a silent fallback).
  // After the await the caches are "ready", so the sync accessors below
  // return instantly (no re-build, no throw).
  await Promise.all([
    getAwarenessSnapshotAsync(projectPath),
    getRepositoryMapAsync(projectPath),
  ]);
  const snap = getAwarenessSnapshot(projectPath);
  const mapSummary = getRepositoryMapSummary(projectPath);
  return buildQualityIndicator(snap, mapSummary);
}

/** Shared builder so the sync + async paths produce the identical shape. */
function buildQualityIndicator(
  snap: import("../kernel/canonical.ts").AwarenessSnapshot,
  mapSummary: ReturnType<typeof getRepositoryMapSummary>,
): QualityIndicator {
  // NO `?? 0` LAUNDERING: a null signal means the computation did not
  // produce a measurement. `null` is carried (not a fabricated 0) into the
  // score + the recommendations, and the `measured` flags tell every
  // consumer which figures are real. (The `?? 0` coercion here previously
  // turned a failed quality computation into zero penalties — a HIGH
  // score for an unmeasured codebase.)
  const measured = {
    quality: snap.quality !== null,
    complexity: snap.complexity !== null,
    clones: snap.clones !== null,
    typeLevel: snap.typeLevel !== null,
  } as const;

  const issueDensity = snap.quality !== null ? snap.quality.issueDensity : null;
  const issuesPerKloc = snap.quality !== null ? snap.quality.issuesPerKloc : null;
  const hotspotCount = snap.complexity !== null ? snap.complexity.hotspotCount : null;
  const typedFraction = snap.typeLevel !== null ? snap.typeLevel.typedFileFraction : null;
  const cloneRatio = snap.clones !== null ? snap.clones.cloneCoverage : null;

  const overallScore = computeScore(getQualityConfig(), issueDensity, issuesPerKloc, hotspotCount, cloneRatio, typedFraction);
  const grade = gradeOf(overallScore);

  return {
    overallScore,
    grade,
    // Wire-required numeric fields: 0 here is a PLACEHOLDER when
    // `measured.quality` is false (the wire shape predates the flags and
    // the client requires numbers). The flag is authoritative — consumers
    // must render/decide from `measured`, never from these placeholders.
    issueDensity: issueDensity ?? 0,
    issuesPerKloc: issuesPerKloc ?? 0,
    totalIssues: snap.quality !== null ? snap.quality.totalIssues : 0,
    topCategories: snap.quality !== null ? snap.quality.topCategories : [],
    complexity: snap.complexity !== null
      ? { mean: snap.complexity.mean, median: snap.complexity.median, p95: snap.complexity.p95, max: snap.complexity.max, hotspotCount: snap.complexity.hotspotCount }
      : null,
    typeLevel: snap.typeLevel,
    // Honest absence: an unmeasured clone signal is `null`, not a
    // fabricated `{ 0, 0, 0 }` stats object.
    cloneStats: snap.clones !== null
      ? { cloneGroupCount: snap.clones.familyCount, clonedFunctionCount: snap.clones.topFamilies.length, cloneRatio: snap.clones.cloneCoverage }
      : null,
    fileCount: mapSummary.fileCount,
    functionCount: snap.functionCount,
    totalLoc: snap.totalLoc,
    moduleCount: snap.moduleCount,
    recommendations: buildRecommendations(issuesPerKloc, hotspotCount, cloneRatio, typedFraction, snap.quality),
    measured,
  };
}
