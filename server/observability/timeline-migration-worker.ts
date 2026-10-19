/**
 * Timeline migration worker thread entry point (SCALE-CR1 C10).
 *
 * A ledger that owes migrations used to run them inside the server's boot,
 * synchronously, before the socket listened: migration 9 over a 10 GB ledger
 * measured 488.8 s with no answer to anything, not even the health check.
 * The timeline bridge now runs them HERE, off the serving thread, through the
 * store's own runner (`migrateTimelineFile`: one transaction, the same
 * refusals), and opens the store when this worker answers. The server listens
 * and answers meanwhile; what needs the ledger is told it is migrating.
 *
 * Handed `{ path, busyTimeoutMs }` (it reads no settings file); posts
 * `{ ok: true, applied }` or `{ ok: false, error }`.
 */
import { parentPort, workerData } from "node:worker_threads";

import { describeFault, migrateTimelineFile } from "../kernel/canonical.ts";
import { postWorkerResult } from "../run/worker-ipc.ts";

type WorkerResult =
  | Readonly<{ ok: true; applied: readonly string[] }>
  | Readonly<{ ok: false; error: Readonly<{ message: string; code?: string }> }>;

if (parentPort === null) process.exit(1);

const input = workerData as Readonly<{ path?: unknown; busyTimeoutMs?: unknown }> | undefined;
if (input === undefined || typeof input.path !== "string" || input.path.length === 0) {
  postWorkerResult({ ok: false, error: { message: "The migration worker requires the ledger's path.", code: "timeline_migration_worker_bad_input" } } satisfies WorkerResult);
} else {
  try {
    const applied = migrateTimelineFile(input.path, typeof input.busyTimeoutMs === "number" ? { sqliteBusyTimeoutMs: input.busyTimeoutMs } : {});
    postWorkerResult({ ok: true, applied } satisfies WorkerResult);
  } catch (err) {
    // Total over any thrown value (a null-prototype one included: SCALE-CR1-FIX L5).
    const { message, code } = describeFault(err);
    postWorkerResult({ ok: false, error: { message, ...(code !== undefined ? { code } : {}) } } satisfies WorkerResult);
  }
}
