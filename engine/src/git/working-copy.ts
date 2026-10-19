/**
 * A PRIVATE WORKING COPY OF A CHECKOUT, WITH ITS OWN GIT — THE ONE BUILDER.
 *
 * Three callers need "this checkout, somewhere else, where writes land on
 * nothing anyone else reads": a test that drives a write-mode generator
 * (`harness sync` rewrites tracked generated files), the S1 scenarios that
 * mutate a runtime candidate, and the candidate checkout that qualifies a
 * dirty tree before it is committed (`scripts/tooling/candidate-checkout.ts`),
 * and the commit guard that certifies the staged tree. Each used
 * to carry its own copier, and the test copy had no `.git`: every git
 * question asked inside it walked up to the LIVE repository, from an ignored
 * directory, so the checks that need git were silently answered "unavailable".
 *
 * ── WHAT A COPY IS ────────────────────────────────────────────────────────
 *
 * - The population is what the source OWNS (`ownedFiles`, the one ownership
 *   reader: tracked plus untracked-not-ignored, versioned rules only),
 *   optionally narrowed by `include`, plus `carry`: ignored paths the caller
 *   names because the commands under test verify them (the pinned build
 *   outputs). Separate inodes, never hardlinks; every file keeps its mode (the
 *   config document's 0600 is checked). A tracked path deleted in the source
 *   is absent here too.
 * - `git: "mirror"` gives the copy its own repository whose objects are
 *   borrowed read-only from the source (`objects/info/alternates`, exactly
 *   what `git clone --shared` does), whose refs and HEAD are the source's, and
 *   whose index is a copy of the source's index. Git in the copy then answers
 *   tracked / untracked / staged exactly as in the source. Paths `include`
 *   leaves out are marked skip-worktree, so a narrowed copy still reports the
 *   source's tracked set and never a mass deletion.
 * - `git: "stage-all"` is mirror plus every change staged in the copy's own
 *   index (never the source's) — the tree `git add -A` would commit in the
 *   source. It needs the whole population.
 * - `git: "staged"` is the source's INDEX, materialized: the copy's files are
 *   the staged blobs (`checkout-index`), its index is the source's, so it is
 *   exactly the tree the next commit records (the commit guard certifies it).
 * - `git: "snapshot"` is a recorded SNAPSHOT, materialized: the files and the
 *   index are the snapshot commit's tree (`read-tree` + `checkout-index`),
 *   HEAD its parent — what the writer recorded, whatever the source's
 *   worktree holds now (a verifier's copy of the qualified tree).
 * - `git: "none"` is bytes only.
 *
 * ── TWO VIEWS OF "WHAT BELONGS", DECIDED ONCE ─────────────────────────────
 *
 * - The REPOSITORY-OWNED view (scanners, the copy's population): the
 *   versioned `.gitignore` rules only, so every machine judges the same set
 *   (`ownedFiles`, the ownership reader).
 * - The GIT STAGING view (what a commit records): git's full ignore view —
 *   `.gitignore`, the source's `info/exclude` (copied into the copy) and the
 *   user's global excludes file — exactly what `git add -A` stages in the
 *   source. A personal file the user's git ignores (`.claude/settings.local.json`
 *   under a global exclude) is copied as an untracked, ignored file and never
 *   staged, so a candidate commit never carries it.
 *
 * ── OBJECTS: BORROWED FROM THE CANONICAL STORE ONLY ───────────────────────
 *
 * The copy borrows objects through `objects/info/alternates`, and only from a
 * CANONICAL store: when the source is itself a copy, the copy borrows the
 * source's own alternates (never the source's object directory, which would
 * chain — deleting the intermediate copy would corrupt this one) and COPIES
 * the source's local objects (the few blobs only that copy holds). Before
 * staging, the index is refreshed against the files, so git re-hashes only
 * what changed: it neither writes the source's store nor freshens (utimes)
 * its packs for the unchanged tree. New objects land in the copy's own store.
 */

import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { abandonedTemporaries, ownedTemporaryName, sweepAbandonedTemporaries } from "../filesystem/private-state.ts";
import { intentToAddPaths } from "./index-entries.ts";
import { directoryGitEnvironment, gitAcceptsRefName, indexFilePath, ownedFiles, repositoryToplevel, trackedFiles } from "./repository-ownership.ts";

export type WorkingCopyGit = "mirror" | "stage-all" | "staged" | "snapshot" | "none";

export type WorkingCopyOptions = Readonly<{
  /** Any directory inside the source checkout; the copy mirrors its work-tree top level. */
  sourceRoot: string;
  /** Where the copy's top level goes; absent or an empty directory, on any filesystem. */
  targetRoot: string;
  git: WorkingCopyGit;
  /** Narrows the owned population (repository-relative, `/`-separated paths). Default: everything owned. */
  include?: (repositoryPath: string) => boolean;
  /** Ignored paths to carry as well (repository-relative); absent ones are skipped. */
  carry?: readonly string[];
  /** Keep each file's mtime (for callers whose caches key on it). */
  preserveTimestamps?: boolean;
  /**
   * `staged` only: the index file to materialize (absolute). Default: the
   * source's own index. A pre-commit hook passes the index git is actually
   * committing — `git commit -a` and `git commit -- <path>` point the hook at
   * a temporary `GIT_INDEX_FILE`, and certifying `.git/index` there judged a
   * tree that was not the one being committed (wf1c-correctness §3).
   */
  index?: string;
  /**
   * `snapshot` only: the commit (a `snapshotWorkingTree` record of the
   * source's repository) whose TREE the copy's files and index are, with
   * HEAD at its parent — so the copy is exactly what the snapshot recorded,
   * whatever the source's worktree holds now.
   */
  commit?: string;
}>;

export type WorkingCopy = Readonly<{
  /** The copy's top level (absolute). */
  root: string;
  /** The source's top level (absolute). */
  sourceRoot: string;
  /** The source HEAD the copy's HEAD names, or `undefined` for an unborn or git-less copy. */
  head: string | undefined;
  /** Every repository-relative path written into the copy. */
  paths: readonly string[];
}>;

function git(cwd: string, argv: readonly string[], input?: string, statusOneIsAnswer = false, environment: Readonly<Record<string, string>> = {}): string {
  try {
    return execFileSync("git", ["-c", "gc.auto=0", ...argv], {
      cwd,
      env: { ...directoryGitEnvironment(), ...environment },
      encoding: "utf8",
      maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes,
      ...(input === undefined ? {} : { input }),
    }).trimEnd();
  } catch (error) {
    // `update-index --refresh` exits 1 when an entry still differs (a
    // modified file): that is its answer, not a failure.
    if (statusOneIsAnswer && (error as { status?: unknown }).status === 1) return String((error as { stdout?: unknown }).stdout ?? "").trimEnd();
    throw error;
  }
}

function gitOptional(cwd: string, argv: readonly string[]): string | undefined {
  try {
    return git(cwd, argv);
  } catch {
    // An unborn HEAD or a detached checkout answers "no such ref" through
    // the exit status; that absence is the answer the caller branches on.
    return undefined;
  }
}

export function createWorkingCopy(options: WorkingCopyOptions): WorkingCopy {
  const sourceRoot = repositoryToplevel(options.sourceRoot, "inherited");
  if (sourceRoot === undefined) {
    throw new InputError(`working copy source is not inside a git working tree: ${options.sourceRoot}`, "working_copy_source_invalid");
  }
  if ((options.git === "stage-all" || options.git === "staged" || options.git === "snapshot") && options.include !== undefined) {
    throw new InputError(`a ${options.git} working copy is a whole tree; it cannot be narrowed`, "working_copy_options_invalid");
  }
  const targetRoot = resolve(options.targetRoot);
  mkdirSync(targetRoot, { recursive: true });
  if (readdirSync(targetRoot).length > 0) {
    throw new InputError(`working copy target is not empty: ${targetRoot}`, "working_copy_target_not_empty");
  }
  const written: string[] = [];
  // A stage-all copy keeps each file's mtime: a file newer than the index git
  // writes is "racily clean", its entry is smudged, and the next `add -A`
  // re-hashes it — freshening (utimes) the borrowed store's pack that holds
  // the unchanged blob. Older mtimes keep the unchanged tree out of `add`.
  const preserveTimestamps = options.preserveTimestamps === true || options.git === "stage-all";
  const carry = (paths: readonly string[]): void => {
    for (const path of paths) {
      if (copyEntry(join(sourceRoot, path), join(targetRoot, path), preserveTimestamps)) written.push(path);
    }
  };
  if (options.git === "staged") {
    // The files ARE the index: materialized by git from the staged blobs.
    const head = initializeGit(sourceRoot, targetRoot, options);
    git(targetRoot, ["checkout-index", "--all", "--force", "--quiet"]);
    dropIntentToAddEntries(targetRoot);
    written.push(...(trackedFiles(targetRoot) ?? []));
    carry(options.carry ?? []);
    git(targetRoot, ["update-index", "-q", "--refresh"], undefined, true);
    return Object.freeze({ root: targetRoot, sourceRoot, head, paths: Object.freeze(written) });
  }
  if (options.git === "snapshot") {
    // The files ARE the snapshot's tree (never the source's worktree), its
    // index the same tree, HEAD its parent: the copy a verifier builds is
    // byte for byte the tree the writer recorded.
    // Resolved IN THE SOURCE: a snapshot ref (refs/bridlewise/snapshots/…)
    // lives there only; the copy borrows its objects, not its refs.
    const commit = options.commit === undefined ? undefined : gitOptional(sourceRoot, ["rev-parse", "--verify", "-q", `${options.commit}^{commit}`])?.trim();
    if (commit === undefined || commit.length === 0) {
      throw new InputError(`a snapshot copy needs a commit of the source's repository: ${options.commit ?? "(none)"}`, "working_copy_snapshot_missing");
    }
    initializeGit(sourceRoot, targetRoot, options);
    git(targetRoot, ["read-tree", commit]);
    git(targetRoot, ["checkout-index", "--all", "--force", "--quiet"]);
    const parent = gitOptional(targetRoot, ["rev-parse", "--verify", "-q", `${commit}^`])?.trim();
    const branch = gitOptional(targetRoot, ["symbolic-ref", "-q", "HEAD"]);
    if (parent !== undefined) git(targetRoot, branch === undefined ? ["update-ref", "--no-deref", "HEAD", parent] : ["update-ref", branch, parent]);
    written.push(...(trackedFiles(targetRoot) ?? []));
    git(targetRoot, ["update-index", "-q", "--refresh"], undefined, true);
    return Object.freeze({ root: targetRoot, sourceRoot, head: parent, paths: Object.freeze(written) });
  }
  const owned = ownedFiles(sourceRoot) ?? [];
  carry([...(options.include === undefined ? owned : owned.filter(options.include)), ...(options.carry ?? [])]);
  const head = options.git === "none" ? undefined : initializeGit(sourceRoot, targetRoot, options);
  return Object.freeze({ root: targetRoot, sourceRoot, head, paths: Object.freeze(written) });
}

/**
 * A staged materialization holds what the COMMIT records: an intent-to-add
 * entry (`git add -N`) is in the index but not in the commit (`write-tree`
 * omits it), yet `checkout-index --all` writes it as an EMPTY file — so a
 * staged file importing it for its side effects compiled against a module
 * the commit does not carry. Such an entry is the only kind `diff-files`
 * reports as ADDED (a real entry differs from its file as modified or
 * deleted); it leaves the copy's index and its empty file is removed. The
 * index edit writes no object.
 */
function dropIntentToAddEntries(copyRoot: string): void {
  const intents = intentToAddPaths(copyRoot, "directory");
  if (intents.length === 0) return;
  git(copyRoot, ["update-index", "--force-remove", "-z", "--stdin"], `${intents.join("\0")}\0`);
  for (const path of intents) rmSync(join(copyRoot, path), { force: true });
}

/** How one owned path of a copy compares with its source. */
export type WorkingCopyDifference = Readonly<{ path: string; state: "changed" | "only-in-source" | "only-in-copy" }>;

function entryBytes(path: string): Buffer | string | undefined {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  if (stats.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
  return stats.isFile() ? Buffer.concat([readFileSync(path), Buffer.from(`\0mode:${(stats.mode & 0o111) !== 0}`)]) : undefined;
}

/**
 * The owned paths on which `copyRoot` and `sourceRoot` disagree (bytes,
 * symlink target, or executable bit), from both sides' ownership answers.
 */
export function workingCopyDifferences(sourceRoot: string, copyRoot: string): readonly WorkingCopyDifference[] {
  const sourceOwned = ownedFiles(sourceRoot) ?? [];
  const copyOwned = new Set(ownedFiles(copyRoot) ?? []);
  const differences: WorkingCopyDifference[] = [];
  for (const path of new Set([...sourceOwned, ...copyOwned])) {
    const inSource = entryBytes(join(sourceRoot, path));
    const inCopy = entryBytes(join(copyRoot, path));
    if (inSource === undefined && inCopy === undefined) continue;
    if (inSource === undefined) differences.push({ path, state: "only-in-copy" });
    else if (inCopy === undefined) differences.push({ path, state: "only-in-source" });
    else if (typeof inSource === "string" || typeof inCopy === "string" ? inSource !== inCopy : !inSource.equals(inCopy)) {
      differences.push({ path, state: "changed" });
    }
  }
  return Object.freeze(differences.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/**
 * Brings a stage-all copy back to its source's current owned bytes (changed
 * and new paths copied, paths the source no longer has removed) and restages
 * the copy's own index. `keep` names the paths the COPY authors (a
 * candidate's regenerated outputs): the source's stale bytes never overwrite
 * them and their absence in the source never deletes them. Returns what it
 * changed.
 */
export function refreshWorkingCopy(
  sourceRoot: string,
  copyRoot: string,
  keep: ReadonlySet<string> = new Set(),
): readonly WorkingCopyDifference[] {
  const differences = workingCopyDifferences(sourceRoot, copyRoot).filter(({ path }) => !keep.has(path));
  for (const { path, state } of differences) {
    const target = join(copyRoot, path);
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) rmSync(target, { force: true });
    if (state !== "only-in-copy") copyEntry(join(sourceRoot, path), target, false);
  }
  stageInCopy(copyRoot);
  return Object.freeze(differences);
}

/**
 * Stages `paths` (default: the whole tree) in a copy's own index with git's
 * full ignore view (the staging view, see the header), WITHOUT touching the
 * borrowed store. The index is refreshed first, so only files whose bytes
 * changed are hashed; and `add` runs against a PRIVATE object directory
 * (`GIT_OBJECT_DIRECTORY`, no alternates), because git FRESHENS (utimes) the
 * pack holding any blob it is asked to write that already exists — a changed
 * file whose new bytes match some historical blob touched the source's packs
 * (measured on the live tree: three such files, two packs). The objects
 * `add` writes are then moved into the copy's own store.
 *
 * The copy's `objects/info/alternates` is NEVER edited: the previous version
 * blanked it during `add` and restored it in a `finally`, so a Ctrl-C in that
 * window left a copy whose HEAD objects were unreachable, and any concurrent
 * reader saw a broken repository. An interrupted `add` here leaves only its
 * new objects in the private directory, and the next call (or the next
 * create/refresh) moves them in first.
 */
export function stageInCopy(copyRoot: string, paths: readonly string[] = ["."]): void {
  stagePrivately(copyRoot, paths, {});
}

/**
 * The private object directories `add` writes into (see {@link stageInCopy}),
 * inside the checkout's own git dir — ONE PER CALL (an owned temporary:
 * `<prefix><pid>-<start time>-<nonce>`). A single shared directory let two
 * concurrent calls on one repository delete each other's objects (each ended
 * by removing it), and `write-tree --missing-ok` then recorded a tree with a
 * lost blob without complaint (wf1c-design H-2).
 */
const STAGING_OBJECTS_PREFIX = "bridlewise-staging-objects-";
/** The snapshot's private index copies, one per call, owned the same way. */
const SNAPSHOT_INDEX_PREFIX = "bridlewise-snapshot-index-";

function gitPath(root: string, argv: readonly string[]): string {
  return git(root, ["rev-parse", "--path-format=absolute", ...argv]);
}

/**
 * Finishes what DEAD owners left in `gitDir`: their staging objects are
 * absorbed into the store (an object's name is its content), their private
 * index copies removed. A live owner's (a concurrent call) is never touched.
 */
function recoverAbandonedStaging(gitDir: string, objects: string): void {
  for (const name of abandonedTemporaries(gitDir, STAGING_OBJECTS_PREFIX)) absorbStagedObjects(objects, join(gitDir, name));
  sweepAbandonedTemporaries(gitDir, SNAPSHOT_INDEX_PREFIX);
}

/**
 * `add -A -- paths` in `root` against a PRIVATE object directory of this
 * call, absorbed into the repository's own store afterwards (see
 * {@link stageInCopy} for why). `environment` may name a private index
 * (`GIT_INDEX_FILE`).
 */
function stagePrivately(root: string, paths: readonly string[], environment: Readonly<Record<string, string>>): void {
  const gitDir = gitPath(root, ["--git-dir"]);
  const objects = gitPath(root, ["--git-path", "objects"]);
  recoverAbandonedStaging(gitDir, objects);
  git(root, ["update-index", "-q", "--refresh"], undefined, true, environment);
  withPrivateObjects(gitDir, objects, true, (staging) =>
    git(root, ["add", "-A", "--", ...paths], undefined, false, { ...environment, GIT_OBJECT_DIRECTORY: staging }));
}

/**
 * `write` against a PRIVATE object directory of this call (an owned
 * temporary in `gitDir`), then its objects absorbed into `objects` (`keep`:
 * something will reference them) or discarded (an identity was all that was
 * wanted: the store gains nothing).
 */
function withPrivateObjects<T>(gitDir: string, objects: string, keep: boolean, write: (staging: string) => T): T {
  const staging = join(gitDir, ownedTemporaryName(STAGING_OBJECTS_PREFIX));
  mkdirSync(staging, { recursive: true });
  try {
    return write(staging);
  } finally {
    if (keep) absorbStagedObjects(objects, staging);
    else rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * THE TREE `git add -A` WOULD COMMIT in `checkoutRoot` (git's full staging
 * view, see the header), written from a PRIVATE copy of its index
 * (`GIT_INDEX_FILE`) into private object directories: the real index is
 * never touched, and the store gains the objects only when `keep` (a
 * snapshot commits them); an identity ({@link workingTreeId}) discards them.
 */
function privateWorkingTree(checkoutRoot: string, keep: boolean): string {
  const gitDir = gitPath(checkoutRoot, ["--git-dir"]);
  const objects = gitPath(checkoutRoot, ["--git-path", "objects"]);
  recoverAbandonedStaging(gitDir, objects);
  const index = join(gitDir, ownedTemporaryName(SNAPSHOT_INDEX_PREFIX));
  const realIndex = indexFilePath(checkoutRoot, "directory");
  try {
    const realStat = statSync(realIndex, { throwIfNoEntry: false });
    if (realStat?.isFile() === true) {
      copyFileSync(realIndex, index);
      // The copy keeps the index's OWN timestamp: git judges an entry "racily clean" (and re-reads the file) when the
      // file is not older than the index that recorded it, and a copy stamped NOW would make an edit of the same size
      // in the same instant look clean — the tree would record the old bytes.
      utimesSync(index, realStat.atime, realStat.mtime);
    }
    git(checkoutRoot, ["update-index", "-q", "--refresh"], undefined, true, { GIT_INDEX_FILE: index });
    // `--missing-ok`: a private directory has no alternates, so the blobs of
    // unchanged files are not visible to it (they are in the store).
    return withPrivateObjects(gitDir, objects, keep, (staging) => {
      const environment = { GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: staging };
      // `:/` (the repository top), never `.`: asked from a FOLDER of the work
      // tree (the engine runner asks from the engine root), `.` staged that
      // folder alone and kept HEAD's entries for everything outside it — an id
      // of a tree nobody would commit (WF-1b3c-FIX N1).
      git(checkoutRoot, ["add", "-A", "--", ":/"], undefined, false, environment);
      return git(checkoutRoot, ["write-tree", "--missing-ok"], undefined, false, environment);
    });
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * THE IDENTITY OF WHAT A CHECKOUT HOLDS: the id of the tree `git add -A`
 * would commit there (tracked edits, staged entries and untracked files
 * outside the ignore rules — a clean checkout answers its HEAD's tree), with
 * nothing written anywhere a reader sees. `checkoutRoot` may be any folder of
 * the work tree: the answer is the whole repository's. The tree a test run measured: a
 * row recorded with it is matched by the commit that later holds exactly
 * that tree, wherever the run was taken (a candidate, a workspace, the
 * checkout itself), which a HEAD sha cannot do for a run of a dirty tree.
 */
export function workingTreeId(checkoutRoot: string): string {
  return privateWorkingTree(checkoutRoot, false);
}

export type WorkingTreeSnapshot = Readonly<{ tree: string; commit: string; parent: string | undefined; ref: string | undefined }>;

/**
 * THE ONE SNAPSHOT OF A DIRTY TREE: what `git add -A` would commit in
 * `checkoutRoot` (git's full staging view, see the header), recorded as a
 * tree and a commit whose parent is HEAD, WITHOUT touching the checkout's
 * real index or freshening its store: a private copy of the index
 * (`GIT_INDEX_FILE`), `add -A` and `write-tree` against a private object
 * directory (absorbed into the store afterwards), then `commit-tree`. The
 * snapshot is refused (`snapshot_objects_missing`) unless every object it
 * references is present.
 *
 * WHERE IT IS RECORDED — a snapshot is NEVER the commit of record:
 *   - `name` records it at `<ROOT_POLICY.verification.workingTreeSnapshot.refNamespace>/<name>`
 *     (the one namespace; a caller never spells a ref);
 *   - `advanceHead` moves the CHECKED-OUT branch (or a detached HEAD) to it —
 *     refused (`snapshot_ref_checked_out`) unless the real index already
 *     records exactly the snapshot's tree: moving a branch under an index
 *     that describes another tree makes `git status` show every change as a
 *     staged reversal, and `commit-tree` runs no hook (wf1c-design H-3).
 *     A commit of record is a normal `git commit` (the guard runs) or a
 *     fast-forward merge.
 *
 * The consumers: the candidate's `snapshot` and `create --from` (WF-1b),
 * `harness workspace create --overlay` (A5). `identity` sets the commit's
 * author and committer (default: the repository's configured identity,
 * refused by git when there is none).
 */
export function snapshotWorkingTree(
  checkoutRoot: string,
  options: Readonly<{ message: string; name?: string; advanceHead?: boolean; identity?: Readonly<{ name: string; email: string }> }>,
): WorkingTreeSnapshot {
  const ref = options.name === undefined ? undefined : `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/${options.name}`;
  // One ref segment, and a name git itself accepts (`x.lock`, `a..b`, `x.`
  // pass a character class and fail git's own rules with a raw error).
  if (ref !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.name!) ||
    !gitAcceptsRefName(ref))) {
    throw new InputError(`a snapshot name is one ref segment git accepts: ${options.name!}`, "snapshot_name_invalid");
  }
  // A named ref that is CHECKED OUT is a branch under an index: moving it is
  // `advanceHead`'s question, never a side effect of recording a name.
  if (ref !== undefined && gitOptional(checkoutRoot, ["symbolic-ref", "-q", "HEAD"]) === ref) {
    throw new HarnessError(`the snapshot ref ${ref} is checked out; recording it would move the branch under its index`, "snapshot_ref_checked_out");
  }
  // The objects are kept (the commit references them); completeness is
  // verified below against the real store.
  const tree = privateWorkingTree(checkoutRoot, true);
  const parent = gitOptional(checkoutRoot, ["rev-parse", "--verify", "-q", "HEAD"]);
  const identity = options.identity === undefined ? {} : {
    GIT_AUTHOR_NAME: options.identity.name, GIT_AUTHOR_EMAIL: options.identity.email,
    GIT_COMMITTER_NAME: options.identity.name, GIT_COMMITTER_EMAIL: options.identity.email,
  };
  const commit = git(checkoutRoot, ["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", options.message], undefined, false, identity);
  const missing = git(checkoutRoot, ["rev-list", "--objects", "--missing=print", commit, ...(parent === undefined ? [] : [`^${parent}`])])
    .split("\n").filter((line) => line.startsWith("?"));
  if (missing.length > 0) {
    throw new HarnessError(`the snapshot references ${String(missing.length)} missing object(s), the first ${missing[0]!}; it was not recorded`, "snapshot_objects_missing");
  }
  if (options.advanceHead === true) {
    const indexMatches = spawnSync("git", ["diff-index", "--cached", "--quiet", tree, "--"], { cwd: checkoutRoot, env: directoryGitEnvironment() }).status === 0;
    if (!indexMatches) {
      throw new HarnessError(
        "the checkout's index does not record the snapshot's tree; moving its checked-out branch would leave every change as a staged reversal — commit with git commit instead",
        "snapshot_ref_checked_out",
      );
    }
    // COMPARE-AND-SWAP: HEAD moves only from the parent this snapshot was
    // built on. A commit made meanwhile (a concurrent `git commit`) was
    // otherwise dropped from the branch (wf1b-correctness §4).
    const moved = spawnSync("git", ["update-ref", "-m", options.message, "HEAD", commit, parent ?? ""], { cwd: checkoutRoot, env: directoryGitEnvironment(), encoding: "utf8" });
    if (moved.status !== 0) {
      throw new HarnessError(`HEAD moved while the snapshot was taken (it is no longer ${parent ?? "unborn"}); nothing was moved — take the snapshot again`, "snapshot_head_moved");
    }
  }
  // The name is recorded only once every refusal above has passed.
  if (ref !== undefined) git(checkoutRoot, ["update-ref", ref, commit]);
  return Object.freeze({ tree, commit, parent, ref: ref ?? (options.advanceHead === true ? "HEAD" : undefined) });
}

/** Moves every object (loose and packed) of `staging` into `objects`, then removes `staging`. */
function absorbStagedObjects(objects: string, staging: string): void {
  if (statSync(staging, { throwIfNoEntry: false }) === undefined) return;
  for (const entry of readdirSync(staging)) {
    if (entry === "info") continue;
    const from = join(staging, entry);
    if (!statSync(from).isDirectory()) continue;
    mkdirSync(join(objects, entry), { recursive: true });
    for (const name of readdirSync(from)) {
      const target = join(objects, entry, name);
      // An object's name is its content: one already present is the same bytes.
      if (statSync(target, { throwIfNoEntry: false }) === undefined) renameSync(join(from, name), target);
    }
  }
  rmSync(staging, { recursive: true, force: true });
}

function copyEntry(source: string, target: string, preserveTimestamps: boolean): boolean {
  const stats = lstatSync(source, { throwIfNoEntry: false });
  if (stats === undefined) return false;
  mkdirSync(dirname(target), { recursive: true });
  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    return true;
  }
  if (!stats.isFile()) return false;
  // A reflink where the filesystem supports one, a byte copy otherwise.
  copyFileSync(source, target, constants.COPYFILE_FICLONE);
  chmodSync(target, stats.mode & 0o7777);
  if (preserveTimestamps) utimesSync(target, stats.atime, stats.mtime);
  return true;
}

function initializeGit(sourceRoot: string, targetRoot: string, options: WorkingCopyOptions): string | undefined {
  const branch = gitOptional(sourceRoot, ["symbolic-ref", "-q", "--short", "HEAD"]);
  git(targetRoot, ["init", "-q", ...(branch === undefined ? [] : [`--initial-branch=${branch}`])]);
  const sourceObjects = join(git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "objects");
  borrowCanonicalObjects(sourceObjects, join(targetRoot, ".git", "objects"));
  const head = gitOptional(sourceRoot, ["rev-parse", "--verify", "-q", "HEAD"]);
  // Every branch, remote-tracking ref and tag of the source, so a question
  // that resolves another ref (the testing floor reads `master` and its
  // remote) is answered as in the source. The objects are borrowed.
  const refs = git(sourceRoot, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes", "refs/tags"])
    .split("\n").filter((line) => line.length > 0 && !line.endsWith(" refs/remotes/origin/HEAD"));
  if (refs.length > 0) git(targetRoot, ["update-ref", "--stdin"], refs.map((line) => {
    const [sha, name] = line.split(" ");
    return `update ${name} ${sha}\n`;
  }).join(""));
  if (head !== undefined) {
    git(targetRoot, branch === undefined ? ["update-ref", "--no-deref", "HEAD", head] : ["update-ref", `refs/heads/${branch}`, head]);
  }
  copyRemoteConfiguration(sourceRoot, targetRoot);
  const sourceExclude = git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (statSync(sourceExclude, { throwIfNoEntry: false })?.isFile() === true) {
    mkdirSync(join(targetRoot, ".git", "info"), { recursive: true });
    copyFileSync(sourceExclude, join(targetRoot, ".git", "info", "exclude"));
  }
  const sourceIndex = options.index ?? indexFilePath(sourceRoot, "directory");
  if (statSync(sourceIndex, { throwIfNoEntry: false })?.isFile() === true) {
    copyFileSync(sourceIndex, join(targetRoot, ".git", "index"));
  }
  const include = options.include;
  if (include !== undefined) {
    const excluded = (trackedFiles(targetRoot) ?? []).filter((path) => !include(path));
    if (excluded.length > 0) git(targetRoot, ["update-index", "--skip-worktree", "-z", "--stdin"], `${excluded.join("\0")}\0`);
  }
  // The staging view (header): the source's own ignore rules apply, so the
  // copy stages exactly what `git add -A` would stage in the source.
  if (options.git === "stage-all") stageInCopy(targetRoot);
  return head;
}

/**
 * Points the copy at the CANONICAL object store(s) and never at another
 * copy's: a source that borrows (its own `info/alternates`) hands its
 * alternates on, and its local objects are copied (read-only on the source).
 */
function borrowCanonicalObjects(sourceObjects: string, targetObjects: string): void {
  const sourceAlternates = join(sourceObjects, "info", "alternates");
  const borrowed = statSync(sourceAlternates, { throwIfNoEntry: false })?.isFile() === true
    ? readFileSync(sourceAlternates, "utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => resolve(sourceObjects, line))
    : [];
  writeFileSync(join(targetObjects, "info", "alternates"), `${(borrowed.length > 0 ? borrowed : [sourceObjects]).join("\n")}\n`);
  if (borrowed.length === 0) return;
  for (const entry of readdirSync(sourceObjects)) {
    if (entry === "info") continue;
    const from = join(sourceObjects, entry);
    if (!statSync(from).isDirectory()) continue;
    for (const name of readdirSync(from)) {
      const target = join(targetObjects, entry, name);
      if (statSync(join(from, name)).isFile() && statSync(target, { throwIfNoEntry: false }) === undefined) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(from, name), target);
      }
    }
  }
}

/**
 * The source's remotes and branch upstreams, so `@{upstream}`, `status
 * --branch` and `remote -v` answer in the copy as in the source.
 */
function copyRemoteConfiguration(sourceRoot: string, targetRoot: string): void {
  const listed = gitOptional(sourceRoot, ["config", "--null", "--get-regexp", "^(remote|branch)\\."]);
  if (listed === undefined) return;
  for (const record of listed.split("\0")) {
    const newline = record.indexOf("\n");
    if (newline <= 0) continue;
    git(targetRoot, ["config", "--add", record.slice(0, newline), record.slice(newline + 1)]);
  }
}
