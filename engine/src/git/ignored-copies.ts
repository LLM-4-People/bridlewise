/**
 * IGNORED COPIES OF A DELETED FILE — the pairing the move-loss rule judges by,
 * and the one a deletion declaration binds to.
 *
 * A tracked file whose index entry is about to go while its exact bytes sit at
 * a path git ignores is the signature of a plain `mv` into an ignored folder
 * plus `git add -A`: the commit guard's move-loss check
 * (`engine/scripts/verification/staged-move-loss.ts`) refuses it. A
 * DELIBERATE deletion is declared (`declared-deletions.ts`), and the
 * declaration records the copies this pairing finds at declare time, so a copy
 * that appears later (the file came back and was moved by accident) is one
 * nobody declared. Both ask HERE, so the guard and the declaration can never
 * disagree about what a copy is.
 *
 * The population is what `git add -A` skipped on this machine
 * (`machineIgnoredFiles`: the versioned rules plus `.git/info/exclude` and
 * `core.excludesFile`), filtered by size before anything is hashed.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

import { HarnessError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { gitProcessEnvironment, machineIgnoredFiles, type GitEnvironment } from "./repository-ownership.ts";

/** A tracked file's content leaving the index at `path`, with the blob it held and that blob's size. */
export type DeletedBlob = Readonly<{
  /** Repository-relative path being removed from the index. */
  readonly path: string;
  /** The blob the path pointed at, from git's own raw diff (or HEAD's tree). */
  readonly blob: string;
  /** That blob's size in bytes — the cheap filter before any hashing. */
  readonly size: number;
}>;

/** A file on disk that git is ignoring, with the blob its bytes would produce. */
export type IgnoredFile = Readonly<{
  readonly path: string;
  readonly blob: string;
}>;

/** One tracked path whose content sits at an ignored path. */
export type MoveLoss = Readonly<{
  /** The path the index is losing. */
  readonly from: string;
  /** Where the identical bytes are sitting now — a path git ignores. */
  readonly to: string;
}>;

/** `git <argv>` in `root` with `input`, its stdout, or a typed refusal naming `code`. */
function git(root: string, argv: readonly string[], input: string, environment: GitEnvironment, code: string): string {
  const result = spawnSync("git", [...argv], {
    cwd: root, input, encoding: "utf8", env: gitProcessEnvironment(environment),
    maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes,
  });
  if (result.status !== 0) {
    throw new HarnessError(`git ${argv.join(" ")} failed in ${root} (status ${String(result.status)}): ${String(result.stderr ?? result.error?.message ?? "").trim()}`, code);
  }
  return result.stdout;
}

/**
 * The size of each of `blobs`, from ONE `cat-file --batch-check`. A blob the
 * store does not hold is a typed refusal (`git_blob_missing`): a size cannot
 * be guessed, and a check that skipped it would certify what it never saw.
 */
export function blobSizes(root: string, blobs: readonly string[], environment: GitEnvironment): ReadonlyMap<string, number> {
  const asked = [...new Set(blobs)];
  const sizes = new Map<string, number>();
  if (asked.length === 0) return sizes;
  const lines = git(root, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], `${asked.join("\n")}\n`, environment, "git_blob_unreadable")
    .split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    const [name, size] = line.split(" ");
    const bytes = Number(size);
    if (name !== undefined && Number.isSafeInteger(bytes)) sizes.set(name, bytes);
  }
  const missing = asked.filter((blob) => !sizes.has(blob));
  if (missing.length > 0) throw new HarnessError(`the object store of ${root} does not hold ${missing.join(", ")}`, "git_blob_missing");
  return sizes;
}

/**
 * Whether a deletion's blob IDENTIFIES the file it came from.
 *
 * ── THE EMPTY BLOB IS NOT AN IDENTITY, AND THAT BROKE THIS RULE ────────────
 *
 * Blob equality is git's own notion of "the same file" for every blob but
 * one. The empty blob (`e69de29b…`) is shared by every zero-byte file that
 * has ever existed, so a staged deletion of an empty file matches EVERY empty
 * ignored file on disk — and this tree keeps thousands of them under
 * `node_modules`.
 *
 * DRIVEN, on this repository: staging the deletion of `engine/
 * test_edit_tool.txt` (0 bytes) made the hook report the file as "still on
 * disk at" a dozen unrelated paths, among them `node_modules/undici/lib/
 * llhttp/.gitkeep` and five tar-fs test fixtures. Not one of them was a move.
 *
 * Both halves of that are damage, and the second is the worse one:
 *   - a deliberate deletion of any empty file is refused, which is a false
 *     refusal the guard's own test set already calls "turned off within a
 *     day, which is a worse outcome than not having it";
 *   - and a REAL empty-file move is indistinguishable from that noise, so
 *     there is no reading of the output under which the guard was working.
 *
 * WHY THE ANSWER IS "REPORT NOTHING" RATHER THAN "REPORT BETTER". The rule
 * exists because the BYTES survive while the index entry does not. A zero-byte
 * file has no bytes to survive; there is nothing for a `git clean` to destroy
 * that a `touch` does not restore. And with no distinguishing content there is
 * no evidence available at this door — the guard would have to guess by name,
 * which is exactly the rule it was written to avoid. Silence is the honest
 * answer, and it is recorded here rather than left as an unexplained `> 0`.
 *
 * WHY IT WAS INVISIBLE: the guard's false-positive test built its fixture with
 * `"# the only copy\n"`. Every deletion it ever judged had content, so the one
 * blob that carries no identity was never in the population. The test now
 * drives an empty file too.
 */
export function carriesLosableContent(deletion: DeletedBlob): boolean {
  return deletion.size > 0;
}

/**
 * The deletions whose exact content reappeared at an ignored path.
 *
 * CONTENT, NOT NAME. A rule keyed to the basename would miss `mv a/x.ts
 * b/renamed.ts` and would fire on two unrelated files that happen to share a
 * name — and the thing that makes this loss silent is precisely that the bytes
 * survive while the index entry does not. Blob equality is git's own notion of
 * "the same file", which is also what makes the answer cheap: the deletion
 * already carries its blob, and a candidate only has to be hashed at all if
 * its size matches one.
 *
 * ── A MOVE HAS TWO PATHS, AND `from === to` IS NOT ONE ────────────────────
 *
 * `git rm --cached <path>` untracks a file WHERE IT IS. It stages a deletion,
 * the bytes stay on disk at that same path, and if a rule now covers the path
 * it is also an ignored file — so the blob join above pairs the deletion with
 * ITSELF. The refusal that produced read `<path> is on disk at <path>, which
 * git IGNORES`, and its only sanctioned escape was "remove the copy on disk
 * first": for an in-place untracking that means deleting the very bytes the
 * operation exists to keep. The person who met it used `--no-verify`, which
 * turns this guard off for everything else in the same commit.
 *
 * SO IT IS ALLOWED, and the reason is mechanical rather than a reading of
 * intent. The loss this rule catches is silent because the bytes went
 * SOMEWHERE ELSE and nothing names where. Here they went nowhere: `git status`
 * shows a staged deletion of exactly the path that was typed, which is the
 * entire content of the operation.
 *
 * THE SAFETY IS IN THE PAIRING, NOT IN THE PRODUCER — and that correction was
 * earned. This paragraph used to claim the state had NO accidental producer:
 * "an ignore rule has no effect on a path already in the index, so `mv` plus
 * `git add -A`, `git mv`, and 'add a rule then `git add -A`' cannot reach it",
 * leaving `git rm --cached` and `git update-index --force-remove` as the only
 * two. THAT IS FALSE, and the third producer is this repository's own
 * sanctioned flow, driven end to end: add an ignore rule for a GENERATED
 * directory; a clean or a rebuild removes the file from disk; an ignore rule
 * does NOT protect a path that is in the index and absent from disk, so
 * `git add -A` stages the deletion; the deterministic generator then recreates
 * byte-identical content at the same path, which is now ignored. `from === to`,
 * reached with nobody typing `rm --cached`.
 *
 * The skip survives that discovery because it never depended on the producer.
 * It is PER PAIR: a deletion is dropped only against its OWN path, and every
 * other ignored path carrying the same blob still reports. A commit holding
 * both an in-place untracking and a REAL move of that same blob is therefore
 * still refused — driven, in the same repository, so "not refused" above can
 * never be a guard that stopped judging. An enumeration of producers is a
 * claim about the world and this one was wrong; the pairing is a property of
 * the rule, and it is what the exemption actually rests on.
 *
 * Two honest limits, stated because they bound the guarantee. A move that also
 * EDITS the file produces different bytes and is not detected here — the
 * mechanical `mv`, which is the shape that loses work by accident, is. And a
 * zero-byte file is skipped, for the reason `carriesLosableContent` records.
 */
export function movedIntoIgnored(
  deletions: readonly DeletedBlob[],
  ignored: readonly IgnoredFile[],
): readonly MoveLoss[] {
  const byBlob = new Map<string, string[]>();
  for (const file of ignored) {
    const paths = byBlob.get(file.blob) ?? [];
    paths.push(file.path);
    byBlob.set(file.blob, paths);
  }
  const losses: MoveLoss[] = [];
  for (const deletion of deletions) {
    if (!carriesLosableContent(deletion)) continue;
    for (const path of byBlob.get(deletion.blob) ?? []) {
      // The deletion paired with its OWN path is an in-place untracking, not a
      // move. Skipped here rather than filtered by the caller: this function is
      // what both the hook and the tests judge by, and a second opinion about
      // which pairs are moves is a second owner of the rule.
      if (path === deletion.path) continue;
      losses.push({ from: deletion.path, to: path });
    }
  }
  return losses;
}

/**
 * Every file on disk that git ignores on this machine whose size matches one
 * of `sizes`, hashed.
 *
 * The size filter is what keeps this affordable at commit time: the ignored
 * population is tens of thousands of files in these trees, and all but a
 * handful are excluded by a `stat` before anything is read. `--stdin-paths`
 * carries the survivors so the argument list can never overflow.
 */
function ignoredFilesOfSize(root: string, sizes: ReadonlySet<number>, environment: GitEnvironment): readonly IgnoredFile[] {
  if (sizes.size === 0) return [];
  const listed = machineIgnoredFiles(root, environment);
  // "Not a work tree" is never "no ignored files": an unread population would
  // pair nothing and certify the commit (wf-del2-design D10).
  if (listed === undefined) {
    throw new HarnessError(
      `${root}: git answers that this is not a work tree, so its ignored files cannot be listed and this ` +
        `check cannot tell whether the commit loses a file.`,
      "ignored_population_unreadable",
    );
  }
  const candidates: string[] = [];
  for (const path of listed) {
    // A path holding a newline cannot travel through `--stdin-paths`, which is
    // newline-delimited. Refusing to examine it is the deny-by-default answer;
    // silently skipping it would be a smaller universe nobody could see.
    if (path.includes("\n")) {
      throw new HarnessError(
        `${root}: the ignored path ${JSON.stringify(path)} contains a newline, so this check ` +
          `cannot hash it and cannot tell you whether this commit loses a file. Rename it.`,
        "ignored_path_unhashable",
      );
    }
    // A dangling symlink or a file removed under us is not a copy (absent);
    // any other stat failure is thrown: an unexamined file is never certified.
    const stats = statSync(path.startsWith("/") ? path : `${root}/${path}`, { throwIfNoEntry: false });
    if (stats !== undefined && sizes.has(stats.size)) candidates.push(path);
  }
  if (candidates.length === 0) return [];
  const hashes = git(root, ["hash-object", "--stdin-paths"], `${candidates.join("\n")}\n`, environment, "ignored_path_unhashable")
    .split("\n")
    .filter((line) => line.length > 0);
  if (hashes.length !== candidates.length) {
    throw new HarnessError(
      `${root}: hashed ${String(hashes.length)} of ${String(candidates.length)} candidate file(s); a short answer ` +
        `here would silently certify the commit.`,
      "ignored_path_unhashable",
    );
  }
  return candidates.map((path, index) => ({ path, blob: hashes[index] ?? "" }));
}

/**
 * THE PAIRING, ASKED OF ONE CHECKOUT: every ignored copy of each of
 * `deletions` (never its own path, never an empty blob), as move losses.
 * The commit guard asks it of the git being committed; a declaration asks it
 * of the checkout it is made in.
 */
export function ignoredCopies(root: string, deletions: readonly DeletedBlob[], environment: GitEnvironment): readonly MoveLoss[] {
  const losable = deletions.filter(carriesLosableContent);
  if (losable.length === 0) return [];
  return movedIntoIgnored(losable, ignoredFilesOfSize(root, new Set(losable.map((deletion) => deletion.size)), environment));
}
