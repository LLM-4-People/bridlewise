/**
 * Git operations bridge — extends the read-only git-bridge with branch
 * listing, diff, and log operations. All operations are read-only (no
 * commit/checkout/push from the web UI — those require governed runtime
 * authority).
 */

import { gitRead, gitTextOrRefuse, isGitRepo, raiseIfNotRun } from "./git-bridge.ts";
import { assertProjectPathOwnership, type FsGate } from "../filesystem/fs-gate.ts";
import { serverConfig } from "../kernel/config.ts";
import { BadRequestError } from "../kernel/errors.ts";

export type GitBranch = Readonly<{
  name: string;
  current: boolean;
  remote: boolean;
}>;

export type GitLogEntry = Readonly<{
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}>;

type GitDiffFile = Readonly<{
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged";
  insertions: number;
  deletions: number;
}>;

export type GitDiffSummary = Readonly<{
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: readonly GitDiffFile[];
}>;

// (No Scattered Helpers): the local `gitText` + `GIT_ENV` + `GIT_ARGS`
// copies are removed — `gitText` is imported from git-bridge.ts (the single
// owner of the git-spawn pattern; this bridge extends it with branch/log/
// diff operations). The shared `gitText` trims stdout; every caller here
// `.trim`s again idempotently before splitting, so behavior is preserved.
// `isGitRepo` + the git-log cap are likewise consolidated —
// `isGitRepo` is imported from git-bridge.ts (the single owner of the
// repo probe), and the log cap lives in `serverConfig.gitMaxLogEntries`
// (the single owner of the `100` literal; previously scattered here, in
// the route, in tool-executor, + in the manifest).

/**
 * Reject a git ref that could be parsed as a git flag (argument
 * injection). `git diff --numstat <ref>` passes `ref` as a positional
 * arg; a caller-supplied `ref` starting with `-` (e.g. `--output=/tmp/x`)
 * is treated by git as an OPTION, not a ref — enabling server-side file
 * writes via `--output=` even though the path is ownership-gated. The
 * bridge is the choke point: validate at the lowest level so no caller
 * (route or LLM tool) can forget. Defense-in-depth on top of the
 * ownership gate (the ref is still scoped to the caller's own project).
 */
function assertSafeGitRef(ref: string): void {
  if (ref.length > 0 && ref.startsWith("-")) {
    throw new BadRequestError(
      "Invalid git ref: a ref must not start with '-' (argument-injection guard).",
      "invalid_git_ref",
    );
  }
}

/**
 * A read whose ANSWER is a list must not report a refusal as an empty list.
 *
 * `gitText` returns null for "git ran and said nothing" and for "confinement
 * refused, so git never existed", and these read paths turned both into `[]`.
 * A sandbox that had stopped working then looked exactly like a repository
 * with no branches — absence reported as a measurement, which is the one thing
 * a read path must never do. The refusal is raised instead, in plain words the
 * route hands straight to the reader.
 */
function readLines(repoPath: string, args: readonly string[], what: string): readonly string[] | null {
  const read = gitRead(repoPath, args);
  // The refusal sentence is built by `raiseIfNotRun` (git-bridge.ts), the
  // single owner — it was written out here as well, and two copies of one
  // sentence is two places for the wording to drift apart.
  raiseIfNotRun(read, what);
  if (read.kind === "failed") return null;
  return read.stdout.trim().split("\n");
}

// The refusal-aware text read is `gitTextOrRefuse` in git-bridge.ts (the git
// owner), imported rather than restated — a second copy here would be a
// second place for "what counts as a refusal" to be answered.
const readText = gitTextOrRefuse;

export function getBranches(repoPath: string, gate?: FsGate): readonly GitBranch[] {
  if (gate !== undefined) assertProjectPathOwnership(repoPath, gate);
  if (!isGitRepo(repoPath)) return [];
  // (bug fix): remote detection was BROKEN — `%(refname:short)`
  // yields `origin/main` for remotes (NO `remotes/` prefix), so the prior
  // `line.includes("remotes/")` was ALWAYS false + the
  // `replace(/^remotes\//, "")` was dead. The 4th column `%(refname)` is
  // the FULL refname (`refs/remotes/origin/main`), the only reliable way
  // to distinguish a remote ref from a local branch that happens to
  // contain a `/` (e.g. `feature/foo`). The short name is still the
  // display value; the full refname is the remote discriminator.
  //
  // (symref filter): the 5th column `%(symref)` is non-empty ONLY for
  // symbolic refs. A fetched remote carries `refs/remotes/origin/HEAD`
  // (a symref → `refs/remotes/origin/main`); git shortens its short name
  // to the BOGUS `origin` (not `origin/HEAD`), so the raw branch list
  // contained a phantom branch named `origin` that does not exist. The
  // symref column lets us skip it precisely (no false-positive risk on a
  // real branch — only symrefs carry a non-empty `%(symref)`).
  const lines = readLines(repoPath, [
    "branch", "-a", "--format=%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(refname)\t%(symref)",
  ], "branch list");
  if (lines === null) return [];
  const branches: GitBranch[] = [];
  const currentBranch = gitTextOrRefuse(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], "current branch")?.trim() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    const name = parts[0]?.trim();
    if (name === undefined || name.length === 0) continue;
    const fullRef = parts[3] ?? "";
    const symref = parts[4] ?? "";
    // Skip the `origin/HEAD` symref — it is a pointer, not a branch the
    // user can check out. Its short name is bogus (`origin`), so including
    // it pollutes the branch list with a phantom entry.
    if (symref.length > 0) continue;
    branches.push({
      name,
      current: name === currentBranch,
      remote: fullRef.startsWith("refs/remotes/"),
    });
  }
  return branches;
}

export function getLog(repoPath: string, maxEntries = serverConfig.gitLogDefaultEntries, gate?: FsGate): readonly GitLogEntry[] {
  if (gate !== undefined) assertProjectPathOwnership(repoPath, gate);
  if (!isGitRepo(repoPath)) return [];
  // the cap is the single config owner `gitMaxLogEntries` (was
  // the scattered `MAX_LOG_ENTRIES = 100` literal; the route + LLM tool
  // re-capped with their own copies). The bridge is the ONLY capper now.
  const limit = Math.min(Math.max(1, maxEntries), serverConfig.gitMaxLogEntries);
  const lines = readLines(repoPath, [
    "log", `-${limit}`, "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s",
  ], "commit log");
  if (lines === null) return [];
  const entries: GitLogEntry[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const [hash, shortHash, author, email, date, message] = line.split("\x1f");
    if (hash === undefined) continue;
    entries.push({ hash, shortHash: shortHash ?? hash.slice(0, serverConfig.gitShortHashLength), author: author ?? "", email: email ?? "", date: date ?? "", message: message ?? "" });
  }
  return entries;
}

export function getDiffSummary(repoPath: string, ref?: string, gate?: FsGate): GitDiffSummary | null {
  if (gate !== undefined) assertProjectPathOwnership(repoPath, gate);
  if (ref !== undefined) assertSafeGitRef(ref);
  if (!isGitRepo(repoPath)) return null;
  const diffArgs = ref !== undefined && ref.length > 0
    ? ["diff", "--numstat", ref]
    : ["diff", "--numstat", "HEAD"];
  const output = readText(repoPath, diffArgs, "change summary");
  if (output === null) {
    return { filesChanged: 0, insertions: 0, deletions: 0, files: [] };
  }
  const files: GitDiffSummary["files"][number][] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of output.trim().split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : parseInt(parts[0] ?? "0", 10) || 0;
    const del = parts[1] === "-" ? 0 : parseInt(parts[1] ?? "0", 10) || 0;
    const path = parts[2] ?? "";
    insertions += ins;
    deletions += del;
    files.push({ path, status: "modified", insertions: ins, deletions: del });
  }
  return { filesChanged: files.length, insertions, deletions, files };
}

/**
 * The empty tree's fixed object name (`git hash-object -t tree /dev/null`),
 * identical in every git repository. A repository's FIRST save has no
 * parent, so "this save against what came before it" is its diff from the
 * empty tree — see `refsOf` below.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The positional refs `git diff` gets for a requested comparison.
 *
 * TWO measured defects lived here:
 *
 * 1. NO REF MEANT "AGAINST THE INDEX". Plain `git diff` compares the working
 *    tree to the INDEX, so anything already staged came back as an EMPTY
 *    patch. Its own sibling `getDiffSummary` has always defaulted to `HEAD`,
 *    and custody's ± counts are measured with `git diff --numstat HEAD` — so
 *    the Custody room printed "+1 −0" on a row whose "see what changed"
 *    answered "no difference to show". Measured on a repo with one staged
 *    line: `git diff -- index.ts` → "" while `git diff --numstat HEAD` →
 *    "1\t0\tindex.ts". The base is now HEAD, matching both.
 *
 * 2. `<hash>^!` SILENTLY DEGRADED ON A ROOT SAVE. `A^!` expands to
 *    `A ^A^1`; a parentless commit has no `A^1`, so git dropped the
 *    exclusion and ran `git diff A` — the commit against the WORKING TREE,
 *    i.e. the reader's uncommitted edits presented as the content of the
 *    first save. A root save now diffs from the empty tree, which is what
 *    `^!` means when there is no parent.
 */
function refsOf(repoPath: string, ref: string | undefined): readonly string[] {
  if (ref === undefined || ref.length === 0) return ["HEAD"];
  const commit = ref.endsWith("^!") ? ref.slice(0, -2) : null;
  if (commit === null || commit.length === 0) return [ref];
  // `rev-list --parents -n 1` exits 0 either way and prints
  // "<sha> <parent…>" — one token means the save has no parent.
  const line = gitTextOrRefuse(repoPath, ["rev-list", "--parents", "-n", "1", commit], "the save's parents");
  if (line === null) return [ref];
  const isRoot = line.trim().split(/\s+/).length === 1;
  return isRoot ? [EMPTY_TREE, commit] : [ref];
}

/**
 * A NEW (never-saved) file's real patch: every line added.
 *
 * `git diff` — with or without a ref — knows nothing about a path that is
 * not in the index, so "see what changed" on a new file returned "" and the
 * reader was told the file "matches its last saved state". It does not: it
 * has no saved state at all. `--no-index` diffs the file against /dev/null
 * and produces the canonical `new file mode` patch; it signals "the two
 * differ" with exit 1, which is the answer, so the spawn owner is asked to
 * accept that code.
 *
 * Returns "" for anything git does not report as untracked — this can only
 * ever turn an empty answer into a real one, never change a real one.
 */
function untrackedPatch(repoPath: string, filePath: string): string {
  const others = gitTextOrRefuse(repoPath, [
    "ls-files", "--others", "--exclude-standard", "--", filePath,
  ], "the list of new files");
  if (others === null || others.trim().length === 0) return "";
  return gitTextOrRefuse(repoPath, ["diff", "--no-index", "--", "/dev/null", filePath], "this file's changes", [1]) ?? "";
}

/**
 * The diff-patch wire's answer. The patch alone cannot say why it is empty:
 * "no uncommitted difference" and "no repository to diff against" are two
 * different facts that both arrive as `""`, and a reader told the first
 * about the second is told a commit/revert story that cannot be true. The
 * typed `repository` fact is the same one the status wire serves, so both
 * doors' readers can name the real cause.
 */
export type DiffPatchAnswer = Readonly<{
  patch: string;
  /** False when the path is not a git repository at all — the same typed
   * fact `getGitStatus` serves beside its zeroed fields. */
  repository: boolean;
  /** The server's own sentence for the no-repository answer; absent for a
   * repository, which has no such cause to name. */
  reason?: string;
}>;

/**
 * The door's own words for a diff asked of a folder no repository tracks.
 * Custody's block serves its own sentence for the same fact ("…so there is
 * no saved history to keep work in"); each door names the consequence its
 * own question carries, in the same voice.
 */
const NOT_A_REPOSITORY_DIFF_REASON =
  "this project's folder is not under version control, so there is no earlier version to show changes against";

export function getDiffPatch(
  repoPath: string,
  filePath?: string,
  ref?: string,
  gate?: FsGate,
): DiffPatchAnswer {
  if (gate !== undefined) assertProjectPathOwnership(repoPath, gate);
  if (ref !== undefined) assertSafeGitRef(ref);
  if (!isGitRepo(repoPath)) {
    return { patch: "", repository: false, reason: NOT_A_REPOSITORY_DIFF_REASON };
  }
  const named = filePath !== undefined && filePath.length > 0;
  const args: string[] = ["diff", ...refsOf(repoPath, ref)];
  if (named) args.push("--", filePath);
  const patch = readText(repoPath, args, "file changes") ?? "";
  if (patch.length > 0 || !named) return { patch, repository: true };
  return { patch: untrackedPatch(repoPath, filePath as string), repository: true };
}

export type GitStatus = Readonly<{
  /** False when the path is NOT a git repository at all — a different fact
   * from every zeroed field beside it, and the one a reader needs to say
   * "not under version control" instead of "detached and clean" (two
   * fabricated facts the zeroed shape used to collapse into). */
  repository: boolean;
  branch: string | null;
  head: string | null;
  dirtyFiles: number;
  stagedFiles: number;
  untrackedFiles: number;
  entries: readonly Readonly<{ status: string; path: string; staged: boolean }>[];
}>;

export function getGitStatus(repoPath: string, gate: FsGate | undefined, options: Readonly<{ async: true }>): Promise<GitStatus>;
export function getGitStatus(repoPath: string, gate?: FsGate): GitStatus;
export function getGitStatus(repoPath: string, gate?: FsGate, options?: Readonly<{ async: true }>): GitStatus | Promise<GitStatus> {
  if (gate !== undefined) assertProjectPathOwnership(repoPath, gate);
  if (options?.async === true) return (async () => {
    // A successful status already proves repository membership. Probe only
    // after a failed status, where non-repository and failed read differ.
    const status = await gitRead(repoPath, ["status", "-b", "--porcelain=v1", "--untracked-files=all"], [], options);
    raiseIfNotRun(status, "working tree status");
    if (status.kind === "failed") {
      const probe = await gitRead(repoPath, ["rev-parse", "--is-inside-work-tree"], [], options);
      raiseIfNotRun(probe, "repository status");
      if (probe.kind !== "ran" || probe.stdout !== "true") return gitStatusFromReads(null, null, false);
    }
    const head = await gitTextOrRefuse(repoPath, ["rev-parse", "HEAD"], "current save", [], options);
    return gitStatusFromReads(status.kind === "ran" ? status.stdout : null, head?.trim() ?? null);
  })();
  if (!isGitRepo(repoPath)) return gitStatusFromReads(null, null, false);
  return gitStatusFromReads(
    readText(repoPath, ["status", "-b", "--porcelain=v1", "--untracked-files=all"], "working tree status"),
    readText(repoPath, ["rev-parse", "HEAD"], "current save")?.trim() ?? null,
  );
}

/** Decode the existing v1 measurement identically for sync and async readers. */
function gitStatusFromReads(porcelain: string | null, head: string | null, repository = true): GitStatus {
  if (!repository) return { repository: false, branch: null, head: null, dirtyFiles: 0, stagedFiles: 0, untrackedFiles: 0, entries: [] };
  let branch: string | null = null;
  if (porcelain !== null) {
    const firstLine = porcelain.split("\n")[0] ?? "";
    if (firstLine.startsWith("## ")) {
      const rest = firstLine.slice(3);
      const tok = rest.split(/\s|\.\.\./)[0] ?? "";
      // "HEAD (no branch)" → detached; tok would be "HEAD".
      branch = tok === "HEAD" ? null : (tok.length > 0 ? tok : null);
    }
  }
  if (porcelain === null) {
    return { repository: true, branch, head, dirtyFiles: 0, stagedFiles: 0, untrackedFiles: 0, entries: [] };
  }
  let stagedFiles = 0;
  let untrackedFiles = 0;
  const entries: { status: string; path: string; staged: boolean }[] = [];
  for (const line of porcelain.split("\n")) {
    // The `-b` flag prepends a `## <branch>` header line — skip it (it is
    // not a porcelain entry; parsing it would produce a bogus staged entry
    // whose "path" is the branch-tracking string).
    if (line.startsWith("## ")) continue;
    if (line.length < 2) continue;
    const xStatus = line[0] ?? " ";
    const yStatus = line[1] ?? " ";
    const path = line.slice(3);
    const staged = xStatus !== " " && xStatus !== "?";
    const status = yStatus === "?" ? "untracked" : yStatus === "M" ? "modified" : yStatus === "D" ? "deleted" : yStatus === "A" ? "added" : xStatus === "M" ? "staged" : xStatus === "D" ? "staged-delete" : yStatus.trim() || xStatus.trim() || "unknown";
    if (yStatus === "?") untrackedFiles++;
    if (staged) stagedFiles++;
    entries.push({ status, path, staged });
  }
  return {
    repository: true,
    branch,
    head,
    dirtyFiles: entries.filter((e) => e.status !== "untracked").length,
    stagedFiles,
    untrackedFiles,
    entries,
  };
}
