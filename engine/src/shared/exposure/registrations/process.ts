/**
 * Shared exposure registrations — `process` module.
 *
 * The faults this process met (SCALE-CR1 C2/C3): what the one fault policy
 * (`src/process/fault-policy.ts`) handled — unhandled promise rejections, and
 * throws inside event-loop callbacks that `guarded(owner, fn)` caught — and
 * the last one, redacted. A service (the web server) lives on after one; a
 * tool (a CLI, a worker) fails closed with exit 70; a test run fails on one
 * (a process with no role re-raises it) — the budget of 0, enforced. An
 * uncaught exception is fail-stop (exit 70 for the supervisor), so it is not
 * a counter a live process can show; it is the `process-fault` event in the
 * ledger.
 */
import { registerExposureModule, registerSignal } from "../index.ts";
import { lastProcessFault, processFaultCounts, processFaultRole } from "../../../process/fault-policy.ts";

let processRegistered = false;

export function registerProcessExposure(): void {
  if (processRegistered) return;
  processRegistered = true;

  registerExposureModule({
    id: "process",
    title: "Faults this process met",
    purpose:
      "A fault that escaped every handler used to end the whole process. The fault policy now counts it here (an unhandled rejection, a throw inside a timer or listener): the server keeps running, a tool fails closed; each count is a defect with an owner, never noise.",
  });

  registerSignal({
    id: "process.faults.role",
    module: "process",
    name: "Fault policy",
    description: "Which fault policy this process installed at its start (server, server-thread, cli or worker); empty means none was installed, and an escaped fault follows Node's default.",
    type: "string",
    value: () => processFaultRole() ?? "",
  });
  registerSignal({
    id: "process.faults.unhandledRejections",
    module: "process",
    name: "Unhandled promise rejections",
    description: "Promises that failed with nobody awaiting them, since this process started. Each one is reported with its cause; a server keeps running, a tool exits 70. The budget is 0.",
    type: "counter",
    unit: "rejections",
    value: () => processFaultCounts().unhandledRejections,
  });
  registerSignal({
    id: "process.faults.guardedCallbacks",
    module: "process",
    name: "Callback faults caught",
    description: "Throws inside a timer, listener or message handler that the event-loop guard caught and attributed to its owner, since this process started. Each one is reported; a server keeps running, a tool exits 70. The budget is 0.",
    type: "counter",
    unit: "faults",
    value: () => processFaultCounts().guardedCallbackFaults,
  });
  registerSignal({
    id: "process.faults.lastFault",
    module: "process",
    name: "Last fault",
    description: "The most recent fault this process survived: where it happened and what it said, with secrets masked. Admins only.",
    type: "string",
    value: () => lastProcessFault(),
    visibility: { viewer: "admin", publicValue: () => (lastProcessFault() === "" ? "" : "a fault was recorded") },
  });
}

/** Reset the registration flag (test-only). */
export function resetProcessRegistration(): void {
  processRegistered = false;
}
