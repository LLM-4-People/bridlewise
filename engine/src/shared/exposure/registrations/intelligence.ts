/**
 * Shared exposure registrations — `intelligence` module.
 *
 * Code-intelligence knobs already live in `codeIntelligence` (schema +
 * `harness-config.ts` accessors). They were not on the settings surface
 * because no registration file published them. This file is that
 * publication: each control binds DIRECTLY to the config path the live
 * consumer already reads, so a settings change persists and takes effect
 * the next time that accessor runs. No in-memory stub.
 *
 * Farm timeouts are the same class: `runIsolatedProcess` already accepts
 * them as options; the map worker now passes the config values through.
 *
 * Map-cache signals and the drop-cache action read through an installable
 * source the web intelligence bridge owns. With no source (engine tests,
 * a process that has not booted the bridge) the honest reading is zero
 * maps cached — absence, never a fabricated count.
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  readBooleanCustomization,
  readNumberCustomization,
  writeConfigCustomization,
} from "../index.ts";
import { getTreeSitterLanguages } from "../../../intelligence/language-registry.ts";

const DEFAULTS = {
  autoIndexOnProjectAdd: true,
  watchIndexedProjects: true,
  indexWatchDebounceMs: 400,
  indexPollMs: 1500,
  indexTimeoutMs: 120_000,
  mapCacheTtlMs: 60_000,
  quickViewCacheTtlMs: 60_000,
  searchDefaultLimit: 50,
  searchMaxLimit: 500,
  retrieveDefaultLimit: 15,
  retrieveMaxLimit: 100,
  repoMapLanguagePreview: 6,
  autoHealEnabled: true,
  staleFullCoverageThreshold: 200,
  staleSampleFloor: 32,
  staleSampleCeiling: 256,
  farmPerFileTimeoutMs: 15_000,
  farmInitTimeoutMs: 2_000,
  farmMaxInitFailures: 8,
  classBoost: 0.15,
  basenameBoost: 0.1,
  pathSegBoost: 0.1,
  phraseBoost: 0.25,
  stage1K: 8,
  finalK: 15,
  importSlots: 4,
  reverseSlots: 1,
  packageSlots: 2,
  stage1CoreK: 4,
  phraseMaxFiles: 5,
  basenameMaxFiles: 3,
  pathSegMaxFiles: 10,
  minBasenameLength: 4,
  minPathSegLength: 5,
  minQueryWordLength: 3,
  packageMinDirHits: 2,
  importSemanticFloor: 0.3,
  importClassMultiplier: 0.5,
  bm25K1: 1.2,
  bm25B: 0.75,
  hybridBm25Weight: 0.6,
  hybridSpecificBm25WeightFloor: 0.7,
  hybridVagueBm25WeightCeiling: 0.4,
  searchBiasDirectoryThreshold: 0.6,
  searchBiasMinResults: 3,
  searchSealRatio: 1.8,
  searchSealMinScore: 0.5,
} as const;

export type IntelligenceMapCacheState = Readonly<{
  cachedProjects: number;
  lastFileCount: number;
  lastSymbolCount: number;
}>;

export type IntelligenceMapCacheStateSource = () => IntelligenceMapCacheState;
export type IntelligenceMapCacheInvalidate = () => number;

let mapCacheStateSource: IntelligenceMapCacheStateSource | null = null;
let mapCacheInvalidate: IntelligenceMapCacheInvalidate | null = null;

/** Install the live map-cache readings (the web intelligence bridge). */
export function installIntelligenceMapCacheSource(source: IntelligenceMapCacheStateSource): void {
  mapCacheStateSource = source;
}

/** Install the live drop-cache function (the web intelligence bridge). */
export function installIntelligenceMapCacheInvalidate(fn: IntelligenceMapCacheInvalidate): void {
  mapCacheInvalidate = fn;
}

/** Remove the live map-cache source (test/reset hook). */
export function clearIntelligenceMapCacheSource(): void {
  mapCacheStateSource = null;
  mapCacheInvalidate = null;
}

function mapCacheState(): IntelligenceMapCacheState {
  return mapCacheStateSource?.() ?? { cachedProjects: 0, lastFileCount: 0, lastSymbolCount: 0 };
}

function registerIntelNum(spec: {
  id: string;
  name: string;
  description: string;
  configPath: string;
  default: number;
  min: number;
  max: number;
  unit?: string;
  effect?: "immediate" | "next-run";
}): void {
  registerCustomization({
    id: spec.id,
    module: "intelligence",
    name: spec.name,
    description: spec.description,
    type: "number",
    default: spec.default,
    min: spec.min,
    max: spec.max,
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
    current: () => readNumberCustomization(spec.configPath, spec.default),
    set: (v) => writeConfigCustomization(spec.configPath, v),
    contract: { effect: spec.effect ?? "immediate" },
    configPath: spec.configPath,
  });
}

function registerBool(spec: {
  id: string;
  name: string;
  description: string;
  configPath: string;
  default: boolean;
}): void {
  registerCustomization({
    id: spec.id,
    module: "intelligence",
    name: spec.name,
    description: spec.description,
    type: "boolean",
    default: spec.default,
    current: () => readBooleanCustomization(spec.configPath, spec.default),
    set: (v) => writeConfigCustomization(spec.configPath, v),
    contract: { effect: "immediate" },
    configPath: spec.configPath,
  });
}

let intelligenceRegistered = false;
export function registerIntelligenceExposure(): void {
  if (intelligenceRegistered) return;
  intelligenceRegistered = true;

  registerExposureModule({
    id: "intelligence",
    title: "How the assistant finds code in this project",
    purpose:
      "When the project map is built, how long a parse may run, how many search hits come back, and when a stale index is rebuilt.",
  });

  registerSignal({
    id: "intelligence.cachedProjects",
    module: "intelligence",
    name: "Cached Project Maps",
    description: "How many finished project maps this process is currently holding in memory.",
    type: "gauge",
    unit: "count",
    value: () => mapCacheState().cachedProjects,
  });
  registerSignal({
    id: "intelligence.lastMapFiles",
    module: "intelligence",
    name: "Files In Newest Map",
    description: "How many source files the most recently finished project map listed.",
    type: "gauge",
    unit: "files",
    value: () => mapCacheState().lastFileCount,
  });
  registerSignal({
    id: "intelligence.lastMapSymbols",
    module: "intelligence",
    name: "Symbols In Newest Map",
    description: "How many named symbols the most recently finished project map extracted.",
    type: "gauge",
    unit: "count",
    value: () => mapCacheState().lastSymbolCount,
  });
  registerSignal({
    id: "intelligence.treeSitterLanguages",
    module: "intelligence",
    name: "Languages The Map Can Parse",
    description:
      "How many programming languages the project map extracts with tree-sitter. Derived from the language registry, not a counter someone typed.",
    type: "gauge",
    unit: "count",
    value: () => getTreeSitterLanguages().length,
  });

  registerAction({
    id: "intelligence.dropCachedMaps",
    module: "intelligence",
    name: "Drop Cached Project Maps",
    description:
      "Forget every finished project map this process is holding so the next ask rebuilds from disk.",
    execute: () => {
      if (mapCacheInvalidate === null) {
        return { dropped: 0, available: false };
      }
      return { dropped: mapCacheInvalidate(), available: true };
    },
  });

  registerBool({
    id: "intelligence.autoIndexOnProjectAdd",
    name: "Build the project map when a folder is added",
    description:
      "When on, adding a project starts mapping its source files immediately so search and reuse have something to read. When off, the map waits until something asks for it.",
    configPath: "codeIntelligence.autoIndexOnProjectAdd",
    default: DEFAULTS.autoIndexOnProjectAdd,
  });
  registerBool({
    id: "intelligence.watchIndexedProjects",
    name: "Refresh the map when files change on disk",
    description:
      "When on, a finished project map watches that folder so an edit made outside this app still starts a fresh reading. When off, only this app's own editor writes and the re-read button refresh the map.",
    configPath: "codeIntelligence.watchIndexedProjects",
    default: DEFAULTS.watchIndexedProjects,
  });
  registerIntelNum({
    id: "intelligence.indexWatchDebounceMs",
    name: "Wait this long after a disk change before re-reading",
    description:
      "Folder-watch events are coalesced for this many milliseconds so a burst of saves becomes one map pass instead of one per file.",
    configPath: "codeIntelligence.indexWatchDebounceMs",
    default: DEFAULTS.indexWatchDebounceMs,
    min: 50,
    max: 60_000,
    unit: "milliseconds",
  });
  registerIntelNum({
    id: "intelligence.indexPollMs",
    name: "How often to check whether mapping is finished",
    description:
      "While a project map is building, the interface asks again this many milliseconds later. Shorter feels snappier and costs more wake-ups; longer is quieter.",
    configPath: "codeIntelligence.indexPollMs",
    default: DEFAULTS.indexPollMs,
    min: 100,
    max: 60_000,
    unit: "milliseconds",
  });
  registerIntelNum({
    id: "intelligence.indexTimeoutMs",
    name: "Give up waiting for a project map after",
    description:
      "If mapping a project has not finished after this many milliseconds, the wait ends so the interface is not stuck on a hung parse.",
    configPath: "codeIntelligence.indexTimeoutMs",
    default: DEFAULTS.indexTimeoutMs,
    min: 1_000,
    max: 600_000,
    unit: "milliseconds",
  });
  registerIntelNum({
    id: "intelligence.mapCacheTtlMs",
    name: "How long a finished project map stays reused",
    description:
      "A mapped project is served from cache for this many milliseconds. Shorter rebuilds more often (fresher, slower); longer reuses a map that may miss recent edits.",
    configPath: "codeIntelligence.mapCacheTtlMs",
    default: DEFAULTS.mapCacheTtlMs,
    min: 1_000,
    max: 3_600_000,
    unit: "milliseconds",
  });
  registerIntelNum({
    id: "intelligence.quickViewCacheTtlMs",
    name: "How long a file overview stays reused",
    description:
      "A file's quick overview is served from cache for this many milliseconds. Shorter costs more parsing; longer can show an overview that predates the last edit.",
    configPath: "codeIntelligence.quickViewCacheTtlMs",
    default: DEFAULTS.quickViewCacheTtlMs,
    min: 1_000,
    max: 3_600_000,
    unit: "milliseconds",
  });
  registerIntelNum({
    id: "intelligence.searchDefaultLimit",
    name: "Default number of symbol search hits",
    description:
      "When a search does not say how many hits it wants, this many come back. Raising it shows more candidates and costs more ranking work.",
    configPath: "codeIntelligence.searchDefaultLimit",
    default: DEFAULTS.searchDefaultLimit,
    min: 1,
    max: 500,
    unit: "results",
  });
  registerIntelNum({
    id: "intelligence.searchMaxLimit",
    name: "Hard ceiling on symbol search hits",
    description:
      "A search cannot ask for more hits than this, even if the caller names a larger number. Raising it lets a wide query dump more of the index.",
    configPath: "codeIntelligence.searchMaxLimit",
    default: DEFAULTS.searchMaxLimit,
    min: 1,
    max: 5_000,
    unit: "results",
  });
  registerIntelNum({
    id: "intelligence.retrieveDefaultLimit",
    name: "Default number of files pulled for a task",
    description:
      "When a file-retrieval request does not say how many files it wants, this many are returned. Raising it feeds more of the tree into the next step.",
    configPath: "codeIntelligence.retrieveDefaultLimit",
    default: DEFAULTS.retrieveDefaultLimit,
    min: 1,
    max: 100,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.retrieveMaxLimit",
    name: "Hard ceiling on files pulled for a task",
    description:
      "A file-retrieval request cannot ask for more files than this. Raising it lets a broad task pull a larger slice of the tree.",
    configPath: "codeIntelligence.retrieveMaxLimit",
    default: DEFAULTS.retrieveMaxLimit,
    min: 1,
    max: 500,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.repoMapLanguagePreview",
    name: "Languages listed in the map preview",
    description:
      "The project-map prompt names this many languages with file counts and omits the rest, so the preview stays short. Raising it shows a fuller mix and spends more prompt space.",
    configPath: "codeIntelligence.repoMapLanguagePreview",
    default: DEFAULTS.repoMapLanguagePreview,
    min: 1,
    max: 40,
    unit: "languages",
  });
  registerBool({
    id: "intelligence.autoHealEnabled",
    name: "Rebuild a stale project map automatically",
    description:
      "When on, a map whose files have moved on disk is rebuilt without waiting for a manual refresh. When off, a stale map is served until something asks again.",
    configPath: "codeIntelligence.autoHeal.enabled",
    default: DEFAULTS.autoHealEnabled,
  });
  registerIntelNum({
    id: "intelligence.staleFullCoverageThreshold",
    name: "Check every file for staleness below this size",
    description:
      "Projects with this many source files or fewer have every file checked for a stale map. Larger trees sample instead, so the check stays bounded.",
    configPath: "codeIntelligence.autoHeal.staleFullCoverageThreshold",
    default: DEFAULTS.staleFullCoverageThreshold,
    min: 1,
    max: 10_000,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.staleSampleFloor",
    name: "Fewest files sampled on a large tree",
    description:
      "On a project larger than the full-coverage cutoff, at least this many files are checked for a stale map. Raising it catches more drift and costs more disk stats.",
    configPath: "codeIntelligence.autoHeal.staleSampleFloor",
    default: DEFAULTS.staleSampleFloor,
    min: 1,
    max: 10_000,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.staleSampleCeiling",
    name: "Most files sampled on a large tree",
    description:
      "On a very large project, at most this many files are checked for a stale map, so the check cannot grow with the tree. Lowering it is cheaper and can miss a changed file.",
    configPath: "codeIntelligence.autoHeal.staleSampleCeiling",
    default: DEFAULTS.staleSampleCeiling,
    min: 1,
    max: 10_000,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.farmPerFileTimeoutMs",
    name: "Abandon a hung file parse after",
    description:
      "A child that is still parsing one file after this many milliseconds is killed and replaced, so a hang cannot stall the whole map. Takes effect the next time a map is built.",
    configPath: "codeIntelligence.farm.perFileTimeoutMs",
    default: DEFAULTS.farmPerFileTimeoutMs,
    min: 100,
    max: 120_000,
    unit: "milliseconds",
    effect: "next-run",
  });
  registerIntelNum({
    id: "intelligence.farmInitTimeoutMs",
    name: "Abandon a parse child that never becomes ready after",
    description:
      "A newly spawned parse child that does not announce ready in this many milliseconds is treated as a failed start. Takes effect the next time a map is built.",
    configPath: "codeIntelligence.farm.initTimeoutMs",
    default: DEFAULTS.farmInitTimeoutMs,
    min: 100,
    max: 60_000,
    unit: "milliseconds",
    effect: "next-run",
  });
  registerIntelNum({
    id: "intelligence.farmMaxInitFailures",
    name: "Stop respawning a parse child after this many failed starts",
    description:
      "After this many consecutive failed starts, remaining files are marked crashed instead of forking forever. Takes effect the next time a map is built.",
    configPath: "codeIntelligence.farm.maxInitFailures",
    default: DEFAULTS.farmMaxInitFailures,
    min: 1,
    max: 32,
    unit: "failures",
    effect: "next-run",
  });
  registerIntelNum({
    id: "intelligence.classBoost",
    name: "Extra rank when the query names a type",
    description:
      "Raising this prefers files whose type names match the query. Lowering it treats those files more like ordinary word matches.",
    configPath: "codeIntelligence.retrieval.classBoost",
    default: DEFAULTS.classBoost,
    min: 0,
    max: 2,
    unit: "score"
  });
  registerIntelNum({
    id: "intelligence.basenameBoost",
    name: "Extra rank when the query matches a file name",
    description:
      "Raising this prefers files whose name (without folders) matches the query. Lowering it treats the file name like any other path fragment.",
    configPath: "codeIntelligence.retrieval.basenameBoost",
    default: DEFAULTS.basenameBoost,
    min: 0,
    max: 2,
    unit: "score"
  });
  registerIntelNum({
    id: "intelligence.pathSegBoost",
    name: "Extra rank when the query matches a folder in the path",
    description:
      "Raising this prefers files whose folder names match the query. Lowering it treats those folders like ordinary path text.",
    configPath: "codeIntelligence.retrieval.pathSegBoost",
    default: DEFAULTS.pathSegBoost,
    min: 0,
    max: 2,
    unit: "score"
  });
  registerIntelNum({
    id: "intelligence.phraseBoost",
    name: "Extra rank for an exact phrase in a file path",
    description:
      "Raising this prefers files whose path contains the query as a contiguous phrase. Lowering it treats those files more like ordinary word matches.",
    configPath: "codeIntelligence.retrieval.phraseBoost",
    default: DEFAULTS.phraseBoost,
    min: 0,
    max: 1,
    unit: "score"
  });
  registerIntelNum({
    id: "intelligence.stage1K",
    name: "Files kept after the first ranking pass",
    description:
      "The first pass keeps this many files before import and folder expansion. Raising it feeds a wider shortlist into the later seats and costs more ranking work.",
    configPath: "codeIntelligence.retrieval.stage1K",
    default: DEFAULTS.stage1K,
    min: 1,
    max: 100,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.finalK",
    name: "Files kept after ranking",
    description:
      "The retrieval pass keeps this many files after scoring. Raising it feeds more of the tree into the next step and costs more ranking work.",
    configPath: "codeIntelligence.retrieval.finalK",
    default: DEFAULTS.finalK,
    min: 1,
    max: 100,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.importSlots",
    name: "Seats reserved for files the shortlist imports",
    description:
      "This many result seats are held for files imported by the first-pass shortlist, so structurally related files are not buried. Raising it shows more of that neighbourhood.",
    configPath: "codeIntelligence.retrieval.importSlots",
    default: DEFAULTS.importSlots,
    min: 0,
    max: 50,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.reverseSlots",
    name: "Seats reserved for files that import the shortlist",
    description:
      "This many result seats are held for files that import the first-pass shortlist. Raising it surfaces more callers; lowering it leaves those seats for other kinds of hit.",
    configPath: "codeIntelligence.retrieval.reverseSlots",
    default: DEFAULTS.reverseSlots,
    min: 0,
    max: 50,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.packageSlots",
    name: "Seats reserved for files that share a folder with the shortlist",
    description:
      "This many result seats are held for files that live in a folder already represented in the shortlist. Raising it keeps more neighbours; lowering it spends those seats elsewhere.",
    configPath: "codeIntelligence.retrieval.packageSlots",
    default: DEFAULTS.packageSlots,
    min: 0,
    max: 50,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.stage1CoreK",
    name: "How many first-pass files seed the import expansion",
    description:
      "Only this many of the first-pass files are used as the seed for import and reverse-import expansion. Raising it grows the neighbourhood; lowering it keeps expansion tight.",
    configPath: "codeIntelligence.retrieval.stage1CoreK",
    default: DEFAULTS.stage1CoreK,
    min: 1,
    max: 50,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.phraseMaxFiles",
    name: "Ignore a phrase that appears in more files than this",
    description:
      "A phrase that matches more files than this is treated as too common to rank by. Lowering it ignores more generic phrases; raising it lets wider phrases still count.",
    configPath: "codeIntelligence.retrieval.phraseMaxFiles",
    default: DEFAULTS.phraseMaxFiles,
    min: 1,
    max: 500,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.basenameMaxFiles",
    name: "Ignore a file name that appears more times than this",
    description:
      "A file name shared by more files than this is treated as too common to rank by. Lowering it ignores more generic names; raising it lets wider names still count.",
    configPath: "codeIntelligence.retrieval.basenameMaxFiles",
    default: DEFAULTS.basenameMaxFiles,
    min: 1,
    max: 500,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.pathSegMaxFiles",
    name: "Ignore a folder name that appears more times than this",
    description:
      "A folder name shared by more files than this is treated as too common to rank by. Lowering it ignores more generic folders; raising it lets wider folder names still count.",
    configPath: "codeIntelligence.retrieval.pathSegMaxFiles",
    default: DEFAULTS.pathSegMaxFiles,
    min: 1,
    max: 500,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.minBasenameLength",
    name: "Shortest file name that still counts as a match",
    description:
      "File names shorter than this many characters are skipped as too generic. Raising it ignores more short names; lowering it lets short names rank.",
    configPath: "codeIntelligence.retrieval.minBasenameLength",
    default: DEFAULTS.minBasenameLength,
    min: 1,
    max: 40,
    unit: "characters",
  });
  registerIntelNum({
    id: "intelligence.minPathSegLength",
    name: "Shortest folder name that still counts as a match",
    description:
      "Folder names shorter than this many characters are skipped as too generic. Raising it ignores more short folders; lowering it lets short folders rank.",
    configPath: "codeIntelligence.retrieval.minPathSegLength",
    default: DEFAULTS.minPathSegLength,
    min: 1,
    max: 40,
    unit: "characters",
  });
  registerIntelNum({
    id: "intelligence.minQueryWordLength",
    name: "Shortest query word that still counts",
    description:
      "Query words shorter than this many characters do not contribute to matching. Raising it ignores more short words; lowering it lets short words rank.",
    configPath: "codeIntelligence.retrieval.minQueryWordLength",
    default: DEFAULTS.minQueryWordLength,
    min: 1,
    max: 20,
    unit: "characters",
  });
  registerIntelNum({
    id: "intelligence.packageMinDirHits",
    name: "Folder must contain this many already-chosen files to qualify",
    description:
      "A folder only earns a neighbour seat once this many first-pass files already live in it. Raising it makes neighbour seats rarer and more concentrated.",
    configPath: "codeIntelligence.retrieval.packageMinDirHits",
    default: DEFAULTS.packageMinDirHits,
    min: 1,
    max: 20,
    unit: "files",
  });
  registerIntelNum({
    id: "intelligence.importSemanticFloor",
    name: "Minimum likeness for an imported file to keep its seat",
    description:
      "An imported file below this likeness score is dropped as a utility rather than a real neighbour. Raising it keeps only closer imports; lowering it lets weaker imports through.",
    configPath: "codeIntelligence.retrieval.importSemanticFloor",
    default: DEFAULTS.importSemanticFloor,
    min: 0,
    max: 1,
    unit: "score"
  });
  registerIntelNum({
    id: "intelligence.importClassMultiplier",
    name: "How much more an imported type-name match counts",
    description:
      "Raising this weights imported files whose type names match the query more heavily. Lowering it treats those imports more like ordinary imported files.",
    configPath: "codeIntelligence.retrieval.importClassMultiplier",
    default: DEFAULTS.importClassMultiplier,
    min: 0,
    max: 5,
    unit: "factor"
  });
  registerIntelNum({
    id: "intelligence.bm25K1",
    name: "How much repeating a word still adds to the score",
    description:
      "Raising this lets a word that appears many times in a file keep adding rank (the underlying term-frequency saturation is k1). Lowering it treats extra repeats as almost the same as the first.",
    configPath: "codeIntelligence.retrieval.bm25K1",
    default: DEFAULTS.bm25K1,
    min: 0,
    max: 5,
    unit: "score"
  });
  registerIntelNum({
    id: "intelligence.bm25B",
    name: "How much longer files are down-ranked",
    description:
      "Raising this reduces the rank of longer files more strongly (the underlying length normalization is b). Lowering it toward zero treats a long file more like a short one.",
    configPath: "codeIntelligence.retrieval.bm25B",
    default: DEFAULTS.bm25B,
    min: 0,
    max: 1,
    unit: "share"
  });
  registerIntelNum({
    id: "intelligence.hybridBm25Weight",
    name: "How much exact-term evidence outweighs fuzzy matches",
    description:
      "Raising this prefers files that contain the query's words as written (the underlying mix is a BM25 weight). Lowering it lets inexact matches count for more.",
    configPath: "codeIntelligence.retrieval.hybridBm25Weight",
    default: DEFAULTS.hybridBm25Weight,
    min: 0,
    max: 1,
    unit: "share"
  });
  registerIntelNum({
    id: "intelligence.hybridSpecificBm25WeightFloor",
    name: "Least share of exact-term evidence for a precise query",
    description:
      "When the query looks like a real identifier, exact-term evidence cannot fall below this share (the underlying mix is a BM25 weight). Raising it locks a precise query onto exact words even more.",
    configPath: "codeIntelligence.retrieval.hybridSpecificBm25WeightFloor",
    default: DEFAULTS.hybridSpecificBm25WeightFloor,
    min: 0,
    max: 1,
    unit: "share"
  });
  registerIntelNum({
    id: "intelligence.hybridVagueBm25WeightCeiling",
    name: "Most share of exact-term evidence for a vague query",
    description:
      "When the query is vague, exact-term evidence cannot rise above this share (the underlying mix is a BM25 weight). Lowering it lets inexact matches dominate a vague query even more.",
    configPath: "codeIntelligence.retrieval.hybridVagueBm25WeightCeiling",
    default: DEFAULTS.hybridVagueBm25WeightCeiling,
    min: 0,
    max: 1,
    unit: "share"
  });
  registerIntelNum({
    id: "intelligence.searchBiasDirectoryThreshold",
    name: "Folder share that counts a result list as clustered",
    description:
      "When this fraction of hits live under one top folder, the result list is reported as clustered there. Lowering it flags milder clustering; raising it waits for a heavier pile-up.",
    configPath: "codeIntelligence.retrieval.searchBiasDirectoryThreshold",
    default: DEFAULTS.searchBiasDirectoryThreshold,
    min: 0,
    max: 1,
    unit: "share"
  });
  registerIntelNum({
    id: "intelligence.searchBiasMinResults",
    name: "Hits needed before a folder cluster is reported",
    description:
      "A result list smaller than this is never called clustered, because a handful of hits can sit in one folder by chance. Raising it waits for a thicker list.",
    configPath: "codeIntelligence.retrieval.searchBiasMinResults",
    default: DEFAULTS.searchBiasMinResults,
    min: 1,
    max: 100,
    unit: "results",
  });
  registerIntelNum({
    id: "intelligence.searchSealRatio",
    name: "How far the top hit must lead to count as a sure match",
    description:
      "The best hit must outscore the second by at least this ratio before search treats it as a confident seal. Raising it makes a seal rarer and more certain.",
    configPath: "codeIntelligence.retrieval.searchSealRatio",
    default: DEFAULTS.searchSealRatio,
    min: 1,
    max: 10,
    unit: "ratio"
  });
  registerIntelNum({
    id: "intelligence.searchSealMinScore",
    name: "Minimum score the top hit must also clear to count as a sure match",
    description:
      "Even a wide lead is not a seal unless the top hit also clears this score. Raising it makes a seal rarer; lowering it lets a weaker top hit still count as sure.",
    configPath: "codeIntelligence.retrieval.searchSealMinScore",
    default: DEFAULTS.searchSealMinScore,
    min: 0,
    max: 1,
    unit: "score"
  });
}

export function resetIntelligenceRegistration(): void {
  intelligenceRegistered = false;
}
