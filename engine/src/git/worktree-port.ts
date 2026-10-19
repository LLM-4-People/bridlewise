import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import {
  compilePinnedProcessProfile,
  runPinnedProcess,
} from "../process/pinned-process-internal.ts";
import { resolveGitExecutable, withGitRuntime, type GitRuntime } from "./git-adapter.ts";
import type { ConfigDocument } from "../kernel/config-contracts.ts";
import { DEFAULT_GIT_RUNTIME_MAXIMUM_BYTES, worktreeOperationTimeouts } from "../workflow/workflow-config.ts";
import { GIT_OBJECT_NAME, parsePushPorcelain, type GitIdentity, type PushedRef } from "./git-port.ts";
import type { GitRepository } from "./tree-reader.ts";
import { COMMAND_ENVIRONMENT, GIT_NETWORK_ENVIRONMENT, projectEnvironment } from "../process/environment-projection.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

/**
 * Worktree git port — typed operations for isolated agent workspaces.
 *
 * Implements the git-worktree half of the isolated agent workspace design:
 *
 * ADMIT -> CREATE -> WORK -> VALIDATE -> MERGE -> DONE
 *
 * Every operation:
 * - Executes through the pinned-process authority (the git executable is
 * pinned via `/proc/self/fd/<descriptor>` and re-verified per call).
 * - Runs with `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`,
 * `GIT_CONFIG_NOSYSTEM=1`, and `GIT_CONFIG_GLOBAL=/dev/null`.
 * - Passes `-c gc.auto=0` so linked worktrees never trigger background GC
 * against the canonical object store (replaces a persistent config write,
 * which would mutate canonical repository state).
 * - Carries an explicit per-call timeout sourced from
 * `workspaceGit.timeouts` by the caller.
 * - Refuses branch names outside the configured `agent/` namespace and any
 * argument that could be interpreted as an option.
 * - Never embeds credentials in arguments, errors, or output; stderr is
 * sanitized of URL userinfo before it reaches an error object.
 *
 * - Runs a repository's own hooks only where git runs them for the
 * operation (a commit), with a PROJECTED environment (`hooks: true`: the
 * minimal child set, the home and the temp folder — never this process's
 * whole environment), so the commit guard a hook hands over to certifies a
 * workspace's commits exactly as it certifies anyone's.
 * - Reaches a REMOTE (`fetchRefs`, `lsRemote`, `pushAtomic`: `network: true`)
 * with the user's own transport: the network projection
 * (`GIT_NETWORK_ENVIRONMENT`: the home, the proxy, the SSH agent, the
 * password program) and the user's git configuration, where a remote's
 * credential helper and URL rewrites live — never a credential of the
 * harness's. Every such call carries the promotion run variable
 * (`ROOT_POLICY.workflow.promotion.runEnvironmentVariable`), so the
 * repository's trigger hook never starts a promotion from the harness's own
 * fetch or push. A push is atomic and never forced (a `+` refspec is
 * refused); its per-ref answer is data (`--porcelain`), never an exception.
 *
 * The port is created either over a real pinned `GitRuntime`
 * (`createPinnedWorktreeGitExec`) or over an injected `WorktreeGitExec`
 * for pure unit tests (argument construction, output parsing, timeout and
 * namespace handling without a live repository).
 */

export const WORKTREE_PORT_SCHEMA_VERSION = schemaId("worktree-port", 2);

const GIT_EXECUTABLE_TARGET_DESCRIPTOR = 4;
import { DEFAULT_MAXIMUM_ERROR_BYTES, DEFAULT_MAXIMUM_ERROR_OUTPUT_CHARACTERS, DEFAULT_MAXIMUM_INPUT_BYTES, DEFAULT_MAXIMUM_OUTPUT_BYTES } from "./git-config.ts";
import { schemaId } from "../kernel/product-identity.ts";
const ALLOWED_SIGNALS: readonly NodeJS.Signals[] = [];

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
/**
 * What a hook git runs is handed: the command environment (programs, locale,
 * home, credential-free proxy) and the temp folder variables — the commit
 * guard spawns node, npm and git, and a test run's private TMPDIR must reach
 * it. Nothing else of this process's environment (a provider key, a token).
 */
const HOOK_ENVIRONMENT: readonly string[] = Object.freeze([...COMMAND_ENVIRONMENT, "TMPDIR", "TMP", "TEMP"]);
const URL_USERINFO_PATTERN = /(https?:\/\/)[^@\s]*@/gu;

export type WorktreeInfo = Readonly<{
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}>;

/**
 * Who a commit is by, and when: the author and the committer are the same
 * person; `date` (an ISO 8601 instant), when given, is both dates — a commit
 * whose inputs are all fixed is then the same object on every machine.
 */
export type CommitIdentity = GitIdentity & Readonly<{ date?: string }>;

export type WorktreeGitExecRequest = Readonly<{
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  allowedExitCodes: readonly number[];
  identity?: CommitIdentity;
  /** The operation runs the repository's hooks (a commit): the hook environment is projected in. */
  hooks?: boolean;
  /** The operation reaches a remote (a fetch, a push, a listing): the network environment and the user's git configuration (see the header). */
  network?: boolean;
}>;

export type WorktreeGitExecResult = Readonly<{
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}>;

export type WorktreeGitExec = (request: WorktreeGitExecRequest) => WorktreeGitExecResult;

export type WorktreeAddRequest = Readonly<{
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  timeoutMs: number;
}>;

export type WorktreeRemoveRequest = Readonly<{
  repoRoot: string;
  worktreePath: string;
  force: boolean;
  timeoutMs: number;
}>;

export type WorktreeLockRequest = Readonly<{
  repoRoot: string;
  worktreePath: string;
  reason?: string;
  timeoutMs: number;
}>;

export type DiffNameOnlyRequest = Readonly<{
  cwd: string;
  refA: string;
  refB: string;
  threeDot: boolean;
  timeoutMs: number;
}>;

export type WorktreeAddDetachedRequest = Readonly<{
  repoRoot: string;
  worktreePath: string;
  commitSha: string;
  timeoutMs: number;
}>;

export type MergeNoCommitRequest = Readonly<{
  cwd: string;
  branch: string;
  message: string;
  /** git asks for an identity even before the commit; absent: the repository's configured identity. */
  identity?: CommitIdentity;
  timeoutMs: number;
}>;

/** A merge of a COMMIT (not a branch) that records it as the second parent and keeps the current tree (`-s ours`), left uncommitted. */
export type MergeOursRequest = Readonly<{
  cwd: string;
  commit: string;
  message: string;
  identity?: CommitIdentity;
  timeoutMs: number;
}>;

/** A merge left in progress: clean, or the paths git left conflicted (unmerged index entries). */
export type MergeNoCommitResult = Readonly<{ clean: boolean; conflictPaths: readonly string[] }>;

export type CommitRequest = Readonly<{
  cwd: string;
  message: string;
  /** The author and committer (and, with a date, both dates); absent: the repository's configured identity. */
  identity?: CommitIdentity;
  timeoutMs: number;
}>;

/** A commit made: its id, and what the commit printed — the repository's hooks speak there (their certificate, their warnings). */
export type CommitOutcome = Readonly<{ commit: string; output: string }>;

/** A refusal is data (git declined and changed nothing), never an exception: git's words, or null when it did it. */
export type RefusableOutcome = Readonly<{ refusal: string | null }>;

/**
 * One path of `git status --porcelain=v2 -z` (the port's one status reader:
 * NUL-separated, so a path with a space, a quote or ` -> ` is read whole):
 * `staged` when the index differs from HEAD there, `unstaged` when the
 * working tree differs from the index, `untracked` for a file git does not
 * track; a rename or copy names its new path (`from`: the old one).
 */
export type StatusEntry = Readonly<{ path: string; staged: boolean; unstaged: boolean; untracked: boolean; from?: string }>;

/** A push's answer: git's exit status, every ref it reported, and its words on stderr (sanitized). Never thrown: the caller classifies. */
export type PushOutcome = Readonly<{ status: number; refs: readonly PushedRef[]; stderr: string }>;

/** A remote listing's answer: each ref asked for that the remote holds, and git's words when it could not ask (`null`: it answered). */
export type RemoteListing = Readonly<{ refs: ReadonlyMap<string, string>; refusal: string | null }>;

/** One index entry a torn landing stages: the object at `path` (mode and id), or its removal. */
export type IndexEntryUpdate = Readonly<{ path: string; mode: string; oid: string } | { path: string; remove: true }>;

/** One deleted blob between two trees: the path and the blob the older tree held there. */
export type DeletedBlobEntry = Readonly<{ path: string; blob: string }>;

export type WorktreeGitPort = Readonly<{
  readonly schemaVersion: typeof WORKTREE_PORT_SCHEMA_VERSION;
  worktreeAdd(request: WorktreeAddRequest): void;
  worktreeAddDetached(request: WorktreeAddDetachedRequest): void;
  worktreeRemove(request: WorktreeRemoveRequest): void;
  worktreeList(repoRoot: string, timeoutMs: number): readonly WorktreeInfo[];
  worktreeLock(request: WorktreeLockRequest): void;
  worktreeUnlock(request: WorktreeLockRequest): void;
  worktreePrune(repoRoot: string, timeoutMs: number): void;
  /** The repository's common git directory (absolute): the same from every worktree. */
  commonDir(cwd: string, timeoutMs: number): string;
  /** The checkout's top level (absolute). */
  toplevel(cwd: string, timeoutMs: number): string;
  /** The branch HEAD names (its short name), or null when HEAD is detached. */
  symbolicBranch(cwd: string, timeoutMs: number): string | null;
  /** The paths the range's diff changes, read `-z`: NUL-delimited and never C-quoted — a non-ASCII path arrives as itself. */
  diffNameOnly(request: DiffNameOnlyRequest): readonly string[];
  /** Paths whose index entry differs from the worktree (`index-to-worktree`) or from HEAD (`head-to-index`), or that the index deletes from HEAD (`staged-deletions`). */
  diffNames(cwd: string, mode: "index-to-worktree" | "head-to-index" | "staged-deletions", timeoutMs: number): readonly string[];
  /** Blobs `fromSha`'s tree holds at paths `toSha`'s tree no longer has (renames off). */
  deletedBlobs(repoRoot: string, fromSha: string, toSha: string, timeoutMs: number): readonly DeletedBlobEntry[];
  mergeBase(repoRoot: string, refA: string, refB: string, timeoutMs: number): string;
  isAncestor(repoRoot: string, ancestor: string, descendant: string, timeoutMs: number): boolean;
  /** An agent branch's tip, or null when the branch does not exist. */
  branchTip(repoRoot: string, branch: string, timeoutMs: number): string | null;
  /** Detaches at `sha`; `discard` drops local changes to tracked files (`checkout -f`). */
  checkoutDetached(cwd: string, sha: string, timeoutMs: number, discard?: boolean): void;
  /** Switches to an agent branch; `discard` drops local changes to tracked files (`checkout -f`: a workspace the integrator verified clean). */
  checkoutBranch(cwd: string, branch: string, timeoutMs: number, discard?: boolean): void;
  mergeNoCommit(request: MergeNoCommitRequest): MergeNoCommitResult;
  mergeAbort(cwd: string, timeoutMs: number): void;
  /** `merge -s ours --no-ff --no-commit` of a commit: MERGE_HEAD names it, the tree stays HEAD's (a promotion's second parent). */
  mergeOursNoCommit(request: MergeOursRequest): void;
  /** `read-tree -u --reset <tree>`: the index AND the working tree become `tree` (a candidate's computed tree). */
  readTreeReset(cwd: string, tree: string, timeoutMs: number): void;
  /** Stages everything the checkout holds (`add -A`) and answers the tree its index now records. */
  stageAll(cwd: string, timeoutMs: number): string;
  /** Creates `ref` at `sha` only if it does not exist (git's empty old value: a compare-and-swap from absent); outside `refs/heads/`. */
  createRef(repoRoot: string, ref: string, sha: string, timeoutMs: number): RefusableOutcome;
  /** Deletes `ref` only while it still points at `oldSha`; outside `refs/heads/`. */
  deleteRef(repoRoot: string, ref: string, oldSha: string, timeoutMs: number): RefusableOutcome;
  /** Every ref whose name starts with `prefix` (a namespaced harness prefix, outside `refs/heads/`), with the object it names. */
  refsUnder(repoRoot: string, prefix: string, timeoutMs: number): ReadonlyMap<string, string>;
  /** The objects `commit` reaches beyond what `exclude` reaches that the object store LACKS (`rev-list --objects --missing=print`): `[]` for a complete commit. */
  missingObjects(repoRoot: string, commit: string, exclude: string, timeoutMs: number): readonly string[];
  /** The text of `path` in `commit`'s tree, or null when that tree has none. */
  blobAt(cwd: string, commit: string, path: string, timeoutMs: number): string | null;
  /** Resolves conflicted paths to OUR side and stages them. */
  resolveToOurs(cwd: string, paths: readonly string[], timeoutMs: number): void;
  addPaths(cwd: string, paths: readonly string[], timeoutMs: number): void;
  /** `git commit` (hooks run); returns the new HEAD. */
  commit(request: CommitRequest): CommitOutcome;
  mergeFfOnly(cwd: string, sha: string, timeoutMs: number): RefusableOutcome;
  /** `git fetch <remote> <refspec>…` (no tags, no FETCH_HEAD): git's refusal (an unreachable remote, a missing ref) is data. */
  fetchRefs(repoRoot: string, remote: string, refspecs: readonly string[], timeoutMs: number): RefusableOutcome;
  /** `git ls-remote <remote> <ref>…`: the refs asked for that the remote holds (exact names only). */
  lsRemote(repoRoot: string, remote: string, refs: readonly string[], timeoutMs: number): RemoteListing;
  /** `git push --atomic --porcelain <remote> <refspec>…`: all or nothing, never forced (see the header). */
  pushAtomic(repoRoot: string, remote: string, refspecs: readonly string[], timeoutMs: number): PushOutcome;
  /** The entries (mode and object id) `commit` records at `paths`; a path it does not hold is absent from the map. */
  treeEntries(cwd: string, commit: string, paths: readonly string[], timeoutMs: number): ReadonlyMap<string, Readonly<{ mode: string; oid: string }>>;
  /** The blob id `git add` would record for each of `paths` (filters applied), in order. */
  hashObjects(cwd: string, paths: readonly string[], timeoutMs: number): readonly string[];
  /** Stages exactly `entries` in the index of the checkout at `cwd` (`update-index --cacheinfo` / `--force-remove`). */
  updateIndexEntries(cwd: string, entries: readonly IndexEntryUpdate[], timeoutMs: number): void;
  /** Compare-and-swap: moves `ref` to `newSha` only while it is `oldSha`. */
  updateRef(repoRoot: string, ref: string, newSha: string, oldSha: string, timeoutMs: number): RefusableOutcome;
  readTree(repoRoot: string, sha: string, timeoutMs: number): void;
  /** Two-way switch of the index and worktree from `fromSha` to `toSha` (`read-tree -m -u`): touches only what differs. */
  readTreeSwitch(repoRoot: string, fromSha: string, toSha: string, timeoutMs: number): void;
  refreshIndex(repoRoot: string, timeoutMs: number): void;
  /** The index's `ls-files --stage -z` records, raw. */
  lsFilesStage(cwd: string, timeoutMs: number): string;
  revParse(repoRoot: string, ref: string, timeoutMs: number): string;
  revListCount(cwd: string, refA: string, refB: string, timeoutMs: number): number;
  /** Every path the checkout's status names (`--porcelain=v2 -z`, every untracked file): what changed where. */
  status(cwd: string, timeoutMs: number): readonly StatusEntry[];
  deleteBranch(repoRoot: string, branch: string, force: boolean, timeoutMs: number): void;
  verifyWorktreeIntact(worktreePath: string, timeoutMs: number): boolean;
}>;

/**
 * `git status --porcelain=v2 -z` read into {@link StatusEntry}s: `1 XY …
 * <path>` (changed), `2 XY … <path>\0<orig>` (renamed or copied: the record's
 * next NUL field is the old path), `u XY … <path>` (unmerged: both sides),
 * `? <path>` (untracked); `#` headers and `!` (ignored) are not paths. An
 * `X` other than `.` is a staged change, a `Y` other than `.` an unstaged one.
 */
export function parseStatusV2(output: string): readonly StatusEntry[] {
  const fields = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]!;
    if (record.length === 0) continue;
    const kind = record[0];
    if (kind === "?") {
      entries.push(deepFreeze({ path: record.slice(2), staged: false, unstaged: false, untracked: true }));
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    // The path is everything after the fixed fields (it may hold spaces): 8 for `1`, 9 for `2`, 10 for `u`.
    const fixed = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    const parts = record.split(" ");
    const path = parts.slice(fixed).join(" ");
    const xy = parts[1] ?? "..";
    const from = kind === "2" ? fields[++index] : undefined;
    entries.push(deepFreeze({ path, staged: xy[0] !== ".", unstaged: xy[1] !== ".", untracked: false, ...(from === undefined ? {} : { from }) }));
  }
  return deepFreeze(entries);
}

export class WorktreeGitError extends HarnessError {
  constructor(operation: string, detail: string, result?: WorktreeGitExecResult) {
    super(
      `git ${operation} failed: ${detail}`,
      "worktree_git_failed",
      false,
      {
        operation,
        ...(result === undefined
          ? {}
          : {
              exitCode: result.status ?? -1,
              timedOut: result.timedOut,
              stderr: sanitizeErrorOutput(result.stderr),
            }),
      },
    );
  }
}

export class WorktreeGitTimeout extends HarnessError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `git ${operation} timed out after ${timeoutMs}ms`,
      "worktree_git_timeout",
      true,
      { operation, timeoutMs },
    );
  }
}

function sanitizeErrorOutput(text: string): string {
  return text.replaceAll(URL_USERINFO_PATTERN, "$1").slice(0, DEFAULT_MAXIMUM_ERROR_OUTPUT_CHARACTERS);
}

export function assertGitSha(value: string, field: string): void {  if (!GIT_OBJECT_NAME.test(value)) {
    throw new InputError(`git ${field} is not a full commit SHA`, "worktree_git_sha_invalid");
  }
}

export function assertAgentBranchName(branch: string, namespace: string): void {
  if (typeof namespace !== "string" || namespace.length === 0 || !namespace.endsWith("/")) {
    throw new InputError("branch namespace must be a non-empty prefix ending in '/'", "worktree_namespace_invalid");
  }
  if (!branch.startsWith(namespace) || branch.length === namespace.length) {
    throw new InputError(
      `branch "${branch}" is outside the "${namespace}" namespace`,
      "worktree_branch_namespace_denied",
    );
  }
  if (!BRANCH_NAME_PATTERN.test(branch) || branch.includes("..") || branch.includes("@{") ||
    branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock") ||
    branch.split("/").some((segment) => segment.length === 0 || segment.startsWith("-") || segment.startsWith("."))) {
    throw new InputError(`branch name "${branch}" is invalid`, "worktree_branch_invalid");
  }
}

export function parseWorktreeListPorcelain(text: string): readonly WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string | null;
    detached?: boolean;
    bare?: boolean;
    locked?: boolean;
    prunable?: boolean;
  } | null = null;
  const flush = (): void => {
    if (current === null) return;
    if (typeof current.path !== "string" || typeof current.head !== "string") {
      throw new InputError("git worktree list porcelain entry is incomplete", "worktree_list_parse_failed");
    }
    entries.push(deepFreeze({
      path: current.path,
      head: current.head,
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
    }));
    current = null;
  };
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
      continue;
    }
    if (current === null) {
      throw new InputError("git worktree list porcelain is malformed", "worktree_list_parse_failed");
    }
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim();
    else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
    else if (line.startsWith("locked")) current.locked = true;
    else if (line.startsWith("prunable")) current.prunable = true;
  }
  flush();
  return deepFreeze(entries);
}

export function createPinnedWorktreeGitExec(
  runtime: GitRuntime,
  ioLimits: Readonly<{ maxOutputBytes?: number; maxErrorBytes?: number; maxInputBytes?: number }> = {},
): WorktreeGitExec {
  return (request) => {
    const environment: Record<string, string> = {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
    };
    if (request.hooks === true) Object.assign(environment, projectEnvironment(process.env, HOOK_ENVIRONMENT), { LC_ALL: "C" });
    if (request.network === true) {
      // The user's own transport: their git configuration (a credential helper, a URL rewrite) and its channels.
      delete environment.GIT_CONFIG_NOSYSTEM;
      delete environment.GIT_CONFIG_GLOBAL;
      Object.assign(environment, projectEnvironment(process.env, GIT_NETWORK_ENVIRONMENT), {
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        [ROOT_POLICY.workflow.promotion.runEnvironmentVariable]: String(process.pid),
      });
    }
    if (request.identity !== undefined) {
      environment.GIT_AUTHOR_NAME = request.identity.name;
      environment.GIT_AUTHOR_EMAIL = request.identity.email;
      environment.GIT_COMMITTER_NAME = request.identity.name;
      environment.GIT_COMMITTER_EMAIL = request.identity.email;
      if (request.identity.date !== undefined) {
        environment.GIT_AUTHOR_DATE = request.identity.date;
        environment.GIT_COMMITTER_DATE = request.identity.date;
      }
    }
    const profile = compilePinnedProcessProfile({
      allowedSignals: ALLOWED_SIGNALS,
      allowedStatuses: [...request.allowedExitCodes],
      bindingTargets: [],
      environment,
      executableTargetDescriptor: GIT_EXECUTABLE_TARGET_DESCRIPTOR,
      maximumErrorBytes: ioLimits.maxErrorBytes ?? DEFAULT_MAXIMUM_ERROR_BYTES,
      maximumInputBytes: ioLimits.maxInputBytes ?? DEFAULT_MAXIMUM_INPUT_BYTES,
      maximumOutputBytes: ioLimits.maxOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES,
      timeoutMilliseconds: request.timeoutMs,
      workingDirectory: request.cwd,
    });
    const result = runPinnedProcess(profile, runtime.executable, {}, [...request.args], Buffer.alloc(0));
    return deepFreeze({
      status: result.status,
      signal: result.signal,
      timedOut: false,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    });
  };
}

/**
 * An exec that pins the git executable for the duration of EACH operation
 * (the same TOCTOU protection as a held runtime, scoped per call): for a
 * caller whose operations span awaits (a merge waits for its lock and its
 * gates), where one runtime held across the whole command would be closed
 * when its synchronous scope returned.
 */
export function createPerOperationPinnedWorktreeGitExec(gitPath: string, maximumBytes: number): WorktreeGitExec {
  return (request) => withGitRuntime(gitPath, maximumBytes, (runtime) => createPinnedWorktreeGitExec(runtime)(request));
}

/**
 * The repository's git as the configuration pins it — the ONE construction
 * every command door uses (`harness workspace`, `harness promote`, the
 * workspace signal): the configured executable
 * (`workspaceGit.gitExecutablePath`, else the one on PATH), pinned per
 * operation (a caller's operations span awaits), with the workspace branch
 * namespace when the document declares one.
 */
export function configuredWorktreeGitPort(document: Pick<ConfigDocument, "workspaceIsolation" | "workspaceGit">): WorktreeGitPort {
  const branchNamespace = document.workspaceIsolation?.branchNamespace;
  return createWorktreeGitPort({
    exec: createPerOperationPinnedWorktreeGitExec(resolveGitExecutable(document.workspaceGit?.gitExecutablePath), DEFAULT_GIT_RUNTIME_MAXIMUM_BYTES),
    ...(branchNamespace === undefined ? {} : { branchNamespace }),
  });
}

/**
 * The repository at `root` as the tree readers and writers ask it
 * (src/git/tree-reader.ts): the SAME configured executable as
 * {@link configuredWorktreeGitPort}, and the configured inspect ceiling
 * (`workspaceGit.timeouts.inspectMs`) on every call. A document that
 * declares neither (a test's `{}`) gets git from PATH and the default ceiling.
 */
export function configuredGitRepository(document: Pick<ConfigDocument, "workspaceGit">, root: string): GitRepository {
  return deepFreeze({
    root,
    executable: resolveGitExecutable(document.workspaceGit?.gitExecutablePath),
    timeoutMs: worktreeOperationTimeouts(document).inspectMs,
  });
}

export type WorktreeGitPortOptions = Readonly<{
  exec?: WorktreeGitExec;
  runtime?: GitRuntime;
  branchNamespace?: string;
}>;

const DEFAULT_BRANCH_NAMESPACE = "agent/" as const;

export function createWorktreeGitPort(options: WorktreeGitPortOptions): WorktreeGitPort {
  const execCandidate = options.exec ?? (options.runtime !== undefined ? createPinnedWorktreeGitExec(options.runtime) : undefined);
  if (execCandidate === undefined) {
    throw new InputError("worktree git port requires an exec or a pinned runtime", "worktree_exec_missing");
  }
  const exec: WorktreeGitExec = execCandidate;
  const branchNamespace = options.branchNamespace ?? DEFAULT_BRANCH_NAMESPACE;
  if (!branchNamespace.endsWith("/")) {
    throw new InputError("branch namespace must end in '/'", "worktree_namespace_invalid");
  }

  function run(operation: string, request: WorktreeGitExecRequest): WorktreeGitExecResult {
    for (const argument of request.args) {
      if (argument.includes("\0")) {
        throw new InputError(`git ${operation} argument contains NUL`, "worktree_argument_invalid");
      }
    }
    let result: WorktreeGitExecResult;
    try { result = exec(request); }
    catch (error) {
      if (error instanceof HarnessError && error.code === "pinned_process_timed_out") throw new WorktreeGitTimeout(operation, request.timeoutMs);
      throw error;
    }
    if (result.timedOut) {
      throw new WorktreeGitTimeout(operation, request.timeoutMs);
    }
    if (result.status === null || !request.allowedExitCodes.includes(result.status)) {
      throw new WorktreeGitError(
        operation,
        `unexpected exit status ${result.status === null ? "(signal)" : result.status}`,
        result,
      );
    }
    return result;
  }

  function assertAbsolutePath(path: string, field: string): void {
    if (!isAbsolute(path) || path.includes("\0") || path.includes("\n")) {
      throw new InputError(`git ${field} must be an absolute clean path`, "worktree_path_invalid");
    }
  }

  /** A ref of the harness's own (`refs/<namespace>/…`): never a branch, a tag or a remote-tracking ref (those move by their own doors). */
  function assertNamespacedRef(ref: string): void {
    assertNoOptionInjection(ref, "ref");
    if (!/^refs\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/u.test(ref) || /^refs\/(?:heads|tags|remotes)\//u.test(ref) || ref.includes("..")) {
      throw new InputError(`git ref ${ref} must be a namespaced harness ref (refs/<namespace>/..., not a branch, tag or remote-tracking ref)`, "worktree_argument_invalid");
    }
  }

  /** The folder of refs `prefix` lies in (`refs/a/b.c` → `refs/a/`): what `for-each-ref` lists, the prefix then matched exactly. */
  function refNamespaceOf(prefix: string): string {
    return prefix.slice(0, prefix.lastIndexOf("/") + 1);
  }

  function assertRemoteName(remote: string): void {
    if (!/^[A-Za-z0-9._-]+$/u.test(remote) || remote.startsWith("-")) {
      throw new InputError(`git remote ${remote} must be a configured remote's name`, "worktree_argument_invalid");
    }
  }

  /**
   * A refspec the port runs: `<source>:<destination>`, the destination a full
   * ref. A PUSH is never forced (no `+`); its source is a commit or object id,
   * a full ref, or nothing (a deletion). A FETCH writes only remote-tracking
   * refs or the harness's own namespaced refs (never a branch or a tag), and
   * may take a `+` (a remote-tracking ref mirrors the remote, rewound or not).
   */
  /** A push refspec (`<commit|ref|nothing>:<full ref>`, never forced), or a fetch refspec of `remote` (`<full ref>:` that remote's own tracking ref or a promotion ref — never a branch, a tag, `refs/stash` or notes). */
  function assertRefspec(refspec: string, kind: "push" | "fetch", remote: string): void {
    const forced = refspec.startsWith("+");
    const [source, destination, extra] = (forced ? refspec.slice(1) : refspec).split(":");
    const fullRef = /^refs\/[A-Za-z0-9._/-]+$/u;
    const fetchedInto = (ref: string): boolean => [`refs/remotes/${remote}/`, `${ROOT_POLICY.workflow.promotion.refNamespace}/`].some((prefix) => ref.startsWith(prefix) && ref.length > prefix.length);
    const valid = extra === undefined && source !== undefined && destination !== undefined && fullRef.test(destination) && !destination.includes("..") && (kind === "push"
      ? !forced && (source === "" || GIT_OBJECT_NAME.test(source) || (fullRef.test(source) && !source.includes("..")))
      : fullRef.test(source) && !source.includes("..") && fetchedInto(destination));
    if (!valid) {
      throw new InputError(`git ${kind} refspec ${refspec} is not one the harness runs (${kind === "push" ? "<commit|ref|nothing>:<full ref>, never forced" : `<full ref>:<a ref under refs/remotes/${remote}/ or the promotion namespace>`})`, "worktree_argument_invalid");
    }
  }

  function assertNoOptionInjection(value: string, field: string): void {
    if (value.startsWith("-")) {
      throw new InputError(`git ${field} must not start with '-'`, "worktree_argument_invalid");
    }
  }

  function statusImpl(cwd: string, timeoutMs: number): readonly StatusEntry[] {
    assertAbsolutePath(cwd, "cwd");
    // Every untracked FILE (`-uall`), never a collapsed directory: a caller
    // judges paths (a generated output created in a new directory is a file).
    const result = run("status --porcelain=v2", {
      args: ["-c", "gc.auto=0", "-C", cwd, "status", "--porcelain=v2", "-z", "--untracked-files=all"],
      cwd,
      timeoutMs,
      allowedExitCodes: [0],
    });
    return parseStatusV2(result.stdout);
  }

  function revParseImpl(repoRoot: string, ref: string, timeoutMs: number): string {
    assertAbsolutePath(repoRoot, "repoRoot");
    assertNoOptionInjection(ref, "ref");
    const result = run("rev-parse", {
      args: ["-c", "gc.auto=0", "-C", repoRoot, "rev-parse", "--verify", ref],
      cwd: repoRoot,
      timeoutMs,
      allowedExitCodes: [0],
    });
    const sha = result.stdout.trim().split("\n")[0] ?? "";
    assertGitSha(sha, "rev-parse result");
    return sha;
  }

  function textOf(operation: string, cwd: string, args: readonly string[], timeoutMs: number): string {
    return run(operation, { args: ["-c", "gc.auto=0", "-C", cwd, ...args], cwd, timeoutMs, allowedExitCodes: [0] }).stdout;
  }

  function nulRecords(text: string): readonly string[] {
    return text.split("\0").filter((entry) => entry.length > 0);
  }

  function assertPaths(paths: readonly string[], field: string): void {
    for (const path of paths) {
      if (path.length === 0 || path.includes("\n")) throw new InputError(`git ${field} must be non-empty clean paths`, "worktree_argument_invalid");
    }
  }

  /** A refusal git reports on stderr (exit 1 or 128) is data; the output is sanitized. */
  function refusable(operation: string, request: WorktreeGitExecRequest): RefusableOutcome {
    const result = run(operation, { ...request, allowedExitCodes: [0, 1, 128] });
    return deepFreeze({ refusal: result.status === 0 ? null : sanitizeErrorOutput(`${result.stderr}${result.stdout}`.trim()) });
  }

  return deepFreeze({
    schemaVersion: WORKTREE_PORT_SCHEMA_VERSION,

    worktreeAdd(request: WorktreeAddRequest): void {
      assertAbsolutePath(request.repoRoot, "repoRoot");
      assertAbsolutePath(request.worktreePath, "worktreePath");
      assertAgentBranchName(request.branch, branchNamespace);
      assertGitSha(request.baseSha, "baseSha");
      run("worktree add", {
        args: ["-c", "gc.auto=0", "-C", request.repoRoot, "worktree", "add", "-b", request.branch, "--", request.worktreePath, request.baseSha],
        cwd: request.repoRoot,
        timeoutMs: request.timeoutMs,
        allowedExitCodes: [0],
      });
    },

    worktreeRemove(request: WorktreeRemoveRequest): void {
      assertAbsolutePath(request.repoRoot, "repoRoot");
      assertAbsolutePath(request.worktreePath, "worktreePath");
      const args = ["-c", "gc.auto=0", "-C", request.repoRoot, "worktree", "remove"];
      if (request.force) args.push("--force");
      args.push("--", request.worktreePath);
      run("worktree remove", {
        args,
        cwd: request.repoRoot,
        timeoutMs: request.timeoutMs,
        allowedExitCodes: [0],
      });
    },

    worktreeList(repoRoot: string, timeoutMs: number): readonly WorktreeInfo[] {
      assertAbsolutePath(repoRoot, "repoRoot");
      const result = run("worktree list", {
        args: ["-c", "gc.auto=0", "-C", repoRoot, "worktree", "list", "--porcelain"],
        cwd: repoRoot,
        timeoutMs,
        allowedExitCodes: [0],
      });
      return parseWorktreeListPorcelain(result.stdout);
    },

    worktreeLock(request: WorktreeLockRequest): void {
      assertAbsolutePath(request.repoRoot, "repoRoot");
      assertAbsolutePath(request.worktreePath, "worktreePath");
      const args = ["-c", "gc.auto=0", "-C", request.repoRoot, "worktree", "lock"];
      if (request.reason !== undefined) {
        if (request.reason.includes("\0") || request.reason.includes("\n")) {
          throw new InputError("worktree lock reason must not contain control characters", "worktree_argument_invalid");
        }
        args.push("--reason", request.reason);
      }
      args.push("--", request.worktreePath);
      run("worktree lock", { args, cwd: request.repoRoot, timeoutMs: request.timeoutMs, allowedExitCodes: [0] });
    },

    worktreeUnlock(request: WorktreeLockRequest): void {
      assertAbsolutePath(request.repoRoot, "repoRoot");
      assertAbsolutePath(request.worktreePath, "worktreePath");
      run("worktree unlock", {
        args: ["-c", "gc.auto=0", "-C", request.repoRoot, "worktree", "unlock", "--", request.worktreePath],
        cwd: request.repoRoot,
        timeoutMs: request.timeoutMs,
        allowedExitCodes: [0],
      });
    },

    worktreePrune(repoRoot: string, timeoutMs: number): void {
      assertAbsolutePath(repoRoot, "repoRoot");
      run("worktree prune", {
        args: ["-c", "gc.auto=0", "-C", repoRoot, "worktree", "prune"],
        cwd: repoRoot,
        timeoutMs,
        allowedExitCodes: [0],
      });
    },

    diffNameOnly(request: DiffNameOnlyRequest): readonly string[] {
      assertAbsolutePath(request.cwd, "cwd");
      assertGitSha(request.refA, "refA");
      assertGitSha(request.refB, "refB");
      const range = request.threeDot ? `${request.refA}...${request.refB}` : `${request.refA}..${request.refB}`;
      const result = run("diff --name-only", {
        args: ["-c", "gc.auto=0", "-C", request.cwd, "diff", "--name-only", "-z", range],
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        allowedExitCodes: [0],
      });
      return deepFreeze(nulRecords(result.stdout).toSorted());
    },

    mergeBase(repoRoot: string, refA: string, refB: string, timeoutMs: number): string {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertGitSha(refA, "refA");
      assertNoOptionInjection(refB, "refB");
      const result = run("merge-base", {
        args: ["-c", "gc.auto=0", "-C", repoRoot, "merge-base", refA, refB],
        cwd: repoRoot,
        timeoutMs,
        allowedExitCodes: [0],
      });
      const sha = result.stdout.trim();
      assertGitSha(sha, "mergeBase");
      return sha;
    },

    worktreeAddDetached(request: WorktreeAddDetachedRequest): void {
      assertAbsolutePath(request.repoRoot, "repoRoot");
      assertAbsolutePath(request.worktreePath, "worktreePath");
      assertGitSha(request.commitSha, "commitSha");
      run("worktree add --detach", {
        args: ["-c", "gc.auto=0", "-C", request.repoRoot, "worktree", "add", "--detach", "--", request.worktreePath, request.commitSha],
        cwd: request.repoRoot,
        timeoutMs: request.timeoutMs,
        allowedExitCodes: [0],
      });
    },

    commonDir(cwd: string, timeoutMs: number): string {
      assertAbsolutePath(cwd, "cwd");
      return textOf("rev-parse --git-common-dir", cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], timeoutMs).trim();
    },

    toplevel(cwd: string, timeoutMs: number): string {
      assertAbsolutePath(cwd, "cwd");
      return textOf("rev-parse --show-toplevel", cwd, ["rev-parse", "--show-toplevel"], timeoutMs).trim();
    },

    symbolicBranch(cwd: string, timeoutMs: number): string | null {
      assertAbsolutePath(cwd, "cwd");
      const result = run("symbolic-ref", { args: ["-c", "gc.auto=0", "-C", cwd, "symbolic-ref", "-q", "--short", "HEAD"], cwd, timeoutMs, allowedExitCodes: [0, 1] });
      return result.status === 0 ? result.stdout.trim() : null;
    },

    diffNames(cwd: string, mode: "index-to-worktree" | "head-to-index" | "staged-deletions", timeoutMs: number): readonly string[] {
      assertAbsolutePath(cwd, "cwd");
      const args = mode === "index-to-worktree"
        ? ["diff", "--name-only", "--no-renames", "-z"]
        : ["diff", "--cached", "--name-only", "--no-renames", "-z", ...(mode === "staged-deletions" ? ["--diff-filter=D"] : [])];
      return deepFreeze(nulRecords(textOf(`diff ${mode}`, cwd, args, timeoutMs)).toSorted());
    },

    deletedBlobs(repoRoot: string, fromSha: string, toSha: string, timeoutMs: number): readonly DeletedBlobEntry[] {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertGitSha(fromSha, "fromSha");
      assertGitSha(toSha, "toSha");
      // `--raw --no-abbrev -z`: `:<srcmode> <dstmode> <srcsha> <dstsha> <status>` then one path.
      const fields = nulRecords(textOf("diff-tree --raw", repoRoot, ["diff-tree", "-r", "--raw", "--no-abbrev", "--no-renames", "--diff-filter=D", "-z", fromSha, toSha], timeoutMs));
      const entries: DeletedBlobEntry[] = [];
      for (let index = 0; index + 1 < fields.length; index += 2) {
        const blob = fields[index]!.replace(/^:/u, "").split(" ")[2] ?? "";
        if (GIT_OBJECT_NAME.test(blob)) entries.push(deepFreeze({ path: fields[index + 1]!, blob }));
      }
      return deepFreeze(entries);
    },

    isAncestor(repoRoot: string, ancestor: string, descendant: string, timeoutMs: number): boolean {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertGitSha(ancestor, "ancestor");
      assertGitSha(descendant, "descendant");
      return run("merge-base --is-ancestor", {
        args: ["-c", "gc.auto=0", "-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant],
        cwd: repoRoot, timeoutMs, allowedExitCodes: [0, 1],
      }).status === 0;
    },

    branchTip(repoRoot: string, branch: string, timeoutMs: number): string | null {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertAgentBranchName(branch, branchNamespace);
      const result = run("rev-parse --verify -q", {
        args: ["-c", "gc.auto=0", "-C", repoRoot, "rev-parse", "--verify", "-q", `refs/heads/${branch}`],
        cwd: repoRoot, timeoutMs, allowedExitCodes: [0, 1],
      });
      if (result.status !== 0) return null;
      const sha = result.stdout.trim();
      assertGitSha(sha, "branchTip");
      return sha;
    },

    checkoutDetached(cwd: string, sha: string, timeoutMs: number, discard = false): void {
      assertAbsolutePath(cwd, "cwd");
      assertGitSha(sha, "sha");
      run("checkout --detach", { args: ["-c", "gc.auto=0", "-C", cwd, "checkout", "-q", ...(discard ? ["-f"] : []), "--detach", sha], cwd, timeoutMs, allowedExitCodes: [0] });
    },

    checkoutBranch(cwd: string, branch: string, timeoutMs: number, discard = false): void {
      assertAbsolutePath(cwd, "cwd");
      assertAgentBranchName(branch, branchNamespace);
      run("checkout", { args: ["-c", "gc.auto=0", "-C", cwd, "checkout", "-q", ...(discard ? ["-f"] : []), branch, "--"], cwd, timeoutMs, allowedExitCodes: [0] });
    },

    mergeNoCommit(request: MergeNoCommitRequest): MergeNoCommitResult {
      assertAbsolutePath(request.cwd, "cwd");
      assertAgentBranchName(request.branch, branchNamespace);
      if (request.message.includes("\0")) throw new InputError("merge message must not contain NUL", "worktree_argument_invalid");
      // Exit 1 is git's "stopped with conflicts": the unmerged entries say which.
      const result = run("merge --no-commit", {
        // `--no-autostash`: a repository's `merge.autostash` must never stash
        // and re-apply around an integration (it leaves conflict markers).
        args: ["-c", "gc.auto=0", "-C", request.cwd, "merge", "--no-ff", "--no-commit", "--no-autostash", "-m", request.message, "--", request.branch],
        cwd: request.cwd, timeoutMs: request.timeoutMs, allowedExitCodes: [0, 1],
        ...(request.identity === undefined ? {} : { identity: request.identity }),
      });
      const conflictPaths = nulRecords(textOf("diff --diff-filter=U", request.cwd, ["diff", "--name-only", "--diff-filter=U", "-z"], request.timeoutMs)).toSorted();
      if (result.status === 1 && conflictPaths.length === 0) {
        throw new WorktreeGitError("merge --no-commit", "the merge stopped without conflicted paths", result);
      }
      return deepFreeze({ clean: conflictPaths.length === 0, conflictPaths: deepFreeze(conflictPaths) });
    },

    mergeAbort(cwd: string, timeoutMs: number): void {
      assertAbsolutePath(cwd, "cwd");
      run("merge --abort", { args: ["-c", "gc.auto=0", "-C", cwd, "merge", "--abort"], cwd, timeoutMs, allowedExitCodes: [0] });
    },

    mergeOursNoCommit(request: MergeOursRequest): void {
      assertAbsolutePath(request.cwd, "cwd");
      assertGitSha(request.commit, "commit");
      if (request.message.includes("\0")) throw new InputError("merge message must not contain NUL", "worktree_argument_invalid");
      run("merge -s ours --no-commit", {
        args: ["-c", "gc.auto=0", "-C", request.cwd, "merge", "-q", "-s", "ours", "--no-ff", "--no-commit", "--no-autostash", "-m", request.message, request.commit],
        cwd: request.cwd, timeoutMs: request.timeoutMs, allowedExitCodes: [0],
        ...(request.identity === undefined ? {} : { identity: request.identity }),
      });
    },

    readTreeReset(cwd: string, tree: string, timeoutMs: number): void {
      assertAbsolutePath(cwd, "cwd");
      assertGitSha(tree, "tree");
      run("read-tree -u --reset", { args: ["-c", "gc.auto=0", "-C", cwd, "read-tree", "-u", "--reset", tree], cwd, timeoutMs, allowedExitCodes: [0] });
    },

    stageAll(cwd: string, timeoutMs: number): string {
      assertAbsolutePath(cwd, "cwd");
      run("add -A", { args: ["-c", "gc.auto=0", "-C", cwd, "add", "-A"], cwd, timeoutMs, allowedExitCodes: [0] });
      const tree = textOf("write-tree", cwd, ["write-tree"], timeoutMs).trim();
      assertGitSha(tree, "write-tree");
      return tree;
    },

    createRef(repoRoot: string, ref: string, sha: string, timeoutMs: number): RefusableOutcome {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertNamespacedRef(ref);
      assertGitSha(sha, "sha");
      return refusable("update-ref (create)", { args: ["-c", "gc.auto=0", "-C", repoRoot, "update-ref", ref, sha, ""], cwd: repoRoot, timeoutMs, allowedExitCodes: [0] });
    },

    missingObjects(repoRoot: string, commit: string, exclude: string, timeoutMs: number): readonly string[] {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertGitSha(commit, "commit");
      assertGitSha(exclude, "exclude");
      const listed = textOf("rev-list --objects --missing=print", repoRoot, ["rev-list", "--objects", "--missing=print", commit, `^${exclude}`], timeoutMs);
      return deepFreeze(listed.split("\n").filter((line) => line.startsWith("?")).map((line) => line.slice(1).trim()));
    },

    deleteRef(repoRoot: string, ref: string, oldSha: string, timeoutMs: number): RefusableOutcome {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertNamespacedRef(ref);
      assertGitSha(oldSha, "oldSha");
      return refusable("update-ref -d", { args: ["-c", "gc.auto=0", "-C", repoRoot, "update-ref", "-d", ref, oldSha], cwd: repoRoot, timeoutMs, allowedExitCodes: [0] });
    },

    refsUnder(repoRoot: string, prefix: string, timeoutMs: number): ReadonlyMap<string, string> {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertNamespacedRef(`${prefix}x`);
      const refs = new Map<string, string>();
      // `<object> <ref>`, NUL-free names (git refuses them); the prefix is matched exactly, never as a pattern.
      for (const line of textOf("for-each-ref", repoRoot, ["for-each-ref", "--format=%(objectname) %(refname)", "--", refNamespaceOf(prefix)], timeoutMs).split("\n")) {
        const space = line.indexOf(" ");
        const ref = line.slice(space + 1);
        if (space > 0 && ref.startsWith(prefix) && GIT_OBJECT_NAME.test(line.slice(0, space))) refs.set(ref, line.slice(0, space));
      }
      return deepFreeze(refs);
    },

    blobAt(cwd: string, commit: string, path: string, timeoutMs: number): string | null {
      assertAbsolutePath(cwd, "cwd");
      assertGitSha(commit, "commit");
      assertPaths([path], "path");
      const result = run("cat-file <commit>:<path>", {
        args: ["-c", "gc.auto=0", "-C", cwd, "cat-file", "blob", `${commit}:${path}`],
        cwd, timeoutMs, allowedExitCodes: [0, 128],
      });
      return result.status === 0 ? result.stdout : null;
    },

    resolveToOurs(cwd: string, paths: readonly string[], timeoutMs: number): void {
      assertAbsolutePath(cwd, "cwd");
      assertPaths(paths, "paths");
      if (paths.length === 0) return;
      run("checkout --ours", { args: ["-c", "gc.auto=0", "-C", cwd, "checkout", "--ours", "--", ...paths], cwd, timeoutMs, allowedExitCodes: [0] });
      run("add", { args: ["-c", "gc.auto=0", "-C", cwd, "add", "--", ...paths], cwd, timeoutMs, allowedExitCodes: [0] });
    },

    addPaths(cwd: string, paths: readonly string[], timeoutMs: number): void {
      assertAbsolutePath(cwd, "cwd");
      assertPaths(paths, "paths");
      if (paths.length === 0) return;
      run("add", { args: ["-c", "gc.auto=0", "-C", cwd, "add", "-A", "--", ...paths], cwd, timeoutMs, allowedExitCodes: [0] });
    },

    commit(request: CommitRequest): CommitOutcome {
      assertAbsolutePath(request.cwd, "cwd");
      if (request.message.includes("\0")) throw new InputError("commit message must not contain NUL", "worktree_argument_invalid");
      const made = run("commit", {
        args: ["-c", "gc.auto=0", "-C", request.cwd, "commit", "-q", "-m", request.message],
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        allowedExitCodes: [0],
        hooks: true,
        ...(request.identity === undefined ? {} : { identity: request.identity }),
      });
      return deepFreeze({ commit: revParseImpl(request.cwd, "HEAD", request.timeoutMs), output: `${made.stderr}${made.stdout}`.trim() });
    },

    mergeFfOnly(cwd: string, sha: string, timeoutMs: number): RefusableOutcome {
      assertAbsolutePath(cwd, "cwd");
      assertGitSha(sha, "sha");
      // `--no-autostash`: with a repository's `merge.autostash` git would stash
      // the checkout's dirty overlap, land, and re-apply it as conflict
      // markers; without it git refuses and nothing moves (the land's promise).
      return refusable("merge --ff-only", { args: ["-c", "gc.auto=0", "-C", cwd, "merge", "-q", "--ff-only", "--no-autostash", sha], cwd, timeoutMs, allowedExitCodes: [0] });
    },

    fetchRefs(repoRoot: string, remote: string, refspecs: readonly string[], timeoutMs: number): RefusableOutcome {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertRemoteName(remote);
      for (const refspec of refspecs) assertRefspec(refspec, "fetch", remote);
      return refusable("fetch", {
        args: ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", repoRoot, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, ...refspecs],
        cwd: repoRoot, timeoutMs, allowedExitCodes: [0], network: true,
      });
    },

    lsRemote(repoRoot: string, remote: string, refs: readonly string[], timeoutMs: number): RemoteListing {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertRemoteName(remote);
      for (const ref of refs) assertNoOptionInjection(ref, "ref");
      const result = run("ls-remote", { args: ["-c", "gc.auto=0", "-C", repoRoot, "ls-remote", remote, ...refs], cwd: repoRoot, timeoutMs, allowedExitCodes: [0, 128], network: true });
      if (result.status !== 0) return deepFreeze({ refs: new Map(), refusal: sanitizeErrorOutput(`${result.stderr}${result.stdout}`.trim()) });
      const wanted = new Set(refs);
      const found = new Map<string, string>();
      for (const line of result.stdout.split("\n")) {
        const [sha, ref] = line.split("\t");
        // ls-remote matches patterns by their tail: only the exact refs asked for answer.
        if (sha !== undefined && ref !== undefined && wanted.has(ref) && GIT_OBJECT_NAME.test(sha)) found.set(ref, sha);
      }
      return deepFreeze({ refs: found, refusal: null });
    },

    pushAtomic(repoRoot: string, remote: string, refspecs: readonly string[], timeoutMs: number): PushOutcome {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertRemoteName(remote);
      if (refspecs.length === 0) throw new InputError("a push names at least one refspec", "worktree_argument_invalid");
      for (const refspec of refspecs) assertRefspec(refspec, "push", remote);
      const result = run("push --atomic", {
        args: ["-c", "gc.auto=0", "-C", repoRoot, "push", "--atomic", "--porcelain", remote, ...refspecs],
        cwd: repoRoot, timeoutMs, allowedExitCodes: [0, 1, 128], network: true,
      });
      return deepFreeze({ status: result.status!, refs: parsePushPorcelain(result.stdout), stderr: sanitizeErrorOutput(result.stderr.trim()) });
    },

    treeEntries(cwd: string, commit: string, paths: readonly string[], timeoutMs: number): ReadonlyMap<string, Readonly<{ mode: string; oid: string }>> {
      assertAbsolutePath(cwd, "cwd");
      assertGitSha(commit, "commit");
      assertPaths(paths, "paths");
      const entries = new Map<string, Readonly<{ mode: string; oid: string }>>();
      if (paths.length === 0) return deepFreeze(entries);
      // `<mode> <type> <oid>\t<path>`, NUL-terminated; `--full-tree`: the paths are repository-relative wherever `cwd` is.
      for (const record of nulRecords(textOf("ls-tree", cwd, ["ls-tree", "-z", "--full-tree", commit, "--", ...paths], timeoutMs))) {
        const tab = record.indexOf("\t");
        const [mode, , oid] = record.slice(0, tab).split(" ");
        if (mode !== undefined && oid !== undefined && GIT_OBJECT_NAME.test(oid)) entries.set(record.slice(tab + 1), deepFreeze({ mode, oid }));
      }
      return deepFreeze(entries);
    },

    hashObjects(cwd: string, paths: readonly string[], timeoutMs: number): readonly string[] {
      assertAbsolutePath(cwd, "cwd");
      assertPaths(paths, "paths");
      if (paths.length === 0) return deepFreeze([]);
      const ids = textOf("hash-object", cwd, ["hash-object", "--", ...paths], timeoutMs).split("\n").filter((line) => line.length > 0);
      for (const id of ids) assertGitSha(id, "hash-object");
      if (ids.length !== paths.length) throw new WorktreeGitError("hash-object", `answered ${String(ids.length)} ids for ${String(paths.length)} paths`);
      return deepFreeze(ids);
    },

    updateIndexEntries(cwd: string, entries: readonly IndexEntryUpdate[], timeoutMs: number): void {
      assertAbsolutePath(cwd, "cwd");
      assertPaths(entries.map((entry) => entry.path), "paths");
      const staged = entries.flatMap((entry) => ("remove" in entry ? [] : [entry]));
      const removed = entries.flatMap((entry) => ("remove" in entry ? [entry.path] : []));
      for (const entry of staged) {
        assertGitSha(entry.oid, "oid");
        if (!/^(?:100644|100755|120000)$/u.test(entry.mode)) throw new InputError(`index entry mode ${entry.mode} is not a file mode`, "worktree_argument_invalid");
        if (entry.path.includes(",")) throw new InputError(`index entry path ${entry.path} cannot be spelled to --cacheinfo`, "worktree_argument_invalid");
      }
      if (staged.length > 0) {
        run("update-index --cacheinfo", { args: ["-c", "gc.auto=0", "-C", cwd, "update-index", "--add", ...staged.flatMap((entry) => ["--cacheinfo", `${entry.mode},${entry.oid},${entry.path}`])], cwd, timeoutMs, allowedExitCodes: [0] });
      }
      if (removed.length > 0) {
        run("update-index --force-remove", { args: ["-c", "gc.auto=0", "-C", cwd, "update-index", "--force-remove", "--", ...removed], cwd, timeoutMs, allowedExitCodes: [0] });
      }
    },

    updateRef(repoRoot: string, ref: string, newSha: string, oldSha: string, timeoutMs: number): RefusableOutcome {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertNoOptionInjection(ref, "ref");
      if (!ref.startsWith("refs/heads/")) throw new InputError("update-ref moves a branch (refs/heads/...) only", "worktree_argument_invalid");
      assertGitSha(newSha, "newSha");
      assertGitSha(oldSha, "oldSha");
      return refusable("update-ref", { args: ["-c", "gc.auto=0", "-C", repoRoot, "update-ref", ref, newSha, oldSha], cwd: repoRoot, timeoutMs, allowedExitCodes: [0] });
    },

    readTree(repoRoot: string, sha: string, timeoutMs: number): void {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertGitSha(sha, "sha");
      run("read-tree", { args: ["-c", "gc.auto=0", "-C", repoRoot, "read-tree", sha], cwd: repoRoot, timeoutMs, allowedExitCodes: [0] });
    },

    readTreeSwitch(repoRoot: string, fromSha: string, toSha: string, timeoutMs: number): void {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertGitSha(fromSha, "fromSha");
      assertGitSha(toSha, "toSha");
      run("read-tree -m -u", { args: ["-c", "gc.auto=0", "-C", repoRoot, "read-tree", "-m", "-u", fromSha, toSha], cwd: repoRoot, timeoutMs, allowedExitCodes: [0] });
    },

    refreshIndex(repoRoot: string, timeoutMs: number): void {
      assertAbsolutePath(repoRoot, "repoRoot");
      // Exit 1 means an entry still differs from its file: that is its answer.
      run("update-index --refresh", { args: ["-c", "gc.auto=0", "-C", repoRoot, "update-index", "-q", "--refresh"], cwd: repoRoot, timeoutMs, allowedExitCodes: [0, 1] });
    },

    lsFilesStage(cwd: string, timeoutMs: number): string {
      assertAbsolutePath(cwd, "cwd");
      return textOf("ls-files --stage", cwd, ["ls-files", "--stage", "-z"], timeoutMs);
    },

    revParse(repoRoot: string, ref: string, timeoutMs: number): string {
      return revParseImpl(repoRoot, ref, timeoutMs);
    },

    revListCount(cwd: string, refA: string, refB: string, timeoutMs: number): number {
      assertAbsolutePath(cwd, "cwd");
      assertGitSha(refA, "refA");
      assertGitSha(refB, "refB");
      const result = run("rev-list --count", {
        args: ["-c", "gc.auto=0", "-C", cwd, "rev-list", "--count", `${refA}..${refB}`],
        cwd,
        timeoutMs,
        allowedExitCodes: [0],
      });
      const count = Number.parseInt(result.stdout.trim(), 10);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new InputError("git rev-list --count output is not a non-negative integer", "worktree_rev_list_parse_failed");
      }
      return count;
    },

    status(cwd: string, timeoutMs: number): readonly StatusEntry[] {
      return statusImpl(cwd, timeoutMs);
    },

    deleteBranch(repoRoot: string, branch: string, force: boolean, timeoutMs: number): void {
      assertAbsolutePath(repoRoot, "repoRoot");
      assertAgentBranchName(branch, branchNamespace);
      run("branch delete", {
        args: ["-c", "gc.auto=0", "-C", repoRoot, "branch", force ? "-D" : "-d", "--", branch],
        cwd: repoRoot,
        timeoutMs,
        allowedExitCodes: [0],
      });
    },

    verifyWorktreeIntact(worktreePath: string, timeoutMs: number): boolean {
      assertAbsolutePath(worktreePath, "worktreePath");
      if (!existsSync(`${worktreePath}/.git`)) return false;
      try {
        run("rev-parse --git-dir", {
          args: ["-c", "gc.auto=0", "-C", worktreePath, "rev-parse", "--git-dir"],
          cwd: worktreePath,
          timeoutMs,
          allowedExitCodes: [0],
        });
        return true;
      } catch (error) {
        if (error instanceof WorktreeGitError || error instanceof WorktreeGitTimeout) return false;
        throw error;
      }
    },
  });
}

export { withGitRuntime, type GitRuntime };
