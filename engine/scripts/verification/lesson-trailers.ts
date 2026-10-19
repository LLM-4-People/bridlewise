/**
 * A COMMIT THAT ACTS ON A LESSON SAYS SO: the `Lesson:` trailer.
 *
 * A workflow lesson (`docs/trackers/workflow-lessons/`) names the tracked
 * paths it was acted in, never a commit id: a hand-typed SHA is a hand-edited
 * generated value, and the commit that acts cannot contain its own. The link
 * to the commit goes the other way: the commit that turns a lesson to
 * `status: acted` carries `Lesson: L-<id>` in its message, so
 * `git log --grep='^Lesson: L-<id>'` finds it.
 *
 * ONE rule, asked of a commit and its parents ({@link lessonsActedAgainst}):
 * a lesson is acted on by a commit when it is `acted` in the commit's tree and
 * not in its FIRST parent (a lesson edited after it was acted needs no second
 * trailer), unless the commit is a merge and one of the commits it brings in
 * (`<first parent>..<other parent>`) already names it in its own trailer: a
 * merge of a branch whose commit acted and said so acts on nothing new, while
 * a merge of a branch whose commit acted WITHOUT the trailer is the first
 * commit on this line to carry that act, and must name it.
 *
 * Two places ask it:
 * - the `commit-msg` hook, BEFORE the commit (`--message <file>` of the commit
 *   guard, {@link missingLessonTrailers}): the tree is the index the commit
 *   records (read with the hook's own git environment: `git commit -a` and
 *   `-- <path>` hand the hook a temporary `GIT_INDEX_FILE`), the parents are
 *   `HEAD` plus every `MERGE_HEAD` (a merge being concluded). A missing
 *   trailer refuses the commit.
 * - the `post-commit` hook, AFTER it ({@link missingLessonTrailersOfCommit}):
 *   the commit itself, with its real parents and message. git tells
 *   `commit-msg` nothing about `--amend` (whose parents are HEAD's parents,
 *   not HEAD), so an amend that drops a trailer is only visible here; git
 *   ignores this hook's status, so it is REPORTED with the repair
 *   (`git commit --amend` with the trailer), never silently passed.
 *
 * The trailers are git's own parse of the raw message (`git interpret-trailers
 * --parse`): git skips comment lines by `core.commentChar` and stops at the
 * `git commit -v` scissors line. The key is matched exactly (`Lesson`),
 * because `git log --grep` is case-sensitive.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { basename } from "node:path";

import { pendingCommitParents } from "../../src/git/repository-ownership.ts";

import { DECISIONS_DIRECTORY, decisionViolations, lessonId, lessonViolations, LESSONS_DIRECTORY, parseFrontMatter } from "./tracker-entries.ts";

/** The trailer key a commit acting on a lesson carries (exact case: `git log --grep` finds it). */
export const LESSON_TRAILER = "Lesson";

function git(root: string, args: readonly string[], input?: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...(input === undefined ? {} : { input }) });
}

function statusOf(root: string, spec: string): string | undefined {
  const shown = spawnSync("git", ["show", spec], { cwd: root, encoding: "utf8" });
  if (shown.status !== 0) return undefined;
  return parseFrontMatter(shown.stdout)?.fields.get("status");
}

function lessonPaths(listing: string): readonly string[] {
  return listing.split("\0").filter((path) => path.startsWith(`${LESSONS_DIRECTORY}/`) && path.endsWith(".md"));
}

/** The `Lesson` values of git's parsed trailer lines (`Key: value`, one per line; the key exact). */
function lessonValues(parsed: string): readonly string[] {
  return parsed.split("\n").flatMap((line) => {
    const colon = line.indexOf(":");
    return colon > 0 && line.slice(0, colon).trim() === LESSON_TRAILER ? [line.slice(colon + 1).trim()] : [];
  });
}

/** The `Lesson:` trailer values the commits `first..merged` carry (exact key, as {@link lessonTrailers}). */
function namedByMergedCommits(root: string, first: string | undefined, merged: readonly string[]): ReadonlySet<string> {
  const named = new Set<string>();
  for (const parent of merged) {
    const range = first === undefined ? [parent] : [parent, `^${first}`];
    for (const id of lessonValues(git(root, ["log", "--format=%(trailers:only,unfold)", ...range, "--"]))) named.add(id);
  }
  return named;
}

/**
 * THE rule: of the `changed` lesson paths, the ids that are `acted` in the
 * tree `treeSpec` names (`""` for the index, else a commit), not acted in the
 * first of `parents`, and not already named by a commit the other parents
 * bring in.
 */
function lessonsActedAgainst(root: string, treeSpec: string, changed: readonly string[], parents: readonly string[]): readonly string[] {
  const [first, ...merged] = parents;
  const acted = changed
    .filter((path) => statusOf(root, `${treeSpec}:${path}`) === "acted" && (first === undefined || statusOf(root, `${first}:${path}`) !== "acted"))
    .map((path) => lessonId(basename(path)));
  const broughtIn = acted.length === 0 || merged.length === 0 ? new Set<string>() : namedByMergedCommits(root, first, merged);
  return acted.filter((id) => !broughtIn.has(id)).sort();
}

/** The ids of the lessons the staged change acts on (the commit being made: parents `HEAD` and any `MERGE_HEAD`). */
export function lessonsActedByStagedChange(root: string): readonly string[] {
  const changed = lessonPaths(git(root, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=AM", "-z", "--", `${LESSONS_DIRECTORY}/`]));
  return lessonsActedAgainst(root, "", changed, pendingCommitParents(root, "inherited"));
}

/** The ids of the lessons commit `commit` acts on, judged against its real parents. */
export function lessonsActedByCommit(root: string, commit: string): readonly string[] {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", commit]).trim().split(" ").slice(1);
  // Against the first parent (a merge commit too), or the whole tree of a root commit.
  const against = parents.length === 0 ? ["--root", commit] : [parents[0]!, commit];
  const changed = lessonPaths(git(root, ["diff-tree", "-r", "--no-commit-id", "--name-only", "--no-renames", "--diff-filter=AM", "-z", ...against, "--", `${LESSONS_DIRECTORY}/`]));
  return lessonsActedAgainst(root, commit, changed, parents);
}

/** The `Lesson:` trailer values of a raw commit message, as git parses them. */
export function lessonTrailers(root: string, message: string): readonly string[] {
  return lessonValues(git(root, ["interpret-trailers", "--parse"], message));
}

function missing(acted: readonly string[], root: string, message: string): readonly string[] {
  if (acted.length === 0) return [];
  const named = new Set(lessonTrailers(root, message));
  return acted.filter((id) => !named.has(id));
}

/** The lesson ids the staged change acts on that the message's trailers do not name (the `commit-msg` question). */
export function missingLessonTrailers(root: string, message: string): readonly string[] {
  return missing(lessonsActedByStagedChange(root), root, message);
}

/**
 * THE RECORDS THIS COMMIT WRITES NAME WHAT IT HOLDS: every lesson and
 * decision file the staged change adds or modifies is judged whole, and its
 * `acted_in` paths against the STAGED tree (tracked or staged). Asked by the
 * `commit-msg` door with the hook's own index; the whole-tree format tests
 * judge only the shape, so a later rename never turns a closed record red
 * (`tracker-entries.ts` `actedInCheck`).
 */
export function stagedTrackerEntryViolations(root: string): readonly string[] {
  const changed = (directory: string): readonly string[] =>
    git(root, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=AM", "-z", "--", `${directory}/`]).split("\0")
      .filter((path) => path.endsWith(".md") && basename(path) !== "README.md");
  const lessons = changed(LESSONS_DIRECTORY);
  const decisions = new Set(changed(DECISIONS_DIRECTORY).map((path) => basename(path)));
  if (lessons.length === 0 && decisions.size === 0) return [];
  const staged = new Set(git(root, ["ls-files", "-z"]).split("\0").filter((path) => path.length > 0));
  const stagedText = (path: string): string => git(root, ["show", `:${path}`]);
  const problems = lessons.flatMap((path) => lessonViolations(basename(path), stagedText(path), staged));
  if (decisions.size > 0) {
    // Judged with every staged decision (ids are unique together), reported for the changed ones.
    const all = [...staged].filter((path) => path.startsWith(`${DECISIONS_DIRECTORY}/`) && path.endsWith(".md") && basename(path) !== "README.md" && !path.slice(DECISIONS_DIRECTORY.length + 1).includes("/"));
    const entries = all.map((path) => ({ name: basename(path), text: stagedText(path) }));
    problems.push(...decisionViolations(entries, staged).filter((problem) => decisions.has(problem.slice(0, problem.indexOf(":")))));
  }
  return problems;
}

/** The lesson ids commit `commit` acts on that its own message does not name (the `post-commit` question). */
export function missingLessonTrailersOfCommit(root: string, commit: string): readonly string[] {
  return missing(lessonsActedByCommit(root, commit), root, git(root, ["log", "-1", "--format=%B", commit]));
}
