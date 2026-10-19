/**
 * Repository-map worker thread entry point.
 *
 * Runs the CPU-heavy map build (which walks + parses the changed source
 * files of a project) OFF the Node main event loop so the HTTP server never
 * blocks (root-cause fix for the HTTP 502 chat-run wedge).
 *
 * The parent thread (intelligence-bridge.ts) spawns this worker on a
 * cache miss or a change trigger, sends `{ projectPath }` via `workerData`
 * (plus, when the bridge holds warm state: `previousCache` — the last
 * successful scan's stat + extraction cache — and `changedPaths` — the
 * paths the harness's own editor writes touched), and awaits the `message`
 * event. The worker posts back one of three shapes:
 * - `{ ok: true, map, cache }` — something changed; the freshly assembled
 *   incremental map + the cache to reuse next time;
 * - `{ ok: true, unchanged: true }` — the stat walk found NOTHING that
 *   differs from the previous successful scan: no map is built, no cache
 *   is written, the parent keeps its map (the smart trigger's empty-diff
 *   gate);
 * - `{ ok: false, error }`. The structured-clone boundary serializes the
 *   plain payloads (frozen objects/arrays — no functions/proxies), which
 *   are cloneable by the structured-clone algorithm.
 *
 * Why a worker thread and not partitioning: the map build is a
 * single O(files × parse) CPU-bound pass with no natural async yield
 * points; chunking it on the event loop would still stall HTTP between
 * chunks. The Node.js guidance ("Don't Block the Event Loop" →
 * "Offloading") recommends a dedicated Worker thread for exactly this
 * class of CPU-intensive work. Built-in `node:worker_threads` — no new
 * runtime dependency.
 *
 * The worker imports `generateRepositoryMapIsolated` directly from the
 * canonical intelligence source module (the same file `canonical.ts`
 * re-exports) rather than through `canonical.ts` so the worker only
 * evaluates the intelligence module chain, not the entire harness
 * re-export graph — keeping worker startup lean and avoiding the
 * cross-module circular init that the heavier canonical hub pulls in.
 *
 * SMART TRIGGER (when to check + when to build): with no path hints, the
 * worker first does the CHEAP pass — a stat-only walk (readdir + lstat, no
 * reads, no parses) diffed against the previous scan's stat snapshot. An
 * empty diff posts `unchanged` and stops there: no map swap, no cache
 * write, no parse work beyond the stat walk. The walk happens HERE, in
 * the worker, not on the main thread — a big tree's stat walk is
 * syscall-bound CPU that must stay off the event loop like every other
 * part of the build.
 */

import { parentPort, workerData } from "node:worker_threads";
import {
  generateRepositoryMapIsolated,
} from "../../engine/src/intelligence/repository-map.ts";
import {
  createRepositoryMapCache,
  isRepositoryMapCacheReusable,
  scanRepositoryStats,
  diffStatSnapshot,
  type RepositoryMapCache,
} from "../../engine/src/intelligence/repository-stat-scan.ts";
import { postWorkerResult } from "../run/worker-ipc.ts";
import type { CodeIntelligenceFarmConfig } from "../kernel/harness-config.ts";

type WorkerInput = Readonly<{
  projectPath: string;
  /** The farm watchdogs, resolved by the bridge from the main thread's
   * settings snapshot — this isolate never reads the settings itself. */
  farm: CodeIntelligenceFarmConfig;
  previousCache?: RepositoryMapCache;
  changedPaths?: readonly string[];
}>;
type WorkerOk =
  | Readonly<{ ok: true; map: unknown; cache: unknown }>
  | Readonly<{ ok: true; unchanged: true }>;
type WorkerErr = Readonly<{ ok: false; error: Readonly<{ message: string; code?: string }> }>;
type WorkerResult = WorkerOk | WorkerErr;

// (No Scattered Helpers): the local `post` helper is removed —
// `postWorkerResult` (server/worker-ipc.ts) is the single owner of the
// worker→parent IPC forward, shared with the other worker entry points.
// The `satisfies WorkerResult` checks keep the payload type aliases used
// (noUnusedLocals) + type-check the posted shape.

if (parentPort === null) {
  // Spawned without a parent port (e.g. run directly) — nothing to do.
  process.exit(1);
}

const input = workerData as WorkerInput | undefined;
if (input === undefined || typeof input.projectPath !== "string" || input.projectPath.length === 0) {
  postWorkerResult({ ok: false, error: { message: "Worker requires a non-empty projectPath.", code: "map_worker_bad_input" } } satisfies WorkerResult);
} else {
  void (async () => {
    try {
      // Parse/extract runs in crash-isolated farm children (init at spawn).
      // This worker only orchestrates; a grammar trap cannot kill HTTP.
      const farm = input.farm;
      const hints = Array.isArray(input.changedPaths) ? input.changedPaths : undefined;
      const previousCache = input.previousCache;
      if (hints === undefined && isRepositoryMapCacheReusable(previousCache)) {
        // Smart trigger: cheap stat walk → diff against the last successful
        // scan. Nothing dirty and nothing dropped means nothing indexable
        // changed — answer "unchanged" without building anything. Otherwise
        // hand the SAME walk to the generator (one walk, not two).
        const scan = scanRepositoryStats(input.projectPath);
        if (scan.complete) {
          const diff = diffStatSnapshot(scan.files, previousCache);
          if (diff.dirty.length === 0 && diff.dropped.length === 0) {
            postWorkerResult({ ok: true, unchanged: true } satisfies WorkerResult);
            return;
          }
          const { map, cache } = await generateRepositoryMapIsolated(input.projectPath, {
            cache: previousCache,
            statScan: scan,
            farm,
          });
          postWorkerResult({ ok: true, map, cache } satisfies WorkerResult);
          return;
        }
        // Incomplete walk: fall through to a full generate, which keeps the
        // previous cache (never installs a partial snapshot) and builds the
        // best-effort map exactly like a cold build.
      }
      const { map, cache } = await generateRepositoryMapIsolated(input.projectPath, {
        cache: previousCache ?? createRepositoryMapCache(),
        ...(hints !== undefined ? { changedPathHints: hints } : {}),
        farm,
      });
      postWorkerResult({ ok: true, map, cache } satisfies WorkerResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | null)?.code;
      postWorkerResult({ ok: false, error: { message, ...(code !== undefined ? { code } : {}) } } satisfies WorkerResult);
    }
  })();
}
