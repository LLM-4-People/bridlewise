// src/awareness/temperature.ts
//
// OBAFGKM function temperature classification — EXP442/EXP455 POSITIVE finding.
//
// Stellar classification sorts stars by surface temperature into the
// classes O, B, A, F, G, K, M (hottest → coolest). Applied to functions,
// each function is classified by its "temperature" — its churn percentile
// within the codebase. Hot functions (top percentile, the O/B/A classes)
// are the "active stars" — the most recently and frequently edited code,
// the highest-priority review targets.
//
// EXP442 measured: awareness active-fn overlap 175→232 (1.33× enrichment
// babel, 1.92× typescript); gemma-4-31b chose the hot-set (A) as more
// useful for review.
//
// Research sources:
// - EXP442 (`novel-principles`): OBAFGKM applied to function churn.
// - Cannon-Pickering (1901-1912) Harvard classification: O B A F G K M
// by surface temperature (30,000K → 2,400K). The mnemonic "Oh Be A
// Fine Girl/Guy, Kiss Me" is standard in astronomy.
// - EXP455 merge manifest: OBAFGKM marked as ENHANCEMENT to awareness
// block (`src/runtime/interactive-session.ts`).
//
// Public API:
// - `classifyByTemperature({ records, options })` → a list of (file,
// name, class, churnPercentile) tuples + a class histogram.
// - `pickHotSet(classifications, topN)` → the top-N hot functions for
// the awareness block.
//
// Class boundaries are DYNAMICALLY computed from the codebase's churn
// distribution (no hardcoded thresholds — per "everything
// dynamically computed"). The classes follow the stellar-class
// convention: O = top 0.01%, B = top 0.1%, A = top 1%, F = top 5%,
// G = top 20%, K = top 50%, M = the rest. The user can override the
// percentiles via options.

import { deepFreeze } from "../kernel/integrity.ts";
import { percentileOf } from "../shared/git-churn.ts";
import { DEFAULT_TEMPERATURE_BOUNDARIES } from "./config.ts";

export type TemperatureClass = "O" | "B" | "A" | "F" | "G" | "K" | "M";

export type TemperatureRecord = Readonly<{
  filePath: string;
  name: string;
  /** Per-function churn count (commits in the window that touched the function's file). */
  churnCount: number;
}>;

export type TemperatureClassification = Readonly<{
  filePath: string;
  name: string;
  /** OBAFGKM class. */
  temperatureClass: TemperatureClass;
  /** Churn percentile within the codebase (0 = coolest, 1 = hottest). */
  churnPercentile: number;
  /** Raw churn count. */
  churnCount: number;
}>;

export type TemperatureOptions = Readonly<{
  /** Class boundaries as churn-percentile thresholds (top percentile). */
  classBoundaries?: Readonly<Record<TemperatureClass, number>>;
}>;

/**
 * Default boundaries (top percentile thresholds — the "hot" cut).
 *
 * The canonical default is owned by `awareness/config.ts`
 * (`DEFAULT_TEMPERATURE_BOUNDARIES` — the single awareness config owner);
 * this is a typed view of it so consumers of `temperature.ts` see the
 * `Record<TemperatureClass, number>` shape.
 *
 * Module-private, because `resolveTemperatureBoundaries` below is the
 * resolver and therefore the only correct reader. A caller that read the
 * default directly would hold boundaries that stop tracking whatever a
 * classification was actually run with.
 */
const OBAFGKM_DEFAULT_BOUNDARIES: Readonly<Record<TemperatureClass, number>> =
  deepFreeze(DEFAULT_TEMPERATURE_BOUNDARIES as Readonly<Record<TemperatureClass, number>>);

/**
 * The boundaries a classification will use, given an optional override.
 * Exported so a caller that wants to know what the defaults ARE asks the
 * resolver for them rather than reading the constant behind it.
 */
export function resolveTemperatureBoundaries(
  overrides?: Readonly<Record<TemperatureClass, number>>,
): Readonly<Record<TemperatureClass, number>> {
  return overrides ?? OBAFGKM_DEFAULT_BOUNDARIES;
}

export type TemperatureResult = Readonly<{
  classifications: readonly TemperatureClassification[];
  /** Histogram of class → count. */
  histogram: Readonly<Record<TemperatureClass, number>>;
  /** Total functions classified. */
  totalFunctions: number;
  /** The class boundaries used (computed or supplied). */
  boundaries: Readonly<Record<TemperatureClass, number>>;
}>;

/**
 * Classify functions by churn-percentile into OBAFGKM temperature classes.
 * The classification is pure: it reads `records` and returns a frozen
 * result. No I/O, no side effects.
 */
export function classifyByTemperature(
  records: readonly TemperatureRecord[],
  options: TemperatureOptions = {},
): TemperatureResult {
  const boundaries = resolveTemperatureBoundaries(options.classBoundaries);

  if (records.length === 0) {
    return deepFreeze({
      classifications: [],
      histogram: emptyHistogram(),
      totalFunctions: 0,
      boundaries,
    });
  }

  // Sort churn ascending to compute percentiles.
  const sortedChurn = records.map((r) => r.churnCount).sort((a, b) => a - b);

  const histogram: Record<TemperatureClass, number> = emptyHistogramObject();
  const classifications: TemperatureClassification[] = [];
  for (const r of records) {
    const pct = percentileOf(r.churnCount, sortedChurn);
    const cls = classForPercentile(pct, boundaries);
    histogram[cls] += 1;
    classifications.push({
      filePath: r.filePath,
      name: r.name,
      temperatureClass: cls,
      churnPercentile: pct,
      churnCount: r.churnCount,
    });
  }

  // Sort classifications: hottest first.
  classifications.sort((a, b) => b.churnPercentile - a.churnPercentile);

  return deepFreeze({
    classifications: deepFreeze(classifications),
    histogram: deepFreeze(histogram),
    totalFunctions: records.length,
    boundaries,
  });
}

/**
 * Pick the hot-set — the top-N hottest functions (the O/B/A classes,
 * or whatever the top-N cut yields). Used by the awareness block to
 * surface review priority.
 */
export function pickHotSet(
  classifications: readonly TemperatureClassification[],
  topN: number = 20,
): readonly TemperatureClassification[] {
  const sorted = [...classifications].sort((a, b) => b.churnPercentile - a.churnPercentile);
  return deepFreeze(sorted.slice(0, topN));
}

/**
 * Filter classifications to a specific class (e.g. "show me the O-class
 * functions only").
 */
export function filterByClass(
  classifications: readonly TemperatureClassification[],
  cls: TemperatureClass,
): readonly TemperatureClassification[] {
  return deepFreeze(classifications.filter((c) => c.temperatureClass === cls));
}

// --- internals ------------------------------------------------------------

function classForPercentile(
  pct: number,
  boundaries: Readonly<Record<TemperatureClass, number>>,
): TemperatureClass {
  // The classes are checked from hottest to coolest. The hottest class
  // whose threshold is at or below `pct` wins.
  if (pct >= boundaries.O) return "O";
  if (pct >= boundaries.B) return "B";
  if (pct >= boundaries.A) return "A";
  if (pct >= boundaries.F) return "F";
  if (pct >= boundaries.G) return "G";
  if (pct >= boundaries.K) return "K";
  return "M";
}

function emptyHistogram(): Readonly<Record<TemperatureClass, number>> {
  return deepFreeze(emptyHistogramObject());
}

function emptyHistogramObject(): Record<TemperatureClass, number> {
  return { O: 0, B: 0, A: 0, F: 0, G: 0, K: 0, M: 0 };
}
