import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { relativePathViolationKinds } from "../filesystem/path-boundary.ts";
import { hasSecondName } from "../filesystem/link-containment.ts";
import {
  type FileInfo,
  type ModuleInfo,
  type RepositoryMap,
  type SourceExtension,
  getSourceExtension,
  isSourceExtension,
  INTELLIGENCE_SCHEMA_VERSION,
} from "./intelligence-types.ts";
import { extractSymbols, type ExtractionResult } from "./symbol-extractor.ts";
import { getLanguageByExtension } from "./language-registry.ts";
import { runIsolatedProcess, type FarmFileResult } from "./process-farm.ts";
import {
  assertTreeSitterLanguagesReady,
  initTreeSitterForExtract,
  isTreeSitterUnreadyError,
  TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
} from "./tree-sitter-backend.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { resolveIntelligenceConfig } from "./intelligence-config.ts";
import {
  type MapEntry,
  type RepositoryFileStat,
  type RepositoryMapCache,
  type RepositoryReadLimits,
  type RepositoryWalkResult,
  createRepositoryMapCache,
  repositoryConfigKey,
  resolveRepositoryReadLimits,
  scanRepositoryStats,
  statMatchesCache,
  usableCacheFor,
} from "./repository-stat-scan.ts";

// In-process map entry: generateRepositoryMap is sync and cannot await
// per call. This process is the harness (JS/TS). Isolated extract — the
// production path for a user's project — inits the languages THAT PROJECT
// actually contains, in the farm child (language-agnostic per project).
await initTreeSitterForExtract(["javascript", "typescript"]);

/**
 * Repository map generator.
 *
 * Implements delivery-map item 7: generate a trustworthy full-repository map
 * before any modification. The map includes all source files, their symbols
 * (functions, classes, types), imports, exports, and module metadata.
 *
 * File listing reuses the same safe-directory-walk discipline as
 * `scripts/verification/safe-repository-reader.ts`: it rejects symlinks,
 * mount-point escapes, hardlinks, and path-traversal entries. The default
 * reader uses `node:fs` with descriptor-pinned identity checks, matching the
 * safe reader's security model at the src/ layer.
 *
 * The set of directories excluded from the scan is sourced from the single
 * canonical owner `ROOT_POLICY.configuration.repositoryScanExclusions`
 * (the same authority `src/config.ts` consumes), not a parallel hardcoded
 * list. Per `relativePathViolationKinds`, entries that are not absolute,
 * do not contain a `.`/`..` segment, a backslash, a control character, or
 * an empty segment are walked; everything else is skipped. The walk depth
 * and entry ceilings (`maximumDepth`/`maximumEntries`) are repository-map
 * defaults because `ROOT_POLICY.configuration` does not yet expose scan
 * depth/entry limits for the intelligence layer — see the typed gap below.
 *
 * Module metadata (layer, realm, owner, dependencies) is sourced from
 * `src/architecture-manifest.ts` — the canonical module registry. The map
 * joins source-file analysis with architecture-manifest metadata so consumers
 * get both the structural facts (symbols, imports) and the governance facts
 * (which layer, which owner, which declared dependencies).
 *
 * The map is cacheable and incremental on two floors:
 * - a STAT cache ({path → mtimeMs,sizeBytes} from the last complete scan)
 *   decides which files are re-READ — a rebuild stat-walks the tree first
 *   and only reads files whose stat no longer matches (mtime+size is the
 *   standard precise-enough primitive under the sole-writer assumption;
 *   a reverted file re-reads but does not re-parse);
 * - the per-file CONTENT-HASH cache (below) decides which files are
 *   re-PARSED — a read whose hash matches the cached extraction is reused
 *   with zero parses.
 * A caller that knows which paths changed (the harness's own editor
 * writes) can pass `changedPathHints` and skip the tree walk entirely.
 * The resulting map is assembled by the same code a full rebuild uses,
 * so an incremental rebuild of a tree is semantically equal to a
 * from-scratch build of the same tree.
 */

export type RepositoryReaderPort = Readonly<{
  listFiles(root: string, limits: RepositoryReadLimits): readonly FileInfo[];
  /** Stat-aware listing: the same walk as `listFiles`, plus a `complete`
   * flag that is `false` when any directory read failed mid-walk. A
   * `complete: false` walk is best-effort (subtrees dropped, exactly like
   * `listFiles`) — the difference is that the map generator will NOT
   * advance the stat-cache snapshot on it (a partial snapshot must never
   * masquerade as the tree's state). Optional: readers without it are
   * assumed complete (mock/in-memory readers). */
  listFilesWithStatus?(root: string, limits: RepositoryReadLimits): RepositoryWalkResult;
  readFile(root: string, path: string): Readonly<{ content: string; sizeBytes: number; contentHash: string; mtimeMs?: number }>;
}>;

export type ArchitectureModuleLookup = Readonly<{
  moduleId: string | null;
  layer: string | null;
  realm: string | null;
  owner: string | null;
}>;

export type ArchitectureModuleIndex = Readonly<{
  lookup(path: string): ArchitectureModuleLookup | null;
  declaredDependencies(path: string): readonly string[];
}>;

export function createEmptyArchitectureIndex(): ArchitectureModuleIndex {
  return deepFreeze({
    lookup: () => null,
    declaredDependencies: () => deepFreeze([]),
  });
}

export type MapGenerationOptions = Readonly<{
  reader?: RepositoryReaderPort;
  architectureIndex?: ArchitectureModuleIndex;
  cache?: RepositoryMapCache;
  limits?: Readonly<Partial<RepositoryReadLimits>>;
  maxFileBytes?: number;
  /** Paths (repo-relative) the caller KNOWS changed since `cache` was
   * built — the harness's own editor-write signal. When present (and the
   * cache is warm) the tree walk is skipped entirely: only these files
   * are re-read, everything else is reused from the cache. Sole-writer
   * assumption: external writers are not hinted — they go through the
   * watch → full stat-walk rebuild. */
  changedPathHints?: readonly string[];
  /** A pre-computed stat scan (see {@link scanRepositoryStats}), so a
   * caller that already walked the tree (e.g. to decide "anything
   * changed?") does not pay for a second walk. Ignored when
   * `changedPathHints` drives an O(hints) rebuild. */
  statScan?: RepositoryWalkResult;
  /** Parse-counter seam (tests/instrumentation): fires exactly once per
   * file that is actually parsed or farm-dispatched — never for a
   * stat-cache or content-hash reuse. Not a logging path. */
  onFileParsed?: (filePath: string) => void;
  /** Watchdog knobs forwarded to `runIsolatedProcess`. Omitted = farm defaults. */
  farm?: Readonly<{
    perFileTimeoutMs?: number;
    initTimeoutMs?: number;
    maxInitFailures?: number;
  }>;
}>;

/** Normalize caller hints to the paths a scan could index: repo-relative,
 * no path violations, a source extension, no excluded directory segment. */
function filterChangedPathHints(hints: readonly string[], limits: RepositoryReadLimits): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hint of hints) {
    if (typeof hint !== "string" || hint.length === 0) continue;
    if (relativePathViolationKinds(hint).length > 0) continue;
    let excluded = false;
    for (const segment of hint.split(/[\\/]+/)) {
      if (limits.excludedDirectoryNames.includes(segment)) { excluded = true; break; }
    }
    if (excluded) continue;
    const ext = getSourceExtension(hint);
    if (!ext || !isSourceExtension(ext)) continue;
    if (!seen.has(hint)) { seen.add(hint); out.push(hint); }
  }
  return out;
}

/** A FileInfo from a stat alone (hash/lineCount unknown until read). */
function fileInfoFromStat(path: string, stat: RepositoryFileStat): FileInfo {
  return Object.freeze({
    path,
    extension: getSourceExtension(path),
    sizeBytes: stat.sizeBytes,
    contentHash: "",
    lineCount: 0,
    isSource: true,
    mtimeMs: stat.mtimeMs,
  });
}

/** The per-rebuild file plan: the file list to assemble (in baseline/walk
 * order, so module order matches a full rebuild) plus which of them need a
 * re-read. `complete` mirrors the walk (a hint path is complete by
 * construction — its baseline descends from a finished walk). */
interface IncrementalScanPlan {
  readonly files: readonly FileInfo[];
  readonly toRead: ReadonlySet<string>;
  readonly complete: boolean;
}

function scanWithReader(
  reader: RepositoryReaderPort,
  rootPath: string,
  limits: RepositoryReadLimits,
): RepositoryWalkResult {
  if (reader.listFilesWithStatus !== undefined) return reader.listFilesWithStatus(rootPath, limits);
  return { files: reader.listFiles(rootPath, limits), complete: true };
}

function planIncrementalScan(
  reader: RepositoryReaderPort,
  rootPath: string,
  limits: RepositoryReadLimits,
  oldCache: RepositoryMapCache,
  hints: readonly string[] | undefined,
  statScan: RepositoryWalkResult | undefined,
): IncrementalScanPlan {
  if (hints !== undefined) {
    // O(hints) fast path — no tree walk. The baseline file set is the
    // cache's own snapshot; the hinted paths are re-read (or dropped when
    // the read fails), everything else is reused as-is.
    const files: FileInfo[] = [];
    for (const [path, stat] of oldCache.stats) files.push(fileInfoFromStat(path, stat));
    for (const hint of hints) {
      if (!oldCache.stats.has(hint)) {
        files.push(fileInfoFromStat(hint, { mtimeMs: 0, sizeBytes: 0 }));
      }
    }
    return { files, toRead: new Set(hints), complete: true };
  }
  const scan = statScan ?? scanWithReader(reader, rootPath, limits);
  const toRead = new Set<string>();
  for (const file of scan.files) {
    if (!statMatchesCache(file, oldCache.stats) || !oldCache.entries.has(file.path)) {
      toRead.add(file.path);
    }
  }
  return { files: scan.files, toRead, complete: scan.complete };
}

/** Module record + totals from one file's entry — the single assembly both
 * generators use, so an incremental map is assembled by the exact code a
 * full rebuild uses. */
function buildModuleRecord(
  path: string,
  contentHash: string,
  extraction: ExtractionResult,
  archIndex: ArchitectureModuleIndex,
): Readonly<{ module: ModuleInfo; symbolCount: number; dependencyCount: number }> {
  const arch = archIndex.lookup(path);
  const symbolsWithPaths = extraction.symbols.map((s) => ({
    ...s,
    location: { ...s.location, filePath: path },
  }));
  return {
    symbolCount: symbolsWithPaths.length,
    dependencyCount: extraction.imports.length,
    module: {
      path,
      contentHash,
      lineCount: extraction.lineCount,
      symbols: deepFreeze(symbolsWithPaths),
      imports: extraction.imports,
      exports: extraction.exports,
      architectureModuleId: arch?.moduleId ?? null,
      architectureLayer: arch?.layer ?? null,
      architectureRealm: arch?.realm ?? null,
      architectureOwner: arch?.owner ?? null,
    },
  };
}

function assembleRepositoryMap(
  rootPath: string,
  files: readonly FileInfo[],
  moduleInfos: readonly ModuleInfo[],
  newEntries: ReadonlyMap<string, MapEntry>,
  totalSymbols: number,
  totalDependencies: number,
): RepositoryMap {
  const mapHash = computeMapHash(rootPath, files, moduleInfos);
  return deepFreeze({
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    rootPath,
    generatedAt: new Date(0).toISOString(),
    files: deepFreeze(moduleInfos.map((m) => ({
      path: m.path,
      extension: getSourceExtension(m.path),
      sizeBytes: newEntries.get(m.path)?.sizeBytes ?? 0,
      contentHash: m.contentHash,
      lineCount: m.lineCount,
      isSource: true,
    }))),
    modules: deepFreeze([...moduleInfos]),
    totalSymbols,
    totalDependencies,
    mapHash,
  });
}

export function generateRepositoryMap(
  rootPath: string,
  options: MapGenerationOptions = {},
): Readonly<{ map: RepositoryMap; cache: RepositoryMapCache }> {
  if (typeof rootPath !== "string" || rootPath.length === 0) {
    throw new InputError("Root path is required", "intelligence_root_missing");
  }
  const reader = options.reader ?? NODE_FS_REPOSITORY_READER;
  const archIndex = options.architectureIndex ?? createEmptyArchitectureIndex();
  const limits = resolveRepositoryReadLimits(options.limits);
  // Resolve + validate the maxFileBytes override at the choke point (rule:
  // validate bounds at the trust boundary). A bad caller value (NaN / <= 0)
  // previously silently broke the walk (all files skipped or none); it now
  // throws a typed InputError via the single validated config owner.
  const maxFileBytes = resolveIntelligenceConfig(
    options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes },
  ).maxFileBytes;
  const configKey = repositoryConfigKey(limits, maxFileBytes);
  const oldCache = usableCacheFor(options.cache ?? createRepositoryMapCache(), configKey);
  // Hints only mean anything against a warm stat baseline.
  const hints = options.changedPathHints !== undefined && oldCache.stats.size > 0
    ? filterChangedPathHints(options.changedPathHints, limits)
    : undefined;
  const plan = planIncrementalScan(reader, rootPath, limits, oldCache, hints, options.statScan);

  const files = plan.files;
  // Sync map cannot await WASM init (lab Finding 0). Fail closed before
  // the extract loop so an unready tree-sitter language cannot become a
  // skipped module / empty symbol set. Init lives at process spawn:
  // farm-child (isolated map) or in-process extract entries.
  assertTreeSitterLanguagesReady(
    files.flatMap((file) => {
      const lang = getLanguageByExtension(file.path);
      return lang === undefined ? [] : [lang.id];
    }),
  );
  const newEntries = new Map<string, MapEntry>();
  const newStats = new Map<string, RepositoryFileStat>();
  const moduleInfos: ModuleInfo[] = [];
  let totalSymbols = 0;
  let totalDependencies = 0;

  for (const file of files) {
    if (file.sizeBytes > maxFileBytes) continue;
    const cachedEntry = oldCache.entries.get(file.path);
    const cachedStat = oldCache.stats.get(file.path);
    let entry: MapEntry;
    if (!plan.toRead.has(file.path) && cachedEntry !== undefined && cachedStat !== undefined) {
      // Stat hit: the file still carries the bytes we already parsed —
      // no read, no hash, no parse.
      entry = cachedEntry;
      newStats.set(file.path, cachedStat);
    } else {
      let fileData: Readonly<{ content: string; sizeBytes: number; contentHash: string; mtimeMs?: number }>;
      try {
        fileData = reader.readFile(rootPath, file.path);
      } catch (e) {handleError(e, { module: "intelligence-repository-map", operation: "catch" });
        continue;
      }
      if (fileData.sizeBytes > maxFileBytes) continue;
      let extraction: ExtractionResult;
      if (cachedEntry !== undefined && cachedEntry.contentHash === fileData.contentHash) {
        // Stat miss but content match (a reverted or same-bytes rewrite):
        // re-read, zero parses.
        extraction = cachedEntry.extraction;
      } else {
        try {
          extraction = extractSymbols(file.path, fileData.content);
        } catch (e) {
          handleError(e, { module: "intelligence-repository-map", operation: "extractSymbols" });
          if (isTreeSitterUnreadyError(e)) throw e;
          continue;
        }
        options.onFileParsed?.(file.path);
      }
      entry = {
        contentHash: fileData.contentHash,
        extraction,
        lineCount: extraction.lineCount,
        sizeBytes: fileData.sizeBytes,
      };
      newStats.set(file.path, {
        mtimeMs: fileData.mtimeMs ?? file.mtimeMs ?? 0,
        sizeBytes: fileData.sizeBytes,
      });
    }
    newEntries.set(file.path, entry);
    const record = buildModuleRecord(file.path, entry.contentHash, entry.extraction, archIndex);
    totalSymbols += record.symbolCount;
    totalDependencies += record.dependencyCount;
    moduleInfos.push(record.module);
  }

  const map = assembleRepositoryMap(rootPath, files, moduleInfos, newEntries, totalSymbols, totalDependencies);
  // Only a COMPLETE walk may install its stat snapshot — a walk that errored
  // mid-way returns the previous cache so a partial tree is never mistaken
  // for the whole one.
  const cache: RepositoryMapCache = plan.complete
    ? deepFreeze({ entries: newEntries, stats: newStats, configKey })
    : oldCache;
  return { map, cache };
}

/**
 * Same map as `generateRepositoryMap`, but file extract runs in
 * crash-isolated child processes (`runIsolatedProcess`). A grammar trap
 * kills a child, not the HTTP/orchestrator process, and names the file.
 */
export async function generateRepositoryMapIsolated(
  rootPath: string,
  options: MapGenerationOptions = {},
): Promise<Readonly<{ map: RepositoryMap; cache: RepositoryMapCache }>> {
  if (typeof rootPath !== "string" || rootPath.length === 0) {
    throw new InputError("Root path is required", "intelligence_root_missing");
  }
  const reader = options.reader ?? NODE_FS_REPOSITORY_READER;
  const archIndex = options.architectureIndex ?? createEmptyArchitectureIndex();
  const limits = resolveRepositoryReadLimits(options.limits);
  const maxFileBytes = resolveIntelligenceConfig(
    options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes },
  ).maxFileBytes;
  const configKey = repositoryConfigKey(limits, maxFileBytes);
  const oldCache = usableCacheFor(options.cache ?? createRepositoryMapCache(), configKey);
  const hints = options.changedPathHints !== undefined && oldCache.stats.size > 0
    ? filterChangedPathHints(options.changedPathHints, limits)
    : undefined;
  const plan = planIncrementalScan(reader, rootPath, limits, oldCache, hints, options.statScan);

  // Read every file the plan flagged, then split: a content-hash match
  // reuses the cached extraction (zero parses — a reverted write costs one
  // read); the rest go to the crash-isolated farm. This is the same
  // read-before-parse ordering the in-process generator uses, so both
  // generators make identical reuse decisions.
  const readData = new Map<string, Readonly<{ content: string; sizeBytes: number; contentHash: string; mtimeMs?: number }>>();
  const hashReuse = new Map<string, MapEntry>();
  const work: Array<{ path: string; absolutePath: string }> = [];
  const langs = new Set<string>();
  for (const path of plan.toRead) {
    let fileData: Readonly<{ content: string; sizeBytes: number; contentHash: string; mtimeMs?: number }>;
    try {
      fileData = reader.readFile(rootPath, path);
    } catch (e) {
      handleError(e, { module: "intelligence-repository-map", operation: "catch" });
      continue;
    }
    if (fileData.sizeBytes > maxFileBytes) continue;
    readData.set(path, fileData);
    const cachedEntry = oldCache.entries.get(path);
    if (cachedEntry !== undefined && cachedEntry.contentHash === fileData.contentHash) {
      hashReuse.set(path, cachedEntry);
      continue;
    }
    work.push({ path, absolutePath: join(rootPath, path) });
    const lang = getLanguageByExtension(path);
    if (lang !== undefined) langs.add(lang.id);
    options.onFileParsed?.(path);
  }
  const farm = await runIsolatedProcess(work, [...langs], {
    ...(options.farm?.perFileTimeoutMs !== undefined ? { perFileTimeoutMs: options.farm.perFileTimeoutMs } : {}),
    ...(options.farm?.initTimeoutMs !== undefined ? { initTimeoutMs: options.farm.initTimeoutMs } : {}),
    ...(options.farm?.maxInitFailures !== undefined ? { maxInitFailures: options.farm.maxInitFailures } : {}),
  });
  assertFarmExtractNotUnready(farm);
  const byPath = new Map(farm.map((r) => [r.path, r]));
  const newEntries = new Map<string, MapEntry>();
  const newStats = new Map<string, RepositoryFileStat>();
  const moduleInfos: ModuleInfo[] = [];
  let totalSymbols = 0;
  let totalDependencies = 0;
  for (const file of plan.files) {
    if (file.sizeBytes > maxFileBytes) continue;
    const cachedEntry = oldCache.entries.get(file.path);
    const cachedStat = oldCache.stats.get(file.path);
    let entry: MapEntry;
    if (!plan.toRead.has(file.path) && cachedEntry !== undefined && cachedStat !== undefined) {
      // Stat hit: no read, no hash, no farm round-trip.
      entry = cachedEntry;
      newStats.set(file.path, cachedStat);
    } else {
      const fileData = readData.get(file.path);
      if (fileData === undefined) continue;
      const reused = hashReuse.get(file.path);
      const extraction = reused !== undefined
        ? reused.extraction
        : farmExtraction(byPath.get(file.path));
      entry = {
        contentHash: fileData.contentHash,
        extraction,
        lineCount: extraction.lineCount,
        sizeBytes: fileData.sizeBytes,
      };
      newStats.set(file.path, {
        mtimeMs: fileData.mtimeMs ?? file.mtimeMs ?? 0,
        sizeBytes: fileData.sizeBytes,
      });
    }
    newEntries.set(file.path, entry);
    const record = buildModuleRecord(file.path, entry.contentHash, entry.extraction, archIndex);
    totalSymbols += record.symbolCount;
    totalDependencies += record.dependencyCount;
    moduleInfos.push(record.module);
  }
  const map = assembleRepositoryMap(rootPath, plan.files, moduleInfos, newEntries, totalSymbols, totalDependencies);
  const cache: RepositoryMapCache = plan.complete
    ? deepFreeze({ entries: newEntries, stats: newStats, configKey })
    : oldCache;
  return { map, cache };
}

function farmExtraction(hit: FarmFileResult | undefined): ExtractionResult {
  // Isolated containment: a poison grammar the farm dropped (or a parse
  // crash) is an empty extract for THAT file. In-process generateRepositoryMap
  // still fail-closes on unready so a forgotten init cannot look like a
  // successful empty map. Isolated already isolated the trap.
  if (hit === undefined || !hit.ok || hit.detail.length === 0) {
    return deepFreeze({
      symbols: deepFreeze([] as const),
      imports: deepFreeze([] as const),
      exports: deepFreeze([] as const),
      lineCount: hit?.lineCount ?? 0,
    });
  }
  return hit.detail[0] as ExtractionResult;
}

/**
 * Isolated extract: a single poison grammar is per-file empty (the farm
 * dropped it and continued). Total init-failure — every file crashed
 * because no child ever readied — still throws so a wedged farm cannot
 * look like a successful empty map.
 */
function assertFarmExtractNotUnready(farm: readonly FarmFileResult[]): void {
  if (farm.length > 0 && farm.every((hit) => !hit.ok)) {
    const initFail = farm.find((hit) => (hit.errorMessage ?? "").includes("failed to initialize"));
    if (initFail !== undefined) {
      throw new InputError(
        initFail.errorMessage ?? "tree-sitter farm failed to initialize",
        TREE_SITTER_LANGUAGE_NOT_INITIALIZED,
      );
    }
  }
}

function computeMapHash(rootPath: string, files: readonly FileInfo[], modules: readonly ModuleInfo[]): string {
  const summary = {
    rootPath,
    fileCount: files.length,
    moduleCount: modules.length,
    moduleHashes: modules.map((m) => ({ path: m.path, hash: m.contentHash, symbols: m.symbols.length })),
  };
  return sha256(canonicalHash(summary));
}

/**
 * The `node:fs`-backed reader every map generation uses unless a caller
 * supplies its own. Named for its IMPLEMENTATION rather than as a `DEFAULT_`,
 * because it is not a configurable value with a resolver behind it — it is the
 * one concrete port, and the `DEFAULT_` family rules are about config defaults
 * that a resolver owns.
 *
 * EXPORTED so its refusals can be driven directly. Its symlink and second-name
 * refusals were reachable only through a full map generation, where the walk
 * already skips both — so the two `throw`s below had no test at all, which is
 * how one of them came to disagree with the web UI's filesystem gate about the
 * same question.
 *
 * The listing is a STAT-ONLY walk: readdir + lstat per entry, no file reads
 * (content hashes are computed by `readFile`, only for the files a rebuild
 * actually needs). Each FileInfo carries `mtimeMs` + `sizeBytes` — the
 * stat-cache identity — with `contentHash: ""` / `lineCount: 0` until the
 * file is read.
 */
export const NODE_FS_REPOSITORY_READER: RepositoryReaderPort = {
  listFiles(root: string, limits: RepositoryReadLimits): readonly FileInfo[] {
    return scanRepositoryStats(root, limits).files;
  },
  listFilesWithStatus(root: string, limits: RepositoryReadLimits): RepositoryWalkResult {
    return scanRepositoryStats(root, limits);
  },
  readFile(root: string, path: string): Readonly<{ content: string; sizeBytes: number; contentHash: string; mtimeMs?: number }> {
    if (relativePathViolationKinds(path).length > 0) {
      throw new HarnessError("Path violation in repository read", "intelligence_path_violation");
    }
    const fullPath = join(root, path);
    const stats = lstatSync(fullPath, { bigint: true, throwIfNoEntry: false });
    if (!stats || !stats.isFile()) {
      throw new HarnessError("File not found in repository", "intelligence_file_missing");
    }
    if (stats.isSymbolicLink()) {
      throw new HarnessError("Symlink rejected by repository reader", "intelligence_symlink_rejected");
    }
    // ONE OWNER FOR THE SECOND-NAME QUESTION, AND NO POLICY IN FRONT OF IT.
    // This reader and the web UI's filesystem gate used to answer it
    // independently, and the gate did not answer it at all — a hard link inside
    // a project returned the bytes of a file outside it. The verdict comes from
    // the shared owner so a future asker cannot disagree with this one.
    //
    // The refusal is UNCONDITIONAL, as it was before the owner existed. The
    // consolidation briefly put the self-protection policy in front of it,
    // which is the wrong question here: this reader walks a TARGET repository,
    // and whether the HARNESS's own tree is seeded with `cp -rl` says nothing
    // about whether a file inside somebody's project also lives outside it.
    // Relaxing the strictest consumer to a shared policy's level is a
    // regression wearing a refactor's clothes, so it is undone and the reason
    // is recorded here rather than in a commit message nobody re-reads.
    if (hasSecondName(stats.nlink)) {
      throw new HarnessError("Hardlink rejected by repository reader", "intelligence_hardlink_rejected");
    }
    const bytes = readFileSync(fullPath);
    return {
      content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      sizeBytes: bytes.length,
      contentHash: sha256(bytes),
      mtimeMs: Number(stats.mtimeMs),
    };
  },
};

export function createArchitectureModuleIndex(
  modules: readonly Readonly<{ path: string; id: string; layer: string; realm: string; owner: string; dependencies: readonly string[] }>[],
): ArchitectureModuleIndex {
  const byPath = new Map<string, ArchitectureModuleLookup & { dependencies: readonly string[] }>();
  for (const mod of modules) {
    byPath.set(mod.path, {
      moduleId: mod.id,
      layer: mod.layer,
      realm: mod.realm,
      owner: mod.owner,
      dependencies: mod.dependencies,
    });
  }
  return deepFreeze({
    lookup(path: string): ArchitectureModuleLookup | null {
      const entry = byPath.get(path);
      if (!entry) return null;
      return { moduleId: entry.moduleId, layer: entry.layer, realm: entry.realm, owner: entry.owner };
    },
    declaredDependencies(path: string): readonly string[] {
      return byPath.get(path)?.dependencies ?? deepFreeze([]);
    },
  });
}

export type { SourceExtension };
