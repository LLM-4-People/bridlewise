/**
 * THE WORKER THREADS' BOOTSTRAP (SCALE-CR1-FIX H2).
 *
 * A worker thread is its own JavaScript realm: the fault policy its spawning
 * thread installed does not reach it, and its entry module runs whatever it
 * imports before any line of its own. So every worker thread is started on ONE
 * entry, THIS module (its PRELUDE half, at the bottom): in a thread started
 * with a boot record it installs the policy for the thread's role, then
 * imports the thread's real entry. Nothing of the entry runs before the
 * policy, and no entry module has to remember it. The spawn half
 * ({@link bootstrappedWorker}) and the prelude half are the two ends of one
 * protocol, so they are one module.
 *
 * {@link bootstrappedWorker} is the one spelling: `new Worker(...bootstrappedWorker(entry, role, options))`.
 * It hands the prelude the entry and the role in `workerData` under
 * {@link WORKER_BOOT_KEY} (the thread's own `workerData` keys are kept as they
 * are). It does not touch `execArgv`: an explicit list replaces node's own
 * inheritance, and a parent's process-level options (a test runner's) are
 * refused by a worker.
 *
 * The role decides what a lost fault does (`fault-policy.ts`): the database
 * facade's supervised threads are `server-thread`s (they live on; a dead one
 * is respawned by its supervisor), a pooled task's thread is a `worker` (it
 * fails closed). `tests/prevention/guarded-callbacks.test.ts` refuses a
 * `new Worker(` that is not started this way.
 */
import { isMainThread, workerData, type WorkerOptions } from "node:worker_threads";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { reportAlwaysOn } from "../shared/debug/debug-system.ts";
import { describeFaultLine } from "../shared/fault-description.ts";
import { installProcessFaultPolicy, PROCESS_FAULT_EXIT_CODE, type ProcessFaultRole } from "./fault-policy.ts";

export type WorkerThreadRole = Extract<ProcessFaultRole, "server-thread" | "worker">;

/** The `workerData` key the prelude reads: `{ entry, role }`. */
const WORKER_BOOT_KEY = "__bridlewiseWorkerBoot";

export type WorkerBoot = Readonly<{ entry: string; role: WorkerThreadRole }>;

const PRELUDE = new URL(import.meta.url);

/**
 * The arguments of a bootstrapped worker thread: the prelude as its entry, and
 * `options` with the boot record added to its `workerData` (an object, or
 * none).
 */
export function bootstrappedWorker(entry: URL | string, role: WorkerThreadRole, options: WorkerOptions = {}): [URL, WorkerOptions] {
  if (role !== "server-thread" && role !== "worker") throw new InputError(`not a worker thread role: ${String(role)}`, "worker_role_invalid");
  const data: unknown = options.workerData;
  if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
    throw new InputError("a bootstrapped worker's workerData is an object (the prelude adds its boot record to it)", "worker_data_not_object");
  }
  const boot: WorkerBoot = { entry: entry instanceof URL ? entry.href : new URL(entry, "file://").href, role };
  return [PRELUDE, { ...options, workerData: { ...(data as Record<string, unknown> | undefined), [WORKER_BOOT_KEY]: boot } }];
}

// ── The prelude half: this module as a worker thread's entry ──────────────
//
// A thread started by `bootstrappedWorker` carries its boot record; it gets
// the policy for its role, then its real entry. A record that names no valid
// role refuses to start the thread (its `error` event): a worker with no
// policy is the defect this exists to end. Imported anywhere else (the main
// thread, or a thread that imports it as a library) it does nothing.
//
// The entry is imported WITHOUT a top-level await: the entry's own graph may
// import this module again (the server's hub re-exports `bootstrappedWorker`),
// and a module awaiting inside an import cycle never settles. An entry that
// fails to load is reported and ends the thread with exit 70, which its owner
// sees as any thread that stopped before it was ready.
const boot = isMainThread ? undefined : (workerData as Readonly<Record<string, unknown>> | null | undefined)?.[WORKER_BOOT_KEY];
if (boot !== undefined) {
  const record = boot as Partial<WorkerBoot>;
  if ((record.role !== "server-thread" && record.role !== "worker") || typeof record.entry !== "string") {
    throw new HarnessError("worker prelude: this thread's boot record names no valid role and entry (start it with bootstrappedWorker)", "worker_boot_missing");
  }
  installProcessFaultPolicy({ role: record.role });
  const entry = record.entry;
  void import(entry).then(undefined, (error: unknown) => {
    reportAlwaysOn("process", `a worker thread's entry failed to load: ${describeFaultLine(error)}`, { entry, role: record.role });
    process.exit(PROCESS_FAULT_EXIT_CODE);
  });
}
