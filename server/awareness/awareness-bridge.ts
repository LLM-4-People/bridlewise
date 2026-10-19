/**
 * Awareness bridge — runs the canonical awareness engine on a project path
 * and returns the snapshot with all computed signals (complexity, clones,
 * drift, entropy, hotspots, risk, etc.).
 *
 * The awareness engine uses regex-based language adapters (no tree-sitter
 * WASM dependency), so it works in the web UI server.
 *
 * 502 wedge fix: `engine.compute` is a CPU-heavy synchronous pass that, run
 * on the main thread, wedges the HTTP server for tens of seconds on a large
 * codebase (the post-run quality call at run.ts:1133 was the second 502
 * chat-run wedge). The compute now runs in a `node:worker_threads` Worker
 * OFF the event loop. The cache has three states (ready/pending/miss),
 * mirroring the repository-map bridge:
 * - "ready": the worker finished; the cached snapshot is returned
 * instantly (sync callers).
 * - "pending": the worker is still computing; sync callers get a typed
 * `AwarenessNotReadyError`, async callers await the shared promise.
 * - miss: spawn a worker (fire-and-forget for sync callers) and
 * return "not ready".
 */

import type { AwarenessSnapshot } from "../kernel/canonical.ts";
import { runWorkerTask, getInFlightWorker } from "../run/worker-pool.ts";
import { AwarenessNotReadyError } from "../kernel/errors.ts";
import { assertProjectPathOwnership, assertValidProjectPath, type FsGate } from "../filesystem/fs-gate.ts";
import { serverConfig } from "../kernel/config.ts";

// ── Cache (per-project, by path) ──

interface ReadyEntry {
  readonly status: "ready";
  readonly snapshot: AwarenessSnapshot;
  readonly generatedAt: number;
}

/** The worker URL for the awareness worker (module-level so both
 * `buildSnapshotInWorker` + `getAwarenessSnapshot` reference the SAME href
 * for the pool's in-flight dedup key). */
const AWARENESS_WORKER_URL = new URL("./awareness-worker.ts", import.meta.url);

/** The cache holds ONLY "ready" entries now. The "pending" state is owned
 * by the worker pool's in-flight map (`getInFlightWorker`) — the pool sets
 * the in-flight entry BEFORE spawning (lowest-level "Relieve
 * Responsibilities": a bridge no longer has to remember to set a pending
 * entry; the pool handles it). */
const snapshotCache = new Map<string, ReadyEntry>();

/** A vanished root invalidates its old snapshot as well as the new request.
 * Recreating the path must start a real scan, never resurrect a cached result. */
function admitAwarenessPath(projectPath: string): void {
  try {
    assertValidProjectPath(projectPath);
  } catch (error) {
    snapshotCache.delete(projectPath);
    throw error;
  }
}


/**
 * Spawn (or reuse) a Worker thread that computes the awareness snapshot for
 * `projectPath` off the event loop. Returns a Promise that resolves with the
 * snapshot. On success the cache entry transitions to "ready"; on failure
 * the entry is removed so the next call can retry.
 *
 * SPO: the spawn (execArgv, `new Worker`, message/error/exit/timeout
 * handlers, cleanup) is owned by the worker pool
 * (`server/worker-pool.ts`) — the SINGLE owner of backend
 * `node:worker_threads` spawning. This bridge no longer calls
 * `new Worker(...)` directly. The pool handles timeout (configurable —
 * fixes the "worker-hang → permanent 'not ready'" bug), error mapping
 * (consistent typed AwarenessNotReadyError), concurrency cap, and shutdown
 * cleanup. The pool ALSO owns the in-flight dedup (the "pending" entry) —
 * it sets the in-flight entry BEFORE spawning, so this bridge no longer
 * needs to manually set a pending cache entry. Concurrent callers are
 * deduped at the pool (lowest level) — no bridge can forget.
 */
function buildSnapshotInWorker(projectPath: string): Promise<AwarenessSnapshot> {
  const result = runWorkerTask<AwarenessSnapshot>({
    workerUrl: AWARENESS_WORKER_URL,
    workerData: { projectPath },
    errorClass: AwarenessNotReadyError,
    label: "awareness",
    dedupKey: projectPath,
    validateOk: (msg) => (msg as { snapshot?: AwarenessSnapshot }).snapshot,
  });
  // The pool's in-flight entry dedups concurrent callers. This bridge only
  // caches the READY result (no pending entry — the pool owns that state).
  void result.then(
    (snapshot) => { snapshotCache.set(projectPath, { status: "ready", snapshot, generatedAt: Date.now() }); },
    () => { snapshotCache.delete(projectPath); },
  );
  return result;
}

/**
 * Synchronous cache read — NEVER blocks the event loop. Returns the cached
 * snapshot on a hit, or throws a typed `AwarenessNotReadyError` on a
 * miss (after fire-and-forget triggering a worker build for a miss).
 * Callers that can wait should use `getAwarenessSnapshotAsync`.
 */
export function getAwarenessSnapshot(projectPath: string, gate?: FsGate): AwarenessSnapshot {
  if (gate !== undefined) assertProjectPathOwnership(projectPath, gate);
  admitAwarenessPath(projectPath);
  const now = Date.now();
  const entry = snapshotCache.get(projectPath);
  if (entry !== undefined) {
    if (now - entry.generatedAt < serverConfig.awarenessSnapshotTtlMs) {
      return entry.snapshot;
    }
    // Stale — rebuild off-thread, return the stale snapshot for this
    // call. Only kick off a build when no worker is already in flight
    // (pool-owned dedup — avoids redundant handler attachment).
    if (getInFlightWorker<AwarenessSnapshot>(AWARENESS_WORKER_URL, projectPath) === undefined) {
      void buildSnapshotInWorker(projectPath);
    }
    return entry.snapshot;
  }
  // No ready entry. Check if a worker is already in flight (pool-owned).
  // The pool's in-flight map is the SINGLE source of "is a worker
  // building?" — this bridge no longer maintains its own pending entry.
  // Only kick off a build when no worker is in flight.
  if (getInFlightWorker<AwarenessSnapshot>(AWARENESS_WORKER_URL, projectPath) === undefined) {
    void buildSnapshotInWorker(projectPath);
  }
  throw new AwarenessNotReadyError(
    "Awareness snapshot is still computing in the background. Retry shortly.",
    "awareness_not_ready",
  );
}

/**
 * Async snapshot read — returns a Promise resolving with the snapshot.
 * On a hit, resolves immediately; on a miss, awaits the (shared)
 * worker build. Used by callers that can wait (the post-run quality path)
 * so the compute runs off-thread WITHOUT blocking any HTTP request.
 */
export async function getAwarenessSnapshotAsync(projectPath: string, gate?: FsGate): Promise<AwarenessSnapshot> {
  if (gate !== undefined) assertProjectPathOwnership(projectPath, gate);
  admitAwarenessPath(projectPath);
  const now = Date.now();
  const entry = snapshotCache.get(projectPath);
  if (entry !== undefined && now - entry.generatedAt < serverConfig.awarenessSnapshotTtlMs) {
    return entry.snapshot;
  }
  // No fresh ready entry. If a worker is already in flight, return its
  // shared promise (the pool dedups the spawn — the in-flight entry is
  // set BEFORE spawning). This avoids attaching a redundant `then` handler
  // that re-caches the same ready entry. If no worker is in flight, spawn
  // one (buildSnapshotInWorker attaches the cache-handler once).
  const inFlight = getInFlightWorker<AwarenessSnapshot>(AWARENESS_WORKER_URL, projectPath);
  if (inFlight !== undefined) return inFlight;
  return buildSnapshotInWorker(projectPath);
}

export function invalidateAwarenessCache(projectPath: string, gate?: FsGate): void {
  if (gate !== undefined) assertProjectPathOwnership(projectPath, gate);
  snapshotCache.delete(projectPath);
}

export function getAwarenessSummary(projectPath: string, gate?: FsGate): AwarenessSummary {
  const snap = getAwarenessSnapshot(projectPath, gate);
  return {
    computedAt: snap.computedAt,
    rootPath: snap.rootPath,
    fileCount: snap.fileCount,
    functionCount: snap.functionCount,
    moduleCount: snap.moduleCount,
    totalLoc: snap.totalLoc,
    primaryLanguageId: snap.primaryLanguageId,
    languageMix: snap.languageMix,
    typeLevel: snap.typeLevel,
    quality: snap.quality,
    complexity: snap.complexity !== null
      ? { mean: snap.complexity.mean, median: snap.complexity.median, p95: snap.complexity.p95, max: snap.complexity.max, hotspotCount: snap.complexity.hotspotCount }
      : null,
    drift: snap.drift,
  };
}

export type AwarenessSummary = Readonly<{
  computedAt: string;
  rootPath: string;
  fileCount: number;
  functionCount: number;
  moduleCount: number;
  totalLoc: number;
  primaryLanguageId: string | null;
  languageMix: readonly Readonly<{ languageId: string; label: string; fileCount: number; lineCount: number }>[];
  typeLevel: Readonly<{ level: string; typedFileFraction: number; typedParameterFraction: number }> | null;
  quality: Readonly<{ issueDensity: number; issuesPerKloc: number; totalIssues: number; topCategories: readonly Readonly<{ category: string; count: number }>[] }> | null;
  complexity: Readonly<{ mean: number; median: number; p95: number; max: number; hotspotCount: number }> | null;
  drift: Readonly<{ schemaVersion: string | null; dependencyDrift: number; changedDependencyFiles: readonly string[] }> | null;
}>;
