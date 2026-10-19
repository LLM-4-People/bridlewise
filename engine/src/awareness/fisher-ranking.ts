/**
 * EXP387 — Fisher information ranking + redundancy removal (EXP324).
 *
 * EXP324 measured each observable's Fisher information (Cramér-Rao
 * inverse): Jaccard 1-NN MI=9.79 bits, Complexity Fisher=767 (most
 * sensitive — best separation), PageRank Fisher=2.3 (least). The
 * Cramér-Rao bound holds for all.
 *
 * For awareness, we approximate Fisher information per signal as the
 * VARIANCE of the signal's value across a SET of codebases, divided
 * by the median measurement noise (the natural jitter from running
 * the same signal twice with a tiny perturbation). The higher the
 * Fisher, the more "informative" the signal — it carries more
 * information about the codebase's identity.
 *
 * Combined with the Spearman correlation matrix (EXP372's
 * verify-correlation.ts), we can:
 * 1. Rank signals by Fisher information (top-5 most informative).
 * 2. Drop low-Fisher signals (they're noise — low information).
 * 3. Remove redundant signals (|ρ| > 0.95 between two signals →
 * keep the one with higher Fisher; drop the other).
 *
 * Usage:
 *
 * const ranking = computeFisherRanking(snapshots); // Map<signal, Fisher>
 * const uniqueSignals = removeRedundant(snapshots, ranking, 0.95);
 * // uniqueSignals = list of signals with high Fisher + low correlation.
 */
import type { AwarenessSnapshot } from "./types.ts";
import { round } from "../shared/numeric-helpers.ts";
import { pearson } from "../shared/stats.ts";

/** Extract a vector of numeric signals from a snapshot. */
export function signalVector(s: AwarenessSnapshot): Record<string, number> {
  const v: Record<string, number> = {};
  v.fileCount = s.fileCount;
  v.functionCount = s.functionCount;
  v.moduleCount = s.moduleCount;
  v.totalLoc = s.totalLoc;
  v.typedFileFraction = s.typeLevel?.typedFileFraction ?? 0;
  v.typedParamFraction = s.typeLevel?.typedParameterFraction ?? 0;
  v.complexityMean = s.complexity?.mean ?? 0;
  v.complexityMax = s.complexity?.max ?? 0;
  v.complexityHotspotCount = s.complexity?.hotspotCount ?? 0;
  v.cloneFamilyCount = s.clones?.familyCount ?? 0;
  v.cloneCoverage = s.clones?.cloneCoverage ?? 0;
  v.entropyShannon = s.entropy?.shannon ?? 0;
  v.circularCount = s.dependencies?.circularCount ?? 0;
  v.missingSymbolCount = s.dependencies?.missingSymbolCount ?? 0;
  v.todoCount = s.health?.todoCount ?? 0;
  v.emptyCatchCount = s.health?.emptyCatchCount ?? 0;
  v.magicNumberCount = s.health?.magicNumberCount ?? 0;
  v.deadExportCount = s.health?.deadExportCount ?? 0;
  v.totalDebt = s.debt?.totalDebt ?? 0;
  v.testRatio = s.testCoverage?.ratio ?? 0;
  v.testDensity = s.testCoverage?.testDensity ?? 0;
  v.fnMeanLength = s.functionStats?.meanLength ?? 0;
  v.fnMaxLength = s.functionStats?.maxLength ?? 0;
  v.fnIdNumArity = s.functionStats?.idNumArity ?? 0;
  v.bellIsolatedFraction = s.bellClones?.isolatedFraction ?? 0;
  v.bellTotalPairs = s.bellClones?.totalPairs ?? 0;
  v.banachContraction = s.banachContraction?.meanContraction ?? 0;
  v.qecMeanDistance = s.qecDistance?.meanDistance ?? 0;
  v.qecFragileCount = s.qecDistance?.fragileCount ?? 0;
  v.agSpectrumSize = s.agSpectrum?.spectrumSize ?? 0;
  v.waveletFamilyCount = s.waveletClones?.waveletFamilyCount ?? 0;
  v.waveletCoverage = s.waveletClones?.waveletCloneCoverage ?? 0;
  v.ricciMeanCurvature = s.ricciCurvature?.meanCurvature ?? 0;
  v.ricciBridgeCount = s.ricciCurvature?.bridgeCount ?? 0;
  v.fiberDivergence = s.fiberBundle?.meanDivergence ?? 0;
  v.toposFailureFraction = s.topos?.failureFraction ?? 0;
  v.persistenceMean = s.persistenceLandscapes?.meanPersistence ?? 0;
  v.ergodicGrowth = s.ergodicDrift?.growthRate ?? 0;
  v.quantumCoherence = s.quantumStability?.coherenceScore ?? 0;
  v.editPredictability = s.editPredictability?.predictability ?? 0;
  v.recursionDecidability = s.recursionHierarchy?.decidabilityRatio ?? 0;
  v.hubGini = s.hubStress?.hubGini ?? 0;
  // EXP387 new signals.
  v.thermoFreeEnergy = s.thermodynamics?.freeEnergy ?? 0;
  v.thermoEntropy = s.thermodynamics?.entropy ?? 0;
  v.thermoTemperature = s.thermodynamics?.temperature ?? 0;
  v.benfordChiSquare = s.benford?.chiSquareDeviation ?? 0;
  v.benfordDominantDigit = s.benford?.dominantDigit ?? 0;
  v.fiedlerValue = s.fiedlerBisection?.fiedlerValue ?? 0;
  v.fiedlerBisectionSize = s.fiedlerBisection?.bisectionSize ?? 0;
  v.homologyH0 = s.homology?.h0 ?? 0;
  v.homologyH1 = s.homology?.h1 ?? 0;
  v.shapeDiversity = s.shapeDna?.shapeDiversity ?? 0;
  v.shapeDistinctShapes = s.shapeDna?.distinctShapes ?? 0;
  v.chromaticNumber = s.chromaticNumber?.chromaticNumber ?? 0;
  v.cliqueNumber = s.chromaticNumber?.cliqueNumber ?? 0;
  v.chromaticRefactorOps = s.chromaticNumber?.refactorOpportunities ?? 0;
  v.martingaleDrift = s.martingaleDebt?.drift ?? 0;
  v.martingaleVariance = s.martingaleDebt?.variance ?? 0;
  v.freeProbCoupledPairs = s.freeProbability?.coupledPairs ?? 0;
  v.freeProbNoncommutingFraction = s.freeProbability?.noncommutingFraction ?? 0;
  v.demonMeanEfficiency = s.maxwellDemon?.meanDemonEfficiency ?? 0;
  v.demonTotalInformationGain = s.maxwellDemon?.totalInformationGain ?? 0;
  v.classifyPathologicalFraction = s.functionClassification?.pathologicalFraction ?? 0;
  v.typologyFunctionalFraction = s.linguisticTypology?.functionalFraction ?? 0;
  v.typologyAsyncFraction = s.linguisticTypology?.asyncFraction ?? 0;
  v.treadmillCount = s.turingTreadmills?.treadmillCount ?? 0;
  v.treadmillMaxCount = s.turingTreadmills?.maxTreadmillCount ?? 0;
  v.mechanismIcRatio = s.mechanismDesign?.icRatio ?? 0;
  v.mechanismUncaught = s.mechanismDesign?.uncaughtCandidates ?? 0;
  v.sheafH0 = s.sheafCohomology?.h0Dimension ?? 0;
  v.sheafH1 = s.sheafCohomology?.h1Obstructions ?? 0;
  return v;
}

/** Compute Fisher information for each signal across a set of snapshots.
 * Fisher ≈ variance(signal) / mean(noise²). We use the across-codebase
 * variance as the signal (more discriminative = more Fisher) and
 * approximate the noise as the median absolute deviation (MAD) of
 * repeated measurements (we don't have repeats, so we use a small
 * floor to avoid divide-by-zero). */
export function computeFisherRanking(snapshots: readonly AwarenessSnapshot[]): Map<string, number> {
  if (snapshots.length < 2) return new Map();
  const vectors = snapshots.map(signalVector);
  const signals = new Set<string>();
  for (const v of vectors) for (const k of Object.keys(v)) signals.add(k);
  const fisher = new Map<string, number>();
  for (const s of signals) {
    const values = vectors.map(v => v[s]!).filter(v => Number.isFinite(v));
    if (values.length < 2) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((s2, v) => s2 + Math.pow(v - mean, 2), 0) / values.length;
    // MAD as noise estimate (we don't have repeats).
    const sortedValues = [...values].sort((a, b) => a - b);
    const median = sortedValues[Math.floor(sortedValues.length / 2)] ?? mean;
    const mad = values.reduce((s, v) => s + Math.abs(v - median), 0) / values.length;
    const noise2 = Math.max(mad * mad, 1e-9);
    fisher.set(s, variance / noise2);
  }
  return fisher;
}

/** Compute Spearman rank correlation between two arrays. */
export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 3) return 0;
  return pearson(rank(a), rank(b));
}

function rank(arr: number[]): number[] {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(arr.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.v === sorted[i]!.v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[sorted[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Remove redundant signals (|ρ| > threshold). Keep the one with higher Fisher.
 * Returns the list of UNIQUE signal names (after removing redundancy). */
export function removeRedundant(
  snapshots: readonly AwarenessSnapshot[],
  fisher: Map<string, number>,
  correlationThreshold = 0.95,
): { unique: string[]; dropped: Array<{ signal: string; correlatedWith: string; correlation: number }> } {
  if (snapshots.length < 3) {
    return { unique: [...fisher.keys()], dropped: [] };
  }
  const vectors = snapshots.map(signalVector);
  const signals = [...fisher.keys()].sort((a, b) => (fisher.get(b) ?? 0) - (fisher.get(a) ?? 0));
  const kept: string[] = [];
  const dropped: Array<{ signal: string; correlatedWith: string; correlation: number }> = [];
  for (const s of signals) {
    let redundant = false;
    let correlatedWith = "";
    let maxCorr = 0;
    for (const k of kept) {
      const aVals = vectors.map(v => v[s] ?? 0);
      const bVals = vectors.map(v => v[k] ?? 0);
      const corr = spearman(aVals, bVals);
      if (Math.abs(corr) > correlationThreshold) {
        redundant = true;
        correlatedWith = k;
        maxCorr = corr;
        break;
      }
    }
    if (redundant) {
      dropped.push({ signal: s, correlatedWith, correlation: round(maxCorr, 4) });
    } else {
      kept.push(s);
    }
  }
  return { unique: kept, dropped };
}
