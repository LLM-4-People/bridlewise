// src/shared/git-churn.ts
//
// Centralized per-file git-churn helper. The single owner for the
// "how many commits recently touched each file?" computation — consumed
// by the EXP455/EXP442 novel-principles implementations (AL2 Tierra
// dead-code fitness, Le Chatelier bandaid-debt, OBAFGKM temperature
// classification) and the awareness engine's git-history signal.
//
// This file exists because AL2/Le Chatelier/OBAFGKM all need per-file
// commit counts and were about to duplicate the same `git log` walk.
// Per DRY + "one canonical owner per concept", the
// computation lives here once.
//
// Research sources:
// - EXP442 (`novel-principles`): the 5 AL principles + 4 ACO approaches
// + 26 formulas. 6 POSITIVE findings documented in
// `experiments/exp455-benchmark-novel/merge-manifest.json`.
// - EXP455 (`benchmark-novel`): the merge manifest describing the 6
// findings that improve the harness, including the
// `git log --name-only` per-file churn computation.
// - Le Chatelier's principle (Gall's Systemantics adaptation): a
// system under stress reorganizes to absorb the stress; high churn
// with low function count = "reorganization debt" (bandaid code).
// - OBAFGKM stellar classification: temperature-graded classes from
// hottest (O) to coolest (M); applied to function churn percentile.
//
// No external code extracted; the `git log --name-only` walk is
// textbook. The shaped result (Map<file, count>) is the contract.

import { execSync } from "node:child_process";
import { InputError } from "../kernel/errors.ts";
import { resolveGitChurnConfig } from "./git-churn-config.ts";
import { median, pearson, percentileOf } from "./stats.ts";

// Re-export the canonical statistical helpers so existing imports from
// `git-churn.ts` continue to work. New code should import directly from
// `src/shared/stats.ts` (the canonical owner of statistical primitives).
export { median, pearson, percentileOf };

// R44: the tunable defaults are resolved through the canonical
// `resolveGitChurnConfig` owner (validates bounds at the trust boundary
//). The resolved config is computed once at module load
// (the defaults never change at runtime) and used as the fallback for
// `computeGitChurn`'s optional `depth`/`timeoutMs`. This makes the
// resolver USED (not a dead export).
const RESOLVED_GIT_CHURN_CONFIG = resolveGitChurnConfig();

/** Per-file commit count (churn) over a recent history window. */
export type GitChurnMap = ReadonlyMap<string, number>;

/** Per-file + per-function commit count, plus the raw commit list. */
export type GitChurnReport = Readonly<{
  /** Map of file path → commit count over the window. */
  fileChurn: GitChurnMap;
  /** Map of "<file>:<function>" → commit count (file-level churn propagated to functions). */
  functionChurn: ReadonlyMap<string, number>;
  /** Total commits in the window. */
  totalCommits: number;
  /** Whether the git history was actually read (false in a non-git dir). */
  hasGit: boolean;
}>;

export type GitChurnOptions = Readonly<{
  /** Number of recent commits to scan (default from `git-churn-config.ts`). */
  depth?: number;
  /** Skip git if false (returns an empty report). */
  useGit?: boolean;
  /** Per-commit timeout (ms) (default from `git-churn-config.ts`). */
  timeoutMs?: number;
}>;

/**
 * Compute per-file churn from `git log --name-only`. The walk is
 * O(commits × files-per-commit); for the default depth=100 on a
 * 10K-file codebase this is ~100K lines of git output (sub-second).
 *
 * The function is *defensive*: a non-git directory, a missing git
 * binary, or a git error returns an empty report (`hasGit: false`),
 * NOT a thrown error. Callers that need to distinguish "no git" from
 * "empty history" read `hasGit`.
 */
export function computeGitChurn(
  rootPath: string,
  options: GitChurnOptions = {},
): GitChurnReport {
  const depth = options.depth ?? RESOLVED_GIT_CHURN_CONFIG.defaultDepth;
  const useGit = options.useGit ?? true;
  const timeoutMs = options.timeoutMs ?? RESOLVED_GIT_CHURN_CONFIG.defaultTimeoutMs;

  if (!useGit) {
    return deepFreezeReport({
      fileChurn: new Map<string, number>(),
      functionChurn: new Map<string, number>(),
      totalCommits: 0,
      hasGit: false,
    });
  }

  const fileChurn = new Map<string, number>();
  let totalCommits = 0;
  let hasGit = false;

  try {
    // One git log call: %H (hash) %ct (commit timestamp) + NUL-separated
    // file list per commit. Using \0 between files avoids filename-with-
    // newline edge cases (rare but real). The commit header uses a unique
    // prefix so we can split commits apart from their file lists.
    const log = execSync(
      `git -C ${shellQuote(rootPath)} log -n ${depth} --no-merges --name-only --pretty=format:COMMIT__%H__%ct -z`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: timeoutMs },
    );
    hasGit = true;
    // The output is NUL-separated entries; commit headers start with COMMIT__.
    // Each commit header is followed by its changed files (until the next
    // COMMIT__ or end). Empty commits produce just the header with no
    // trailing files.
    const entries = log.split("\0");
    let inCommit = false;
    for (const entry of entries) {
      if (entry.startsWith("COMMIT__")) {
        inCommit = true;
        totalCommits += 1;
      } else if (entry.trim() !== "" && inCommit) {
        const normalized = entry.trim().replace(/\\/g, "/");
        fileChurn.set(normalized, (fileChurn.get(normalized) ?? 0) + 1);
      }
    }
  } catch {
    // Non-git dir, git error, or timeout — return an empty report.
    return deepFreezeReport({
      fileChurn: new Map<string, number>(),
      functionChurn: new Map<string, number>(),
      totalCommits,
      hasGit,
    });
  }

  return deepFreezeReport({
    fileChurn,
    functionChurn: new Map<string, number>(),
    totalCommits,
    hasGit,
  });
}

/**
 * Propagate per-file churn to per-function churn. Each function inherits
 * its file's churn count (a function is "hot" when its file is hot).
 * Finer granularity (per-function git blame) is a future enhancement;
 * file-level is sufficient for the EXP455 use cases (Le Chatelier,
 * OBAFGKM, AL2).
 */
export function propagateChurnToFunctions(
  fileChurn: GitChurnMap,
  functions: readonly Readonly<{ filePath: string; name: string }>[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const fn of functions) {
    const key = `${fn.filePath}:${fn.name}`;
    out.set(key, fileChurn.get(fn.filePath) ?? 0);
  }
  return out;
}

/**
 * Percentile of a value within a sorted-ascending array. Re-exported from
 * `src/shared/stats.ts` (the canonical statistical owner). Kept here as a
 * re-export so existing imports from `git-churn.ts` continue to work.
 *
 * @deprecated Import from `src/shared/stats.ts` directly for new code.
 */
// Re-exported above via `export { percentileOf }`.

/** Validate rootPath is a non-empty string (defensive guard). */
export function assertRootPath(rootPath: string): void {
  if (typeof rootPath !== "string" || rootPath.trim() === "") {
    throw new InputError("rootPath must be a non-empty string", "git_churn_invalid_root");
  }
}

// --- internals ------------------------------------------------------------

function deepFreezeReport<T extends GitChurnReport>(report: T): T {
  // Map is not deepFreeze-able; the contract is "callers treat as readonly".
  // The Map itself is shared by reference, so callers must not mutate it.
  return report;
}

/** Shell-quote a path for safe interpolation into a git command. */
function shellQuote(s: string): string {
  // Single-quote escape: replace ' with '\'' (the standard POSIX trick).
  return `'${s.replace(/'/g, "'\\''")}'`;
}
