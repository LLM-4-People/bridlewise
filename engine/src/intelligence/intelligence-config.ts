/**
 * Intelligence operational defaults — the SINGLE canonical owner for
 * intelligence-domain configurable values (one source
 * of truth; no hardcoded configurables scattered in source).
 *
 * Every intelligence module that needs a tunable default imports it from
 * here — NEVER re-declares an inline magic number. The values are the
 * floors; call sites accept an `options` override (the caller-provided
 * value wins). `resolveIntelligenceConfig` validates overrides so a bad
 * config cannot silently degrade the intelligence layer (rule: validate
 * bounds at every trust boundary — the lowest-level enforcement).
 *
 * Web research: the single-owner Repository Intelligence Graph
 * pattern (arXiv 2601.10112 "RIG"; codebase-memory-mcp graph-augmented
 * search) confirms ONE canonical owner per intelligence concern. This
 * module is that owner for operational defaults; the web UI's
 * `harness-config.ts::getExp474RetrievalConfig` is the owner for the
 * EXP474 ranking knobs exposed to the web.
 */
import { deepFreeze } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { refuseUnknownKeys } from "../shared/type-guards.ts";

// ── Existing defaults (consumed by file-slice.ts + quick-view.ts) ──
export const DEFAULT_SLICE_CAP_LINES = 150;
export const DEFAULT_CLONE_JACCARD = 0.9;
export const DEFAULT_MIN_TOKENS = 30;
export const DEFAULT_CONTEXT_RADIUS = 0;
export const DEFAULT_DOC_TEXT_SLICE = 120;
export const DEFAULT_VIEWPORT_MAX_LINES = 200;
export const DEFAULT_SHINGLE_K = 6;
export const DEFAULT_DOC_MIN_NAME_LENGTH = 3;
export const DEFAULT_MIN_BODY = 80;

// ── Consolidated defaults (R43: previously scattered inline magic numbers) ──
// Each was a hardcoded literal in a consumer module; moved here so the
// single owner holds every intelligence default. The
// mechanical test (integration-intelligence-owner.test.ts) pins that the
// consumers import from here, not re-declare inline.

/** Default symbol-search result limit (`createSymbolSearchQuery`). */
export const DEFAULT_SEARCH_LIMIT = 50;
/** Default reuse-discovery result limit (`createReuseQuery`). */
export const DEFAULT_REUSE_LIMIT = 20;
/** Repository-walk skip threshold: files larger than this are not analyzed
 * (`generateRepositoryMap` maxFileBytes floor). Module-private — the public
 * accessor is `resolveIntelligenceConfig.maxFileBytes`. */
const DEFAULT_MAX_FILE_BYTES = 1_048_576;
/** Hard upper bound on a single source string passed to the symbol
 * extractor (`extractSymbols` oversized guard). Distinct from
 * `DEFAULT_MAX_FILE_BYTES` (the walk skip threshold) — the extractor
 * guards against a caller streaming an oversized blob directly. */
export const DEFAULT_SOURCE_ANALYSIS_LIMIT = 10_485_760;
/** Repository-walk maximum directory depth (`DEFAULT_READ_LIMITS`). */
export const DEFAULT_REPOSITORY_MAX_DEPTH = 32;
/** Repository-walk maximum file-entry count (`DEFAULT_READ_LIMITS`). */
export const DEFAULT_REPOSITORY_MAX_ENTRIES = 50_000;
/** The MAIN-THREAD stat-walk door: the largest previous-scan size (cached
 * stat entries) for which the no-change TTL refresh's stat walk may run on
 * the request thread. Above it the refresh takes the repository-map worker
 * (the walk is O(tree) syscalls — the exact case the worker exists for).
 * Distinct from `DEFAULT_REPOSITORY_MAX_ENTRIES` (the SCAN bound every walk
 * enforces): this is the DOOR bound for one walk's placement, a smaller
 * default because the main thread is the request path, not a worker.
 * Module-private — the public accessor is
 * `resolveIntelligenceConfig().mainThreadStatWalkMaxEntries`. */
const DEFAULT_MAIN_THREAD_STAT_WALK_MAX_ENTRIES = 20_000;
/** Default data-flow trace depth (`traceValueFlow` maxDepth floor). */
export const DEFAULT_DATA_FLOW_MAX_DEPTH = 3;
/** Default next-edit-prediction cap (`predictNextEdits` maxPredictions). */
export const DEFAULT_NEXT_EDIT_MAX_PREDICTIONS = 20;
/** Default next-edit prefetch file cap (`pickPrefetchFiles` maxFiles). */
export const DEFAULT_NEXT_EDIT_MAX_FILES = 10;
/** Minimum in-degree for a node to count as a hub (`graphStats`). */
export const DEFAULT_HUB_NODE_MIN_IN_DEGREE = 3;
/** C/C++ include-path parent-directory search depth
 * (`candidatesForLanguage` c/cpp branch). */
export const DEFAULT_INCLUDE_SEARCH_DEPTH = 3;
/** Ambiguous-slice candidate option cap (`FileSliceIndex.slice` options
 * list + `findCallers` caller list). */
export const DEFAULT_FILE_SLICE_OPTIONS_LIMIT = 10;
/** Max callees emitted per skeleton declaration (`calleesOf`). */
export const DEFAULT_FILE_SLICE_CALLEES_LIMIT = 5;
/** Source directories scanned by `FileSliceIndex` when no file hint is given
 * and by `QuickViewIndex` for the source-file partition. Single owner
 *; overridable via
 * the index options. */
export const DEFAULT_SOURCE_DIRECTORIES: readonly string[] = deepFreeze(["src"]);
/** Test directories scanned by `QuickViewIndex` for the test-file partition. */
export const DEFAULT_TEST_DIRECTORIES: readonly string[] = deepFreeze(["test"]);
/** Directories `FileSliceIndex` scans when no file hint is given — the union
 * of source + test (file-slice does not partition the two). */
export const DEFAULT_SCAN_DIRECTORIES: readonly string[] = deepFreeze([
  ...DEFAULT_SOURCE_DIRECTORIES,
  ...DEFAULT_TEST_DIRECTORIES,
]);
/** Documentation directories scanned by `QuickViewIndex` for doc mentions.
 * Single owner; overridable via `QuickViewIndexOptions.docDirectories`. */
export const DEFAULT_DOC_DIRECTORIES: readonly string[] = deepFreeze(["docs"]);
/** EXP474 lexical-score overlap-bonus cap (`Math.min(cap, overlap * per)`).
 * Owned here so retrieval.ts carries NO hardcoded configurables of
 * its own (its header claims this; R43 makes it true). */
export const DEFAULT_EXP474_LEXICAL_OVERLAP_CAP = 0.3;
/** EXP474 lexical-score per-overlap-word weight. */
export const DEFAULT_EXP474_LEXICAL_PER_WORD = 0.05;
/** EXP474 singularization minimum word length (`singular`). */
export const DEFAULT_EXP474_SINGULAR_MIN_LENGTH = 4;
/** EXP474 class-match minimum query-word length (`classMatch`). */
export const DEFAULT_EXP474_CLASS_MATCH_MIN_LENGTH = 3;

// ── Hybrid symbol-search defaults (BM25 + fuzzy) ──
// The hybrid ranker arrived with these as an inline `DEFAULT_HYBRID_OPTIONS`
// object literal inside `symbol-search.ts`. They are operator-tunable ranking
// knobs, so they belong to this owner like every other intelligence default —
// NOT to a second `*-config.ts` beside it. `symbol-search.ts` reads them from
// here and re-declares none of them.

/** BM25 term-frequency saturation (`k1`). Above ~1.2 repeated terms keep
 * adding score; below it they saturate faster. */
const DEFAULT_BM25_K1 = 1.2;
/** BM25 length normalization (`b`). 0 disables length normalization, 1
 * fully normalizes by document length. */
const DEFAULT_BM25_B = 0.75;
/** Baseline weight on the BM25 component of the hybrid score. The query
 * classifier moves this between the floor and the ceiling below. */
const DEFAULT_HYBRID_BM25_WEIGHT = 0.6;
/** Minimum BM25 weight applied to a query classified "specific". A specific
 * query names a real identifier, so exact term evidence should dominate. */
const DEFAULT_HYBRID_SPECIFIC_BM25_WEIGHT_FLOOR = 0.7;
/** Maximum BM25 weight applied to a query classified "vague". A vague query
 * has little term evidence, so fuzzy subsequence matching should dominate. */
const DEFAULT_HYBRID_VAGUE_BM25_WEIGHT_CEILING = 0.4;
/** Top-directory share above which a result set is reported as biased. */
const DEFAULT_SEARCH_BIAS_DIRECTORY_THRESHOLD = 0.6;
/** Minimum results before bias is computed at all. Below this the top-
 * directory share is dominated by sample size, not by real concentration. */
const DEFAULT_SEARCH_BIAS_MIN_RESULTS = 3;
/** Instant-seal: top-1 must exceed top-2 by this ratio to signal confidence. */
const DEFAULT_SEARCH_SEAL_RATIO = 1.8;
/** Instant-seal: top-1 must also clear this absolute score. */
const DEFAULT_SEARCH_SEAL_MIN_SCORE = 0.5;

// ── Crash-isolated extract farm (lab process-farm.ts, landed) ───────────
// Native/WASM grammar traps share the process with worker_threads and
// kill HTTP. Child processes do not. These are the farm's tunables; the
// farm is the one door (`runIsolatedProcess`).

/** Per-file parse watchdog (main run). */
export const DEFAULT_FARM_PER_FILE_TIMEOUT_MS = 15_000;
/** Per-file timeout for the victim-retry pass. */
export const DEFAULT_FARM_RETRY_TIMEOUT_MS = 3_000;
/** How long the farm waits for a child to announce "ready". */
export const DEFAULT_FARM_INIT_TIMEOUT_MS = 2_000;
/** Files per IPC batch. */
export const DEFAULT_FARM_IPC_BATCH = 25;
/** Grace after SIGTERM before SIGKILL. */
export const DEFAULT_FARM_KILL_ESCALATION_MS = 1_000;
/** Consecutive init failures before a loop stops respawning. */
export const DEFAULT_FARM_MAX_INIT_FAILURES = 8;

/**
 * The resolved intelligence configuration — every operational default in
 * one validated object. Call sites that need the full set (rather than a
 * single `DEFAULT_*` floor) read through `resolveIntelligenceConfig`.
 */
export type IntelligenceConfig = Readonly<{
  sliceCapLines: number;
  cloneJaccard: number;
  minTokens: number;
  contextRadius: number;
  docTextSlice: number;
  viewportMaxLines: number;
  shingleK: number;
  docMinNameLength: number;
  minBody: number;
  searchDefaultLimit: number;
  reuseDefaultLimit: number;
  maxFileBytes: number;
  sourceAnalysisLimit: number;
  repositoryMaxDepth: number;
  repositoryMaxEntries: number;
  mainThreadStatWalkMaxEntries: number;
  dataFlowMaxDepth: number;
  nextEditMaxPredictions: number;
  nextEditMaxFiles: number;
  hubNodeMinInDegree: number;
  includeSearchDepth: number;
  fileSliceOptionsLimit: number;
  fileSliceCalleesLimit: number;
  sourceDirectories: readonly string[];
  testDirectories: readonly string[];
  docDirectories: readonly string[];
  exp474LexicalOverlapCap: number;
  exp474LexicalPerWord: number;
  exp474SingularMinLength: number;
  exp474ClassMatchMinLength: number;
  bm25K1: number;
  bm25B: number;
  hybridBm25Weight: number;
  hybridSpecificBm25WeightFloor: number;
  hybridVagueBm25WeightCeiling: number;
  searchBiasDirectoryThreshold: number;
  searchBiasMinResults: number;
  searchSealRatio: number;
  searchSealMinScore: number;
}>;

/** The frozen default configuration (the floors every override merges onto).
 * Module-private — `resolveIntelligenceConfig` is the public accessor. */
const DEFAULT_INTELLIGENCE_CONFIG: IntelligenceConfig = deepFreeze({
  sliceCapLines: DEFAULT_SLICE_CAP_LINES,
  cloneJaccard: DEFAULT_CLONE_JACCARD,
  minTokens: DEFAULT_MIN_TOKENS,
  contextRadius: DEFAULT_CONTEXT_RADIUS,
  docTextSlice: DEFAULT_DOC_TEXT_SLICE,
  viewportMaxLines: DEFAULT_VIEWPORT_MAX_LINES,
  shingleK: DEFAULT_SHINGLE_K,
  docMinNameLength: DEFAULT_DOC_MIN_NAME_LENGTH,
  minBody: DEFAULT_MIN_BODY,
  searchDefaultLimit: DEFAULT_SEARCH_LIMIT,
  reuseDefaultLimit: DEFAULT_REUSE_LIMIT,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  sourceAnalysisLimit: DEFAULT_SOURCE_ANALYSIS_LIMIT,
  repositoryMaxDepth: DEFAULT_REPOSITORY_MAX_DEPTH,
  repositoryMaxEntries: DEFAULT_REPOSITORY_MAX_ENTRIES,
  mainThreadStatWalkMaxEntries: DEFAULT_MAIN_THREAD_STAT_WALK_MAX_ENTRIES,
  dataFlowMaxDepth: DEFAULT_DATA_FLOW_MAX_DEPTH,
  nextEditMaxPredictions: DEFAULT_NEXT_EDIT_MAX_PREDICTIONS,
  nextEditMaxFiles: DEFAULT_NEXT_EDIT_MAX_FILES,
  hubNodeMinInDegree: DEFAULT_HUB_NODE_MIN_IN_DEGREE,
  includeSearchDepth: DEFAULT_INCLUDE_SEARCH_DEPTH,
  fileSliceOptionsLimit: DEFAULT_FILE_SLICE_OPTIONS_LIMIT,
  fileSliceCalleesLimit: DEFAULT_FILE_SLICE_CALLEES_LIMIT,
  sourceDirectories: DEFAULT_SOURCE_DIRECTORIES,
  testDirectories: DEFAULT_TEST_DIRECTORIES,
  docDirectories: DEFAULT_DOC_DIRECTORIES,
  exp474LexicalOverlapCap: DEFAULT_EXP474_LEXICAL_OVERLAP_CAP,
  exp474LexicalPerWord: DEFAULT_EXP474_LEXICAL_PER_WORD,
  exp474SingularMinLength: DEFAULT_EXP474_SINGULAR_MIN_LENGTH,
  exp474ClassMatchMinLength: DEFAULT_EXP474_CLASS_MATCH_MIN_LENGTH,
  bm25K1: DEFAULT_BM25_K1,
  bm25B: DEFAULT_BM25_B,
  hybridBm25Weight: DEFAULT_HYBRID_BM25_WEIGHT,
  hybridSpecificBm25WeightFloor: DEFAULT_HYBRID_SPECIFIC_BM25_WEIGHT_FLOOR,
  hybridVagueBm25WeightCeiling: DEFAULT_HYBRID_VAGUE_BM25_WEIGHT_CEILING,
  searchBiasDirectoryThreshold: DEFAULT_SEARCH_BIAS_DIRECTORY_THRESHOLD,
  searchBiasMinResults: DEFAULT_SEARCH_BIAS_MIN_RESULTS,
  searchSealRatio: DEFAULT_SEARCH_SEAL_RATIO,
  searchSealMinScore: DEFAULT_SEARCH_SEAL_MIN_SCORE,
});

/**
 * Every name this layer answers to — derived from the defaults, so the list
 * cannot fall behind the settings it describes.
 *
 * Exported because the config document's schema needs it. Without it the
 * `codeIntelligence.retrieval` section had to be declared as a loose numeric
 * map, which accepted any key at all: a misspelled knob validated at the
 * write gate, was dropped by the reader that forwards only known names, and
 * so was accepted everywhere and applied nowhere. The schema now spells the
 * same names this module does, and it spells them by asking.
 */
export const INTELLIGENCE_SETTING_NAMES: readonly string[] =
  deepFreeze(Object.keys(DEFAULT_INTELLIGENCE_CONFIG).sort());

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InputError(`${name} must be a finite non-negative number`, "intelligence_config_invalid");
  }
  return value;
}

/**
 * A ranking weight or share that is only meaningful inside 0..1. The hybrid
 * ranker derives `fuzzyWeight = 1 - bm25Weight`, so a bm25 weight outside
 * this interval silently produces a NEGATIVE fuzzy weight and inverts the
 * ranking instead of failing. Rejecting it here — at the one door every
 * caller passes through — makes that state unreachable rather than merely
 * discouraged.
 */
function unitInterval(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new InputError(`${name} must be a finite number between 0 and 1`, "intelligence_config_invalid");
  }
  return value;
}

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new InputError(`${name} must be a positive finite integer`, "intelligence_config_invalid");
  }
  return value;
}

/**
 * Resolve the intelligence configuration by merging caller overrides onto
 * the frozen defaults, validating every numeric bound (rule: validate at
 * the trust boundary — the lowest-level enforcement). A bad override
 * throws a typed `InputError` instead of silently degrading the layer.
 */
export function resolveIntelligenceConfig(
  overrides: Partial<IntelligenceConfig> = {},
): IntelligenceConfig {
  const base = DEFAULT_INTELLIGENCE_CONFIG;
  // An override this resolver does not know is REFUSED, not dropped.
  //
  // The merge below reads a fixed key list, so a misspelling used to fall
  // through every layer without a word: the config schema accepts the
  // retrieval knobs as a loose numeric map, so `bm25k1` validates; the web
  // reader forwards only the names it knows, so it never arrives; and this
  // resolver reads only `bm25K1`, so the default applies. Acceptance at every
  // step and effect at none — an operator's setting that reads as applied and
  // is not. The type system cannot catch it either, because the value crosses
  // from JSON as `Partial<IntelligenceConfig>` by assertion.
  //
  // This is the last place that can still tell, so it is the place that tells.
  refuseUnknownKeys(overrides, base, "intelligence", "intelligence_config_unknown_key");
  const merge = <K extends keyof IntelligenceConfig>(key: K): IntelligenceConfig[K] => {
    const v = overrides[key];
    return v === undefined ? base[key] : v;
  };
  return deepFreeze({
    sliceCapLines: positiveInt(merge("sliceCapLines"), "sliceCapLines"),
    cloneJaccard: finiteNonNegative(merge("cloneJaccard"), "cloneJaccard"),
    minTokens: positiveInt(merge("minTokens"), "minTokens"),
    contextRadius: finiteNonNegative(merge("contextRadius"), "contextRadius"),
    docTextSlice: positiveInt(merge("docTextSlice"), "docTextSlice"),
    viewportMaxLines: positiveInt(merge("viewportMaxLines"), "viewportMaxLines"),
    shingleK: positiveInt(merge("shingleK"), "shingleK"),
    docMinNameLength: positiveInt(merge("docMinNameLength"), "docMinNameLength"),
    minBody: positiveInt(merge("minBody"), "minBody"),
    searchDefaultLimit: positiveInt(merge("searchDefaultLimit"), "searchDefaultLimit"),
    reuseDefaultLimit: positiveInt(merge("reuseDefaultLimit"), "reuseDefaultLimit"),
    maxFileBytes: positiveInt(merge("maxFileBytes"), "maxFileBytes"),
    sourceAnalysisLimit: positiveInt(merge("sourceAnalysisLimit"), "sourceAnalysisLimit"),
    repositoryMaxDepth: positiveInt(merge("repositoryMaxDepth"), "repositoryMaxDepth"),
    repositoryMaxEntries: positiveInt(merge("repositoryMaxEntries"), "repositoryMaxEntries"),
    mainThreadStatWalkMaxEntries: positiveInt(merge("mainThreadStatWalkMaxEntries"), "mainThreadStatWalkMaxEntries"),
    dataFlowMaxDepth: positiveInt(merge("dataFlowMaxDepth"), "dataFlowMaxDepth"),
    nextEditMaxPredictions: positiveInt(merge("nextEditMaxPredictions"), "nextEditMaxPredictions"),
    nextEditMaxFiles: positiveInt(merge("nextEditMaxFiles"), "nextEditMaxFiles"),
    hubNodeMinInDegree: positiveInt(merge("hubNodeMinInDegree"), "hubNodeMinInDegree"),
    includeSearchDepth: positiveInt(merge("includeSearchDepth"), "includeSearchDepth"),
    fileSliceOptionsLimit: positiveInt(merge("fileSliceOptionsLimit"), "fileSliceOptionsLimit"),
    fileSliceCalleesLimit: positiveInt(merge("fileSliceCalleesLimit"), "fileSliceCalleesLimit"),
    sourceDirectories: deepFreeze([...merge("sourceDirectories")]),
    testDirectories: deepFreeze([...merge("testDirectories")]),
    docDirectories: deepFreeze([...merge("docDirectories")]),
    exp474LexicalOverlapCap: finiteNonNegative(merge("exp474LexicalOverlapCap"), "exp474LexicalOverlapCap"),
    exp474LexicalPerWord: finiteNonNegative(merge("exp474LexicalPerWord"), "exp474LexicalPerWord"),
    exp474SingularMinLength: positiveInt(merge("exp474SingularMinLength"), "exp474SingularMinLength"),
    exp474ClassMatchMinLength: positiveInt(merge("exp474ClassMatchMinLength"), "exp474ClassMatchMinLength"),
    bm25K1: finiteNonNegative(merge("bm25K1"), "bm25K1"),
    bm25B: unitInterval(merge("bm25B"), "bm25B"),
    hybridBm25Weight: unitInterval(merge("hybridBm25Weight"), "hybridBm25Weight"),
    hybridSpecificBm25WeightFloor: unitInterval(merge("hybridSpecificBm25WeightFloor"), "hybridSpecificBm25WeightFloor"),
    hybridVagueBm25WeightCeiling: unitInterval(merge("hybridVagueBm25WeightCeiling"), "hybridVagueBm25WeightCeiling"),
    searchBiasDirectoryThreshold: unitInterval(merge("searchBiasDirectoryThreshold"), "searchBiasDirectoryThreshold"),
    searchBiasMinResults: positiveInt(merge("searchBiasMinResults"), "searchBiasMinResults"),
    searchSealRatio: finiteNonNegative(merge("searchSealRatio"), "searchSealRatio"),
    searchSealMinScore: finiteNonNegative(merge("searchSealMinScore"), "searchSealMinScore"),
  });
}
