/**
 * THE TREE LANDING — how a computed tree becomes a commit on a branch, the
 * one owner shared by `harness promote` (a promotion's projected tree) and
 * `harness workspace merge` (a workspace's merge), merge-door-final §4 row 8:
 *
 * - CANDIDATE ({@link createCandidate}): a disposable detached worktree at the
 *   target tip T, made a merge of the source commit S whose tree is exactly the
 *   computed tree P (`merge -s ours --no-commit S`, then `read-tree -u --reset
 *   P`; when S is already in T's history there is no second parent). Nothing
 *   any other checkout holds is touched: the candidate has its own index.
 * - SETTLE ({@link settleCandidate}): the files git does not carry (links, the
 *   config mode), the declared `setup` commands, the declared `converge`
 *   commands driven to a FIXED POINT over the staged tree (the one loop,
 *   `convergeUntilStable` in `checkout-setup.ts`: repeated until a pass leaves
 *   the tree as it found it; a tree seen before is an oscillation), the DECLARED-WRITES
 *   check (everything setup and converge changed is a generated output — an
 *   untracked file that is not ignored counts), the `verify` commands, and the
 *   check that verifying wrote nothing. Every command runs through the ONE
 *   runner (`checkout-setup.ts`: its errored class retried, a failure never).
 * - COMMIT ({@link commitCandidate}): ONE `git commit` in the candidate — the
 *   repository's hooks run (the commit guard certifies the exact tree; never
 *   `--no-verify`) — with the identity and date the caller fixes, so the same
 *   inputs give the same commit; then its postconditions: its tree is the
 *   settled tree, its parents are the declared ones, and no object it reaches
 *   is missing.
 * - PUBLISH ({@link pushToRemote}): ONE atomic, never-forced push of the
 *   commit and its companions (`git push --atomic --porcelain`): all or
 *   nothing on the remote, classified — a non-fast-forward rejection (the
 *   remote moved), the remote's own refusal (a hook, a permission), or the
 *   machine's (unreachable) — never an exception.
 * - LAND ({@link landCommit}): the branch moves to the commit only forward —
 *   `merge --ff-only` in the checkout that has it checked out (git refuses,
 *   changing nothing, when that would touch the checkout's own work), a
 *   compare-and-swap `update-ref` when none does. A checkout a crash left
 *   TORN in the middle of a fast-forward (every path git calls dirty already
 *   holds the commit's bytes, mode and link target, and its index entry is
 *   the old tip's or the commit's) is completed with git alone
 *   ({@link landCommit}: stage those entries, `read-tree -m -u T C`, then the
 *   compare-and-swap); any other overlap is the checkout's own work — a
 *   staged version that is neither is never overwritten — and is never
 *   touched: the refusal names the paths (a promotion PARKS).
 * - SWEEP ({@link sweepCandidates}): the candidates a crashed or failed run
 *   left, removed (the newest kept for inspection when asked); never a path
 *   the consumer's own candidate naming does not match.
 *
 * Every phase runs in {@link runLandingPhase}: its start and end (duration,
 * outcome, the typed code) logged once, here, and a git step's failure typed
 * there ({@link landingGitFailure}: the machine's — a ceiling, a signal, a
 * full disk — is `git_errored`, git's own refusal `git_failed`), so no git
 * error leaves a phase untyped. A refusal is a {@link LandingError} with its
 * {@link LandingFailure} kind; the consumer maps the kind to its own
 * diagnostic code.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { deepFreeze, gitBlobId } from "../kernel/integrity.ts";
import { WorktreeGitError, WorktreeGitTimeout, type CommitIdentity, type CommitOutcome, type IndexEntryUpdate, type PushOutcome, type WorktreeGitPort } from "../git/worktree-port.ts";
import { debugLog } from "../shared/debug/debug-system.ts";
import { removeGateLogs, settleCheckout } from "./checkout-setup.ts";
import {
  NotConvergedError, applyCheckoutFiles, commandFailureClass, convergeBound, convergeUntilStable, convergenceReport, runDeclaredCommands,
  type CheckoutCommand, type CheckoutStep, type ConvergenceReport, type RunCheckoutCommand,
} from "./checkout-setup.ts";

/** Why a landing stopped (the consumer's code is derived from it). */
export type LandingFailure =
  | "setup_failed" | "setup_errored"
  | "gate_failed" | "gate_errored"
  | "not_converged" | "undeclared_write"
  | "commit_refused" | "objects_missing" | "candidate_mismatch"
  | "git_errored" | "git_failed";

/**
 * THE GIT OPERATIONS a promotion's landing runs besides its commands, by
 * phase, at their worst (a landing that completes a torn checkout, a sweep
 * that removes a candidate) — what a ceiling over a whole run counts, each
 * operation bounded by its own git ceiling. Declared once;
 * `engine/test/workflow/promotion/publish.test.ts` counts every port call of
 * a real promotion (reconcile, build, publish, land, finish) and holds the
 * total within {@link landingGitOperationCount}, so a new git step cannot go
 * uncounted. `perConvergePass` repeats once per converge pass; `land` counts
 * twice (the reconcile's catch-up of a target behind its remote, then the
 * promotion's own landing); `sweep` three times (the two sweeps before a
 * build and the finish's).
 */
const LANDING_GIT_OPERATIONS = deepFreeze({
  reconcile: ["ls-remote (the hold)", "fetch (the hold)", "ls-remote (the tips)", "fetch (the tips)", "merge-base (behind)", "merge-base (ahead)", "merge-base (the source)"],
  sweep: ["worktree list", "worktree remove", "worktree prune"],
  candidate: ["worktree add --detach", "merge-base --is-ancestor", "merge -s ours", "read-tree -u --reset", "add -A + write-tree"],
  settle: ["add -A + write-tree (before converge)", "ls-files (before converge)", "add -A + write-tree (after converge)", "diff (regenerated)", "add -A + write-tree (after verify)"],
  perConvergePass: ["add -A + write-tree", "ls-files"],
  commit: ["commit", "rev-parse tree", "rev-parse parent 1", "rev-parse parent 2", "rev-list --missing", "update-ref (the receipt)", "update-ref (the pin)"],
  publish: ["push --atomic", "ls-remote (after the push)", "fetch (a tip past the commit)", "merge-base (it carries the commit)"],
  land: ["worktree list", "merge --ff-only", "status", "diff (head-to-index)", "diff (index-to-worktree)", "diff (the landing's delta)", "rev-parse HEAD", "ls-tree (the commit)", "hash-object", "ls-tree (the old tip)", "ls-files (the index)", "update-index", "read-tree -m -u", "update-ref"],
  finish: ["worktree list", "diff (the landed delta)", "update-ref -d (the pin)", "merge-base (a stale pin shipped)", "update-ref -d (a stale receipt)"],
} as const);

/** How many git operations a run of `passes` converge passes may take ({@link LANDING_GIT_OPERATIONS}). */
export function landingGitOperationCount(passes: number): number {
  const { reconcile, sweep, candidate, settle, perConvergePass, commit, publish, land, finish } = LANDING_GIT_OPERATIONS;
  return reconcile.length + 3 * sweep.length + candidate.length + settle.length + passes * perConvergePass.length + commit.length + publish.length + 2 * land.length + finish.length;
}

/** One typed refusal of a landing phase: what stopped, and the facts that name it (the failing step and its output tail, the paths). */
export class LandingError extends HarnessError {
  readonly failure: LandingFailure;
  readonly facts: Readonly<Record<string, unknown>>;

  constructor(failure: LandingFailure, message: string, facts: Readonly<Record<string, unknown>> = {}) {
    super(message, `landing_${failure}`, failure.endsWith("_errored"), {});
    this.failure = failure;
    this.facts = deepFreeze({ ...facts });
  }
}

/**
 * The landing refusal of a failed git step, or `null` for an error that is
 * not one: `git_errored` when the machine ended it (the port's ceiling, a
 * signal, git not started, or its words reporting an environmental error such
 * as a full disk — the command runner's own rule), else `git_failed` (git
 * refused: a state the landing must not meet). Covers both git doors, the
 * worktree port and the tree readers' `gitOutput`.
 */
export function landingGitFailure(error: unknown, phase: string): LandingError | null {
  if (!(error instanceof HarnessError)) return null;
  const facts = { phase, operation: error.safeDetails["operation"] ?? null };
  if (error instanceof WorktreeGitTimeout) return new LandingError("git_errored", `${error.message} (landing phase ${phase})`, facts);
  let ending: "exited" | "signal";
  if (error instanceof WorktreeGitError) ending = error.safeDetails["exitCode"] === -1 ? "signal" : "exited";
  else if (error.code === "tree_reader_git_failed") ending = error.safeDetails["ending"] === "exited" ? "exited" : "signal";
  else return null;
  const words = String(error.safeDetails["stderr"] ?? error.message);
  return new LandingError(commandFailureClass(ending, words) === "errored" ? "git_errored" : "git_failed", `${error.message} (landing phase ${phase})`, { ...facts, tail: words });
}

/**
 * THE PHASE RUNNER: runs one landing phase, logging its start and its end
 * (duration, outcome, the typed code of a refusal) at this one choke point;
 * a git step's failure leaves it typed ({@link landingGitFailure}).
 */
export async function runLandingPhase<T>(phase: string, facts: Readonly<Record<string, unknown>>, body: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  debugLog("workflow", "info", `landing phase ${phase} started`, () => ({ phase, ...facts }));
  try {
    const result = await body();
    debugLog("workflow", "info", `landing phase ${phase} passed`, () => ({ phase, outcome: "pass", durationMs: Date.now() - started, ...facts }));
    return result;
  } catch (error) {
    const refusal = landingGitFailure(error, phase) ?? error;
    const code = refusal instanceof HarnessError ? refusal.code : "unexpected";
    debugLog("workflow", "warn", `landing phase ${phase} stopped: ${code}`, () => ({ phase, outcome: "fail", code, durationMs: Date.now() - started, ...facts }));
    throw refusal;
  }
}

export type CandidateRequest = Readonly<{
  git: WorktreeGitPort;
  /** Any checkout of the repository (the worktree is added from it). */
  repoRoot: string;
  /** Where the candidate worktree is made (absent; on the repository's filesystem: the caller checks). */
  path: string;
  /** The target tip T: the candidate's first parent. */
  target: string;
  /** The source commit S: the second parent, unless T already holds it. */
  source: string;
  /** The computed tree P the candidate holds. */
  tree: string;
  message: string;
  identity: CommitIdentity;
  timeoutMs: number;
}>;

/**
 * Makes the candidate (see the header) and checks its postcondition: its
 * index and files are exactly P, and `MERGE_HEAD` names S (absent when T
 * already holds S). Answers whether S is a second parent.
 */
export function createCandidate(request: CandidateRequest): Readonly<{ merged: boolean }> {
  const { git, path, timeoutMs } = request;
  git.worktreeAddDetached({ repoRoot: request.repoRoot, worktreePath: path, commitSha: request.target, timeoutMs });
  const merged = !git.isAncestor(request.repoRoot, request.source, request.target, timeoutMs);
  if (merged) git.mergeOursNoCommit({ cwd: path, commit: request.source, message: request.message, identity: request.identity, timeoutMs });
  git.readTreeReset(path, request.tree, timeoutMs);
  const staged = git.stageAll(path, timeoutMs);
  if (staged !== request.tree) {
    throw new LandingError("candidate_mismatch", `the candidate ${path} holds the tree ${staged}, not the computed tree ${request.tree}`, { path, staged, tree: request.tree });
  }
  return deepFreeze({ merged });
}

export type SettleRequest = Readonly<{
  git: WorktreeGitPort;
  /** The candidate's root. */
  root: string;
  /** The checkout the declared links point into (the invoking one). */
  sourceRoot: string;
  /** The engine root's path below the candidate's top (the config document's place). */
  engineRelative: string;
  isolation: Readonly<{ commands: Readonly<Record<string, CheckoutCommand>>; links: readonly string[] }>;
  phases: Readonly<{ setup: readonly string[]; converge: readonly string[]; verify: readonly string[] }>;
  run: RunCheckoutCommand;
  /** The generated outputs of the candidate's tree (the paths setup and converge may write). */
  generatedOutputs: (root: string) => ReadonlySet<string>;
  /** The candidate's tree before settling (P). */
  baseTree: string;
  timeoutMs: number;
}>;

export type SettleReport = Readonly<{
  /** The settled tree F (staged in the candidate's index). */
  tree: string;
  steps: readonly CheckoutStep[];
  /** The converge phase's fixed point (no pass when the phase declares no command). */
  convergence: ConvergenceReport;
  /** The paths settling changed against P: each a generated output. */
  regenerated: readonly string[];
}>;

/** The failure kind of a failed phase step: errored (the machine's) or failed (the tree's). */
function phaseFailure(phase: "setup" | "gate", failed: CheckoutStep): LandingFailure {
  return failed.failure === "errored" ? `${phase}_errored` : `${phase}_failed`;
}

function phaseRefusal(request: SettleRequest, phase: "setup" | "converge" | "verify", failed: CheckoutStep): LandingError {
  return new LandingError(phaseFailure(phase === "setup" ? "setup" : "gate", failed), `the ${phase} command ${failed.step} failed in ${request.root}: ${failed.message}`, {
    phase, step: failed.step, message: failed.message, tail: failed.details.join("\n"), candidate: request.root,
  });
}

async function runPhaseCommands(request: SettleRequest, phase: "setup" | "verify", steps: CheckoutStep[]): Promise<void> {
  const ran = await runDeclaredCommands(request.isolation, phase, request.phases[phase], request.run);
  steps.push(...ran);
  const failed = ran.find((entry) => entry.status === "fail");
  if (failed !== undefined) throw phaseRefusal(request, phase, failed);
}

/** One converge pass: whether every command passed, and the first that failed. */
type ConvergePass = Readonly<{ allPassed: boolean; failed: CheckoutStep | undefined }>;

/** An index entry: its mode, object id and merge stage (`"0"`: no conflict). */
type IndexEntry = Readonly<{ mode: string; oid: string; stage: string }>;

/** The index of the checkout at `cwd` as `ls-files --stage` records it: path → its entry (a conflicted path: its last stage). */
function indexEntries(git: WorktreeGitPort, cwd: string, timeoutMs: number): ReadonlyMap<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  // `<mode> <oid> <stage>\t<path>`, NUL-terminated.
  for (const record of git.lsFilesStage(cwd, timeoutMs).split("\0")) {
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    if (tab > 0 && mode !== undefined && oid !== undefined && stage !== undefined) entries.set(record.slice(tab + 1), deepFreeze({ mode, oid, stage }));
  }
  return entries;
}

/** The candidate's whole tree as git stages it (every change, an untracked file not ignored included): path → mode, object id and stage. */
function stagedEntries(git: WorktreeGitPort, root: string, timeoutMs: number): ReadonlyMap<string, string> {
  git.stageAll(root, timeoutMs);
  return new Map([...indexEntries(git, root, timeoutMs)].map(([path, entry]) => [path, `${entry.mode} ${entry.oid} ${entry.stage}`]));
}

/**
 * THE ONE UNDECLARED-WRITE RULE of a landing (the promotion's settle and the
 * workspace merge's regenerate): every path `written` must be a generated
 * output a generator declares (`generated`); any other is refused,
 * `undeclared_write`, naming the paths and what wrote them.
 */
export function refuseUndeclaredWrites(written: readonly string[], generated: ReadonlySet<string>, phase: string, what: string, candidate: string): void {
  const undeclared = written.filter((path) => !generated.has(path));
  if (undeclared.length > 0) {
    throw new LandingError("undeclared_write", `${what} wrote ${undeclared.join(", ")}, which no generator declares (a generated output is registered with its generator)`, { phase, paths: undeclared, candidate });
  }
}

/**
 * SETTLES the candidate (see the header). The converge commands are driven to
 * the fixed point of the candidate's staged tree by the one loop
 * (`convergeUntilStable`): a pass is one full run of them; a failing pass that
 * changed nothing is the converge phase's failure; a state seen before (an
 * oscillation) or the bound — one pass per generated output, plus the pass
 * that changes nothing — is `not_converged`, naming the paths.
 */
export async function settleCandidate(request: SettleRequest): Promise<SettleReport> {
  const { git, root, timeoutMs } = request;
  const steps: CheckoutStep[] = [...applyCheckoutFiles(root, request.sourceRoot, request.engineRelative, request.isolation)];
  await runPhaseCommands(request, "setup", steps);
  const generated = request.generatedOutputs(root);
  let convergence = convergenceReport([]);
  if (request.phases.converge.length > 0) {
    let converged: Readonly<{ output: ConvergePass; convergence: ConvergenceReport }>;
    try {
      converged = await convergeUntilStable(async () => {
        const ran = await runDeclaredCommands(request.isolation, "converge", request.phases.converge, request.run);
        steps.push(...ran);
        const failed = ran.find((entry) => entry.status === "fail");
        return { allPassed: failed === undefined, failed };
      }, () => stagedEntries(git, root, timeoutMs), convergeBound(generated.size), { subject: "the converge commands", code: "landing_not_converged" });
    } catch (error) {
      if (!(error instanceof NotConvergedError)) throw error;
      // A path no generator declares is an undeclared write, whatever the bound (with none declared, it is one pass: N8).
      refuseUndeclaredWrites(error.paths, generated, "converge", "converge", root);
      throw new LandingError("not_converged", `${error.message} (${String(error.paths.length)} path(s) still change)`, { passes: error.passes, paths: error.paths, candidate: root });
    }
    if (converged.output.failed !== undefined) throw phaseRefusal(request, "converge", converged.output.failed);
    convergence = converged.convergence;
  }
  const tree = git.stageAll(root, timeoutMs);
  const regenerated = git.diffNameOnly({ cwd: root, refA: request.baseTree, refB: tree, threeDot: false, timeoutMs });
  refuseUndeclaredWrites(regenerated, generated, "converge", "setup or converge", root);
  await runPhaseCommands(request, "verify", steps);
  const verified = git.stageAll(root, timeoutMs);
  if (verified !== tree) {
    const written = git.diffNameOnly({ cwd: root, refA: tree, refB: verified, threeDot: false, timeoutMs });
    throw new LandingError("undeclared_write", `the verify commands wrote ${written.join(", ")}: a gate must not change the tree it judges`, { phase: "verify", paths: written, candidate: root });
  }
  return deepFreeze({ tree, steps, convergence, regenerated });
}

export type CommitRequest = Readonly<{
  git: WorktreeGitPort;
  root: string;
  message: string;
  /** Who the commit is by, and when (absent: the repository's configured identity). */
  identity?: CommitIdentity;
  /** The tree the commit must record (the settled tree). */
  tree: string;
  /** The parents the commit must have, in order. */
  parents: readonly string[];
  timeoutMs: number;
}>;

/**
 * COMMITS the candidate (see the header): the hooks run; a hook's refusal is
 * `commit_refused` with its words (a commit the machine ended — its ceiling, a
 * signal — is `git_errored`, typed by the phase runner), and its words on
 * success are answered too.
 * Then the postconditions: the recorded tree and parents, and no missing
 * object beyond the first parent.
 */
export function commitCandidate(request: CommitRequest): CommitOutcome {
  const { git, root, timeoutMs } = request;
  let made: CommitOutcome;
  try {
    made = git.commit({ cwd: root, message: request.message, timeoutMs, ...(request.identity === undefined ? {} : { identity: request.identity }) });
  } catch (error) {
    if (!(error instanceof WorktreeGitError) || landingGitFailure(error, "commit")?.failure === "git_errored") throw error;
    // git's stderr is already bounded by the port's error ceiling.
    const words = String(error.safeDetails["stderr"] ?? error.message);
    throw new LandingError("commit_refused", `the commit was refused (the repository's commit hooks judge it like any commit): ${words}`, { tail: words, candidate: root });
  }
  const { commit } = made;
  const recorded = git.revParse(root, `${commit}^{tree}`, timeoutMs);
  const parents = request.parents.map((_, index) => git.revParse(root, `${commit}^${String(index + 1)}`, timeoutMs));
  if (recorded !== request.tree || parents.some((parent, index) => parent !== request.parents[index])) {
    throw new LandingError("candidate_mismatch", `the commit ${commit} records the tree ${recorded} and the parents ${parents.join(", ")}, not ${request.tree} over ${request.parents.join(", ")}`, { commit, tree: recorded, parents });
  }
  const missing = git.missingObjects(root, commit, request.parents[0]!, timeoutMs);
  if (missing.length > 0) throw new LandingError("objects_missing", `the commit ${commit} reaches ${String(missing.length)} missing object(s): ${missing.join(", ")}`, { commit, missing });
  return made;
}

/**
 * How a commit landed: by a fast-forward in the checkout that has the branch,
 * by the completion of a torn fast-forward there, or by a compare-and-swap of
 * the ref. `refusal` is git's words when it declined (nothing moved); then
 * `overlap` names the checkout's own changes in the way (its work, never
 * touched) and `indexLocked` says another git holds the checkout's index.
 */
export type LandOutcome = Readonly<{
  landing: "fast-forward" | "torn-completion" | "update-ref";
  landedIn: string | null;
  refusal: string | null;
  overlap: readonly string[];
  indexLocked: boolean;
}>;

/**
 * Every path of the checkout at `cwd` a fast-forward over `delta` would have
 * to write while the checkout holds it differently from its HEAD: each staged
 * or unstaged change, and each untracked file (not ignored) where the landing
 * adds one. An untracked file elsewhere is never in the way.
 */
function dirtyPaths(git: WorktreeGitPort, cwd: string, delta: ReadonlySet<string>, timeoutMs: number): readonly string[] {
  const untracked = git.status(cwd, timeoutMs).filter((entry) => entry.untracked).map((entry) => entry.path).filter((path) => delta.has(path));
  return [...new Set([...git.diffNames(cwd, "head-to-index", timeoutMs), ...git.diffNames(cwd, "index-to-worktree", timeoutMs), ...untracked])].toSorted();
}


/**
 * The paths among `paths` the checkout `cwd` does NOT hold exactly as
 * `entries` records them (absent when an entry is): the kind, the execute
 * bit, the bytes (one `hash-object` for every regular file, filters applied)
 * or the link target (hashed here: no filter applies to a link).
 */
function pathsNotHolding(git: WorktreeGitPort, cwd: string, paths: readonly string[], entries: ReadonlyMap<string, Readonly<{ mode: string; oid: string }>>, timeoutMs: number): readonly string[] {
  const differing: string[] = [];
  const toHash: string[] = [];
  for (const path of paths) {
    const entry = entries.get(path);
    const stats = lstatSync(join(cwd, path), { throwIfNoEntry: false });
    if (entry === undefined || stats === undefined) {
      if (entry !== undefined || stats !== undefined) differing.push(path);
    } else if (entry.mode === "120000") {
      if (!stats.isSymbolicLink() || gitBlobId(Buffer.from(readlinkSync(join(cwd, path))), entry.oid) !== entry.oid) differing.push(path);
    } else if (!stats.isFile() || ((stats.mode & 0o100) !== 0) !== (entry.mode === "100755")) {
      differing.push(path);
    } else {
      toHash.push(path);
    }
  }
  const hashed = git.hashObjects(cwd, toHash, timeoutMs);
  toHash.forEach((path, index) => {
    if (hashed[index] !== entries.get(path)!.oid) differing.push(path);
  });
  return differing.toSorted();
}

/**
 * The paths among `paths` whose index entry in the checkout `cwd` is neither
 * the old tip's (`before`) nor the commit's (`after`) — absent counts as an
 * entry — or is a conflict: a version staged there that exists nowhere else,
 * which a completion would overwrite.
 */
function pathsStagedApart(git: WorktreeGitPort, cwd: string, paths: readonly string[], before: ReadonlyMap<string, Readonly<{ mode: string; oid: string }>>, after: ReadonlyMap<string, Readonly<{ mode: string; oid: string }>>, timeoutMs: number): readonly string[] {
  if (paths.length === 0) return [];
  const index = indexEntries(git, cwd, timeoutMs);
  const same = (staged: IndexEntry | undefined, recorded: Readonly<{ mode: string; oid: string }> | undefined): boolean =>
    staged === undefined ? recorded === undefined : recorded !== undefined && staged.mode === recorded.mode && staged.oid === recorded.oid;
  return paths.filter((path) => {
    const staged = index.get(path);
    return (staged !== undefined && staged.stage !== "0") || (!same(staged, before.get(path)) && !same(staged, after.get(path)));
  });
}

/**
 * LANDS `commit` on `branch` (see the header): a fast-forward in the checkout
 * that has the branch checked out — completing a torn one with git alone —,
 * else `update-ref` from `oldTip`. git's refusal is data (nothing moved),
 * never an exception.
 */
export function landCommit(git: WorktreeGitPort, repoRoot: string, branch: string, commit: string, oldTip: string, engineRelative: string, timeoutMs: number): LandOutcome {
  const holder = branchCheckout(git, repoRoot, branch, timeoutMs);
  if (holder === null) {
    const moved = git.updateRef(repoRoot, `refs/heads/${branch}`, commit, oldTip, timeoutMs);
    return deepFreeze({ landing: "update-ref", landedIn: null, refusal: moved.refusal, overlap: [], indexLocked: false });
  }
  const merged = git.mergeFfOnly(holder, commit, timeoutMs);
  if (merged.refusal === null) {
    settleCheckout(holder, engineRelative);
    return deepFreeze({ landing: "fast-forward", landedIn: holder, refusal: null, overlap: [], indexLocked: false });
  }
  if (/index\.lock/u.test(merged.refusal)) return deepFreeze({ landing: "fast-forward", landedIn: holder, refusal: merged.refusal, overlap: [], indexLocked: true });
  // A torn fast-forward: every dirty path is one the landing changes, already at the commit's bytes, and staged as the old tip or the commit records it.
  const delta = new Set(git.diffNameOnly({ cwd: holder, refA: oldTip, refB: commit, threeDot: false, timeoutMs }));
  const dirty = dirtyPaths(git, holder, delta, timeoutMs);
  const head = git.revParse(holder, "HEAD", timeoutMs);
  const inDelta = dirty.filter((path) => delta.has(path));
  const entries = git.treeEntries(holder, commit, inDelta, timeoutMs);
  const foreign = new Set([
    ...dirty.filter((path) => !delta.has(path)),
    ...pathsNotHolding(git, holder, inDelta, entries, timeoutMs),
    ...pathsStagedApart(git, holder, inDelta, git.treeEntries(holder, oldTip, inDelta, timeoutMs), entries, timeoutMs),
  ]);
  if (head !== oldTip || dirty.length === 0 || foreign.size > 0) {
    return deepFreeze({ landing: "fast-forward", landedIn: holder, refusal: merged.refusal, overlap: [...foreign].filter((path) => delta.has(path)).toSorted(), indexLocked: false });
  }
  const staged: IndexEntryUpdate[] = dirty.map((path) => {
    const entry = entries.get(path);
    return entry === undefined ? { path, remove: true } : { path, mode: entry.mode, oid: entry.oid };
  });
  git.updateIndexEntries(holder, staged, timeoutMs);
  git.readTreeSwitch(holder, oldTip, commit, timeoutMs);
  settleCheckout(holder, engineRelative);
  const moved = git.updateRef(holder, `refs/heads/${branch}`, commit, oldTip, timeoutMs);
  debugLog("workflow", "info", "landing completed a torn fast-forward", () => ({ branch, commit, checkout: holder, paths: dirty, refusal: moved.refusal }));
  return deepFreeze({ landing: "torn-completion", landedIn: holder, refusal: moved.refusal, overlap: [], indexLocked: false });
}

/** The checkout that has `branch` checked out (a land writes into it), or `null` when none does. */
export function branchCheckout(git: WorktreeGitPort, repoRoot: string, branch: string, timeoutMs: number): string | null {
  return git.worktreeList(repoRoot, timeoutMs).find((entry) => entry.branch === `refs/heads/${branch}`)?.path ?? null;
}

/** How a push ended: `pushed` (every ref moved), `rejected` (the remote moved: a ref was not a fast-forward), `refused` (the remote or its hooks declined; a permission), `errored` (the remote was not reached). */
export type PushVerdict = Readonly<{ verdict: "pushed" | "rejected" | "refused" | "errored"; detail: string }>;

/** git's words that say the remote, or the user's access to it, refused: a configuration or permission to fix, never a busy network. */
const REMOTE_REFUSAL_WORDS = /Authentication failed|Permission denied|could not read (?:Username|Password)|terminal prompts disabled|\b40[13]\b|does not appear to be a git repository|No such remote|repository not found|' not found|protected branch|pre-receive hook declined/iu;

/** The class of a remote operation git could not run (a fetch, a listing, a push that reported no ref): refused or errored (see {@link PushVerdict}). */
export function remoteFailureClass(words: string): "refused" | "errored" {
  return REMOTE_REFUSAL_WORDS.test(words) ? "refused" : "errored";
}

/** The verdict of a push's answer (see {@link PushVerdict}): its per-ref lines first, git's words when it reported none. */
export function pushVerdict(outcome: PushOutcome): PushVerdict {
  const failed = outcome.refs.filter((ref) => ref.flag === "!");
  const lines = failed.map((ref) => `${ref.destination} ${ref.summary}`).join("; ");
  if (outcome.status === 0 && failed.length === 0) return deepFreeze({ verdict: "pushed", detail: outcome.refs.map((ref) => `${ref.destination} ${ref.summary}`).join("; ") });
  if (failed.some((ref) => ref.summary.startsWith("[remote rejected]"))) return deepFreeze({ verdict: "refused", detail: lines });
  if (failed.some((ref) => /^\[rejected\] \((?:non-fast-forward|fetch first|stale info)\)/u.test(ref.summary))) return deepFreeze({ verdict: "rejected", detail: lines });
  const words = `${lines}${lines.length > 0 ? "; " : ""}${outcome.stderr}`;
  return deepFreeze({ verdict: failed.length > 0 ? "refused" : remoteFailureClass(outcome.stderr), detail: words });
}

/**
 * PUBLISHES to `remote` (see the header): ONE `git push --atomic` of
 * `refspecs` (never forced: the port refuses a `+`), answered as a
 * {@link PushVerdict}.
 */
export function pushToRemote(git: WorktreeGitPort, repoRoot: string, remote: string, refspecs: readonly string[], timeoutMs: number): PushVerdict {
  const verdict = pushVerdict(git.pushAtomic(repoRoot, remote, refspecs, timeoutMs));
  debugLog("workflow", verdict.verdict === "pushed" ? "info" : "warn", `push to ${remote}: ${verdict.verdict}`, () => ({ remote, refspecs, verdict: verdict.verdict, detail: verdict.detail }));
  return verdict;
}

/**
 * Removes the candidates under `directory` — this repository's worktrees
 * whose folder sits directly in it and whose name `isCandidate` accepts —
 * keeping the newest when `keepNewest` (a failed candidate kept for
 * inspection), then prunes git's worktree records. Answers the removed paths.
 * Nothing else is touched.
 */
export function sweepCandidates(git: WorktreeGitPort, repoRoot: string, directory: string, isCandidate: (name: string) => boolean, keepNewest: boolean, timeoutMs: number): readonly string[] {
  // git records a worktree's real path: compare against both spellings of the folder.
  const folders = new Set([directory, existsSync(directory) ? realpathSync(directory) : directory]);
  const candidates = git.worktreeList(repoRoot, timeoutMs)
    .filter((entry) => folders.has(dirname(entry.path)) && isCandidate(basename(entry.path)))
    .map((entry) => ({ path: entry.path, at: statSync(entry.path, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => b.at - a.at);
  const removed = candidates.slice(keepNewest ? 1 : 0).map((entry) => entry.path);
  for (const path of removed) {
    removeGateLogs(path);
    git.worktreeRemove({ repoRoot, worktreePath: path, force: true, timeoutMs });
  }
  git.worktreePrune(repoRoot, timeoutMs);
  return deepFreeze(removed);
}
