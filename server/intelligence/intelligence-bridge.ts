/**
 * Intelligence bridge — server-side adapter to the canonical harness
 * intelligence modules. Provides repository map, dependency graph,
 * symbol search, and reuse discovery over a real project path.
 *
 * Symbol extract for every registered language runs in Isolated farm
 * children (tree-sitter WASM, crash-isolated). The map is the code-index
 * SSOT. This-turn census is injected at prompt assembly; conversation
 * memory is not a second index.
 */

import type { RepositoryMap } from "../kernel/canonical.ts";
import {
  diffStatSnapshot,
  isRepositoryMapCacheReusable,
  scanRepositoryStats,
  type RepositoryMapCache,
} from "../../engine/src/intelligence/repository-stat-scan.ts";
import { resolveIntelligenceConfig } from "../../engine/src/intelligence/intelligence-config.ts";
// ROOT_POLICY as a VALUE (the scan-exclusion owner the folder-watch filter
// derives from) — a separate line so the type-only canonical import above
// keeps its pinned shape (map-worker-nonblocking guard).
import { ROOT_POLICY, guarded } from "../kernel/canonical.ts";
import {
  buildDependencyGraph,
  graphStats,
  detectCycles,
  impactAnalysis,
  forwardDependencies,
  reverseDependencies,
  shortestPath,
} from "../../engine/src/intelligence/dependency-graph.ts";
import {
  hybridSearchSymbols,
  findSymbolUsage,
  buildBm25Index,
  type Bm25Index,
  type HybridSearchResult,
} from "../../engine/src/intelligence/symbol-search.ts";
import {
  findReuseCandidates,
  findDuplicates,
} from "../../engine/src/intelligence/reuse-discovery.ts";
import { QuickViewIndex, extractNameFromQuery, type QuickViewResult, type QuickViewBuiltState } from "../../engine/src/intelligence/quick-view.ts";
import { FileSliceIndex, type SliceResult, type ViewportResult, type SkeletonResult } from "../../engine/src/intelligence/file-slice.ts";
import {
  resolveExp474RetrievalConfig,
  retrieveRelevantFiles as retrieveRelevantFilesModule,
  type Exp474RetrievalResult,
} from "../../engine/src/intelligence/retrieval.ts";
import type { DependencyGraph } from "../kernel/canonical.ts";
import { watch, type FSWatcher } from "node:fs";
import { extname, relative } from "node:path";
import { runWorkerTask, getInFlightWorker } from "../run/worker-pool.ts";
import { ProjectPathError, MapNotReadyError } from "../kernel/errors.ts";
import { assertProjectPathOwnership, assertValidProjectPath, resolveWithinProject, type FsGate } from "../filesystem/fs-gate.ts";
import { getFarmConfig, getMapCacheTtlMs, getExp474RetrievalConfig, getHybridSearchOverrides, getAutoHealConfig, getQuickViewCacheTtlMs, getIntelligenceSearchDefaultLimit, getIntelligenceSearchMaxLimit, getRepoMapLanguagePreviewCount, getAutoIndexOnProjectAdd, getWatchIndexedProjects, getIndexWatchDebounceMs } from "../kernel/harness-config.ts";
import { installAfterProjectWrite } from "../filesystem/editor-bridge.ts";
import {
  installIntelligenceMapCacheSource,
  installIntelligenceMapCacheInvalidate,
} from "../kernel/canonical.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { registerComponent } from "../observability/component-registry.ts";
import {
  captureMtimeSnapshot,
  detectStaleIndex,
  detectBrokenEdges,
  buildAutoHealReport,
  type MtimeSnapshot,
  type AutoHealReport,
} from "./auto-heal.ts";

// ── Cache (per-project, by path) — built OFF the event loop ──
//
// The repository map is built in a `node:worker_threads` Worker so the
// CPU-heavy file walk + parse never blocks the Node event loop. Root-cause
// fix for the HTTP 502 chat-run wedge: the previous `getCachedMap` called
// `generateRepositoryMap` SYNCHRONOUSLY on a cache miss, blocking the
// single-threaded server for tens of seconds on a 475+ module codebase.
// Every HTTP request queued behind it (health, chat run, the auto-index
// itself) timed out → 502. The map is now built off-thread; the cache has
// three states:
// - "ready": the worker finished; the cached map is returned instantly.
// - "pending": the worker is still building; a shared Promise resolves
// when it finishes (concurrent callers for the same path
// await the SAME worker — one build per path, not N).
// - miss: no entry → spawn a worker (fire-and-forget for sync callers,
// awaited for async callers) and return "not ready".
//
// Synchronous callers (the run route's prompt injection, the intelligence
// routes/tools) get the cached map on a hit or a typed `MapNotReadyError`
// on a miss/pending — they NEVER block. The run route skips map injection
// when not ready (the map injects on the next run); the routes return 202
// "indexing"; the tools return a typed "indexing in progress" message.

interface ReadyEntry {
  readonly status: "ready";
  readonly map: RepositoryMap;
  readonly generatedAt: number;
  /** Mtime snapshot of a sample of the indexed source files, captured at
   * index time. Used by the auto-heal staleness check on every read so a
   * file change WITHIN the TTL window triggers an off-thread rebuild
   * (closes the TTL/staleness gap). Null when auto-heal is
   * disabled or the snapshot failed. */
  readonly mtimeSnapshot: MtimeSnapshot | null;
}

/** The worker URL for the repository-map worker (module-level so both
 * `buildMapInWorker` + `getCachedMapSync` reference the SAME href for the
 * pool's in-flight dedup key). */
const MAP_WORKER_URL = new URL("./repository-map-worker.ts", import.meta.url);

/** The cache holds ONLY "ready" entries now. The "pending" state is owned
 * by the worker pool's in-flight map (`getInFlightWorker`) — the pool sets
 * the in-flight entry BEFORE spawning (lowest-level "Relieve
 * Responsibilities": a bridge no longer has to remember to set a pending
 * entry; the pool handles it). */
const mapCache = new Map<string, ReadyEntry>();

/** Per-project incremental index state: the stat + extraction cache the
 * last SUCCESSFUL changed rebuild produced. Handed to the worker on the
 * next rebuild (the pool's workers are one-shot, so the baseline lives
 * HERE, keyed by project path — it survives worker restarts by
 * construction). Dropped with the map on invalidate. */
const mapIndexIncremental = new Map<string, RepositoryMapCache>();

/** Changed paths (repo-relative) reported by the harness's own editor
 * writes since the last rebuild started. Drained into the worker's
 * `changedPaths` at every rebuild start — the internal-write fast path
 * that skips the tree stat walk. */
const pendingWriteHints = new Map<string, Set<string>>();

/** The worker's answer to a rebuild: either a freshly built map + the
 * cache for next time, or "nothing indexable changed" (the smart
 * trigger's empty-diff gate — the caller keeps its map untouched). */
type MapWorkerResult = Readonly<
  | { changed: false; map: null; cache: null }
  | { changed: true; map: RepositoryMap; cache: RepositoryMapCache }
>;

/** Paths that changed while a rebuild was already in flight. When the
 * current worker finishes, `kickRebuild` starts one more pass so a write
 * during a build is not lost. */
const rebuildAgain = new Set<string>();

type FolderWatch = {
  readonly watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  /** The component-registry unregister for this watch — set on the creation
   * path, called by the SAME stopFolderWatch that closes the watcher, so a
   * folder watch cannot exist unregistered and a registry entry cannot
   * outlive its watcher. */
  unregisterComponent: () => void;
};
const folderWatches = new Map<string, FolderWatch>();

// ── Folder-watch path filter (root cause of the idle CPU burn) ──
//
// The recursive folder watch sees EVERY write under the project root —
// including runtime data the scanner never indexes (.git objects, the
// state directory's ledger WAL, node_modules, coverage output). Before
// this filter, each such write armed the debounce → noteIndexedFilesChanged
// → a repository-map worker that re-walked the whole tree and concluded
// "nothing changed" — measured at ~2s of CPU per 15s at idle when the
// cockpit's selected project is the repo itself (the observability ledger
// WAL ticks 1-2×/s inside the state directory). The exclusion set is NOT
// a second list: it is derived from the SAME owner the scanner walks
// with (`ROOT_POLICY.configuration.repositoryScanExclusions`, the
// authority repository-map.ts's walk consumes), so a path the scan would
// never index can never arm a rebuild here either.

/** Directory-name segments the scan prunes — derived once from the
 * canonical owner (the policy is deep-frozen, so this cannot drift). */
const WATCH_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(
  ROOT_POLICY.configuration.repositoryScanExclusions,
);

/**
 * Should a folder-watch event on `filename` (relative to the watched
 * project root) arm an index rebuild? `false` only for paths under a
 * scan-excluded directory. A filename the platform did not report
 * (`undefined` / `null` / empty — "can't tell") stays indexable: arming
 * the rebuild is the conservative default and preserves the pre-filter
 * behavior for every event that cannot be classified. Segment matching
 * is exact-name (`node_modules`, never `node_modules-extra`) and applies
 * to any segment — the same shape the scanner prunes with, excluding
 * `node_modules/x.js` and `src/coverage/x.js` alike.
 */
export function isIndexableWatchFilename(filename: string | null | undefined): boolean {
  if (typeof filename !== "string" || filename.length === 0) return true;
  for (const segment of filename.split(/[\\/]+/)) {
    if (WATCH_EXCLUDED_DIRECTORY_NAMES.has(segment)) return false;
  }
  return true;
}

function stopFolderWatch(projectPath: string): void {
  const entry = folderWatches.get(projectPath);
  if (entry === undefined) return;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.watcher.close();
  entry.unregisterComponent();
  folderWatches.delete(projectPath);
}

function watchIndexedFolder(projectPath: string): void {
  if (!getWatchIndexedProjects()) return;
  if (folderWatches.has(projectPath)) return;
  // RESOLVED WHEN THE WATCH IS ARMED, never inside its callback: a config
  // read in the callback throws `config_unreadable` the moment the file is
  // half-saved, and an exception out of a watch callback is uncaught — it
  // exits the server (wf1a-design H-1). A settings change applies to the
  // next watch armed.
  const debounceMs = getIndexWatchDebounceMs();
  try {
    // persistent: false — THE WATCHER MUST NEVER HOLD THE PROCESS OPEN.
    // Measured on linux/Node 24: a RECURSIVE fs.watch creates internal
    // FSEventWrap handles that the public `watcher.unref()` does NOT reach,
    // so a bounded script that imports this module, builds one map, and
    // finishes stays alive indefinitely on the watcher's handles (a leaked
    // coverage probe ran 15.5h past its 20s deadline this way).
    // `persistent: false` makes the watcher non-holding FROM CREATION for
    // every internal handle — the forgetting-is-impossible shape: no
    // shutdown call, no unref discipline, nothing to remember. While the
    // server lives its HTTP listener holds the loop, so the watcher stays
    // fully functional; the moment the last real handle closes, the process
    // (and the watcher with it) exits. `watcher.unref()` stays as the
    // documented belt-and-braces for the non-recursive fallback shape.
    const watcher = watch(projectPath, { recursive: true, persistent: false }, guarded("intelligence.watch.event", (_eventType, filename) => {
      // Filter BEFORE arming the debounce timer: an event under a
      // scan-excluded directory (state WAL, .git, node_modules, …) is
      // invisible to the index, so rebuilding on it is pure waste — the
      // walk re-runs and concludes "nothing changed". See
      // isIndexableWatchFilename for the conservative undefined case.
      if (!isIndexableWatchFilename(filename)) return;
      const entry = folderWatches.get(projectPath);
      if (entry === undefined) return;
      if (entry.timer !== null) clearTimeout(entry.timer);
      const timer = setTimeout(guarded("intelligence.watch.debounce", () => {
        entry.timer = null;
        noteIndexedFilesChanged(projectPath);
      }), debounceMs);
      timer.unref();
      entry.timer = timer;
    }));
    watcher.unref();
    watcher.on("error", guarded("intelligence.watch.error", (err: unknown) => {
      webWarn("intelligence", "project folder watch failed", () => ({
        path: projectPath,
        error: err instanceof Error ? err.message : String(err),
      }));
      stopFolderWatch(projectPath);
    }));
    // ANATOMY REGISTRATION — at the owner, on the watch-creation path:
    // every folder watch this bridge holds is a registry component for
    // exactly its lifetime (removed by the stopFolderWatch above).
    const unregisterComponent = registerComponent({
      kind: "folder-watch",
      label: projectPath,
      provenance: "server/intelligence/intelligence-bridge.ts watchIndexedFolder",
      facts: { path: projectPath, recursive: true },
    });
    folderWatches.set(projectPath, { watcher, timer: null, unregisterComponent });
  } catch (err) {
    webWarn("intelligence", "project folder watch not started", () => ({
      path: projectPath,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

function onMapReady(projectPath: string): void {
  watchIndexedFolder(projectPath);
}

/**
 * The no-change TTL refresh — ONE owner for the "verified against disk,
 * nothing changed" outcome, fed from BOTH verdict sources: the worker's
 * `unchanged` result and the main-thread stat walk below. NO map swap (the
 * cached map object is kept as-is, so map-derived artifacts stay valid), NO
 * new mtime snapshot, NO cache write. Only the TTL's `generatedAt` is
 * refreshed — "verified against disk at time T" — which is the same
 * once-per-TTL derived-artifact invalidation the old full-rebuild-per-TTL
 * shape already paid.
 */
function refreshUnchangedTtl(projectPath: string): void {
  const entry = mapCache.get(projectPath);
  if (entry !== undefined) {
    mapCache.set(projectPath, { ...entry, generatedAt: Date.now() });
    onMapReady(projectPath);
    return;
  }
  // Unchanged with nothing cached cannot happen (a cache-less worker always
  // builds); if it ever does, drop the incremental baseline so the next
  // read rebuilds fully instead of looping on "unchanged".
  mapIndexIncremental.delete(projectPath);
}

/**
 * The MAIN-THREAD no-change verdict for a TTL-expired read. The original design
 * put the stat walk in the worker for big-tree syscall cost; measured on
 * THIS repository's real tree (2,341 source files, warm cache), the
 * readdir+lstat walk + diff costs ~18ms median — while the one-shot worker
 * that used to own this verdict cost ~1.25s of CPU per refresh (module
 * transform + tree-sitter WASM init at boot, plus the structured-clone of
 * the whole previousCache in and out). So the no-change verdict runs here,
 * ONCE per TTL window, and the worker is spawned ONLY when the diff is
 * non-empty (or the walk cannot conclude): the changed-file rebuild keeps
 * the worker. Mirrors the worker's own smart-trigger condition exactly —
 * no hints pending, a reusable previousCache, a COMPLETE walk, an empty
 * diff. Returns true when the TTL was refreshed without a worker.
 *
 * THE SIZE DOOR: the walk's cost is O(tree) syscalls paid on the request
 * thread, so it is bounded. `previousCache.stats.size` — the previous
 * scan's own count — is known PRE-walk: above
 * `mainThreadStatWalkMaxEntries` (the intelligence config owner's door
 * bound, default 20,000) the walk is exactly the big-tree case the worker
 * exists for and this verdict declines it up front (return false → the
 * worker path — the big-tree window belongs to the worker); at or below it
 * the walk runs here as measured. The walk itself carries its own hard bound
 * (`repositoryMaxEntries`, global per walk) and refuses with a typed
 * limit error when a tree exceeds it — that refusal lands in the catch
 * below and also takes the worker path, so a misconfigured door (set
 * above the walk bound) still never wedges the request thread.
 */
function ttlRefreshWithoutWorker(projectPath: string): boolean {
  // A worker already in flight owns this window's verdict — join it, never
  // race it.
  if (getInFlightWorker<MapWorkerResult>(MAP_WORKER_URL, projectPath) !== undefined) return false;
  // Pending editor-write hints say bytes changed — the hinted rebuild owns it.
  const hints = pendingWriteHints.get(projectPath);
  if (hints !== undefined && hints.size > 0) return false;
  const previousCache = mapIndexIncremental.get(projectPath);
  if (!isRepositoryMapCacheReusable(previousCache)) return false;
  // THE SIZE DOOR (pre-walk): a previous scan bigger than the door bound
  // costs more main-thread syscall time than the no-change verdict is
  // worth — hand the window to the worker.
  if (previousCache.stats.size > resolveIntelligenceConfig().mainThreadStatWalkMaxEntries) return false;
  try {
    const scan = scanRepositoryStats(projectPath);
    if (!scan.complete) return false;
    const diff = diffStatSnapshot(scan.files, previousCache);
    if (diff.dirty.length > 0 || diff.dropped.length > 0) return false;
    refreshUnchangedTtl(projectPath);
    return true;
  } catch (err) {
    // The walk itself failed (not "found changes") — degrade to the worker
    // path, whose own typed error channel records the failure. This is a
    // routing decision, not a swallowed cause: the worker retries the same
    // walk and its error surfaces through MapNotReadyError handling.
    webWarn("intelligence", "main-thread stat walk failed; falling back to the worker rebuild", () => ({
      path: projectPath,
      error: err instanceof Error ? err.message : String(err),
    }));
    return false;
  }
}

/**
 * Spawn (or reuse) a Worker thread that builds the repository map for
 * `projectPath` off the event loop. Returns a Promise that resolves with
 * the map. Concurrent calls for the SAME path share one worker (the pool
 * dedups the spawn via the pending entry's promise); a fresh call for a
 * different path spawns its own worker. On success the cache entry
 * transitions to "ready"; on failure the entry is removed so the next call
 * can retry.
 *
 * SPO: the spawn (execArgv, `new Worker`, message/error/exit/timeout
 * handlers, cleanup) is owned by the worker pool (`server/worker-pool.ts`)
 * the SINGLE owner of backend `node:worker_threads` spawning. This
 * bridge no longer calls `new Worker(...)` directly. The pool handles
 * timeout (configurable — fixes the "worker-hang → permanent 'not ready'"
 * bug), error mapping (consistent typed errors), concurrency cap, and
 * shutdown cleanup. The pool ALSO owns the in-flight dedup (the "pending"
 * entry) — it sets the in-flight entry BEFORE spawning, so this bridge no
 * longer needs to manually set a pending cache entry. Concurrent callers
 * are deduped at the pool (lowest level) — no bridge can forget.
 */
function buildMapInWorker(projectPath: string, changedPathHints?: readonly string[]): Promise<MapWorkerResult> {
  const previousCache = mapIndexIncremental.get(projectPath);
  const result = runWorkerTask<MapWorkerResult>({
    workerUrl: MAP_WORKER_URL,
    workerData: {
      projectPath,
      // Resolved HERE, from the main thread's settings snapshot: a worker
      // isolate that imported the config owner would read the FILE on its
      // own (a store that went bad after boot would fail the build).
      farm: getFarmConfig(),
      ...(previousCache !== undefined ? { previousCache } : {}),
      ...(changedPathHints !== undefined ? { changedPaths: changedPathHints } : {}),
    },
    errorClass: MapNotReadyError,
    label: "repository-map",
    dedupKey: projectPath,
    validateOk: (msg) => {
      const m = msg as { map?: RepositoryMap; cache?: RepositoryMapCache; unchanged?: boolean };
      if (m.unchanged === true) return { changed: false, map: null, cache: null };
      if (m.map !== undefined && m.cache !== undefined) {
        return { changed: true, map: m.map, cache: m.cache };
      }
      return undefined;
    },
  });
  // The pool's in-flight entry dedups concurrent callers. This bridge only
  // caches the READY result (no pending entry — the pool owns that state).
  void result.then(
    (outcome) => {
      if (!outcome.changed) {
        // The smart trigger's empty-diff gate (the worker's half — the
        // main-thread half lives in ttlRefreshWithoutWorker; ONE refresh
        // owner feeds both).
        refreshUnchangedTtl(projectPath);
        return;
      }
      // Auto-heal: capture an mtime snapshot of a sample of the
      // indexed source files so subsequent reads can detect file changes
      // WITHIN the TTL window (the TTL alone serves stale data until it
      // expires). Best-effort: a snapshot failure (e.g. auto-heal
      // disabled) → null, and staleness detection is skipped (TTL-only
      // behavior is preserved).
      let snapshot: MtimeSnapshot | null = null;
      try {
        if (getAutoHealConfig().enabled) {
          snapshot = captureMtimeSnapshot(projectPath, outcome.map);
        }
      } catch (err) {
        // A snapshot failure must never block the map from being served.
        // Route through the centralized debug bridge. captureMtimeSnapshot already logs per-file
        // stat failures via webWarn; this catches a higher-level failure.
        webWarn("auto-heal", "mtime snapshot capture failed (staleness detection disabled until next rebuild)", () => ({ projectPath, error: err instanceof Error ? err.message : String(err) }));
        snapshot = null;
      }
      mapCache.set(projectPath, { status: "ready", map: outcome.map, generatedAt: Date.now(), mtimeSnapshot: snapshot });
      mapIndexIncremental.set(projectPath, outcome.cache);
      onMapReady(projectPath);
    },
    () => { mapCache.delete(projectPath); },
  );
  return result;
}

/**
 * Start an off-thread map build, draining any editor-write hints collected
 * for the project (hints are facts about disk state — every rebuild
 * consumes them). When the pass finishes, a write that landed during it
 * starts one more. Readers that merely join an in-flight build must NOT
 * mark dirty — that would rebuild after every concurrent poll.
 */
function startRebuild(projectPath: string): Promise<MapWorkerResult> {
  const hints = drainPendingWriteHints(projectPath);
  const done = buildMapInWorker(projectPath, hints);
  // `done` already carries the cache-management handlers installed in
  // buildMapInWorker, so it is consumed. The housekeeping here is DETACHED,
  // though: a `void done.finally(...)` would re-reject into a brand-new
  // promise nobody owns, and a background build failure surfaced as an
  // unhandled promise rejection (measured: worker pool full while suites
  // ran in parallel). Settle into a never-rejecting chain instead, keep
  // the re-kick in both outcomes exactly as before, and route the failure
  // through the debug bridge so it is observed rather than escaped.
  // The promise handed back to awaiters still rejects honestly.
  const settled = done.then(
    () => undefined,
    (err: unknown) => {
      webWarn("intelligence", "background map rebuild failed", () => ({
        path: projectPath,
        error: err instanceof Error ? err.message : String(err),
      }));
      return undefined;
    },
  );
  void settled.then(() => {
    if (rebuildAgain.delete(projectPath)) {
      void startRebuild(projectPath);
    }
  });
  return done;
}

function joinOrStartRebuild(projectPath: string): Promise<MapWorkerResult> {
  const inFlight = getInFlightWorker<MapWorkerResult>(MAP_WORKER_URL, projectPath);
  if (inFlight !== undefined) return inFlight;
  return startRebuild(projectPath);
}

/** Take (and clear) the editor-write hints collected for a project. Hints
 * are only ever ADDED knowledge: a rebuild without them does a full stat
 * walk and reconciles everything, so a lost hint can cost a read, never a
 * missed change. */
function drainPendingWriteHints(projectPath: string): readonly string[] | undefined {
  const set = pendingWriteHints.get(projectPath);
  if (set === undefined || set.size === 0) return undefined;
  const paths = [...set];
  set.clear();
  return paths;
}

/** Files on disk changed: rebuild, or mark dirty if a pass is already running. */
function kickRebuildAfterWrite(projectPath: string): void {
  const inFlight = getInFlightWorker<MapWorkerResult>(MAP_WORKER_URL, projectPath);
  if (inFlight !== undefined) {
    rebuildAgain.add(projectPath);
    return;
  }
  void startRebuild(projectPath);
}

/**
 * Synchronous cache read — NEVER blocks the event loop. Returns the cached
 * map on a hit, or `null` on a miss/pending (after fire-and-forget
 * triggering a worker build for a miss). Callers that need the map
 * synchronously should throw a typed `MapNotReadyError` on `null` so the
 * run route (skip injection) and routes (202 status) can degrade
 * gracefully instead of wedging the server.
 */
function getCachedMapSync(projectPath: string): RepositoryMap | null {
  assertValidProjectPath(projectPath);
  const ttl = getMapCacheTtlMs();
  const now = Date.now();
  const entry = mapCache.get(projectPath);
  if (entry !== undefined) {
    // The cache holds ONLY "ready" entries now (the pool owns the
    // "pending"/in-flight state). The stale check + rebuild fire-and-
    // forget applies to a ready entry.
    if (now - entry.generatedAt < ttl) {
      // Auto-heal: even within the TTL window, detect file
      // drift via the mtime snapshot. When the index is stale (files
      // changed/vanished), fire-and-forget a rebuild off-thread and
      // return the stale map for THIS call (the rebuild populates the
      // cache for the next read). This closes the TTL/staleness gap
      // without a manual re-index button. Only kick off a build when
      // no worker is already in flight (pool-owned dedup).
      if (entry.mtimeSnapshot !== null && isIndexStale(entry.mtimeSnapshot)) {
        kickRebuildAfterWrite(projectPath);
      }
      return entry.map;
    }
    // TTL expired — the no-change verdict runs ON THE MAIN THREAD first (a
    // stat-only walk, ~18ms on this repository's tree, once per TTL window);
    // the worker is spawned ONLY when the walk finds changes, cannot
    // conclude, or has no reusable baseline. Return the stale map for this
    // call either way.
    if (!ttlRefreshWithoutWorker(projectPath)) void joinOrStartRebuild(projectPath);
    return entry.map;
  }
  // No ready entry. Join an in-flight worker or start one. A concurrent
  // read does not dirty the pass.
  void joinOrStartRebuild(projectPath);
  return null;
}

/**
 * Async cache read — returns a Promise resolving with the map. On a hit,
 * resolves immediately with the cached map. On a miss/pending, awaits the
 * (shared) worker build. Used by the auto-index endpoint (which already
 * runs in an async handler) so the FIRST request triggers + waits for the
 * build without blocking any other HTTP request.
 */
async function getCachedMapAsync(projectPath: string): Promise<RepositoryMap> {
  assertValidProjectPath(projectPath);
  const ttl = getMapCacheTtlMs();
  const now = Date.now();
  const entry = mapCache.get(projectPath);
  if (entry !== undefined && now - entry.generatedAt < ttl) {
    // Auto-heal: check staleness WITHIN the TTL window — the same check the
    // sync path (`getCachedMapSync`) makes. Without this, a project accessed
    // only via the async path (e.g. the quality-bridge's
    // `getQualityIndicatorAsync`) would never auto-heal a stale index within
    // the TTL window: files changed on disk would be served stale until the
    // TTL expired, with no background rebuild triggered. The sync path
    // returns the stale map for THIS call + fire-and-forgets a rebuild so the
    // NEXT read is fresh; the async path mirrors that contract (return the
    // cached map immediately, rebuild off-thread, only when no worker is
    // already in flight — the pool dedups).
    if (entry.mtimeSnapshot !== null && isIndexStale(entry.mtimeSnapshot)) {
      kickRebuildAfterWrite(projectPath);
    }
    return entry.map;
  }
  // The main-thread no-change verdict first (same condition as the sync
  // path); the worker is awaited ONLY when the walk finds changes or cannot
  // conclude.
  if (!ttlRefreshWithoutWorker(projectPath)) {
    const outcome = await joinOrStartRebuild(projectPath);
    if (outcome.changed) return outcome.map;
  }
  // The verdict (whichever half made it) concluded "nothing changed": the
  // cached map was kept (and its TTL refreshed). An unchanged outcome with
  // no cached entry is impossible by construction (a cache-less worker
  // builds); treat it as not-ready rather than fabricating a map.
  const after = mapCache.get(projectPath);
  if (after !== undefined) return after.map;
  throw new MapNotReadyError(
    "Repository map is still indexing in the background. Retry shortly.",
    "map_not_ready",
  );
}

/**
 * Return the cached map or throw a typed `MapNotReadyError` when it isn't
 * ready. The error is `retryable` (the worker is building the map in the
 * background; the next call will likely succeed). Used by the synchronous
 * intelligence accessors so the routes/tools can catch + degrade.
 */
function requireCachedMap(projectPath: string): RepositoryMap {
  const map = getCachedMapSync(projectPath);
  if (map === null) {
    throw new MapNotReadyError(
      "Repository map is still indexing in the background. Retry shortly.",
      "map_not_ready",
    );
  }
  return map;
}

function invalidateCache(projectPath: string): void {
  mapCache.delete(projectPath);
  mapIndexIncremental.delete(projectPath);
  pendingWriteHints.delete(projectPath);
  stopFolderWatch(projectPath);
  // Every artifact derived from the map is dropped with it. Iterating the
  // registry rather than naming each cache is what keeps this correct: a
  // derived artifact added later is evicted because it registered itself,
  // not because someone remembered to add a line here.
  for (const cache of derivedFromMapCaches) cache.delete(projectPath);
}

// ── Artifacts derived from the repository map (tied to its generation) ──
//
// The dependency graph and the BM25 search index are both pure folds over the
// cached map, both expensive enough that rebuilding per request is the
// difference between a fast and a slow surface, and both valid for exactly as
// long as the map they came from. That is one pattern, so it is one mechanism:
// each derived artifact keys its cache entry on the map's `generatedAt`, so a
// rebuilt map (the auto-heal mtime-staleness path installs a NEW `generatedAt`)
// invalidates it automatically. No separate TTL that could drift out of step
// with the map's, and no second cache shape to keep in sync with this one.

interface DerivedEntry<T> {
  readonly value: T;
  /** The `generatedAt` of the map entry this artifact was derived from. When
   * the map is rebuilt, this no longer matches and the artifact is rebuilt. */
  readonly mapGeneratedAt: number;
}

/** Every derived cache, so invalidation can iterate instead of enumerate. */
const derivedFromMapCaches: Set<Map<string, DerivedEntry<unknown>>> = new Set();

/**
 * Build `derive(map)` once per map generation for `projectPath`. Throws
 * `MapNotReadyError` when the map is not cached yet (the same contract as
 * `requireCachedMap`). The map entry is read ONCE and both the value and the
 * `generatedAt` stamp come from that read, so the tie cannot race: this is
 * synchronous, and the map cache is only mutated from an async callback that
 * runs in a later microtask.
 */
function deriveFromMap<T>(
  cache: Map<string, DerivedEntry<T>>,
  projectPath: string,
  derive: (map: RepositoryMap) => T,
): { value: T; map: RepositoryMap } {
  // requireCachedMap throws MapNotReadyError on a miss/pending (the contract
  // the routes/tools rely on). It also fires a worker build on a miss.
  requireCachedMap(projectPath);
  const mapEntry = mapCache.get(projectPath);
  if (mapEntry === undefined) {
    // Defensive: requireCachedMap succeeded so the entry existed an instant
    // ago. If it was evicted between the two reads (an auto-heal rebuild
    // replaced it), treat as not ready so the caller retries.
    throw new MapNotReadyError(
      "Repository map is still indexing in the background. Retry shortly.",
      "map_not_ready",
    );
  }
  const cached = cache.get(projectPath);
  if (cached !== undefined && cached.mapGeneratedAt === mapEntry.generatedAt) {
    return { value: cached.value, map: mapEntry.map };
  }
  const value = derive(mapEntry.map);
  cache.set(projectPath, { value, mapGeneratedAt: mapEntry.generatedAt });
  return { value, map: mapEntry.map };
}

/** Register a derived cache so `invalidateCache` drops it automatically. */
function registerDerivedCache<T>(): Map<string, DerivedEntry<T>> {
  const cache = new Map<string, DerivedEntry<T>>();
  derivedFromMapCaches.add(cache as Map<string, DerivedEntry<unknown>>);
  return cache;
}

const graphCache = registerDerivedCache<{ graph: DependencyGraph; modulePaths: readonly string[] }>();
const bm25Cache = registerDerivedCache<Bm25Index>();

/**
 * The dependency graph for `projectPath`. The map is returned too, so callers
 * needing both (e.g. `retrieveRelevantFiles`) avoid a second cache read.
 */
function requireCachedGraph(projectPath: string): { graph: DependencyGraph; modulePaths: readonly string[]; map: RepositoryMap } {
  const { value, map } = deriveFromMap(graphCache, projectPath, (m) => ({
    graph: buildDependencyGraph(m),
    modulePaths: m.modules.map((mod) => mod.path),
  }));
  return { graph: value.graph, modulePaths: value.modulePaths, map };
}

/**
 * The BM25 search index for `projectPath`. Without this, every search — every
 * HTTP call, every `code.search` block read, every LLM `search_symbols`
 * invocation — re-walked and re-tokenized every symbol in the project before
 * scoring a single candidate.
 */
function requireCachedBm25Index(projectPath: string): Bm25Index {
  return deriveFromMap(bm25Cache, projectPath, buildBm25Index).value;
}

/**
 * Auto-heal staleness probe. Re-stats the mtime snapshot's files and reports
 * whether the index is stale (files changed/vanished since index time). Pure
 * over the filesystem (only `statSync`). Never throws. Used by
 * `getCachedMapSync` to decide whether to trigger an off-thread rebuild
 * within the TTL window.
 */
function isIndexStale(snapshot: MtimeSnapshot): boolean {
  if (!getAutoHealConfig().enabled) return false;
  return detectStaleIndex(snapshot).stale;
}

// ── Public API ──

/**
 * Synchronous repository-map read. Returns the cached map or throws a
 * typed `MapNotReadyError` when the worker is still indexing. NEVER
 * blocks the event loop. Callers that can wait should use
 * `getRepositoryMapAsync` instead.
 */
export function getRepositoryMap(projectPath: string, gate?: FsGate): RepositoryMap {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  return requireCachedMap(projectPath);
}

/**
 * Async repository-map read. Awaits the (shared) worker build on a
 * miss/pending. Used by the auto-index endpoint so the first request
 * triggers + waits for the build WITHOUT blocking any other HTTP
 * request (the worker runs off the event loop).
 */
export async function getRepositoryMapAsync(projectPath: string, gate?: FsGate): Promise<RepositoryMap> {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  return getCachedMapAsync(projectPath);
}

export function getDependencyGraph(projectPath: string, gate?: FsGate): Readonly<{
  graph: DependencyGraph;
  stats: ReturnType<typeof graphStats>;
  cycles: ReturnType<typeof detectCycles>;
  /** The full module path list (including isolated nodes with no edges).
   * The canonical `DependencyGraph` only exposes `nodeCount` + adjacency
   * maps built from edges — isolated nodes are NOT keys in the adjacency
   * maps, so a consumer that needs the full node list (e.g. the graph
   * route's degree-map seed) cannot derive it from the graph alone. This
   * field exposes the module paths from the SAME cached map the graph was
   * built from, so the route avoids a redundant second bridge call (which
   * would repeat the ownership DB query + path-validation statSync). */
  modulePaths: readonly string[];
}> {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const { graph, modulePaths } = requireCachedGraph(projectPath);
  return {
    graph,
    stats: graphStats(graph),
    cycles: detectCycles(graph),
    modulePaths,
  };
}

export function getImpactAnalysis(projectPath: string, filePath: string, gate?: FsGate): Readonly<{
  directlyAffected: readonly string[];
  transitivelyAffected: readonly string[];
  totalAffected: number;
}> {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const { graph } = requireCachedGraph(projectPath);
  return impactAnalysis(graph, normalizeGraphKey(filePath, projectPath));
}

export function getForwardDeps(projectPath: string, filePath: string, gate?: FsGate): readonly string[] {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const { graph } = requireCachedGraph(projectPath);
  return forwardDependencies(graph, normalizeGraphKey(filePath, projectPath));
}

export function getReverseDeps(projectPath: string, filePath: string, gate?: FsGate): readonly string[] {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const { graph } = requireCachedGraph(projectPath);
  return reverseDependencies(graph, normalizeGraphKey(filePath, projectPath));
}

/**
 * Normalize a user/LLM-supplied file path to the dependency-graph's node-
 * key form (a path RELATIVE to the project root, with no leading `./` and
 * no resolved `..` segments). The graph's adjacency maps are keyed by
 * `mod.path`, which the repository map stores as a relative path
 * (`relativePathViolationKinds` rejects absolute / `..` / backslash at
 * index time). Without this normalization, a caller-supplied `filePath`
 * like `./src/foo.ts` or an absolute path SILENTLY returned an empty result
 * (exact-key Map.get missed) — a correctness bug masked as "no impact".
 *
 * Deny-by-default (rule): a `filePath` that escapes the project root
 * (`../../etc`) throws `PathTraversalError` at the bridge choke point via
 * `resolveWithinProject` (CWE-22) rather than silently returning empty.
 * The single owner of the resolve + within-root check is `fs-gate.ts`
 * (No Scattered Helpers).
 */
function normalizeGraphKey(filePath: string, projectPath: string): string {
  const abs = resolveWithinProject(filePath, projectPath);
  const rel = relative(projectPath, abs);
  return rel;
}

// ── Dependency path (structural load-path analysis) ──
//
// Exposes the harness's `shortestPath` BFS (previously zero callers) as an
// honest "how are these two files connected through imports?" answer. Three
// hard rules, all first-class in the shape rather than prose in a route:
// - "No path" is an ANSWER (connected: false + plain-language summary),
//   never an error and never a bare empty array a UI renders as blank.
// - Direction is explicit: the import direction (`from` imports `to`) is
//   searched first; when it yields nothing the reverse is searched too, and
//   `direction` says which one connected. A one-direction "no path" over a
//   directed graph would be confidently wrong half the time.
// - The basis is carried IN the result (`basis`): the graph is built from
//   statically-resolved import statements only — `buildDependencyGraph`
//   skips dynamic imports and unresolvable specifiers — so a "no path"
//   through those is stated as a limitation, not presented as certainty.

/** One step of a dependency path, in IMPORT direction (importer → imported). */
export interface DependencyPathHop {
  /** The file containing the import statement. */
  readonly importer: string;
  /** The file the import resolves to. */
  readonly imported: string;
  /** The import specifier as written in `importer` (one representative
   * statement when several resolve to the same file). Null means the edge
   * exists in the adjacency but no specifier could be recovered — an honest
   * "unknown", never a fabricated one. */
  readonly specifier: string | null;
}

export interface DependencyPathResult {
  /** The two files, normalized to the graph's repo-relative key form. */
  readonly from: string;
  readonly to: string;
  /** Whether each file is a module the index knows about. A file missing
   * from the index gets "not indexed" as the answer — NOT a bare "no path",
   * which would read as a verdict about the code when it is really a verdict
   * about the query. */
  readonly inIndex: Readonly<{ from: boolean; to: boolean }>;
  readonly connected: boolean;
  /** Which search connected: "forward" = `from` imports `to` (directly or
   * through intermediaries); "reverse" = the opposite direction was the one
   * that connected; "same-file" = both arguments are one file; null = not
   * connected (or not answerable — see `inIndex`). */
  readonly direction: "forward" | "reverse" | "same-file" | null;
  /** The shortest chain, each hop in import direction. Empty when there is
   * no chain to show. */
  readonly hops: readonly DependencyPathHop[];
  /** Plain-language statement of the answer, safe to render verbatim. */
  readonly summary: string;
  /** What the answer is computed from — carried in-band because a
   * confidently-wrong "no path" is dangerous without it. */
  readonly basis: string;
}

const DEPENDENCY_PATH_BASIS =
  "Computed from the import statements captured when the project was indexed. Dynamic imports and imports that could not be resolved to a file inside the project are not part of this graph, so a connection that exists only through those would not be found.";

/** Map every graph edge (from→to) to one representative import specifier. */
function edgeSpecifiers(graph: DependencyGraph): ReadonlyMap<string, string> {
  const bySpec = new Map<string, string>();
  for (const e of graph.edges) {
    const key = `${e.from}\u0000${e.to}`;
    if (!bySpec.has(key)) bySpec.set(key, e.specifier);
  }
  return bySpec;
}

/** Turn a BFS node chain into hops with the specifier per hop. */
function toHops(graph: DependencyGraph, nodes: readonly string[]): readonly DependencyPathHop[] {
  const specs = edgeSpecifiers(graph);
  const hops: DependencyPathHop[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const importer = nodes[i]!;
    const imported = nodes[i + 1]!;
    hops.push({ importer, imported, specifier: specs.get(`${importer}\u0000${imported}`) ?? null });
  }
  return hops;
}

/**
 * Pure dependency-path computation over an already-built graph. Exported
 * separately from `getDependencyPath` so tests can exercise every branch
 * (found / reverse-found / no-path / unknown-file / same-file) against real
 * graphs without the map cache or worker machinery.
 */
export function computeDependencyPath(
  graph: DependencyGraph,
  knownModules: ReadonlySet<string>,
  from: string,
  to: string,
): DependencyPathResult {
  const inIndex = { from: knownModules.has(from), to: knownModules.has(to) } as const;
  const base = { from, to, inIndex, basis: DEPENDENCY_PATH_BASIS };
  if (!inIndex.from || !inIndex.to) {
    const missing = [inIndex.from ? null : from, inIndex.to ? null : to].filter(
      (p): p is string => p !== null,
    );
    return {
      ...base,
      connected: false,
      direction: null,
      hops: [],
      summary: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not in the code index, so no import path can be computed. Check the file path, or re-index the project if the file is new.`,
    };
  }
  if (from === to) {
    return {
      ...base,
      connected: true,
      direction: "same-file",
      hops: [],
      summary: `Both arguments point to the same file: ${from}.`,
    };
  }
  const forwardChain = shortestPath(graph, from, to);
  if (forwardChain !== null) {
    const hops = toHops(graph, forwardChain);
    return {
      ...base,
      connected: true,
      direction: "forward",
      hops,
      summary:
        hops.length === 1
          ? `${from} imports ${to} directly.`
          : `${from} depends on ${to} through ${hops.length} import steps.`,
    };
  }
  const reverseChain = shortestPath(graph, to, from);
  if (reverseChain !== null) {
    const hops = toHops(graph, reverseChain);
    return {
      ...base,
      connected: true,
      direction: "reverse",
      hops,
      summary:
        hops.length === 1
          ? `No import path runs from ${from} to ${to}, but the connection exists the other way: ${to} imports ${from} directly.`
          : `No import path runs from ${from} to ${to}, but the connection exists the other way: ${to} depends on ${from} through ${hops.length} import steps.`,
    };
  }
  return {
    ...base,
    connected: false,
    direction: null,
    hops: [],
    summary: "Nothing connects these two files through imports, in either direction.",
  };
}

/**
 * Public bridge entry: dependency path between two files of a project.
 * Ownership-gated + path-normalized like every other project-scoped read.
 */
export function getDependencyPath(
  projectPath: string,
  fromFile: string,
  toFile: string,
  gate?: FsGate,
): DependencyPathResult {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const { graph, modulePaths } = requireCachedGraph(projectPath);
  const from = normalizeGraphKey(fromFile, projectPath);
  const to = normalizeGraphKey(toFile, projectPath);
  return computeDependencyPath(graph, new Set(modulePaths), from, to);
}

/**
 * Symbol search for every surface that offers it — the HTTP route, the
 * `code.search` block, and the LLM `search_symbols` tool all call THIS
 * function. Widening it here is what upgrades all three at once; a second
 * "hybrid search" entry point beside it would have left three callers to
 * remember to migrate, and the one nobody remembered would have kept
 * answering differently.
 *
 * Ranking is hybrid: BM25 over name+path tokens for queries that name a real
 * identifier, fuzzy subsequence matching for vague ones, with the balance
 * chosen per query. The returned confidence signals (`queryClass`,
 * `sealFired`, `biasDetected`, and the weights actually used) are reported
 * to the caller rather than kept private, so the UI and the LLM can see WHY
 * a ranking came out as it did instead of receiving a bare ordered list.
 */
export function searchCodeSymbols(
  projectPath: string,
  query: string,
  limit?: number,
  gate?: FsGate,
): HybridSearchResult {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const map = requireCachedMap(projectPath);
  // Clamp at the bridge choke point so NO caller can skip the config cap
  // (the route + the tool handler also clamp, but a future caller that
  // bypasses both would be capped here — the single lowest-level gate).
  const effectiveLimit = Math.min(limit ?? getIntelligenceSearchDefaultLimit(), getIntelligenceSearchMaxLimit());
  return hybridSearchSymbols(
    map,
    {
      name: query,
      kind: null,
      filePath: null,
      directory: null,
      exported: null,
      async: null,
      limit: effectiveLimit,
      matchMode: "fuzzy",
    } as Parameters<typeof hybridSearchSymbols>[1],
    getHybridSearchOverrides(),
    requireCachedBm25Index(projectPath),
  );
}

export function findCodeSymbolUsage(
  projectPath: string,
  symbolName: string,
  gate?: FsGate,
): ReturnType<typeof findSymbolUsage> {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const map = requireCachedMap(projectPath);
  return findSymbolUsage(map, symbolName);
}

export function findReuse(
  projectPath: string,
  query: string,
  limit?: number,
  gate?: FsGate,
): readonly { symbol: { name: string; kind: string; location: { filePath: string; line: number; column: number } }; filePath: string; score: number; reasons: readonly string[] }[] {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const map = requireCachedMap(projectPath);
  // Clamp at the bridge choke point (same single-lowest-level gate as
  // searchCodeSymbols above).
  const effectiveLimit = Math.min(limit ?? getIntelligenceSearchDefaultLimit(), getIntelligenceSearchMaxLimit());
  return findReuseCandidates(map, {
    name: query,
    kind: null,
    signature: null,
    directory: null,
    limit: effectiveLimit,
  } as Parameters<typeof findReuseCandidates>[1]);
}

export function findCodeDuplicates(projectPath: string, gate?: FsGate): ReturnType<typeof findDuplicates> {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const map = requireCachedMap(projectPath);
  return findDuplicates(map);
}

// ── EXP474 codebase-file retrieval (phrase n-gram + slot allocation) ──
// Ranks relevant source files for a natural-language query using the
// language-agnostic EXP474 algorithms (semantic lexical score + phrase
// n-gram + slot allocation + package/directory co-occurrence). Reuses the
// cached repository map + dependency graph. The ranking knobs are what the
// operator set (`getExp474RetrievalConfig`) resolved against the retrieval
// module's own defaults — the reader supplies no floors of its own, so an
// unset knob has one answer rather than one per reader.

export function retrieveRelevantFiles(
  projectPath: string,
  query: string,
  limit?: number,
  gate?: FsGate,
): Exp474RetrievalResult {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const { map, graph } = requireCachedGraph(projectPath);
  const options = resolveExp474RetrievalConfig(getExp474RetrievalConfig());
  const effectiveLimit = typeof limit === "number" && Number.isInteger(limit) && limit > 0
    ? { ...options, finalK: Math.min(limit, options.finalK) }
    : options;
  return retrieveRelevantFilesModule(map, graph, query, effectiveLimit);
}

export function invalidateProjectCache(projectPath: string, gate?: FsGate): void {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  invalidateCache(projectPath);
  quickViewIndexCache.delete(projectPath);
  fileSliceIndexCache.delete(projectPath);
}

/** Drop every finished project map this process is holding. Returns how many. */
export function invalidateAllMapCaches(): number {
  const paths = [...mapCache.keys()];
  for (const projectPath of paths) invalidateCache(projectPath);
  return paths.length;
}

/** Live map-cache readings for the exposure signals. */
export function getMapCacheExposureState(): Readonly<{
  cachedProjects: number;
  lastFileCount: number;
  lastSymbolCount: number;
}> {
  let lastFileCount = 0;
  let lastSymbolCount = 0;
  let latest = 0;
  for (const entry of mapCache.values()) {
    if (entry.generatedAt >= latest) {
      latest = entry.generatedAt;
      lastFileCount = entry.map.files.length;
      lastSymbolCount = entry.map.totalSymbols;
    }
  }
  return { cachedProjects: mapCache.size, lastFileCount, lastSymbolCount };
}

/** Wire the exposure signals/action to this process's map cache. */
export function installIntelligenceMapCacheExposureSource(): void {
  installIntelligenceMapCacheSource(getMapCacheExposureState);
  installIntelligenceMapCacheInvalidate(invalidateAllMapCaches);
}

/**
 * Start mapping a project if `codeIntelligence.autoIndexOnProjectAdd` is
 * on. Fire-and-forget: the Isolated farm runs off the event loop. A
 * finished map starts watching the folder. The map stays the symbol SSOT;
 * this-turn census is injected at prompt assembly, not stored as memory.
 */
export function beginIndexingIfConfigured(
  projectPath: string,
  gate?: FsGate,
): void {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  if (!getAutoIndexOnProjectAdd()) return;
  try {
    assertValidProjectPath(projectPath);
  } catch (err) {
    // Fire-and-forget means never failing the caller: a project over a
    // folder that is not (yet) on disk simply has nothing to map. Folder
    // presence is measured at read time, so creation, reads, re-links and
    // restores over a missing folder must still succeed — the explicit
    // map-intelligence calls keep the hard `project_path_missing` refusal.
    webWarn("intelligence", "auto-index skipped: project path unusable", () => ({
      path: projectPath,
      error: err instanceof Error ? err.message : String(err),
    }));
    return;
  }
  const cached = mapCache.get(projectPath);
  if (cached !== undefined) {
    onMapReady(projectPath);
    return;
  }
  void joinOrStartRebuild(projectPath).catch((err: unknown) => {
    webWarn("intelligence", "auto-index rebuild failed", () => ({
      path: projectPath,
      error: err instanceof Error ? err.message : String(err),
    }));
  });
}

/**
 * A successful editor write/create/delete of this project's files. Only
 * rebuilds a map we already hold or are building — a scratch write in a
 * test dir does not spawn a farm. `changedPath` (repo-relative) is the
 * harness's own write signal: it becomes a rebuild HINT so the rebuild
 * re-reads exactly that file instead of stat-walking the whole tree
 * (external writers get no hint — they arrive through the folder watch,
 * whose rebuilds do the full stat walk and diff).
 */
export function noteIndexedFilesChanged(projectPath: string, changedPath?: string): void {
  const watched =
    mapCache.has(projectPath) ||
    getInFlightWorker<MapWorkerResult>(MAP_WORKER_URL, projectPath) !== undefined ||
    rebuildAgain.has(projectPath) ||
    folderWatches.has(projectPath);
  if (!watched) return;
  if (typeof changedPath === "string" && changedPath.length > 0) {
    let hints = pendingWriteHints.get(projectPath);
    if (hints === undefined) {
      hints = new Set<string>();
      pendingWriteHints.set(projectPath, hints);
    }
    hints.add(changedPath);
  }
  kickRebuildAfterWrite(projectPath);
}

/** Boot: editor writes notify the map through one listener. */
export function installIndexRefreshFromEditorWrites(): void {
  installAfterProjectWrite(noteIndexedFilesChanged);
}

// ── Auto-heal signals ──
// Exposes the stale-index + broken-edge report for a project so the UI /
// quality layer / signals route can surface "index is stale, rebuilding"
// and "N broken import edges". Pure read over the cache + filesystem; never
// blocks (the mtime sample is bounded + stat-only).

/**
 * Build the auto-heal report for a project: staleness (from the mtime
 * snapshot) + broken dependency edges. Returns a "not indexed" report when
 * the map is not yet cached (no snapshot, no map → no stale + no broken
 * edges). The staleness check re-stats the snapshot's sampled files (bounded
 * by the adaptive sample size); the broken-edge check is a pure fold over
 * the cached map's module imports.
 */
export function getProjectAutoHealReport(projectPath: string, gate?: FsGate): AutoHealReport {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  assertValidProjectPath(projectPath);
  const entry = mapCache.get(projectPath);
  if (entry === undefined) {
    return buildAutoHealReport(null, null);
  }
  return buildAutoHealReport(entry.mtimeSnapshot, entry.map);
}

/**
 * Broken dependency edges for a project — imports whose `resolvedPath` is
 * null (the target file does not exist on disk). A non-empty list means the
 * code index references deleted/never-created files; the index should be
 * rebuilt. Returns an empty report when the map is not cached yet.
 */
export function getProjectBrokenEdges(projectPath: string, gate?: FsGate): ReturnType<typeof detectBrokenEdges> {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  assertValidProjectPath(projectPath);
  const entry = mapCache.get(projectPath);
  if (entry === undefined) {
    return { brokenEdges: [], count: 0 };
  }
  return detectBrokenEdges(entry.map);
}

// ── Quick-view (EXP398: 137× faster than grep, AST-based) ──
//
// the QuickViewIndex is built OFF the event loop in a
// `node:worker_threads` Worker — the same wedge-class fix as the repository
// map. Building it synchronously on a cache miss blocked the single-threaded
// HTTP server for seconds (a 475+ module codebase = 475+ babel parses). The
// cache now has the same three states as the map cache:
// - "ready": the worker finished; the rehydrated index is returned instantly.
// - "pending": the worker is still building; concurrent callers share ONE worker.
// - miss: spawn a worker (fire-and-forget for sync callers) + return "not ready".
// Synchronous callers (the `quick_view` tool) get the cached index on a hit or
// a typed `MapNotReadyError` on a miss/pending — they NEVER block. The tool
// handler catches `MapNotReadyError` and returns an "indexing in progress,
// retry shortly" message so the LLM retries instead of wedging the server.

interface QvReadyEntry {
  readonly status: "ready";
  readonly index: QuickViewIndex;
  readonly generatedAt: number;
}

/** The worker URL for the quick-view worker (module-level so both
 * `buildQuickViewIndexInWorker` + `getQuickViewIndex` reference the SAME
 * href for the pool's in-flight dedup key). */
const QUICK_VIEW_WORKER_URL = new URL("./quick-view-worker.ts", import.meta.url);

/** The cache holds ONLY "ready" entries now. The "pending" state is owned
 * by the worker pool's in-flight map (`getInFlightWorker`) — the pool sets
 * the in-flight entry BEFORE spawning. */
const quickViewIndexCache = new Map<string, QvReadyEntry>();

/**
 * Spawn (or reuse) a Worker thread that builds the QuickViewIndex for
 * `projectPath` off the event loop. Returns a Promise that resolves with
 * the rehydrated index. On success the cache entry transitions to "ready";
 * on failure the entry is removed so the next call can retry.
 *
 * SPO: the spawn is owned by the worker pool (`server/worker-pool.ts`).
 * This bridge no longer calls `new Worker(...)` directly. The pool handles
 * timeout, error mapping, concurrency cap, + shutdown cleanup. The pool
 * ALSO owns the in-flight dedup (the "pending" entry) — it sets the
 * in-flight entry BEFORE spawning, so this bridge no longer needs to
 * manually set a pending cache entry.
 */
function buildQuickViewIndexInWorker(projectPath: string): Promise<QuickViewIndex> {
  const statePromise = runWorkerTask<QuickViewBuiltState>({
    workerUrl: QUICK_VIEW_WORKER_URL,
    workerData: { projectPath },
    errorClass: MapNotReadyError,
    label: "quick-view",
    dedupKey: projectPath,
    validateOk: (msg) => (msg as { state?: QuickViewBuiltState }).state,
  });
  const indexPromise = statePromise.then((state) => {
    const index = QuickViewIndex.fromBuiltState(state);
    quickViewIndexCache.set(projectPath, { status: "ready", index, generatedAt: Date.now() });
    return index;
  });
  // On failure, delete the entry so the next call can retry. The pool's
  // typed rejection (MapNotReadyError) propagates to indexPromise; this
  // handler only clears the cache, it does not swallow the error.
  void indexPromise.then(undefined, () => { quickViewIndexCache.delete(projectPath); });
  return indexPromise;
}

/**
 * Synchronous quick-view index read — NEVER blocks the event loop. Returns
 * the cached index on a fresh hit, or throws a typed `MapNotReadyError` on a
 * miss/stale entry (after fire-and-forget triggering a worker build for a
 * miss/stale). Callers should catch `MapNotReadyError` and degrade
 * (the tool returns an "indexing in progress" message) instead of wedging.
 */
function getQuickViewIndex(projectPath: string): QuickViewIndex {
  const now = Date.now();
  const cached = quickViewIndexCache.get(projectPath);
  if (cached !== undefined && now - cached.generatedAt < getQuickViewCacheTtlMs()) {
    return cached.index;
  }
  // Miss or stale. Check if a worker is already in flight (pool-owned).
  // The pool's in-flight map is the SINGLE source of "is a worker
  // building?" — this bridge no longer maintains its own pending entry.
  // Only kick off a build when no worker is in flight (one build per path,
  // shared across concurrent callers — the pool dedups).
  if (getInFlightWorker<QuickViewBuiltState>(QUICK_VIEW_WORKER_URL, projectPath) === undefined) {
    void buildQuickViewIndexInWorker(projectPath);
  }
  throw new MapNotReadyError(
    "Quick-view index is still building in the background. Retry shortly.",
    "quick_view_not_ready",
  );
}

/**
 * Quick-view ALL edit locations for a symbol (EXP398): definition, callers,
 * clones, type refs, tests, and docs — a structured AST-based replacement
 * for grep. Returns a frozen QuickViewResult. Throws `MapNotReadyError` when
 * the background worker is still building the index (the caller catches it
 * and returns an "indexing in progress" message — never blocks).
 */
export function quickView(projectPath: string, query: string, gate?: FsGate): QuickViewResult {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const name = extractNameFromQuery(query) ?? query;
  const index = getQuickViewIndex(projectPath);
  return index.query(name);
}

// ── File-slice (EXP334: 187 tokens vs full file) ──

const fileSliceIndexCache = new Map<string, FileSliceIndex>();

function getFileSliceIndex(projectPath: string): FileSliceIndex {
  let index = fileSliceIndexCache.get(projectPath);
  if (index === undefined) {
    index = new FileSliceIndex(projectPath);
    fileSliceIndexCache.set(projectPath, index);
  }
  return index;
}

/** Slice a single function/class body from a file (AST-based, not read_file). */
export function fileSlice(projectPath: string, name: string, file: string | null, gate?: FsGate): SliceResult {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  return getFileSliceIndex(projectPath).slice(name, file);
}

/** Viewport: a bounded line window of a file (for exact-byte editor needs). */
export function fileViewport(projectPath: string, file: string, startLine: number, endLine: number, gate?: FsGate): ViewportResult {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  return getFileSliceIndex(projectPath).viewport(file, startLine, endLine);
}

/** Skeleton: one line per top-level declaration — file-wide structure in ~30-50 tokens. */
export function fileSkeleton(projectPath: string, file: string, gate?: FsGate): SkeletonResult {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  return getFileSliceIndex(projectPath).skeleton(file);
}

export function getRepositoryMapSummary(projectPath: string, gate?: FsGate): Readonly<{
  fileCount: number;
  moduleCount: number;
  symbolCount: number;
  totalLines: number;
  languages: readonly Readonly<{ extension: string; fileCount: number }>[];
}> {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const map = requireCachedMap(projectPath);
  const moduleCount = map.modules.length;
  let symbolCount = 0;
  let totalLines = 0;
  const langCounts = new Map<string, number>();
  for (const mod of map.modules) {
    symbolCount += mod.symbols.length;
    totalLines += mod.lineCount;
    // Adaptive language detection. The previous version was a hardcoded `endsWith` chain
    // that only recognized.ts/.tsx/.js/.jsx/.py/.rs/.go and lumped every
    // other language (.java,.c,.cpp,.rb,.kt,.lua, …) into "other"so
    // a language the codebase actually uses was invisible in the summary
    // Deriving the extension
    // dynamically from the module path classifies EVERY language the
    // repository map indexed, with zero maintenance (a new language needs
    // no code change here). The repository map already rejects absolute /
    // `..` paths at index time, so `extname` is over a clean relative path.
    const rawExt = extname(mod.path);
    const ext = rawExt.length > 0 ? rawExt : "(no extension)";
    langCounts.set(ext, (langCounts.get(ext) ?? 0) + 1);
  }
  const languages = [...langCounts.entries()]
    .map(([extension, fileCount]) => ({ extension, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount);
  return {
    fileCount: map.files.length,
    moduleCount,
    symbolCount,
    totalLines,
    languages,
  };
}

/**
 * Which of a project's files the symbol index could actually read.
 *
 * Symbol extraction does not cover every language it accepts files from.
 * Measured on a fixture holding one declaration each in TypeScript, Python,
 * Go, Rust, Java, Ruby, PHP and C#, the map returned symbols for TypeScript
 * and NOTHING for the other seven — the tree-sitter backend that would parse
 * them is not initialised on this path, so those files are indexed as modules
 * with an empty symbol list.
 *
 * That is a silent degradation, and silent is the dangerous part: a symbol
 * search over a Python project returns no results, which is exactly what a
 * search for a symbol that does not exist returns. The model cannot tell "not
 * there" from "never read", and the two call for opposite next moves — stop
 * looking, or look another way.
 *
 * So the coverage is measured and reported alongside the results. It is
 * derived from the map itself rather than from a list of supported languages,
 * because a list would be a second answer to "what can we parse" and would go
 * stale the moment a backend was added or lost.
 */
export function getSymbolCoverage(projectPath: string, gate?: FsGate): Readonly<{
  /** Modules the index read at least one symbol from. */
  indexedModules: number;
  /** Modules indexed with no symbols at all. */
  unreadModules: number;
  /** Extensions of the unread modules, commonest first. */
  unreadExtensions: readonly Readonly<{ extension: string; fileCount: number }>[];
}> {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  const map = requireCachedMap(projectPath);
  let indexedModules = 0;
  let unreadModules = 0;
  const unreadCounts = new Map<string, number>();
  for (const mod of map.modules) {
    if (mod.symbols.length > 0) {
      indexedModules += 1;
      continue;
    }
    unreadModules += 1;
    const rawExt = extname(mod.path);
    const ext = rawExt.length > 0 ? rawExt : "(no extension)";
    unreadCounts.set(ext, (unreadCounts.get(ext) ?? 0) + 1);
  }
  return {
    indexedModules,
    unreadModules,
    unreadExtensions: [...unreadCounts.entries()]
      .map(([extension, fileCount]) => ({ extension, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount),
  };
}

// ── System-prompt injection (code graph sent to the LLM) ──
// The repo map is injected into the system prompt so the LLM has codebase
// intelligence on the FIRST message — symbol/module/language awareness
// without needing to call search_code first. Reuses the cached map.
// When the project path is broken or the map isn't ready, the prompt is
// returned unchanged (honest — no empty/fake section).

/**
 * Append a "## Codebase intelligence" section to the system prompt with the
 * repository map summary (files, symbols, modules, languages, top modules).
 * The map is fetched from the per-project cache (built on first access, e.g.
 * by the auto-index on project add). When indexing isn't ready or the path
 * is broken, returns the prompt unchanged.
 */
export function injectRepositoryMapIntoPrompt(systemPrompt: string, projectPath: string, gate?: FsGate): string {
  if (gate !== undefined) {
    assertProjectPathOwnership(projectPath, gate);
  }
  let summary: ReturnType<typeof getRepositoryMapSummary> | null = null;
  try {
    summary = getRepositoryMapSummary(projectPath);
  } catch (err) {
    // Honest degradation: ONLY the "not ready" (worker still indexing) and
    // "broken project path" (stale enc: / missing / not a dir) cases skip
    // injection — the prompt is returned without the Codebase intelligence
    // section. Any OTHER error MUST propagate: a blanket `catch {}` here
    // would swallow a future security failure (e.g. a ForbiddenError if a
    // gate were threaded into getRepositoryMapSummary) as a silent "no
    // section", masking the problem.
    if (!(err instanceof MapNotReadyError || err instanceof ProjectPathError)) throw err;
    return systemPrompt;
  }
  if (summary === null || summary.fileCount === 0) return systemPrompt;

  const langText = summary.languages
    .slice(0, getRepoMapLanguagePreviewCount())
    .map((l) => `${l.extension}=${l.fileCount}`)
    .join(", ");

  const lines = [
    systemPrompt,
    "",
    "## Codebase intelligence",
    `Pre-indexed map: ${summary.fileCount} files, ${summary.symbolCount} symbols, ${summary.moduleCount} modules, ${summary.totalLines} lines.`,
    `Languages: ${langText.length > 0 ? langText : "(none detected)"}.`,
    "Use search_code / quick_view / slice to inspect specific symbols before editing.",
  ];
  return lines.join("\n");
}
