#!/usr/bin/env -S node --experimental-strip-types
/**
 * The program every `pre-commit` hook in these repositories runs.
 *
 * One entry point for all three trees, because the question is the same in
 * each and a hook copied per repository is three copies that drift. The hook
 * files are three lines of shell that resolve this path and hand over; the
 * rule, the wording and the git calls live in one owner.
 *
 * Exit 1 refuses the commit. Anything this program cannot answer is also a
 * refusal: a check that fails open certifies the commit it could not examine.
 *
 * The bypass is documented, not hidden: `git commit --no-verify` skips this
 * hook entirely — git's own design, and this door is a guard, not a lock.
 * Legitimate use is narrow: a deliberately uncertified work-in-progress
 * commit nobody will merge, or repairing the door's own machinery (a change
 * to this program that must land before a commit it would refuse can be
 * made). It is NEVER legitimate for routing around a refusal: a refused
 * commit is a report that the certificate is not earned, and force-landing
 * it pushes an uncertified tree — fix the code the door refuses, or fix the
 * door when IT is wrong, never the flag around either.
 */

import { frozenRecordsMessage, syncFrozenRecords } from "../src/workflow/record-links.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMIT_GUARD_PROGRAM, COMMIT_MESSAGE_FLAG, canonicalHookDuty, commitLossVerdict, hookTextIsCanonical, MERGE_COMMIT_FLAG, SHIPPED_HOOKS } from "./verification/staged-move-loss.ts";
import { LESSON_TRAILER, missingLessonTrailers, stagedTrackerEntryViolations } from "./verification/lesson-trailers.ts";
import { stagedRatchetGrowth } from "./verification/ratchet.ts";
import { qualificationEvidence, readRunHistory, readRunFailureRows, WEB_RUN_HISTORY_PATH } from "../src/shared/run-history.ts";
import { createWorkingCopy } from "../src/git/working-copy.ts";
import { FLAKE_CAUSE_TRAILER, flakeCauseTrailerProblems } from "../src/git/flake-cause-fixes.ts";
import { configuredGitRepository } from "../src/git/worktree-port.ts";
import { indexBaselineDrift } from "../src/git/index-baseline.ts";
import { directoryGitEnvironment, indexFilePath, repositoryToplevel, trackedFiles } from "../src/git/repository-ownership.ts";
import { ensurePrivateStateDirectory, ownedTemporaryName, PRIVATE_STATE_DIRECTORY_MODE, sweepAbandonedTemporaries } from "../src/filesystem/private-state.ts";
import { statePath } from "../src/kernel/product-identity.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import { bootstrapProcess } from "../src/runtime/cli-debug.ts";
import { loadPinnedConfigSnapshotIfPresent } from "../src/kernel/config.ts";
import { applyCheckoutFiles, engineRelativePath } from "../src/workflow/checkout-setup.ts";
import { pinnedBuildOutputPaths } from "../src/workflow/hash-binding-registry.ts";
import { parseHarnessCommandResult } from "../src/workflow/command-result.ts";

const root = process.argv[2] ?? process.cwd();
/** Handed by the `pre-merge-commit` shim: this is the commit `git merge` makes by itself. */
const mergeCommit = process.argv.slice(3).includes(MERGE_COMMIT_FLAG);

// Central logging first (an audit event from a sweep or a journal is heard).
// The bootstrap reads its section as data and never refuses; a crash here is
// the guard's own fault, and a crash certifies nothing.
try {
  bootstrapProcess({ role: "cli" });
} catch (error) {
  process.stderr.write(
    `\nCOMMIT REFUSED — central logging could not start, so this guard cannot run as designed:\n` +
      `${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exitCode = 1;
}
// ── THE MESSAGE NAMES THE LESSONS THIS COMMIT ACTS ON (commit-msg) ─────────
//
// The `commit-msg` hook hands over the message file: a commit that turns a
// workflow lesson to `acted` (acted in the index, not in HEAD, and not named
// by a commit a MERGE_HEAD brings in) carries `Lesson: L-<id>` for each one
// (scripts/verification/lesson-trailers.ts), and every lesson or decision
// file it adds or changes is well formed with its `acted_in` paths held by
// the staged tree (the one time they are judged against a tree). The staged
// tree's code was certified by `pre-commit` a moment before.
const messageAt = process.argv.indexOf(COMMIT_MESSAGE_FLAG, 3);
if (messageAt >= 0) {
  try {
    const messageFile = process.argv[messageAt + 1];
    if (messageFile === undefined) throw new Error(`${COMMIT_MESSAGE_FLAG} needs the message file git hands the commit-msg hook`);
    const records = stagedTrackerEntryViolations(root);
    if (records.length > 0) {
      process.stderr.write(
        `\nCOMMIT REFUSED — a workflow lesson or decision this commit writes is malformed, or names a path the commit does not hold:\n` +
          `${records.map((problem) => `  - ${problem}`).join("\n")}\n\n`,
      );
      process.exitCode = 1;
    }
    const message = readFileSync(messageFile, "utf8");
    // A `Flake-cause:` trailer is judged HERE, once: a malformed one in pushed
    // history can only be reported and ignored (src/git/flake-cause-fixes.ts).
    const flakeCauses = flakeCauseTrailerProblems(configuredGitRepository({}, root), message);
    if (flakeCauses.length > 0) {
      process.stderr.write(
        `\nCOMMIT REFUSED — a ${FLAKE_CAUSE_TRAILER} trailer of this message is malformed (a declaration nobody can evaluate):\n` +
          `${flakeCauses.map((problem) => `  - ${problem}`).join("\n")}\n\n`,
      );
      process.exitCode = 1;
    }
    const missing = missingLessonTrailers(root, message);
    if (missing.length > 0) {
      process.stderr.write(
        `\nCOMMIT REFUSED — this commit turns workflow lessons to acted, and its message does not name them:\n` +
          `${missing.map((id) => `  - ${id}`).join("\n")}\n\n` +
          `Add one trailer per lesson at the end of the message (${missing.map((id) => `${LESSON_TRAILER}: ${id}`).join(", ")}; the key is case-sensitive), so git log --grep finds the commit that acted.\n\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `\nCOMMIT REFUSED — the lesson trailer check could not run, so it cannot say this message names the lessons it acts on:\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n`,
    );
    process.exitCode = 1;
  }
  process.exit();
}

/** This guard's own engine; the repository-relative path is derived from it, never spelled. */
const ENGINE_ROOT = fileURLToPath(new URL("../", import.meta.url));
if (basename(fileURLToPath(import.meta.url)) !== COMMIT_GUARD_PROGRAM) throw new Error(`the guard program is named ${COMMIT_GUARD_PROGRAM} in staged-move-loss.ts; rename both together`);
/** Each staged-tree materialization is an owned temporary `staged-<pid>-<start time>-<nonce>` (see the sweep). */
const MATERIALIZATION_PREFIX = "staged-";

try {
  const { failure, accepted } = commitLossVerdict(root, mergeCommit);
  if (accepted.length > 0) {
    // Heard, never silent: a deletion with an ignored copy passes only because
    // somebody declared it (src/git/declared-deletions.ts), and says so here.
    process.stderr.write(
      `\nDECLARED DELETIONS — ${String(accepted.length)} staged deletion(s) with an ignored copy are accepted as declared:\n` +
        `${accepted.map((judged) => `  ${judged.deletion.path} (blob ${judged.deletion.blob}); the ignored copies stay on disk at ${judged.copies.join(", ")}`).join("\n")}\n\n`,
    );
  }
  if (failure !== null) {
    process.stderr.write(`\nCOMMIT REFUSED — a file would leave the index\n\n${failure}\n\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `\nCOMMIT REFUSED — the move check could not run, so it cannot say this commit is safe:\n` +
      `${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  // A crashed check certifies nothing: the refusal is the EXIT CODE, not the
  // message — printing "COMMIT REFUSED" and exiting 0 lets the commit
  // proceed, which is failing open.
  process.exitCode = 1;
}

// ── THE CERTIFICATE DESCRIBES THE STAGED TREE ────────────────────────────
//
// A commit records the INDEX, not the working tree. Both legs below — the
// compile (both trees, in parallel) and the generated facts (`harness check`)
// — therefore run in a MATERIALIZATION OF THE INDEX (the working-copy
// builder's "staged" mode: its files are the staged blobs, its index the
// source's), never in the working tree. Two shapes the working-tree check
// certified and this one refuses: regenerated outputs staged without the
// source that produced them, and staged sources that compile or pin only
// because of an UNSTAGED second file. And the reverse false positive is
// gone: a partially staged hand edit of a pin-bearing file is judged on its
// staged bytes, not refused because the working tree differs.
//
// The compile is part of the certificate: the suites strip types (esbuild
// strips, never type-errors), so a commit can be green-tested and
// red-compiled. The generated facts are too: a commit that edits an engine
// source without regenerating the manifest, pins, schema artifact or
// bindings lands an incoherent tree that compiles cleanly.
let stagedAll: string[];
let staged: string[];
try {
  // `-z` so a path holding a newline arrives RAW, never C-quoted: the quoted
  // form's trailing `"` would make every extension filter miss the file, and
  // the move check (the other read of this same index) decodes with `-z`.
  // `--no-renames` so a staged RENAME or move lists BOTH sides: with rename
  // detection git names only the new path, and a move of an engine source to
  // `attic/x.txt` selected neither leg while the tree no longer compiled
  // (wf1a-correctness §3). The old path is a deletion; deletions are listed.
  stagedAll = execFileSync("git", ["diff", "--cached", "--name-only", "--no-renames", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((name) => name.length > 0);
  staged = stagedAll
    // Code-shaped: things that change what the same sources compile to.
    // Sources, yes — and manifests/lockfiles too: a dependency-resolution
    // edit (package.json, package-lock.json) changes the compiled result
    // without touching a single source byte, so the legs must re-prove it.
    .filter((name) => /\.(?:ts|mts|svelte)$/u.test(name) || /(?:^|\/)(?:package\.json|package-lock\.json|tsconfig[^/]*\.json)$/u.test(name));
} catch (error) {
  stagedAll = [];
  staged = [];
  process.stderr.write(
    `\nCOMMIT REFUSED — the staged file list could not be read, so no door can say this commit is safe:\n` +
      `${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exitCode = 1;
}
// The engine's place in a repository, derived from THIS guard's own checkout
// (the hook of every tree runs the guard of a tree with the same layout; a
// test fixture runs the real guard against a scratch repository). Asked of
// the engine's DIRECTORY, never with the hook's environment: in a linked
// worktree (the live checkout is one) and under `--git-dir`, git hands the
// hook `GIT_DIR`, and `--show-toplevel` from `<top>/engine` then answers
// `<top>/engine` — the engine's place was "", no facts leg ran and the
// "engine" compile leg re-ran the web one (wf1b-correctness §2 N1).
let engineRelative = "";
if (process.exitCode === undefined) {
  try {
    const guardRepository = repositoryToplevel(ENGINE_ROOT, "directory");
    if (guardRepository === undefined) throw new Error(`the commit guard's own engine ${ENGINE_ROOT} is not inside a git working tree`);
    engineRelative = engineRelativePath(guardRepository, ENGINE_ROOT);
    if (engineRelative.length === 0 || engineRelative.startsWith("..")) {
      throw new Error(`the commit guard's engine ${ENGINE_ROOT} resolved to ${JSON.stringify(engineRelative)} in ${guardRepository}, not a folder below its top`);
    }
  } catch (error) {
    process.stderr.write(
      `\nCOMMIT REFUSED — the guard could not locate its own engine, so it cannot say which legs this commit needs:\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n`,
    );
    process.exitCode = 1;
  }
}
// ── THE HOOKS STAY IN PLACE ──────────────────────────────────────────────
//
// git runs a hook only when its file is executable, and ignores it silently
// otherwise. A commit that drops the bit from a tracked hook therefore
// disables THIS guard in every checkout that takes it — and it passed every
// leg, because a mode-only change stages no code (wf1c-correctness §3). The
// same holds for a commit that DELETES a guarded hook (`git rm --cached`, a
// `git mv` away) or stages a guarded hook that no longer hands over to this
// program (wf1b-correctness §2 N5). The hooks directory is git's own answer
// (`--git-path hooks` honours `core.hooksPath`), never a spelled name. What
// no pre-commit hook can see (the working-tree `chmod -x`, `rm` or rewrite
// that disables the hook BEFORE git would run it) is the installation check
// of both suites (`readHookInstallations`).
if (process.exitCode === undefined) {
  try {
    const problems = hookIntegrityProblems(root);
    if (problems.length > 0) {
      process.stderr.write(
        `\nCOMMIT REFUSED — this commit disables a tracked hook, and git silently skips a hook it cannot execute:\n` +
          `${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
          `Restore it (git update-index --chmod=+x -- <path>, or restore its content and git add), or commit the removal with --no-verify deliberately.\n\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `\nCOMMIT REFUSED — the hook check could not run, so it cannot say this commit keeps its hooks:\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n`,
    );
    process.exitCode = 1;
  }
}

// ── A RATCHET BASELINE ONLY SHRINKS (scripts/verification/ratchet.ts) ─────
//
// A guard's accepted-debt baseline is judged by the suite against the
// baseline as COMMITTED, so a commit that grows the list would make the
// grown list the next floor. Every staged baseline is judged against HEAD
// here: an added entry (or a copy of an entry) refuses the commit, and a
// staged baseline with an entry that gives no reason does not parse.
if (process.exitCode === undefined) {
  try {
    const grown = stagedRatchetGrowth(root, stagedAll);
    if (grown.length > 0) {
      process.stderr.write(
        `\nCOMMIT REFUSED — a ratchet baseline grew; accepted debt only shrinks:\n` +
          `${grown.map(({ path, grown: keys }) => `  ${path}:\n${keys.map((key) => `    + ${key}`).join("\n")}`).join("\n")}\n\n` +
          `Fix the new sites instead of listing them, and unstage the added entries.\n\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `\nCOMMIT REFUSED — the ratchet baselines could not be judged, so no door can say this commit keeps them shrinking:\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n`,
    );
    process.exitCode = 1;
  }
}

// ── THE LIVE INDEX AGAINST ITS RECORDED BASELINE (src/git/index-baseline.ts) ──
//
// Never a refusal (a commit legitimately changes what is staged), always
// heard: a protected staged blob (one HEAD does not hold) that is no longer
// staged is about to be lost — whether this commit carries the change (a
// committed `git rm --cached` of an inherited modification: after the commit
// nothing would say so again) or not (a `git restore --staged` nobody is
// committing).
try {
  const drift = indexBaselineDrift(root);
  if (drift.state === "drifted") {
    const committing = new Set(stagedAll);
    process.stderr.write(
      `\nINDEX WARNING — staged blobs recorded in the live index baseline are no longer staged, and HEAD does not hold them:\n` +
        `${drift.lost.map((path) => `  - ${path}${committing.has(path) ? " (THIS commit records the change)" : ""}`).join("\n")}\n\n` +
        `If that was not deliberate, abort and restore them exactly: ${drift.repair.join(" ")} (engine CLI).\n\n`,
    );
  }
} catch (error) {
  process.stderr.write(`\nINDEX WARNING — the index baseline could not be compared: ${error instanceof Error ? error.message : String(error)}\n\n`);
}

const compileLegs = staged.length > 0;
const factsLeg = stagedAll.some((name) => name.startsWith(`${engineRelative}/`));
// EVERY commit is certified for its frozen records, whatever paths it touches (round 13, R3-3): nearly every frozen
// root lies under docs/, so a docs-only commit could rewrite history unseen when this ran only with the engine leg.
if (process.exitCode === undefined) {
  let stagedTree: string | undefined;
  try {
    stagedTree = materializeStagedTree(root);
    if (compileLegs) await refuseUncompilableStagedTree(stagedTree);
    const checked = factsLeg && existsSync(join(stagedTree, engineRelative, ROOT_POLICY.sourcePath));
    // `harness check` over the staged engine includes the frozen step; without it, the frozen step runs alone.
    if (checked) refuseStaleGeneratedFacts(join(stagedTree, engineRelative));
    else refuseStaleFrozenRecords(stagedTree);
  } catch (error) {
    process.stderr.write(
      `\nCOMMIT REFUSED — the staged tree could not be certified, so no door can say this commit is safe:\n` +
        `${error instanceof Error ? error.message : String(error)}\n\n`,
    );
    process.exitCode = 1;
  } finally {
    if (stagedTree !== undefined) rmSync(stagedTree, { recursive: true, force: true });
  }
}

/**
 * The index of `repositoryRoot`, materialized in a private directory of its
 * state root (same filesystem, ignored): the staged blobs, the source's
 * index, the ignored build outputs the pins describe, the declared links and
 * the installed dependencies (each tracked lockfile's `node_modules`, linked
 * from the working tree — the commit never carries them).
 */
function materializeStagedTree(repositoryRoot: string): string {
  const parent = ensurePrivateStateDirectory(join(repositoryRoot, statePath("state", "commit-guard")));
  // A guard killed mid-run (Ctrl-C, a closed terminal, the OOM killer) never
  // reaches its `finally` and leaves a WHOLE materialized tree behind (109 MB
  // and 5,076 files were found in one candidate): each materialization is an
  // owned temporary, and what a dead guard left is removed before a new one
  // is made. A live guard's tree (a concurrent commit) is never touched.
  sweepAbandonedTemporaries(parent, MATERIALIZATION_PREFIX);
  const target = join(parent, ownedTemporaryName(MATERIALIZATION_PREFIX));
  mkdirSync(target, { mode: PRIVATE_STATE_DIRECTORY_MODE });
  // The index file THIS commit records, read with the hook's own environment
  // (`git commit -a`, `-- <path>` and `-i` hand the hook a temporary
  // `GIT_INDEX_FILE`): the staged list above is read the same way, so the list
  // and the materialized tree describe one index.
  createWorkingCopy({ sourceRoot: repositoryRoot, targetRoot: target, git: "staged", index: indexFilePath(repositoryRoot, "inherited"), carry: pinnedBuildOutputPaths() });
  const dependencyLinks = (trackedFiles(repositoryRoot) ?? [])
    .filter((path) => basename(path) === "package-lock.json")
    .map((path) => join(dirname(path), "node_modules").split(sep).join("/"));
  const links = [...(loadPinnedConfigSnapshotIfPresent()?.document.workspaceIsolation?.links ?? []), ...dependencyLinks];
  const steps = applyCheckoutFiles(target, repositoryRoot, engineRelative, { links });
  const failed = steps.filter((step) => step.status === "fail");
  if (failed.length > 0) throw new Error(`the staged tree could not be prepared: ${failed.map((step) => step.message).join("; ")}`);
  return target;
}

/**
 * What the staged change does to the tracked hooks, read from the index being
 * committed (`--raw -z`: `:<old mode> <new mode> <old> <new> <status>\0<path>\0`):
 * an executable hook that stops being an executable file, a guarded hook
 * deleted, a guarded hook whose staged text no longer hands over to the guard.
 */
function hookIntegrityProblems(repositoryRoot: string): readonly string[] {
  const hooks = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const relativeHooks = relative(repositoryRoot, hooks).split(sep).join("/");
  if (relativeHooks.startsWith("..") || relativeHooks.length === 0) return [];
  const guarded = new Set<string>(SHIPPED_HOOKS.map((hook) => `${relativeHooks}/${hook}`));
  const fields = execFileSync("git", ["diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "-z"], { cwd: repositoryRoot, encoding: "utf8" }).split("\0");
  const problems: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, , newObject] = fields[index]!.replace(/^:/u, "").split(" ");
    const path = fields[index + 1]!;
    if (!path.startsWith(`${relativeHooks}/`)) continue;
    if (newMode === "000000") {
      if (guarded.has(path)) problems.push(`${path}: deleted — a shipped hook (it ${canonicalHookDuty(path.slice(relativeHooks.length + 1))})`);
    } else if (oldMode === "100755" && newMode !== "100755") {
      problems.push(`${path}: removes the execute bit (mode ${newMode ?? "?"})`);
    } else if (guarded.has(path) && newMode !== "100755") {
      problems.push(`${path}: staged as mode ${newMode ?? "?"}, not an executable file`);
    } else if (guarded.has(path) && !hookTextIsCanonical(execFileSync("git", ["cat-file", "blob", newObject!], { cwd: repositoryRoot, encoding: "utf8" }), path.slice(relativeHooks.length + 1))) {
      problems.push(`${path}: its staged text is not canonical: it no longer ${canonicalHookDuty(path.slice(relativeHooks.length + 1))}`);
    }
  }
  return problems;
}

type LegOutcome = Readonly<{ label: string; status: number | null; output: string }>;

function runTypecheckLeg(directory: string, label: string): Promise<LegOutcome> {
  return new Promise((resolveLeg) => {
    const chunks: Buffer[] = [];
    const child = spawn("npm", ["run", "typecheck"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => resolveLeg({ label, status: null, output: `${Buffer.concat(chunks).toString("utf8")}${error.message}` }));
    child.once("close", (status) => resolveLeg({ label, status, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** Both trees' compile legs, in parallel, over the STAGED tree; each leg's output is printed whole. */
async function refuseUncompilableStagedTree(stagedTree: string): Promise<void> {
  const outcomes = await Promise.all([runTypecheckLeg(stagedTree, "web"), runTypecheckLeg(join(stagedTree, engineRelative), "engine")]);
  for (const outcome of outcomes) {
    process.stderr.write(`\n[commit-guard] ${outcome.label} typecheck (staged tree):\n${outcome.output}`);
    if (outcome.status !== 0) {
      process.stderr.write(
        `\nCOMMIT REFUSED — the staged ${outcome.label} tree does not compile (the suites strip types, the compiler is the certificate).\n\n`,
      );
      process.exitCode = 1;
    }
  }
}

/** The frozen records of the staged tree against its pinned manifest (the check's frozen step, alone): a change refuses the commit, named. */
function refuseStaleFrozenRecords(stagedTree: string): void {
  const report = syncFrozenRecords(stagedTree, false);
  process.stderr.write(`\n[commit-guard] frozen records (staged tree): ${report.converged ? "pass" : "fail"}\n`);
  if (!report.converged) {
    process.stderr.write(`\nCOMMIT REFUSED — ${frozenRecordsMessage(report)}\n\n`);
    process.exitCode = 1;
  }
}

/**
 * `harness check --skip-typecheck` over the staged engine, run by the STAGED
 * checker itself (the check's own code may be part of the commit).
 */
function refuseStaleGeneratedFacts(engineRoot: string): void {
  const check = spawnSync(process.execPath, [join(engineRoot, "src", "cli.ts"), "harness", "check", "--skip-typecheck"], {
    cwd: engineRoot, env: directoryGitEnvironment(), encoding: "utf8", maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes,
  });
  const payload = check.stdout.trim().split("\n").at(-1) ?? "";
  let result: { allPassed?: unknown } & Record<string, unknown>;
  try {
    result = parseHarnessCommandResult(JSON.parse(payload)).result as typeof result;
  } catch {
    throw new Error(`harness check produced no result payload (status ${String(check.status)}): ${`${check.stdout}${check.stderr}`.trim().split("\n").slice(-8).join("\n")}`);
  }
  const steps = Object.values(result).filter((step): step is Readonly<{ step?: unknown; status?: unknown }> => typeof step === "object" && step !== null && "step" in step);
  if (result.allPassed === true) {
    // A pass is said too (PROMO2-F1): a promotion's answer shows which legs certified the tree.
    process.stderr.write(`\n[commit-guard] staged generated facts (harness check --skip-typecheck): pass (${String(steps.filter((step) => step.status === "pass").length)} step(s) passed, ${String(steps.filter((step) => step.status === "skip").length)} skipped)\n`);
    return;
  }
  const failing = Object.values(result).flatMap((step) =>
    typeof step === "object" && step !== null && (step as { status?: unknown }).status === "fail"
      ? [`  - ${String((step as { step?: unknown }).step)}: ${String((step as { message?: unknown }).message)}`] : []);
  process.stderr.write(
    `\nCOMMIT REFUSED — the STAGED engine's generated facts do not match its staged sources:\n${failing.join("\n")}\n\n` +
      `Regenerate them (cd engine && node src/cli.ts harness sync --with-bundle), review the diff, and stage the ` +
      `regenerated outputs TOGETHER WITH every source they were generated from (git add -- <paths>).\n\n`,
  );
  process.exitCode = 1;
}

// BASELINE LOUDNESS — never a refusal (a refused commit cannot BE the fix),
// always heard once the suite has run even once. The class it closes: a red
// full-suite baseline went unnoticed for DAYS (2026-08-29: ~100 failures on
// clean HEAD) because verification ran subsets whose green said nothing
// about the whole, and nothing at commit time said "the last full pass was
// red." The ledger already records every judged run; this reads the latest
// and prints its failure count loud — piling onto a red baseline is legal
// (the fix commits do exactly that), but it is never again silent. A ledger
// that cannot be read or has never been written warns in the same breath:
// "no full run has ever certified this tree" is itself a red flag, not a
// green light.
try {
  const historyPath = join(root, WEB_RUN_HISTORY_PATH);
  const currentEvidence = readRunHistory(historyPath).at(-1);
  if (currentEvidence !== undefined) process.stderr.write(`\nRUN EVIDENCE — ${qualificationEvidence(currentEvidence)}\n`);
  const failures = readRunFailureRows(historyPath);
  if (failures.length === 0) {
    process.stderr.write(
      `\nBASELINE WARNING — the judged-run ledger is empty: no full-suite run ` +
        `has ever certified this tree on THIS machine. Subset greens say ` +
        `nothing about the whole; run the full suite ("npm test") before ` +
        `treating any verification as complete.\n\n`,
    );
  } else {
    const latest = failures[failures.length - 1];
    if (latest !== undefined && latest.failures.length > 0) {
      let staleness = "";
      const judged = readRunHistory(historyPath);
      const latestJudged = judged[judged.length - 1];
      if (latestJudged?.headSha !== undefined) {
        try {
          const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
          if (head !== latestJudged.headSha) {
            staleness =
              ` (measured at ${latestJudged.headSha.slice(0, 9)}, HEAD is now ${head.slice(0, 9)} — ` +
              `fix commits have landed since, which is expected; it does not prove green)`;
          }
        } catch (err) {
          // HEAD unreadable → leave staleness unsaid rather than guess, but
          // say WHY on stderr so a broken checkout is visible instead of
          // silently skipping the check.
          process.stderr.write(
            `[commit-guard] HEAD unreadable, staleness note skipped: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      // A row a candidate's copy-back imported says where it was measured.
      const measuredIn = latest.importedFrom === undefined ? "" : `, measured in the candidate ${latest.importedFrom}`;
      process.stderr.write(
        `\nBASELINE WARNING — the last recorded full-suite run (${latest.timestamp ?? "time unknown"}${measuredIn}) ` +
          `had ${String(latest.failures.length)} failure row(s)${staleness}:\n` +
          latest.failures.map((f) => `  - ${f}`).join("\n") +
          `\n\nIf this commit IS the fix, carry on — the next full run re-judges. ` +
          `If it is not, you are piling commits onto a red baseline.\n\n`,
      );
    }
  }
} catch {
  process.stderr.write(
    `\nBASELINE WARNING — the judged-run ledger could not be read, so this commit ` +
      `has no answer to "was the last full suite green?". A loudness check that ` +
      `fails open would be worse than none, but a missing answer is not a green — ` +
      `run the full suite before trusting subset-only verification.\n\n`,
  );
}
