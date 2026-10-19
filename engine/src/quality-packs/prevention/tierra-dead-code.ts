// src/quality-packs/prevention/tierra-dead-code.ts
//
// AL2 Tierra/Avida dead-code fitness — EXP442/EXP455 POSITIVE finding.
//
// Digital organisms (Tierra, Avida) assign a "fitness" score to each
// organism based on how well it reproduces. Applied to code: each
// function's fitness is its `complexity × (callerCount + 1)` —
// functions with low complexity AND few callers are "unfit" (dead-code
// candidates). The bottom percentile (computed, not hardcoded) by
// fitness are flagged.
//
// EXP442 measured: dead-code recall 0→0.183 (the existing
// `deadSymbolCheck` finds 0 of the unexported-uncalled dead set; AL2
// finds 18.3% at 64.8% precision). COMPLEMENTS the existing check
// (different dead-code class — exported-unused vs unexported-uncalled).
// On typescript: recall 0.214, precision 0.957.
//
// Research sources:
// - EXP442 (`novel-principles`): Tierra/Avida fitness on babel + typescript.
// - Ofria, Lenski, Adami (2004) "The digital life of digital organisms":
// fitness = replication rate × computational merit. We map
// replication rate → callerCount (how often the function is "called
// back" by the rest of the system) and computational merit →
// complexity (how much the function does).
// - EXP455 merge manifest: AL2 marked as NEW quality check (`src/
// quality-packs/prevention/tierra-dead-code.ts` + register in
// `index.ts`).
//
// Public API:
// - `detectTierraDeadCode({ map, functionRecords, churn, options })` →
// a list of dead-code candidates with fitness + percentile.
//
// No code extracted from external sources; the fitness ranking is a
// textbook percentile computation. The richness is in the fitness
// formula (complexity × (callers + 1)) — the Tierra/Avida-inspired
// mapping.

import { deepFreeze } from "../../kernel/integrity.ts";
import { percentileOf } from "../../shared/git-churn.ts";
import type { RepositoryMap } from "../../intelligence/intelligence-types.ts";
import { resolveTierraConfig } from "./novel-principles-config.ts";

export type TierraFunctionRecord = Readonly<{
  filePath: string;
  name: string;
  /** Cyclomatic complexity (1 = trivial). */
  complexity: number;
  /** Number of call sites that invoke this function (callers). */
  callerCount: number;
}>;

export type TierraDeadCodeOptions = Readonly<{
  /** Bottom percentile threshold for flagging (default 0.10 = bottom 10%). */
  bottomPercentile?: number;
  /** Minimum complexity to consider (default 1). */
  minComplexity?: number;
  /** Maximum caller count to consider "uncalled" (default 0). */
  maxUncalledCallers?: number;
}>;

export type TierraDeadCodeFinding = Readonly<{
  filePath: string;
  name: string;
  /** The Tierra fitness score: complexity × (callerCount + 1). */
  fitness: number;
  /** Percentile of fitness within the codebase (0 = lowest = most likely dead). */
  fitnessPercentile: number;
  /** Why this function was flagged. */
  reason: string;
}>;

export type TierraDeadCodeResult = Readonly<{
  findings: readonly TierraDeadCodeFinding[];
  /** Total functions evaluated. */
  totalFunctions: number;
  /** Bottom-percentile threshold used. */
  bottomPercentile: number;
}>;

// R44: the tunable defaults are resolved through the canonical
// `resolveTierraConfig` owner (validates bounds at the trust boundary
//). The local aliases keep the existing call-site shape
// while making the resolver USED (not a dead export).
const TIERRA_DEFAULT_BOTTOM_PERCENTILE = resolveTierraConfig().bottomPercentile;
const TIERRA_DEFAULT_MIN_COMPLEXITY = resolveTierraConfig().minComplexity;
const TIERRA_DEFAULT_MAX_UNCALLED = resolveTierraConfig().maxUncalledCallers;

/**
 * Detect dead-code candidates using the Tierra/Avida fitness score.
 *
 * Fitness = complexity × (callerCount + 1). The +1 prevents zero-by-
 * multiplication for uncalled functions (which would otherwise always
 * have fitness 0 and dominate the bottom percentile regardless of
 * complexity). With the +1, an uncalled complex function scores higher
 * than an uncalled trivial function — the trivial one is the more likely
 * dead-code.
 *
 * The bottom `bottomPercentile` of functions by fitness are flagged.
 * This is computed from the actual distribution (no hardcoded
 * threshold) — so the rule adapts to each codebase.
 *
 * The caller is responsible for providing `callerCount` per record. Use
 * `computeCallerCountsFromMap` to derive caller counts from a
 * `RepositoryMap` when only the import graph is available; otherwise
 * use exact call-site counts (e.g. from `quick-view.ts`).
 */
export function detectTierraDeadCode(
  records: readonly TierraFunctionRecord[],
  options: TierraDeadCodeOptions = {},
): TierraDeadCodeResult {
  const bottomPercentile = options.bottomPercentile ?? TIERRA_DEFAULT_BOTTOM_PERCENTILE;
  const minComplexity = options.minComplexity ?? TIERRA_DEFAULT_MIN_COMPLEXITY;
  const maxUncalledCallers = options.maxUncalledCallers ?? TIERRA_DEFAULT_MAX_UNCALLED;

  // Filter to functions within scope.
  const filtered = records.filter(
    (r) => r.complexity >= minComplexity,
  );

  // Compute fitness for each function.
  const withFitness = filtered.map((r) => ({
    record: r,
    fitness: r.complexity * (r.callerCount + 1),
  }));

  // Sort fitness ascending to compute percentiles.
  const sortedFitness = withFitness.map((w) => w.fitness).sort((a, b) => a - b);

  // Find functions whose fitness percentile is at or below the bottom
  // threshold AND whose callerCount is at or below the uncalled
  // threshold.
  const findings: TierraDeadCodeFinding[] = [];
  for (const w of withFitness) {
    const pct = percentileOf(w.fitness, sortedFitness);
    if (pct > bottomPercentile) continue;
    if (w.record.callerCount > maxUncalledCallers) continue;
    findings.push({
      filePath: w.record.filePath,
      name: w.record.name,
      fitness: w.fitness,
      fitnessPercentile: pct,
      reason: `fitness=${w.fitness} (complexity=${w.record.complexity} × (callers+1)=${w.record.callerCount + 1}); bottom ${pct.toFixed(4)} ≤ ${bottomPercentile}`,
    });
  }

  // Sort findings by fitness ascending (most-likely-dead first).
  findings.sort((a, b) => a.fitness - b.fitness);

  return deepFreeze({
    findings: deepFreeze(findings),
    totalFunctions: filtered.length,
    bottomPercentile,
  });
}

/**
 * Compute callerCount for each function from the repository map.
 * The callerCount is the number of modules that import the symbol's
 * name (a proxy for the number of call sites — exact call-site counts
 * would require a full CallExpression walk, which quick-view.ts
 * already does; here we use the import graph as a cheaper proxy).
 */
export function computeCallerCountsFromMap(
  map: RepositoryMap,
  records: readonly Readonly<{ filePath: string; name: string }>[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  // Build a map of imported-name → set-of-importing-modules.
  const importers = new Map<string, Set<string>>();
  for (const m of map.modules) {
    for (const imp of m.imports) {
      for (const name of imp.importedNames) {
        let set = importers.get(name);
        if (set === undefined) {
          set = new Set();
          importers.set(name, set);
        }
        set.add(m.path);
      }
    }
  }
  for (const r of records) {
    const key = `${r.filePath}:${r.name}`;
    const set = importers.get(r.name);
    out.set(key, set === undefined ? 0 : set.size);
  }
  return out;
}
