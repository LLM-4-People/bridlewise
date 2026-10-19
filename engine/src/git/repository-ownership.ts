/**
 * WHAT THE REPOSITORY OWNS — THE ONE READER.
 *
 * Every question of the shape "which files belong to this repository?" is
 * answered here: the source guards of both suites, the test inventory's
 * independent instrument, the checkpoint capture, the candidate manifest, the
 * staged-move guard, the working-copy builder, and product walkers over a
 * user's workspace. Before this module there were seven readers with two rule
 * sets, so one entry in `.git/info/exclude` made the checkpoint, the candidate
 * manifest and the working copy disagree about what the repository owns.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * Only the VERSIONED ignore rules count (`--exclude-per-directory=.gitignore`).
 * The standard set would also read `.git/info/exclude` and the user's global
 * excludes file, which differ per machine; the population a guard judges, a
 * snapshot captures or a copy carries must be the same on every checkout of
 * the same commit. A tracked file is always owned: git reports untracked
 * ignored paths only, and never collapses a directory holding a tracked file.
 *
 * The instrument is git itself, asked from `root` (paths come back relative to
 * it). A `root` outside any work tree has no declaration to read, so the
 * readers return `undefined` rather than guess; each caller decides whether
 * that is "own everything" or a refusal. Nothing is cached: ignored
 * directories appear during a run (reports, state, build output).
 *
 * ONE DECLARED EXCEPTION, IN THE READER: {@link machineIgnoredFiles}. The
 * commit guard's move-loss check asks a different question from every
 * population above — not "what does the repository own" but "what did
 * `git add -A` skip ON THIS MACHINE" — and `git add` honours
 * `.git/info/exclude` and the user's `core.excludesFile` too. Judged by the
 * versioned rules alone, a plain `mv` into a folder only `info/exclude`
 * ignores (or a rename to a `core.excludesFile` pattern) dropped a tracked
 * file with the guard green (wf-del-verify P3). So that one population is
 * git's full, machine-local ignore view (`--exclude-standard`), and no other
 * reader may use it.
 *
 * The prevention guard `repository-ownership-reader.test.ts` refuses a
 * `git ls-files` population query (`--others`, `--ignored`, `--exclude*`,
 * `--cached`) anywhere else in the repository.
 *
 * It also owns the small git reads the checkout-state records share (the
 * index baseline, the declared deletions): which git directory file a name
 * resolves to (`gitPath`), what HEAD names (`headCommit`), how many times
 * HEAD has moved (`headMoves`) and what HEAD holds at given paths
 * (`headVersions`).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

/**
 * The versioned-only rule set: every population below uses exactly this, and
 * the two pinned-git integrity readers (candidate manifest, checkpoint
 * capture) import it rather than spell their own.
 */
export const VERSIONED_IGNORE_RULES = "--exclude-per-directory=.gitignore";

export type RepositoryOwnership = Readonly<{
  /** The scan root the answer was computed for (absolute). */
  root: string;
  /** The top of the git working tree holding `root` (absolute). */
  repositoryRoot: string;
  /** Whether `absolutePath` (at or under `root`) is excluded by the repository's versioned ignore rules. */
  isIgnored: (absolutePath: string) => boolean;
}>;

/**
 * The process environment minus every `GIT_*` variable, for commands that
 * CREATE or drive a second repository (the working-copy builder, checkout
 * setup): an inherited `GIT_DIR` or `GIT_INDEX_FILE` (git exports them to
 * hooks) would point those commands at the source's git instead of the copy's.
 * The readers above deliberately honour the environment: inside a hook the
 * index being committed IS the answer, and a test may plant an index this way.
 */
export function directoryGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("GIT_")));
}

/**
 * THE GIT IDENTITY a commit made at `directory` would carry, as git resolves
 * it there — the repository's, the user's global or the system's
 * `user.name`/`user.email` — or `null` when git has none (it would refuse the
 * commit). The one reader: a copy that commits as its source (the candidate
 * checkout) and the workspace integrator, whose pinned git reads the
 * repository's own config only (its global config is `/dev/null`), so the
 * identity is resolved here once and handed to it (A5-design L8).
 */
export function configuredGitIdentity(directory: string): Readonly<{ name: string; email: string }> | null {
  const read = (key: string): string | null => {
    const answer = spawnSync("git", ["config", "--get", key], { cwd: directory, env: directoryGitEnvironment(), encoding: "utf8" });
    return answer.status === 0 && answer.stdout.trim().length > 0 ? answer.stdout.trim() : null;
  };
  const name = read("user.name");
  const email = read("user.email");
  return name === null || email === null ? null : Object.freeze({ name, email });
}

/**
 * Whether git accepts `ref` as a ref name (`git check-ref-format`, the one
 * authority on ref syntax: a name ending in git's lock suffix, `a..b` or `x.`
 * pass a character class and fail git's own rules). A question about the name alone, so no repository
 * is involved. The one owner (the snapshot names, the promotion profile's refs).
 */
export function gitAcceptsRefName(ref: string): boolean {
  return spawnSync("git", ["check-ref-format", ref], { env: directoryGitEnvironment() }).status === 0;
}

/**
 * Which git a question is asked of:
 *
 * - `inherited`: the caller's `GIT_*` count. Inside a hook they ARE the
 *   answer (git exports `GIT_INDEX_FILE` for `commit -a`, `GIT_DIR` for a
 *   linked worktree or `--git-dir`, `GIT_WORK_TREE` for `--work-tree`).
 * - `directory`: git is asked about the directory alone ({@link directoryGitEnvironment}).
 *   A question about ANOTHER place than the hook's repository must be asked
 *   this way: with the hook's `GIT_DIR` and no `GIT_WORK_TREE`, git takes the
 *   current directory for the top of the work tree, so `--show-toplevel` from
 *   `<top>/engine` answers `<top>/engine` (wf1b-correctness §2 N1: the commit
 *   guard located its engine at "" in every linked worktree).
 */
export type GitEnvironment = "inherited" | "directory";

/**
 * THE ROOTS A CHECKOUT'S TOOLS KEEP STATE UNDER (journals, recovery): the
 * engine root and the top of the checkout that holds it, deduplicated,
 * asked of the DIRECTORY's own git (a hook's `GIT_DIR` must not move the
 * answer). The one answer `harness check`'s journals step and the CLI's
 * journals signal share (wf1b2-design G2/G8: they asked two different gits).
 */
export function engineAndCheckoutRoots(engineRoot: string): readonly string[] {
  const top = repositoryToplevel(engineRoot, "directory");
  return [...new Set([engineRoot, ...(top === undefined ? [] : [top])])];
}

/** The process environment a git question of `environment` runs with. */
export function gitProcessEnvironment(environment: GitEnvironment): NodeJS.ProcessEnv {
  return environment === "directory" ? directoryGitEnvironment() : process.env;
}

/**
 * The top of the git working tree containing `root`, or `undefined` outside
 * one. Asked from the nearest ancestor git can enter: a root that lists but
 * cannot be entered (read bit without execute) is still INSIDE its repository,
 * and answering "no repository" there would switch off the index check that
 * exists to notice such a root.
 */
export function repositoryToplevel(root: string, environment: GitEnvironment): string | undefined {
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: nearestEnterableDirectory(resolve(root)), encoding: "utf8", env: gitProcessEnvironment(environment),
  });
  return toplevel.status === 0 ? resolve(toplevel.stdout.trim()) : undefined;
}

/**
 * {@link repositoryToplevel} (asked of the directory alone unless the caller
 * judges the hook's own git), or the typed refusal `code` outside a work tree
 * (each caller names its own code, so the refusal says whose question it was).
 */
export function requiredRepositoryToplevel(root: string, code: string, environment: GitEnvironment): string {
  const top = repositoryToplevel(root, environment);
  if (top === undefined) throw new InputError(`not inside a git working tree: ${root}`, code);
  return top;
}

/**
 * Git's own absolute answer for `name` inside the git directory of `root`
 * (`--git-path`): a linked worktree's per-worktree files live in its own git
 * directory, shared ones (refs, objects, hooks) in the common one.
 */
export function gitPath(root: string, name: string, environment: GitEnvironment): string {
  return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", name], {
    cwd: resolve(root), encoding: "utf8", env: gitProcessEnvironment(environment),
  }).trim();
}

/**
 * THE ONE "WHICH INDEX FILE" ANSWER: git's own (`--git-path index`, absolute).
 * `inherited` honours a hook's temporary `GIT_INDEX_FILE` (the index
 * `git commit -a`, `-- <path>` and `-i` record); `directory` is the checkout's
 * real index (a linked worktree's lives in its own git dir, never `.git/index`).
 */
export function indexFilePath(root: string, environment: GitEnvironment): string {
  return gitPath(root, "index", environment);
}

/**
 * THE PARENTS OF THE COMMIT BEING MADE in `root`: HEAD (none on an unborn
 * branch) and the commit `MERGE_HEAD` names (a merge being concluded), asked
 * of `environment`'s git (a hook's own, when a commit is being judged). An
 * octopus merge's further heads are not named here (git resolves the pseudo-ref
 * to its first line): a rule judged against these parents asks MORE of such a
 * merge, never less.
 */
export function pendingCommitParents(root: string, environment: GitEnvironment): readonly string[] {
  const head = headCommit(root, environment);
  const merge = spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD^{commit}"], { cwd: root, encoding: "utf8", env: gitProcessEnvironment(environment) });
  return Object.freeze([...(head === null ? [] : [head]), ...(merge.status === 0 ? [merge.stdout.trim()] : [])]);
}

/**
 * The commit HEAD names in the checkout whose top level is `top` (asked of
 * `environment`'s git: the directory alone by default, the hook's own git when
 * a commit is being judged); `null` on an unborn branch. Anything else git
 * cannot answer is a typed refusal, never a guess.
 */
export function headCommit(top: string, environment: GitEnvironment): string | null {
  const answer = spawnSync("git", ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: top, encoding: "utf8", env: gitProcessEnvironment(environment) });
  if (answer.status === 0) return answer.stdout.trim();
  if (answer.status === 1 && answer.error === undefined) return null;
  // A spawn that failed itself (EAGAIN under load, ENOENT) has no stderr: its error code is the reason.
  const reason = answer.error === undefined ? (answer.stderr ?? "").trim() : `git did not run (${(answer.error as NodeJS.ErrnoException).code ?? answer.error.message})`;
  throw new HarnessError(`git could not name HEAD in ${top}: ${reason}`, "repository_head_unreadable");
}

/** An index entry git keeps apart from the disk: its flag, and what the index holds for it. */
export type FlaggedIndexEntry = Readonly<{ flag: "skip-worktree" | "assume-unchanged"; mode: string; bytes: Buffer }>;

/**
 * THE INDEX ENTRIES WHOSE DISK BYTES GIT DOES NOT LOOK AT under `paths`
 * (repository-relative pathspecs): those marked skip-worktree (a narrowed copy
 * leaves them out) or assume-unchanged. For each, the flag and the bytes and
 * mode the INDEX holds — git's view of the path, the one a commit records,
 * whatever the disk holds.
 */
export function flaggedIndexEntries(top: string, paths: readonly string[]): ReadonlyMap<string, FlaggedIndexEntry> {
  const flagged = new Map<string, FlaggedIndexEntry>();
  const tags = gitNulRecords(top, ["ls-files", "-v", "-z", "--", ...paths], "inherited");
  const stages = new Map(gitNulRecords(top, ["ls-files", "-s", "-z", "--", ...paths], "inherited").map((record) => {
    const tab = record.indexOf("\t");
    const [mode, oid] = record.slice(0, tab).split(" ");
    return [record.slice(tab + 1), { mode: mode!, oid: oid! }] as const;
  }));
  for (const record of tags) {
    const tag = record[0]!;
    const path = record.slice(2);
    const flag = tag === "S" || tag === "s" ? "skip-worktree" : tag !== tag.toUpperCase() ? "assume-unchanged" : undefined;
    const entry = stages.get(path);
    if (flag === undefined || entry === undefined) continue;
    const bytes = execFileSync("git", ["cat-file", "blob", entry.oid], { cwd: top, env: gitProcessEnvironment("inherited"), maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes });
    flagged.set(path, Object.freeze({ flag, mode: entry.mode, bytes }));
  }
  return flagged;
}

/** Where a checkout's HEAD stands: the branch it names (or null when detached) and the commit it resolves to. */
export type RepositoryRefIdentity = Readonly<{ branch: string | null; head: string | null }>;

/**
 * THE REPOSITORY A RUN MUST NOT MOVE: the branch the checkout holding `root`
 * has checked out and the commit HEAD resolves to (asked of the directory's
 * own git). A suite snapshots it before its first test and compares it after
 * its last ({@link repositoryRefChanges}): a test that committed, reset or
 * checked out in the real checkout (a git command that fell through to the
 * enclosing repository) is named. `undefined` outside a work tree.
 */
export function repositoryRefIdentity(root: string): RepositoryRefIdentity | undefined {
  const top = repositoryToplevel(resolve(root), "directory");
  if (top === undefined) return undefined;
  const named = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: top, encoding: "utf8", env: gitProcessEnvironment("directory") });
  if (named.error !== undefined) throw named.error;
  return Object.freeze({ branch: named.status === 0 ? named.stdout.trim() : null, head: headCommit(top, "directory") });
}

/** What moved between two readings of {@link repositoryRefIdentity}, said in words; empty when nothing did. */
export function repositoryRefChanges(before: RepositoryRefIdentity | undefined, after: RepositoryRefIdentity | undefined): readonly string[] {
  if (before === undefined || after === undefined) return before === after ? [] : ["the checkout's repository appeared or vanished"];
  return Object.freeze([
    ...(before.branch === after.branch ? [] : [`HEAD names ${after.branch ?? "no branch (detached)"}, not ${before.branch ?? "no branch (detached)"}`]),
    ...(before.head === after.head ? [] : [`HEAD moved from ${before.head ?? "(unborn)"} to ${after.head ?? "(unborn)"}`]),
  ]);
}

/**
 * How many times HEAD has moved in the checkout whose top level is `top`: the
 * length of its HEAD reflog (every commit, reset, checkout, merge and rebase
 * step appends one entry, and an existing reflog is appended to whatever
 * `core.logAllRefUpdates` says). Two readings are equal only while HEAD has
 * not moved at all between them, even when it has come back to the same
 * commit (`reset --soft`). `null` when this checkout keeps no HEAD reflog.
 */
export function headMoves(top: string, environment: GitEnvironment): number | null {
  const answer = spawnSync("git", ["rev-list", "--walk-reflogs", "--count", "HEAD"], { cwd: top, encoding: "utf8", env: gitProcessEnvironment(environment) });
  const count = answer.status === 0 ? Number.parseInt(answer.stdout.trim(), 10) : Number.NaN;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/** One path's (mode, object) in a tree. */
export type TreeVersion = Readonly<{ mode: string; objectId: string }>;

/**
 * HEAD's (mode, object) for each of `paths`, exactly (asked of `environment`'s
 * git, like {@link headCommit}): the answer holds the asked paths and nothing
 * else, and a folder is its own tree entry. Paths HEAD does not hold are
 * absent, and so is everything on an unborn branch.
 *
 * `ls-tree` takes its paths as PATTERNS THAT DESCEND, even literal ones.
 * Asked for `docs` and `docs/a.md` together, it walks into `docs` and lists
 * every child there, but never `docs` itself, so the folder looked absent and
 * its siblings looked asked (measured on git 2.47). So a path that is the
 * folder of another asked path is asked on its own, and only asked paths are
 * kept.
 */
export function headVersions(top: string, paths: readonly string[], environment: GitEnvironment): ReadonlyMap<string, TreeVersion> {
  const versions = new Map<string, TreeVersion>();
  if (paths.length === 0 || headCommit(top, environment) === null) return versions;
  const asked = new Set(paths);
  const folders = [...asked].filter((path) => [...asked].some((other) => other.startsWith(`${path}/`)));
  const batches = [[...asked].filter((path) => !folders.includes(path)), ...folders.map((folder) => [folder])].filter((batch) => batch.length > 0);
  for (const batch of batches) {
    for (const record of gitNulRecords(top, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", "HEAD", "--", ...batch], environment)) {
      const match = /^(\d{6}) \w+ ([0-9a-f]+)\t([\s\S]+)$/u.exec(record);
      if (match !== null && batch.includes(match[3]!)) versions.set(match[3]!, { mode: match[1]!, objectId: match[2]! });
    }
  }
  return versions;
}

const NOT_ENTERABLE_CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR"]);

function nearestEnterableDirectory(path: string): string {
  let current = path;
  while (true) {
    try {
      accessSync(current, constants.X_OK);
      if (statSync(current).isDirectory()) return current;
    } catch (error) {
      // Not enterable (or not there): its parent answers the same repository
      // question. Anything else is a real failure.
      if (!NOT_ENTERABLE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The NUL-terminated records a `-z` git command prints in `cwd` (`argv`
 * carries its own `-z`), decoded strictly: a path that is not UTF-8 is
 * refused rather than mangled into a replacement character that names no file.
 */
export function gitNulRecords(cwd: string, argv: readonly string[], environment: GitEnvironment): readonly string[] {
  const listed = execFileSync("git", [...argv], {
    cwd,
    env: gitProcessEnvironment(environment),
    maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes,
  });
  let text: string;
  try {
    text = STRICT_UTF8.decode(listed);
  } catch {
    throw new InputError(`git listed a path under ${cwd} that is not valid UTF-8`, "repository_path_encoding_invalid");
  }
  return Object.freeze(text.split("\0").filter((entry) => entry.length > 0));
}

/**
 * The text of `path` (repository-relative) at revision `rev` of the repository
 * at `top`, or `null` when that revision does not hold it (or `rev` names
 * nothing, as HEAD in a repository with no commit).
 */
export function revisionFileText(top: string, rev: string, path: string, environment: GitEnvironment): string | null {
  const env = gitProcessEnvironment(environment);
  const held = spawnSync("git", ["cat-file", "-e", `${rev}:${path}`], { cwd: top, env, stdio: "ignore" });
  if (held.error !== undefined) throw held.error;
  if (held.status !== 0) return null;
  return STRICT_UTF8.decode(execFileSync("git", ["cat-file", "blob", `${rev}:${path}`], { cwd: top, env, maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes }));
}

function listPaths(cwd: string, argv: readonly string[]): readonly string[] {
  return gitNulRecords(cwd, ["ls-files", "-z", ...argv], "inherited");
}

/**
 * Every path the git index holds under `root`, relative to `root` (a tracked
 * path deleted from the disk is still listed). `undefined` outside a work tree.
 */
export function trackedFiles(root: string): readonly string[] | undefined {
  const absoluteRoot = resolve(root);
  if (repositoryToplevel(absoluteRoot, "inherited") === undefined) return undefined;
  return listPaths(absoluteRoot, ["--cached", "--deduplicate", "--", "."]);
}

/**
 * Every path the git index holds under `root` that is PRESENT in the working
 * tree, relative to `root`: {@link trackedFiles} minus git's own
 * `ls-files --deleted`. An unstaged deletion is a legitimate working-tree
 * state (a deleted module waiting for its commit), so a population judged
 * against the disk (the source walk's index oracle, the test inventory's
 * independent instrument) expects it to be simply absent, never "missing".
 * `undefined` outside a work tree.
 */
export function presentTrackedFiles(root: string): readonly string[] | undefined {
  const absoluteRoot = resolve(root);
  if (repositoryToplevel(absoluteRoot, "inherited") === undefined) return undefined;
  return withoutUnstagedDeletions(absoluteRoot, listPaths(absoluteRoot, ["--cached", "--deduplicate", "--", "."]));
}

/** `listed` minus git's own `ls-files --deleted` under `absoluteRoot` (the one unstaged-deletion answer). */
function withoutUnstagedDeletions(absoluteRoot: string, listed: readonly string[]): readonly string[] {
  const deleted = new Set(listPaths(absoluteRoot, ["--deleted", "--deduplicate", "--", "."]));
  return deleted.size === 0 ? listed : Object.freeze(listed.filter((path) => !deleted.has(path)));
}

/**
 * Every file the repository owns under `root`, relative to `root`: tracked,
 * plus untracked-but-not-ignored under the versioned rules. An UNSTAGED
 * deletion is absent (a directory whose tracked files were all deleted is no
 * longer an owned entry — no "git rm" is needed for discovery to agree with
 * the disk). `undefined` outside a work tree.
 */
export function ownedFiles(root: string): readonly string[] | undefined {
  const absoluteRoot = resolve(root);
  if (repositoryToplevel(absoluteRoot, "inherited") === undefined) return undefined;
  return withoutUnstagedDeletions(absoluteRoot, listPaths(absoluteRoot, ["--cached", "--others", "--deduplicate", VERSIONED_IGNORE_RULES, "--", "."]));
}

/**
 * Every untracked file under `root` that git ignores ON THIS MACHINE — the
 * versioned rules plus `.git/info/exclude` and `core.excludesFile`
 * (`--exclude-standard`): exactly what `git add -A` skips. The move-loss
 * population only (see the header); relative to `root`, one entry per file.
 * `undefined` outside a work tree.
 */
export function machineIgnoredFiles(root: string, environment: GitEnvironment): readonly string[] | undefined {
  const absoluteRoot = resolve(root);
  if (repositoryToplevel(absoluteRoot, environment) === undefined) return undefined;
  return gitNulRecords(absoluteRoot, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", "."], environment);
}

/**
 * Every TRACKED path under `root` that the versioned rules also match (a file
 * force-added past an ignore rule), relative to `root`. `undefined` outside a
 * work tree.
 */
export function trackedIgnoredFiles(root: string): readonly string[] | undefined {
  const absoluteRoot = resolve(root);
  if (repositoryToplevel(absoluteRoot, "inherited") === undefined) return undefined;
  return listPaths(absoluteRoot, ["--cached", "--ignored", VERSIONED_IGNORE_RULES, "--", "."]);
}

/**
 * The ignored entries under `root`, repository-relative, with every wholly
 * ignored directory collapsed to one `dir/` entry — the raw listing
 * {@link repositoryOwnership} prunes with. `undefined` outside a work tree.
 */
export function ignoredEntries(root: string): readonly string[] | undefined {
  const absoluteRoot = resolve(root);
  const repositoryRoot = repositoryToplevel(absoluteRoot, "inherited");
  return repositoryRoot === undefined ? undefined : listIgnored(repositoryRoot, absoluteRoot);
}

function listIgnored(repositoryRoot: string, absoluteRoot: string): readonly string[] {
  // Asked from the TOP of the work tree with the root as a pathspec: git
  // refuses the question when its working directory is itself inside an
  // ignored directory ("directory entry not superset of prefix"), and a scan
  // root inside one is exactly the case the caller must be told about.
  const pathspec = toRepositoryPath(repositoryRoot, absoluteRoot) || ".";
  return listPaths(repositoryRoot, ["--others", "--ignored", VERSIONED_IGNORE_RULES, "--directory", "--", pathspec]);
}

/**
 * The ownership answer for `root` as a predicate, or `undefined` when `root`
 * is not inside a git working tree.
 */
export function repositoryOwnership(root: string): RepositoryOwnership | undefined {
  const absoluteRoot = resolve(root);
  const repositoryRoot = repositoryToplevel(absoluteRoot, "inherited");
  if (repositoryRoot === undefined) return undefined;
  const ignoredFiles = new Set<string>();
  const ignoredDirectories: string[] = [];
  for (const entry of listIgnored(repositoryRoot, absoluteRoot)) {
    if (entry.endsWith("/")) ignoredDirectories.push(entry.slice(0, -1));
    else ignoredFiles.add(entry);
  }
  const isIgnored = (absolutePath: string): boolean => {
    const path = toRepositoryPath(repositoryRoot, resolve(absolutePath));
    if (path.startsWith("..")) return false;
    if (ignoredFiles.has(path)) return true;
    return ignoredDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`));
  };
  return Object.freeze({ root: absoluteRoot, repositoryRoot, isIgnored });
}

/**
 * The names directly under `directory` that hold something the repository
 * owns — the door for a guard that DISCOVERS its scan roots from a directory
 * listing. Answered from {@link ownedFiles}, so git's own directory (`.git`),
 * dependencies, build output and research copies are never roots. Sorted;
 * `undefined` outside a work tree.
 */
export function ownedEntries(directory: string): readonly string[] | undefined {
  const owned = ownedFiles(directory);
  if (owned === undefined) return undefined;
  return Object.freeze([...new Set(owned.map((path) => path.split("/")[0]!))].toSorted());
}

function toRepositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}
