/**
 * EXP387 — Real-time multi-turn awareness delta.
 *
 * Per the user's directive: "the info we feed to the llm must be
 * dynamically updated in real time somehow, so that after many multi
 * turns, it is still relevant". This module computes the DELTA between
 * two awareness snapshots (before and after an edit) and produces a
 * compact summary the LLM sees at the start of the next turn:
 *
 * "After your edit: function count +1, complexity +5, clone coverage +2%."
 *
 * The delta is computed by `computeDelta(before, after)`. The engine
 * keeps the last snapshot internally; calling `computeWithDelta(path)`
 * returns both the new snapshot AND the delta vs the previous one.
 *
 * The DELTA is a separate output from the compact block — it's
 * prepended to the LLM's prompt at the start of each turn, AFTER the
 * awareness block:
 *
 * <awareness block>
 *
 * AFTER YOUR LAST EDIT (turn N):
 * - fileCount: 118 → 119 (+1)
 * - functionCount: 854 → 855 (+1)
 * - complexity.mean: 1.57 → 1.58 (+0.01)
 * - clones.familyCount: 5 → 6 (+1) [new clone family introduced]
 *
 * This gives the LLM FEEDBACK on its edits — it can see whether its
 * edit made the codebase better or worse.
 */
import type { AwarenessSnapshot } from "./types.ts";
import { roundKeepNonFinite } from "../shared/numeric-helpers.ts";

/** A single delta line: signal name, before, after, change. */
export interface DeltaLine {
  signal: string;
  before: number | string | boolean;
  after: number | string | boolean;
  change: number | string;
}

/** The full delta between two snapshots. */
export interface AwarenessDelta {
  /** ISO timestamp of the new snapshot. */
  computedAt: string;
  /** Number of files re-analyzed (cache miss). */
  reanalyzedFiles: number;
  /** Number of files reused from cache. */
  cachedFiles: number;
  /** Wall-clock time to compute the new snapshot (ms). */
  computeTimeMs: number;
  /** Lines describing the changes. */
  lines: readonly DeltaLine[];
  /** Compact text representation (prepending to the LLM prompt). */
  text: string;
}

/**
 * Compute the delta between two snapshots. Returns the lines describing
 * which signals CHANGED (signals that did not change are omitted).
 */
export function computeDelta(before: AwarenessSnapshot, after: AwarenessSnapshot): AwarenessDelta {
  const lines: DeltaLine[] = [];
  // Numeric comparisons — top-level counts.
  addNumDelta(lines, "fileCount", before.fileCount, after.fileCount);
  addNumDelta(lines, "functionCount", before.functionCount, after.functionCount);
  addNumDelta(lines, "moduleCount", before.moduleCount, after.moduleCount);
  addNumDelta(lines, "totalLoc", before.totalLoc, after.totalLoc);
  // Per-signal numeric fields.
  if (before.complexity && after.complexity) {
    addNumDelta(lines, "complexity.mean", before.complexity.mean, after.complexity.mean, 2);
    addNumDelta(lines, "complexity.max", before.complexity.max, after.complexity.max);
    addNumDelta(lines, "complexity.hotspotCount", before.complexity.hotspotCount, after.complexity.hotspotCount);
  }
  if (before.clones && after.clones) {
    addNumDelta(lines, "clones.familyCount", before.clones.familyCount, after.clones.familyCount);
    addNumDelta(lines, "clones.cloneCoverage", before.clones.cloneCoverage, after.clones.cloneCoverage, 4);
  }
  if (before.health && after.health) {
    addNumDelta(lines, "health.todoCount", before.health.todoCount, after.health.todoCount);
    addNumDelta(lines, "health.emptyCatchCount", before.health.emptyCatchCount, after.health.emptyCatchCount);
    addNumDelta(lines, "health.magicNumberCount", before.health.magicNumberCount, after.health.magicNumberCount);
    addNumDelta(lines, "health.deadExportCount", before.health.deadExportCount, after.health.deadExportCount);
  }
  if (before.debt && after.debt) {
    addNumDelta(lines, "debt.totalDebt", before.debt.totalDebt, after.debt.totalDebt, 2);
  }
  if (before.testCoverage && after.testCoverage) {
    addNumDelta(lines, "testCoverage.ratio", before.testCoverage.ratio, after.testCoverage.ratio, 4);
  }
  if (before.entropy && after.entropy) {
    addNumDelta(lines, "entropy.shannon", before.entropy.shannon, after.entropy.shannon, 4);
  }
  if (before.dependencies && after.dependencies) {
    addNumDelta(lines, "dependencies.circularCount", before.dependencies.circularCount, after.dependencies.circularCount);
    addNumDelta(lines, "dependencies.missingSymbolCount", before.dependencies.missingSymbolCount, after.dependencies.missingSymbolCount);
  }
  // EXP372 new signals.
  if (before.bellClones && after.bellClones) {
    addNumDelta(lines, "bellClones.totalPairs", before.bellClones.totalPairs, after.bellClones.totalPairs);
  }
  if (before.banachContraction && after.banachContraction) {
    addNumDelta(lines, "banachContraction.meanContraction", before.banachContraction.meanContraction, after.banachContraction.meanContraction, 4);
  }
  if (before.qecDistance && after.qecDistance) {
    addNumDelta(lines, "qecDistance.fragileCount", before.qecDistance.fragileCount, after.qecDistance.fragileCount);
  }
  if (before.waveletClones && after.waveletClones) {
    addNumDelta(lines, "waveletClones.waveletFamilyCount", before.waveletClones.waveletFamilyCount, after.waveletClones.waveletFamilyCount);
  }
  if (before.ricciCurvature && after.ricciCurvature) {
    addNumDelta(lines, "ricciCurvature.bridgeCount", before.ricciCurvature.bridgeCount, after.ricciCurvature.bridgeCount);
  }
  if (before.topos && after.topos) {
    addNumDelta(lines, "topos.lemFailsCount", before.topos.lemFailsCount, after.topos.lemFailsCount);
  }
  if (before.functionStats && after.functionStats) {
    addNumDelta(lines, "functionStats.idNumArity", before.functionStats.idNumArity, after.functionStats.idNumArity);
    addNumDelta(lines, "functionStats.meanLength", before.functionStats.meanLength, after.functionStats.meanLength, 2);
  }
  // EXP387 new signals.
  if (before.thermodynamics && after.thermodynamics) {
    addNumDelta(lines, "thermo.freeEnergy", before.thermodynamics.freeEnergy, after.thermodynamics.freeEnergy, 4);
    addNumDelta(lines, "thermo.entropy", before.thermodynamics.entropy, after.thermodynamics.entropy, 4);
  }
  if (before.benford && after.benford) {
    addNumDelta(lines, "benford.chiSquareDeviation", before.benford.chiSquareDeviation, after.benford.chiSquareDeviation, 4);
  }
  if (before.fiedlerBisection && after.fiedlerBisection) {
    addNumDelta(lines, "fiedler.fiedlerValue", before.fiedlerBisection.fiedlerValue, after.fiedlerBisection.fiedlerValue, 4);
  }
  if (before.homology && after.homology) {
    addNumDelta(lines, "homology.h0", before.homology.h0, after.homology.h0);
    addNumDelta(lines, "homology.h1", before.homology.h1, after.homology.h1);
  }
  if (before.shapeDna && after.shapeDna) {
    addNumDelta(lines, "shapeDna.distinctShapes", before.shapeDna.distinctShapes, after.shapeDna.distinctShapes);
  }
  if (before.chromaticNumber && after.chromaticNumber) {
    addNumDelta(lines, "chromatic.chromaticNumber", before.chromaticNumber.chromaticNumber, after.chromaticNumber.chromaticNumber);
    addNumDelta(lines, "chromatic.cliqueNumber", before.chromaticNumber.cliqueNumber, after.chromaticNumber.cliqueNumber);
  }
  if (before.martingaleDebt && after.martingaleDebt) {
    addNumDelta(lines, "martingale.drift", before.martingaleDebt.drift, after.martingaleDebt.drift, 4);
  }
  if (before.freeProbability && after.freeProbability) {
    addNumDelta(lines, "freeProb.coupledPairs", before.freeProbability.coupledPairs, after.freeProbability.coupledPairs);
  }
  if (before.maxwellDemon && after.maxwellDemon) {
    addNumDelta(lines, "demon.meanDemonEfficiency", before.maxwellDemon.meanDemonEfficiency, after.maxwellDemon.meanDemonEfficiency, 4);
  }
  if (before.functionClassification && after.functionClassification) {
    addNumDelta(lines, "classify.pathologicalFraction", before.functionClassification.pathologicalFraction, after.functionClassification.pathologicalFraction, 4);
  }
  if (before.turingTreadmills && after.turingTreadmills) {
    addNumDelta(lines, "treadmill.treadmillCount", before.turingTreadmills.treadmillCount, after.turingTreadmills.treadmillCount);
  }
  if (before.mechanismDesign && after.mechanismDesign) {
    addNumDelta(lines, "mechanism.icRatio", before.mechanismDesign.icRatio, after.mechanismDesign.icRatio, 4);
  }
  if (before.sheafCohomology && after.sheafCohomology) {
    addNumDelta(lines, "sheaf.h0Dimension", before.sheafCohomology.h0Dimension, after.sheafCohomology.h0Dimension);
    addNumDelta(lines, "sheaf.h1Obstructions", before.sheafCohomology.h1Obstructions, after.sheafCohomology.h1Obstructions);
  }
  // Compose text.
  const text = composeDeltaText(lines, after);
  return {
    computedAt: after.computedAt,
    reanalyzedFiles: after.reanalyzedFiles,
    cachedFiles: after.cachedFiles,
    computeTimeMs: after.computeTimeMs,
    lines,
    text,
  };
}

/** Add a numeric delta line if before!= after. */
function addNumDelta(lines: DeltaLine[], signal: string, before: number, after: number, decimals = 0): void {
  if (before === after) return;
  const diff = after - before;
  const sign = diff > 0 ? "+" : "";
  lines.push({
    signal,
    before: round(before, decimals),
    after: round(after, decimals),
    change: `${sign}${round(diff, decimals)}`,
  });
}

function composeDeltaText(lines: readonly DeltaLine[], after: AwarenessSnapshot): string {
  if (lines.length === 0) {
    return `AFTER YOUR LAST EDIT: no signal changes (reanalyzed=${after.reanalyzedFiles} files, cached=${after.cachedFiles}).`;
  }
  const lineTexts = lines.map(l => `- ${l.signal}: ${l.before} → ${l.after} (${l.change})`);
  return `AFTER YOUR LAST EDIT (reanalyzed=${after.reanalyzedFiles}, cached=${after.cachedFiles}, ${after.computeTimeMs}ms):\n${lineTexts.join("\n")}`;
}

function round(n: number, d: number): number {
  // R44: delegate to the canonical `roundKeepNonFinite` owner in
  // `src/shared/numeric-helpers.ts` (was a private near-duplicate body
  // — "No Scattered Helpers" violation). The display variant preserves
  // non-finite values (NaN, Infinity) AS-IS instead of returning 0, so
  // the delta-line display reflects reality (a NaN signal shows NaN, not
  // a misleading `0`). The previous `number | string` return type was
  // incorrect (no path ever returned a string) — corrected to `number`.
  return roundKeepNonFinite(n, d);
}
