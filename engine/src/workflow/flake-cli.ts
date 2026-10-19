/**
 * `harness flake` — THE ONE DOOR THAT RECORDS WHAT EXPLAINS A FLAKY SUSPECT
 * (the FLAKE-REPRO decision; the records: src/shared/flake-reproduction.ts).
 *
 *     harness flake reproduce --suite engine|web --fix <commit>
 *         --test <ledger identity> --cause <repository path>[,<path>…] [--test … --cause …]
 *         [--env NAME=VALUE …] [--setup <shell command>] [--during <shell command>]
 *         [--preload <repository path>] [--seed <integer>] [--only-named] [--statistical [--runs <n>]]
 *
 *     harness flake move --suite engine --commit <commit> --from <hermetic identity> --to <live identity>
 *
 * REPRODUCE. Each `--cause` names the cause paths of the `--test` before it
 * (the test's own file may be one): one call reproduces every test one fix
 * fixed. The fix must change a declared cause SEMANTICALLY (the one semantic
 * reader: a comment or layout edit is refused by name) before anything
 * runs. It checks out the fix's PARENT in a private worktree (beside the
 * repository, set up by the one checkout setup, `prepareCheckout`), runs the
 * named tests' files there, then moves the same worktree to the FIX (and runs
 * the whole setup again there) and runs them again — every run under ONE set
 * of conditions (the environment entries, the setup command run first, the
 * command run alongside, the preloaded module, the order seed), all inside
 * the host's one instrument lock. Deterministic by default: one run on each
 * side; a test that FAILED on the parent and PASSED on the fix is recorded
 * with the digest it failed with. `--statistical` (a cause that needs load or
 * a race; it requires a condition: `--during`, the hog or the churner, or
 * `--preload`, the shim) runs each side the
 * configured N times (`testExecution.flakeReproduction.statisticalRuns`),
 * or `--runs` times when that is more (a rarer race takes more runs to show,
 * and every fix run must still pass; never fewer than N): a
 * test that failed at least once on the parent and passed all N times on the
 * fix is recorded, with the digests, how often each was seen and the host's
 * load after every run. Any other outcome is said and records nothing.
 *
 * MOVE. A test that left the hermetic suite for the live suite in a commit
 * is recorded by its two identities, after the door has read the commit's
 * and its parent's test inventories: the hermetic identity was there on the
 * parent and is gone in the commit, and the destination's file is the live
 * suite's (the inventory's qualified-external sources). The verdict then
 * checks the destination against the live suite's manifest. Engine only:
 * the web suite has no live suite.
 *
 * Outcomes are read by a reporter of THIS checkout loaded into the run
 * (engine: scripts/tooling/flake-reproduction-reporter.ts, a node:test
 * reporter; web: scripts/testing/flake-reproduction-reporter.ts, a vitest
 * reporter), so the identity and the digest are spelled by the same owners
 * the ledgers use, whatever the reproduced tree's own runner looked like.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { testProcessSupervisorBinary } from "../../guardian/build.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { createOwnedTemporaryDirectory, ensurePrivateStateDirectory, PRIVATE_STATE_DIRECTORY_MODE, removeOwnedTemporaryDirectory } from "../filesystem/private-state.ts";
import { flakeCauseContentKeys, judgeCauseChange, parseFlakeCause } from "../git/flake-cause-fixes.ts";
import { gitOutput, type GitRepository } from "../git/tree-reader.ts";
import { configuredGitRepository, configuredWorktreeGitPort } from "../git/worktree-port.ts";
import { worktreeOperationTimeouts } from "./workflow-config.ts";
import { resolveRepositoryRegistry, workspaceRootOf } from "./repository-registry.ts";
import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import { INPUT_ERROR_CODE, InputError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../kernel/verification-paths.ts";
import { deepFreeze, randomBytes, sha256 } from "../kernel/integrity.ts";
import { admitEvidenceStore, evidenceStoreLocation, keepEvidenceBytes } from "./evidence-store.ts";
import { holdInstrumentLock, wholeInstrumentTestFileCount } from "../process/instrument-lock.ts";
import { superviseCommand } from "../process/supervised-run.ts";
import { persistableText } from "../privacy/evidence-handler.ts";
import { isSensitiveKeyName } from "../privacy/secret-signals.ts";
import { directoryGitEnvironment } from "../git/repository-ownership.ts";
import { temporaryRootKeepOutRefusal } from "../filesystem/temporary-root.ts";
import {
  contentKeyDigest,
  FLAKE_ATTEMPT_SCHEMA_VERSION,
  claimLooks,
  FLAKE_REPRODUCTION_SCHEMA_VERSION,
  flakeAttemptDirectory,
  flakeAttemptFileName,
  flakeReproductionDirectory,
  flakeReproductionFileName,
  IDENTITY_MOVE_SCHEMA_VERSION,
  identityMoveFileName,
  isDoorOwnedVariable,
  readFlakeAttempts,
  reproductionStrength,
  runsNeeded,
  serializeFlakeAttempt,
  serializeFlakeReproduction,
  serializeIdentityMove,
  type FlakeAttempt,
  type FlakeReproduction,
  type IdentityMove,
  type ReproductionConditions,
  unconfinedRecursiveRemoval,
} from "../shared/flake-reproduction.ts";
import { contentKeyComplete, failureIdentityFile } from "../shared/run-history.ts";
import { configuredCheckoutCommandRunner, engineRelativePath, prepareCheckout, runCheckoutCommand, type CheckoutStep } from "./checkout-setup.ts";
import { wrapResult, type CommandAnswer } from "./command-result.ts";
import { readTestExecutionConfig } from "./test-result-collector.ts";

/** One test's outcome in one run, as the reproduction reporter spells it. */
export type ReproducedOutcome = Readonly<{ outcome: "failed"; digest: string; location: string | null }> | Readonly<{ outcome: "passed" }> | Readonly<{ outcome: "skipped" }>;

/** What a reproduction reporter writes: every test identity it saw, and how it ended. */
export type ReproductionReport = Readonly<Record<string, ReproducedOutcome>>;

export type FlakeReproductionRequest = Readonly<{
  suite: "engine" | "web";
  tests: readonly Readonly<{ identity: string; causes: readonly string[] }>[];
  fix: string;
  /** The one set of conditions every run runs under; the preload's digest is read when the door runs. */
  environment: Readonly<Record<string, string>>;
  setup: string | null;
  /** A command run ALONGSIDE the tests (the hog or the churner that recreates the condition), stopped when they end. */
  during: string | null;
  /** A module of this repository preloaded into every test file's process (engine only). */
  preload: string | null;
  seed: string | null;
  /** Run only the named tests of their files (a condition, recorded). */
  onlyNamed: boolean;
  /** N runs on each side (the configured N, or `runs` when given), not one. */
  statistical: boolean;
  /** `--runs`: more runs per side than the configured N (statistical only; never fewer). */
  runs: number | null;
}>;

export type IdentityMoveRequest = Readonly<{ suite: "engine"; commit: string; from: string; to: string }>;

/** One test's answer: its record, or why it has none. */
export type ReproductionAnswer = Readonly<{ identity: string; recorded: string } | { identity: string; refused: string }>;

/** The checkout this module belongs to (whose reporters and record folder are used). */
const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const USAGE = "harness flake takes: reproduce --suite engine|web --fix <commit> --test <identity> --cause <path>[,<path>…] [--test … --cause …] " +
  "[--env NAME=VALUE …] [--setup <command>] [--during <command>] [--preload <repository path>] [--seed <integer>] [--only-named] [--statistical [--runs <n>]]; " +
  "or move --suite engine --commit <commit> --from <hermetic identity> --to <live identity>";

/** The flag pairs of a `harness flake` verb (`--name value`; `--statistical` stands alone). */
function flagPairs(argv: readonly string[], standalone: ReadonlySet<string>): readonly Readonly<{ flag: string; value: string }>[] {
  const pairs: { flag: string; value: string }[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (standalone.has(flag)) {
      pairs.push({ flag, value: "" });
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new InputError(`${flag} needs a value`, INPUT_ERROR_CODE);
    pairs.push({ flag, value });
    index += 1;
  }
  return pairs;
}

/** Parse `reproduce` arguments; a malformed request is refused before anything runs. */
export function parseFlakeReproduceArgs(argv: readonly string[]): FlakeReproductionRequest {
  if (argv[0] !== "reproduce") throw new InputError(USAGE, INPUT_ERROR_CODE);
  const tests: { identity: string; causes: readonly string[] | undefined }[] = [];
  const environment: Record<string, string> = {};
  let suite: string | undefined, fix: string | undefined, setup: string | null = null, during: string | null = null;
  let preload: string | null = null, seed: string | null = null, statistical = false, onlyNamed = false, runs: number | null = null;
  for (const { flag, value } of flagPairs(argv, new Set(["--statistical", "--only-named"]))) {
    if (flag === "--suite") suite = value;
    else if (flag === "--test") tests.push({ identity: value, causes: undefined });
    else if (flag === "--cause") {
      const last = tests.at(-1);
      if (last === undefined || last.causes !== undefined) throw new InputError("each --cause follows its own --test", INPUT_ERROR_CODE);
      last.causes = value.split(",").map((path) => path.trim());
    }
    else if (flag === "--fix") fix = value;
    else if (flag === "--setup") setup = value;
    else if (flag === "--during") during = value;
    else if (flag === "--preload") preload = value;
    else if (flag === "--seed") {
      if (!/^[0-9]{1,10}$/u.test(value)) throw new InputError(`--seed takes a non-negative integer, not ${JSON.stringify(value)}`, INPUT_ERROR_CODE);
      seed = value;
    }
    else if (flag === "--statistical") statistical = true;
    else if (flag === "--runs") {
      if (!/^[1-9][0-9]{0,3}$/u.test(value)) throw new InputError(`--runs takes a positive integer, not ${JSON.stringify(value)}`, INPUT_ERROR_CODE);
      runs = Number(value);
    }
    else if (flag === "--only-named") onlyNamed = true;
    else if (flag === "--env") {
      const equals = value.indexOf("=");
      if (equals <= 0) throw new InputError(`--env takes NAME=VALUE, not ${JSON.stringify(value)}`, INPUT_ERROR_CODE);
      const name = value.slice(0, equals);
      if (isDoorOwnedVariable(name)) {
        throw new InputError(`--env ${name}: the door owns it — every run gets a fresh world (HOME and TMPDIR under the run's temp root), its output folder and a git environment of its own (no GIT_* variable passes)`, "flake_reproduction_variable_owned");
      }
      environment[name] = value.slice(equals + 1);
    } else throw new InputError(`unknown flag ${flag}`, INPUT_ERROR_CODE);
  }
  for (const [what, command] of [["--setup", setup], ["--during", during]] as const) {
    const removal = command === null ? null : unconfinedRecursiveRemoval(command);
    if (removal !== null) throw new InputError(`${what}: \`${removal}\` recursively removes a place the command did not create — every run already starts in a fresh world, so a shim never removes HOME, ~ or a variable it did not make with mktemp -d`, "flake_reproduction_unconfined_removal");
  }
  if (suite !== "engine" && suite !== "web") throw new InputError("--suite must be engine or web", INPUT_ERROR_CODE);
  if (tests.length === 0 || fix === undefined || tests.some((one) => one.causes === undefined)) throw new InputError("--fix and at least one --test, each followed by its --cause, are required", INPUT_ERROR_CODE);
  if (statistical && during === null && preload === null) throw new InputError("--statistical reproduces a condition: it takes --during (the hog or the churner) or --preload (the shim) that recreates it", "flake_reproduction_statistical_unconditioned");
  if (runs !== null && !statistical) throw new InputError("--runs sets a statistical reproduction's N: it takes --statistical", INPUT_ERROR_CODE);
  if (onlyNamed && suite !== "engine") throw new InputError("--only-named is the engine runner's (`--test-name-pattern` on the ledger's test names); the web runner's names are spelled otherwise", INPUT_ERROR_CODE);
  return deepFreeze({ suite, tests: tests.map((one) => ({ identity: one.identity, causes: one.causes! })), fix, environment, setup, during, preload, seed, onlyNamed, statistical, runs });
}

/** Parse `move` arguments. */
export function parseFlakeMoveArgs(argv: readonly string[]): IdentityMoveRequest {
  if (argv[0] !== "move") throw new InputError(USAGE, INPUT_ERROR_CODE);
  const values: Record<string, string> = {};
  for (const { flag, value } of flagPairs(argv, new Set())) {
    if (!["--suite", "--commit", "--from", "--to"].includes(flag)) throw new InputError(`unknown flag ${flag}`, INPUT_ERROR_CODE);
    values[flag] = value;
  }
  if (values["--suite"] !== "engine") throw new InputError("--suite must be engine: only the engine has a live suite", INPUT_ERROR_CODE);
  const [commit, from, to] = [values["--commit"], values["--from"], values["--to"]];
  if (commit === undefined || from === undefined || to === undefined) throw new InputError("--commit, --from and --to are required", INPUT_ERROR_CODE);
  if (failureIdentityFile(from) === null || failureIdentityFile(to) === null) throw new InputError("--from and --to are ledger identities (`<file>::<test name>`)", INPUT_ERROR_CODE);
  return deepFreeze({ suite: "engine", commit, from, to });
}

/** One run's answer: what each test did, and everything the run printed (kept as evidence). */
export type ReproductionRun = Readonly<{ report: ReproductionReport; output: string }>;

/** Runs the request's test files once at a revision of the reproduction worktree and answers what each test did, with the run's output. */
export type ReproductionRunner = (revision: "parent" | "fix", files: readonly string[]) => Promise<ReproductionRun>;

/**
 * How the judgement runs: N runs per side, the conditions' preload digest,
 * the clock, the host's load, α, and the two writes every attempt makes —
 * each run's output kept as evidence (`keepOutput`: its digest), and the
 * attempt kept (`appendAttempt`, one file each), recorded or refused.
 */
export type ReproductionSettings = Readonly<{
  runs: number;
  preloadSha256: string | null;
  now: () => Date;
  load: () => number;
  significance: number;
  /** The preloaded modules whose one run per side is strong (config). */
  deterministicShims: readonly string[];
  /** How many attempts this (test, fix) claim already had (each one a look its bar pays for). */
  priorLooks: (identity: string, fix: string) => number;
  attemptId: () => string;
  keepOutput: (output: string) => string;
  appendAttempt: (attempt: FlakeAttempt) => void;
}>;

/** One test's tally over a side's runs: each digest's count and where those failures happened ("" for none named). */
type Tally = { failed: Record<string, number>; locations: Record<string, string[]>; passed: number };

/** The runs per side a request takes: N for a statistical one; for a deterministic one, one with a REGISTERED shim (config `deterministicShims`), else what an all-failing parent needs at α. */
export function deterministicRuns(preload: string | null, significance: number, deterministicShims: readonly string[]): number {
  return preload !== null && deterministicShims.includes(preload) ? 1 : runsNeeded(1, significance);
}

/**
 * THE JUDGEMENT, given the runs (`run`): the fix must change a declared cause
 * semantically, or nothing runs; then each side runs `settings.runs` times,
 * and each test whose counts are STRONG (the parent failed — every run, for a
 * deterministic reproduction — the fix passed every run, and a fix that
 * changed nothing would show such counts with probability at most α) is
 * recorded; any other is refused with why, and the runs a weaker rate needs.
 * EVERY ATTEMPT that ran anything is appended to the attempt log, refused
 * tests and all, with each run's output kept as evidence; a run that ended
 * the attempt early is logged too, as every test refused. Pure but for the
 * runner and the writes (`write`, and the settings').
 */
export async function reproduceFlake(
  request: FlakeReproductionRequest,
  repository: GitRepository,
  testPathOf: (file: string) => string,
  run: ReproductionRunner,
  write: (record: FlakeReproduction, bytes: string) => string,
  settings: ReproductionSettings,
): Promise<readonly ReproductionAnswer[]> {
  const fix = resolveCommit(repository, request.fix);
  const parent = resolveCommit(repository, `${fix}^`);
  const declarations = request.tests.map(({ identity, causes }) =>
    parseFlakeCause(`${identity} => ${causes.join(", ")} @ ${fix}`, fix, testPathOf));
  for (const declared of declarations) {
    const change = await judgeCauseChange(repository, declared);
    if (!change.semantic) throw new InputError(`${declared.identity}: ${change.why} between ${parent} and ${fix} — a fix of a cause changes what it means`, "flake_reproduction_cause_cosmetic");
  }
  const keys = flakeCauseContentKeys(repository);
  const files = [...new Set(request.tests.map(({ identity }) => failureIdentityFile(identity)!))];
  const tallies = { parent: new Map<string, Tally>(), fix: new Map<string, Tally>() };
  const loads: { parent: number[]; fix: number[] } = { parent: [], fix: [] };
  const outputs: { revision: "parent" | "fix"; run: number; sha256: string }[] = [];
  const conditions = recordableConditions(request, settings.preloadSha256);
  const mode = request.statistical ? "statistical" as const : "deterministic" as const;
  const attempt = settings.attemptId();
  const log = (outcomes: FlakeAttempt["outcomes"]): void => settings.appendAttempt({
    schemaVersion: FLAKE_ATTEMPT_SCHEMA_VERSION, attempt, suite: request.suite, fix, parent, conditions, mode, runs: settings.runs,
    outputs: [...outputs], outcomes, recordedAt: settings.now().toISOString(),
  });
  const failedOn = (tally: Tally | undefined): number => Object.values(tally?.failed ?? {}).reduce((sum, count) => sum + count, 0);
  try {
    for (const revision of ["parent", "fix"] as const) {
      // A parent that showed no declared test failing reproduces nothing: the fix's runs could prove nothing, so none are made.
      if (revision === "fix" && declarations.every(({ identity }) => failedOn(tallies.parent.get(identity)) === 0)) break;
      for (let index = 0; index < settings.runs; index += 1) {
        const { report, output } = await run(revision, files);
        outputs.push({ revision, run: index + 1, sha256: settings.keepOutput(output) });
        loads[revision].push(settings.load());
        for (const { identity } of declarations) {
          const tally = tallies[revision].get(identity) ?? { failed: {}, locations: {}, passed: 0 };
          const outcome = report[identity];
          if (outcome?.outcome === "failed") {
            tally.failed[outcome.digest] = (tally.failed[outcome.digest] ?? 0) + 1;
            const where = outcome.location ?? "";
            tally.locations[outcome.digest] = [...new Set([...(tally.locations[outcome.digest] ?? []), where])].sort();
          }
          else if (outcome?.outcome === "passed") tally.passed += 1;
          tallies[revision].set(identity, tally);
        }
      }
    }
  } catch (error) {
    log(declarations.map(({ identity }) => ({ identity, refused: `the attempt ended before its runs were done: ${(error as Error).message}` })));
    throw error;
  }
  const describe = (tally: Tally | undefined): string => tally === undefined ? "did not run"
    : `failed ${String(failedOn(tally))} and passed ${String(tally.passed)} of ${String(settings.runs)} run(s)${Object.keys(tally.failed).length === 0 ? "" : ` (${Object.entries(tally.failed).map(([digest, count]) => `${digest} ×${String(count)}`).join(", ")})`}`;
  const answers = declarations.map((declared): ReproductionAnswer & Readonly<{ sha256?: string }> => {
    const refused = (why: string): ReproductionAnswer => ({ identity: declared.identity, refused: why });
    const onParent = tallies.parent.get(declared.identity);
    const onFix = tallies.fix.get(declared.identity);
    if (onParent === undefined || failedOn(onParent) === 0) return refused(`on the parent ${parent} it ${describe(onParent)}: nothing was reproduced`);
    if (onParent.passed + failedOn(onParent) !== settings.runs) return refused(`on the parent it did not run every time (${describe(onParent)})`);
    if (mode === "deterministic" && failedOn(onParent) !== settings.runs) return refused(`on the parent it ${describe(onParent)}: a deterministic reproduction fails every run — reproduce the condition with --statistical`);
    if (onFix === undefined || onFix.passed !== settings.runs) return refused(`on the parent it ${describe(onParent)}, but on the fix ${fix} it ${describe(onFix)}: the fix is not shown`);
    const parentKey = keys(parent, declared.paths);
    const fixKey = keys(fix, declared.paths);
    if (!contentKeyComplete(parentKey) || !contentKeyComplete(fixKey)) return refused("a declared path is absent at the parent or the fix");
    const record: FlakeReproduction = {
      schemaVersion: FLAKE_REPRODUCTION_SCHEMA_VERSION,
      identity: declared.identity,
      suite: request.suite,
      paths: [...declared.paths],
      causes: [...declared.causes],
      attempt,
      fix: { commit: fix, contentDigest: contentKeyDigest(fixKey) },
      parent: { commit: parent, contentDigest: contentKeyDigest(parentKey) },
      conditions,
      mode,
      runs: settings.runs,
      parentRuns: { failed: { ...onParent.failed }, locations: { ...onParent.locations }, passed: onParent.passed, loads: [...loads.parent] },
      fixRuns: { passed: onFix.passed, loads: [...loads.fix] },
      recordedAt: settings.now().toISOString(),
    };
    // THE COUNTS MUST BE STRONG: a no-op fix shows them with probability at most α.
    const strength = reproductionStrength(record, settings.significance, settings.deterministicShims, settings.priorLooks(declared.identity, fix) + 1);
    if ("why" in strength) return refused(`on the parent it ${describe(onParent)} and on the fix it passed every run, but ${strength.why}`);
    const bytes = serializeFlakeReproduction(record);
    return { identity: declared.identity, recorded: write(record, bytes), sha256: sha256(bytes) };
  });
  log(answers.map((answer) => "recorded" in answer ? { identity: answer.identity, recorded: answer.sha256! } : { identity: answer.identity, refused: answer.refused }));
  return answers.map((answer) => "recorded" in answer ? { identity: answer.identity, recorded: answer.recorded } : answer);
}



/**
 * THE CONDITIONS AS THEY ARE RECORDED: every value and command passes the
 * one persistence redaction — a credential-named entry is withheld whole, a
 * credential-shaped span is redacted — so a key typed into a shim reaches the
 * run, never the tracked record.
 */
export function recordableConditions(request: FlakeReproductionRequest, preloadSha256: string | null): ReproductionConditions {
  return {
    environment: Object.fromEntries(Object.entries(request.environment).map(([name, value]) => [name, isSensitiveKeyName(name) ? "[REDACTED:credential]" : persistableText(value)])),
    setup: request.setup === null ? null : persistableText(request.setup),
    during: request.during === null ? null : persistableText(request.during),
    preload: request.preload === null ? null : { path: request.preload, sha256: preloadSha256! },
    seed: request.seed,
    onlyNamed: request.onlyNamed,
  };
}

/** One run's fresh world: a private folder under the run's temp root (D-19), its HOME and its TMPDIR, side by side. */
export type ShimWorld = Readonly<{ root: string; home: string; tmp: string }>;

/** Creates one run's fresh world under `temporaryRoot` (refused inside the safety floor). */
export function createShimWorld(temporaryRoot: string, harnessRoot: string): ShimWorld {
  const refusal = temporaryRootKeepOutRefusal(harnessRoot, temporaryRoot);
  if (refusal !== undefined) throw new InputError(refusal, "flake_reproduction_temp_root_refused");
  const root = createOwnedTemporaryDirectory(temporaryRoot, "flake-world-");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  mkdirSync(home, { mode: PRIVATE_STATE_DIRECTORY_MODE });
  mkdirSync(tmp, { mode: PRIVATE_STATE_DIRECTORY_MODE });
  return { root, home, tmp };
}

/**
 * THE ENVIRONMENT OF A RUN: the caller's minus every GIT_* variable (the one
 * projection the checkout steps use: an inherited GIT_DIR would reach the
 * caller's index), the request's entries, and the world's HOME and TMPDIR.
 * Then the door REFUSES to run anything unless HOME and TMPDIR resolve
 * strictly inside the world — checked on the environment actually handed to
 * the shim, so a failed override never reaches a command.
 */
export function shimEnvironment(base: NodeJS.ProcessEnv, request: FlakeReproductionRequest, world: ShimWorld, output: string): Record<string, string> {
  // The caller's door-owned variables never reach a run (its XDG base folders would lead out of the world).
  const inherited = Object.fromEntries(Object.entries(directoryGitEnvironment(base)).filter(([name]) => !isDoorOwnedVariable(name)));
  const environment = { ...inherited, ...request.environment, HOME: world.home, TMPDIR: world.tmp, FLAKE_REPRODUCTION_OUTPUT: output } as Record<string, string>;
  assertShimWorldConfined(environment, world);
  return environment;
}

/** Refuses an environment whose HOME or TMPDIR does not resolve strictly inside the world (`flake_shim_home_unconfined`). */
export function assertShimWorldConfined(environment: Readonly<Record<string, string | undefined>>, world: ShimWorld): void {
  const root = realpathSync(world.root);
  for (const name of ["HOME", "TMPDIR"] as const) {
    const value = environment[name];
    const resolved = value === undefined || value === "" || !existsSync(value) ? undefined : realpathSync(value);
    if (resolved === undefined || !resolved.startsWith(`${root}/`)) {
      throw new InputError(`${name} is ${JSON.stringify(value ?? null)}, not inside this run's fresh world ${root}: nothing runs`, "flake_shim_home_unconfined");
    }
  }
}

function resolveCommit(repository: GitRepository, name: string): string {
  const found = gitOutput(repository, ["rev-parse", "-q", "--verify", `${name}^{commit}`], { allowed: [0, 1, 128] });
  if (found.status !== 0) throw new InputError(`${name} is no commit of this repository`, "flake_reproduction_commit_unknown");
  return found.stdout.toString("utf8").trim();
}

/** The engine test inventory at a commit: its hermetic identities and its live suite's files. */
function inventoryAt(repository: GitRepository, commit: string, engineRelative: string): Readonly<{ hermetic: ReadonlySet<string>; liveFiles: ReadonlySet<string> }> {
  const found = gitOutput(repository, ["cat-file", "blob", `${commit}:${engineRelative}/${VERIFICATION_PATHS.testInventory}`], { allowed: [0, 128] });
  if (found.status !== 0) throw new InputError(`${commit} holds no engine test inventory`, "flake_move_inventory_missing");
  const inventory = JSON.parse(found.stdout.toString("utf8")) as { tests?: { sourceId: string; name: string }[]; scope?: { qualifiedExternalSourceIds?: string[] } };
  return {
    hermetic: new Set((inventory.tests ?? []).map((entry) => `${entry.sourceId}::${entry.name}`)),
    liveFiles: new Set(inventory.scope?.qualifiedExternalSourceIds ?? []),
  };
}

/**
 * THE MOVE'S JUDGEMENT: the hermetic identity is in the commit's parent's
 * inventory and not in the commit's, and the destination's file is a live
 * suite file of the commit's inventory. Refused otherwise, by name.
 */
export function recordIdentityMove(request: IdentityMoveRequest, repository: GitRepository, engineRelative: string, write: (record: IdentityMove) => string, now: () => Date): string {
  const commit = resolveCommit(repository, request.commit);
  const parent = resolveCommit(repository, `${commit}^`);
  const before = inventoryAt(repository, parent, engineRelative);
  const after = inventoryAt(repository, commit, engineRelative);
  if (!before.hermetic.has(request.from)) throw new InputError(`${request.from} is not a test of the hermetic suite at ${parent}: nothing moved`, "flake_move_refused");
  if (after.hermetic.has(request.from)) throw new InputError(`${request.from} is still a test of the hermetic suite at ${commit}: it did not leave`, "flake_move_refused");
  const destination = failureIdentityFile(request.to)!;
  if (!after.liveFiles.has(destination)) throw new InputError(`${destination} is not a live suite file at ${commit} (the inventory's qualified-external sources)`, "flake_move_refused");
  return write({ schemaVersion: IDENTITY_MOVE_SCHEMA_VERSION, suite: request.suite, from: request.from, to: request.to, commit, recordedAt: now().toISOString() });
}

/**
 * KEEP ONE ATTEMPT under `engineRoot`: a file of its own in the attempts
 * folder, named by the sha256 of its bytes (the same bytes, the same file), so two doors
 * or two branches never write the same file and a merge is the union. Each
 * file is checked on its own when read (`readFlakeAttempts`).
 */
export function appendFlakeAttempt(engineRoot: string, attempt: FlakeAttempt): void {
  // One file per attempt, named by the sha256 of its bytes: nothing else is read or rewritten, so two writers (two
  // branches) never conflict and a merge is the union.
  const bytes = serializeFlakeAttempt(attempt);
  const path = join(flakeAttemptDirectory(engineRoot), flakeAttemptFileName(bytes));
  mkdirSync(flakeAttemptDirectory(engineRoot), { recursive: true });
  const written = atomicWriteFile(path, bytes, { createMode: ROOT_POLICY.filesystem.rawFileModes.traceability, exactMode: ROOT_POLICY.filesystem.rawFileModes.traceability });
  if (!written.success) throw new InputError(`the attempt ${path} could not be written: ${written.reason ?? "unknown"}`, "flake_attempt_write_failed");
}

/** A record's write: the one serializer, atomically, into this checkout's record folder (a TRACKED file: the traceability mode). */
function writeRecordFile(name: string, bytes: string): string {
  const path = join(flakeReproductionDirectory(ENGINE_ROOT), name);
  const written = atomicWriteFile(path, bytes, { createMode: ROOT_POLICY.filesystem.rawFileModes.traceability, exactMode: ROOT_POLICY.filesystem.rawFileModes.traceability });
  if (!written.success) throw new InputError(`the record ${path} could not be written: ${written.reason ?? "unknown"}`, "flake_reproduction_write_failed");
  return path;
}

export async function runFlakeCli(argv: readonly string[]): Promise<CommandAnswer<readonly ReproductionAnswer[]>> {
  const snapshot = loadPinnedConfigSnapshot();
  const repository = configuredGitRepository(snapshot.document, ENGINE_ROOT);
  const top = gitOutput(repository, ["rev-parse", "--show-toplevel"]).stdout.toString("utf8").trim();
  const engineRelative = engineRelativePath(top, ENGINE_ROOT);
  const topRepository = configuredGitRepository(snapshot.document, top);
  if (argv[0] === "move") {
    const move = parseFlakeMoveArgs(argv);
    const recorded = recordIdentityMove(move, topRepository, engineRelative, (record) => writeRecordFile(identityMoveFileName(record.from), serializeIdentityMove(record)), () => new Date());
    return { result: wrapResult("flake", [{ identity: move.from, recorded }], { status: "pass" }), exitCode: 0 };
  }
  const request = parseFlakeReproduceArgs(argv);
  const isolation = snapshot.document.workspaceIsolation;
  if (isolation === undefined) throw new InputError("workspaceIsolation config section is required: a reproduction checkout is set up by its setup phase", "workspace_isolation_config_missing");
  const testPathOf = (file: string): string => request.suite === "engine" ? `${engineRelative}/${file}` : file;
  const config = readTestExecutionConfig(ENGINE_ROOT);
  const significance = config.flakeReproduction?.significance;
  if (significance === undefined) throw new InputError("testExecution.flakeReproduction.significance is not declared: no record's strength can be judged", "flake_reproduction_config_missing");
  // Required by name, like the significance beside them: no silent default in either direction.
  const declaredLock = config.instrumentLock;
  if (declaredLock === undefined) throw new InputError("testExecution.instrumentLock is not declared: a reproduction is a whole instrument that holds the host's one lock", "instrument_lock_undeclared");
  const deterministicShims = config.flakeReproduction?.deterministicShims;
  if (deterministicShims === undefined) throw new InputError("testExecution.flakeReproduction.deterministicShims is not declared: which preload is strong at one run per side is config", "flake_reproduction_config_missing");
  let store: ReturnType<typeof admitEvidenceStore> | undefined;
  const evidence = (): ReturnType<typeof admitEvidenceStore> => (store ??= admitEvidenceStore(evidenceStoreLocation(), top));
  const preloadFile = request.preload === null ? null : join(top, request.preload);
  const preloadSha256 = preloadFile === null ? null : sha256(readFileSync(preloadFile));
  // A whole instrument (it runs suites at two revisions), heavy by kind.
  const lock = await holdInstrumentLock({
    config: declaredLock, harnessRoot: ENGINE_ROOT, runner: `flake reproduce (${String(request.tests.length)} test(s))`,
    testFileCount: wholeInstrumentTestFileCount(declaredLock, "flake-reproduction"), onWait: (line) => process.stderr.write(`${line}\n`),
  });
  const supervisor = testProcessSupervisorBinary();
  const commandRunner = configuredCheckoutCommandRunner(snapshot.document, isolation, supervisor,
    (step, commandArguments) => process.stderr.write(`[flake reproduce] setup ${step}: ${commandArguments.join(" ")}\n`));
  // BESIDE THE REPOSITORY, where its workspaces live (`workspaceIsolation.workspaceRoot`): a checkout under
  // the user cache folder would sit inside the instrument lock's folder and the harness's kept-out state.
  const workspaceRoot = workspaceRootOf(resolveRepositoryRegistry(configuredWorktreeGitPort(snapshot.document), top, worktreeOperationTimeouts(snapshot.document).inspectMs), isolation.workspaceRoot);
  ensurePrivateStateDirectory(workspaceRoot);
  const checkout = createOwnedTemporaryDirectory(workspaceRoot, "flake-reproduction-");
  const runStep = (name: string, command: Parameters<typeof runCheckoutCommand>[2]): Promise<CheckoutStep> => runCheckoutCommand(checkout, name, command, commandRunner);
  const refuseFailed = (steps: readonly CheckoutStep[], when: string): void => {
    const failed = steps.find((taken) => taken.status === "fail");
    if (failed !== undefined) throw new InputError(`the reproduction checkout's ${when} failed at ${failed.step}: ${failed.message}\n${failed.details.join("\n")}`, "flake_reproduction_setup_failed");
  };
  const at: { revision: string | null; added: boolean } = { revision: null, added: false };
  try {
    const answers = await reproduceFlake(request, topRepository, testPathOf, async (revision, files) => {
      const commit = resolveCommit(topRepository, revision === "parent" ? `${request.fix}^` : request.fix);
      if (!at.added) {
        gitOutput(topRepository, ["worktree", "add", "--detach", checkout, commit]);
        at.added = true;
        refuseFailed(await prepareCheckout(checkout, top, engineRelative, isolation, runStep), "setup");
      } else if (at.revision !== commit) {
        // THE WHOLE SETUP AGAIN at the fix: a step that declares no inputs (the bundle) would
        // otherwise keep the parent's output, and the fix would run on the parent's build.
        gitOutput(configuredGitRepository(snapshot.document, checkout), ["checkout", "-q", "--detach", commit]);
        refuseFailed(await prepareCheckout(checkout, top, engineRelative, isolation, runStep), "setup at the fix");
      }
      at.revision = commit;
      return runTests(checkout, engineRelative, request, preloadFile, files, supervisor, config.engineSuiteWatchdog);
    }, (record, bytes) => writeRecordFile(flakeReproductionFileName(record.identity, record.fix.commit), bytes), {
      runs: request.statistical ? statisticalRunsOf(request, config) : deterministicRuns(request.preload, significance, deterministicShims),
      preloadSha256,
      now: () => new Date(),
      load: () => loadavg()[0]!,
      significance,
      deterministicShims,
      priorLooks: (identity, fixCommit) => claimLooks(readFlakeAttempts(ENGINE_ROOT).looks, identity, fixCommit),
      attemptId: () => randomBytes(16).toString("hex"),
      // Each run's output, redacted (D-09), kept in the evidence store: the attempt names it by digest.
      keepOutput: (output) => keepEvidenceBytes(evidence(), Buffer.from(persistableText(output), "utf8")),
      appendAttempt: (attempt) => appendFlakeAttempt(ENGINE_ROOT, attempt),
    });
    const recorded = answers.filter((answer) => "recorded" in answer).length;
    return { result: wrapResult("flake", answers, { status: recorded === answers.length ? "pass" : "fail" }), exitCode: recorded === answers.length ? 0 : 1 };
  } finally {
    if (at.added) gitOutput(topRepository, ["worktree", "remove", "--force", checkout], { allowed: [0, 128] });
    removeOwnedTemporaryDirectory(checkout);
    gitOutput(topRepository, ["worktree", "prune"], { allowed: [0, 128] });
    lock.release();
  }
}

/** A statistical request's N: the configured one (required, never a default), or `--runs` when that is more — never fewer. */
export function statisticalRunsOf(request: Pick<FlakeReproductionRequest, "runs">, config: Pick<ReturnType<typeof readTestExecutionConfig>, "flakeReproduction">): number {
  const configured = config.flakeReproduction?.statisticalRuns;
  if (configured === undefined) throw new InputError("testExecution.flakeReproduction.statisticalRuns is not declared: a statistical reproduction has no N", "flake_reproduction_config_missing");
  if (request.runs !== null && request.runs < configured) throw new InputError(`--runs ${String(request.runs)} is below the configured ${String(configured)}: a statistical record of fewer runs shows nothing`, "flake_reproduction_too_few_runs");
  return request.runs ?? configured;
}

/** One run of `files` in `checkout` under the request's conditions, read by this checkout's reproduction reporter. */
async function runTests(
  checkout: string,
  engineRelative: string,
  request: FlakeReproductionRequest,
  preloadFile: string | null,
  files: readonly string[],
  supervisor: string,
  watchdog: Readonly<{ hardCeilingMs: number; killGraceMs: number }>,
): Promise<ReproductionRun> {
  const output = join(checkout, ".flake-reproduction-report.json");
  // Each run writes its own report: a run that reaches no reporter must not read the last run's.
  rmSync(output, { force: true });
  const world = createShimWorld(tmpdir(), ENGINE_ROOT);
  try {
    return await runInWorld(checkout, engineRelative, request, preloadFile, files, supervisor, watchdog, output, shimEnvironment(process.env, request, world, output));
  } finally {
    removeOwnedTemporaryDirectory(world.root);
  }
}

/** One run in its world (the environment is already the confined one). */
async function runInWorld(
  checkout: string,
  engineRelative: string,
  request: FlakeReproductionRequest,
  preloadFile: string | null,
  files: readonly string[],
  supervisor: string,
  watchdog: Readonly<{ hardCeilingMs: number; killGraceMs: number }>,
  output: string,
  environment: Record<string, string>,
): Promise<ReproductionRun> {
  // Everything the run prints is echoed AND kept: the attempt keeps it as evidence.
  const printed: string[] = [];
  const keep = (chunk: Buffer | string): void => { printed.push(chunk.toString()); process.stderr.write(chunk); };
  const echo = { onStdout: keep, onStderr: keep };
  const cwd = request.suite === "engine" ? join(checkout, engineRelative) : checkout;
  if (request.setup !== null) {
    await superviseCommand({ supervisor, command: "sh", args: ["-c", request.setup], cwd, env: environment, hardCeilingMs: watchdog.hardCeilingMs, killGraceMs: watchdog.killGraceMs, ...echo });
  }
  const reporter = request.suite === "engine"
    ? pathToFileURL(join(ENGINE_ROOT, "scripts", "tooling", "flake-reproduction-reporter.ts")).href
    : join(ENGINE_ROOT, "..", "scripts", "testing", "flake-reproduction-reporter.ts");
  const order = request.seed === null ? []
    : request.suite === "engine" ? ["--test-randomize", `--test-random-seed=${request.seed}`] : ["--sequence.shuffle", `--sequence.seed=${request.seed}`];
  const preload = preloadFile === null ? [] : [`--import=${pathToFileURL(preloadFile).href}`];
  // ONLY THE NAMED TESTS (a recorded condition): their names, exactly, as the runner's own pattern.
  const names = request.tests.map(({ identity }) => identity.slice(identity.indexOf("::") + 2).replace(/ \(skipped\)$/u, "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const only = !request.onlyNamed ? []
    : [`--test-name-pattern=^(?:${names.join("|")})$`];
  const [command, args] = request.suite === "engine"
    ? [process.execPath, ["--experimental-strip-types", "scripts/tooling/test-guards.ts", ...preload, ...order, ...only, "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${reporter}`, `--test-reporter-destination=${output}`, ...files]] as const
    : ["npx", ["vitest", "run", ...files, ...order, "--reporter=default", `--reporter=${reporter}`]] as const;
  const stopDuring = new AbortController();
  const alongside = request.during === null ? undefined
    : superviseCommand({ supervisor, command: "sh", args: ["-c", request.during], cwd, env: environment, hardCeilingMs: watchdog.hardCeilingMs, killGraceMs: watchdog.killGraceMs, stop: stopDuring.signal, ...echo });
  // THE WEB RUNNER'S PRELOAD, PINNED LIKE THE ENGINE'S: the same module, digested and recorded the
  // same way, reaches vitest and every worker it starts through NODE_OPTIONS — which the DOOR sets: a request's own
  // NODE_OPTIONS is a door-owned variable, refused, so no preload ever runs unpinned.
  const runEnvironment = request.suite === "web" && preloadFile !== null ? { ...environment, NODE_OPTIONS: `--import=${pathToFileURL(preloadFile).href}` } : environment;
  try {
    await superviseCommand({ supervisor, command, args, cwd, env: runEnvironment, hardCeilingMs: watchdog.hardCeilingMs, killGraceMs: watchdog.killGraceMs, ...echo });
  } finally {
    stopDuring.abort();
    await alongside;
  }
  try {
    return { report: JSON.parse(readFileSync(output, "utf8")) as ReproductionReport, output: printed.join("") };
  } catch (error) {
    throw new InputError(`the reproduction run wrote no readable report (${(error as Error).message}): its runner did not reach the reporter`, "flake_reproduction_report_missing");
  }
}
