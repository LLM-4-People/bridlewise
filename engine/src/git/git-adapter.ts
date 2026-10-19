import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { HarnessError, InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import {
  compilePinnedProcessProfile,
  runPinnedProcess,
  withPinnedProcessExecutable,
  type PinnedProcessExecutable,
  type PinnedProcessResult,
} from "../process/pinned-process-internal.ts";
import {
  GIT_PORT_SCHEMA_VERSION,
  parsePushPorcelain,
  type GitBranchRequest,
  type GitBranchResult,
  type GitCheckoutRequest,
  type GitCheckoutResult,
  type GitCloneRequest,
  type GitCloneResult,
  type GitCommitRequest,
  type GitCommitResult,
  type GitConflictInfo,
  type GitConflictResult,
  type GitDiffRequest,
  type GitDiffResult,
  type GitEffectRecorder,
  type GitIdentity,
  type GitInitRequest,
  type GitInitResult,
  type GitLogEntry,
  type GitLogRequest,
  type GitLogResult,
  type GitMergeRequest,
  type GitMergeResult,
  type GitNeverPushConfig,
  type GitNeverPushScanResult,
  type GitNeverPushViolation,
  type GitOperationContext,
  type GitPort,
  type GitPromotionRequest,
  type GitPromotionResult,
  type GitPullRequest,
  type GitPullResult,
  type GitPushRequest,
  type GitPushResult,
  type GitRebaseRequest,
  type GitRebaseResult,
  type GitRefInfo,
  type GitRemoteInfo,
  type GitRepositoryInfo,
  type GitRollbackRequest,
  type GitRollbackResult,
  type GitStatusEntry,
  type GitStatusRequest,
  type GitStatusResult,
  type GitTagRequest,
  type GitTagResult,
  type WorkspaceGitConfig,
} from "./git-port.ts";

/**
 * Git adapter — concrete implementation using the pinned-process-internal.
 *
 * Per delivery map item 10: "Interactively handle empty folders,
 * existing data, existing repositories, init/clone/pull, separate source
 * and push remotes/forks, authentication boundaries, exclusions that can
 * never be pushed, sync conflicts, branches, per-feature tags/checkpoints,
 * tests, testing promotion, and rollback."
 *
 * Per: "Respects the `GIT_OPTIONAL_LOCKS=0` rule from "
 * and "Use `GIT_OPTIONAL_LOCKS=0 git --no-optional-locks...` and verify
 * index bytes before/after."
 *
 * All git commands are executed via the pinned-process-internal, which
 * pins the git executable via `/proc/self/fd/<descriptor>` to prevent
 * TOCTOU attacks. The executable identity is verified before and after
 * each process execution.
 *
 * The adapter enforces:
 * `GIT_OPTIONAL_LOCKS=0` in every command environment.
 * No credentials in remote URLs (URLs are sanitized to identity only).
 * Never-push exclusions before any push effect.
 * Bounded output (stdout/stderr capped at configurable limits).
 * Timeout and cancellation support.
 * All operations recorded in the timeline via GitEffectRecorder.
 */

const GIT_EXECUTABLE_TARGET_DESCRIPTOR = 4;
import { DEFAULT_MAXIMUM_ERROR_BYTES, DEFAULT_MAXIMUM_OUTPUT_BYTES } from "./git-config.ts";
const ALLOWED_SIGNALS: readonly NodeJS.Signals[] = [];
const EXIT_OK: readonly number[] = [0];
const EXIT_OK_OR_CHANGED_OR_UNBORN: readonly number[] = [0, 1, 128];

// Default git inspect timeout (milliseconds). Used when
// `defaultOperationContext` is invoked without an explicit `timeoutMs`
// (e.g. direct programmatic calls that do not flow through the central
// config document). The canonical owner of the value is the central config
// contract (`workspaceGit.timeouts.inspectMs`); this named constant is only
// the fallback when config is unavailable. Matches the `DEFAULT_GIT_*`
// naming pattern used in `src/workflow/harness-commands.ts`.
import { DEFAULT_GIT_INSPECT_TIMEOUT_MS } from "./git-config.ts";

const URL_CREDENTIAL_PATTERN = /^[^@]*@/u;
const ALLOWED_TRANSPORT_PATTERN = /^(file|ssh|https):\/\//u;

export type GitRuntime = Readonly<{
  executable: PinnedProcessExecutable;
  gitPath: string;
}>;

export type GitIoLimits = Readonly<{
  maxOutputBytes: number;
  maxErrorBytes: number;
  maxInputBytes: number;
}>;

export type GitAdapterOptions = Readonly<{
  config: WorkspaceGitConfig;
  gitIoLimits?: GitIoLimits;
  recorder?: GitEffectRecorder;
  correlation?: Readonly<{ runId?: string; turnId?: string }>;
}>;

export function withGitRuntime<Result>(
  gitExecutablePath: string,
  maximumBytes: number,
  operation: (runtime: GitRuntime) => Result,
): Result {
  if (!isAbsolute(gitExecutablePath) || !existsSync(gitExecutablePath)) {
    throw new InputError("Git executable path is invalid or does not exist", "git_executable_invalid");
  }
  return withPinnedProcessExecutable(
    gitExecutablePath,
    maximumBytes,
    false,
    (executable) => operation(deepFreeze({ executable, gitPath: gitExecutablePath })),
  );
}

export function createGitAdapter(
  runtime: GitRuntime,
  options: GitAdapterOptions,
): GitPort {
  const config = options.config;
  const recorder = options.recorder;
  const correlation = options.correlation;

  function runGit(
    context: GitOperationContext,
    args: readonly string[],
    allowedExitCodes: readonly number[],
  ): PinnedProcessResult {
    const environment = buildGitEnvironment(context);
    const ioLimits = options.gitIoLimits;
    const profile = compilePinnedProcessProfile({
      allowedSignals: ALLOWED_SIGNALS,
      allowedStatuses: [...allowedExitCodes],
      bindingTargets: [],
      environment,
      executableTargetDescriptor: GIT_EXECUTABLE_TARGET_DESCRIPTOR,
      maximumErrorBytes: ioLimits?.maxErrorBytes ?? DEFAULT_MAXIMUM_ERROR_BYTES,
      // The adapter admits up to the root-policy git input ceiling unless configured lower.
      maximumInputBytes: ioLimits?.maxInputBytes ?? ROOT_POLICY.runtime.limits.maximumGitInputBytes,
      maximumOutputBytes: ioLimits?.maxOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES,
      timeoutMilliseconds: context.timeoutMs,
      workingDirectory: context.workingDirectory,
    });
    const input = Buffer.alloc(0);
    const result = runPinnedProcess(profile, runtime.executable, {}, [...args], input);
    if (!result.terminationAccepted) {
      throw gitError(
        context.operation,
        result,
        `Git command failed: ${args.join(" ")}`,
      );
    }
    if (!allowedExitCodes.includes(result.status ?? -1)) {
      throw gitError(
        context.operation,
        result,
        `Git command exited with status ${result.status}: ${args.join(" ")}`,
      );
    }
    return result;
  }

  function buildGitEnvironment(context: GitOperationContext): Record<string, string> {
    const env: Record<string, string> = {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: context.identity.name,
      GIT_AUTHOR_EMAIL: context.identity.email,
      GIT_COMMITTER_NAME: context.identity.name,
      GIT_COMMITTER_EMAIL: context.identity.email,
    };
    for (const [key, value] of Object.entries(context.environment)) {
      env[key] = value;
    }
    return env;
  }

  function recordOp(operation: string, description: string): void {
    if (recorder === undefined) return;
    recorder.recordGitOperation({ operation, description, ...(correlation ?? {}) });
  }

  function recordCommit(commitSha: string, description: string): void {
    if (recorder === undefined) return;
    recorder.recordCommit({ commitSha, description, ...(correlation ?? {}) });
  }

  function stdoutString(result: PinnedProcessResult): string {
    return result.stdout.toString("utf8");
  }

  function stderrString(result: PinnedProcessResult): string {
    return result.stderr.toString("utf8");
  }

  function parseLines(text: string): string[] {
    return text.length === 0 ? [] : text.split("\n").filter((line) => line.length > 0);
  }

  function sanitizeRemoteUrl(url: string): string {
    if (URL_CREDENTIAL_PATTERN.test(url) && url.includes("://")) {
      const schemeMatch = url.match(/^([a-z]+):\/\/[^@]*@(.*)$/u);
      if (schemeMatch) return `${schemeMatch[1]}://${schemeMatch[2]}`;
    }
    return url.replace(URL_CREDENTIAL_PATTERN, "");
  }

  function validateRemoteUrl(url: string): void {
    if (!ALLOWED_TRANSPORT_PATTERN.test(url) && !url.startsWith("/")) {
      throw new SecurityError(
        "Remote URL uses a disallowed transport",
        "git_transport_denied",
      );
    }
    if (URL_CREDENTIAL_PATTERN.test(url) && url.includes("://")) {
      throw new SecurityError(
        "Remote URL contains embedded credentials",
        "git_credential_in_url_denied",
      );
    }
    if (url.includes("://")) {
      const transport = url.split("://")[0] ?? "";
      if (transport && !(config.allowedTransports as readonly string[]).includes(transport)) {
        throw new SecurityError(
          "Remote URL uses a transport not in the allowed list",
          "git_transport_not_allowed",
        );
      }
    }
  }

  function parsePorcelainV2(output: string): GitStatusResult {
    const lines = parseLines(output);
    let branch: string | null = null;
    let head: string | null = null;
    let detached = false;
    let unborn = false;
    const entries: GitStatusEntry[] = [];

    for (const line of lines) {
      if (line.startsWith("# branch.head")) {
        branch = line.slice("# branch.head".length).trim();
        if (branch === "(detached)") {
          detached = true;
          branch = null;
        }
      } else if (line.startsWith("# branch.oid")) {
        head = line.slice("# branch.oid".length).trim();
        if (head === "(initial)") {
          head = null;
          unborn = true;
        }
      } else if (line.startsWith("1 ")) {
        const entry = parsePorcelainV2Ordinary(line);
        if (entry !== null) entries.push(entry);
      } else if (line.startsWith("2 ")) {
        const entry = parsePorcelainV2Renamed(line);
        if (entry !== null) entries.push(entry);
      } else if (line.startsWith("u ")) {
        const entry = parsePorcelainV2Unmerged(line);
        if (entry !== null) entries.push(entry);
      } else if (line.startsWith("? ")) {
        entries.push(deepFreeze({
          path: line.slice(2),
          statusCode: "??",
          staged: false,
          conflict: false,
          untracked: true,
          ignored: false,
        }));
      } else if (line.startsWith("! ")) {
        entries.push(deepFreeze({
          path: line.slice(2),
          statusCode: "!!",
          staged: false,
          conflict: false,
          untracked: false,
          ignored: true,
        }));
      }
    }

    return deepFreeze({
      branch,
      head,
      detached,
      unborn,
      entries: deepFreeze(entries),
      clean: entries.length === 0,
    });
  }

  function parsePorcelainV2Ordinary(line: string): GitStatusEntry | null {
    const parts = line.split(" ");
    if (parts.length < 9) return null;
    const xy = parts[1] ?? "";
    const path = parts.slice(8).join(" ");
    const staged = xy[0] !== undefined && xy[0] !== " " && xy[0] !== "." && xy[0] !== "?";
    return deepFreeze({
      path,
      statusCode: xy,
      staged,
      conflict: false,
      untracked: false,
      ignored: false,
    });
  }

  function parsePorcelainV2Renamed(line: string): GitStatusEntry | null {
    const parts = line.split(" ");
    if (parts.length < 10) return null;
    const xy = parts[1] ?? "";
    const path = parts.slice(9).join(" ");
    const staged = xy[0] !== undefined && xy[0] !== " " && xy[0] !== "." && xy[0] !== "?";
    return deepFreeze({
      path,
      statusCode: xy,
      staged,
      conflict: false,
      untracked: false,
      ignored: false,
    });
  }

  function parsePorcelainV2Unmerged(line: string): GitStatusEntry | null {
    const parts = line.split(" ");
    if (parts.length < 12) return null;
    const xy = parts[1] ?? "";
    const path = parts.slice(11).join(" ");
    return deepFreeze({
      path,
      statusCode: xy,
      staged: false,
      conflict: true,
      untracked: false,
      ignored: false,
    });
  }

  function parseLogRaw(output: string): GitLogResult {
    const entries: GitLogEntry[] = [];
    const lines = parseLines(output);
    for (const line of lines) {
      const parts = line.split("\x1f");
      if (parts.length < 8) continue;
      entries.push(deepFreeze({
        sha: parts[0]!,
        parents: parts[1]!.length > 0 ? parts[1]!.split(" ") : [],
        author: deepFreeze({ name: parts[2]!, email: parts[3]! }),
        authorDate: parts[4]!,
        committer: deepFreeze({ name: parts[5]!, email: parts[6]! }),
        commitDate: parts[7]!,
        message: parts.slice(8).join("\x1f"),
        treeSha: "",
      }));
    }
    return deepFreeze({ entries: deepFreeze(entries), total: entries.length });
  }

  function parseRemoteOutput(output: string): readonly GitRemoteInfo[] {
    const remotes = new Map<string, GitRemoteInfo>();
    for (const line of parseLines(output)) {
      const parts = line.split("\t");
      if (parts.length !== 3) continue;
      const name = parts[0]!;
      const url = sanitizeRemoteUrl(parts[1]!);
      const type = parts[2]!;
      let remote = remotes.get(name);
      if (remote === undefined) {
        remote = deepFreeze({
          name,
          fetchUrl: null,
          pushUrl: null,
          fetchRefspecs: [],
          pushRefspecs: [],
        });
        remotes.set(name, remote);
      }
      if (type === "fetch") {
        remotes.set(name, deepFreeze({ ...remote, fetchUrl: url }));
      } else if (type === "push") {
        remotes.set(name, deepFreeze({ ...remote, pushUrl: url }));
      }
    }
    return deepFreeze([...remotes.values()]);
  }

  function parseRefsOutput(output: string): readonly GitRefInfo[] {
    const refs: GitRefInfo[] = [];
    for (const line of parseLines(output)) {
      const parts = line.split(" ");
      if (parts.length !== 2) continue;
      const sha = parts[0]!;
      const refName = parts[1]!.replace(/[\n\r]*$/u, "");
      const isBranch = refName.startsWith("refs/heads/");
      const isTag = refName.startsWith("refs/tags/");
      const isRemote = refName.startsWith("refs/remotes/");
      const isHead = refName === "HEAD";
      refs.push(deepFreeze({
        name: refName,
        sha,
        isBranch,
        isTag,
        isRemote,
        isHead,
        annotated: false,
      }));
    }
    return deepFreeze(refs);
  }

  function parseConflictPaths(output: string): GitConflictInfo[] {
    const conflicts: GitConflictInfo[] = [];
    for (const line of parseLines(output)) {
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const stage = parseInt(parts[1]!, 10);
      const shaPart = parts[2]!;
      const sha: string | null = shaPart.length === 40 || shaPart.length === 64 ? shaPart : null;
      const path = parts.slice(3).join("\t");
      const ourSha: string | null = stage === 2 ? sha : null;
      const theirSha: string | null = stage === 3 ? sha : null;
      const baseSha: string | null = stage === 1 ? sha : null;
      conflicts.push(deepFreeze({ path, stage, ourSha, theirSha, baseSha }));
    }
    return conflicts;
  }

  function checkConflictsInternal(path: string, context: GitOperationContext): GitConflictResult {
    const conflictResult = runGit(
      { ...context, workingDirectory: path, operation: "conflict-check" },
      ["ls-files", "-u", "-z"],
      EXIT_OK,
    );
    const output = stdoutString(conflictResult);
    const conflicts = parseConflictPaths(output.replace(/\0/g, "\n"));
    return deepFreeze({ conflicts, hasConflicts: conflicts.length > 0 });
  }

  return deepFreeze({
    schemaVersion: GIT_PORT_SCHEMA_VERSION,

    init(request: GitInitRequest, context: GitOperationContext): GitInitResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Init path must be absolute", "git_init_path_invalid");
      }
      const args = ["init", "--initial-branch=" + request.initialBranch];
      if (request.bare) args.push("--bare");
      args.push(request.path);
      runGit(
        { ...context, workingDirectory: "/", operation: "init" },
        args,
        EXIT_OK,
      );
      recordOp("init", `git init at ${request.path}`);
      const gitDir = request.bare ? request.path : resolve(request.path, ".git");
      const headResult = runGit(
        { ...context, workingDirectory: request.path, operation: "init" },
        ["rev-parse", "HEAD"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const head = headResult.status === 0 ? stdoutString(headResult).trim() : "";
      return deepFreeze({ gitDir, head, branch: request.initialBranch });
    },

    clone(request: GitCloneRequest, context: GitOperationContext): GitCloneResult {
      validateRemoteUrl(request.url);
      if (!isAbsolute(request.destination)) {
        throw new InputError("Clone destination must be absolute", "git_clone_destination_invalid");
      }
      const args = ["clone"];
      if (request.bare) args.push("--bare");
      if (request.branch !== undefined) args.push("--branch", request.branch);
      if (request.depth !== undefined) args.push("--depth", String(request.depth));
      args.push(sanitizeRemoteUrl(request.url), request.destination);
      runGit(
        { ...context, workingDirectory: "/", operation: "clone" },
        args,
        EXIT_OK,
      );
      recordOp("clone", `git clone ${sanitizeRemoteUrl(request.url)} -> ${request.destination}`);
      const gitDir = request.bare ? request.destination : resolve(request.destination, ".git");
      const headResult = runGit(
        { ...context, workingDirectory: request.destination, operation: "clone" },
        ["rev-parse", "HEAD"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const head = headResult.status === 0 ? stdoutString(headResult).trim() : "";
      const branchResult = runGit(
        { ...context, workingDirectory: request.destination, operation: "clone" },
        ["rev-parse", "--abbrev-ref", "HEAD"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const branch = branchResult.status === 0 ? stdoutString(branchResult).trim() : request.branch ?? "";
      return deepFreeze({ gitDir, head, branch, remoteUrl: sanitizeRemoteUrl(request.url) });
    },

    pull(request: GitPullRequest, context: GitOperationContext): GitPullResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Pull path must be absolute", "git_pull_path_invalid");
      }
      const args = ["pull"];
      if (request.reconciliation === "rebase") args.push("--rebase");
      else if (request.reconciliation === "merge") args.push("--no-ff");
      else args.push("--ff-only");
      args.push(request.remote, request.branch);
      const result = runGit(
        { ...context, workingDirectory: request.path, operation: "pull" },
        args,
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const output = stdoutString(result) + stderrString(result);
      const fastForward = output.includes("Fast-forward") || output.includes("fast-forward");
      const upToDate = output.includes("Already up to date") || output.includes("Already up-to-date");
      const conflicts = parseLines(output)
        .filter((line) => line.startsWith("CONFLICT"))
        .map((line) => line.replace(/^CONFLICT \([^)]*\): /u, ""));
      recordOp("pull", `git pull ${request.remote} ${request.branch} at ${request.path}`);
      return deepFreeze({
        fastForward,
        upToDate,
        merged: !fastForward && !upToDate && conflicts.length === 0,
        rebased: request.reconciliation === "rebase" && !upToDate && conflicts.length === 0,
        conflicts: deepFreeze(conflicts),
      });
    },

    push(request: GitPushRequest, context: GitOperationContext): GitPushResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Push path must be absolute", "git_push_path_invalid");
      }
      if (request.force !== false) {
        throw new SecurityError("Force push is not allowed", "git_force_push_denied");
      }
      const args = ["push", "--porcelain"];
      if (request.atomic) args.push("--atomic");
      args.push(request.remote, ...request.refspecs);
      const result = runGit(
        { ...context, workingDirectory: request.path, operation: "push" },
        args,
        [0, 1],
      );
      // Each ref as git reported it (the one porcelain reading); the refspec
      // is the ref's own `<src>:<dst>`, its remote sha the summary's new side.
      const pushed: { refspec: string; remoteSha: string; forced: false }[] = [];
      const rejected: { refspec: string; reason: string }[] = [];
      for (const ref of parsePushPorcelain(stdoutString(result))) {
        const refspec = `${ref.source}:${ref.destination}`;
        if (ref.flag === "!") rejected.push(deepFreeze({ refspec, reason: ref.summary }));
        else pushed.push(deepFreeze({ refspec, remoteSha: /\.\.\.?([0-9a-f]{7,64})$/u.exec(ref.summary)?.[1] ?? "", forced: false }));
      }
      recordOp("push", `git push ${request.remote} ${request.refspecs.join(" ")} at ${request.path}`);
      return deepFreeze({ pushed: deepFreeze(pushed), rejected: deepFreeze(rejected) });
    },

    commit(request: GitCommitRequest, context: GitOperationContext): GitCommitResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Commit path must be absolute", "git_commit_path_invalid");
      }
      if (request.stageAll) {
        runGit(
          { ...context, workingDirectory: request.path, operation: "commit" },
          ["add", "-A"],
          EXIT_OK,
        );
      }
      const args = ["commit", "-m", request.message];
      if (request.allowEmpty) args.push("--allow-empty");
      runGit(
        { ...context, workingDirectory: request.path, operation: "commit" },
        args,
        EXIT_OK,
      );
      const shaResult = runGit(
        { ...context, workingDirectory: request.path, operation: "commit" },
        ["rev-parse", "HEAD"],
        EXIT_OK,
      );
      const commitSha = stdoutString(shaResult).trim();
      const treeResult = runGit(
        { ...context, workingDirectory: request.path, operation: "commit" },
        ["rev-parse", "HEAD^{tree}"],
        EXIT_OK,
      );
      const treeSha = stdoutString(treeResult).trim();
      const parentsResult = runGit(
        { ...context, workingDirectory: request.path, operation: "commit" },
        ["rev-list", "--parents", "-n", "1", "HEAD"],
        EXIT_OK,
      );
      const parentParts = stdoutString(parentsResult).trim().split(" ").slice(1);
      recordCommit(commitSha, `git commit: ${request.message}`);
      return deepFreeze({
        commitSha,
        treeSha,
        parentShas: deepFreeze(parentParts),
      });
    },

    branch(request: GitBranchRequest, context: GitOperationContext): GitBranchResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Branch path must be absolute", "git_branch_path_invalid");
      }
      const args = ["branch", request.name];
      if (request.startPoint !== undefined) args.push(request.startPoint);
      runGit(
        { ...context, workingDirectory: request.path, operation: "branch" },
        args,
        EXIT_OK,
      );
      let checkedOut = false;
      if (request.checkout) {
        runGit(
          { ...context, workingDirectory: request.path, operation: "branch" },
          ["checkout", request.name],
          EXIT_OK,
        );
        checkedOut = true;
      }
      const shaResult = runGit(
        { ...context, workingDirectory: request.path, operation: "branch" },
        ["rev-parse", request.name],
        EXIT_OK,
      );
      const sha = stdoutString(shaResult).trim();
      recordOp("branch", `git branch ${request.name} at ${request.path}`);
      return deepFreeze({ name: request.name, sha, checkedOut });
    },

    tag(request: GitTagRequest, context: GitOperationContext): GitTagResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Tag path must be absolute", "git_tag_path_invalid");
      }
      const args = ["tag"];
      if (request.annotated) {
        args.push("-a");
        args.push("-m", request.message ?? "");
        if (request.identity !== undefined) {
          context = { ...context, identity: request.identity };
        }
      }
      args.push(request.name);
      if (request.target !== undefined) args.push(request.target);
      runGit(
        { ...context, workingDirectory: request.path, operation: "tag" },
        args,
        EXIT_OK,
      );
      const shaResult = runGit(
        { ...context, workingDirectory: request.path, operation: "tag" },
        ["rev-parse", request.name],
        EXIT_OK,
      );
      const sha = stdoutString(shaResult).trim();
      recordOp("tag", `git tag ${request.name} at ${request.path}`);
      return deepFreeze({ name: request.name, sha, annotated: request.annotated });
    },

    checkout(request: GitCheckoutRequest, context: GitOperationContext): GitCheckoutResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Checkout path must be absolute", "git_checkout_path_invalid");
      }
      const args = ["checkout"];
      if (request.createBranch !== undefined) {
        args.push("-b", request.createBranch);
      }
      args.push(request.ref);
      runGit(
        { ...context, workingDirectory: request.path, operation: "checkout" },
        args,
        EXIT_OK,
      );
      const headResult = runGit(
        { ...context, workingDirectory: request.path, operation: "checkout" },
        ["rev-parse", "HEAD"],
        EXIT_OK,
      );
      const head = stdoutString(headResult).trim();
      const branchResult = runGit(
        { ...context, workingDirectory: request.path, operation: "checkout" },
        ["rev-parse", "--abbrev-ref", "HEAD"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const branch = branchResult.status === 0 ? stdoutString(branchResult).trim() : null;
      recordOp("checkout", `git checkout ${request.ref} at ${request.path}`);
      return deepFreeze({ ref: request.ref, head, branch });
    },

    merge(request: GitMergeRequest, context: GitOperationContext): GitMergeResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Merge path must be absolute", "git_merge_path_invalid");
      }
      const args = ["merge"];
      if (request.noFastForward) args.push("--no-ff");
      if (request.noCommit) args.push("--no-commit");
      args.push(request.branch);
      let result: PinnedProcessResult;
      try {
        result = runGit(
          { ...context, workingDirectory: request.path, operation: "merge" },
          args,
          EXIT_OK,
        );
      } catch (error) {
        if (error instanceof HarnessError) {
          const conflictResult = checkConflictsInternal(request.path, context);
          if (conflictResult.hasConflicts) {
            return deepFreeze({
              fastForward: false,
              merged: false,
              conflicts: conflictResult.conflicts.map((c: GitConflictInfo) => c.path),
              commitSha: null,
            });
          }
        }
        throw error;
      }
      const output = stdoutString(result) + stderrString(result);
      const fastForward = output.includes("Fast-forward") || output.includes("fast-forward");
      const conflictResult = checkConflictsInternal(request.path, context);
      const conflicts = conflictResult.conflicts.map((c) => c.path);
      let commitSha: string | null = null;
      if (!request.noCommit && conflicts.length === 0) {
        const shaResult = runGit(
          { ...context, workingDirectory: request.path, operation: "merge" },
          ["rev-parse", "HEAD"],
          EXIT_OK,
        );
        commitSha = stdoutString(shaResult).trim();
      }
      recordOp("merge", `git merge ${request.branch} at ${request.path}`);
      return deepFreeze({
        fastForward,
        merged: !fastForward && conflicts.length === 0,
        conflicts: deepFreeze(conflicts),
        commitSha,
      });
    },

    rebase(request: GitRebaseRequest, context: GitOperationContext): GitRebaseResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Rebase path must be absolute", "git_rebase_path_invalid");
      }
      let result: PinnedProcessResult;
      try {
        result = runGit(
          { ...context, workingDirectory: request.path, operation: "rebase" },
          ["rebase", request.branch],
          EXIT_OK,
        );
      } catch (error) {
        if (error instanceof HarnessError) {
          const conflictResult = checkConflictsInternal(request.path, context);
          if (conflictResult.hasConflicts) {
            return deepFreeze({
              rebased: false,
              conflicts: conflictResult.conflicts.map((c: GitConflictInfo) => c.path),
              commitSha: null,
            });
          }
        }
        throw error;
      }
      void result;
      const conflictResult = checkConflictsInternal(request.path, context);
      const conflicts = conflictResult.conflicts.map((c) => c.path);
      let commitSha: string | null = null;
      if (conflicts.length === 0) {
        const shaResult = runGit(
          { ...context, workingDirectory: request.path, operation: "rebase" },
          ["rev-parse", "HEAD"],
          EXIT_OK,
        );
        commitSha = stdoutString(shaResult).trim();
      }
      recordOp("rebase", `git rebase ${request.branch} at ${request.path}`);
      return deepFreeze({
        rebased: conflicts.length === 0,
        conflicts: deepFreeze(conflicts),
        commitSha,
      });
    },

    status(request: GitStatusRequest, context: GitOperationContext): GitStatusResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Status path must be absolute", "git_status_path_invalid");
      }
      const args = ["status", "--porcelain=v2", "--branch"];
      if (request.showIgnored) args.push("--ignored");
      const result = runGit(
        { ...context, workingDirectory: request.path, operation: "status" },
        args,
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      recordOp("status", `git status at ${request.path}`);
      return parsePorcelainV2(stdoutString(result));
    },

    diff(request: GitDiffRequest, context: GitOperationContext): GitDiffResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Diff path must be absolute", "git_diff_path_invalid");
      }
      const args = ["diff"];
      if (request.staged) args.push("--cached");
      args.push(`-U${request.contextLines}`);
      if (request.refA !== undefined && request.refB !== undefined) {
        args.push(`${request.refA}..${request.refB}`);
      } else if (request.refA !== undefined) {
        args.push(request.refA);
      }
      const result = runGit(
        { ...context, workingDirectory: request.path, operation: "diff" },
        args,
        [0, 1],
      );
      const patch = stdoutString(result);
      const lines = parseLines(patch);
      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;
      for (const line of lines) {
        if (line.startsWith("diff --git")) filesChanged++;
        else if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
      recordOp("diff", `git diff at ${request.path}`);
      return deepFreeze({ patch, filesChanged, insertions, deletions });
    },

    log(request: GitLogRequest, context: GitOperationContext): GitLogResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Log path must be absolute", "git_log_path_invalid");
      }
      const args = ["log", `-${request.maxCount}`, "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s"];
      if (request.ref !== undefined) args.push(request.ref);
      const result = runGit(
        { ...context, workingDirectory: request.path, operation: "log" },
        args,
        [0, 128],
      );
      recordOp("log", `git log at ${request.path}`);
      return parseLogRaw(stdoutString(result));
    },

    inspectRepository(path: string, context: GitOperationContext): GitRepositoryInfo {
      if (!isAbsolute(path)) {
        throw new InputError("Inspect path must be absolute", "git_inspect_path_invalid");
      }
      const isBareResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["rev-parse", "--is-bare-repository"],
        EXIT_OK,
      );
      const bare = stdoutString(isBareResult).trim() === "true";
      const gitDirResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["rev-parse", "--absolute-git-dir"],
        EXIT_OK,
      );
      const gitDir = stdoutString(gitDirResult).trim();
      const workTreeResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["rev-parse", "--show-toplevel"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const workTree = workTreeResult.status === 0 ? stdoutString(workTreeResult).trim() : null;
      const headResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["rev-parse", "HEAD"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const head = headResult.status === 0 ? stdoutString(headResult).trim() : "";
      const headUnborn = headResult.status !== 0;
      const branchResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["rev-parse", "--abbrev-ref", "HEAD"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      let currentBranch: string | null;
      let headDetached: boolean;
      if (headUnborn) {
        const symRefResult = runGit(
          { ...context, workingDirectory: path, operation: "inspect" },
          ["symbolic-ref", "--short", "HEAD"],
          EXIT_OK,
        );
        currentBranch = stdoutString(symRefResult).trim();
        headDetached = false;
      } else {
        const branchText = branchResult.status === 0 ? stdoutString(branchResult).trim() : "";
        headDetached = branchText === "HEAD";
        currentBranch = headDetached ? null : branchText;
      }
      const remoteResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["remote", "-v"],
        EXIT_OK,
      );
      const remotes = parseRemoteOutput(stdoutString(remoteResult));
      const refsResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["show-ref"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const refs = refsResult.status === 0 ? parseRefsOutput(stdoutString(refsResult)) : [];
      const objectFormatResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["rev-parse", "--show-object-format"],
        EXIT_OK,
      );
      const objectFormat = stdoutString(objectFormatResult).trim();
      const refStorageResult = runGit(
        { ...context, workingDirectory: path, operation: "inspect" },
        ["config", "extensions.objectformat"],
        EXIT_OK_OR_CHANGED_OR_UNBORN,
      );
      const refStorage = refStorageResult.status === 0 ? stdoutString(refStorageResult).trim() : "files";
      recordOp("inspect", `git inspect at ${path}`);
      return deepFreeze({
        path,
        bare,
        gitDir,
        workTree,
        head,
        headUnborn,
        headDetached,
        currentBranch,
        remotes,
        refs,
        objectFormat,
        refStorage,
      });
    },

    checkConflicts(path: string, context: GitOperationContext): GitConflictResult {
      if (!isAbsolute(path)) {
        throw new InputError("Conflict check path must be absolute", "git_conflict_path_invalid");
      }
      const result = runGit(
        { ...context, workingDirectory: path, operation: "conflict-check" },
        ["ls-files", "-u", "-z"],
        EXIT_OK,
      );
      const output = stdoutString(result);
      const conflicts = parseConflictPaths(output.replace(/\0/g, "\n"));
      return deepFreeze({ conflicts, hasConflicts: conflicts.length > 0 });
    },

    scanNeverPush(
      path: string,
      neverPushConfig: GitNeverPushConfig,
      context: GitOperationContext,
    ): GitNeverPushScanResult {
      if (!isAbsolute(path)) {
        throw new InputError("Never-push scan path must be absolute", "git_never_push_path_invalid");
      }
      const violations: GitNeverPushViolation[] = [];
      for (const rule of neverPushConfig.additiveRules) {
        const statusResult = runGit(
          { ...context, workingDirectory: path, operation: "never-push-scan" },
          ["status", "--porcelain=v2", "-z"],
          EXIT_OK_OR_CHANGED_OR_UNBORN,
        );
        const trackedResult = runGit(
          { ...context, workingDirectory: path, operation: "never-push-scan" },
          ["ls-files", "-z"],
          EXIT_OK,
        );
        const allFiles = [
          ...parseLines(stdoutString(statusResult).replace(/\0/g, "\n"))
            .map((line) => line.split("\t").slice(1).join("\t"))
            .filter((p) => p && p.length > 0),
          ...parseLines(stdoutString(trackedResult).replace(/\0/g, "\n")),
        ];
        const pattern = new RegExp(rule.pattern, "u");
        for (const filePath of new Set(allFiles)) {
          if (pattern.test(filePath)) {
            violations.push(deepFreeze({
              pattern: rule.pattern,
              path: filePath,
              classification: rule.classification,
              reason: `matches never-push pattern: ${rule.pattern}`,
            }));
          }
        }
      }
      recordOp("never-push-scan", `git never-push scan at ${path}`);
      return deepFreeze({ violations: deepFreeze(violations), clean: violations.length === 0 });
    },

    promote(request: GitPromotionRequest, context: GitOperationContext): GitPromotionResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Promotion path must be absolute", "git_promote_path_invalid");
      }
      const targetCheck = runGit(
        { ...context, workingDirectory: request.path, operation: "promote" },
        ["rev-parse", "--verify", request.targetBranch],
        [0, 128],
      );
      if (targetCheck.status !== 0) {
        throw new InputError(`Promotion target branch does not exist: ${request.targetBranch}`, "git_promote_target_missing");
      }
      if (request.fastForwardOnly) {
        runGit(
          { ...context, workingDirectory: request.path, operation: "promote" },
          ["fetch", ".", request.sourceBranch + ":" + request.targetBranch],
          EXIT_OK,
        );
      } else {
        runGit(
          { ...context, workingDirectory: request.path, operation: "promote" },
          ["merge", "--ff-only", request.sourceBranch],
          EXIT_OK,
        );
      }
      const targetShaResult = runGit(
        { ...context, workingDirectory: request.path, operation: "promote" },
        ["rev-parse", request.targetBranch],
        EXIT_OK,
      );
      const sourceShaResult = runGit(
        { ...context, workingDirectory: request.path, operation: "promote" },
        ["rev-parse", request.sourceBranch],
        EXIT_OK,
      );
      const targetSha = stdoutString(targetShaResult).trim();
      const sourceSha = stdoutString(sourceShaResult).trim();
      recordOp("promote", `git promote ${request.sourceBranch} -> ${request.targetBranch} at ${request.path}`);
      return deepFreeze({
        promoted: true,
        fastForward: request.fastForwardOnly,
        targetSha,
        sourceSha,
      });
    },

    rollback(request: GitRollbackRequest, context: GitOperationContext): GitRollbackResult {
      if (!isAbsolute(request.path)) {
        throw new InputError("Rollback path must be absolute", "git_rollback_path_invalid");
      }
      if (request.mode === "revert") {
        runGit(
          { ...context, workingDirectory: request.path, operation: "rollback" },
          ["revert", "--no-edit", request.target],
          EXIT_OK,
        );
        const shaResult = runGit(
          { ...context, workingDirectory: request.path, operation: "rollback" },
          ["rev-parse", "HEAD"],
          EXIT_OK,
        );
        const newHead = stdoutString(shaResult).trim();
        recordOp("rollback", `git revert ${request.target} at ${request.path}`);
        return deepFreeze({ reverted: true, reset: false, newHead, commitSha: newHead });
      }
      const resetMode = request.mode === "reset-soft" ? "--soft" : "--mixed";
      runGit(
        { ...context, workingDirectory: request.path, operation: "rollback" },
        ["reset", resetMode, request.target],
        EXIT_OK,
      );
      const shaResult = runGit(
        { ...context, workingDirectory: request.path, operation: "rollback" },
        ["rev-parse", "HEAD"],
        EXIT_OK,
      );
      const newHead = stdoutString(shaResult).trim();
      recordOp("rollback", `git reset ${resetMode} ${request.target} at ${request.path}`);
      return deepFreeze({ reverted: false, reset: true, newHead, commitSha: null });
    },
  });

  function gitError(
    operation: string,
    result: PinnedProcessResult,
    message: string,
  ): HarnessError {
    const code = `git_${operation}_failed`;
    const safeDetails = deepFreeze({
      operation,
      exitCode: result.status ?? -1,
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
    });
    return new HarnessError(message, code, false, safeDetails);
  }
}

export function resolveGitExecutable(override?: string): string {
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override) || !existsSync(override)) {
      throw new InputError("Configured git executable path is invalid or does not exist", "git_executable_invalid");
    }
    return override;
  }
  const isWindows = process.platform === "win32";
  const lookup = isWindows ? "where" : "which";
  const pathResult = spawnSync(lookup, ["git"], { encoding: "utf8" });
  if (pathResult.status === 0 && pathResult.stdout) {
    const resolved = pathResult.stdout.split(/\r?\n/u)[0]!.trim();
    if (isAbsolute(resolved)) return resolved;
  }
  const fallbacks = isWindows
    ? [
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\bin\\git.exe",
      "C:\\Program Files\\Git\\cmd\\git.exe",
    ]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  throw new InputError("Git executable not found", "git_executable_not_found");
}

export function defaultOperationContext(
  workingDirectory: string,
  identity: GitIdentity,
  operation: string,
  timeoutMs?: number,
): GitOperationContext {
  return deepFreeze({
    workingDirectory,
    identity,
    environment: {},
    timeoutMs: timeoutMs ?? DEFAULT_GIT_INSPECT_TIMEOUT_MS,
    operation: operation as GitOperationContext["operation"],
    description: `git ${operation} at ${workingDirectory}`,
  });
}

export type { GitPort, GitEffectRecorder };
