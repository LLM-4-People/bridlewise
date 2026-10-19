/**
 * Worker IPC helper — the SINGLE owner of the `post` helper duplicated across
 * the worker_threads entry points (No Scattered Helpers).
 *
 * Each worker (awareness-worker, quick-view-worker, repository-map-worker)
 * previously defined its own `function post(result) { parentPort?.postMessage(result); }`
 * the same one-line IPC forwarder copied into 3 files. This module owns it
 * once; the workers import `postWorkerResult` instead. The `WorkerResult`
 * /`WorkerOk`/`WorkerErr` types stay local to each worker (their `ok`-payload
 * shapes differ per worker); this helper only forwards an already-shaped
 * message to the parent, so it takes `unknown` (no shared payload type).
 *
 * No new deps (node:worker_threads).
 */
import { parentPort } from "node:worker_threads";

/**
 * Forward a worker result message to the parent thread. A no-op when there
 * is no parent port (the worker is the main thread — never happens for these
 * workers but the optional chaining matches the prior per-worker behavior).
 */
export function postWorkerResult(result: unknown): void {
  parentPort?.postMessage(result);
}
