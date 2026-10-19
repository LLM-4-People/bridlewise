/**
 * TREE READERS — one port over "the files of a tree": a COMMIT's (read from
 * the object store: one `git ls-tree` for the listing, `git cat-file --batch`
 * for the bytes, batched, never one process per file) or a WORKING TREE's (the
 * files `git add -A` would commit, read from disk). A consumer that classifies
 * or walks a tree (the promotion projection, the source-side boundary guard)
 * is written once against {@link TreeReader} and runs over either.
 *
 * Entries keep git's own identity: a commit entry is its mode and object id,
 * never re-encoded (a binary blob is compared by id, its bytes are never a
 * string); `text` decodes UTF-8 for the files a walk parses. A working-tree
 * entry carries the mode git would record and no object id (nothing is
 * hashed until something asks for one). A path is UTF-8 or refused
 * (`tree_reader_path_not_utf8`): a decoded-and-re-encoded path would name
 * another file in a tree written from it.
 *
 * Every git process runs through ONE door, {@link gitOutput}, against a
 * {@link GitRepository}: the configured executable (never PATH's by
 * accident) and a per-call ceiling, so a hung git ends typed instead of
 * hanging its caller.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { createOwnedTemporaryDirectory, removeOwnedTemporaryDirectory } from "../filesystem/private-state.ts";
import { gitProcessEnvironment, ownedFiles } from "./repository-ownership.ts";

/** A repository and the git that answers about it: the executable (the configured one: `configuredGitRepository`, src/git/worktree-port.ts) and each call's ceiling. */
export type GitRepository = Readonly<{
  /** Any directory inside a checkout of the repository. */
  root: string;
  /** The absolute path of the git executable. */
  executable: string;
  /** The ceiling of one git process, in milliseconds. */
  timeoutMs: number;
}>;

/** The gitlink (submodule) mode: an entry with no bytes in this repository. */
export const GITLINK_MODE = "160000";
/** The symbolic-link mode: the entry's bytes are the link target. */
export const SYMLINK_MODE = "120000";

/** One file of a tree, as git records it. */
export type TreeEntry = Readonly<{
  /** Git's mode: `100644`, `100755`, `120000` (a symlink) or `160000` (a gitlink). */
  mode: string;
  /** The object id (a commit reader); `null` for a working-tree file nobody has hashed. */
  oid: string | null;
}>;

export type TreeReader = Readonly<{
  /** What is read: a commit id, or `working tree <root>`. */
  label: string;
  /** Every file path of the tree, repository-relative, sorted. */
  paths(): readonly string[];
  /** The entry at `path`, or `null` when the tree holds none. */
  entry(path: string): TreeEntry | null;
  /** The UTF-8 text at `path` (a symlink's target), or `null` when absent or a gitlink. Served from the batch cache when prefetched. */
  text(path: string): string | null;
  /** Reads `paths` in as few processes as the output bound allows, so the following `text` calls are cache hits. */
  prefetch(paths: Iterable<string>): void;
}>;

/**
 * `git <argv>` in `repository` (the directory's own git: no inherited
 * `GIT_DIR` or index; `gc.auto=0`, so no read starts a background collection),
 * stdout as bytes, or the typed refusal `tree_reader_git_failed` (its message
 * says when the call reached its ceiling). `allowed` lists the exit statuses
 * that answer a question (`merge-base --is-ancestor` answers 1 for "no");
 * `environment` adds variables (a private `GIT_INDEX_FILE`). The one git door
 * of the tree readers and writers and of the promotion that reads history
 * through them.
 */
export function gitOutput(
  repository: GitRepository,
  argv: readonly string[],
  options: Readonly<{ input?: Buffer; allowed?: readonly number[]; environment?: Readonly<Record<string, string>> }> = {},
): Readonly<{ status: number; stdout: Buffer }> {
  const result = spawnSync(repository.executable, ["-c", "gc.auto=0", ...argv], {
    cwd: repository.root,
    env: { ...gitProcessEnvironment("directory"), ...options.environment },
    maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes,
    timeout: repository.timeoutMs,
    killSignal: "SIGKILL",
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.status === null || !(options.allowed ?? [0]).includes(result.status)) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const reason = code === "ETIMEDOUT"
      ? `it reached its ${String(repository.timeoutMs)}ms ceiling and was killed`
      : result.error === undefined ? (result.signal === null ? result.stderr.toString("utf8").trim() : `it ended by ${result.signal}`) : `git did not run (${code ?? result.error.message})`;
    // How it ended, for a caller that tells the machine's failure (a ceiling, a signal, git not run) from git's answer.
    const ending = code === "ETIMEDOUT" ? "ceiling" : result.error !== undefined ? "unstarted" : result.signal !== null ? "signal" : "exited";
    throw new HarnessError(`git ${argv.join(" ")} failed in ${repository.root}: ${reason}`, "tree_reader_git_failed", ending !== "exited", { ending });
  }
  return { status: result.status, stdout: result.stdout };
}

/** The object `rev` names in `repository`, peeled to `kind` (a commit by default), or `null` when it names none. */
export function resolveRevision(repository: GitRepository, rev: string, kind: "commit" | "tree" | "object" = "commit"): string | null {
  const found = gitOutput(repository, ["rev-parse", "-q", "--verify", `${rev}^{${kind}}`], { allowed: [0, 1] });
  return found.status === 0 ? found.stdout.toString("utf8").trim() : null;
}

function gitBytes(repository: GitRepository, argv: readonly string[], input?: Buffer): Buffer {
  return gitOutput(repository, argv, input === undefined ? {} : { input }).stdout;
}

/** The repository path of a NUL-terminated git record's path bytes, refused (`tree_reader_path_not_utf8`) unless they are UTF-8. */
function utf8Path(bytes: Buffer, where: string): string {
  const path = bytes.toString("utf8");
  if (!Buffer.from(path, "utf8").equals(bytes)) {
    throw new HarnessError(`${where} holds a path that is not UTF-8 (${bytes.toString("hex")}): rename it on its branch; a tree written from a decoded path would name another file`, "tree_reader_path_not_utf8");
  }
  return path;
}

/** The records of a `-z` listing: each NUL-terminated record's bytes. */
function nulRecords(output: Buffer): readonly Buffer[] {
  const records: Buffer[] = [];
  for (let start = 0; start < output.length;) {
    const end = output.indexOf(0, start);
    const stop = end < 0 ? output.length : end;
    if (stop > start) records.push(output.subarray(start, stop));
    start = stop + 1;
  }
  return records;
}

type CommitEntry = Readonly<{ mode: string; type: string; oid: string; size: number }>;

/**
 * The files of `commit` in `repository`. The listing is one
 * `git ls-tree -r -l -z --full-tree`; bytes are read by object id through
 * `git cat-file --batch`, in batches whose declared sizes fit half the git
 * output bound.
 */
export function commitTreeReader(repository: GitRepository, commit: string): TreeReader {
  const listing = new Map<string, CommitEntry>();
  for (const record of nulRecords(gitBytes(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit]))) {
    const tab = record.indexOf(0x09);
    const [mode, type, oid, size] = record.subarray(0, tab).toString("utf8").split(/ +/u);
    listing.set(utf8Path(record.subarray(tab + 1), commit), deepFreeze({ mode: mode!, type: type!, oid: oid!, size: size === "-" ? 0 : Number(size) }));
  }
  const sorted = deepFreeze([...listing.keys()].sort());
  const texts = new Map<string, string | null>();
  const batchBytes = Math.floor(ROOT_POLICY.runtime.limits.maximumGitOutputBytes / 2);
  const readBatch = (paths: readonly string[]): void => {
    const blobs = paths.filter((path) => listing.get(path)!.type === "blob");
    for (const path of paths) if (listing.get(path)!.type !== "blob") texts.set(path, null);
    if (blobs.length === 0) return;
    const output = gitBytes(repository, ["cat-file", "--batch"], Buffer.from(`${blobs.map((path) => listing.get(path)!.oid).join("\n")}\n`));
    let offset = 0;
    for (const path of blobs) {
      const newline = output.indexOf(0x0a, offset);
      const header = output.subarray(offset, newline).toString("utf8").split(" ");
      const size = Number(header[2]);
      if (header[1] !== "blob" || !Number.isInteger(size)) throw new HarnessError(`git cat-file --batch answered "${header.join(" ")}" for ${path} in ${commit}`, "tree_reader_git_failed");
      texts.set(path, output.subarray(newline + 1, newline + 1 + size).toString("utf8"));
      offset = newline + 1 + size + 1;
    }
  };
  const prefetch = (wanted: Iterable<string>): void => {
    let batch: string[] = [];
    let bytes = 0;
    for (const path of new Set(wanted)) {
      const entry = listing.get(path);
      if (entry === undefined || texts.has(path)) continue;
      if (batch.length > 0 && bytes + entry.size > batchBytes) {
        readBatch(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(path);
      bytes += entry.size;
    }
    if (batch.length > 0) readBatch(batch);
  };
  return deepFreeze({
    label: commit,
    paths: () => sorted,
    entry(path: string): TreeEntry | null {
      const entry = listing.get(path);
      return entry === undefined ? null : deepFreeze({ mode: entry.mode, oid: entry.oid });
    },
    text(path: string): string | null {
      if (!listing.has(path)) return null;
      if (!texts.has(path)) prefetch([path]);
      return texts.get(path) ?? null;
    },
    prefetch,
  });
}

/**
 * The files of the working tree at `root` (its top level): what the repository
 * OWNS (`ownedFiles`: the tracked files still on disk and the untracked files
 * no versioned ignore rule names — what any clone would commit) — read from
 * disk.
 */
export function workingTreeReader(root: string): TreeReader {
  const listed = ownedFiles(root);
  if (listed === undefined) throw new HarnessError(`${root} is not inside a git working tree`, "tree_reader_git_failed");
  const entries = new Map<string, TreeEntry>();
  for (const path of listed) {
    const stats = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stats === undefined) continue;
    const mode = stats.isSymbolicLink() ? SYMLINK_MODE : stats.isDirectory() ? GITLINK_MODE : (stats.mode & 0o111) !== 0 ? "100755" : "100644";
    entries.set(path, deepFreeze({ mode, oid: null }));
  }
  const sorted = deepFreeze([...entries.keys()].sort());
  const texts = new Map<string, string | null>();
  const text = (path: string): string | null => {
    const entry = entries.get(path);
    if (entry === undefined || entry.mode === GITLINK_MODE) return null;
    if (!texts.has(path)) texts.set(path, entry.mode === SYMLINK_MODE ? readlinkSync(join(root, path)) : readFileSync(join(root, path), "utf8"));
    return texts.get(path) ?? null;
  };
  return deepFreeze({
    label: `working tree ${root}`,
    paths: () => sorted,
    entry: (path: string): TreeEntry | null => entries.get(path) ?? null,
    text,
    prefetch(paths: Iterable<string>): void {
      for (const path of paths) text(path);
    },
  });
}

/** Writes `bytes` to the object store of `repository` (binary-safe) and answers the blob id. */
export function writeBlob(repository: GitRepository, bytes: Buffer | string): string {
  return gitBytes(repository, ["hash-object", "-w", "--stdin"], Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8")).toString("utf8").trim();
}

/**
 * Writes the tree holding exactly `entries` (path → mode and object id) and
 * answers its id. It is built in a private index of its own — an owned
 * temporary directory under `scratchDirectory` per call (the one
 * owned-temporary rule: removed after, and a crashed call's swept by the
 * next) — so neither the repository's index nor a concurrent or crashed
 * call's can leak into it; and
 * the written tree is read back and compared with `entries` before it is
 * answered (`tree_writer_mismatch`: a tree that holds anything else is never
 * returned).
 */
export function writeTree(repository: GitRepository, entries: ReadonlyMap<string, Readonly<{ mode: string; oid: string }>>, scratchDirectory: string): string {
  const directory = createOwnedTemporaryDirectory(scratchDirectory, "index-");
  const environment = { GIT_INDEX_FILE: join(directory, "index") };
  try {
    const info = [...entries].map(([path, entry]) => `${entry.mode} ${entry.oid}\t${path}\0`).join("");
    gitOutput(repository, ["update-index", "-z", "--index-info"], { input: Buffer.from(info, "utf8"), environment });
    const tree = gitOutput(repository, ["write-tree"], { environment }).stdout.toString("utf8").trim();
    const written = commitTreeReader(repository, tree);
    const stray = written.paths().filter((path) => {
      const entry = written.entry(path)!;
      const expected = entries.get(path);
      return expected === undefined || expected.mode !== entry.mode || expected.oid !== entry.oid;
    });
    const missing = [...entries.keys()].filter((path) => written.entry(path) === null);
    if (stray.length > 0 || missing.length > 0) {
      throw new HarnessError(`the tree ${tree} written in ${repository.root} does not hold exactly the ${String(entries.size)} entries given (missing: ${missing.slice(0, 8).join(", ") || "none"}; differing or unexpected: ${stray.slice(0, 8).join(", ") || "none"})`, "tree_writer_mismatch");
    }
    return tree;
  } finally {
    removeOwnedTemporaryDirectory(directory);
  }
}
