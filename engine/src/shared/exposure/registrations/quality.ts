/**
 * Shared exposure registrations — `quality` module.
 *
 * Owns a small per-process state object that mirrors what the real
 * quality packs would expose.
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  configBoundSet,
  seedFromConfig,
  syncStateFromConfig,
  readNumberCustomization,
  writeConfigCustomization,
} from "../index.ts";

/**
 * The checks a fresh process runs. ONE source for both the initial state and
 * the `quality.enabledChecks` control's declared default: the control used to
 * advertise `""` while the module actually started with these four, so the
 * settings surface offered a "reset to default" that would have silently
 * turned every quality check off.
 */
const DEFAULT_ENABLED_CHECKS: readonly string[] = [
  "duplicate-body-detector",
  "duplicated-literals",
  "dead-exports",
  "schema-drift",
];

/** Per-process quality state. */
export const qualityState = {
  findingCount: 0,
  falsePositiveCount: 0,
  totalCheckTimeMs: 0,
  checkSamples: 0,
  checksRun: 0,
  lastCheckTimeMs: 0,
  checksClearedCount: 0,
  recheckCount: 0,
  // The severity cutoffs, fail-gates and check selection are a LIVE PROJECTION
  // of the `quality` config section: seeded from `bridlewise.config.json`
  // and written back through the config gate on every `set`.
  enabledChecks: new Set<string>(
    String(seedFromConfig("quality.enabledChecks", DEFAULT_ENABLED_CHECKS.join(",")))
      .split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  ),
  thresholdCritical: seedFromConfig("quality.thresholdCritical", 0) as number,
  thresholdHigh: seedFromConfig("quality.thresholdHigh", 0.25) as number,
  thresholdMedium: seedFromConfig("quality.thresholdMedium", 0.5) as number,
  thresholdLow: seedFromConfig("quality.thresholdLow", 0.75) as number,
  failOnCritical: seedFromConfig("quality.failOnCritical", true) as boolean,
  failOnHigh: seedFromConfig("quality.failOnHigh", false) as boolean,
  failOnMedium: seedFromConfig("quality.failOnMedium", false) as boolean,
  failOnLow: seedFromConfig("quality.failOnLow", false) as boolean,
  /**
   * Findings recorded per severity band since the last `clear`. The gate
   * (`recheck`) reads these together with the four `failOn*` flags; the bands
   * themselves come from the four score cutoffs.
   */
  severityCounts: { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>,
};

/** The severity bands, worst first — the order the gate reports failures in. */
const SEVERITY_BANDS = ["critical", "high", "medium", "low"] as const;

/**
 * The severity band a finding's score falls in, read from the four cutoffs at
 * call time. A score at or above the lowest cutoff is below every band and is
 * recorded as `none` — it fails no gate.
 */
function classifySeverity(score: number): string {
  if (score < qualityState.thresholdCritical) return "critical";
  if (score < qualityState.thresholdHigh) return "high";
  if (score < qualityState.thresholdMedium) return "medium";
  if (score < qualityState.thresholdLow) return "low";
  return "none";
}

/** Whether a finding in this band fails the overall check, per the gate flags. */
function bandFailsGate(band: string): boolean {
  if (band === "critical") return qualityState.failOnCritical;
  if (band === "high") return qualityState.failOnHigh;
  if (band === "medium") return qualityState.failOnMedium;
  if (band === "low") return qualityState.failOnLow;
  return false;
}

/** State-field → config-path map (single source for the import-time seeds and the registration-time re-sync). */
const QUALITY_CONFIG_BINDINGS = {
  enabledChecks: "quality.enabledChecks",
  thresholdCritical: "quality.thresholdCritical",
  thresholdHigh: "quality.thresholdHigh",
  thresholdMedium: "quality.thresholdMedium",
  thresholdLow: "quality.thresholdLow",
  failOnCritical: "quality.failOnCritical",
  failOnHigh: "quality.failOnHigh",
  failOnMedium: "quality.failOnMedium",
  failOnLow: "quality.failOnLow",
} as const;

let qualityRegistered = false;
export function registerQualityExposure(): void {
  if (qualityRegistered) return;
  qualityRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(qualityState, QUALITY_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "quality",
    title: "Code quality checks",
    purpose:
      "Which checks run over the work, and how serious a finding has to be before it counts as a failure rather than a note.",
  });

  // --- Signals (10) ---
  registerSignal({
    id: "quality.findingCount",
    module: "quality",
    name: "Finding Count",
    description: "Total number of findings emitted by quality checks.",
    type: "counter",
    unit: "count",
    value: () => qualityState.findingCount,
  });
  registerSignal({
    id: "quality.falsePositiveCount",
    module: "quality",
    name: "False Positive Count",
    description: "Total number of findings marked as false positives.",
    type: "counter",
    unit: "count",
    value: () => qualityState.falsePositiveCount,
  });
  registerSignal({
    id: "quality.falsePositiveRate",
    module: "quality",
    name: "False Positive Rate",
    description: "Fraction of findings marked false positive (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      qualityState.findingCount === 0
        ? 0
        : qualityState.falsePositiveCount / qualityState.findingCount,
  });
  registerSignal({
    id: "quality.avgCheckTime",
    module: "quality",
    name: "Average Check Time",
    description: "Mean quality-check run time in milliseconds.",
    type: "timer",
    unit: "ms",
    value: () =>
      qualityState.checkSamples === 0
        ? 0
        : qualityState.totalCheckTimeMs / qualityState.checkSamples,
  });
  registerSignal({
    id: "quality.checksRun",
    module: "quality",
    name: "Checks Run",
    description: "Total number of individual check runs executed.",
    type: "counter",
    unit: "count",
    value: () => qualityState.checksRun,
  });
  registerSignal({
    id: "quality.lastCheckTime",
    module: "quality",
    name: "Last Check Time",
    description: "Duration in ms of the most recent quality check.",
    type: "timer",
    unit: "ms",
    value: () => qualityState.lastCheckTimeMs,
  });
  registerSignal({
    id: "quality.enabledCheckCount",
    module: "quality",
    name: "Enabled Check Count",
    description: "Number of checks enabled in the active quality pack.",
    type: "gauge",
    unit: "count",
    value: () => qualityState.enabledChecks.size,
  });
  registerSignal({
    id: "quality.recheckCount",
    module: "quality",
    name: "Recheck Count",
    description: "Number of times the quality checks have been rerun.",
    type: "counter",
    unit: "count",
    value: () => qualityState.recheckCount,
  });
  registerSignal({
    id: "quality.clearedCount",
    module: "quality",
    name: "Cleared Count",
    description: "Number of times the quality state has been cleared.",
    type: "counter",
    unit: "count",
    value: () => qualityState.checksClearedCount,
  });
  registerSignal({
    id: "quality.failOnCritical",
    module: "quality",
    name: "Fail On Critical",
    description: "Whether a CRITICAL finding fails the gate.",
    type: "boolean",
    value: () => qualityState.failOnCritical,
  });

  // --- Actions (5) ---
  registerAction({
    id: "quality.recheck",
    module: "quality",
    name: "Recheck",
    description: "Rerun all enabled quality checks.",
    // The elapsed time is MEASURED. It was a random 50–250ms, and it fed
    // `quality.lastCheckTime` / `quality.avgCheckTime` — numbers an operator
    // reads as how long the checks actually took.
    // The gate is recomputed here from the recorded findings: a band with at
    // least one finding fails the check when its `failOn*` flag is on. That
    // makes the three exposed gate flags decide the check's own verdict, not
    // just describe it.
    execute: async () => {
      const startedAt = performance.now();
      qualityState.recheckCount += 1;
      qualityState.checksRun += qualityState.enabledChecks.size;
      const failedOn = SEVERITY_BANDS.filter(
        (band) => (qualityState.severityCounts[band] ?? 0) > 0 && bandFailsGate(band),
      );
      const time = performance.now() - startedAt;
      qualityState.lastCheckTimeMs = time;
      qualityState.totalCheckTimeMs += time;
      qualityState.checkSamples += 1;
      return {
        rechecked: true,
        timeMs: time,
        checksRun: qualityState.enabledChecks.size,
        passed: failedOn.length === 0,
        failedOn,
      };
    },
  });
  registerAction({
    id: "quality.clear",
    module: "quality",
    name: "Clear",
    description: "Clear all quality findings and reset counters.",
    execute: async () => {
      qualityState.findingCount = 0;
      qualityState.falsePositiveCount = 0;
      qualityState.totalCheckTimeMs = 0;
      qualityState.checkSamples = 0;
      for (const band of SEVERITY_BANDS) qualityState.severityCounts[band] = 0;
      qualityState.checksClearedCount += 1;
      return { cleared: true, clearedCount: qualityState.checksClearedCount };
    },
  });
  registerAction({
    id: "quality.addFinding",
    module: "quality",
    name: "Add Finding",
    description: "Record a finding and classify its severity against the configured cutoffs.",
    args: {
      score: {
        type: "number",
        required: false,
        description: "Finding score (0..1, lower is worse), banded by the four severity cutoffs",
      },
      severity: {
        type: "string",
        required: false,
        description: "Severity stated by the caller (critical|high|medium|low), used instead of banding a score",
      },
      falsePositive: { type: "boolean", required: false, description: "Mark as false positive" },
    },
    // The severity is DERIVED from the score by the four cutoffs — that is
    // what makes those cutoffs real controls rather than stored numbers. A
    // caller that already knows the band may state it (the same override
    // shape `bias.reportDetection` uses); a caller that knows neither gets
    // `unclassified`, which fails no gate, rather than an invented band.
    execute: async (args) => {
      qualityState.findingCount += 1;
      const fp = args?.falsePositive === true;
      if (fp) qualityState.falsePositiveCount += 1;
      const stated = args?.severity === undefined ? undefined : String(args.severity);
      const score = args?.score === undefined ? undefined : Number(args.score);
      const severity = stated ?? (score === undefined ? "unclassified" : classifySeverity(score));
      if (severity in qualityState.severityCounts) {
        qualityState.severityCounts[severity] = (qualityState.severityCounts[severity] ?? 0) + 1;
      }
      return {
        findingCount: qualityState.findingCount,
        severity,
        ...(score === undefined ? {} : { score }),
        failsGate: bandFailsGate(severity),
        falsePositive: fp,
      };
    },
  });
  registerAction({
    id: "quality.enableCheck",
    module: "quality",
    name: "Enable Check",
    description: "Enable a quality check by id.",
    args: {
      id: { type: "string", required: true, description: "Check id" },
    },
    execute: async (args) => {
      const id = String(args?.id ?? "");
      qualityState.enabledChecks.add(id);
      return { enabled: Array.from(qualityState.enabledChecks) };
    },
  });
  registerAction({
    id: "quality.disableCheck",
    module: "quality",
    name: "Disable Check",
    description: "Disable a quality check by id.",
    args: {
      id: { type: "string", required: true, description: "Check id" },
    },
    execute: async (args) => {
      const id = String(args?.id ?? "");
      qualityState.enabledChecks.delete(id);
      return { enabled: Array.from(qualityState.enabledChecks) };
    },
  });

  // --- Customizations (9) ---
  // Effect timing: all nine are read at call time — the four cutoffs band
  // every finding `addFinding` records, the four gate flags decide
  // `recheck`'s verdict (and each finding's own `failsGate`), and
  // `enabledChecks` decides what `recheck` runs. A change therefore lands on
  // the next finding or the next recheck, which is what `immediate` states.
  registerCustomization({
    id: "quality.thresholdCritical",
    module: "quality",
    name: "'Critical' severity cutoff",
    description:
      "A quality finding scoring below this counts as Critical — the most serious level.",
    type: "number",
    default: 0,
    min: 0,
    max: 1,
    unit: "score",
    current: () => qualityState.thresholdCritical,
    set: configBoundSet("quality.thresholdCritical", (v) => { qualityState.thresholdCritical = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "quality.thresholdCritical",
  });
  registerCustomization({
    id: "quality.thresholdHigh",
    module: "quality",
    name: "'High' severity cutoff",
    description:
      "A quality finding scoring below this (but at or above the Critical cutoff) counts as High severity.",
    type: "number",
    default: 0.25,
    min: 0,
    max: 1,
    unit: "score",
    current: () => qualityState.thresholdHigh,
    set: configBoundSet("quality.thresholdHigh", (v) => { qualityState.thresholdHigh = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "quality.thresholdHigh",
  });
  registerCustomization({
    id: "quality.thresholdMedium",
    module: "quality",
    name: "'Medium' severity cutoff",
    description:
      "A quality finding scoring below this (but at or above the High cutoff) counts as Medium severity.",
    type: "number",
    default: 0.5,
    min: 0,
    max: 1,
    unit: "score",
    current: () => qualityState.thresholdMedium,
    set: configBoundSet("quality.thresholdMedium", (v) => { qualityState.thresholdMedium = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "quality.thresholdMedium",
  });
  registerCustomization({
    id: "quality.thresholdLow",
    module: "quality",
    name: "'Low' severity cutoff",
    description:
      "A quality finding scoring below this (but at or above the Medium cutoff) counts as Low severity.",
    type: "number",
    default: 0.75,
    min: 0,
    max: 1,
    unit: "score",
    current: () => qualityState.thresholdLow,
    set: configBoundSet("quality.thresholdLow", (v) => { qualityState.thresholdLow = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "quality.thresholdLow",
  });
  registerCustomization({
    id: "quality.failOnCritical",
    module: "quality",
    name: "Critical findings fail the check",
    description:
      "On: one Critical finding is enough to make the overall quality check fail.",
    type: "boolean",
    default: true,
    current: () => qualityState.failOnCritical,
    set: configBoundSet("quality.failOnCritical", (v) => { qualityState.failOnCritical = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "quality.failOnCritical",
    configPath: "quality.failOnCritical",
  });
  registerCustomization({
    id: "quality.failOnHigh",
    module: "quality",
    name: "High findings fail the check",
    description:
      "On: one High-severity finding is enough to make the overall quality check fail.",
    type: "boolean",
    default: false,
    current: () => qualityState.failOnHigh,
    set: configBoundSet("quality.failOnHigh", (v) => { qualityState.failOnHigh = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "quality.failOnHigh",
  });
  registerCustomization({
    id: "quality.failOnMedium",
    module: "quality",
    name: "Medium findings fail the check",
    description:
      "On: one Medium-severity finding is enough to make the overall quality check fail.",
    type: "boolean",
    default: false,
    current: () => qualityState.failOnMedium,
    set: configBoundSet("quality.failOnMedium", (v) => { qualityState.failOnMedium = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "quality.failOnMedium",
  });
  registerCustomization({
    id: "quality.failOnLow",
    module: "quality",
    name: "Low findings fail the check",
    description:
      "On: one Low-severity finding is enough to make the overall quality check fail.",
    type: "boolean",
    default: false,
    current: () => qualityState.failOnLow,
    set: configBoundSet("quality.failOnLow", (v) => { qualityState.failOnLow = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "quality.failOnLow",
  });
  registerCustomization({
    id: "quality.enabledChecks",
    module: "quality",
    name: "Only run these checks",
    description:
      "A comma-separated list of quality-check names to run. Leave empty to run none of them.",
    type: "string",
    default: DEFAULT_ENABLED_CHECKS.join(","),
    current: () => Array.from(qualityState.enabledChecks).join(","),
    set: configBoundSet("quality.enabledChecks", (v) => {
      qualityState.enabledChecks = new Set(
        String(v).split(",").map((s) => s.trim()).filter((s) => s.length > 0),
      );
    }),
    contract: { effect: "immediate" },
    measuredBy: "quality.enabledCheckCount",
    configPath: "quality.enabledChecks",
  });

  // The composite quality score the awareness bridge actually computes
  // (`webUi.quality` via `getQualityConfig` / `getLintGateConfig`). Distinct
  // from the finding-cutoff knobs above: those band findings; these weight
  // the on-screen score and the lint auto-check.
  const QUALITY_SCORE = {
    scoreMax: 100,
    scoreMin: 0,
    penaltyCapIssuesPerKloc: 30,
    penaltyCapHotspots: 20,
    penaltyCapClones: 15,
    penaltyCapUntyped: 15,
    penaltyCapIssueDensity: 20,
    penaltyWeightIssuesPerKloc: 5,
    penaltyWeightHotspots: 2,
    penaltyWeightClones: 30,
    penaltyWeightUntyped: 20,
    penaltyWeightIssueDensity: 100,
    topCategoriesCount: 3,
    maxIssuesPerKloc: 10,
    maxComplexityHotspots: 5,
    maxCloneRatio: 0.15,
    minTypedFileFraction: 0.5,
  } as const;
  const scoreNum = (spec: {
    id: string;
    name: string;
    description: string;
    configPath: string;
    default: number;
    min: number;
    max: number;
    unit?: string;
  }): void => {
    registerCustomization({
      id: spec.id,
      module: "quality",
      name: spec.name,
      description: spec.description,
      type: "number",
      default: spec.default,
      min: spec.min,
      max: spec.max,
      ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
      current: () => readNumberCustomization(spec.configPath, spec.default),
      set: (v) => writeConfigCustomization(spec.configPath, v),
      contract: { effect: "immediate" },
      configPath: spec.configPath,
    });
  };
  scoreNum({
    id: "quality.scoreMax",
    name: "Starting value of the quality score",
    description:
      "The on-screen quality score starts at this number and subtracts penalties. Raising it stretches the scale; lowering it makes the same issues look worse.",
    configPath: "webUi.quality.scoreMax",
    default: QUALITY_SCORE.scoreMax,
    min: 1,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.scoreMin",
    name: "Floor the quality score cannot fall below",
    description:
      "After penalties, the on-screen quality score is never reported below this. Raising it hides how bad a messy tree looks; lowering it lets the score drop further.",
    configPath: "webUi.quality.scoreMin",
    default: QUALITY_SCORE.scoreMin,
    min: 0,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyCapIssuesPerKloc",
    name: "Most points lost to issue density",
    description:
      "Issue-density cannot subtract more than this many points from the quality score. Raising it lets a messy tree hurt the score more.",
    configPath: "webUi.quality.penaltyCapIssuesPerKloc",
    default: QUALITY_SCORE.penaltyCapIssuesPerKloc,
    min: 1,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyCapHotspots",
    name: "Most points lost to complexity hotspots",
    description:
      "Complexity hotspots cannot subtract more than this many points from the quality score. Raising it lets tangled files hurt the score more.",
    configPath: "webUi.quality.penaltyCapHotspots",
    default: QUALITY_SCORE.penaltyCapHotspots,
    min: 1,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyCapClones",
    name: "Most points lost to duplicated code",
    description:
      "Duplicated code cannot subtract more than this many points from the quality score. Raising it lets copies hurt the score more.",
    configPath: "webUi.quality.penaltyCapClones",
    default: QUALITY_SCORE.penaltyCapClones,
    min: 1,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyCapUntyped",
    name: "Most points lost to untyped files",
    description:
      "Missing types cannot subtract more than this many points from the quality score. Raising it lets untyped files hurt the score more.",
    configPath: "webUi.quality.penaltyCapUntyped",
    default: QUALITY_SCORE.penaltyCapUntyped,
    min: 1,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyCapIssueDensity",
    name: "Most points lost to packed issues",
    description:
      "Packed issues cannot subtract more than this many points from the quality score. Raising it lets a dense pile of findings hurt the score more.",
    configPath: "webUi.quality.penaltyCapIssueDensity",
    default: QUALITY_SCORE.penaltyCapIssueDensity,
    min: 1,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyWeightIssuesPerKloc",
    name: "How heavily issue density is weighted",
    description:
      "Each unit of issue density subtracts this many points, up to its cap. Raising it makes issue density move the score more.",
    configPath: "webUi.quality.penaltyWeightIssuesPerKloc",
    default: QUALITY_SCORE.penaltyWeightIssuesPerKloc,
    min: 0,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyWeightHotspots",
    name: "How heavily complexity hotspots are weighted",
    description:
      "Each complexity hotspot subtracts this many points, up to its cap. Raising it makes tangled files move the score more.",
    configPath: "webUi.quality.penaltyWeightHotspots",
    default: QUALITY_SCORE.penaltyWeightHotspots,
    min: 0,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyWeightClones",
    name: "How heavily duplicated code is weighted",
    description:
      "Each unit of duplicated code subtracts this many points, up to its cap. Raising it makes copies move the score more.",
    configPath: "webUi.quality.penaltyWeightClones",
    default: QUALITY_SCORE.penaltyWeightClones,
    min: 0,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyWeightUntyped",
    name: "How heavily untyped files are weighted",
    description:
      "Each unit of missing types subtracts this many points, up to its cap. Raising it makes untyped files move the score more.",
    configPath: "webUi.quality.penaltyWeightUntyped",
    default: QUALITY_SCORE.penaltyWeightUntyped,
    min: 0,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.penaltyWeightIssueDensity",
    name: "How heavily packed issues are weighted",
    description:
      "Each unit of packed issues subtracts this many points, up to its cap. Raising it makes a dense pile of findings move the score more.",
    configPath: "webUi.quality.penaltyWeightIssueDensity",
    default: QUALITY_SCORE.penaltyWeightIssueDensity,
    min: 0,
    max: 1_000,
    unit: "points",
  });
  scoreNum({
    id: "quality.topCategoriesCount",
    name: "Issue kinds listed in the quality notes",
    description:
      "The quality notes name this many top issue kinds and omit the rest. Raising it shows a fuller mix; lowering it keeps the list short.",
    configPath: "webUi.quality.topCategoriesCount",
    default: QUALITY_SCORE.topCategoriesCount,
    min: 1,
    max: 50,
    unit: "kinds",
  });
  scoreNum({
    id: "quality.lintMaxIssuesPerKloc",
    name: "Issue density that still passes the lint gate",
    description:
      "The lint auto-check fails when issues per thousand lines pass this. Lowering it is stricter; raising it lets a messier tree through.",
    configPath: "webUi.quality.lintGate.maxIssuesPerKloc",
    default: QUALITY_SCORE.maxIssuesPerKloc,
    min: 0,
    max: 1_000,
    unit: "issues",
  });
  scoreNum({
    id: "quality.lintMaxComplexityHotspots",
    name: "Complexity hotspots that still pass the lint gate",
    description:
      "The lint auto-check fails when complexity hotspots pass this count. Lowering it is stricter; raising it lets more tangled files through.",
    configPath: "webUi.quality.lintGate.maxComplexityHotspots",
    default: QUALITY_SCORE.maxComplexityHotspots,
    min: 0,
    max: 1_000,
    unit: "hotspots",
  });
  scoreNum({
    id: "quality.lintMaxCloneRatio",
    name: "Duplicated-code share that still passes the lint gate",
    description:
      "The lint auto-check fails when duplicated code passes this fraction of the tree. Lowering it is stricter; raising it lets more copies through.",
    configPath: "webUi.quality.lintGate.maxCloneRatio",
    default: QUALITY_SCORE.maxCloneRatio,
    min: 0,
    max: 1,
    unit: "share",
  });
  scoreNum({
    id: "quality.lintMinTypedFileFraction",
    name: "Typed-file share needed to pass the lint gate",
    description:
      "The lint auto-check fails when the share of typed files falls below this. Raising it is stricter; lowering it lets more untyped files through.",
    configPath: "webUi.quality.lintGate.minTypedFileFraction",
    default: QUALITY_SCORE.minTypedFileFraction,
    min: 0,
    max: 1,
    unit: "share",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetQualityRegistration(): void {
  qualityRegistered = false;
}
