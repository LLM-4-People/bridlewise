/**
 * THE PROCESS FAULT POLICY — ONE OWNER OF WHAT A PROCESS DOES WITH A FAULT
 * THAT ESCAPED EVERY HANDLER (SCALE-CR1 C2, SCALE-CR1-FIX H1/H2).
 *
 * Before it, the web server installed its own `unhandledRejection` and
 * `uncaughtException` listeners AFTER a top-level `await` (so a fault while the
 * database warmed went to Node's default), formatted the reason with
 * `String(reason)` / `err.stack ?? err.message` (a null-prototype reason, a
 * thrown `undefined` and a throwing `stack` getter each threw INSIDE the
 * listener and ended the process with the cause lost), and a second, dead
 * owner sat in the debug system.
 *
 * ── Who installs it (H2: three doors, each guarded) ──
 *
 *  - every CLI entry point, through the one process bootstrap
 *    (`bootstrapProcess({ role })`, `src/runtime/cli-debug.ts`) that
 *    `test/runtime/cli-debug.test.ts` requires first in every entry block;
 *  - every worker THREAD, through its prelude: every `new Worker(` is spelled
 *    `new Worker(...bootstrappedWorker(entry, role, options))`
 *    (`worker-bootstrap.ts`), so the prelude installs the policy before the
 *    thread's own entry module loads;
 *  - the web server, as its first import (`server/kernel/process-fault-policy.ts`).
 *
 * `tests/prevention/guarded-callbacks.test.ts` refuses an install anywhere else
 * and a `new Worker(` outside the one spawn.
 *
 * ── What the ROLE decides (H1) ──
 *
 *  - AN UNCAUGHT EXCEPTION is FAIL-STOP in every role: the synchronous code
 *    that threw may have left any state half-updated, so the process records
 *    the fault (the always-on report and — on the server — a `process-fault`
 *    event in the ledger through the registered recorder) and exits with
 *    {@link PROCESS_FAULT_EXIT_CODE}. In a worker thread the exit ends the
 *    THREAD; its owner sees the code.
 *  - AN UNHANDLED REJECTION or A GUARDED CALLBACK FAULT is counted, attributed
 *    and reported in every role. A SERVICE (`server`, and its supervised
 *    `server-thread`s) lives on: a rejected promise nobody awaited left no
 *    state half-written, and ending a server for it ends every user's work. A
 *    TOOL (`cli`, `worker`) FAILS CLOSED: its exit code becomes
 *    {@link PROCESS_FAULT_EXIT_CODE}, stickily — the policy's own `exit`
 *    listener restores it if the tool later sets 0 — so a gate whose failure
 *    surfaced only as a lost rejection can never pass.
 *  - A process that installed NO role (a test runner hosting product code, an
 *    ad-hoc script) keeps Node's own fail-closed default: an unhandled
 *    rejection is Node's; a guarded callback fault is counted, reported, and
 *    rethrown as an uncaught exception, so the host's own handler (a test
 *    runner's: the file fails) sees it. That is the gate budget of 0 for the
 *    suites: no test can pass over a fault a callback swallowed.
 *
 * Every step of the handlers is total: the description never throws
 * (`describeFault`), each reporting step is guarded on its own, and the exit
 * happens in a `finally`. What no handler can prevent — SIGKILL, the kernel's
 * out-of-memory killer, power loss — is out of reach of code by definition.
 *
 * Callbacks the event loop runs (timers, emitters, event targets) go through
 * {@link guarded} — defined HERE, the policy's own door, so the policy imports
 * no module that imports it back.
 */
import { types as nodeTypes } from "node:util";

import { describeFault, faultLine, type FaultDescription } from "../shared/fault-description.ts";
import { redactDiagnosticText, reportAlwaysOn, reportBestEffortFailure } from "../shared/debug/debug-system.ts";

/** EX_SOFTWARE (sysexits.h): an internal software error. What a supervisor reads as "restart me". */
export const PROCESS_FAULT_EXIT_CODE = 70;

/** What a process is, for its faults: a service that lives on, or a tool that fails closed (see the header). */
export type ProcessFaultRole = "server" | "server-thread" | "cli" | "worker";

/** The roles that survive an unhandled rejection or a guarded callback fault. Every other role fails closed. */
const SERVICE_ROLES: ReadonlySet<ProcessFaultRole> = new Set(["server", "server-thread"]);

export type ProcessFaultCounts = Readonly<{
  unhandledRejections: number;
  guardedCallbackFaults: number;
  uncaughtExceptions: number;
}>;

/** The server's ledger lane for the fatal fault: a synchronous append, attempted once, never trusted to succeed. */
export type FatalFaultRecorder = (fault: FaultDescription, origin: string) => void;

const counts = { unhandledRejections: 0, guardedCallbackFaults: 0, uncaughtExceptions: 0 };
/**
 * Occurrences per `kind:owner:name:code`, so a fault in a hot callback reports
 * at 1, 2, 4, 8, ... and is counted always — and two different faults never
 * hide each other (the key is the fault's identity, bounded by the code's own
 * error classes and codes, never its free text).
 */
const occurrences = new Map<string, number>();
let role: ProcessFaultRole | undefined;
let failedClosed = false;
let lastFault = "";
let fatalRecorder: FatalFaultRecorder | undefined;

/** The faults this process met (a service survives them; the uncaught one ends any process), counted since it started. */
export function processFaultCounts(): ProcessFaultCounts {
  return Object.freeze({ ...counts });
}

/** The last fault, as its redacted one-line description (empty when none). */
export function lastProcessFault(): string {
  return lastFault;
}

/** The role this process installed the policy for, or `undefined` before it did. */
export function processFaultRole(): ProcessFaultRole | undefined {
  return role;
}

/** The ledger's fatal-fault lane (the web server's timeline, once it is open). */
export function registerFatalFaultRecorder(recorder: FatalFaultRecorder | undefined): void {
  fatalRecorder = recorder;
}

function powerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** Report one fault through the one always-on report (logarithmic per fault identity). Total. */
function report(kind: string, owner: string, fault: FaultDescription): void {
  try {
    const head = faultLine(fault);
    lastFault = redactDiagnosticText(`${kind} in ${owner}: ${head}`);
    const key = `${kind}:${owner}:${fault.name}:${fault.code ?? ""}`;
    const seen = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, seen);
    if (!powerOfTwo(seen)) return;
    const stack = seen === 1 && fault.stack !== undefined ? `\n${fault.stack}` : "";
    reportAlwaysOn("process", `${kind} in ${owner}: ${head}${stack}`, {
      role: role ?? "none",
      ...(seen > 1 ? { occurrence: seen } : {}),
    });
  } catch {
    reportBestEffortFailure();
  }
}

/** A TOOL role's lost fault fails the process (see the header): the exit code becomes 70 and stays so. */
function failClosed(): void {
  if (role === undefined || SERVICE_ROLES.has(role)) return;
  failedClosed = true;
  process.exitCode = PROCESS_FAULT_EXIT_CODE;
}

/** A fault `guarded(owner, fn)` caught: counted and reported; the role decides the rest. Never throws. */
function noteGuardedFault(owner: string, value: unknown): void {
  counts.guardedCallbackFaults += 1;
  report("callback fault", owner, describeFault(value));
  if (role === undefined) {
    // No role: Node's own default. Re-raised as a rejection nobody handles,
    // which a process with no policy ends on (or its host — a test runner —
    // reports as the file's failure).
    void Promise.reject(value);
    return;
  }
  failClosed();
}

/**
 * THE EVENT LOOP'S DOOR (SCALE-CR1 C3): every callback the event loop runs
 * on its own — a timer, an emitter or event-target listener, a worker's or
 * child's message handler, a node-style completion callback — is registered
 * as `guarded(owner, fn)`. A synchronous throw there has no caller to catch
 * it, so it was an uncaught exception: fatal for the whole process. Guarded,
 * it is ATTRIBUTED to `owner`, COUNTED (`process.faults.guardedCallbacks`)
 * and REPORTED, the callback returns `undefined`, and the process's role
 * decides the rest ({@link noteGuardedFault}). A returned promise is observed
 * the same way, so an async listener's rejection is attributed too instead
 * of becoming an anonymous unhandled rejection.
 *
 * `owner` is a stable dotted label (`mcp.stdio.message`), never data.
 * `tests/prevention/guarded-callbacks.test.ts` refuses a registration that
 * is not guarded.
 */
export function guarded<A extends unknown[]>(owner: string, fn: (...args: A) => unknown): (...args: A) => undefined {
  return (...args: A): undefined => {
    try {
      const result = fn(...args);
      if (nodeTypes.isPromise(result)) {
        Promise.prototype.then.call(result, undefined, (error: unknown) => { noteGuardedFault(owner, error); });
      }
    } catch (error) {
      noteGuardedFault(owner, error);
    }
    return undefined;
  };
}

const onUnhandledRejection = guarded("process.unhandled-rejection", (reason: unknown): void => {
  counts.unhandledRejections += 1;
  report("unhandled rejection", "promise", describeFault(reason));
  failClosed();
});

const onUncaughtException = guarded("process.uncaught-exception", (error: unknown, origin: unknown): void => {
  try {
    counts.uncaughtExceptions += 1;
    const fault = describeFault(error);
    const source = typeof origin === "string" ? origin : "uncaughtException";
    report("uncaught exception", source, fault);
    try {
      fatalRecorder?.(fault, source);
    } catch {
      reportBestEffortFailure();
    }
  } finally {
    process.exit(PROCESS_FAULT_EXIT_CODE);
  }
});

/** The sticky exit of a tool role: a later `process.exitCode = 0` (or `exit(0)`) cannot clear a lost fault. */
const onExit = guarded("process.fault-exit", (): void => {
  if (failedClosed && (process.exitCode === undefined || Number(process.exitCode) === 0)) {
    process.exitCode = PROCESS_FAULT_EXIT_CODE;
  }
});

/**
 * Install the policy for this process (its main thread, or a worker thread
 * for its own thread). Called ONLY by the three doors named in the header.
 * Once: a second install keeps the first role's listeners (one owner) and is
 * a no-op.
 */
export function installProcessFaultPolicy(options: Readonly<{ role: ProcessFaultRole }>): void {
  if (role !== undefined) return;
  role = options.role;
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  if (!SERVICE_ROLES.has(role)) process.on("exit", onExit);
}
