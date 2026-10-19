/**
 * The stat-scan half of the repository map: the walk limits, the stat-cache
 * baseline types, and the readdir+lstat-only scan + diff that answer "did
 * anything actually change?" WITHOUT reading or parsing a single file.
 *
 * WHY THIS IS ITS OWN MODULE, not a part of repository-map.ts: the map
 * generator's module inits tree-sitter WASM at evaluation (its sync
 * in-process entry cannot await per call), so importing ANY value from it
 * pays that init. The stat walk is pure syscalls — it is now needed ON THE
 * MAIN THREAD (the no-change TTL refresh in server/intelligence/
 * intelligence-bridge.ts runs it there instead of spawning a worker, which
 * measured ~1.25s of one-shot worker CPU — boot + tree-sitter init + the
 * structured-clone of the previous cache — for an 18ms verdict on this
 * repository), so it lives where importing it costs nothing but plain
 * module evaluation. The generator imports FROM here (one owner for the
 * limits, the cache shape, the config fingerprint, and the walk); nothing
 * about the walk's semantics changed in the move.
 *
 * The set of directories excluded from the scan is sourced from the single
 * canonical owner `ROOT_POLICY.configuration.repositoryScanExclusions`
 * (the same authority the generator consumed), never a parallel hardcoded
 * list. Per `relativePathViolationKinds`, entries that are not absolute,
 * do not contain a `.`/`..` segment, a backslash, a control character, or
 * an empty segment are walked; everything else is skipped. The walk depth
 * and entry ceilings are owned by `resolveIntelligenceConfig`
 * (`repositoryMaxDepth`/`repositoryMaxEntries` — the same knobs every
 * other intelligence default flows through): the entry ceiling is ONE
 * GLOBAL per-walk bound, and a tree that exceeds it REFUSES the walk with
 * a typed limit error rather than silently capping — a capped file set
 * would diff wrongly (files beyond the cap look "dropped" → false
 * "changed") and a silently partial map is worse than an honest refusal.
 */
import { lstatSync, readdirSync, type BigIntStats, type Dirent } from "node:fs";
import { join } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { relativePathViolationKinds } from "../filesystem/path-boundary.ts";
import { hasSecondName } from "../filesystem/link-containment.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import {
  type FileInfo,
  type SourceExtension,
  getSourceExtension,
  isSourceExtension,
  SOURCE_EXTENSIONS,
} from "./intelligence-types.ts";
import type { ExtractionResult } from "./symbol-extractor.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { resolveIntelligenceConfig } from "./intelligence-config.ts";

export type RepositoryReadLimits = Readonly<{
  /** Maximum directory depth, inclusive (`repositoryMaxDepth`). */
  maximumDepth: number;
  /** GLOBAL per-walk ceiling on collected file entries (`repositoryMaxEntries`).
   * A tree that exceeds it refuses the walk with the typed limit error
   * `intelligence_walk_entries_exceeded` — never a silently capped listing. */
  maximumEntries: number;
  excludedDirectoryNames: readonly string[];
  extensions: readonly SourceExtension[];
}>;

/**
 * Module-private: `resolveRepositoryReadLimits` below is the resolver, and
 * a default whose owner also owns the resolver has exactly one correct reader.
 * Anything else holding this constant holds a value that stops tracking
 * configuration the moment a caller narrows the walk. The depth/entry
 * ceilings are NOT restated here — they resolve per call from
 * `resolveIntelligenceConfig` (`repositoryMaxDepth`/`repositoryMaxEntries`),
 * so a caller's validated override of those knobs reaches the walk instead
 * of dying at a frozen copy (the dead-knob state this resolver used to have).
 */
const DEFAULT_READ_LIMITS: Readonly<Pick<RepositoryReadLimits, "excludedDirectoryNames" | "extensions">> = deepFreeze({
  excludedDirectoryNames: deepFreeze(ROOT_POLICY.configuration.repositoryScanExclusions),
  extensions: SOURCE_EXTENSIONS,
});

/**
 * THE WALK LIMITS, FILLED IN — one owner for the fill-in step.
 *
 * `generateRepositoryMap` and the tool layer both had their own
 * `options.limits ?? DEFAULT_READ_LIMITS`, which is two mechanisms answering
 * one question. Field-level overrides are honoured, so a caller may narrow
 * the depth without restating the exclusion list.
 */
export function resolveRepositoryReadLimits(
  overrides: Readonly<Partial<RepositoryReadLimits>> = {},
): RepositoryReadLimits {
  const config = resolveIntelligenceConfig();
  return deepFreeze({
    maximumDepth: overrides.maximumDepth ?? config.repositoryMaxDepth,
    maximumEntries: overrides.maximumEntries ?? config.repositoryMaxEntries,
    excludedDirectoryNames: overrides.excludedDirectoryNames ?? DEFAULT_READ_LIMITS.excludedDirectoryNames,
    extensions: overrides.extensions ?? DEFAULT_READ_LIMITS.extensions,
  });
}

export type MapEntry = Readonly<{
  contentHash: string;
  extraction: ExtractionResult;
  lineCount: number;
  sizeBytes: number;
}>;

/** One file's cheap identity from the last successful scan: the two numbers
 * a sole-writer harness can trust to mean "this file's bytes are the ones
 * we already parsed" (mtime + size is the standard precise-enough primitive
 * — make, ninja and every file watcher use the same pair; content hashing
 * would cost a full read per file per rebuild, which is exactly the cost
 * the stat cache exists to avoid). */
export type RepositoryFileStat = Readonly<{ mtimeMs: number; sizeBytes: number }>;

/** A filesystem scan result plus whether the scan completed. */
export type RepositoryWalkResult = Readonly<{ files: readonly FileInfo[]; complete: boolean }>;

export type RepositoryMapCache = Readonly<{
  entries: ReadonlyMap<string, MapEntry>;
  /** Stat snapshot from the last COMPLETE scan ({@link RepositoryFileStat}
   * per indexed file). Only ever swapped in wholesale, and only on a walk
   * that finished — a walk that errored mid-way returns the previous cache
   * unchanged so a partial tree can never be mistaken for the whole one. */
  stats: ReadonlyMap<string, RepositoryFileStat>;
  /** Fingerprint of the config the snapshot was built under (exclusions,
   * limits, maxFileBytes). `null` on a virgin cache; a mismatching key
   * makes the generator discard the cache wholesale (full re-scan). */
  configKey: string | null;
}>;

export function createRepositoryMapCache(): RepositoryMapCache {
  return deepFreeze({ entries: new Map(), stats: new Map(), configKey: null });
}

/** Fingerprint of every scan-shape knob: a cache built under one shape must
 * be discarded wholesale when the shape changes (different exclusions,
 * limits or byte ceilings see a different tree). */
export function repositoryConfigKey(limits: RepositoryReadLimits, maxFileBytes: number): string {
  return sha256(canonicalHash({
    excludedDirectoryNames: [...limits.excludedDirectoryNames],
    extensions: [...limits.extensions],
    maximumDepth: limits.maximumDepth,
    maximumEntries: limits.maximumEntries,
    maxFileBytes,
  }));
}

/** The config key for the DEFAULT scan shape (what a bare
 * `generateRepositoryMap(root)` / worker rebuild resolves). */
function repositoryDefaultConfigKey(): string {
  return repositoryConfigKey(resolveRepositoryReadLimits(), resolveIntelligenceConfig().maxFileBytes);
}

/** A cache from another config shape is unusable — replace it with a virgin
 * one so the rebuild is a full scan. */
export function usableCacheFor(supplied: RepositoryMapCache, configKey: string): RepositoryMapCache {
  return supplied.configKey !== null && supplied.configKey !== configKey
    ? createRepositoryMapCache()
    : supplied;
}

/** Can this cache be trusted as a stat baseline by a rebuild with default
 * config? (The repository-map worker's smart trigger asks exactly this
 * before walking.) Also narrows `undefined` away. */
export function isRepositoryMapCacheReusable(cache: RepositoryMapCache | undefined): cache is RepositoryMapCache {
  if (cache === undefined || cache.stats.size === 0) return false;
  return cache.configKey === null || cache.configKey === repositoryDefaultConfigKey();
}

/** Does `file` still carry the bytes the stat snapshot recorded? */
export function statMatchesCache(file: FileInfo, stats: ReadonlyMap<string, RepositoryFileStat>): boolean {
  if (file.mtimeMs === undefined) return false;
  const st = stats.get(file.path);
  return st !== undefined && st.mtimeMs === file.mtimeMs && st.sizeBytes === file.sizeBytes;
}

/** Diff a stat walk against a cache snapshot. `dirty` = walk files that
 * changed (or lack a stat/entry pairing — the two are always recorded
 * together, so a stray one is treated as changed, never trusted);
 * `dropped` = cached files the walk no longer lists. */
export function diffStatSnapshot(
  files: readonly FileInfo[],
  cache: RepositoryMapCache,
): Readonly<{ dirty: readonly string[]; dropped: readonly string[] }> {
  const listed = new Set(files.map((f) => f.path));
  const dirty = files
    .filter((f) => !statMatchesCache(f, cache.stats) || !cache.entries.has(f.path))
    .map((f) => f.path);
  const dropped = [...cache.stats.keys()].filter((p) => !listed.has(p));
  return { dirty, dropped };
}

/** One stat walk over the tree: the file list plus whether it completed. */
function statWalk(root: string, limits: RepositoryReadLimits): RepositoryWalkResult {
  const walkState = { incomplete: false, collected: 0 };
  const files = walkDirectory(root, ".", limits, 0, walkState);
  return { files, complete: !walkState.incomplete };
}

/**
 * Stat-scan a repository with the node reader (readdir + lstat only — no
 * file reads, no parses). The repository-map worker's smart trigger uses
 * it to make the "did anything actually change?" decision BEFORE building
 * anything, then hands the same walk to the generator (one walk, not
 * two); the intelligence bridge runs it ON THE MAIN THREAD for the
 * no-change TTL refresh (an 18ms verdict on this repository's tree vs a
 * ~1.25s one-shot worker spawn).
 */
export function scanRepositoryStats(
  rootPath: string,
  limits?: Readonly<Partial<RepositoryReadLimits>>,
): RepositoryWalkResult {
  return statWalk(rootPath, resolveRepositoryReadLimits(limits));
}

/** The per-walk mutable state: `incomplete` marks a walk that errored
 * mid-way (its listing is best-effort); `collected` carries the GLOBAL
 * entry count across every directory of one walk — the ceiling it is
 * checked against (`limits.maximumEntries`) is per-walk, not per-directory. */
type WalkState = { incomplete: boolean; collected: number };

function walkDirectory(
  root: string,
  dirPath: string,
  limits: RepositoryReadLimits,
  depth: number,
  walkState: WalkState,
): readonly FileInfo[] {
  if (depth > limits.maximumDepth) return [];
  if (dirPath !== "." && relativePathViolationKinds(dirPath).length > 0) {
    throw new HarnessError("Path violation during directory walk", "intelligence_path_violation");
  }
  const fullDir = join(root, dirPath === "." ? "" : dirPath);
  let entries: Dirent<string>[] = [];
  try {
    entries = readdirSync(fullDir, { withFileTypes: true });
  } catch (e) {
    handleError(e, { module: "intelligence-repository-map", operation: "walkDirectory" });
    // Mid-walk failure: this subtree is dropped from the listing exactly as
    // before, AND the walk is marked incomplete so the generator keeps the
    // previous stat snapshot instead of installing a partial one (a partial
    // snapshot must never masquerade as the tree's state).
    walkState.incomplete = true;
    return [];
  }
  const results: FileInfo[] = [];
  for (const entry of entries) {
    if (limits.excludedDirectoryNames.includes(entry.name)) continue;
    const entryPath = dirPath === "." ? entry.name : `${dirPath}/${entry.name}`;
    if (relativePathViolationKinds(entryPath).length > 0) continue;
    let stats: BigIntStats | undefined;
    try {
      stats = lstatSync(join(root, entryPath), { bigint: true, throwIfNoEntry: false });
    } catch (e) {handleError(e, { module: "intelligence-repository-map", operation: "catch" });
      continue;
    }
    if (!stats || stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      if (depth + 1 <= limits.maximumDepth) {
        results.push(...walkDirectory(root, entryPath, limits, depth + 1, walkState));
      }
      continue;
    }
    if (!stats.isFile()) continue;
    // Unconditional for the same reason as the read above.
    if (hasSecondName(stats.nlink)) continue;
    const ext = getSourceExtension(entryPath);
    if (!ext || !isSourceExtension(ext)) continue;
    // THE GLOBAL ENTRY CEILING (`repositoryMaxEntries`): one bound for the
    // whole walk, not per-directory. A tree that exceeds it REFUSES here —
    // a capped listing would be a lie twice over (a stat-diff against it
    // reports every file beyond the cap as "dropped" → a false "changed";
    // a map built from it is silently partial while claiming to be the
    // tree). The typed refusal routes honestly instead: the main-thread TTL
    // refresh takes the worker path, and the worker surfaces the limit as
    // a typed error the operator can raise (`repositoryMaxEntries`).
    if (walkState.collected >= limits.maximumEntries) {
      throw new HarnessError(
        `Directory walk exceeded the repositoryMaxEntries ceiling (${limits.maximumEntries}) — refusing rather than returning a partial tree`,
        "intelligence_walk_entries_exceeded",
      );
    }
    walkState.collected += 1;
    // Stat-only: `size` is the byte count of a regular file (identical to
    // what a read would return as `bytes.length`) and `mtimeMs` is the
    // stat-cache key. No read, no hash, no line count here.
    results.push(Object.freeze({
      path: entryPath,
      extension: ext,
      sizeBytes: Number(stats.size),
      contentHash: "",
      lineCount: 0,
      isSource: true,
      mtimeMs: Number(stats.mtimeMs),
    }));
  }
  return deepFreeze(results);
}
