/**
 * Awareness-engine worker thread entry point.
 *
 * Runs the CPU-heavy `awarenessEngine.compute(projectPath)` OFF the Node
 * main event loop. The awareness engine walks + parses every source file
 * in the project to compute complexity, clones, drift, entropy, and
 * hotspots. For a large codebase (e.g. the 475+ module harness with its
 * `_experiments` tree) this is a long synchronous pass that, run on the
 * main thread, wedges the HTTP server (the second 502 chat-run wedge —
 * the post-run quality call at run.ts:1133 called `getQualityIndicator`
 * → `getAwarenessSnapshot` → `engine.compute` synchronously).
 *
 * Same pattern as `repository-map-worker.ts`: the parent spawns this
 * worker on a cache miss, sends `{ projectPath }` via `workerData`, and
 * awaits the `message` event. The worker posts back either
 * `{ ok: true, snapshot }` or `{ ok: false, error }`. The snapshot is a
 * plain object (cloneable by the structured-clone algorithm).
 *
 * Built-in `node:worker_threads` — no new runtime dependency.
 */

import { parentPort, workerData } from "node:worker_threads";
import { createAwarenessEngine } from "../../engine/src/awareness/engine.ts";
import { configureAwareness } from "../../engine/src/awareness/config.ts";
// TYPE-ONLY: erased at compile time, so the worker still evaluates only the
// awareness chain — the hub module itself is never loaded here at runtime.
import type { AwarenessSnapshot } from "../kernel/canonical.ts";
// GIT IS RUN THROUGH THE CONFINEMENT OWNER'S DOOR, never by the engine.
// The engine walks a project the user chose, and git executes programs that
// project's own `.git/config` names — so running it from this unconfined
// process was an escape, measured end to end. See `runGitConfined`.
import { runGitConfined } from "../intelligence/git-bridge.ts";
import { postWorkerResult } from "../run/worker-ipc.ts";

type WorkerInput = Readonly<{ projectPath: string }>;
type WorkerOk = Readonly<{ ok: true; snapshot: AwarenessSnapshot }>;
type WorkerErr = Readonly<{ ok: false; error: Readonly<{ message: string; code?: string }> }>;
type WorkerResult = WorkerOk | WorkerErr;

// (No Scattered Helpers): the local `post` helper is removed —
// `postWorkerResult` (server/worker-ipc.ts) is the single owner of the
// worker→parent IPC forward, shared with the other worker entry points.
// The `satisfies WorkerResult` checks keep the payload type aliases used
// (noUnusedLocals) + type-check the posted shape.

if (parentPort === null) {
  process.exit(1);
}

const input = workerData as WorkerInput | undefined;
if (input === undefined || typeof input.projectPath !== "string" || input.projectPath.length === 0) {
  postWorkerResult({ ok: false, error: { message: "Worker requires a non-empty projectPath.", code: "awareness_worker_bad_input" } } satisfies WorkerResult);
} else {
  try {
    const engine = createAwarenessEngine(configureAwareness({}), { runGit: runGitConfined });
    const snapshot = engine.compute(input.projectPath);
    postWorkerResult({ ok: true, snapshot } satisfies WorkerResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code;
    postWorkerResult({ ok: false, error: { message, ...(code !== undefined ? { code } : {}) } } satisfies WorkerResult);
  }
}
