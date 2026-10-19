/**
 * Shared types for the dynamic awareness engine. These are produced by
 * the language adapters and consumed by the signal modules.
 *
 * The engine never reads raw source files twice: it walks the tree once,
 * invokes the language adapter per file (cached by mtime+size), and
 * feeds the resulting `FileAnalysis` to every signal. Signal modules are
 * pure functions of `(fileAnalyses, config)` — they never touch the
 * filesystem or re-read source.
 */
import type { AwarenessConfig, LanguageConfig } from "./config.ts";
import { schemaId } from "../kernel/product-identity.ts";

/** A single function/method definition found by the language adapter. */
export type FunctionRecord = Readonly<{
  /** Path relative to the codebase root, using forward slashes. */
  filePath: string;
  /** Function/method name (or "<anonymous>"). */
  name: string;
  /** 1-based start line. */
  line: number;
  /** Body length in lines (0 if unknown). */
  bodyLines: number;
  /** Body length in characters. */
  bodyChars: number;
  /** Normalized tokens (used for clone detection + entropy). */
  tokens: readonly string[];
  /** Cyclomatic complexity (1 + number of decision points). */
  complexity: number;
  /** Number of parameters with type annotations. */
  typedParameters: number;
  /** Total parameter count. */
  parameterCount: number;
  /** Whether the return type is annotated. */
  hasReturnAnnotation: boolean;
}>;

/** An import statement found by the language adapter. */
export type ImportRecord = Readonly<{
  /** File making the import. */
  filePath: string;
  /** Raw specifier (e.g. "./foo", "@babel/core", "react", "os"). */
  specifier: string;
  /** Names imported (may be empty for side-effect imports). */
  importedNames: readonly string[];
  /** Resolved path if intra-codebase, else null. */
  resolvedPath: string | null;
}>;

/** An export found by the language adapter. */
export type ExportRecord = Readonly<{
  /** File making the export. */
  filePath: string;
  /** Exported name. */
  name: string;
  /** Whether this is the default export. */
  isDefault: boolean;
}>;

/** Per-file analysis produced by a language adapter. */
export type FileAnalysis = Readonly<{
  /** Path relative to the codebase root, forward slashes. */
  filePath: string;
  /** Language id from `LanguageConfig.id`. */
  languageId: string;
  /** Total line count (excludes final newline-only lines). */
  lineCount: number;
  /** Whether the file has any type annotations. */
  hasTypeAnnotations: boolean;
  /** Fraction of function params with type annotations (0–1). */
  typedParameterFraction: number;
  /** Functions in this file. */
  functions: readonly FunctionRecord[];
  /** Imports in this file. */
  imports: readonly ImportRecord[];
  /** Exports in this file. */
  exports: readonly ExportRecord[];
  /** Counts of code-health issues per category. */
  health: Readonly<Record<string, number>>;
  /** Token-stream for entropy (concatenated identifiers + literals). */
  tokenStream: readonly string[];
  /** File content hash (sha256 hex). */
  contentHash: string;
}>;

/** Per-module aggregate (a "module" = a directory under the source root). */
export type ModuleRecord = Readonly<{
  /** Module path (directory) relative to root, forward slashes. */
  path: string;
  /** Module name (last path segment, or root name). */
  name: string;
  /** Number of source files in this module. */
  fileCount: number;
  /** Number of functions in this module. */
  functionCount: number;
  /** Total LOC in this module. */
  lineCount: number;
  /** PageRank score (set by architecture signal). */
  pagerank: number;
  /** Number of distinct modules that import this module (in-degree). */
  inDegree: number;
  /** Number of distinct modules this module imports (out-degree). */
  outDegree: number;
  /** Most recent mtime among files in this module (ms since epoch). */
  latestMtimeMs: number;
}>;

/** The full awareness snapshot — all signals computed at one point in time. */
export type AwarenessSnapshot = Readonly<{
  /** Engine schema version (constant — see SNAPSHOT_SCHEMA_VERSION below). */
  schemaVersion: string;
  /** ISO timestamp when the snapshot was computed. */
  computedAt: string;
  /** Codebase root path. */
  rootPath: string;
  /** Languages detected and their file counts (sorted desc). */
  languageMix: readonly Readonly<{ languageId: string; label: string; fileCount: number; lineCount: number }>[];
  /** Primary language id (highest file count). */
  primaryLanguageId: string | null;
  /** File counts. */
  fileCount: number;
  /** Function count. */
  functionCount: number;
  /** Module count. */
  moduleCount: number;
  /** Total LOC across all source files. */
  totalLoc: number;
  /** Per-module aggregates. */
  modules: readonly ModuleRecord[];
  /** Per-file analyses (the raw material for signals). */
  fileAnalyses: readonly FileAnalysis[];
  /** Type-level signal. */
  typeLevel: Readonly<{ level: "typed" | "untyped" | "mixed"; typedFileFraction: number; typedParameterFraction: number }> | null;
  /** Quality signal. */
  quality: Readonly<{ issueDensity: number; issuesPerKloc: number; totalIssues: number; topCategories: readonly Readonly<{ category: string; count: number }>[] }> | null;
  /** Drift signal. */
  drift: Readonly<{ schemaVersion: string | null; dependencyDrift: number; changedDependencyFiles: readonly string[] }> | null;
  /** Complexity signal. */
  complexity: Readonly<{ mean: number; median: number; p95: number; max: number; hotspotCount: number; distribution: readonly number[]; topFunctions: readonly FunctionRecord[] }> | null;
  /** Architecture signal. */
  architecture: Readonly<{ type: "monolith" | "modular" | "microservices"; hubModules: readonly ModuleRecord[]; edgeCount: number; density: number }> | null;
  /** Clones signal. */
  clones: Readonly<{ familyCount: number; cloneCoverage: number; topFamilies: readonly Readonly<{ representative: string; members: number; avgJaccard: number }>[] }> | null;
  /** Entropy signal. */
  entropy: Readonly<{ shannon: number; renyiSpectrum: readonly Readonly<{ order: number; entropy: number }>[]; tokenCount: number }> | null;
  /** Dependencies signal. */
  dependencies: Readonly<{ circularCount: number; cycles: ReadonlyArray<readonly string[]>; graphDensity: number; missingSymbolCount: number }> | null;
  /** Health signal. */
  health: Readonly<{ todoCount: number; emptyCatchCount: number; magicNumberCount: number; deadExportCount: number; total: number }> | null;
  /** Ebbinghaus debt signal. */
  debt: Readonly<{ totalDebt: number; topDebts: readonly Readonly<{ filePath: string; ageDays: number; debt: number; kind: string }>[] }> | null;
  /** Module-roles signal. */
  moduleRoles: Readonly<{ roles: readonly Readonly<{ role: string; moduleCount: number; functionCount: number }>[] }> | null;
  /** Hotspots signal. */
  hotspots: Readonly<{ topComplex: readonly FunctionRecord[]; topDependedOn: readonly ModuleRecord[] }> | null;
  /** Trending signal. */
  trending: Readonly<{ topRecentFiles: readonly Readonly<{ filePath: string; ageDays: number }>[]; topTrendingModules: readonly ModuleRecord[] }> | null;
  /** Risk signal. */
  risk: Readonly<{ topRisks: readonly Readonly<{ filePath: string; name: string; complexity: number; callCount: number; riskScore: number }>[] }> | null;
  // EXP372 new signals (16).
  /** Bell-inequality clone classification (EXP340). */
  bellClones: Readonly<{ isolatedPairs: number; familyPairs: number; totalPairs: number; bellRatio: number; isolatedFraction: number }> | null;
  /** Banach contraction factor (EXP341). */
  banachContraction: Readonly<{ meanContraction: number; minContraction: number; isContraction: boolean; familyCount: number }> | null;
  /** QEC code distance (EXP346). */
  qecDistance: Readonly<{ meanDistance: number; maxDistance: number; fragileCount: number; protectedCount: number; protectionRatio: number; familyCount: number }> | null;
  /** Algebraic geometry spectrum (EXP347). */
  agSpectrum: Readonly<{ spectrumSize: number; totalRules: number; mostGenericRule: string; reducibleCount: number; familyCount: number }> | null;
  /** Wavelet-packet clone detection (EXP345). */
  waveletClones: Readonly<{ waveletFamilyCount: number; waveletCloneCoverage: number; meanCoeffEnergy: number }> | null;
  /** Ricci curvature (EXP322). */
  ricciCurvature: Readonly<{ meanCurvature: number; minCurvature: number; bridgeCount: number; hubCount: number; edgeCount: number }> | null;
  /** Fiber-bundle non-triviality (EXP321). */
  fiberBundle: Readonly<{ nonTrivial: boolean; meanDivergence: number; maxDivergence: number; topDistinctModule: string; moduleCount: number }> | null;
  /** Topos intuitionistic logic (EXP344). */
  topos: Readonly<{ lemHoldsCount: number; lemFailsCount: number; isIntuitionistic: boolean; failureFraction: number }> | null;
  /** Function stats + Lie hub (EXP306). */
  functionStats: Readonly<{ meanLength: number; medianLength: number; maxLength: number; arityDistribution: readonly number[]; idNumArity: number; idNumHubCount: number; lieCommutativity: number }> | null;
  /** Persistence landscapes (EXP249). */
  persistenceLandscapes: Readonly<{ meanPersistence: number; maxPersistence: number; landscapePeak: number; bettiNumbers: readonly number[] }> | null;
  /** Test coverage proxy. */
  testCoverage: Readonly<{ testFileCount: number; sourceFileCount: number; ratio: number; testLoc: number; sourceLoc: number; testDensity: number }> | null;
  /** Ergodic drift (EXP219). */
  ergodicDrift: Readonly<{ driftVector: readonly number[]; driftMagnitude: number; driftDirection: string; growthRate: number; commitCount: number }> | null;
  /** Quantum decoherence stability (EXP309). */
  quantumStability: Readonly<{ coherenceScore: number; meanCommitSize: number; varianceCommitSize: number; isStable: boolean; commitCount: number }> | null;
  /** Game-of-Life edit predictability (EXP224). */
  editPredictability: Readonly<{ aliveCellCount: number; predictedAliveNext: number; predictability: number; isPredictable: boolean }> | null;
  /** Recursion-theory hierarchy (EXP348). */
  recursionHierarchy: Readonly<{ decidableCount: number; reCount: number; coreCount: number; undecidableCount: number; decidabilityRatio: number }> | null;
  /** Hub stress (EXP14 — scale-free hub fan-in/out). */
  hubStress: Readonly<{ topHubStress: readonly Readonly<{ name: string; inDegree: number; outDegree: number; stressRatio: number }>[]; meanStress: number; hubGini: number; isScaleFree: boolean }> | null;
  // EXP387 new signals (14) — sourced from EXPERIMENTS-SURVEY.md findings.
  /** Thermodynamic free energy F = U - T·S (EXP41/210). */
  thermodynamics: Readonly<{ temperature: number; entropy: number; internalEnergy: number; freeEnergy: number; boltzmannW: number }> | null;
  /** Benford's-law deviation of numeric literals (EXP42). */
  benford: Readonly<{ firstDigitDistribution: readonly number[]; chiSquareDeviation: number; totalNumbers: number; dominantDigit: number }> | null;
  /** Fiedler bisection of module graph (EXP46/248). */
  fiedlerBisection: Readonly<{ fiedlerValue: number; isBottleneck: boolean; bisectionSize: number; topBridgeModule: string; largestEigenvalue: number }> | null;
  /** Homology of clone graph (EXP51/101/190). */
  homology: Readonly<{ h0: number; h1: number; h0Components: number; h1Candidates: number }> | null;
  /** Shape-DNA function clusters (EXP57). */
  shapeDna: Readonly<{ distinctShapes: number; shapeDiversity: number; largestShape: string; largestShapeCount: number; topShapeClones: readonly Readonly<{ shape: string; members: number; example: string }>[] }> | null;
  /** Chromatic number of clone graph (EXP113). */
  chromaticNumber: Readonly<{ chromaticNumber: number; cliqueNumber: number; isPerfectGraph: boolean; topClique: readonly Readonly<{ filePath: string; name: string }>[]; refactorOpportunities: number }> | null;
  /** Martingale-debt drift (EXP323/328). */
  martingaleDebt: Readonly<{ drift: number; isSubMartingale: boolean; driftPValue: number; debtTrajectory: string; variance: number; sampleCount: number }> | null;
  /** Free-probability token coupling (EXP84/320). */
  freeProbability: Readonly<{ coupledPairs: number; freeIndependent: boolean; noncommutingFraction: number; topCoupled: readonly Readonly<{ tokens: string; chiSquare: number; observed: number; expected: number }>[] }> | null;
  /** Maxwell's-demon information-flow efficiency (EXP307/324). */
  maxwellDemon: Readonly<{ meanDemonEfficiency: number; isThermodynamicallyValid: boolean; topDemon: string; topDemonEfficiency: number; totalInformationGain: number }> | null;
  /** Function classification (4-axis: complexity/role/risk) (EXP102). */
  functionClassification: Readonly<{ complexityBuckets: Readonly<{ simple: number; medium: number; complex: number; pathological: number }>; roleBuckets: Readonly<{ utility: number; dataTransform: number; errorHandler: number; validator: number; other: number }>; riskBuckets: Readonly<{ low: number; medium: number; high: number }>; pathologicalFraction: number }> | null;
  /** Linguistic typology (paradigm mix) (EXP223). */
  linguisticTypology: Readonly<{ familyDistribution: Readonly<{ imperative: number; functional: number; declarative: number; async: number }>; dominantFamily: string; multiParadigm: boolean; functionalFraction: number; asyncFraction: number }> | null;
  /** Turing-machine treadmills (files refactored repeatedly) (EXP326). */
  turingTreadmills: Readonly<{ treadmillCount: number; topTreadmills: readonly Readonly<{ filePath: string; editCount: number }>[]; maxTreadmillCount: number; hasActiveTreadmills: boolean }> | null;
  /** Mechanism-design IC ratio (EXP327). */
  mechanismDesign: Readonly<{ icRatio: number; incentiveCompatible: boolean; uncaughtCandidates: number; mechanismStrength: string; familyCount: number }> | null;
  /** Sheaf cohomology (EXP80). */
  sheafCohomology: Readonly<{ h0Dimension: number; h1Obstructions: number; isSheaf: boolean; topUniversalSymbol: string; topSymbolReach: number }> | null;
  // EXP462 new signals (44 more — 10× harder). Grouped by mathematical domain.
  /** AL2 Tierra fitness = complexity × callers (EXP442). */
  al2Fitness: Readonly<{ meanFitness: number; maxFitness: number; topFit: readonly Readonly<{ name: string; fitness: number; complexity: number; callers: number }>[] }> | null;
  /** Le Chatelier churn resistance (EXP442). */
  leChatelier: Readonly<{ meanResistance: number; minResistance: number; unstableModules: number; totalModules: number }> | null;
  /** OBAFGKM temperature classification (EXP442). */
  obafgkm: Readonly<{ oType: number; bType: number; aType: number; fType: number; gType: number; kType: number; mType: number; dominantClass: string }> | null;
  /** Peierls call-chain symmetry (EXP442). */
  peierlsSymmetry: Readonly<{ symmetricChains: number; asymmetricChains: number; symmetryFraction: number; totalChains: number }> | null;
  /** Born-Haber energy conservation (EXP442). */
  bornHaber: Readonly<{ formationEnergy: number; latticeEnergy: number; energyImbalance: number; isConserved: boolean }> | null;
  /** Kolmogorov complexity estimate (EXP462 — compression ratio proxy). */
  kolmogorovComplexity: Readonly<{ meanK: number; minK: number; maxK: number; compressibility: number }> | null;
  /** Rényi entropy of order α (EXP462). */
  renyiEntropy: Readonly<{ order: number; entropy: number; hartleyEntropy: number; shannonEntropy: number; minEntropy: number }> | null;
  /** Tsallis non-extensive entropy (EXP462). */
  tsallisEntropy: Readonly<{ q: number; entropy: number; effectiveStates: number }> | null;
  /** Kullback-Leibler divergence (EXP462 — drift between token distributions). */
  klDivergence: Readonly<{ divergence: number; isSignificant: boolean; sampleSize: number }> | null;
  /** Jensen-Shannon divergence (EXP462 — symmetric drift). */
  jsDivergence: Readonly<{ divergence: number; similarity: number; squareRoot: number }> | null;
  /** Fisher information (EXP462 — sensitivity to parameter change). */
  fisherInformation: Readonly<{ meanFisher: number; maxFisher: number; totalInformation: number }> | null;
  /** Mutual information (EXP462 — module correlation). */
  mutualInformation: Readonly<{ meanMI: number; maxMI: number; coupledPairs: number; totalPairs: number }> | null;
  /** Hartley entropy = log2(alphabet size) (EXP462). */
  hartleyEntropy: Readonly<{ entropy: number; alphabetSize: number; tokenCount: number }> | null;
  /** Betweenness centrality (EXP462 — bridge modules). */
  betweennessCentrality: Readonly<{ topBridges: readonly Readonly<{ name: string; betweenness: number }>[]; meanBetweenness: number; maxBetweenness: number }> | null;
  /** Closeness centrality (EXP462 — central modules). */
  closenessCentrality: Readonly<{ topCentral: readonly Readonly<{ name: string; closeness: number }>[]; meanCloseness: number; maxCloseness: number }> | null;
  /** Eigenvector centrality (EXP462 — influential modules). */
  eigenvectorCentrality: Readonly<{ topInfluential: readonly Readonly<{ name: string; centrality: number }>[]; maxEigenvalue: number; converged: boolean }> | null;
  /** Katz centrality (EXP462 — attenuated reach). */
  katzCentrality: Readonly<{ topReach: readonly Readonly<{ name: string; katz: number }>[]; alpha: number; meanKatz: number }> | null;
  /** Clustering coefficient (EXP462 — triangle density). */
  clusteringCoefficient: Readonly<{ meanClustering: number; globalClustering: number; triangles: number; totalTriples: number }> | null;
  /** Modularity (Louvain) (EXP462 — community structure). */
  modularity: Readonly<{ modularity: number; communityCount: number; largestCommunity: number; totalModules: number }> | null;
  /** Kirchhoff index = sum of effective resistances (EXP462). */
  kirchhoffIndex: Readonly<{ kirchhoffIndex: number; meanResistance: number; maxResistance: number }> | null;
  /** Cheeger constant (EXP462 — bottleneck size). */
  cheegerConstant: Readonly<{ cheeger: number; isExpander: boolean; bottleneckSet: number }> | null;
  /** Spectral gap of graph Laplacian (EXP462). */
  spectralGap: Readonly<{ spectralGap: number; largestEigenvalue: number; gapRatio: number; isExpander: boolean }> | null;
  /** Lovász theta number (EXP462 — Shannon capacity). */
  lovaszTheta: Readonly<{ theta: number; shannonCapacity: number; cliqueNumber: number }> | null;
  /** Girth = shortest cycle length (EXP462). */
  girth: Readonly<{ girth: number; hasCycle: boolean; cycleCount: number }> | null;
  /** Graph diameter = longest shortest path (EXP462). */
  graphDiameter: Readonly<{ diameter: number; radius: number; meanPathLength: number; totalNodes: number }> | null;
  /** Halstead complexity (EXP462 — vocabulary + length). */
  halsteadComplexity: Readonly<{ vocabulary: number; length: number; volume: number; difficulty: number; effort: number }> | null;
  /** Maintainability index (EXP462 — MI formula). */
  maintainabilityIndex: Readonly<{ mi: number; normalizedMi: number; grade: string }> | null;
  /** Cyclomatic debt (EXP462 — complexity debt). */
  cyclomaticDebt: Readonly<{ totalDebt: number; meanDebt: number; maxDebt: number; debtRatio: number }> | null;
  /** LCOM cohesion (EXP462 — lack of cohesion). */
  lcomCohesion: Readonly<{ meanLCOM: number; maxLCOM: number; lowCohesionCount: number; totalClasses: number }> | null;
  /** Coupling — fan-in/fan-out (EXP462). */
  coupling: Readonly<{ meanFanIn: number; meanFanOut: number; maxFanIn: number; maxFanOut: number; totalEdges: number }> | null;
  /** Sørensen-Dice coefficient (EXP462 — clone similarity). */
  sorensenDice: Readonly<{ meanSimilarity: number; maxSimilarity: number; clonePairs: number; totalPairs: number }> | null;
  /** Simpson diversity (EXP462 — module diversity). */
  simpsonDiversity: Readonly<{ simpson: number; dominantShare: number; moduleCount: number }> | null;
  /** Shannon evenness (EXP462 — equality of distribution). */
  shannonEvenness: Readonly<{ evenness: number; shannon: number; maxShannon: number; totalModules: number }> | null;
  /** Gini coefficient (EXP462 — inequality of complexity). */
  giniCoefficient: Readonly<{ gini: number; meanComplexity: number; maxComplexity: number; totalFunctions: number }> | null;
  /** Berger-Parker dominance (EXP462 — dominant module share). */
  bergerParker: Readonly<{ dominance: number; dominantModule: string; dominantShare: number }> | null;
  /** Lagrangian L = T - V (EXP462 — kinetic - potential energy). */
  lagrangian: Readonly<{ kinetic: number; potential: number; lagrangian: number; totalEnergy: number }> | null;
  /** Hamiltonian H = T + V (EXP462 — total energy). */
  hamiltonian: Readonly<{ hamiltonian: number; kinetic: number; potential: number; isConserved: boolean }> | null;
  /** Entropy production (EXP462 — irreversible change). */
  entropyProduction: Readonly<{ production: number; isIrreversible: boolean; commitCount: number; meanEntropyRate: number }> | null;
  /** Free energy F = U - TS (EXP462 — available work). */
  freeEnergy: Readonly<{ freeEnergy: number; internalEnergy: number; temperature: number; entropy: number }> | null;
  /** Pólya enumeration (EXP462 — distinct colorings under symmetry). */
  polyaEnumeration: Readonly<{ distinctColorings: number; symmetryGroupSize: number; totalColorings: number }> | null;
  /** Burnside's lemma (EXP462 — orbits under group action). */
  burnsideLemma: Readonly<{ orbitCount: number; groupOrder: number; meanFixedPoints: number }> | null;
  /** Catalan number (EXP462 — tree/Dyck path count). */
  catalanNumber: Readonly<{ catalan: number; n: number; treeCount: number; dyckPathCount: number }> | null;
  /** Stirling number of the second kind (EXP462 — partitions of a set). */
  stirlingNumber: Readonly<{ stirling: number; n: number; k: number; partitionCount: number }> | null;
  /** Assortativity = degree-correlation (EXP462). */
  assortativity: Readonly<{ assortativity: number; isAssortative: boolean; meanDegree: number }> | null;
  /** Compact block text (filled by compact.ts). */
  compactBlock: string;
  /** Estimated token count of the compact block. */
  compactTokens: number;
  /** Wall-clock time to compute this snapshot (ms). */
  computeTimeMs: number;
  /** Number of files re-analyzed (cache miss) for this snapshot. */
  reanalyzedFiles: number;
  /** Number of files reused from cache. */
  cachedFiles: number;
}>;

/** Schema version (the only hardcoded constant in this module — it identifies the snapshot shape itself). */
export const SNAPSHOT_SCHEMA_VERSION = schemaId("awareness", 1);

/** Context passed to each signal module. */
export type SignalContext = Readonly<{
  config: AwarenessConfig;
  languageConfigs: ReadonlyMap<string, LanguageConfig>;
  fileAnalyses: readonly FileAnalysis[];
  modules: readonly ModuleRecord[];
  rootPath: string;
  /** Git history (commit → changed files) if `useGitHistory` is true and git is available. */
  gitHistory: readonly GitCommit[];
  /** Helper to read a file's content (used by drift/debt; cached). */
  readFile: (filePath: string) => string | null;
  /** Wall-clock start time of the snapshot, for age calculations. */
  nowMs: number;
}>;

/**
 * HOW THE ENGINE ASKS GIT A QUESTION — a port, because the engine must not be
 * the thing that starts a program.
 *
 * ── WHY THIS IS A PORT AND NOT A FUNCTION CALL ────────────────────────────
 *
 * `git` is not an inert reader of files. It executes programs named in the
 * configuration it finds in the repository it is pointed at — `core.fsmonitor`
 * (which fires on `diff-tree`), aliases, `core.pager`, `filter.*.clean` and
 * `.smudge`, and the hooks in `.git/hooks`. The repository here is the
 * USER-SELECTED PROJECT, so those names are chosen by whatever wrote into the
 * project, which includes the model.
 *
 * This engine used to run git itself, through a shell, with no sandbox. That
 * was fine where it was written — the command-line harness confines its whole
 * process at start-up, so anything it spawns inherits the restriction — and it
 * was a live escape the moment a second host imported the engine: the web
 * server runs `compute` in a worker thread of an UNCONFINED process. Measured
 * end to end on git 2.47.3: the project's own `.git/config` named a script,
 * `compute` ran it, and it wrote outside the project and overwrote a file in
 * the harness's protected source tree.
 *
 * The fix is not to neutralise the channels one at a time — that is a list,
 * and the list was already incomplete. It is to stop this module from having
 * the capability at all, so each HOST supplies a runner with the authority
 * that host can honestly grant: the command-line harness supplies a direct one
 * (already inside its own sandbox), and the web server supplies its confined
 * git door. A host that forgets cannot compile, because the runner has no
 * default — a default would be exactly the "fallback source" that makes the
 * dangerous path the quiet one.
 *
 * Returns the child's stdout, or `null` when git could not be run or failed.
 * `null` is a REFUSAL OR A FAILURE, never "no commits" — a caller that needs
 * to tell those apart must not read emptiness as an answer.
 */
export type GitCommandRunner = (
  rootPath: string,
  args: readonly string[],
  timeoutMs: number,
) => string | null;

/** One git commit in the recent history of the codebase. */
export type GitCommit = Readonly<{
  /** Commit hash (short). */
  hash: string;
  /** Author timestamp in ms since epoch. */
  timestampMs: number;
  /** Files changed in this commit (relative paths, forward slashes). */
  changedFiles: readonly string[];
}>;

/** A signal module — a pure function from context to a partial snapshot. */
export type SignalModule<K extends keyof AwarenessSnapshot = keyof AwarenessSnapshot> = Readonly<{
  /** Signal id, matches a toggle in `AwarenessSignalToggles`. */
  id: string;
  /** Compute the signal; returns the partial snapshot value (or null). */
  compute: (ctx: SignalContext) => Partial<Pick<AwarenessSnapshot, K>>;
}>;
