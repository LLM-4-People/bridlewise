/**
 * Central configuration for the dynamic codebase awareness engine.
 *
 * This is the SINGLE owner of every threshold, cap, top-N limit, signal
 * toggle, and language mapping used by the awareness engine. Per the user
 * directive ("everything should be dynamically computed, no static
 * variables/consts other than configurables"), every numeric/string
 * constant that is not derived from the actual codebase lives HERE, in
 * the central config, and is overridable by the caller. The signal
 * implementations never read hardcoded values from their own modules.
 *
 * Language keywords (e.g. `def`, `fn`, `func`) are NOT harness constants;
 * they are part of the target language's grammar and live in the
 * language adapters alongside the parser that uses them.
 */
import { deepFreeze } from "../kernel/integrity.ts";

/**
 * Configuration for one supported source language.
 *
 * `extensions` and `functionKeyword`/`typeAnnotationPattern` are part of
 * the language's grammar, not harness policy; they are colocated with the
 * adapter but exposed here so the engine's file walker can dispatch to the
 * right adapter without a hardcoded extension switch.
 */
export type LanguageConfig = Readonly<{
  /** Language id, e.g. "typescript", "python", "rust", "go". */
  id: string;
  /** Human-readable label used in the compact block. */
  label: string;
  /** File extensions, lowercase, leading dot. */
  extensions: readonly string[];
  /** Comment line prefixes used for TODO/FIXME scanning. */
  commentLinePrefixes: readonly string[];
}>;

/**
 * Per-signal thresholds and caps. Every value is overridable; the
 * defaults are deliberately conservative so the compact block stays
 * inside the 200–500 token budget on codebases from a few files up to
 * tens of thousands.
 */
export type AwarenessThresholds = Readonly<{
  /** Cyclomatic complexity at/above which a function is a "hotspot". */
  complexityHotspot: number;
  /** Numeric literal count threshold for "magic number" detection per file. */
  magicNumberAllowlist: readonly number[];
  /** Body size (chars) below which a function is skipped for clone detection. */
  cloneMinBodySize: number;
  /** Token count below which a function is skipped for clone detection. */
  cloneMinTokens: number;
  /** Jaccard similarity at/above which two function bodies are "clones". */
  cloneJaccardThreshold: number;
  /** Shingle size for Jaccard clone detection. */
  cloneShingleK: number;
  /** Shingles appearing in more than this many functions are non-discriminative. */
  cloneBucketCap: number;
  /** PageRank damping factor. */
  pagerankDamping: number;
  /** PageRank iteration count. */
  pagerankIterations: number;
  /** PageRank convergence tolerance (unused when iterations is fixed). */
  pagerankTolerance: number;
  /** Number of commits to scan for trending/debt signals (0 = no git). */
  gitHistoryDepth: number;
  /** Ebbinghaus decay rate per unit time (per day) for debt accrual. */
  debtDecayPerDay: number;
  /** Function call-count at/above which a high-complexity fn becomes a risk. */
  riskCallCountThreshold: number;
  /** QEC code distance at/above which a clone family is "well-protected" (EXP346). */
  qecProtectedDistance: number;
  /** Ricci curvature below which a module edge is a "bridge" (EXP322). */
  ricciBridgeThreshold: number;
  /** Ricci curvature above which a module edge is a "hub" (EXP322). */
  ricciHubThreshold: number;
  /** Quantum decoherence coherence score above which the codebase is "stable" (EXP309). */
  quantumStabilityThreshold: number;
  /** Edit predictability above which the codebase is "predictable" (EXP224). */
  editPredictabilityThreshold: number;
  /** Fiedler value below which the module graph has a "bottleneck" (EXP46). */
  fiedlerBottleneck: number;
  /** Treadmill: a file edited in >= this many recent commits is a treadmill (EXP326). */
  treadmillCommitThreshold: number;
  /** Max source files to scan for Benford numeric-literal analysis (EXP42). */
  benfordMaxFiles: number;
  /** Timeout (ms) for the git subprocess spawned by the engine for history/debt signals. */
  gitTimeoutMs: number;
  /** Top-N tokens used by the free-probability hidden-coupling signal (EXP84/320). */
  freeProbabilityTopTokens: number;
  /** Number of community colors for the Pólya-enumeration combinatorics
   * signal (the k in "with k community colors"). Was a hardcoded 3. */
  combinatoricsCommunityColors: number;
}>;

/**
 * Top-N limits for the compact representation. These bound the size of
 * each section so the total block stays inside the token budget.
 */
export type AwarenessTopN = Readonly<{
  topHubModules: number;
  topTrendingModules: number;
  topRiskHotspots: number;
  topCloneFamilies: number;
  topComplexFunctions: number;
  topModuleRoles: number;
  topRecentFiles: number;
  topRenyiOrders: number;
}>;

/**
 * Which signals to compute. Each toggle is overridable so callers can
 * disable expensive signals (e.g. clones on a 10k-file codebase).
 */
export type AwarenessSignalToggles = Readonly<{
  typeLevel: boolean;
  quality: boolean;
  drift: boolean;
  complexity: boolean;
  architecture: boolean;
  clones: boolean;
  entropy: boolean;
  dependencies: boolean;
  health: boolean;
  debt: boolean;
  moduleRoles: boolean;
  hotspots: boolean;
  trending: boolean;
  risk: boolean;
  // EXP372 new signals (16).
  bellClones: boolean;
  banachContraction: boolean;
  qecDistance: boolean;
  agSpectrum: boolean;
  waveletClones: boolean;
  ricciCurvature: boolean;
  fiberBundle: boolean;
  topos: boolean;
  functionStats: boolean;
  persistenceLandscapes: boolean;
  testCoverage: boolean;
  ergodicDrift: boolean;
  quantumStability: boolean;
  editPredictability: boolean;
  recursionHierarchy: boolean;
  hubStress: boolean;
  // EXP387 new signals (14) — sourced from EXPERIMENTS-SURVEY.md findings.
  thermodynamics: boolean;        // EXP41/210: free energy F = U - T·S
  benford: boolean;               // EXP42: numeric literal first-digit Benford deviation
  fiedlerBisection: boolean;      // EXP46/248: Laplacian Fiedler value λ2
  homology: boolean;               // EXP51/101: H0 components, H1 cycles (hidden DRY)
  shapeDna: boolean;              // EXP57: AST-shape clustering (cross-file clone candidate)
  chromaticNumber: boolean;       // EXP113: chromatic number of clone graph
  martingaleDebt: boolean;        // EXP323/328: sub-martingale drift of DRY violations
  freeProbability: boolean;       // EXP84/320: token-class free independence (hidden coupling)
  maxwellDemon: boolean;          // EXP307/324: information-flow efficiency of hubs
  functionClassification: boolean;// EXP102: 4-axis function classification
  linguisticTypology: boolean;    // EXP223: imperative/functional/declarative/async mix
  turingTreadmills: boolean;      // EXP326: files refactored repeatedly (never settle)
  mechanismDesign: boolean;       // EXP327: incentive-compatibility ratio of clone detector
  sheafCohomology: boolean;       // EXP80: H⁰ universal symbols, H¹ broken imports
  // EXP462 new signals (44 more — 10× harder).
  al2Fitness: boolean;
  leChatelier: boolean;
  obafgkm: boolean;
  peierlsSymmetry: boolean;
  bornHaber: boolean;
  kolmogorovComplexity: boolean;
  renyiEntropy: boolean;
  tsallisEntropy: boolean;
  klDivergence: boolean;
  jsDivergence: boolean;
  fisherInformation: boolean;
  mutualInformation: boolean;
  hartleyEntropy: boolean;
  betweennessCentrality: boolean;
  closenessCentrality: boolean;
  eigenvectorCentrality: boolean;
  katzCentrality: boolean;
  clusteringCoefficient: boolean;
  modularity: boolean;
  kirchhoffIndex: boolean;
  cheegerConstant: boolean;
  spectralGap: boolean;
  lovaszTheta: boolean;
  girth: boolean;
  graphDiameter: boolean;
  halsteadComplexity: boolean;
  maintainabilityIndex: boolean;
  cyclomaticDebt: boolean;
  lcomCohesion: boolean;
  coupling: boolean;
  sorensenDice: boolean;
  simpsonDiversity: boolean;
  shannonEvenness: boolean;
  giniCoefficient: boolean;
  bergerParker: boolean;
  lagrangian: boolean;
  hamiltonian: boolean;
  entropyProduction: boolean;
  freeEnergy: boolean;
  polyaEnumeration: boolean;
  burnsideLemma: boolean;
  catalanNumber: boolean;
  stirlingNumber: boolean;
  assortativity: boolean;
}>;

/**
 * The full awareness configuration. The engine reads ONLY from this
 * object; signal modules receive their slice via the engine.
 */
export type AwarenessConfig = Readonly<{
  /** Languages to detect and walk. Order = priority for the "primary language" label. */
  languages: readonly LanguageConfig[];
  /** Directories to skip during the walk. */
  excludedDirectoryNames: readonly string[];
  /** Maximum walk depth (safety cap). */
  maximumDepth: number;
  /** Maximum file entries (safety cap). */
  maximumEntries: number;
  /** Maximum file size in bytes (skip larger files). */
  maximumFileBytes: number;
  /** Whether to use git history for trending/debt (false if git unavailable). */
  useGitHistory: boolean;
  /** Thresholds. */
  thresholds: AwarenessThresholds;
  /** Top-N limits for the compact block. */
  topN: AwarenessTopN;
  /** Signal toggles. */
  signals: AwarenessSignalToggles;
  /** Target token budget for the compact block. */
  compactTokenBudget: number;
  /** Characters-per-token estimate for compactness measurement. */
  compactCharsPerToken: number;
  /**
   * Whether to compute the expensive O(n²) / O(n³) signals (the EXP372 +
   * EXP387 advanced clone/graph/topology signals). When `false`, the engine
   * skips every signal listed in `EXPENSIVE_SIGNAL_IDS` (in engine.ts),
   * regardless of the per-signal toggle. This is the single knob callers
   * use to keep the snapshot tractable on large codebases (lodash: 50.5s →
   * ~3s with expensiveSignals=false). Default `true` so small codebases
   * still get the full signal set. EXP446 documented this flag as dead
   * code; EXP462 wires it. The per-signal toggles in `signals.*` remain
   * the fine-grained authority; `expensiveSignals` is the coarse gate.
   */
  expensiveSignals: boolean;
  /**
   * OBAFGKM stellar-temperature class boundaries for the function
   * temperature classifier (EXP442/EXP455). Each value is a churn-
   * percentile threshold (top percentile = the "hot" cut). The keys are
   * the stellar classes O/B/A/F/G/K/M (hottest → coolest). Owned HERE (the
   * single awareness config owner); `temperature.ts` is a
   * consumer that casts to its `Record<TemperatureClass, number>`.
   */
  temperatureBoundaries: Readonly<Record<string, number>>;
}>;

/**
 * Signal ids that are gated by `config.expensiveSignals`. These are the
 * O(n²) / O(n³) signals from EXP372 + EXP387 — clone-graph pairwise
 * comparisons, module-graph topology, and persistent-homology-style
 * computations. The baseline 14 signals (typeLevel, quality, drift,
 * complexity, architecture, clones, entropy, dependencies, health, debt,
 * moduleRoles, hotspots, trending, risk) are ALWAYS computed (they are
 * O(n) or O(n log n)). This list is the single owner of "what is
 * expensive" — the engine consults it; no signal module hardcodes the
 * gate. EXTEND this set when adding a new expensive signal; do NOT add
 * a signal id here that is O(n).
 */
export const EXPENSIVE_SIGNAL_IDS: ReadonlySet<string> = new Set([
  "bellClones",
  "banachContraction",
  "qecDistance",
  "agSpectrum",
  "waveletClones",
  "ricciCurvature",
  "fiberBundle",
  "topos",
  "persistenceLandscapes",
  "ergodicDrift",
  "quantumStability",
  "editPredictability",
  "recursionHierarchy",
  "hubStress",
  "thermodynamics",
  "benford",
  "fiedlerBisection",
  "homology",
  "shapeDna",
  "chromaticNumber",
  "martingaleDebt",
  "freeProbability",
  "maxwellDemon",
  "functionClassification",
  "linguisticTypology",
  "turingTreadmills",
  "mechanismDesign",
  "sheafCohomology",
  // EXP462 new expensive signals (44 more) — gated here so the
  // expensiveSignals=false fast path covers them too.
  "al2Fitness",
  "leChatelier",
  "obafgkm",
  "peierlsSymmetry",
  "bornHaber",
  "kolmogorovComplexity",
  "renyiEntropy",
  "tsallisEntropy",
  "klDivergence",
  "jsDivergence",
  "fisherInformation",
  "mutualInformation",
  "hartleyEntropy",
  "betweennessCentrality",
  "closenessCentrality",
  "eigenvectorCentrality",
  "katzCentrality",
  "clusteringCoefficient",
  "modularity",
  "kirchhoffIndex",
  "cheegerConstant",
  "spectralGap",
  "lovaszTheta",
  "girth",
  "graphDiameter",
  "halsteadComplexity",
  "maintainabilityIndex",
  "cyclomaticDebt",
  "lcomCohesion",
  "coupling",
  "sorensenDice",
  "simpsonDiversity",
  "shannonEvenness",
  "giniCoefficient",
  "bergerParker",
  "lagrangian",
  "hamiltonian",
  "entropyProduction",
  "freeEnergy",
  "polyaEnumeration",
  "burnsideLemma",
  "catalanNumber",
  "stirlingNumber",
  "assortativity",
]);

/** Default languages. Extendable via `AwarenessConfig.languages`. */
const DEFAULT_AWARENESS_LANGUAGES = deepFreeze([
  { id: "typescript", label: "TypeScript/JavaScript", extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], commentLinePrefixes: ["//", "/*", "*"] },
  { id: "python",     label: "Python",                extensions: [".py"],                                                                 commentLinePrefixes: ["#"] },
  { id: "rust",       label: "Rust",                  extensions: [".rs"],                                                                commentLinePrefixes: ["//", "/*", "*"] },
  { id: "go",         label: "Go",                    extensions: [".go"],                                                                commentLinePrefixes: ["//", "/*", "*"] },
] as const) satisfies readonly LanguageConfig[];

/** Default excluded directory names (build artefacts, deps, VCS, test data, etc.). */
const DEFAULT_EXCLUDED_DIRS = deepFreeze([
  // Build outputs and deps.
  "node_modules", ".git", "dist", "build", "target", "__pycache__",
  ".venv", "venv", "vendor", ".next", ".nuxt", "out", "bin", "obj",
  "coverage", ".cache", ".turbo", ".idea", ".vscode",
  ".yarn", ".pnp.cjs", ".pnp.js", "lib", "Lib",
  // Test data + fixtures + benchmarks (NOT production source).
  "__tests__", "__fixtures__", "__mocks__", "fixtures", "cypress",
  "cases", "baselines", "test-cases", "testdata", "test-data",
  "benchmark", "benchmarks", "codemods",
  // Misc editor/tooling.
  ".svelte-kit", ".parcel-cache", ".gradle", ".m2", ".dart_tool",
] as const);

/** Default thresholds, chosen to keep the compact block inside budget. */
const DEFAULT_THRESHOLDS = deepFreeze({
  complexityHotspot: 15,
  magicNumberAllowlist: [0, 1, -1, 2, -2, 10, 60, 100, 1000, 3600, 0.5],
  cloneMinBodySize: 80,
  cloneMinTokens: 30,
  cloneJaccardThreshold: 0.9,
  cloneShingleK: 6,
  cloneBucketCap: 200,
  pagerankDamping: 0.85,
  pagerankIterations: 30,
  pagerankTolerance: 1e-6,
  gitHistoryDepth: 30,
  debtDecayPerDay: 0.05,
  riskCallCountThreshold: 5,
  // EXP372 new thresholds.
  qecProtectedDistance: 5,
  ricciBridgeThreshold: 0.0,
  ricciHubThreshold: 0.5,
  quantumStabilityThreshold: 0.7,
  editPredictabilityThreshold: 0.6,
  // EXP387 new thresholds.
  fiedlerBottleneck: 0.05,
  treadmillCommitThreshold: 4,
  benfordMaxFiles: 2000,
  // Consolidated from scattered inline literals.
  gitTimeoutMs: 10_000,
  freeProbabilityTopTokens: 20,
  combinatoricsCommunityColors: 3,
} as const) satisfies AwarenessThresholds;

/**
 * Default OBAFGKM stellar-temperature class boundaries (EXP442/EXP455).
 * Owned HERE (the single awareness config owner); was a
 * scattered `OBAFGKM_DEFAULT_BOUNDARIES` const in `temperature.ts`. Each
 * value is a churn-percentile threshold (top percentile = the "hot" cut).
 */
export const DEFAULT_TEMPERATURE_BOUNDARIES: Readonly<Record<string, number>> = deepFreeze({
  O: 0.9999, // top 0.01%
  B: 0.999,  // top 0.1%
  A: 0.99,   // top 1%
  F: 0.95,   // top 5%
  G: 0.80,   // top 20%
  K: 0.50,   // top 50%
  M: 0.00,   // the rest
} as const);

/** Default Top-N limits. */
const DEFAULT_TOP_N = deepFreeze({
  topHubModules: 5,
  topTrendingModules: 5,
  topRiskHotspots: 5,
  topCloneFamilies: 5,
  topComplexFunctions: 5,
  topModuleRoles: 5,
  topRecentFiles: 5,
  topRenyiOrders: 4,
} as const) satisfies AwarenessTopN;

/** Default signal toggles (all on). */
const DEFAULT_SIGNAL_TOGGLES = deepFreeze({
  typeLevel: true,
  quality: true,
  drift: true,
  complexity: true,
  architecture: true,
  clones: true,
  entropy: true,
  dependencies: true,
  health: true,
  debt: true,
  moduleRoles: true,
  hotspots: true,
  trending: true,
  risk: true,
  // EXP372 new signals (16) — all on by default.
  bellClones: true,
  banachContraction: true,
  qecDistance: true,
  agSpectrum: true,
  waveletClones: true,
  ricciCurvature: true,
  fiberBundle: true,
  topos: true,
  functionStats: true,
  persistenceLandscapes: true,
  testCoverage: true,
  ergodicDrift: true,
  quantumStability: true,
  editPredictability: true,
  recursionHierarchy: true,
  hubStress: true,
  // EXP387 new signals (14) — all on by default.
  thermodynamics: true,
  benford: true,
  fiedlerBisection: true,
  homology: true,
  shapeDna: true,
  chromaticNumber: true,
  martingaleDebt: true,
  freeProbability: true,
  maxwellDemon: true,
  functionClassification: true,
  linguisticTypology: true,
  turingTreadmills: true,
  mechanismDesign: true,
  sheafCohomology: true,
  // EXP462 new signals (44 more — 10× harder). All on by default; gated by
  // `expensiveSignals` (the coarse knob) since most are O(n²) on the
  // module/function graph.
  al2Fitness: true,
  leChatelier: true,
  obafgkm: true,
  peierlsSymmetry: true,
  bornHaber: true,
  kolmogorovComplexity: true,
  renyiEntropy: true,
  tsallisEntropy: true,
  klDivergence: true,
  jsDivergence: true,
  fisherInformation: true,
  mutualInformation: true,
  hartleyEntropy: true,
  betweennessCentrality: true,
  closenessCentrality: true,
  eigenvectorCentrality: true,
  katzCentrality: true,
  clusteringCoefficient: true,
  modularity: true,
  kirchhoffIndex: true,
  cheegerConstant: true,
  spectralGap: true,
  lovaszTheta: true,
  girth: true,
  graphDiameter: true,
  halsteadComplexity: true,
  maintainabilityIndex: true,
  cyclomaticDebt: true,
  lcomCohesion: true,
  coupling: true,
  sorensenDice: true,
  simpsonDiversity: true,
  shannonEvenness: true,
  giniCoefficient: true,
  bergerParker: true,
  lagrangian: true,
  hamiltonian: true,
  entropyProduction: true,
  freeEnergy: true,
  polyaEnumeration: true,
  burnsideLemma: true,
  catalanNumber: true,
  stirlingNumber: true,
  assortativity: true,
} as const) satisfies AwarenessSignalToggles;

/** Default awareness config. */
export const DEFAULT_AWARENESS_CONFIG: AwarenessConfig = deepFreeze({
  languages: DEFAULT_AWARENESS_LANGUAGES,
  excludedDirectoryNames: DEFAULT_EXCLUDED_DIRS,
  maximumDepth: 32,
  maximumEntries: 50_000,
  maximumFileBytes: 5_000_000,
  useGitHistory: true,
  thresholds: DEFAULT_THRESHOLDS,
  topN: DEFAULT_TOP_N,
  signals: DEFAULT_SIGNAL_TOGGLES,
  compactTokenBudget: 500,
  compactCharsPerToken: 4,
  expensiveSignals: true,
  temperatureBoundaries: DEFAULT_TEMPERATURE_BOUNDARIES,
} as const) satisfies AwarenessConfig;

/**
 * Merge a partial override into the default config. Only the supplied
 * fields are overridden; nested objects are shallow-merged at the
 * `thresholds`/`topN`/`signals` level.
 */
export function configureAwareness(override: Readonly<Partial<AwarenessConfig>>): AwarenessConfig {
  const base: AwarenessConfig = DEFAULT_AWARENESS_CONFIG;
  return deepFreeze({
    languages: override.languages ?? base.languages,
    excludedDirectoryNames: override.excludedDirectoryNames ?? base.excludedDirectoryNames,
    maximumDepth: override.maximumDepth ?? base.maximumDepth,
    maximumEntries: override.maximumEntries ?? base.maximumEntries,
    maximumFileBytes: override.maximumFileBytes ?? base.maximumFileBytes,
    useGitHistory: override.useGitHistory ?? base.useGitHistory,
    thresholds: { ...base.thresholds, ...override.thresholds },
    topN: { ...base.topN, ...override.topN },
    signals: { ...base.signals, ...override.signals },
    compactTokenBudget: override.compactTokenBudget ?? base.compactTokenBudget,
    compactCharsPerToken: override.compactCharsPerToken ?? base.compactCharsPerToken,
    expensiveSignals: override.expensiveSignals ?? base.expensiveSignals,
    temperatureBoundaries: override.temperatureBoundaries ?? base.temperatureBoundaries,
  } as const);
}
