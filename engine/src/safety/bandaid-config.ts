import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { memberOf } from "../shared/type-guards.ts";

/**
 * Bandaid / workaround / goal-deviation detection + prevention configuration.
 *
 * EXP432 (2026-07-21) — the user directive: "the workaround/bandaids part
 * is using static keywords, are we in 1990?... static values like that are
 * prohibited app-wide." EXP408 hardcoded 8 regex patterns (`@ts-ignore`,
 * `as any`, `eslint-disable`, `TODO...fix|later|hack|workaround|temporary`,
 * `catch{}`, `catch{//comment}`, `if (x === null)`) in
 * `BANDAID_DEFAULT_PATTERNS`. That static keyword list is PROHIBITED.
 *
 * EXP432 replaces it with:
 *
 * - STRUCTURAL detection (AST node types — `TSAnyKeyword`, empty
 * `CatchClause.body`, `NullLiteral` test, unused catch binding) in
 * `bandaid-ast-detector.ts`. Keyword-free; no learning needed.
 * - LEARNED comment detection (`bandaid-pattern-learner.ts`): the set of
 * suppression pragmas + deferred markers is MINED FROM THE CODEBASE and
 * passed to the detector via `learnedSuppressionPragmas` /
 * `learnedDeferredMarkers` below. No static keyword list lives in the
 * source. The detector compiles the learned regexes at construction.
 * - Optional user-config patterns (`bandaidPatterns`): a user may add
 * custom patterns via config — that is CONFIG, not a hardcoded source
 * list. The default is EMPTY.
 *
 * Root-cause containment (the PRIMARY signal, keyword-free) remains:
 * `bandaidMinRootCauseOverlap`. The other families (workaround, deviation,
 * step-skip) keep their thresholds; their static lists (consequential tools,
 * manual-approach patterns, stopwords, step expectations) are either
 * removed (stopwords — IDF handles it), made dynamic (consequential tools —
 * computed from the tool registry at runtime), or kept as a learnable
 * config mapping (step-skip expectations — empty by default).
 *
 * Single source of truth for every threshold. Nothing in the detectors
 * hardcodes a number or a regex — every limit + pattern comes from here or
 * is learned at runtime. Per the binding directive "everything dynamically
 * computed, no static variables/consts": callers construct this via
 * `resolveBandaidConfig` so overrides flow through validation.
 */
export const BANDAID_FAMILIES = deepFreeze([
  "bandaid",
  "workaround",
  "deviation",
  "stepSkip",
] as const);

export type BandaidFamily = typeof BANDAID_FAMILIES[number];

/**
 * A user-supplied bandaid pattern definition (config). The detector compiles
 * `regex` against the ADDED lines of an edit. The DEFAULT config has NO
 * patterns — the structural + learned detectors do the work. A user may add
 * custom patterns via config (e.g. a project-specific bandaid signature).
 */
export type BandaidPattern = Readonly<{
  label: string;
  regex: string;
  severity: BandaidSeverity;
  category: BandaidPatternCategory;
}>;

// THE ARRAY OWNS EACH VOCABULARY. A union and a list of its members written
// separately is one vocabulary in two declarations, and the compiler cannot
// join them: a list holding FEWER members is assignable to `readonly T[]`, so
// a category added to the union and forgotten in the validator compiles with
// zero errors and is then REFUSED at the config boundary — accepted upstream,
// dropped here. `typeof X[number]` leaves one declaration to add it to.
export const BANDAID_PATTERN_CATEGORIES = deepFreeze([
  "type-suppression",
  "error-swallow",
  "null-guard",
  "deferred-fix",
  "lint-suppression",
] as const);

export type BandaidPatternCategory = typeof BANDAID_PATTERN_CATEGORIES[number];

export const BANDAID_SEVERITIES = deepFreeze(["low", "medium", "high"] as const);

export type BandaidSeverity = typeof BANDAID_SEVERITIES[number];

export type FamilyThresholdConfig = Readonly<{
  enabled: boolean;
  /** Minimum number of recorded events before this family is evaluated. */
  minEvents: number;
}>;

/** How the workaround detector determines "consequential" tools. */
export const CONSEQUENTIAL_TOOLS_MODES = deepFreeze(["all", "list"] as const);

export type ConsequentialToolsMode = typeof CONSEQUENTIAL_TOOLS_MODES[number];

export type BandaidConfig = Readonly<{
  families: Readonly<Record<BandaidFamily, FamilyThresholdConfig>>;
  /**
   * User-config bandaid regex patterns (DEFAULT EMPTY — no hardcoded
   * patterns). The detector compiles each against added lines.
   */
  bandaidPatterns: readonly BandaidPattern[];
  /**
   * LEARNED suppression-pragma regexes (mined from the codebase by
   * `learnBandaidPatterns`). The detector compiles these and matches them
   * against comments in the edit. Empty by default — populate via the
   * learner. NO hardcoded values in the source.
   */
  learnedSuppressionPragmas: readonly string[];
  /** LEARNED deferred-fix marker regexes (mined from the codebase). */
  learnedDeferredMarkers: readonly string[];
  /**
   * Enable the structural long-comment deferred heuristic (a comment much
   * longer than the code it precedes → deferred-fix smell). Keyword-free.
   */
  longCommentDeferredEnabled: boolean;
  /** Min ratio of comment chars to following-statement chars for the heuristic. */
  longCommentMinRatio: number;
  /** Min comment length (chars) before the long-comment heuristic applies. */
  longCommentMinCommentLength: number;
  /**
   * When a `knownRootCauseFix` is provided with an edit, the edit must reflect
   * at least this fraction of the root-cause-fix tokens (containment) to
   * clear bandaid suspicion. Below this → bandaid finding (root cause not
   * addressed). This is the PRIMARY keyword-free signal.
   */
  bandaidMinRootCauseOverlap: number;
  /** Edit must touch at least this many lines to be worth scanning. */
  bandaidMinEditLines: number;
  /** Workaround: switch window (turns). */
  workaroundSwitchWindow: number;
  /** Workaround: how to determine consequential tools ("all" = every tool). */
  workaroundConsequentialToolsMode: ConsequentialToolsMode;
  /**
   * Workaround: tool names treated as consequential when mode is "list".
   * Empty by default — populate from the harness tool registry at runtime
   * (no hardcoded list).
   */
  workaroundConsequentialTools: readonly string[];
  /**
   * Workaround: manual-approach regex patterns. DEFAULT EMPTY — replaced by
   * AST detection of hand-rolled reimplementations. Kept for user-config
   * custom patterns; not hardcoded.
   */
  workaroundManualApproachPatterns: readonly string[];
  /** Deviation: cosine similarity threshold. */
  deviationMinTaskSimilarity: number;
  /** Deviation: warmup turns. */
  deviationMinTurnsBeforeDeviation: number;
  /** Deviation: rolling window. */
  deviationWindowSize: number;
  /** Deviation: persistent escalation after N consecutive. */
  deviationPersistentThreshold: number;
  /**
   * Deviation: a configurable stopword list for TF-IDF tokenization. This
   * is a CONFIG value (not a source constant) — the default is the English
   * closed-class words (a fixed linguistic fact, like lowercasing). The
   * deviation detector ALSO applies dynamic stopword removal (words with
   * df > N/2 in the work corpus get zero weight) so the detector is
   * adaptive even when this list is empty. Per the binding directive
   * ("everything dynamically computed, no static variables/consts other
   * than configurables") this is a CONFIGURABLE — override or empty it to
   * rely on the dynamic removal alone.
   */
  deviationStopwords: readonly string[];
  /**
   * Step-skip: per task type, the expected steps. EMPTY by default —
   * populate via learning from observed successful tasks (no hardcoded
   * mapping).
   */
  stepSkipExpectations: Readonly<Record<string, readonly string[]>>;
  /** Step-skip: edit-before-read window. */
  stepSkipEditBeforeReadWindow: number;
  /** Investigation: when a finding is raised, run the investigation stage. */
  investigationEnabled: boolean;
  /** Investigation: root-cause overlap floor for "necessary" classification. */
  investigationRootCauseOverlapFloor: number;
  /** Pause-ask: enabled. */
  pauseAskEnabled: boolean;
  /** Pause-ask: max message length. */
  pauseAskMaxMessageLength: number;
  /**
   * Pause-ask: how long a paused run waits for the user's answer before it
   * ends with a named timeout outcome (milliseconds). A pause is a USER
   * question — the run holds no answer shape it can fall back to, so waiting
   * forever is the one outcome the owner may not produce silently. 0 says
   * "wait forever" and is an explicit operator choice, never a default.
   */
  pauseAskWaitTimeoutMs: number;
  /**
   * Pattern-learner options. The learner mines suppression pragmas +
   * deferred markers from the codebase; these options control minSupport
   * (how many files a pragma must appear in to be learned) and length
   * caps.
   */
  learnOptions: Readonly<{
    minSupport: number;
    maxPragmaLength: number;
    maxDeferredLength: number;
    includeLongCommentHeuristic: boolean;
  }>;
}>;

/**
 * DEFAULT config — NO static keyword patterns. The structural + learned
 * detectors do the work. The only static values here are THRESHOLDS
 * (numbers) and SCHEMA enums (family names), which are the contract, not
 * detection keywords. Per the binding directive "everything dynamically
 * computed, no static variables/consts other than configurables" — these
 * thresholds ARE the configurables.
 */
const BANDAID_DEFAULT_CONFIG = deepFreeze({
  families: {
    bandaid: { enabled: true, minEvents: 1 },
    workaround: { enabled: true, minEvents: 1 },
    deviation: { enabled: true, minEvents: 1 },
    stepSkip: { enabled: true, minEvents: 1 },
  },
  bandaidPatterns: [],
  learnedSuppressionPragmas: [],
  learnedDeferredMarkers: [],
  longCommentDeferredEnabled: true,
  longCommentMinRatio: 4,
  longCommentMinCommentLength: 40,
  bandaidMinRootCauseOverlap: 0.25,
  bandaidMinEditLines: 1,
  workaroundSwitchWindow: 3,
  workaroundConsequentialToolsMode: "all",
  workaroundConsequentialTools: [],
  workaroundManualApproachPatterns: [],
  deviationMinTaskSimilarity: 0.20,
  deviationMinTurnsBeforeDeviation: 3,
  deviationWindowSize: 3,
  deviationPersistentThreshold: 3,
  deviationStopwords: [
    "a", "an", "the", "for", "to", "of", "in", "on", "at", "by", "with",
    "from", "into", "and", "or", "is", "was", "are", "were", "be", "been",
    "as", "it", "its", "this", "that", "these", "those", "all", "any",
    "do", "does", "did", "have", "has", "had", "will", "would", "can",
    "could", "should", "shall", "may", "might", "must",
    "add", "new", "fix", "make", "get", "set", "use", "using", "used",
  ],
  stepSkipExpectations: {},
  stepSkipEditBeforeReadWindow: 5,
  investigationEnabled: true,
  investigationRootCauseOverlapFloor: 0.25,
  pauseAskEnabled: true,
  pauseAskMaxMessageLength: 1000,
  // Ten minutes: generous to a person who answered a chat and put the kettle
  // on, and bound enough that a run nobody is watching cannot hold in-flight
  // state silently for the rest of the process's life.
  pauseAskWaitTimeoutMs: 600_000,
  learnOptions: {
    minSupport: 2,
    maxPragmaLength: 80,
    maxDeferredLength: 200,
    includeLongCommentHeuristic: true,
  },
} as const);

// EACH VALIDATOR IS THE VOCABULARY'S OWN MEMBERSHIP TEST, HELD IN A CLOSURE.
// `new Set<T>([…])` restated every member beside the type it claimed to be
// checking, and `new Set<string>(…)` erased the element type of the one that
// did derive — a mutable set nothing stops from disagreeing with its source.
const VALID_CATEGORIES = memberOf(BANDAID_PATTERN_CATEGORIES);
const VALID_SEVERITIES = memberOf(BANDAID_SEVERITIES);
const VALID_CONSEQUENTIAL_MODES = memberOf(CONSEQUENTIAL_TOOLS_MODES);

export const isBandaidFamily = memberOf(BANDAID_FAMILIES);

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError(`${field} must be a positive finite number`, "bandaid_config_invalid");
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InputError(`${field} must be a non-negative finite number`, "bandaid_config_invalid");
  }
}

function assertUnitRange(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new InputError(`${field} must be a finite number in [0, 1]`, "bandaid_config_invalid");
  }
}

function resolveOneFamily(
  key: BandaidFamily,
  base: FamilyThresholdConfig,
  overrides?: Partial<FamilyThresholdConfig>,
): FamilyThresholdConfig {
  const enabled = overrides?.enabled ?? base.enabled;
  const minEvents = overrides?.minEvents ?? base.minEvents;
  if (!Number.isFinite(minEvents) || minEvents < 0) {
    throw new InputError(`families.${key}.minEvents must be a non-negative finite number`, "bandaid_config_invalid");
  }
  return deepFreeze({ enabled, minEvents });
}

function resolvePatterns(
  base: readonly BandaidPattern[],
  overrides?: readonly Partial<BandaidPattern>[],
): readonly BandaidPattern[] {
  if (!overrides || overrides.length === 0) return base;
  const out: BandaidPattern[] = [];
  for (let i = 0; i < overrides.length; i += 1) {
    const o = overrides[i];
    if (!o) continue;
    const label = o.label ?? `pattern-${i}`;
    const regex = o.regex ?? "";
    const severity: BandaidSeverity = o.severity ?? "medium";
    const category: BandaidPatternCategory = o.category ?? "type-suppression";
    if (typeof regex !== "string" || regex.length === 0) {
      throw new InputError(`bandaidPatterns[${i}].regex must be a non-empty string`, "bandaid_config_invalid");
    }
    if (!VALID_SEVERITIES(severity)) {
      throw new InputError(`bandaidPatterns[${i}].severity must be low|medium|high`, "bandaid_config_invalid");
    }
    if (!VALID_CATEGORIES(category)) {
      throw new InputError(`bandaidPatterns[${i}].category is invalid`, "bandaid_config_invalid");
    }
    try {
      new RegExp(regex);
    } catch (err) {
      throw new InputError(`bandaidPatterns[${i}].regex is invalid: ${(err as Error).message}`, "bandaid_config_invalid");
    }
    out.push(deepFreeze({ label, regex, severity, category }));
  }
  return deepFreeze(out);
}

function resolveRegexList(
  base: readonly string[],
  overrides: readonly string[] | undefined,
  field: string,
): readonly string[] {
  const list = overrides ?? base;
  const out: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    if (typeof p !== "string" || p.length === 0) {
      throw new InputError(`${field}[${i}] must be a non-empty string`, "bandaid_config_invalid");
    }
    try {
      new RegExp(p);
    } catch (err) {
      throw new InputError(`${field}[${i}] is invalid: ${(err as Error).message}`, "bandaid_config_invalid");
    }
    out.push(p);
  }
  return deepFreeze(out);
}

export type BandaidConfigOverrides = Readonly<{
  families?: Readonly<Partial<Record<BandaidFamily, Partial<FamilyThresholdConfig>>>>;
  bandaidPatterns?: readonly Partial<BandaidPattern>[];
  learnedSuppressionPragmas?: readonly string[];
  learnedDeferredMarkers?: readonly string[];
  longCommentDeferredEnabled?: boolean;
  longCommentMinRatio?: number;
  longCommentMinCommentLength?: number;
  bandaidMinRootCauseOverlap?: number;
  bandaidMinEditLines?: number;
  workaroundSwitchWindow?: number;
  workaroundConsequentialToolsMode?: ConsequentialToolsMode;
  workaroundConsequentialTools?: readonly string[];
  workaroundManualApproachPatterns?: readonly string[];
  deviationMinTaskSimilarity?: number;
  deviationMinTurnsBeforeDeviation?: number;
  deviationWindowSize?: number;
  deviationPersistentThreshold?: number;
  deviationStopwords?: readonly string[];
  stepSkipExpectations?: Readonly<Record<string, readonly string[]>>;
  stepSkipEditBeforeReadWindow?: number;
  investigationEnabled?: boolean;
  investigationRootCauseOverlapFloor?: number;
  pauseAskEnabled?: boolean;
  pauseAskMaxMessageLength?: number;
  pauseAskWaitTimeoutMs?: number;
  learnOptions?: Readonly<{
    minSupport?: number;
    maxPragmaLength?: number;
    maxDeferredLength?: number;
    includeLongCommentHeuristic?: boolean;
  }>;
}>;

/**
 * Construct a validated `BandaidConfig`. Unknown family keys in `overrides`
 * are rejected; missing keys fall back to `BANDAID_DEFAULT_CONFIG`. Every
 * regex pattern is compiled eagerly so detection never throws. No static
 * keyword list is introduced — `learnedSuppressionPragmas` /
 * `learnedDeferredMarkers` are expected to be populated by the learner at
 * runtime (empty by default).
 */
export function resolveBandaidConfig(overrides: BandaidConfigOverrides = {}): BandaidConfig {
  const baseFamilies = BANDAID_DEFAULT_CONFIG.families;
  const overrideFamilies: Readonly<Partial<Record<BandaidFamily, Partial<FamilyThresholdConfig>>>> =
    overrides.families ?? {};
  for (const key of Object.keys(overrideFamilies)) {
    if (!isBandaidFamily(key)) {
      throw new InputError(`unknown bandaid family "${key}" in overrides.families`, "bandaid_config_invalid");
    }
  }
  const families = {} as Record<BandaidFamily, FamilyThresholdConfig>;
  for (const f of BANDAID_FAMILIES) {
    families[f] = resolveOneFamily(f, baseFamilies[f], overrideFamilies[f]);
  }

  const bandaidPatterns = resolvePatterns(
    BANDAID_DEFAULT_CONFIG.bandaidPatterns,
    overrides.bandaidPatterns,
  );
  const learnedSuppressionPragmas = resolveRegexList(
    BANDAID_DEFAULT_CONFIG.learnedSuppressionPragmas,
    overrides.learnedSuppressionPragmas,
    "learnedSuppressionPragmas",
  );
  const learnedDeferredMarkers = resolveRegexList(
    BANDAID_DEFAULT_CONFIG.learnedDeferredMarkers,
    overrides.learnedDeferredMarkers,
    "learnedDeferredMarkers",
  );
  const longCommentDeferredEnabled =
    overrides.longCommentDeferredEnabled ?? BANDAID_DEFAULT_CONFIG.longCommentDeferredEnabled;
  const longCommentMinRatio =
    overrides.longCommentMinRatio ?? BANDAID_DEFAULT_CONFIG.longCommentMinRatio;
  const longCommentMinCommentLength =
    overrides.longCommentMinCommentLength ?? BANDAID_DEFAULT_CONFIG.longCommentMinCommentLength;
  const bandaidMinRootCauseOverlap =
    overrides.bandaidMinRootCauseOverlap ?? BANDAID_DEFAULT_CONFIG.bandaidMinRootCauseOverlap;
  const bandaidMinEditLines =
    overrides.bandaidMinEditLines ?? BANDAID_DEFAULT_CONFIG.bandaidMinEditLines;
  const workaroundSwitchWindow =
    overrides.workaroundSwitchWindow ?? BANDAID_DEFAULT_CONFIG.workaroundSwitchWindow;
  const workaroundConsequentialToolsMode: ConsequentialToolsMode =
    overrides.workaroundConsequentialToolsMode ?? BANDAID_DEFAULT_CONFIG.workaroundConsequentialToolsMode;
  if (!VALID_CONSEQUENTIAL_MODES(workaroundConsequentialToolsMode)) {
    throw new InputError(`workaroundConsequentialToolsMode must be "all" | "list"`, "bandaid_config_invalid");
  }
  const workaroundConsequentialTools =
    overrides.workaroundConsequentialTools ?? BANDAID_DEFAULT_CONFIG.workaroundConsequentialTools;
  const workaroundManualApproachPatterns =
    overrides.workaroundManualApproachPatterns ?? BANDAID_DEFAULT_CONFIG.workaroundManualApproachPatterns;
  const deviationMinTaskSimilarity =
    overrides.deviationMinTaskSimilarity ?? BANDAID_DEFAULT_CONFIG.deviationMinTaskSimilarity;
  const deviationMinTurnsBeforeDeviation =
    overrides.deviationMinTurnsBeforeDeviation ?? BANDAID_DEFAULT_CONFIG.deviationMinTurnsBeforeDeviation;
  const deviationWindowSize =
    overrides.deviationWindowSize ?? BANDAID_DEFAULT_CONFIG.deviationWindowSize;
  const deviationPersistentThreshold =
    overrides.deviationPersistentThreshold ?? BANDAID_DEFAULT_CONFIG.deviationPersistentThreshold;
  const deviationStopwords =
    overrides.deviationStopwords ?? BANDAID_DEFAULT_CONFIG.deviationStopwords;
  const stepSkipExpectations =
    overrides.stepSkipExpectations ?? BANDAID_DEFAULT_CONFIG.stepSkipExpectations;
  const stepSkipEditBeforeReadWindow =
    overrides.stepSkipEditBeforeReadWindow ?? BANDAID_DEFAULT_CONFIG.stepSkipEditBeforeReadWindow;
  const investigationEnabled =
    overrides.investigationEnabled ?? BANDAID_DEFAULT_CONFIG.investigationEnabled;
  const investigationRootCauseOverlapFloor =
    overrides.investigationRootCauseOverlapFloor ?? BANDAID_DEFAULT_CONFIG.investigationRootCauseOverlapFloor;
  const pauseAskEnabled =
    overrides.pauseAskEnabled ?? BANDAID_DEFAULT_CONFIG.pauseAskEnabled;
  const pauseAskMaxMessageLength =
    overrides.pauseAskMaxMessageLength ?? BANDAID_DEFAULT_CONFIG.pauseAskMaxMessageLength;
  const pauseAskWaitTimeoutMs =
    overrides.pauseAskWaitTimeoutMs ?? BANDAID_DEFAULT_CONFIG.pauseAskWaitTimeoutMs;
  const learnOptions = {
    minSupport: overrides.learnOptions?.minSupport ?? BANDAID_DEFAULT_CONFIG.learnOptions.minSupport,
    maxPragmaLength: overrides.learnOptions?.maxPragmaLength ?? BANDAID_DEFAULT_CONFIG.learnOptions.maxPragmaLength,
    maxDeferredLength: overrides.learnOptions?.maxDeferredLength ?? BANDAID_DEFAULT_CONFIG.learnOptions.maxDeferredLength,
    includeLongCommentHeuristic:
      overrides.learnOptions?.includeLongCommentHeuristic ?? BANDAID_DEFAULT_CONFIG.learnOptions.includeLongCommentHeuristic,
  };

  assertUnitRange(bandaidMinRootCauseOverlap, "bandaidMinRootCauseOverlap");
  assertNonNegativeFinite(bandaidMinEditLines, "bandaidMinEditLines");
  assertPositiveFinite(workaroundSwitchWindow, "workaroundSwitchWindow");
  assertUnitRange(deviationMinTaskSimilarity, "deviationMinTaskSimilarity");
  assertNonNegativeFinite(deviationMinTurnsBeforeDeviation, "deviationMinTurnsBeforeDeviation");
  assertPositiveFinite(deviationWindowSize, "deviationWindowSize");
  assertPositiveFinite(deviationPersistentThreshold, "deviationPersistentThreshold");
  assertPositiveFinite(stepSkipEditBeforeReadWindow, "stepSkipEditBeforeReadWindow");
  assertUnitRange(investigationRootCauseOverlapFloor, "investigationRootCauseOverlapFloor");
  assertPositiveFinite(pauseAskMaxMessageLength, "pauseAskMaxMessageLength");
  // Non-negative rather than positive: the one honest meaning of 0 here is
  // "no bound" (the wait never times out), and false input is refused, never
  // silently clamped to a floor the operator did not ask for.
  assertNonNegativeFinite(pauseAskWaitTimeoutMs, "pauseAskWaitTimeoutMs");
  assertPositiveFinite(longCommentMinRatio, "longCommentMinRatio");
  assertPositiveFinite(longCommentMinCommentLength, "longCommentMinCommentLength");
  assertPositiveFinite(learnOptions.minSupport, "learnOptions.minSupport");
  assertPositiveFinite(learnOptions.maxPragmaLength, "learnOptions.maxPragmaLength");
  assertPositiveFinite(learnOptions.maxDeferredLength, "learnOptions.maxDeferredLength");

  for (const p of workaroundManualApproachPatterns) {
    if (typeof p !== "string" || p.length === 0) {
      throw new InputError("workaroundManualApproachPatterns entries must be non-empty strings", "bandaid_config_invalid");
    }
    try {
      new RegExp(p);
    } catch (err) {
      throw new InputError(`workaroundManualApproachPatterns regex is invalid: ${(err as Error).message}`, "bandaid_config_invalid");
    }
  }
  for (const p of workaroundConsequentialTools) {
    if (typeof p !== "string" || p.length === 0) {
      throw new InputError("workaroundConsequentialTools entries must be non-empty strings", "bandaid_config_invalid");
    }
  }
  for (const [, steps] of Object.entries(stepSkipExpectations)) {
    if (!Array.isArray(steps)) {
      throw new InputError("stepSkipExpectations values must be arrays of strings", "bandaid_config_invalid");
    }
    for (const s of steps) {
      if (typeof s !== "string" || s.length === 0) {
        throw new InputError("stepSkipExpectations entries must be non-empty strings", "bandaid_config_invalid");
      }
    }
  }

  const config: BandaidConfig = {
    families: deepFreeze(families),
    bandaidPatterns,
    learnedSuppressionPragmas,
    learnedDeferredMarkers,
    longCommentDeferredEnabled,
    longCommentMinRatio,
    longCommentMinCommentLength,
    bandaidMinRootCauseOverlap,
    bandaidMinEditLines,
    workaroundSwitchWindow,
    workaroundConsequentialToolsMode,
    workaroundConsequentialTools: deepFreeze([...workaroundConsequentialTools]),
    workaroundManualApproachPatterns: deepFreeze([...workaroundManualApproachPatterns]),
    deviationMinTaskSimilarity,
    deviationMinTurnsBeforeDeviation,
    deviationWindowSize,
    deviationPersistentThreshold,
    deviationStopwords: deepFreeze([...deviationStopwords]),
    stepSkipExpectations: deepFreeze({ ...stepSkipExpectations }),
    stepSkipEditBeforeReadWindow,
    investigationEnabled,
    investigationRootCauseOverlapFloor,
    pauseAskEnabled,
    pauseAskMaxMessageLength,
    pauseAskWaitTimeoutMs,
    learnOptions: deepFreeze(learnOptions),
  };
  return deepFreeze(config);
}
