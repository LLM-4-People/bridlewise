/**
 * PREPARE A PRIVATE CHECKOUT AND RUN ITS DECLARED COMMANDS — THE ONE OWNER.
 *
 * A checkout made for isolated work (a `harness workspace` worktree, a
 * candidate that qualifies a dirty tree, the commit guard's materialized
 * index) holds the repository's files and nothing else. Before the harness
 * can run there it needs what git never carries, and every agent used to
 * recreate that by hand, each time missing a different piece (the corpus
 * link, the guardian's test binaries, the hooks path, the 0600 config mode).
 * All of it is declared in the configuration's `workspaceIsolation` section
 * and applied here:
 *
 * - `links`: ignored paths recreated as symlinks to the source checkout's
 *   entry (a shared corpus too large to copy) — {@link applyCheckoutFiles};
 * - the configuration document's required mode (git checks it out 0644; the
 *   loader refuses anything but the policy mode) — {@link applyCheckoutFiles};
 * - the PHASES: `setup` (dependency installs from the checkout's own
 *   lockfiles, native build outputs, the bundle), and the workspace's gates
 *   (`validate`, `regenerate`, `merge`) — {@link runCheckoutPhase}.
 *
 * Every command runs through ONE runner, {@link runCheckoutCommand}: in the
 * checkout, under the native supervisor (`src/process/supervised-run.ts`: the
 * command's `timeoutMs` is its hard ceiling, and it and every descendant die
 * with it — a process-group kill cannot reach a detached grandchild), with
 * its output kept to a bounded tail, an ERRORED run retried by the runner's own
 * policy (every consumer — workspace phases and gates, the candidate
 * checkout, the promotion's lockfiles — gets it from the one runner it is
 * handed), and every attempt logged once, here. A phase is fail-fast: the
 * first failing command ends it, and the commands after it are reported as
 * skipped — a red typecheck makes a suite run meaningless.
 *
 * THE FIXED POINT ({@link convergeUntilStable}) is the one loop every
 * converging consumer runs: `harness sync` (`harnessSync` in
 * `harness-commands.ts`, over the generated outputs' digests) and a promotion
 * candidate's converge commands (`tree-landing.ts`, over its staged tree), so
 * the bound, the oscillation rule and the report are the same everywhere.
 *
 * Where a private checkout may live: on the source's filesystem
 * ({@link assertSameFilesystem}) — the harness refuses a root under another
 * mount (`safe_path_root_ancestor_mountpoint`), and a tmpfs loses it.
 */

import { appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { generateId, sha256 } from "../kernel/integrity.ts";
import { persistableText } from "../privacy/evidence-handler.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE, removeOwnedTemporaryDirectory } from "../filesystem/private-state.ts";
import { QUALIFICATION_INVOCATION_ENV } from "../shared/run-history.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import type { WorkspaceIsolationConfig } from "../kernel/config-contracts.ts";
import { directoryGitEnvironment } from "../git/repository-ownership.ts";
import { superviseCommand, type SupervisedCommand } from "../process/supervised-run.ts";
import { debugLog } from "../shared/debug/debug-system.ts";
import { DEFAULT_MAXIMUM_GATE_OUTPUT_CHARACTERS, commandRetryPolicy } from "./workflow-config.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { workingTreeId } from "../git/working-copy.ts";
import { holdInstrumentLock, waitForInstrumentLock, wholeInstrumentTestFileCount, type InstrumentHold } from "../process/instrument-lock.ts";
import { readTestExecutionConfig } from "./test-result-collector.ts";

/**
 * Why a command failed: ERRORED — the environment ended it (its ceiling, a
 * signal or a stop, a supervisor that left no receipt) or its output reports
 * an environmental error (see {@link commandFailureClass}: no space, an npm
 * cache miss, a network reset) — or FAILED: any other non-zero exit, a real
 * defect of the tree it ran on. Only an errored command is retried (the
 * runner's {@link CommandRetryPolicy}); a failure is never re-run away.
 */
export type CheckoutFailureClass = "errored" | "failed";

/**
 * How a command ran (merge-door-final §7.4: what a receipt records of every
 * command): its argv and folder, how many attempts the errored-class retry
 * took, their total duration, and the machine's load and parallelism when it
 * ended — so a slow or errored run is judged against the load it met.
 */
export type CommandEvidence = Readonly<{ argv: readonly string[]; cwd: string; attempts: number; durationMs: number; load: number; parallelism: number; invocationId?: string; terminal?: SupervisedCommand }>;

/** One step a checkout took: a link, the config mode, or a command (a gate). */
export type CheckoutStep = Readonly<{
  step: string;
  status: "pass" | "fail" | "skip";
  message: string;
  /** The command's output tail (bounded), when it produced any. */
  details: readonly string[];
  /** A failed command's class; absent on every other step. */
  failure?: CheckoutFailureClass;
  /** How a command ran (a command's step only). */
  evidence?: CommandEvidence;
}>;

type Isolation = NonNullable<WorkspaceIsolationConfig>;
export type CheckoutCommand = Isolation["commands"][string];
export type CheckoutPhase = keyof Isolation["phases"];
type IsolationFiles = Pick<Isolation, "links">;
type IsolationPhases = Pick<Isolation, "commands" | "phases">;

/** How an errored command is retried: `retries` more attempts, the first after `backoffMs`, each next after twice the last wait. */
export type CommandRetryPolicy = Readonly<{
  retries: number;
  backoffMs: number;
  /** Waits `ms` (a test injects its own clock). */
  sleep?: (ms: number) => Promise<void>;
}>;

/** How commands are run: the native supervisor binary, its kill grace, the output tail kept, and the errored-class retry policy. */
export type CheckoutCommandRunner = Readonly<{
  /** The native supervisor (`testProcessSupervisorBinary()`, built by the caller). */
  supervisor: string;
  killGraceMs: number;
  /** How many characters of a command's output (stdout and stderr, interleaved) are kept. */
  outputCharacters: number;
  /** How an ERRORED run is retried (`harness.commandErroredRetries` / `commandRetryBackoffMs`: `commandRetryPolicy`, src/workflow/workflow-config.ts). */
  retries: CommandRetryPolicy;
  /** Told when each command starts (an operator's progress line). */
  onStart?: (step: string, argv: readonly string[]) => void;
  /** A test's own instrument lock (the host's lock is never a test's to take); absent, the host's, from config. */
  instrumentLock?: Readonly<{ lockPath: string; pollIntervalMs: number }>;
}>;

/**
 * The ONE runner as the configuration declares it — the one construction
 * every consumer uses (the workspace CLI, the candidate checkout, the
 * promotion): the native supervisor the caller built, the isolation's kill
 * grace, the gate output tail, and the errored-class retry policy
 * (`harness.commandErroredRetries` / `commandRetryBackoffMs`).
 */
export function configuredCheckoutCommandRunner(
  document: Parameters<typeof commandRetryPolicy>[0],
  isolation: Pick<Isolation, "killGraceMs">,
  supervisor: string,
  onStart?: CheckoutCommandRunner["onStart"],
): CheckoutCommandRunner {
  return Object.freeze({
    supervisor,
    killGraceMs: isolation.killGraceMs,
    outputCharacters: DEFAULT_MAXIMUM_GATE_OUTPUT_CHARACTERS,
    retries: commandRetryPolicy(document),
    ...(onStart === undefined ? {} : { onStart }),
  });
}

/** The engine root's path relative to the repository top level (derived, never configured). */
export function engineRelativePath(repositoryRoot: string, engineRoot: string): string {
  return relative(realpathSync(repositoryRoot), realpathSync(engineRoot)).split(sep).join("/");
}

function step(name: string, status: CheckoutStep["status"], message: string, details: readonly string[] = [], failure?: CheckoutFailureClass, evidence?: CommandEvidence): CheckoutStep {
  return Object.freeze({
    step: name, status, message, details: Object.freeze([...details]),
    ...(failure === undefined ? {} : { failure }),
    ...(evidence === undefined ? {} : { evidence: Object.freeze({ ...evidence, argv: Object.freeze([...evidence.argv]) }) }),
  });
}

const ENVIRONMENTAL_CODES = ROOT_POLICY.workflow.commandRunner.environmentalErrorCodes.join("|");
/**
 * A line that REPORTS an environmental error — npm's own diagnostic
 * (`npm error code ENOTCACHED`, `npm ERR! errno ENOSPC`), an uncaught
 * system error (`Error: ENOSPC: …`), a tool's `…: No space left on device` —
 * as opposed to a line that merely mentions a code (a test named after one,
 * an assertion quoting one), which says nothing about the machine.
 */
const ENVIRONMENTAL_LINE = new RegExp(`^(?:npm (?:ERR!|error) (?:code|errno) (?:${ENVIRONMENTAL_CODES})\\b|(?:Error|SystemError): (?:${ENVIRONMENTAL_CODES})\\b|.*: No space left on device$)`, "mu");

/** The class of a failed run: errored when the environment ended it or a line of its tail reports an environmental error (see {@link CheckoutFailureClass}). */
export function commandFailureClass(ending: SupervisedCommand["ending"], tail: string): CheckoutFailureClass {
  if (ending !== "exited") return "errored";
  return ENVIRONMENTAL_LINE.test(tail) ? "errored" : "failed";
}

/**
 * THE ONE COMMAND RUNNER (see the header). A command that exits 0 passes;
 * anything else — a non-zero exit, its ceiling, a signal, a supervisor that
 * left no receipt — fails, with the output tail as the detail. An ERRORED
 * failure is retried by `runner.retries` (a doubling backoff); a FAILED one,
 * a pass or a skip is answered at once. The last attempt's answer is
 * returned, its message naming how many attempts ran.
 */
export async function runCheckoutCommand(
  checkoutRoot: string,
  name: string,
  command: CheckoutCommand,
  runner: CheckoutCommandRunner,
): Promise<CheckoutStep> {
  if (command.holdsInstrumentLock === true) return runHoldingInstrumentLock(checkoutRoot, name, command, runner);
  return runWithRetries(checkoutRoot, name, command, runner);
}

/** This engine's root (the configuration that declares the host's instrument lock). */
const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A SETUP COMMAND THAT IS A HEAVY INSTRUMENT (`holdsInstrumentLock`: the web
 * module cache warm-up collects the whole suite). It runs ONCE PER TREE: the
 * tree it ran for is recorded beside the checkout's gate logs (outside the
 * checkout, removed with it), and the same tree is not run again. Otherwise
 * THIS RUNNER takes the host's one instrument lock first, waiting with no
 * deadline and naming the holder on every change (a validate holding the lock
 * makes a create wait, never fail), and only then starts the command, whose
 * `timeoutMs` bounds the command alone; the command runs inside the hold (the
 * vitest door borrows it). The lock has no queue, so the wait names the holder,
 * not a position (a queue is the lock's fairness redesign, E-03).
 */
async function runHoldingInstrumentLock(checkoutRoot: string, name: string, command: CheckoutCommand, runner: CheckoutCommandRunner): Promise<CheckoutStep> {
  const marker = join(gateLogDirectory(checkoutRoot), `${name}.tree`);
  const tree = workingTreeId(checkoutRoot);
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === tree) {
    return step(name, "pass", `already run for this tree (${tree}): a heavy setup command runs once per tree`);
  }
  const label = `checkout setup: ${name}`;
  const onWait = (line: string): void => void process.stderr.write(`${line} (a setup step's wait counts toward no timeout)\n`);
  let hold: InstrumentHold;
  if (runner.instrumentLock !== undefined) {
    hold = await waitForInstrumentLock(runner.instrumentLock.lockPath, label, { onWait, pollIntervalMs: runner.instrumentLock.pollIntervalMs });
  } else {
    const lock = readTestExecutionConfig(ENGINE_ROOT).instrumentLock;
    if (lock === undefined) throw new InputError("testExecution.instrumentLock is not declared in bridlewise.config.json", "instrument_lock_undeclared");
    hold = await holdInstrumentLock({ config: lock, harnessRoot: ENGINE_ROOT, runner: label, testFileCount: wholeInstrumentTestFileCount(lock, "slot"), onWait });
  }
  try {
    const outcome = await runWithRetries(checkoutRoot, name, command, runner);
    if (outcome.status === "pass") {
      const written = atomicWriteFile(marker, `${tree}\n`, { createMode: PRIVATE_STATE_FILE_MODE });
      if (!written.success) throw new HarnessError(`the tree ${name} ran for could not be recorded at ${marker}: ${written.reason ?? "unknown"}`, "checkout_setup_record_failed");
    }
    return outcome;
  } finally {
    hold.release();
  }
}

/** One command with the errored-class retries (see {@link runCheckoutCommand}). */
async function runWithRetries(checkoutRoot: string, name: string, command: CheckoutCommand, runner: CheckoutCommandRunner): Promise<CheckoutStep> {
  const argv = command.argv;
  const { retries, backoffMs } = runner.retries;
  const sleep = runner.retries.sleep ?? ((ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  let outcome = await runOnce(checkoutRoot, name, command, runner, argv, 1);
  let durationMs = outcome.evidence!.durationMs;
  for (let attempt = 1; attempt <= retries && outcome.failure === "errored"; attempt += 1) {
    const wait = backoffMs * 2 ** (attempt - 1);
    debugLog("workflow", "warn", `${name} errored; retrying after ${String(wait)}ms`, () => ({ command: name, attempt, of: retries + 1, waitMs: wait }));
    await sleep(wait);
    outcome = await runOnce(checkoutRoot, name, command, runner, argv, attempt + 1);
    durationMs += outcome.evidence!.durationMs;
    const evidence = { ...outcome.evidence!, durationMs };
    outcome = outcome.status === "fail"
      ? step(name, "fail", `${outcome.message} (attempt ${String(attempt + 1)} of ${String(retries + 1)})`, outcome.details, outcome.failure, evidence)
      : Object.freeze({ ...outcome, evidence: Object.freeze(evidence) });
  }
  return outcome;
}

/**
 * WHERE A CHECKOUT'S GATE LOGS GO: never inside it (a log there is a write no
 * generator declares, and a promotion's converge refuses it), but under the
 * run's temp root (D-19), one private folder per checkout, named by its
 * folder name and a digest of its real path. A temp root inside the checkout
 * would put them back inside: refused by name.
 */
export function gateLogDirectory(checkoutRoot: string): string {
  const real = realpathSync(checkoutRoot);
  const directory = gateLogPlace(real);
  const inside = relative(real, directory);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new InputError(`the gate logs of ${real} would land inside it (${directory}): set TMPDIR to a private folder outside the checkout (D-19)`, "gate_log_inside_checkout");
  }
  return ensurePrivateStateDirectory(directory);
}

/** The gate-log folder of the checkout whose real path is `real` (named, never created). */
function gateLogPlace(real: string): string {
  return join(tmpdir(), ROOT_POLICY.filesystemInfrastructure.gateLogFolder, `${basename(real)}-${sha256(real).slice(0, ROOT_POLICY.filesystemInfrastructure.gateLogCheckoutDigestHexDigits)}`);
}

/**
 * A checkout's gate logs live as long as the checkout: whoever removes a
 * checkout (a workspace's abort or merge, a promotion's candidate sweep)
 * removes its logs first, while its real path can still be read; a checkout
 * already gone leaves nothing to name.
 */
export function removeGateLogs(checkoutRoot: string): void {
  let real: string;
  try { real = realpathSync(checkoutRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  removeOwnedTemporaryDirectory(gateLogPlace(real));
}

/** The end of the last complete line in `text` (after its last `\n` or `\r`), or 0 when it holds none. */
function lastLineEnd(text: string): number {
  return Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
}

/** One attempt of {@link runCheckoutCommand}: the supervised run, its step, and its one log line. */
async function runOnce(checkoutRoot: string, name: string, command: CheckoutCommand, runner: CheckoutCommandRunner, argv: readonly string[], attempt: number): Promise<CheckoutStep> {
  runner.onStart?.(name, argv);
  const invocationId = command.ledger === undefined ? undefined : generateId("qualification");
  // THE WHOLE OUTPUT IS KEPT, REDACTED, OUTSIDE THE CHECKOUT: the step carries
  // a bounded tail for the report and the full log under the run's temp root
  // ({@link gateLogDirectory}). Both pass the one redaction (D-09, UR-21:
  // redact, never block) a complete line at a time, so a credential is never
  // split across two redactions.
  const logPath = join(gateLogDirectory(checkoutRoot), `${name}-${new Date().toISOString().replace(/[:.]/gu, "-")}-attempt-${String(attempt)}.log`);
  // Created exclusively, never through a link, and written through its descriptor (the workflow's write rule: no
  // write by path outside the one atomic writer; a log is appended, so it is a descriptor of its own).
  const logFd = openSync(logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, PRIVATE_STATE_FILE_MODE);
  try {
    let output = "";
    const pending = { stdout: "", stderr: "" };
    // A stream whose unended line grew past the bound: its rest is discarded until the line ends.
    const overflowing = { stdout: false, stderr: false };
    const lineMaximum = ROOT_POLICY.filesystemInfrastructure.gateLogLineMaximumCharacters;
    // One decoder per stream: a character split across two pipe chunks is decoded whole, never as U+FFFD.
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const flush = (stream: keyof typeof pending, final: boolean, arrived = ""): void => {
      const text = final ? `${pending[stream]}${decoders[stream].end()}` : pending[stream];
      // REDACTED BEFORE ANY SPLIT: a logical line (ended by `\n` or `\r`) reaches the one redaction WHOLE, however
      // long it grows and however its bytes arrive, so a key and its value (`password: v`, `password = v`,
      // `"password": "v"`) are never redacted apart. The line is held until it ends; only the stream's end flushes
      // an unended one. Only the new chunk is searched for an end, so a long line costs its length once.
      // A LINE WITH NO END PAST THE BOUND is withheld WHOLE, never split (a split could part a key from its value):
      // the place says so, and the rest of that line is discarded as it arrives, so the memory a line costs is
      // bounded.
      const written = (piece: string): void => {
        appendFileSync(logFd, piece);
        output = `${output}${piece}`;
        if (output.length > 2 * runner.outputCharacters) output = output.slice(-runner.outputCharacters);
      };
      if (overflowing[stream]) {
        const end = final ? text.length : text.search(/[\n\r]/u) + 1;
        if (end === 0) { pending[stream] = ""; return; }
        overflowing[stream] = false;
        pending[stream] = text.slice(end);
        flush(stream, final, pending[stream]);
        return;
      }
      if (!final && !/[\n\r]/u.test(arrived)) {
        if (text.length <= lineMaximum) return;
        written(`[withheld: a line of more than ${String(lineMaximum)} characters with no end; not redactable whole]\n`);
        overflowing[stream] = true;
        pending[stream] = "";
        return;
      }
      const cut = final ? text.length : lastLineEnd(text);
      if (cut === 0) return;
      pending[stream] = text.slice(cut);
      const lines = text.slice(0, cut);
      const kept = persistableText(lines);
      written(lines.endsWith("\n") && !kept.endsWith("\n") ? `${kept}\n` : kept);
    };
    const keep = (stream: keyof typeof pending) => (chunk: Buffer): void => {
      const arrived = decoders[stream].write(chunk);
      pending[stream] = `${pending[stream]}${arrived}`;
      flush(stream, false, arrived);
    };
    const run = await superviseCommand({
      supervisor: runner.supervisor,
      command: argv[0]!,
      args: argv.slice(1),
      hardCeilingMs: command.timeoutMs,
      killGraceMs: runner.killGraceMs,
      cwd: join(checkoutRoot, command.cwd),
      env: { ...directoryGitEnvironment(), ...(invocationId === undefined ? {} : { [QUALIFICATION_INVOCATION_ENV]: invocationId }) },
      onStdout: keep("stdout"),
      onStderr: keep("stderr"),
      killOnInterrupt: true,
    });
    flush("stdout", true);
    flush("stderr", true);
    const tail = output.trim().slice(-runner.outputCharacters);
    // A run whose streams did not close within the grace after its exit kept what arrived, and says so.
    const fullLog = `full output (${String(fstatSync(logFd).size)} bytes${run.outputComplete ? "" : ", INCOMPLETE: the streams did not close within the grace after the exit"}): ${logPath}`;
    const spelled = `${argv.join(" ")} (in ${command.cwd})`;
    const passed = run.ending === "exited" && run.exitCode === 0;
    const failure = passed ? undefined : commandFailureClass(run.ending, tail);
    const evidence: CommandEvidence = { argv, cwd: command.cwd, attempts: attempt, durationMs: run.elapsedMs, load: loadavg()[0]!, parallelism: availableParallelism(),
      ...(invocationId === undefined ? {} : { invocationId }), terminal: run };
    debugLog("workflow", passed ? "info" : "warn", `${name} ${passed ? "passed" : failure!}`, () => ({
      command: name, class: failure ?? "pass", ending: run.ending, exit: run.exitCode, signal: run.signal, durationMs: run.elapsedMs, attempt, load: evidence.load, parallelism: evidence.parallelism,
    }));
    if (passed) return step(name, "pass", spelled, tail.length === 0 ? [fullLog] : [tail, fullLog], undefined, evidence);
    const why = run.ending === "exited" ? `exited ${String(run.exitCode)}` : run.ending === "ceiling" ? `reached its ${String(command.timeoutMs)}ms ceiling and was killed` : `ended: ${run.ending}`;
    return step(name, "fail", `${spelled} ${why}`, tail.length === 0 ? [fullLog] : [tail, fullLog], failure, evidence);
  } finally {
    closeSync(logFd);
  }
}

/** Runs one declared command (by name) and answers its step: {@link checkoutCommandRunner}, or a test's fake. */
export type RunCheckoutCommand = (name: string, command: CheckoutCommand) => Promise<CheckoutStep>;

/** The production {@link RunCheckoutCommand}: {@link runCheckoutCommand} in `checkoutRoot`. */
export function checkoutCommandRunner(checkoutRoot: string, runner: CheckoutCommandRunner): RunCheckoutCommand {
  return (name, command) => runCheckoutCommand(checkoutRoot, name, command, runner);
}

/**
 * The registry commands nothing runs: declared in `commands`, named by no
 * workspace phase and by none of `consumers` (the other consumers' command
 * names — a promotion profile's phases and transforms). Dead config. Judged by
 * `harness check` over the checkout, where the profiles are visible (the
 * configuration schema alone cannot see them).
 */
export function unconsumedCommands(isolation: IsolationPhases, consumers: Iterable<string>): readonly string[] {
  const run = new Set(commandsRun(isolation.commands, [...Object.values(isolation.phases).flat(), ...consumers]));
  return Object.freeze(Object.keys(isolation.commands).filter((name) => !run.has(name)).sort());
}

/**
 * The commands a sequence of `names` runs ({@link runDeclaredCommands}): each
 * gate's producers before its first gate, every name once. What a ceiling,
 * a plan digest or a toolchain census of the sequence must count.
 */
export function commandsRun(commands: Isolation["commands"], names: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(names.flatMap((name) => [...(commands[name]?.requires ?? []), name]))]);
}

function declaredCommand(isolation: Pick<Isolation, "commands">, name: string): CheckoutCommand {
  const command = isolation.commands[name];
  if (command === undefined) throw new InputError(`a phase names an undeclared command ${name}`, "checkout_setup_command_undeclared");
  return command;
}

/**
 * Runs the registry commands `names` in order, FAIL-FAST: after the first
 * failing command the rest are reported as skipped. `phase` names the
 * sequence in those skip messages; `only` narrows it to the commands it
 * admits (the setup re-run). The one sequencer of declared commands: a
 * workspace phase ({@link runCheckoutPhase}) and a promotion profile's phases
 * (its own lists of registry names) both run through it.
 *
 * A gate that `requires` producers has each run first — once per sequence,
 * however many gates require it — and is not run when one failed: a gate
 * never judges an artifact no step of this sequence produced.
 */
export async function runDeclaredCommands(
  isolation: Pick<Isolation, "commands">,
  phase: string,
  names: readonly string[],
  run: RunCheckoutCommand,
  only?: (name: string, command: CheckoutCommand) => boolean,
): Promise<readonly CheckoutStep[]> {
  const steps: CheckoutStep[] = [];
  const produced = new Set<string>();
  let failed: string | undefined;
  for (const name of names) {
    const command = declaredCommand(isolation, name);
    if (only !== undefined && !only(name, command)) continue;
    if (failed !== undefined) {
      steps.push(step(name, "skip", `not run: ${failed} failed earlier in the ${phase} phase`));
      continue;
    }
    for (const producer of command.requires ?? []) {
      if (produced.has(producer)) continue;
      const made = await run(producer, declaredCommand(isolation, producer));
      steps.push(made);
      if (made.status === "fail") {
        failed = producer;
        break;
      }
      produced.add(producer);
    }
    if (failed !== undefined) {
      steps.push(step(name, "skip", `not run: ${failed}, which produces what it judges, failed in the ${phase} phase`));
      continue;
    }
    const outcome = await run(name, command);
    steps.push(outcome);
    if (outcome.status === "fail") failed = name;
  }
  return Object.freeze(steps);
}

/** Runs one declared workspace phase ({@link runDeclaredCommands} over `isolation.phases[phase]`). */
export function runCheckoutPhase(
  isolation: IsolationPhases,
  phase: CheckoutPhase,
  run: RunCheckoutCommand,
  only?: (name: string, command: CheckoutCommand) => boolean,
): Promise<readonly CheckoutStep[]> {
  return runDeclaredCommands(isolation, phase, isolation.phases[phase], run, only);
}

/** Whether a changed repository path is one of a command's declared inputs (a file, or a directory prefix). */
function touchesInputs(inputs: readonly string[], changed: readonly string[]): boolean {
  return changed.some((path) => inputs.some((input) => path === input || path.startsWith(`${input}/`)));
}

/**
 * Re-runs, in declared order, every setup command one of whose `inputs` is
 * among `changedPaths` (a refreshed checkout whose lockfile or guardian
 * sources moved must not qualify on the old dependencies or binaries) or
 * that is still `owed` (it failed, or was skipped after a failure, at its
 * last attempt: {@link owedSetup} — the LAST SUCCESS counts, never the last
 * attempt), and that `also` admits (a consumer that needs only part of the
 * setup: the promoter home, the engine's own). Fail-fast; returns the steps
 * it took.
 */
export function rerunChangedSetup(
  isolation: IsolationPhases,
  changedPaths: readonly string[],
  run: RunCheckoutCommand,
  also: (name: string, command: CheckoutCommand) => boolean = () => true,
  owed: ReadonlySet<string> = new Set(),
): Promise<readonly CheckoutStep[]> {
  return runCheckoutPhase(isolation, "setup", run, (name, command) => (owed.has(name) || touchesInputs(command.inputs ?? [], changedPaths)) && also(name, command));
}

/**
 * The setup commands still OWED after `steps` (a setup or a re-run of it):
 * each that failed or was skipped after a failure, plus each `owed` before
 * that the steps did not run — in declared order. A checkout records it, so
 * its next re-run runs them whatever its inputs say (PROMO2FIX-N8: a
 * candidate whose setup failed at create never re-ran that step).
 */
export function owedSetup(isolation: IsolationPhases, steps: readonly CheckoutStep[], owed: ReadonlySet<string> = new Set()): readonly string[] {
  const outcome = new Map(steps.map((taken) => [taken.step, taken.status]));
  return Object.freeze(isolation.phases.setup.filter((name) => outcome.has(name) ? outcome.get(name) !== "pass" : owed.has(name)));
}

/**
 * A named observation about a converged run. `source_generated_outputs_stale`:
 * the FIRST pass rewrote generated outputs the tree held, i.e. its generated
 * values were not what its own sources produce — it was not synced, or a
 * generated value depends on history rather than on sources (the FR-15 class:
 * two fresh checkouts of one tree must agree).
 */
export type ConvergenceFinding = Readonly<{ code: "source_generated_outputs_stale"; paths: readonly string[] }>;

/** What a fixed point took: how many passes, what each changed (the last nothing), and the findings. */
export type ConvergenceReport = Readonly<{
  passes: number;
  changedByPass: readonly (readonly string[])[];
  /** True when the first pass changed nothing: the tree's generated outputs were current. */
  convergedOnFirstPass: boolean;
  findings: readonly ConvergenceFinding[];
}>;

/** The report of a run whose passes changed `changedByPass` (the last entry empty when it converged). */
export function convergenceReport(changedByPass: readonly (readonly string[])[]): ConvergenceReport {
  const first = changedByPass[0] ?? [];
  return Object.freeze({
    passes: changedByPass.length,
    changedByPass: Object.freeze(changedByPass.map((entry) => Object.freeze([...entry]))),
    convergedOnFirstPass: first.length === 0,
    findings: Object.freeze(first.length === 0 ? [] : [Object.freeze({ code: "source_generated_outputs_stale" as const, paths: Object.freeze([...first]) })]),
  });
}

/** How many passes a fixed point over `outputs` changing things may take: one per output, plus the pass that changes nothing. */
export function convergeBound(outputs: number): number {
  return outputs + 1;
}

/** A fixed point that was not reached: an oscillation (a state seen before) or the bound exhausted; `paths` are what kept changing. */
export class NotConvergedError extends HarnessError {
  readonly passes: number;
  readonly paths: readonly string[];
  readonly oscillates: boolean;

  constructor(message: string, code: string, passes: number, paths: readonly string[], oscillates: boolean) {
    super(message, code, false, { passes: String(passes), paths: paths.join(", ") });
    this.passes = passes;
    this.paths = Object.freeze([...paths]);
    this.oscillates = oscillates;
  }
}

/**
 * THE FIXED POINT — the one loop every converging consumer runs (`harness
 * sync`, a promotion candidate's converge phase): `pass` runs until one
 * leaves `fingerprint` (path → digest) unchanged; that pass's own output is
 * the result (a red pass on a state the pass no longer changes is a real
 * red). A pass that FAILED but changed outputs is followed by another: after
 * a registry edit the first pass's check judges pins the same pass is still
 * re-deriving, and the second pass is the first green one. A pass that brings
 * the state back to one an EARLIER pass left is an oscillation, refused at
 * once ({@link NotConvergedError} with the caller's `code`, naming what
 * changes around the cycle) — never looped on until a ceiling. `bound`
 * ({@link convergeBound}) is only the structural safety net for a generator
 * that never repeats a state.
 */
export async function convergeUntilStable<Output extends Readonly<{ allPassed: boolean }>>(
  pass: () => Promise<Output>,
  fingerprint: () => ReadonlyMap<string, string>,
  bound: number,
  failure: Readonly<{ subject: string; code: string }>,
): Promise<Readonly<{ output: Output; convergence: ConvergenceReport }>> {
  const changedByPass: string[][] = [];
  const stateKey = (state: ReadonlyMap<string, string>): string => JSON.stringify([...state].toSorted(([left], [right]) => left.localeCompare(right)));
  let before = fingerprint();
  const seen = [stateKey(before)];
  for (let attempt = 1; attempt <= bound; attempt += 1) {
    const output = await pass();
    const after = fingerprint();
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => after.get(path) !== before.get(path)).toSorted();
    changedByPass.push(changed);
    if (changed.length === 0) return { output, convergence: convergenceReport(changedByPass) };
    const key = stateKey(after);
    const repeated = seen.indexOf(key);
    if (repeated >= 0) {
      const cycling = [...new Set(changedByPass.slice(repeated).flat())].toSorted();
      throw new NotConvergedError(`${failure.subject} oscillates: pass ${String(attempt)} brought the outputs back to the state after pass ${String(repeated)}; changing around the cycle: ${cycling.join(", ")}`, failure.code, attempt, cycling, true);
    }
    seen.push(key);
    before = after;
  }
  const still = changedByPass.at(-1)!;
  throw new NotConvergedError(`${failure.subject} did not converge in ${String(bound)} passes; still changing: ${still.join(", ")}`, failure.code, bound, still, false);
}

/** The nearest existing ancestor of `path` (a checkout's parents may not exist yet). */
function nearestExisting(path: string): string {
  let current = path;
  while (lstatSync(current, { throwIfNoEntry: false }) === undefined && dirname(current) !== current) current = dirname(current);
  return current;
}

/**
 * Refuses (`code`) a private checkout `target` — the folder itself, which
 * may not exist yet — that would not live on the filesystem of `source` (the
 * device of `target`, or of its nearest existing ancestor, differs): the
 * harness refuses a root under another mount
 * (`safe_path_root_ancestor_mountpoint`), and a tmpfs loses it. The one owner
 * (the candidate checkout, the workspace root, a promotion's candidate and
 * promoter home).
 */
export function assertSameFilesystem(source: string, target: string, code: string): void {
  if (statSync(nearestExisting(target)).dev !== statSync(source).dev) {
    throw new InputError(
      `${target} is on a different filesystem from ${source}; the harness refuses a root under another mount ` +
        "(safe_path_root_ancestor_mountpoint) — put it beside the repository or under ~/.local/state",
      code,
    );
  }
}

/**
 * The FILES a checkout needs that git does not carry: each declared link (a
 * symlink to the source checkout's entry, or its link target) and the
 * configuration document's required mode. Synchronous and command-free — the
 * commit guard's materialized index needs exactly this.
 */
export function applyCheckoutFiles(
  checkoutRoot: string,
  sourceRoot: string,
  engineRelative: string,
  isolation: IsolationFiles,
): readonly CheckoutStep[] {
  const steps: CheckoutStep[] = [];
  for (const link of isolation.links) {
    const source = join(sourceRoot, link);
    const target = join(checkoutRoot, link);
    const sourceStats = lstatSync(source, { throwIfNoEntry: false });
    if (sourceStats === undefined) {
      steps.push(step(`link ${link}`, "pass", "absent in the source checkout; nothing to link"));
      continue;
    }
    if (lstatSync(target, { throwIfNoEntry: false }) === undefined) {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(sourceStats.isSymbolicLink() ? readlinkSync(source) : resolve(source), target);
    }
    steps.push(step(`link ${link}`, "pass", `-> ${readlinkSync(target)}`));
  }
  return Object.freeze([...steps, ...settleCheckout(checkoutRoot, engineRelative)]);
}

/**
 * THE ONE POINT AFTER EVERY TREE MOVE: a checkout, a merge, a fast-forward or
 * a read-tree switch rewrites each file it changes with git's own mode (0644,
 * or 0664 under the usual umask), so the configuration document's required
 * mode is re-applied after each, here. Every mover calls this: the checkout
 * setup ({@link applyCheckoutFiles}), a workspace's worktree moves, the land
 * (`landCommit`, its fast-forward and its torn completion) and the overlay's
 * read-tree switch. Measured without it: a land of a config change left the
 * canonical checkout's config 0664, and every harness command there was then
 * refused (`config_mode_insecure`).
 */
export function settleCheckout(checkoutRoot: string, engineRelative: string): readonly CheckoutStep[] {
  const configPath = join(checkoutRoot, engineRelative, ROOT_POLICY.configuration.basename);
  if (!existsSync(configPath)) return Object.freeze([]);
  chmodSync(configPath, Number.parseInt(ROOT_POLICY.configuration.requiredConfigFileMode, 8));
  return Object.freeze([step("config-mode", "pass", `${ROOT_POLICY.configuration.requiredConfigFileMode} ${relative(checkoutRoot, configPath)}`)]);
}

/**
 * Applies the declared setup to `checkoutRoot` (a checkout of the repository
 * whose source checkout is `sourceRoot`): the files, then the `setup` phase.
 * Returns every step taken; the caller refuses on a `fail`.
 */
export async function prepareCheckout(
  checkoutRoot: string,
  sourceRoot: string,
  engineRelative: string,
  isolation: IsolationFiles & IsolationPhases,
  run: RunCheckoutCommand,
): Promise<readonly CheckoutStep[]> {
  const files = applyCheckoutFiles(checkoutRoot, sourceRoot, engineRelative, isolation);
  const commands = await runCheckoutPhase(isolation, "setup", run);
  return Object.freeze([...files, ...commands]);
}
