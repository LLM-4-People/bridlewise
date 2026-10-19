import { execFileSync } from "node:child_process";

import { handleError } from "../shared/debug/debug-system.ts";
import type { GitCommandRunner } from "./types.ts";

/**
 * THE COMMAND-LINE HARNESS'S OWN GIT RUNNER — the direct one, and the only
 * host that may honestly use it.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
 *
 * The awareness engine does not start programs; it is handed a
 * {@link GitCommandRunner} by whatever is running it (see the port's own
 * documentation for the escape that made that necessary). This file is ONE
 * implementation of that port: run git here, in this process, with this
 * process's authority.
 *
 * That is correct for the command-line harness and for nothing else. The CLI
 * bootstrap applies the Landlock guardian to ITSELF before any work begins,
 * and the restriction is irrevocable and inherited across every fork and exec
 * — so a program git decides to run from the project's own `.git/config` is
 * already inside the same sandbox as everything else the harness does, and
 * running it is authority the harness already had.
 *
 * A HOST THAT IS NOT ITSELF CONFINED MUST NOT USE THIS. The web server runs
 * the engine in a worker thread of an unconfined process; it supplies its own
 * runner, which puts git behind the same guardian as every other subprocess it
 * starts. The separation is the whole point: two hosts, two honest answers,
 * one engine that has no opinion because it has no capability.
 *
 * ── AN ARGUMENT VECTOR, NOT A COMMAND LINE ────────────────────────────────
 *
 * `execFileSync` with an argument list, never `execSync` with a string. There
 * is no shell, so there is nothing to quote for: a repository path containing
 * a quote, a space, a `$` or a `;` is one argument and cannot become syntax.
 * The hand-rolled `shellQuote` this replaces was correct as far as it went,
 * and "as far as it went" is not a property anybody can check by reading.
 *
 * ── FAILURE IS `null`, AND `null` IS NOT EMPTINESS ────────────────────────
 *
 * A directory that is not a repository, a git that is not installed, a
 * timeout, a non-zero exit — all of them are `null`, which the engine reads as
 * "no history was obtained". It never reads them as "this project has no
 * commits", because reporting an absent measurement as a zero is the
 * fabrication this codebase keeps rediscovering.
 */
export function runGitDirectly(...args: Parameters<GitCommandRunner>): string | null {
  const [rootPath, gitArgs, timeoutMs] = args;
  try {
    return execFileSync("git", ["-C", rootPath, ...gitArgs], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: timeoutMs,
    });
  } catch (error) {
    handleError(error, { module: "awareness/git-command-runner", operation: "runGitDirectly" });
    return null;
  }
}
