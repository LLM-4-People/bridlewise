// src/quality-packs/prevention/le-chatelier-bandaid.ts
//
// Le Chatelier bandaid-debt detection — EXP442/EXP455 POSITIVE finding.
//
// Le Chatelier's principle: a system under stress reorganizes to
// absorb the stress. Applied to code (Gall's Systemantics adaptation):
// a file under stress (high churn) reorganizes by adding functions. A
// high-churn file whose function count is BELOW the codebase median
// has NOT reorganized — it has accumulated "bandaid debt" (quick fixes
// instead of refactoring).
//
// EXP442 measured: bandaid FP 121→0 (r=0.655 on babel); flags 138
// high-churn files → 17 real bandaid-debt files (high churn + NOT split).
//
// Research sources:
// - EXP442 (`novel-principles`): Pearson(churn, log(fnCount)) per
// codebase computed; flag high-churn + below-median fn-count.
// - Le Chatelier's principle (1888): "Tout système en équilibre
// éprouve, sous l'influence d'une action qui tend à en changer les
// conditions, une modification telle qu'elle amène, si elle pouvait
// se produire seule, un changement opposé." Applied to code by
// John Gall (Systemantics, 1975): a system under stress reorganizes
// to absorb the stress; failure to reorganize is a "debt" symptom.
// - EXP455 merge manifest: Le Chatelier marked as NEW quality check.
//
// Public API:
// - `detectLeChatelierBandaid({ fileChurn, fileFunctionCounts, options })` →
// a list of bandaid-debt files with churn + fn-count + percentile.
//
// No code extracted from external sources; the Pearson correlation +
// percentile walk are textbook. The richness is the Le Chatelier
// interpretation (high churn + below-median fn-count = "no reorganization").

import { deepFreeze } from "../../kernel/integrity.ts";
import { computeGitChurn, median, percentileOf, pearson } from "../../shared/git-churn.ts";
import { resolveLeChatelierConfig } from "./novel-principles-config.ts";

export type LeChatelierFileRecord = Readonly<{
  /** File path relative to the codebase root. */
  filePath: string;
  /** Number of functions in this file. */
  functionCount: number;
  /** Per-file commit count over the recent history window. */
  churnCount: number;
}>;

export type LeChatelierOptions = Readonly<{
  /** Churn percentile threshold for "high churn" (default 0.75 = top 25%). */
  highChurnPercentile?: number;
  /** Whether to use the median fn-count as the "low" threshold (default true). */
  useMedianFunctionCount?: boolean;
  /** Explicit low-fn-count threshold (overrides median). */
  lowFunctionCountThreshold?: number;
  /** Minimum churn to consider (default 5 — files with <5 commits are not "stressed"). */
  minChurn?: number;
}>;

export type LeChatelierFinding = Readonly<{
  filePath: string;
  /** Per-file churn count. */
  churnCount: number;
  /** Function count in this file. */
  functionCount: number;
  /** Churn percentile within the codebase. */
  churnPercentile: number;
  /** Why this file was flagged. */
  reason: string;
}>;

export type LeChatelierResult = Readonly<{
  findings: readonly LeChatelierFinding[];
  /** Pearson correlation of churn vs log(fnCount) across the codebase. */
  churnFnCountCorrelation: number;
  /** The median function count (the "low" threshold). */
  medianFunctionCount: number;
  /** Total files evaluated. */
  totalFiles: number;
}>;

// R44: the tunable defaults are resolved through the canonical
// `resolveLeChatelierConfig` owner (validates bounds at the trust boundary
//). The local aliases keep the existing call-site shape
// while making the resolver USED (not a dead export).
const LE_CHATELIER_DEFAULT_HIGH_CHURN_PERCENTILE = resolveLeChatelierConfig().highChurnPercentile;
const LE_CHATELIER_DEFAULT_MIN_CHURN = resolveLeChatelierConfig().minChurn;

/**
 * Detect bandaid-debt files using the Le Chatelier principle. A file is
 * flagged when:
 * (a) its churn is in the top `highChurnPercentile` (the file is
 * "under stress"), AND
 * (b) its function count is at or below the codebase median (the
 * file has NOT reorganized by adding functions).
 *
 * The Pearson correlation of churn vs log(fnCount) is reported as a
 * "Le Chatelier index" — a strong positive correlation means the
 * codebase reorganizes well (high-churn files add functions); a weak
 * or negative correlation means bandaid debt is widespread.
 */
export function detectLeChatelierBandaid(
  records: readonly LeChatelierFileRecord[],
  options: LeChatelierOptions = {},
): LeChatelierResult {
  const highChurnPercentile = options.highChurnPercentile ?? LE_CHATELIER_DEFAULT_HIGH_CHURN_PERCENTILE;
  const minChurn = options.minChurn ?? LE_CHATELIER_DEFAULT_MIN_CHURN;

  if (records.length === 0) {
    return deepFreeze({
      findings: [],
      churnFnCountCorrelation: 0,
      medianFunctionCount: 0,
      totalFiles: 0,
    });
  }

  // Filter to files with at least `minChurn` commits (not "stressed" otherwise).
  const filtered = records.filter((r) => r.churnCount >= minChurn);

  // Compute the median function count.
  const fnCounts = filtered.map((r) => r.functionCount);
  const medianFn = options.lowFunctionCountThreshold
    ?? (options.useMedianFunctionCount ?? true ? median(fnCounts) : 0);

  // Compute churn percentiles.
  const sortedChurn = filtered.map((r) => r.churnCount).sort((a, b) => a - b);

  // Compute Pearson(churn, log(fnCount+1)) across the codebase.
  const churns = filtered.map((r) => r.churnCount);
  const logFns = filtered.map((r) => Math.log(r.functionCount + 1));
  const correlation = pearson(churns, logFns);

  // Flag files meeting both criteria.
  const findings: LeChatelierFinding[] = [];
  for (const r of filtered) {
    const pct = percentileOf(r.churnCount, sortedChurn);
    if (pct < highChurnPercentile) continue;
    if (r.functionCount > medianFn) continue;
    findings.push({
      filePath: r.filePath,
      churnCount: r.churnCount,
      functionCount: r.functionCount,
      churnPercentile: pct,
      reason: `high churn (pct=${pct.toFixed(3)} ≥ ${highChurnPercentile}) + low fn-count (${r.functionCount} ≤ median ${medianFn.toFixed(1)}) = Le Chatelier violation (stress without reorganization)`,
    });
  }

  // Sort findings by churn descending (most-stressed first).
  findings.sort((a, b) => b.churnCount - a.churnCount);

  return deepFreeze({
    findings: deepFreeze(findings),
    churnFnCountCorrelation: correlation,
    medianFunctionCount: medianFn,
    totalFiles: filtered.length,
  });
}

/**
 * Convenience: build the file records by combining the git-churn map
 * with a per-file function count. The function count is provided by the
 * caller (the awareness engine or the repository map) — this helper just
 * joins the two data sources.
 */
export function buildLeChatelierRecords(
  rootPath: string,
  fileFunctionCounts: ReadonlyMap<string, number>,
  options: Readonly<{ depth?: number; useGit?: boolean }> = {},
): readonly LeChatelierFileRecord[] {
  const churn = computeGitChurn(rootPath, options);
  const records: LeChatelierFileRecord[] = [];
  // Iterate over files with known function counts (the codebase).
  for (const [filePath, functionCount] of fileFunctionCounts) {
    records.push({
      filePath,
      functionCount,
      churnCount: churn.fileChurn.get(filePath) ?? 0,
    });
  }
  return deepFreeze(records);
}
