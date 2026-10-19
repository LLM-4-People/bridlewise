/**
 * Git bridge — read-only git status for project paths. This is a thin
 * boundary adapter: the canonical runtime git adapter (`src/git/git-adapter.ts`)
 * is built for the governed runtime (pinned process, effect recording) and
 * requires a full GitRuntime + config. For the web UI's project listing we
 * only need a read-only status summary (branch + dirty file count), so we
 * invoke git directly with `--no-optional-locks` and a tight timeout. No
 * mutating git operations happen here.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { serverConfig } from "../kernel/config.ts";
import { assertProjectPathOwnership, type FsGate } from "../filesystem/fs-gate.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { recordEffect, recordEffectAsync } from "../kernel/canonical.ts";
import { ServiceUnavailableError } from "../kernel/errors.ts";
// The process itself is created by the confinement owner's single door
// (`spawnPlannedSync`), which is why `spawnSync` is no longer imported here.
import { prepareConfinedSpawn, readGuardianOutcome, spawnPlanned, spawnPlannedSync, type CapturedPlannedResult } from "../safety/landlock-runner.ts";

export type ProjectGitStatus = Readonly<{
  branch: string | null;
  dirtyFiles: number;
  head: string | null;
}>;

// The git subprocess env is owned by server/config.ts (the single config
// owner) as `serverConfig.subprocessEnv` — a frozen env built from an
// EXPLICIT allowlist (deny-by-default: only PATH/HOME/GIT_*/etc. pass
// through; secrets like HARNESS_API_KEY are dropped) + GIT_OPTIONAL_LOCKS=0.
// This env is shared by ALL subprocesses (git + execute_command + typecheck)
// — the name `subprocessEnv` reflects that it is not git-specific. This
// module MUST NOT read process.env directly (Single-Party-Owner: config
// reading has one owner; the prior `const GIT_ENV = {...process.env,
// GIT_OPTIONAL_LOCKS: "0" }` duplicated that logic AND bypassed the
// owner). (-F9): the full-env copy leaked secrets to git hooks —
// now the allowlist prevents that. We consume the owner's env here.
/**
 * ── GIT RUNS PROGRAMS THE PROJECT NAMES, AND THAT WAS A LIVE ESCAPE ───────
 *
 * `git` is not an inert reader of files. It executes programs named in
 * configuration it finds in the repository it is pointed at: `core.fsmonitor`
 * on an ordinary `git status`, `core.pager`, `alias.*`, `filter.*.clean` and
 * `filter.*.smudge`, and the hooks in `.git/hooks`. The repository is the
 * project, and the project is writable from inside the sandbox.
 *
 * Measured end to end on git 2.47.3: a confined `execute_command` wrote
 * `<project>/pwn.sh` and appended `[core] fsmonitor = <project>/pwn.sh` to the
 * project's own `.git/config`; a read-only `git status --porcelain` through
 * this function then executed it with the server's full filesystem authority.
 * No mutating git operation was involved and nothing in the request was
 * unusual — the project only has to be a git repository, which is the case
 * this module exists to handle.
 *
 * TWO CHANGES, AND NEITHER IS SUFFICIENT ALONE:
 *
 * 1. The invocation is CONFINED, through the same door as every other
 *    subprocess this server starts. A program git decides to run is a child
 *    of the guardian's restricted process, so it inherits the restriction —
 *    Landlock's is irrevocable and survives fork and exec. `core.fsmonitor`
 *    still runs; it now runs inside the project it came from, which is
 *    authority the model already had. That converts an escalation into a
 *    no-op, and it does so for every one of git's execution channels at once
 *    rather than for the one that was found.
 *
 * 2. The GLOBAL and SYSTEM configurations are taken out of the picture with
 *    `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at `/dev/null`.
 *    Those files are outside the project and therefore unreadable under
 *    confinement anyway — git would warn about them on every call — and they
 *    are a second source of executed programs that this server has no reason
 *    to consult when all it wants is a branch name and a dirty-file count.
 *    Deny by default: the only configuration that applies is the repository's
 *    own, and that one is now harmless because it is confined.
 *
 * `core.safeCRLF=false` is unrelated and unchanged: it keeps a repository with
 * mixed line endings from turning a status read into a warning storm.
 *
 * `core.excludesFile` and `core.attributesFile` are pointed at an empty file
 * for the same reason as the two environment variables, and this one was
 * MEASURED rather than anticipated: with only the repository's own
 * configuration in play, git still looks for `$XDG_CONFIG_HOME/git/ignore` and
 * `.../attributes` in the user's home, and a confined `git status` died with
 * `fatal: cannot use /home/…/.config/git/ignore as an exclude file`. A file
 * outside the project cannot be read from inside the sandbox and should not be
 * deciding what a project's status says in any case. The repository's own
 * `.gitignore` and `.git/info/exclude` are inside the project and still apply,
 * which is the layer that actually matters for the branch name and dirty-file
 * count this module exists to produce.
 */
const GIT_ARGS = [
  "-c", "core.safeCRLF=false",
  "-c", "core.excludesFile=/dev/null",
  "-c", "core.attributesFile=/dev/null",
];

/**
 * The environment for a git child: the server's shared subprocess environment
 * with the two out-of-project configuration sources neutralised. Built per
 * call from the frozen owner rather than cached, so an env change in the one
 * config owner cannot be shadowed by a copy taken here at import time.
 */
function gitEnv(): Readonly<Record<string, string>> {
  return {
    ...serverConfig.subprocessEnv,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

/**
 * Git subcommands that only READ repository state. Read-only git operations
 * are NOT effects (nothing about the world changed), so they are not
 * recorded — the git-status poll alone would otherwise flood the ledger
 * with hundreds of identical no-op events per session.
 *
 * DENY-BY-DEFAULT: any subcommand NOT in this set is classified as
 * MUTATING and recorded as a `git` effect. An unknown subcommand is
 * over-recorded (a spurious event), never under-recorded (silent work) —
 * the safe direction for a ledger.
 */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "rev-parse", "status", "log", "diff", "diff-tree", "show", "ls-files", "branch",
]);

/**
 * Whether this git invocation MUTATES repository state.
 *
 * `branch` is read-only ONLY in its listing form (`branch -a --format=…`);
 * with any positional (non-flag) argument it creates/deletes/renames a
 * branch, so a positional argument reclassifies it as mutating.
 */
function isMutatingGitInvocation(args: readonly string[]): boolean {
  const sub = args[0];
  if (sub === undefined) return false;
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return true;
  if (sub === "branch") return args.slice(1).some((a) => !a.startsWith("-"));
  return false;
}

/**
 * Run a read-only git command in `repoPath` and return its trimmed stdout,
 * or null on any failure (non-zero exit, spawn error, exception). This is
 * the SINGLE owner of the "spawn git with the configured env + timeout +
 * safeCRLF args" pattern (No Scattered Helpers: previously
 * duplicated byte-for-byte in git-ops-bridge.ts). The `.trim` is safe for
 * every caller: status/branch/rev-parse need it, and the log/diff callers
 * `.trim` again idempotently before splitting. Exported so the git-ops
 * bridge (which EXTENDS this read-only bridge) reuses it instead of
 * redefining it.
 *
 * `okExitCodes` widens the SUCCESS set for the handful of git subcommands
 * that report a RESULT through their exit status rather than a failure.
 * `git diff --no-index` is the case in hand: it exits 1 when the two paths
 * differ, which is the answer, not an error. Without this the only way to
 * read such a command would be a second spawn site — exactly the scattered
 * duplicate this owner exists to prevent. Default `[]` keeps every existing
 * caller on the strict "0 or null" contract, and a widened code still runs
 * through the SAME classification + recording wrap below.
 */
/**
 * WHY A READ PRESERVES EXECUTION AND CAPTURE ENDINGS.
 *
 * `gitText` answers `string | null`, and `null` conflates two facts that a
 * caller must not conflate: git RAN and produced nothing, and git NEVER RAN
 * because confinement refused it. Read paths built on the nullable form
 * returned `[]` for both — so a sandbox that had stopped working looked
 * exactly like a repository with no branches, which is a false statement in
 * the direction where nobody looks again. `landlock-runner.ts` documents that
 * exact hazard and solves it with a discriminator; this is the same
 * discriminator on the same question. An incomplete capture is a fourth
 * outcome: it cannot supply counts, and it cannot claim git never ran.
 *
 * `gitText` remains, unchanged in behaviour, for the callers whose question
 * really is "did I get a string" — but it is now DERIVED from this, so there
 * is one implementation and the distinction is available to anyone who needs
 * it rather than lost before they can ask.
 */
export type GitRead =
  | Readonly<{ kind: "ran"; stdout: string }>
  /** The guardian refused, or git could not be started. Nothing was executed. */
  | Readonly<{ kind: "not_run"; reason: string }>
  /** git ran and reported a failure. */
  | Readonly<{ kind: "failed"; reason: string }>
  /** The read did not yield a complete result; execution may already have begun. */
  | Readonly<{ kind: "unavailable"; reason: string }>;

export function gitRead(repoPath: string, args: readonly string[], okExitCodes: readonly number[], options: Readonly<{ async: true }>): Promise<GitRead>;
export function gitRead(repoPath: string, args: readonly string[], okExitCodes?: readonly number[]): GitRead;
export function gitRead(
  repoPath: string,
  args: readonly string[],
  okExitCodes: readonly number[] = [],
  options?: Readonly<{ async: true }>,
): GitRead | Promise<GitRead> {
  // One plan, outcome classifier and effect boundary for both execution
  // shapes. Captured async reads use the same confined program and arguments.
  const run = (): GitRead | Promise<GitRead> => {
    let release: (() => void) | undefined;
    const unexpected = (err: unknown): GitRead => {
      try {
        webWarn("git-bridge", "gitRead threw unexpectedly", () => ({ repoPath, args: args.join(" "), error: err instanceof Error ? err.message : String(err) }));
        return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
      } finally { release?.(); }
    };
    const settle = (result: CapturedPlannedResult, confined: boolean): GitRead => {
      try {
        const rawStderr = result.stderr ?? "";
        const outcome = confined ? readGuardianOutcome(result.status, rawStderr)
          : ({ kind: "payload_ran", stderr: rawStderr } as const);
        if (outcome.kind === "refused_before_exec") return { kind: "not_run", reason: outcome.message };
        const exitAccepted = result.status === 0 || (result.status !== null && okExitCodes.includes(result.status));
        if (result.error !== undefined) return { kind: "unavailable", reason: result.error.message };
        if (!exitAccepted) return { kind: "failed", reason: `exit ${result.status ?? "null"}${outcome.stderr.trim().length > 0 ? `: ${outcome.stderr.trim()}` : ""}` };
        return { kind: "ran", stdout: result.stdout.trim() };
      } finally { release?.(); }
    };
    try {
      const plan = prepareConfinedSpawn({ command: "git", args: [...GIT_ARGS, ...args], projectRoot: repoPath });
      if (plan.kind === "refused") return { kind: "not_run", reason: plan.message };
      if (plan.kind === "confined") release = plan.release;
      const spawnOptions = { cwd: repoPath, timeout: serverConfig.gitTimeoutMs, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] as const };
      return options?.async === true
        ? spawnPlanned(plan, { ...spawnOptions, capture: true }).then((result) => settle(result, plan.kind === "confined"), unexpected)
        : settle(spawnPlannedSync(plan, { ...spawnOptions, encoding: "utf8" }), plan.kind === "confined");
    } catch (err) { return unexpected(err); }
  };
  const effectOptions = {
    failedWhen: (out: GitRead) => out.kind !== "ran",
    errorOf: (out: GitRead) => ({ message: out.kind === "ran" ? "git command failed" : out.kind === "not_run" ? `git was not run: ${out.reason}` : out.reason, code: "git_failed" }),
  };
  if (options?.async === true) {
    const runAsync = async (): Promise<GitRead> => run();
    return isMutatingGitInvocation(args) ? recordEffectAsync("git", args[0] ?? "git", runAsync, effectOptions) : runAsync();
  }
  const runSync = (): GitRead => run() as GitRead;
  return isMutatingGitInvocation(args) ? recordEffect("git", args[0] ?? "git", runSync, effectOptions) : runSync();
}

/**
 * The stdout of a read that RAN, or `null` for either kind of non-answer.
 * The thin form, for callers whose question really is "did I get a string".
 * Derived from {@link gitRead} so there is one implementation of the spawn.
 */
export function gitText(
  repoPath: string,
  args: readonly string[],
  okExitCodes: readonly number[] = [],
): string | null {
  const read = gitRead(repoPath, args, okExitCodes);
  return read.kind === "ran" ? read.stdout : null;
}

/**
 * THE ONE PLACE A REFUSED GIT READ BECOMES A USER-FACING ANSWER.
 *
 * `not_run` means the guardian refused and git never existed. It is not a
 * measurement, so it may never be rendered as one — no empty list, no zero
 * count, no `false`. Every read path that a person can see routes its
 * `GitRead` through here first, which is why the sentence exists once instead
 * of once per surface: N surfaces rendering the same refusal N ways is N
 * chances to render it as emptiness, and that is the defect this function
 * exists to make unavailable.
 *
 * THE SURFACE IS WIDER THAN THE ROUTES, AND SAYING "FIVE ROUTES" HID THAT.
 * The five paths `registerGitOpsRoutes` registers are not the population.
 * `blocks/custody.ts` — a user-facing block surface with no route of its own
 * — reaches git through four handlers of its own, so the protected set is
 * ten `isGitRepo` call sites across three modules, not five. The count is not
 * repeated here as a literal: `git-bridge-owner.test.ts` derives the module
 * set from this file's own exported primitives and fails when it shrinks,
 * because an enumeration written in prose is a claim that goes stale in the
 * permissive direction while still reading as authoritative.
 *
 * The message the guardian produced is already written for a reader and
 * already carries the way out ("Choose a different project folder"), so it is
 * handed through unchanged rather than re-worded into a status code.
 *
 * ── WHAT THE ASSERTION SIGNATURE DOES AND DOES NOT BUY, MEASURED ─────────
 *
 * This returns `asserts read is …`, and that was written up as making the
 * defect "unrepresentable rather than merely checked". It does not. Driven on
 * both toolchains this project ships (tsc 5.9.3 and tsc 7.0.2), counting
 * diagnostics whose path is the probe's own file rather than an exit code:
 *
 *     r.stdout, unnarrowed                       -> 1 diagnostic  (TS2339)
 *     r.kind === "ran" ? r.stdout : null         -> 0 diagnostics
 *     if (r.kind !== "ran") return []            -> 0 diagnostics
 *     the same ternary AFTER raiseIfNotRun(r)    -> 0 diagnostics
 *
 * The middle two ARE the shape that caused the outage, and they compile
 * silently — before this function existed and after it. The one refusal the
 * compiler does give comes from `GitRead` being a discriminated union and
 * predates this function entirely. So the guarantee here is a RUNTIME one at
 * a single door, and nothing stronger: emptiness-for-a-refusal remains fully
 * representable, which is precisely why the behavioural guard that drives the
 * real routes is the thing holding this closed and must not be traded for a
 * type-level claim.
 *
 * (Judging those probes by exit code would have said the opposite on one of
 * the two: tsc 7 exits 1 on diagnostics, tsc 5 exits 2, and a `tsconfig.json`
 * merely present makes every probe exit non-zero on TS5112.)
 */
export function raiseIfNotRun(
  read: GitRead,
  what: string,
): asserts read is Exclude<GitRead, { kind: "not_run" | "unavailable" }> {
  if (read.kind === "unavailable") {
    throw new ServiceUnavailableError(
      `The ${what} could not be read because git did not return a complete result: ${read.reason}`,
      "git_read_unavailable",
    );
  }
  if (read.kind !== "not_run") return;
  throw new ServiceUnavailableError(
    `The ${what} could not be read because this server would not run git: ${read.reason}`,
    "git_not_run",
  );
}

/**
 * The stdout of a read that RAN, or `null` when git ran and reported failure.
 * A REFUSAL raises instead of returning, so no caller can render it as an
 * empty string, an empty list or a zero.
 *
 * This is `gitText` with the one conflation removed, and it is what every
 * read a person can see uses. `gitText` itself stays for the callers whose
 * question really is "did I get a string" — but it is no longer reachable
 * from a user-facing surface, which is the property that was missing.
 */
export function gitTextOrRefuse(repoPath: string, args: readonly string[], what: string, okExitCodes: readonly number[], options: Readonly<{ async: true }>): Promise<string | null>;
export function gitTextOrRefuse(repoPath: string, args: readonly string[], what: string, okExitCodes?: readonly number[]): string | null;
export function gitTextOrRefuse(
  repoPath: string, args: readonly string[], what: string,
  okExitCodes: readonly number[] = [], options?: Readonly<{ async: true }>,
): string | null | Promise<string | null> {
  const text = (read: GitRead): string | null => {
    raiseIfNotRun(read, what);
    return read.kind === "ran" ? read.stdout : null;
  };
  return options?.async === true ? gitRead(repoPath, args, okExitCodes, options).then(text)
    : text(gitRead(repoPath, args, okExitCodes));
}

/**
 * Whether `rawPath` points at a working git repository. The SINGLE owner
 * of the "resolve path + exists + is-directory + `git rev-parse
 * --is-inside-work-tree`" probe (No Scattered Helpers).
 * Previously this exact logic lived inline in `getProjectGitStatus` below
 * AND as a near-duplicate named `isGitRepo` in git-ops-bridge.ts (same
 * body, different name — the violation class calls out
 * explicitly). Consolidated here so the git-ops bridge imports + reuses
 * it instead of redefining it. `gitText` already trims, so the rev-parse
 * result compares directly to `"true"` (no redundant `.trim`).
 */
/**
 * THIS SERVER'S ANSWER TO "HOW MAY GIT BE RUN?" — the confined door, handed to
 * anything in the harness that needs git and is not itself a sandbox.
 *
 * The awareness engine needs recent history and used to obtain it by running
 * git itself, through a shell, with no guardian. That is safe where it was
 * written — the command-line harness confines its own process at start-up —
 * and it was a live escape here, because this server runs the engine in a
 * worker thread of an UNCONFINED process. Measured end to end: the project's
 * own `.git/config` named a script through `core.fsmonitor`, `git diff-tree`
 * executed it, and it wrote outside the project and overwrote a file in the
 * harness's protected source tree.
 *
 * The engine no longer holds the capability; it asks its host. This is this
 * host's answer, and it is `gitText` — the SAME function every other git read
 * in this server goes through, so git gains no second door here and every one
 * of git's execution channels inherits the restriction at once. Adapting
 * rather than re-implementing is the whole value: a change to how this server
 * runs git reaches awareness with no edit anywhere.
 */
export function runGitConfined(
  repoPath: string,
  args: readonly string[],
  _timeoutMs: number,
): string | null {
  // The timeout is this server's own (`serverConfig.gitTimeoutMs`, applied
  // inside `gitText`) rather than the caller's: one owner for how long this
  // server will wait on a subprocess, and a caller cannot widen it.
  return gitText(repoPath, args);
}

/**
 * WHY THE PROBE RAISES INSTEAD OF ANSWERING `false`.
 *
 * This is the FIRST call in every git-backed read the web UI performs —
 * branches, log, diff, diff-patch, status, and the project listing's own
 * summary all begin `if (!isGitRepo(path)) return <empty>`. It was built on
 * the nullable `gitText`, which answers `null` both for "git ran and said
 * nothing" and for "the guardian refused, so git never existed". Collapsing
 * the second into `false` made every one of those callers return its empty
 * shape — `[]`, `""`, `null`, `{dirtyFiles: 0, entries: []}` — with HTTP 200.
 *
 * Measured on a path the guardian correctly refuses, against a repository
 * that had uncommitted work at that moment: `{"dirtyFiles":0,"entries":[]}`,
 * HTTP 200. A reader cannot tell "your tree is clean" from "we could not
 * look", and the first is a claim a person acts on before committing or
 * switching branches.
 *
 * The refusal-aware helper the read paths already had could never fire,
 * because this probe short-circuited above it. So the fix belongs here, at
 * the one door they all pass through, and not at any of the call sites:
 * closing it once closes every one of them, including any added later by
 * someone who never learns this happened. (The count that used to sit in
 * this sentence was six, and it was six when it was written; it is ten. A
 * number in prose is a measurement nothing re-takes — the guard derives it.)
 */
export function isGitRepo(rawPath: string): boolean {
  const repoPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) return false;
  const read = gitRead(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  raiseIfNotRun(read, "project folder");
  // `failed` is a real answer here: git ran and said this is not a work tree.
  return read.kind === "ran" && read.stdout === "true";
}

export function getProjectGitStatus(rawPath: string, gate?: FsGate): ProjectGitStatus | null {
  if (gate !== undefined) assertProjectPathOwnership(rawPath, gate);
  if (!isGitRepo(rawPath)) return null;
  const repoPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  const branch = gitTextOrRefuse(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], "current branch");
  const head = gitTextOrRefuse(repoPath, ["rev-parse", "HEAD"], "current save");
  const porcelain = gitTextOrRefuse(repoPath, ["status", "--porcelain=v1", "--untracked-files=no"], "working tree status");
  const dirtyFiles = porcelain === null ? 0 : porcelain.split("\n").filter((line) => line.length > 0).length;
  return { branch, dirtyFiles, head };
}
