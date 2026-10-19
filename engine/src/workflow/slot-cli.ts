/**
 * `harness slot run -- <command> [args…]` — THE SHELL'S DOOR TO THE HOST'S ONE
 * INSTRUMENT LOCK (src/process/instrument-lock.ts), for ad-hoc load and
 * performance work that no runner starts: a CPU hog, a file looped under load,
 * a profile. It waits for the lock (saying who holds it), runs the command
 * under the native supervisor (adopted into the lock: a door killed outright
 * leaves the lock held until the command and everything it started are gone),
 * and frees the lock when the command ends; its exit code is the command's.
 */
import { constants } from "node:os";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { testProcessSupervisorBinary } from "../../guardian/build.ts";
import { INPUT_ERROR_CODE, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { holdInstrumentLock, waitForInstrumentLock, wholeInstrumentTestFileCount } from "../process/instrument-lock.ts";
import { superviseCommand } from "../process/supervised-run.ts";
import { wrapResult, type CommandAnswer } from "./command-result.ts";
import { readTestExecutionConfig } from "./test-result-collector.ts";

export type SlotRunOutput = Readonly<{ command: readonly string[]; exitCode: number; ending: string }>;

/**
 * Who holds the lock, for a slot run: the program and how many arguments it
 * got — never the arguments themselves (a person reads it; a command line is
 * unbounded and carries anything).
 */
function slotRunLabel(command: readonly string[]): string {
  return `slot run: ${basename(command[0] ?? "")} (${String(command.length - 1)} argument(s))`;
}

/**
 * THE ONE "INSIDE THE DOOR" MARKER: the environment variable the supervising
 * door sets on the command it runs ({@link runInsideInstrumentLock}). A door
 * that re-ran itself (vitest, the coverage run, the perf profile) reads it to
 * take its inner path and never re-run a second time — and the inner path
 * still BORROWS the hold through the one lock door, which refuses it outside
 * a live hold: the marker chooses the path, never grants the lock.
 */
export const INSIDE_INSTRUMENT_LOCK_VARIABLE = "HARNESS_INSIDE_INSTRUMENT_LOCK";

/**
 * THE SUPERVISING DOOR (correctness L-N1): the host's one instrument lock for
 * `runner` (heavy by `testFileCount`; a whole instrument passes `Infinity`),
 * waited for, then `command` run under the native supervisor, ADOPTED into
 * the hold — so a door killed outright never frees the lock under its
 * command: the lock stays held until the command's whole process tree is
 * gone. Answers the command's exit code (a command a signal ended: 128 + its
 * number, the shell's convention). `harness slot run`, the coverage run and
 * the perf profile all hold the lock this way, never in their own process.
 */
/** The declared lock (required: its place and its poll are config). */
function declaredInstrumentLock<T>(lock: T | undefined): T {
  if (lock === undefined) throw new InputError("testExecution.instrumentLock is not declared in bridlewise.config.json", "instrument_lock_undeclared");
  return lock;
}

export async function runInsideInstrumentLock(runner: string, testFileCount: number, command: readonly string[], options: Readonly<{ lockPath?: string }> = {}): Promise<Readonly<{ exitCode: number; ending: string }>> {
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  const config = readTestExecutionConfig(engineRoot);
  const onWait = (line: string): void => void process.stderr.write(`${line}\n`);
  // `lockPath`: a test's own lock file (the host's lock is never a test's to take).
  const lock = options.lockPath !== undefined
    ? await waitForInstrumentLock(options.lockPath, runner, { onWait, pollIntervalMs: declaredInstrumentLock(config.instrumentLock).pollIntervalMs })
    : await holdInstrumentLock({ config: config.instrumentLock, harnessRoot: engineRoot, runner, testFileCount, onWait });
  try {
    const run = await superviseCommand({
      supervisor: testProcessSupervisorBinary(),
      command: command[0]!,
      args: command.slice(1),
      hardCeilingMs: config.engineSuiteWatchdog.hardCeilingMs,
      killGraceMs: config.engineSuiteWatchdog.killGraceMs,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
      env: { ...process.env, [INSIDE_INSTRUMENT_LOCK_VARIABLE]: "1" },
      killOnInterrupt: true,
    });
    const exitCode = run.signal !== null ? 128 + constants.signals[run.signal] : run.ending === "exited" ? run.exitCode : 1;
    return deepFreeze({ exitCode, ending: run.ending });
  } finally {
    lock.release();
  }
}

export async function runSlotCli(argv: readonly string[]): Promise<CommandAnswer<SlotRunOutput>> {
  if (argv[0] !== "run" || argv[1] !== "--" || argv.length < 3) {
    throw new InputError("harness slot takes: run -- <command> [args…]", INPUT_ERROR_CODE);
  }
  const command = argv.slice(2);
  // A whole instrument (an ad-hoc load or profile), heavy by kind (config `wholeInstruments`).
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  const count = wholeInstrumentTestFileCount(declaredInstrumentLock(readTestExecutionConfig(engineRoot).instrumentLock), "slot");
  const { exitCode, ending } = await runInsideInstrumentLock(slotRunLabel(command), count, command);
  return { result: wrapResult("slot", deepFreeze({ command, exitCode, ending }), { status: exitCode === 0 ? "pass" : "fail" }), exitCode };
}
