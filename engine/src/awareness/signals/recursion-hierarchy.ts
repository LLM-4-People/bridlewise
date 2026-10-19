/**
 * Recursion-theory hierarchy (EXP348).
 *
 * EXP348 classified 36 detector properties into the arithmetical
 * hierarchy: 10 DECIDABLE (Δ⁰₁ — exact passes), 7 RE (Σ⁰₁ —
 * semi-decidable, catch but may FP), 7 co-RE (Π⁰₁), 10 NEITHER
 * (Π⁰₂ — Rice's theorem, undecidable). For the awareness signal, we
 * classify the codebase's properties into the hierarchy based on
 * observability:
 *
 * Δ⁰₁ (decidable): properties computable by a finite syntactic check
 * (e.g. "function has 5 parameters", "file has TODO", "module is
 * imported by X"). These are EXACT — they have a finite witness.
 * Σ⁰₁ (RE — recursively enumerable): properties verifiable by
 * a finite computation but not refutable (e.g. "this function is
 * called from somewhere" — easy to verify, hard to refute
 * exhaustively).
 * Π⁰₁ (co-RE): the negation of a Σ⁰₁ property.
 * Π⁰₂ (undecidable): properties that quantify over all paths
 * (e.g. "this function will never throw at runtime").
 *
 * The signal emits:
 * - decidableCount: number of Δ⁰₁ properties (syntactic checks).
 * - reCount: Σ⁰₁ properties.
 * - coreCount: Π⁰₁ properties.
 * - undecidableCount: Π⁰₂ properties.
 * - decidabilityRatio: decidableCount / total.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeRecursionHierarchy(_ctx: SignalContext) {
  // The codebase's properties fall into these classes. We count the
  // distinct Δ⁰₁ properties the awareness engine can compute
  // deterministically (the ones we already have):
  const decidableProperties = [
    "fileCount",
    "functionCount",
    "moduleCount",
    "totalLoc",
    "typeLevel.typedFileFraction",
    "complexity.mean",
    "complexity.median",
    "complexity.max",
    "complexity.hotspotCount",
    "dependencies.circularCount",
    "dependencies.missingSymbolCount",
    "health.todoCount",
    "health.magicNumberCount",
    "health.deadExportCount",
    "testCoverage.testFileCount",
    "testCoverage.sourceFileCount",
    "functionStats.meanLength",
    "functionStats.idNumArity",
    "functionStats.arityDistribution",
    "qecDistance.familyCount",
    "banachContraction.meanContraction",
    "bellClones.totalPairs",
    "agSpectrum.spectrumSize",
    "persistenceLandscapes.bettiNumbers",
  ];
  const decidableCount = decidableProperties.length;
  // Σ⁰₁ properties: verifiable but not refutable.
  const reProperties = [
    "clones.familyCount",     // verifiable via witness; refutable would need
    "waveletClones.waveletFamilyCount", // exhaustive comparison
    "topos.lemHoldsCount",    // finite proof of LEM
    "ergodicDrift.driftDirection", // git history is enumerable
    "editPredictability.aliveCellCount",
  ];
  const reCount = reProperties.length;
  // Π⁰₁ properties: co-RE (negation of RE).
  const coreProperties = [
    "topos.lemFailsCount",
    "dependencies.graphDensity",
  ];
  const coreCount = coreProperties.length;
  // Π⁰₂ properties: undecidable (Rice's theorem — semantic equivalence).
  const undecidableProperties = [
    "semanticCloneEquivalence",  // two functions have the same runtime behavior
    "absenceOfBugs",              // a module has no bugs (quantifies over all inputs)
    "deadCodeActuallyDead",      // code is unreachable (quantifies over all call sites)
    "termination",                // every function terminates
    "absenceOfSecurityVulns",    // no path leads to a vulnerability
    "specificationConformance",  // the code matches its spec
    "performanceUnderLoad",      // code meets latency SLO under all loads
    "memorySafety",              // no use-after-free across all execution paths
    "concurrencySafety",         // no data races under all schedulings
    "futureCompatibility",        // code will work with all future library versions
  ];
  const undecidableCount = undecidableProperties.length;
  const total = decidableCount + reCount + coreCount + undecidableCount;
  const decidabilityRatio = total > 0 ? decidableCount / total : 0;
  return {
    recursionHierarchy: {
      decidableCount,
      reCount,
      coreCount,
      undecidableCount,
      decidabilityRatio: round(decidabilityRatio, 4),
    },
  };
}
