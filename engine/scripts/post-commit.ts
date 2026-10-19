#!/usr/bin/env -S node --experimental-strip-types
/**
 * The program the `post-commit` hook runs (`.githooks/post-commit`): the
 * commit has landed, so every deletion declaration whose path HEAD no longer
 * holds is consumed, and every one whose path is on disk again expires
 * (`src/git/declared-deletions.ts`). Asked of the git that committed (the
 * hook's environment: a linked worktree's, or a `--git-dir` one), exactly as
 * the commit guard read them.
 *
 * It then asks the commit itself, with its real parents and message, whether
 * it acts on a workflow lesson without its `Lesson:` trailer
 * (`scripts/verification/lesson-trailers.ts`): `commit-msg` cannot see an
 * `--amend` (git does not tell it), nor a commit made with `--no-verify`, so
 * such a commit is REPORTED here with its repair.
 *
 * git ignores this hook's exit status, because the commit is already made. A
 * failure is printed and exits 1 for the record. Nothing is unsafe when this
 * does not run: a declaration left behind is stale for good (HEAD moved), so
 * the commit guard refuses it rather than re-using it, and
 * `harness deletions status` names it (`harness deletions clear` withdraws it).
 */

import { consumeDeclaredDeletions } from "../src/git/declared-deletions.ts";
import { bootstrapProcess, isEntryPoint } from "../src/runtime/cli-debug.ts";
import { LESSON_TRAILER, missingLessonTrailersOfCommit } from "./verification/lesson-trailers.ts";

/** Consumes the declarations the commit in `root` used, and says so on stderr. */
function consumeAfterCommit(root: string): void {
  try {
    // Central logging first: the consumption is an audit event.
    bootstrapProcess({ role: "cli" });
    const { head, consumed, expired, remaining } = consumeDeclaredDeletions(root, "inherited");
    if (consumed.length + expired.length > 0) {
      process.stderr.write(
        `[post-commit] ${String(consumed.length)} declared deletion(s) consumed by ${head ?? "(no HEAD)"}` +
          `${expired.length > 0 ? `; ${String(expired.length)} expired (the path is on disk again)` : ""}` +
          `${remaining > 0 ? `; ${String(remaining)} left, stale for good since HEAD moved (harness deletions status)` : ""}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`[post-commit] the deletion declarations could not be consumed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/** Reports the lessons HEAD acts on without naming them (an amend that dropped a trailer; a `--no-verify` commit). */
function reportUnnamedLessons(root: string): void {
  try {
    const missing = missingLessonTrailersOfCommit(root, "HEAD");
    if (missing.length === 0) return;
    process.stderr.write(
      `\n[post-commit] LESSON TRAILER MISSING — the commit just made turns workflow lessons to acted, and its message does not name them:\n` +
        `${missing.map((id) => `  - ${id}`).join("\n")}\n` +
        `Repair it now: git commit --amend, adding ${missing.map((id) => `${LESSON_TRAILER}: ${id}`).join(", ")} at the end of the message.\n\n`,
    );
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`[post-commit] the lesson trailer check could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

// Run as a program (the hook), never on import. Both sides are real paths, so
// a checkout reached through a symbolic link still runs it.
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const root = process.argv[2] ?? process.cwd();
  consumeAfterCommit(root);
  reportUnnamedLessons(root);
}
