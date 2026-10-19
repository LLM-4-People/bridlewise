/**
 * The key tool's scan, off the event loop: the read-only walk for installs
 * that still keep a key beside their database (`findLegacyInstalls`, bounded
 * by `legacyInstalls.scanFolderBudget`) runs in this worker thread, so a scan
 * of a home folder (a million folders: 48 s, measured) never stalls the web
 * server (sec-e-design H3). The main thread registers what it found.
 *
 * Input (`workerData`): `{ roots, folderBudget }`. Posts back
 * `{ ok: true, search }` or `{ ok: false, error }`.
 */
import { workerData } from "node:worker_threads";

import { findLegacyInstalls, type LegacyInstallSearch } from "../kernel/canonical.ts";
import { postWorkerResult } from "../run/worker-ipc.ts";

type WorkerResult = Readonly<{ ok: true; search: LegacyInstallSearch }> | Readonly<{ ok: false; error: Readonly<{ message: string; code?: string }> }>;

const input = workerData as Readonly<{ roots?: unknown; folderBudget?: unknown }> | undefined;
const roots = input?.roots;
const folderBudget = input?.folderBudget;
if (!Array.isArray(roots) || !roots.every((root) => typeof root === "string") || typeof folderBudget !== "number" || !Number.isInteger(folderBudget) || folderBudget <= 0) {
  postWorkerResult({ ok: false, error: { message: "The key scan worker needs its roots and a positive folder budget.", code: "key_scan_worker_bad_input" } } satisfies WorkerResult);
} else {
  try {
    postWorkerResult({ ok: true, search: findLegacyInstalls(roots as string[], folderBudget) } satisfies WorkerResult);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    postWorkerResult({ ok: false, error: { message: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) } } satisfies WorkerResult);
  }
}
