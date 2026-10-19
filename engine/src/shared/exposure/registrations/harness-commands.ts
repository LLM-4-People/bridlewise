/**
 * Shared exposure registrations — `harnessCommands` module.
 *
 * The bounds on the harness's own maintenance doors: how long the
 * typecheck step may run, how the shared lock behaves when the test
 * command holds it, how long the evaluation runner's identity probe may
 * take, and how the ONE command runner retries a command that ERRORED (the
 * machine, not the change: `harness.commandErroredRetries` /
 * `commandRetryBackoffMs`; a failed command is never retried, so no
 * verdict depends on them either).
 *
 * THE DISPOSITION DOCTRINE (this class's census, tests/prevention/
 * exposure-reachable.test.ts): the rows span three config sections
 * (`harness`, `resourceLock`, `evaluation`) because they answer ONE user
 * question — how the harness's own commands are bounded — and the census
 * binds every row by config path, so a row moved between modules stays
 * disposed. Each is an administrative RUN BOUND: no verdict depends on it,
 * a shorter bound fails closed (the step is abandoned and reported), the
 * same class the benchmark and workspace timeout bounds belong to. The
 * class's remaining leaves are FILED by the census: the evaluation
 * section's `maxOutputTokens` has reader code (the matrix generator accepts
 * the knob) but no production path forwards the document's value into it —
 * the wiring gap, filed with the missing consumer named.
 *
 * THE HONEST TIMING: every consumer is an engine command door — a fresh
 * process that resolves the pinned config document once per invocation —
 * so a settings write lands in the file and the NEXT run of that command
 * reads it.
 */

import {
  registerCustomization,
  registerExposureModule,
} from "../index.ts";
import { readNumberCustomization, writeConfigCustomization } from "../config-binding.ts";
import {
  commandRetryPolicy,
  DEFAULT_TYPECHECK_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_POLL_INTERVAL_MS,
  DEFAULT_LOCK_STALE_MS,
} from "../../../workflow/workflow-config.ts";
import { IDENTITY_ATTESTATION_TIMEOUT_MS } from "../../../evaluation/evaluation-config.ts";

const ROWS = [
  {
    id: "typecheckTimeoutMs",
    configPath: "harness.typecheckTimeoutMs",
    name: "How long one typecheck step may run",
    description:
      "The check command runs the project's typecheck step under this bound; a step that overruns is abandoned and reported rather than hanging the command. Lower = a wedged typechecker ends sooner; higher = a large project still finishes. Takes effect on the next run.",
    default: DEFAULT_TYPECHECK_TIMEOUT_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
  },
  {
    id: "commandErroredRetries",
    configPath: "harness.commandErroredRetries",
    name: "How often a command the machine interrupted is retried",
    description:
      "A command the harness runs for a checkout (a dependency install, a gate, a lockfile derivation — in a workspace, a candidate checkout or a promotion) that ERRORED — its time ran out, a signal ended it, or it reported a machine condition such as no space, a package-cache miss or a network reset — runs again this many times. A command that failed on its own is never retried. Lower = a busy or offline machine is reported sooner; higher = a transient condition is ridden out. Takes effect on the next run.",
    default: commandRetryPolicy({}).retries,
    min: 0,
    max: 10,
    unit: "retries",
  },
  {
    id: "commandRetryBackoffMs",
    configPath: "harness.commandRetryBackoffMs",
    name: "How long to wait before retrying an interrupted command",
    description:
      "The wait before the first retry of an errored command; each later retry waits twice as long as the one before. Lower = a retry comes sooner; higher = a busy machine gets longer to recover. Takes effect on the next run.",
    default: commandRetryPolicy({}).backoffMs,
    min: 0,
    max: 3_600_000,
    unit: "milliseconds",
  },
  {
    id: "lockTimeoutMs",
    configPath: "resourceLock.timeoutMs",
    name: "How long a command waits to take the shared lock",
    description:
      "Test commands serialize through one lock; a command that cannot take it within this bound gives up with a typed failure instead of queuing forever. Lower = a blocked command reports sooner; higher = a busy machine still gets its turn. Takes effect on the next run.",
    default: DEFAULT_LOCK_TIMEOUT_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
  },
  {
    id: "lockPollIntervalMs",
    configPath: "resourceLock.pollIntervalMs",
    name: "How often a waiting command rechecks the shared lock",
    description:
      "While waiting for the shared lock, a command rechecks this often. Lower = the lock is claimed the instant it frees, at the cost of more checks; higher = fewer checks, slightly later pickup. Takes effect on the next run.",
    default: DEFAULT_LOCK_POLL_INTERVAL_MS,
    min: 1,
    max: 60_000,
    unit: "milliseconds",
  },
  {
    id: "lockStaleMs",
    configPath: "resourceLock.staleMs",
    name: "How old an unreadable lock file is before it is taken over",
    description:
      "A lock file no harness process wrote (another format, a hand-made file) is honoured for this long, then taken over, so a foreign leftover cannot block the next command forever. A live holder is never taken over, however long it holds the lock, and a dead holder's lock is taken over at once. Lower = a foreign leftover clears sooner; higher = an unidentified file is kept longer for inspection. Takes effect on the next run.",
    default: DEFAULT_LOCK_STALE_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
  },
  {
    id: "identityAttestationTimeoutMs",
    configPath: "evaluation.identityAttestationTimeoutMs",
    name: "How long the evaluation identity probe may run",
    description:
      "The evaluation runner probes each model's identity before trusting it; the probe is bounded by this. Lower = an unresponsive model is refused sooner; higher = a slow provider still gets to answer. Takes effect on the next evaluation run.",
    default: IDENTITY_ATTESTATION_TIMEOUT_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
  },
] as const;

let harnessCommandsRegistered = false;
export function registerHarnessCommandsExposure(): void {
  if (harnessCommandsRegistered) return;
  harnessCommandsRegistered = true;

  registerExposureModule({
    id: "harnessCommands",
    title: "How the harness's own commands are bounded",
    purpose:
      "How long the harness's own maintenance steps may run — the typecheck step, the shared lock its test command holds, the evaluation runner's identity probe — and how a command the machine interrupted is retried.",
  });

  // --- Customizations (7: the command doors' run bounds and the command runner's errored-class retries) ---
  for (const spec of ROWS) {
    registerCustomization({
      id: `harnessCommands.${spec.id}`,
      module: "harnessCommands",
      name: spec.name,
      description: spec.description,
      type: "number",
      default: spec.default,
      min: spec.min,
      max: spec.max,
      unit: spec.unit,
      current: () => readNumberCustomization(spec.configPath, spec.default),
      set: (v) => writeConfigCustomization(spec.configPath, v),
      contract: { effect: "next-run" },
      configPath: spec.configPath,
    });
  }
}

/** Reset the per-module registration flag (test-only). */
export function resetHarnessCommandsRegistration(): void {
  harnessCommandsRegistered = false;
}
