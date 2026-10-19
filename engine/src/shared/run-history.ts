/**
 * THE RUN-HISTORY LEDGER — the judged runs of BOTH suites.
 *
 * Each CPU verdict is ONE run against the cap in force (UR-24-BUDGETS); the
 * ledger is what the rolling baseline and the measuring tool read (D-17), and
 * what the flaky memory judges. That memory is an append-and-trim ledger of judged full runs, and this module
 * is its one reader and one writer. It was hoisted from the web repository's
 * `tests/helpers/budget-history.ts` (which is now a thin binding of the
 * default web path onto these functions) when the integration runner grew
 * the same gate: two ledgers with two parsers drift, one owner cannot.
 *
 * THE PATH IS REQUIRED, NEVER DEFAULTED. Each runner owns its ledger's
 * location (web: `tests/helpers/budget-paths.ts`; integration:
 * `src/workflow/test-result-collector.ts`), and a default here would be a
 * second source of truth for a path — the fallback-source shape, firing
 * exactly when the real owner is missing.
 *
 * WHAT ENTERS, AND WHAT DELIBERATELY DOES NOT. Only runs the verdict JUDGED
 * are appended — the caller writes a record after judging, never before. A
 * refused run (a subset, a cold cache, a missing CPU reading) proved nothing
 * about the tree, so it must never feed a baseline; keeping it out of the
 * file entirely is the simplest spelling of "skip". Refusals are loud where they happen — every one is
 * printed on the run's own summary line.
 *
 * GARBAGE TOLERANCE, AND WHICH DIRECTION IT LEANS. A missing or corrupt file
 * is an EMPTY history: the rolling baseline then stands at its declared
 * floor (the cold start) — it can never manufacture a red or loosen a cap. Individual malformed entries are skipped the
 * same way.
 *
 * ROOM TO GROW: records are carried and re-written as the raw objects that
 * were parsed, so fields this module does not read (for instance the
 * integration runner's per-run failure rows, which a flaky-test guard wants
 * in the same ledger) survive a rewrite instead of being stripped by it.
 *
 * PROVISIONAL FAILURE ROWS. A judged run taken on a working tree whose
 * TRACKED content differs from HEAD (uncommitted edits — the natural
 * iterate-then-verify loop of building a fix) measured code the next writer's
 * baseline will never see: the committed tree. Its failure rows are therefore
 * marked PROVISIONAL at the append site — `provisionalFailures: true`,
 * derived by the tree-identity owner (`provisionalFailureMark` in
 * `tree-identity.ts`), which owns the porcelain subprocess and which the
 * server's import graph cannot reach. This module deliberately holds NO
 * spelling of that judgement: it is server-reachable, and any subprocess
 * reference here — even a dynamic import of the owner — would put the spawn
 * one hop from the server, the escape the confinement boundary exists to
 * refuse. The flaky-test verdict weights the two kinds of row differently:
 * a suspect must have failed on a run whose tracked tree was CLEAN — a
 * dirty-tree failure alone is a mid-edit iteration, not evidence the
 * committed code is broken. A row that cannot say how its tree stood (a
 * legacy entry, a malformed flag) counts as a REAL failure: absence of
 * provenance is not innocence.
 *
 * DELIBERATE-MUTATION ROWS. A run launched as a mutation verification
 * (`HARNESS_MUTATION_RUN=1` — the operator plants a defect, runs the owning
 * suite to watch it red, restores) carries `mutationRun: true`, derived by
 * the same owner module (`mutationRunMark` in `tree-identity.ts`) so both
 * provenances have one spelling each. Such a row cannot INDICT: its red is
 * the verification working, evidence about the planted defect, never about
 * the committed code. The standing 2026-08-24 suspect (a module-load
 * failure healed within minutes, never recurred) was recorded by exactly
 * such a run and misread as the suite's flakiness for a whole window. The
 * row still occupies its window slot and the latest-run mute keeps its
 * existing posture (the provisional precedent: a break visible in the
 * latest run is that run's own red, and a genuine older failure re-surfaces
 * as a suspect at the next real run). Unmarked rows — ordinary failures,
 * legacy entries, malformed flags — keep the historical posture in both
 * directions: the marker can only ever be set by the operator who launched
 * the run, and an unreadable one defaults to a real failure.
 *
 * DECLARED, REPRODUCED FIXES. The fourth disposition (the FLAKE-REPRO
 * decision): a suspect stops indicting only when a commit declared it fixed
 * the cause (`Flake-cause:`, src/git/flake-cause-fixes.ts) AND a recorded
 * reproduction proves it (src/shared/flake-reproduction.ts: on the fix's
 * parent the test failed with a digest, on the fix it passed). Each recorded
 * failure must have measured the parent's bytes at the declared paths AND
 * failed with the reproduced digest; a declared cause other than the test
 * file must have changed. There is no other filing: the coordinator-filed
 * sidecar is gone, folded into this one rule.
 *
 * REGENERATION-EXPLAINED ROWS. The fifth disposition, and the one the
 * mint-last discipline owes an account of: the writer regenerates the perf
 * profile as the standing LAST gate of a round, so every full-suite gate
 * that runs BEFORE the mint on a tree whose measured surface moved records
 * the freshness arm's red — a DETERMINISTIC red with a known cause (the
 * surface moved, the mint is owed) that the round then mints away. The
 * flaky window reads exactly that pair — pre-mint red rows, then a green
 * post-mint latest — as the flaky signature, and red the LIVE arm for
 * ~8 further runs while the rows aged out (one writer round paid 7 extra
 * full runs for it, the rows verified in the live ledger, 2026-09-03).
 * A red whose remedy
 * is a recorded workflow step is not an unread bug report, and the
 * exclusion binds the row to the remedy's own instant: the caller names
 * the exact ledger identity of the artifact-judging test and the instant
 * the artifact was last REGENERATED (`ArtifactRegeneration`), and a
 * suspect whose every recorded failure STRICTLY predates that instant is
 * explained by the regeneration — mechanical, and bound to the artifact's
 * own instant (an artifact is not source: no tree's bytes reproduce it). Narrow by construction: the
 * explanation covers one exact identity (a budget arm in the same file
 * stays a suspect), a failure at or after the instant is a recurrence
 * that reds, an unreadable timestamp or instant can never be proven
 * pre-regeneration and counts (absence of provenance is not innocence,
 * the lean every other marker here takes), and a caller that passes no
 * data excludes nothing — the historical posture. The raw rows stand
 * append-only and a green run SAYS what the regeneration explained
 * (`regeneratedSuspectsMessage`), never silently swallows it.
 */
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { bestEffort } from "./best-effort.ts";
import { finiteNumber, type GateOutcome, type JudgedRunRecord, type RunQualification, type RunQualificationTerminal } from "./budget-verdict.ts";
import { auditEvent } from "./debug/debug-system.ts";
import { contentKeyDigest, reproducedDigests, type CountedFlakeReproduction, type IdentityMove } from "./flake-reproduction.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { withFileLock } from "../filesystem/file-lock.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { HarnessError, hasErrorCode } from "../kernel/errors.ts";
import { generateId, sha256 } from "../kernel/integrity.ts";
import { GIT_OBJECT_NAME } from "../git/git-port.ts";
import { statePath } from "../kernel/product-identity.ts";
import type { SupervisedCommand } from "../process/supervised-run.ts";

/**
 * How many judged runs the ledger keeps.
 *
 * ── THE DEPTH, DERIVED FROM THE MEASUREMENT THAT PAID FOR IT ─────────────
 *
 * The 20 this replaced was measured too shallow twice by the only workload
 * that reads the whole window: the budget-watch round. One such round
 * (2026-09-04) consumed 12 of the 20 slots on its own runs; the ordinary
 * cadence of 2026-09-02/03 filled the window in six rounds (~3.3 runs
 * each), so the 2026-09-04 era analysis spanning that whole stretch could
 * not read its earliest readings from the record — nine of them had to be
 * rebuilt from tracker prose. The era dataset that investigation needed
 * was 29 readings; 60 holds that whole era twice over, five budget-watch
 * rounds at the measured budget-watch pace, and ~18 ordinary rounds at
 * the measured ordinary pace — while staying a glance rather than a log
 * (~60 rows ≈ 20 KB on disk).
 *
 * It is far above the rolling baseline's window (`baselineWindowRuns`).
 *
 * THE RUN HISTORY MAY BE COMPACTED; THE SUSPECTS NEVER: a row trimmed past this depth that recorded a failure moves to the
 * ledger's SUSPECT ARCHIVE ({@link flakySuspectArchivePath}), which is never
 * trimmed, and {@link readRunFailureRows} reads the archive before the ledger.
 * So a flaky suspect never ages out: it leaves the flaky memory only when a
 * recorded reproduction explains it or an owned burn-down entry holds it
 * (src/workflow/flaky-burn-down.ts `judgeFlakyMemory`, design NH-E).
 */
export const HISTORY_KEPT = 60;

/** The file beside a ledger that keeps every failing row the ledger trimmed: never trimmed itself. */
const SUSPECT_ARCHIVE_NAME = "flaky-suspects.json";

/** The suspect archive of the ledger at `ledgerPath` (beside it). */
export function flakySuspectArchivePath(ledgerPath: string): string {
  return join(dirname(ledgerPath), SUSPECT_ARCHIVE_NAME);
}

/** The fields of a failing row the flaky memory reads (what the archive keeps of a trimmed row). */
const SUSPECT_FIELDS = ["timestamp", "failures", "provisionalFailures", "mutationRun", "importedFrom", "treeId", "failureDigests", "failureLocations"] as const;

/**
 * The ENGINE suite's judged-run ledger, relative to the engine root — the
 * memory the CPU gate's baseline reads (`judgeSuiteCpu` in
 * `src/shared/budget-verdict.ts`). Beside the run summary
 * (`TEST_RUN_SUMMARY_PATH`) because they are two views of the same subject:
 * the summary is the last run in full, the history is the judged runs in
 * brief.
 */
export const TEST_RUN_HISTORY_PATH = statePath("state", "test-results", "run-history.json");

/**
 * The WEB suite's judged-run ledger, relative to the repository root (the
 * engine suite's is `TEST_RUN_HISTORY_PATH`, relative to the engine root).
 * The web reporter writes it (`tests/helpers/budget-paths.ts`); the commit
 * guard's BASELINE WARNING reads it, and a candidate copy-back imports the
 * candidate's rows into it ({@link importJudgedRuns}).
 */
export const WEB_RUN_HISTORY_PATH = statePath("web-test-results", "run-history.json");

/** The suites that keep a judged-run ledger (a workspace gate names one: `workspaceIsolation.commands[].ledger`). */
export const SUITE_LEDGER_NAMES = ["engine", "web"] as const;
export type SuiteLedgerName = typeof SUITE_LEDGER_NAMES[number];

/**
 * THE ONE MAP from a suite to its ledger, repository-relative (the engine
 * root is `engineRelative` below the repository's top level): the workspace
 * gates, the candidate checkout's import and withdrawal read it, so a ledger
 * that moves is moved here once.
 */
export function suiteLedgerPaths(engineRelative: string): Readonly<Record<SuiteLedgerName, string>> {
  return Object.freeze({ engine: join(engineRelative, TEST_RUN_HISTORY_PATH), web: WEB_RUN_HISTORY_PATH });
}

/** The raw entries currently on disk, or [] when there is nothing readable. */
function rawEntries(path: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const runs = (parsed as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return [];
  return runs.filter(
    (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
  );
}

/**
 * A ledger row's failure rows — string rows only, anything else skipped with
 * the same garbage-tolerance lean as the rest of the file. Shared by the
 * judged-run parser (the rolling baseline's feed filter reads them) and the
 * failure-rows view (the flaky memory's substrate): two spellings of "which
 * rows did this run fail" would drift about what enters a verdict.
 */
function stringRows(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((f): f is string => typeof f === "string" && f.length > 0);
}

/** A row's identity → digest map, its malformed pairs dropped; `undefined` when absent or empty. */
function digestRows(v: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const pairs = Object.entries(v).filter((pair): pair is [string, string] => pair[0].length > 0 && typeof pair[1] === "string" && pair[1].length > 0);
  return pairs.length === 0 ? undefined : Object.freeze(Object.fromEntries(pairs));
}

/** Current certificates cannot inherit the legacy parser's lossy tolerance. */
function currentFailureCensus(value: Record<string, unknown> | undefined): boolean {
  if (value === undefined || !Array.isArray(value.failures)
    || !value.failures.every((identity) => typeof identity === "string" && identity.trim().length > 0)) return false;
  const failures = new Set(value.failures as string[]);
  if (failures.size !== value.failures.length) return false;
  if (value.failureDigests === undefined) return true; // Some legitimate failures have no diagnostic.
  const digests = recordOf(value.failureDigests);
  return digests !== undefined && Object.entries(digests).every(([identity, digest]) =>
    failures.has(identity) && typeof digest === "string" && digest.trim().length > 0);
}

/**
 * What a failure said: its error's name and message (both suites' receipts
 * hand this shape), and — when the runner kept them — its stack and the
 * assertion's operator (`strictEqual`, `toBe`…): where it failed.
 */
export type FailureStatement = Readonly<{ name?: string | null; message: string; stack?: string | null; operator?: string | null }>;

/** One frame of a stack: the function's name (`<anonymous>` when it has none) and its file, as the frame spells it. */
type StackFrame = Readonly<{ method: string; file: string }>;

/** The frames of a V8 stack (`at name (file:line:col)`, `at file:line:col`), outermost last; lines that are no frame are skipped. */
function stackFrames(stack: string): readonly StackFrame[] {
  return stack.split("\n").flatMap((line) => {
    const named = /^\s*at (?:async )?(.+?) \((.+?):\d+:\d+\)\s*$/u.exec(line);
    if (named !== null) return [{ method: named[1]!, file: named[2]! }];
    const bare = /^\s*at (?:async )?(.+?):\d+:\d+\s*$/u.exec(line);
    return bare === null ? [] : [{ method: "<anonymous>", file: bare[1]! }];
  });
}

/**
 * WHERE A FAILURE HAPPENED, in the parts that hold still between runs of the
 * same failure (design NH-D, the digest that kept "# !== #" for every numeric
 * mismatch): the assertion's operator and the names of the first
 * `ROOT_POLICY.workflow.failureLocationFrames` frames of the failing test's
 * OWN file — function names, never line numbers (an edit above the test moves
 * every line). 16 hex characters, or null when the failure names neither (a
 * timeout, an error with no frame in the test file): then it is compared by
 * its digest alone, as every failure was before locations were kept.
 * `testFile` is the identity's file (runner-relative): a frame belongs to it
 * when its path ends with it.
 */
export function failureLocation(failure: FailureStatement, testFile: string): string | null {
  const own = (frame: StackFrame): boolean => {
    const file = frame.file.replace(/^file:\/\//u, "");
    return file === testFile || file.endsWith(`/${testFile}`);
  };
  const frames = stackFrames(failure.stack ?? "").filter(own).slice(0, ROOT_POLICY.workflow.failureLocationFrames).map((frame) => frame.method);
  const operator = failure.operator ?? null;
  if (frames.length === 0 && operator === null) return null;
  return sha256(`${operator ?? ""}\u0000${frames.join("\u0000")}`).slice(0, FAILURE_DIGEST_HEX_DIGITS);
}

/**
 * What a failure said, with everything that moves between runs of the SAME
 * failure masked: the checkout root (`<root>`) and the temp root with the
 * owned folder under it (`<tmp>/<dir>`), UUIDs, hex runs of 8 or more with
 * a letter (run ids, nonces, digests), then every signed run of digits
 * (durations, byte deltas, ports, pids, line numbers — and counts: "3
 * offenders" and "4 offenders" read alike, the price of not reading every
 * timing change as a change), whitespace collapsed. WF-1b3b verify M3: without the id and path masks, 41 of 73
 * persisting web failures read `changed` between two runs of one tree.
 */
export function normalizedFailureText(failure: FailureStatement, root: string): string {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const places = [[root, "<root>"], [tmpdir(), "<tmp>"]].filter(([place]) => place!.length > 1).sort((a, b) => b[0]!.length - a[0]!.length);
  let text = `${failure.name ?? ""}: ${failure.message}`;
  for (const [place, label] of places) text = text.replace(new RegExp(escape(place!), "gu"), label!);
  return text
    .replace(/<tmp>\/[^/\s"'`]+/gu, "<tmp>/<dir>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/giu, "<hex>")
    .replace(/-?\d+/gu, "#")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * THE ONE DIGEST OF WHAT A FAILURE SAID, for both suites' ledger rows: the
 * {@link normalizedFailureText} hashed, 16 hex characters. Two runs whose
 * digests differ failed differently; equal digests may still differ in a
 * masked value.
 */
export function failureDigest(failure: FailureStatement, root: string): string {
  return sha256(normalizedFailureText(failure, root)).slice(0, FAILURE_DIGEST_HEX_DIGITS);
}

/** How many hex characters of the sha256 a failure digest keeps (a ledger row carries one per failure). */
const FAILURE_DIGEST_HEX_DIGITS = 16;
/**
 * The judged runs on disk, oldest first, malformed entries skipped.
 *
 * A skipped entry feeds no baseline (see the header): a verdict is one run
 * against the cap in force, so a skipped row can never create or forgive one.
 *
 * The live ledger is shared state a concurrent run may be appending to, so
 * tests drive these functions against their own file, never the live one.
 */
export function readRunHistory(path: string): JudgedRunRecord[] {
  return judgedRows(rawEntries(path));
}

/** A row's performance measurements: an object of finite numbers or nulls, or undefined. */
function performanceMeasurementsOf(value: unknown): Readonly<Record<string, number | null>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, measured]) => measured === null || (typeof measured === "number" && Number.isFinite(measured)))) return undefined;
  return Object.freeze(Object.fromEntries(entries) as Record<string, number | null>);
}

function judgedRows(entries: readonly Record<string, unknown>[]): JudgedRunRecord[] {
  const out: JudgedRunRecord[] = [];
  for (const e of entries) {
    const cpuMsPerTestFile = finiteNumber(e.cpuMsPerTestFile);
    const testModuleCount = finiteNumber(e.testModuleCount);
    if (cpuMsPerTestFile === null || testModuleCount === null) continue;
    // Tree identity + measurement condition, OPTIONAL BY DESIGN: entries
    // written before these fields exist stay valid, and a malformed value is
    // treated as absent rather than poisoning the entry — the same
    // garbage-tolerance lean as the whole file (a missing identity delays a
    // same-sha derivation, it can never fabricate one).
    const headSha = typeof e.headSha === "string" && e.headSha.length > 0 ? e.headSha : undefined;
    const qualification = currentFailureCensus(e) ? parseRunQualification(e.qualification) : undefined;
    const treeId = typeof e.treeId === "string" && GIT_OBJECT_NAME.test(e.treeId) ? e.treeId : undefined;
    const ambientLoadPerCpu = finiteNumber(e.ambientLoadPerCpu);
    // The pre-launch snapshot's longer legs, same optional-by-design lean:
    // entries written before the fields exist stay valid, and a malformed
    // value is treated as absent rather than poisoning the entry.
    const ambientLoad5PerCpu = finiteNumber(e.ambientLoad5PerCpu);
    const ambientLoad15PerCpu = finiteNumber(e.ambientLoad15PerCpu);
    // The run's own failure rows, parsed for the rolling baseline's feed
    // filter (a row carrying the budget gate's own failure never feeds).
    // ABSENT when the row predates failure recording or recorded none — an
    // absent set is a run whose cost is still its cost, never a fabricated
    // empty one poisoning the entry.
    const failures = Array.isArray(e.failures) ? stringRows(e.failures) : undefined;
    const failureDigests = digestRows(e.failureDigests);
    const failureLocations = digestRows(e.failureLocations);
    const importedFrom = typeof e.importedFrom === "string" && e.importedFrom.length > 0 ? e.importedFrom : undefined;
    // The deliberate-mutation provenance, strictly-true only: an unmarked or
    // malformed flag counts as an ordinary run (the lean every marker here
    // takes), and the feed filter's allowance bound blocks the harm
    // direction anyway — a mutation run reading high never feeds.
    const mutation = e.mutationRun === true ? true : undefined;
    // The run's wall clock and pool occupancy — the during-run calibration
    // fields (an occupancy/CPU ratio is the in-situ contention signal a
    // future ambient envelope can be derived from; the 2026-09-04 pairs
    // recorded ≈0.99 in both a quiet and an inflated run, so no consumer
    // judges by them today). Optional, finite, absent when unrecorded.
    const wallClockMs = finiteNumber(e.wallClockMs);
    const totalOccupancyMs = finiteNumber(e.totalOccupancyMs);
    // The perf budgets' measurements: a record of finite numbers or nulls; anything else is absent (never a guessed value).
    const performanceMeasurements = performanceMeasurementsOf(e[ROOT_POLICY.workflow.webPerformanceBudgets.ledgerField]);
    out.push({
      timestamp: typeof e.timestamp === "string" ? e.timestamp : null,
      cpuMsPerTestFile,
      testModuleCount,
      ...(qualification === undefined ? {} : { qualification }),
      ...(headSha !== undefined ? { headSha } : {}),
      ...(treeId !== undefined ? { treeId } : {}),
      ...(ambientLoadPerCpu !== null ? { ambientLoadPerCpu } : {}),
      ...(ambientLoad5PerCpu !== null ? { ambientLoad5PerCpu } : {}),
      ...(ambientLoad15PerCpu !== null ? { ambientLoad15PerCpu } : {}),
      ...(wallClockMs !== null ? { wallClockMs } : {}),
      ...(totalOccupancyMs !== null ? { totalOccupancyMs } : {}),
      ...(performanceMeasurements !== undefined ? { performanceMeasurements } : {}),
      ...(failures !== undefined ? { failures } : {}),
      ...(failureDigests !== undefined ? { failureDigests } : {}),
      ...(failureLocations !== undefined ? { failureLocations } : {}),
      ...(importedFrom !== undefined ? { importedFrom } : {}),
      ...(e.provisionalFailures === true ? { provisionalFailures: true } : {}),
      ...(mutation !== undefined ? { mutation } : {}),
      ...(e.heavySlot === "held" || e.heavySlot === "unslotted" ? { heavySlot: e.heavySlot } : {}),
    });
  }
  return out;
}

/** Private child correlation, not configuration or permission. */
export const QUALIFICATION_INVOCATION_ENV = "HARNESS_RUN_INVOCATION";
const INVOCATION_ID = /^qualification-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TREE_ID = GIT_OBJECT_NAME;
const TERMINAL_ENDINGS = ["exited", "stalled", "ceiling", "stopped", "signal", "unverified", "launcher-exited"] as const;

/** The actual runner reads/forwards this token; malformed inherited state refuses. */
export function qualificationInvocation(environment: Readonly<Record<string, string | undefined>>): string {
  const value = environment[QUALIFICATION_INVOCATION_ENV];
  if (value === undefined) return generateId("qualification");
  if (!INVOCATION_ID.test(value)) throw new HarnessError("invalid qualification invocation identity", "qualification_invocation_invalid");
  return value;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Native facts have no invocation/tree identity; those belong to qualification. */
export type CommandTerminalFacts = Omit<RunQualificationTerminal, "invocationId" | "treeId">;

/** One parser for persisted command observations and qualification terminals. */
export function parseCommandTerminalFacts(value: unknown): CommandTerminalFacts | undefined {
  const row = recordOf(value);
  if (row === undefined
    || !TERMINAL_ENDINGS.some((ending) => ending === row.ending)
    || !Number.isInteger(row.exitCode) || (row.status !== null && !Number.isInteger(row.status))
    || (row.signal !== null && typeof row.signal !== "string")
    || !["outputComplete", "receiptPresent", "noOwnedChildren", "timedOut", "interrupted", "commandKilled", "orphanedGroupKilled"].every((field) => typeof row[field] === "boolean")
    || !Number.isInteger(row.killedDescendants) || Number(row.killedDescendants) < 0) return undefined;
  const facts = Object.freeze({
    ending: row.ending as CommandTerminalFacts["ending"],
    exitCode: row.exitCode as number, status: row.status as number | null, signal: row.signal as string | null,
    outputComplete: row.outputComplete as boolean, receiptPresent: row.receiptPresent as boolean,
    noOwnedChildren: row.noOwnedChildren as boolean, timedOut: row.timedOut as boolean,
    interrupted: row.interrupted as boolean, commandKilled: row.commandKilled as boolean,
    killedDescendants: row.killedDescendants as number, orphanedGroupKilled: row.orphanedGroupKilled as boolean,
  });
  return Object.keys(row).every((key) => Object.hasOwn(facts, key)) ? facts : undefined;
}

function parseQualificationTerminal(value: unknown): RunQualificationTerminal | undefined {
  const row = recordOf(value);
  if (row === undefined || typeof row.invocationId !== "string" || !INVOCATION_ID.test(row.invocationId)
    || typeof row.treeId !== "string" || !TREE_ID.test(row.treeId)) return undefined;
  const { invocationId, treeId, ...observation } = row;
  const facts = parseCommandTerminalFacts(observation);
  return facts === undefined ? undefined : Object.freeze({ invocationId, treeId, ...facts });
}

/** Strict current envelope; malformed/legacy evidence never becomes completion. */
export function parseRunQualification(value: unknown): RunQualification | undefined {
  const row = recordOf(value);
  if (row === undefined || row.schemaVersion !== 1 || typeof row.invocationId !== "string" || !INVOCATION_ID.test(row.invocationId)
    || typeof row.treeId !== "string" || !TREE_ID.test(row.treeId) || (row.producer !== "web" && row.producer !== "engine")
    || typeof row.producerComplete !== "boolean" || !Array.isArray(row.outcomes) || row.outcomes.length === 0) return undefined;
  const outcomes: GateOutcome[] = [];
  for (const value of row.outcomes) {
    const outcome = recordOf(value);
    if (outcome === undefined || typeof outcome.gate !== "string" || outcome.gate.length === 0
      || typeof outcome.message !== "string" || outcome.message.length === 0
      || typeof outcome.kind !== "string" || !["pass", "fail", "not-judged"].includes(outcome.kind)) return undefined;
    outcomes.push(Object.freeze({ gate: outcome.gate, kind: outcome.kind as GateOutcome["kind"], message: outcome.message }));
  }
  const terminal = row.terminal === undefined ? undefined : parseQualificationTerminal(row.terminal);
  if (row.terminal !== undefined && terminal === undefined) return undefined;
  return Object.freeze({ schemaVersion: 1, invocationId: row.invocationId, treeId: row.treeId,
    producer: row.producer, producerComplete: row.producerComplete, outcomes: Object.freeze(outcomes),
    ...(terminal === undefined ? {} : { terminal }),
  });
}

/** The single projection from native observation to stored terminal facts. */
export function commandTerminalFacts(run: SupervisedCommand, ending: CommandTerminalFacts["ending"] = run.ending): CommandTerminalFacts {
  const receipt = run.supervision;
  return { ending, exitCode: run.exitCode, status: run.status, signal: run.signal, outputComplete: run.outputComplete,
    receiptPresent: receipt !== undefined, noOwnedChildren: receipt?.noOwnedChildren === true,
    timedOut: receipt?.timedOut === true, interrupted: receipt?.interrupted === true,
    commandKilled: receipt?.commandKilled === true,
    killedDescendants: receipt?.reaped.filter((child) => child.killed).length ?? 0,
    orphanedGroupKilled: run.orphanedGroupKilled };
}

/** One normal-completion policy for stored full results and actual focused commands. */
export function commandTerminalOutcome(terminal: CommandTerminalFacts | null | undefined, owner: string,
  expectedExitCode?: number | null): GateOutcome {
  const fail = (message: string): GateOutcome => ({ gate: "command-completion", kind: "fail", message });
  if (terminal === undefined || terminal === null) return fail(`${owner} has no terminal proof`);
  if (terminal.ending !== "exited" || !terminal.outputComplete || !terminal.receiptPresent || !terminal.noOwnedChildren
    || terminal.timedOut || terminal.interrupted || terminal.commandKilled || terminal.killedDescendants !== 0
    || terminal.orphanedGroupKilled || terminal.signal !== null || terminal.status !== terminal.exitCode) {
    return fail(`${owner} did not complete normally with complete output and clean descendant teardown`);
  }
  if (expectedExitCode !== undefined && terminal.exitCode !== expectedExitCode) {
    return fail(`${owner} terminal exit does not match its reported command result`);
  }
  return { gate: "command-completion", kind: "pass", message: `${owner} completed normally with complete output and clean descendant teardown` };
}

/** Focused runs owe actual finality even when they have no numeric ledger row. */
export function supervisedCommandOutcome(run: SupervisedCommand | undefined, owner: string, expectedExitCode?: number): GateOutcome {
  return commandTerminalOutcome(run === undefined ? undefined : commandTerminalFacts(run), owner, expectedExitCode);
}

/** Preserve observed supervision at the existing adapter; never infer it from exit alone. */
export function qualificationTerminal(invocationId: string, treeId: string, run: SupervisedCommand,
  ending: RunQualificationTerminal["ending"] = run.ending): RunQualificationTerminal {
  const terminal = parseQualificationTerminal({ invocationId, treeId, ...commandTerminalFacts(run, ending) });
  if (terminal === undefined) throw new HarnessError("invalid qualification terminal binding", "qualification_terminal_invalid");
  return terminal;
}

/** Exactly one numeric row from this invocation, including malformed duplicates in the refusal. */
export function runForInvocation(path: string, invocationId: string): JudgedRunRecord | undefined {
  const matches = rawEntries(path).filter((row) => recordOf(row.qualification)?.invocationId === invocationId);
  return matches.length === 1 ? judgedRows(matches)[0] : undefined;
}

/** Finalization shares append/import's lock and atomically binds one exact producer row. */
export function finalizeQualifiedRun(path: string, invocationId: string, treeId: string, terminal: RunQualificationTerminal): void {
  const checked = parseQualificationTerminal(terminal);
  if (checked === undefined || checked.invocationId !== invocationId || checked.treeId !== treeId) {
    throw new HarnessError("qualification terminal does not name this invocation/tree", "qualification_terminal_mismatch");
  }
  changeLedger(path, (runs) => {
    const matches = runs.filter((row) => recordOf(row.qualification)?.invocationId === invocationId);
    const row = matches.length === 1 ? matches[0] : undefined;
    const qualification = parseRunQualification(row?.qualification);
    if (row === undefined || !currentFailureCensus(row) || row.treeId !== treeId || qualification === undefined || qualification.treeId !== treeId
      || qualification.terminal !== undefined) {
      throw new HarnessError("qualification finalization needs one unfinished matching producer row", "qualification_finalization_refused");
    }
    return { runs: runs.map((entry) => entry === row ? { ...entry, qualification: { ...qualification, terminal: checked } } : entry), result: undefined };
  });
}

/** Advisory provenance only: a stored row cannot certify a later outer command. */
export function qualificationEvidence(row: JudgedRunRecord): string {
  const q = parseRunQualification(row.qualification);
  if (q === undefined) return "historical test reference only; current producer/terminal proof absent or malformed";
  return `invocation ${q.invocationId}; producer ${q.producerComplete ? "complete" : "incomplete"}; ${q.outcomes.map((outcome) => `${outcome.gate}=${outcome.kind}`).join(", ")}; stored terminal ${q.terminal?.ending ?? "absent"}; outer-command admission not established by this row alone`;
}

/** CURRENT completion only. Historical exact-tree test comparison is a separate claim. */
export function currentQualificationOutcome(row: JudgedRunRecord | undefined, expected: Readonly<{
  invocationId: string; treeId: string; producer: "web" | "engine"; outer: RunQualificationTerminal | undefined;
  /** Budget gates the caller judges like for like (UR-24): their breach is not this check's refusal. */
  judgedBudgets?: ReadonlySet<string>;
}>): GateOutcome {
  const fail = (message: string): GateOutcome => ({ gate: "current-qualification", kind: "fail", message });
  const q = parseRunQualification(row?.qualification);
  if (row === undefined || q === undefined || !currentFailureCensus(recordOf(row))) return fail("current invocation has no complete measured qualification envelope");
  if (row.mutation === true || row.treeId !== expected.treeId || q.treeId !== expected.treeId
    || q.invocationId !== expected.invocationId || q.producer !== expected.producer) return fail("current qualification identity does not match this invocation/tree/producer");
  if (!q.producerComplete) return fail("current producer result census is incomplete");
  const failures = q.outcomes.filter((outcome) => outcome.kind === "fail" && expected.judgedBudgets?.has(outcome.gate) !== true);
  if (failures.length > 0) return fail(`current non-test gate failed: ${failures.map((outcome) => `${outcome.gate}: ${outcome.message}`).join("; ")}`);
  const budgetBreached = q.outcomes.some((outcome) => outcome.kind === "fail" && expected.judgedBudgets?.has(outcome.gate) === true);
  for (const [owner, terminal] of [["producer wrapper", q.terminal], ["outer command", parseQualificationTerminal(expected.outer)]] as const) {
    if (terminal === undefined) return fail(`${owner} has no terminal proof`);
    if (terminal.invocationId !== expected.invocationId || terminal.treeId !== expected.treeId) return fail(`${owner} terminal identity does not match this invocation/tree`);
    const health = commandTerminalOutcome(terminal, owner);
    if (health.kind !== "pass") return fail(health.message);
    if (terminal.exitCode !== 0 && terminal.exitCode !== 1) return fail(`${owner} has an unaccounted exit ${String(terminal.exitCode)}`);
    if ((terminal.exitCode === 1) !== ((row.failures?.length ?? 0) > 0 || budgetBreached)) return fail(`${owner} exit disagrees with its accounted test failures`);
  }
  return { gate: "current-qualification", kind: "pass", message: `complete current result; ${q.outcomes.map((outcome) => `${outcome.gate}=${outcome.kind}`).join(", ")}` };
}

/**
 * IS `row` A RUN OF `tree` — the one answer every "find the run of that
 * tree" asks (a workspace's target baseline and its land's import, a
 * promotion's source evidence): the row names the tree it measured
 * (`treeId`), wherever it was taken (a candidate's run of a dirty tree on the
 * parent HEAD is the run of the commit that later lands exactly that tree). A
 * row that names none — written before rows carried their tree, or a run
 * whose tree could not be read or changed while it ran — is the run of NO
 * tree: its HEAD cannot say what it measured (an untracked file is not
 * provisional, and a tree that changed mid-run leaves the HEAD unmoved;
 * WF-1b3c-FIX MED-2). A deliberate mutation run is never a run of any tree.
 */
function measuresTree(row: Readonly<{ treeId?: unknown; mutation?: unknown; mutationRun?: unknown }>, tree: string): boolean {
  return row.mutation !== true && row.mutationRun !== true && row.treeId === tree;
}

/** Every run of `tree` among `rows` ({@link measuresTree}): a budget's like-for-like base values. */
export function runsOfTree(rows: readonly JudgedRunRecord[], tree: string): readonly JudgedRunRecord[] {
  return rows.filter((row) => measuresTree(row, tree));
}

/**
 * THE LATEST RUN OF `tree` among `rows` ({@link measuresTree}) recorded
 * before `before` (epoch ms), by its TIMESTAMP — never by its place in a
 * file (an imported or a concurrent run is appended out of time order) — or
 * undefined. The one answer the workspace's target baseline and the
 * promotion's source evidence both read (WF-1b3c-FIX N8).
 */
export function latestRunOfTree(rows: readonly JudgedRunRecord[], tree: string, before = Number.POSITIVE_INFINITY): JudgedRunRecord | undefined {
  return rows.filter((row) => Date.parse(row.timestamp ?? "") < before && measuresTree(row, tree))
    .toSorted((left, right) => Date.parse(left.timestamp!) - Date.parse(right.timestamp!))
    .at(-1);
}

/**
 * THE REPOSITORY'S OWN HEAD, READ FROM THE FILESYSTEM — the tree-identity
 * half both runners record into their judged-run ledgers.
 *
 * Filesystem, not a subprocess, on purpose: the runners live under strict
 * subprocess confinement ("exactly one module may create a subprocess"), and
 * a `git rev-parse` here would be a second subprocess creator for a value
 * three file reads answer. Resolution: `.git/HEAD` is either a detached sha
 * (done) or `ref: <path>`, which resolves through the loose ref file or,
 * when the ref is packed, through `.git/packed-refs`. A worktree's `.git`
 * FILE (`gitdir: <path>`, relative to the file's folder or absolute) is
 * followed one level, with `commondir` honoured for the shared refs.
 *
 * `directory` is any folder of the work tree: the `.git` entry is found the
 * way git discovers it, the nearest one at or above it. The engine runner
 * asks from the ENGINE root, a folder below the repository's: reading
 * `<engine>/.git` alone answered null there, so no engine ledger row ever
 * carried its HEAD (WF-1b3c: a workspace's baseline of the target, measured
 * in its own worktree, was then never found).
 *
 * Returns null when anything along the way is unreadable — absence, never a
 * fabricated identity; a record without a sha simply cannot participate in a
 * same-sha derivation.
 */
export function readRepositoryHeadSha(directory: string): string | null {
  // Discovery starts from an existing directory. A file or missing descendant
  // cannot borrow an ancestor's identity merely because `.git` is absent there.
  try {
    if (!statSync(directory).isDirectory()) return null;
  } catch {
    return null;
  }
  // Every read below is "the file's text, or null" — a missing loose ref, a
  // `.git` that is a directory rather than a worktree pointer, and a missing
  // `commondir` are all ordinary states of a healthy repository, so each
  // absence steers the resolution rather than aborting it.
  const tryRead = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  // Whether `folder` holds a `.git` entry; null when that cannot be learned
  // (EACCES, ENOTDIR: an unreadable or impossible path) — absence, never a
  // throw (WF-1b3c-FIX N7).
  const holdsGit = (folder: string): boolean | null => {
    try {
      statSync(join(folder, ".git"));
      return true;
    } catch (error) {
      return hasErrorCode(error, "ENOENT") ? false : null;
    }
  };
  let worktree = resolve(directory);
  for (let found = holdsGit(worktree); found !== true; found = holdsGit(worktree)) {
    const parent = dirname(worktree);
    if (found === null || parent === worktree) return null;
    worktree = parent;
  }
  let gitDir = join(worktree, ".git");
  // A linked worktree's `.git` is a FILE pointing at the real git dir; a
  // directory read returns null here and the join above already points at it.
  const asFile = tryRead(gitDir);
  if (asFile !== null && asFile.startsWith("gitdir:")) {
    gitDir = resolve(worktree, asFile.slice("gitdir:".length).trim());
  }
  const head = tryRead(join(gitDir, "HEAD"))?.trim();
  if (head === undefined) return null;
  if (GIT_OBJECT_NAME.test(head)) return head;
  if (!head.startsWith("ref: ")) return null;
  const ref = head.slice("ref: ".length).trim();
  // Loose ref first; then the common dir's loose ref (a linked worktree
  // keeps shared refs there); then packed-refs.
  const loose = tryRead(join(gitDir, ref))?.trim();
  if (loose !== undefined) return GIT_OBJECT_NAME.test(loose) ? loose : null;
  let refsDir = gitDir;
  const common = tryRead(join(gitDir, "commondir"))?.trim();
  if (common !== undefined) {
    refsDir = join(gitDir, common);
    const commonLoose = tryRead(join(refsDir, ref))?.trim();
    if (commonLoose !== undefined) return GIT_OBJECT_NAME.test(commonLoose) ? commonLoose : null;
  }
  const packed = tryRead(join(refsDir, "packed-refs"));
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const at = line.indexOf(" ");
    if (at > 0 && line.slice(at + 1).trim() === ref) {
      const sha = line.slice(0, at).trim();
      return GIT_OBJECT_NAME.test(sha) ? sha : null;
    }
  }
  return null;
}

/**
 * THE ONE LEDGER WRITER. Every change to a ledger — an append, an import, a
 * withdrawal — is one read-modify-write under the cross-process file lock
 * (`<ledger>.lock` beside it) and lands through the one atomic writer: a
 * copy-back importing rows while a live suite appends its own used to be two
 * raw `writeFileSync` cycles, and one side's rows were lost
 * (wf-del2-correctness NEW-9, wf-del2-design D4). Returns what `change`
 * returned; the result is trimmed to the newest `HISTORY_KEPT`.
 */
function changeLedger<T>(path: string, change: (runs: readonly Record<string, unknown>[]) => Readonly<{ runs: readonly Record<string, unknown>[]; result: T }>): T {
  ensurePrivateStateDirectory(dirname(path));
  return withFileLock(`${path}.lock`, (message, details) => new HarnessError(`another process is writing the run ledger (${message}); try again`, "run_history_busy", true, details), () => {
    const { runs, result } = change(rawEntries(path));
    // A failing row past the depth moves to the suspect archive BEFORE the ledger drops it (never trimmed: design HIGH 2).
    const trimmed = runs.slice(0, Math.max(0, runs.length - HISTORY_KEPT)).filter((row) => stringRows(row.failures).length > 0);
    if (trimmed.length > 0) {
      const archive = flakySuspectArchivePath(path);
      const kept = trimmed.map((row) => Object.fromEntries(SUSPECT_FIELDS.filter((field) => row[field] !== undefined).map((field) => [field, row[field]])));
      // A row already archived (a ledger write that failed after the archive's) is not archived twice.
      const present = rawEntries(archive);
      const known = new Set(present.map((row) => JSON.stringify(row)));
      const archived = atomicWriteFile(archive, JSON.stringify({ runs: [...present, ...kept.filter((row) => !known.has(JSON.stringify(row)))] }));
      if (!archived.success) throw archived.error ?? new HarnessError(`could not write the suspect archive ${archive}: ${archived.reason ?? "unknown"}`, "run_history_write_failed");
    }
    const written = atomicWriteFile(path, JSON.stringify({ runs: runs.slice(-HISTORY_KEPT) }));
    if (!written.success) throw written.error ?? new HarnessError(`could not write the run ledger ${path}: ${written.reason ?? "unknown"}`, "run_history_write_failed");
    return result;
  });
}

/**
 * Append one JUDGED run and trim to the newest `HISTORY_KEPT`.
 *
 * The record may carry fields beyond `JudgedRunRecord` (the integration
 * runner appends its failure rows); they are persisted as-is.
 *
 * Never throws: the ledger is memory for the next run's verdict, and a full
 * disk must not fail the run that was measured — the current run's own
 * verdict was already delivered from the in-memory evidence.
 */
export function appendJudgedRun(
  record: JudgedRunRecord & Readonly<Record<string, unknown>>,
  path: string,
): void {
  // Loud failure is the runner's job for the run itself; losing one history
  // append only delays a future red by one run at most — but it is SAID
  // (bestEffort reports a fixed failure diagnostic), never swallowed.
  bestEffort(() => changeLedger(path, (runs) => ({ runs: [...runs, { ...record }], result: undefined })));
}

/**
 * When a ledger row's run STARTED (its timestamp is when it was recorded,
 * after `wallClockMs` of running), in epoch ms; `null` when the row cannot
 * say — and a run that cannot say when it started can never be proven to
 * have measured a given tree.
 */
function runStartedAt(entry: Readonly<Record<string, unknown>>): number | null {
  const recorded = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  const wallClockMs = finiteNumber(entry.wallClockMs);
  return Number.isFinite(recorded) && wallClockMs !== null && wallClockMs >= 0 ? recorded - wallClockMs : null;
}

/**
 * Whether a row of another checkout's ledger measured the tree that checkout
 * holds since `measuredSince` (the instant its tree last changed): the run
 * STARTED at or after it, and it was not a deliberate mutation run (a planted
 * defect is not the tree either).
 */
function measuredTheTreeSince(entry: Readonly<Record<string, unknown>>, measuredSince: number): boolean {
  const started = runStartedAt(entry);
  return started !== null && started >= measuredSince && entry.mutationRun !== true;
}

/**
 * IMPORTS ANOTHER CHECKOUT'S JUDGED RUNS OF ITS CURRENT TREE: appends to `to`
 * every row of `from` that measured the tree `from`'s checkout holds since
 * `measuredSince` (ISO: the instant that tree last changed — a candidate's
 * last refresh or sync that changed anything) and is newer than `to`'s
 * newest, each marked `importedFrom: origin`, trimmed as every append is.
 * Returns how many rows it imported.
 *
 * Why (step6-readiness-2 F-3): qualification runs in a candidate checkout,
 * so the LIVE ledger never heard of it — its last row was ten days old, and
 * every commit printed that stale BASELINE WARNING while the qualifying run
 * sat in the candidate. The candidate's copy-back makes the live tree the
 * candidate's tree, so the candidate's rows OF THAT TREE are runs of these
 * bytes: the copy-back imports them, and the mark says where they were
 * measured. Rows of the candidate's earlier trees are not (wf-del2-correctness
 * NEW-1: four qualification rounds were imported, three of them of trees the
 * live checkout never held, with failures it never had).
 *
 * `measuredTree`, when given, narrows the rows to the runs of that tree
 * ({@link measuresTree}): a workspace's ledger also holds its target's
 * baseline runs (another tree), which a land must never import as its own.
 *
 * Unlike an append it THROWS when `to` cannot be written: the caller (the
 * copy-back) reports the failure beside the work it did, instead of a live
 * ledger silently missing its qualification.
 */
export function importJudgedRuns(from: string, to: string, origin: string, measuredSince: string, measuredTree?: string): number {
  const since = Date.parse(measuredSince);
  if (!Number.isFinite(since)) throw new HarnessError(`importJudgedRuns: ${JSON.stringify(measuredSince)} is not an instant`, "run_history_import_bound_invalid");
  const offered = rawEntries(from).filter((entry) => measuredTheTreeSince(entry, since) &&
    (measuredTree === undefined || measuresTree(entry, measuredTree)));
  const imported = changeLedger(to, (runs) => {
    const newest = runs.reduce((latest, entry) => (typeof entry.timestamp === "string" && entry.timestamp > latest ? entry.timestamp : latest), "");
    const incoming = offered.filter((entry) => typeof entry.timestamp === "string" && entry.timestamp > newest);
    return { runs: [...runs, ...incoming.map((entry) => ({ ...entry, importedFrom: origin }))], result: incoming.map((entry) => String(entry.timestamp)) };
  });
  auditEvent("judged-runs-imported", { from, to, origin, measuredSince, rows: imported });
  return imported.length;
}

/**
 * WITHDRAWS rows imported from `origin` that did not measure its tree since
 * `measuredSince` (the rule {@link importJudgedRuns} applies; a row that
 * cannot say when it started is withdrawn too). The repair for rows imported
 * before that bound existed (wf-del2-correctness NEW-1); returns the
 * timestamps withdrawn. Rows measured in this checkout are never touched.
 */
export function withdrawImportedRuns(path: string, origin: string, measuredSince: string): readonly string[] {
  const since = Date.parse(measuredSince);
  if (!Number.isFinite(since)) throw new HarnessError(`withdrawImportedRuns: ${JSON.stringify(measuredSince)} is not an instant`, "run_history_import_bound_invalid");
  const withdrawn = changeLedger(path, (runs) => {
    const superseded = (entry: Readonly<Record<string, unknown>>): boolean => entry.importedFrom === origin && !measuredTheTreeSince(entry, since);
    return { runs: runs.filter((entry) => !superseded(entry)), result: runs.filter(superseded).map((entry) => String(entry.timestamp)) };
  });
  auditEvent("judged-runs-withdrawn", { path, origin, measuredSince, rows: withdrawn });
  return withdrawn;
}

/**
 * One judged run's FAILURE ROWS with the run's own timestamp — the flaky-test
 * memory's view of the ledger.
 */
export interface RunFailureRows {
  readonly timestamp: string | null;
  readonly failures: readonly string[];
  /**
   * True when the run's tracked working tree differed from HEAD — the run
   * measured mid-edit code, so its failure rows are PROVISIONAL: they are
   * evidence about an iteration, never by themselves an indictment of the
   * committed tree. Optional because a fixture (or a caller reconstructing a
   * legacy entry) describes a run with no recorded provenance, and that
   * absence must MEAN absence: the verdict's own default — missing counts as
   * a real failure, the historical posture — answers it, and a required
   * field would force every fixture to restate the default.
   */
  readonly provisional?: boolean;
  /**
   * True when the run was launched as a DELIBERATE MUTATION-VERIFICATION run
   * (`HARNESS_MUTATION_RUN=1` — the operator planted a defect, ran the
   * owning suite to watch it red, and restored). Such a run's results say
   * nothing about the committed code in EITHER direction: its failures are
   * the verification working, its passes measured a deliberately wrong
   * tree, so the flaky verdict never INDICTS from it. The latest-run mute
   * still applies to it (the provisional precedent): while the row is the
   * latest one, its failures mute older suspects — a break visible in the
   * latest run is that run's own red — and a genuine older failure
   * re-surfaces at the next real run. Optional for the same reason
   * `provisional` is: absence of provenance counts as a real failure, the
   * historical posture.
   */
  readonly mutation?: boolean;
  /** Where the run was measured when another checkout's copy-back imported it ({@link importJudgedRuns}). */
  readonly importedFrom?: string;
  /** The tree the run measured, when its row names one: the content a fixed cause is compared by ({@link CauseEvidence}). */
  readonly treeId?: string;
  /** What each failure said (identity → `failureDigest`), when the row records it: a reproduction is matched by it. */
  readonly digests?: Readonly<Record<string, string>>;
  /** Where each failure happened (identity → `failureLocation`), when the row records it: matched beside the digest. */
  readonly locations?: Readonly<Record<string, string>>;
}

/**
 * The failure rows on disk, oldest first: the ledger's suspect archive (its
 * trimmed failing rows, never trimmed) and then the ledger itself.
 *
 * An entry carrying a `failures` array contributes it verbatim (string rows
 * only; anything else in the array is skipped with the same garbage-tolerance
 * lean as the rest of the file). An entry WITHOUT the field predates failure
 * recording: it contributes an empty set — "no rows recorded", which can
 * delay a red (a failure nobody wrote down is invisible to the guard) but can
 * never manufacture one.
 */
export function readRunFailureRows(path: string): RunFailureRows[] {
  // The suspect archive first (every failing row the ledger trimmed, oldest), then the ledger.
  return [...rawEntries(flakySuspectArchivePath(path)), ...rawEntries(path)].map((e) => ({
    timestamp: typeof e.timestamp === "string" ? e.timestamp : null,
    failures: stringRows(e.failures),
    // Strictly-true only: a legacy entry (recorded before the marker
    // existed) and a malformed flag both read as a REAL failure — the lean
    // that can postpone a provisional reprieve, never fabricate one.
    provisional: e.provisionalFailures === true,
    // Same strictness, same lean: a row that cannot say it was a deliberate
    // mutation run was, as far as the ledger knows, an ordinary run.
    mutation: e.mutationRun === true,
    ...(typeof e.importedFrom === "string" ? { importedFrom: e.importedFrom } : {}),
    ...(typeof e.treeId === "string" && GIT_OBJECT_NAME.test(e.treeId) ? { treeId: e.treeId } : {}),
    ...(digestRows(e.failureDigests) === undefined ? {} : { digests: digestRows(e.failureDigests)! }),
    ...(digestRows(e.failureLocations) === undefined ? {} : { locations: digestRows(e.failureLocations)! }),
  }));
}

/**
 * THE TEST FILE A FAILURE IDENTITY NAMES — a ledger failure identity is
 * `<file>::<test name>` (both runners write it so; the engine's file is
 * relative to the engine, the web's to the repository); null when the
 * identity carries no file. The ledger judge asks it to find a failure's
 * owner (src/workflow/failure-owners.ts).
 */
export function failureIdentityFile(identity: string): string | null {
  const separator = identity.indexOf("::");
  if (separator > 0) return identity.slice(0, separator);
  // A file-level row (a load crash, a watchdog kill) is `<file> (<what happened>)`.
  const note = identity.indexOf(" (");
  return note > 0 ? identity.slice(0, note) : null;
}

const SKIPPED_SUFFIX = " (skipped)";

/** The ledger row of a named skipped test (`<file>::<name> (skipped)`): its own identity, never a failure's. */
export function skippedIdentity(identity: string): string {
  return `${identity}${SKIPPED_SUFFIX}`;
}

/** The test a ledger row is about: a skip row's own test, any other row as it is. */
function testIdentityOfRow(identity: string): string {
  return identity.endsWith(SKIPPED_SUFFIX) ? identity.slice(0, -SKIPPED_SUFFIX.length) : identity;
}

/**
 * One test the memory indicts: it failed on a committed-tree run inside the
 * window but not in the latest recorded run.
 */
export interface FlakySuspect {
  readonly identity: string;
  /** The windowed COMMITTED-TREE runs it failed in (their timestamps; null
   *  when a run recorded none), oldest first. */
  readonly failedAt: readonly (string | null)[];
}

/**
 * THE FLAKY-TEST VERDICT, PURE OVER THE LEDGER'S OWN ROWS.
 *
 * A test that failed within the last `windowRuns` recorded runs but did NOT
 * fail in the latest one is a suspect: either it is flaky (the bug is still
 * there, hiding) or it was fixed — and the memory cannot tell those apart,
 * which is the point. A flaky failure IS an unread bug report, and the guard
 * reds until it is explained or owned (the live guards pass every row, the
 * suspect archive's included: nothing ages out), so nobody gets to re-run a
 * red away and call it noise. A test that failed in the LATEST recorded run
 * too is not here: that run was already red on its own, and the runner owns
 * that verdict.
 *
 * PROVISIONAL ROWS WEIGH LESS. A failure recorded on a run whose tracked
 * tree was DIRTY (uncommitted edits — the iterate-then-verify loop of
 * building a fix) says nothing about the committed code the next writer
 * inherits: the red may exist only in the edit being built. So a suspect
 * must carry at least one failure from a COMMITTED-TREE run inside the
 * window — a dirty-tree failure alone never indicts. The provenance lists
 * only those indicting runs. The latest run's failures mute a suspect
 * regardless of their provenance: a break visible in the latest run is the
 * runner's own red, and splitting that ownership by tree state would let a
 * real break go unnamed.
 *
 * `excludePrefix` is the ONE structural exclusion: the guard's own rows. A
 * gate whose input includes its own verdicts is a feedback loop — when the
 * guard reds, its own failure enters the ledger, and without the exclusion
 * the guard would indict itself forever after a single suspect. The guard's
 * own failures are the runner's business, not the memory's.
 *
 * Returns null for a window below 2 — a one-run window has nothing to
 * compare, and answering [] would be the permissive direction wearing a
 * number. The module's no-throw discipline holds: a bad argument is reported,
 * never raised.
 */
export function flakySuspectsWithin(
  entries: readonly RunFailureRows[],
  windowRuns: number,
  excludePrefix?: string,
): FlakySuspect[] | null {
  return indictments(entries, windowRuns, excludePrefix)?.map(({ identity, failedAt }) => ({ identity, failedAt })) ?? null;
}

/** One indicting failure: the tree its run measured and what it said (null: the row recorded none). */
type MeasuredFailure = Readonly<{ tree: string | null; digest: string | null; location: string | null }>;

/** The suspects with what each indicting run measured and said, oldest first. */
function indictments(
  entries: readonly RunFailureRows[],
  windowRuns: number,
  excludePrefix?: string,
): (FlakySuspect & Readonly<{ failedOn: readonly MeasuredFailure[] }>)[] | null {
  if (!Number.isInteger(windowRuns) || windowRuns < 2) return null;
  const window = entries.slice(-windowRuns);
  const latest = window[window.length - 1];
  const older = window.slice(0, -1);
  const latestFailures = new Set(latest?.failures ?? []);
  const failedAtByIdentity = new Map<string, (string | null)[]>();
  const failedOnByIdentity = new Map<string, MeasuredFailure[]>();
  for (const run of older) {
    // A provisional (dirty-tree) run cannot indict — only a failure measured
    // on the committed tree is evidence the committed code broke.
    if (run.provisional === true) continue;
    // A DELIBERATE MUTATION-VERIFICATION run cannot indict either: the
    // operator planted the defect its red names, so the failure is the
    // verification working — evidence about the planted defect, never about
    // the committed code. The standing 2026-08-24 suspect (a module-load
    // failure healed within minutes, never recurred) was recorded by exactly
    // such a run and misread as the suite's flakiness for a whole window.
    if (run.mutation === true) continue;
    for (const identity of run.failures) {
      if (latestFailures.has(identity)) continue;
      if (excludePrefix !== undefined && identity.startsWith(excludePrefix)) continue;
      const failedAt = failedAtByIdentity.get(identity) ?? [];
      failedAt.push(run.timestamp);
      failedAtByIdentity.set(identity, failedAt);
      failedOnByIdentity.set(identity, [...(failedOnByIdentity.get(identity) ?? []), { tree: run.treeId ?? null, digest: run.digests?.[identity] ?? null, location: run.locations?.[identity] ?? null }]);
    }
  }
  return [...failedAtByIdentity.entries()].map(([identity, failedAt]) => ({ identity, failedAt, failedOn: failedOnByIdentity.get(identity)! }));
}

/**
 * A CAUSE A COMMIT FIXED, as the fix commit itself declares it (its
 * `Flake-cause:` trailer, src/git/flake-cause-fixes.ts): the test identity,
 * and the repository paths whose content the failure depended on — the
 * test's own file and the cause's.
 */
export interface DeclaredCauseFix {
  readonly identity: string;
  /** The test's own file first, then every other declared cause, each once: the bytes a failure is matched by. */
  readonly paths: readonly string[];
  /** The causes as declared — the test's own file may be one of them: the fix must change them SEMANTICALLY. */
  readonly causes: readonly string[];
  /** The fix commit: its PARENT holds the content the failure was measured on. */
  readonly commit: string;
}

/**
 * How the fix changed its declared causes, judged by the one semantic reader
 * (src/quality/languages/semantic-form.ts): semantic when at least one
 * cause's meaning changed; otherwise why not (a comment or layout edit, a
 * kind no reader judges), said by path.
 */
export type CauseChange = Readonly<{ semantic: true }> | Readonly<{ semantic: false; why: string }>;

/** A declared fix with its judged change. */
export interface JudgedCauseFix extends DeclaredCauseFix {
  readonly change: CauseChange;
}

/**
 * The content key of `paths` in the tree-ish `treeish` (a tree id, or a
 * commit and `^`): equal keys are equal bytes at every path, a path absent
 * there keys as absent (`<path>=`). Null when the tree-ish is unknown — never
 * proven anything. A declaration's own test file is keyed WHOLE, like every
 * other path: no parse of a test file decides which of its bytes a failure
 * measured (a closure that could leave the failing test's own body out was a
 * hole: security T-1/T-2, correctness F-N1).
 */
export type ContentKeyAt = (treeish: string, paths: readonly string[]) => string | null;

/** Every path of a content key was present (no `<path>=` line): only such a key can prove what a run measured. */
export function contentKeyComplete(key: string | null): key is string {
  return key !== null && key.split("\n").every((line) => !line.endsWith("="));
}

/** The identities each suite holds NOW: the hermetic suite's and the live suite's manifest (a moved test is judged by them). */
export type SuiteIdentities = Readonly<{ hermetic: ReadonlySet<string>; live: ReadonlySet<string> }>;

/** What the verdict needs to judge a declared fix or a move: the declarations, the records and the content reader. */
export interface CauseEvidence {
  readonly declared: readonly JudgedCauseFix[];
  readonly reproductions: readonly CountedFlakeReproduction[];
  /** The configured N a statistical reproduction must have run (`testExecution.flakeReproduction.statisticalRuns`). */
  readonly statisticalRuns: number;
  /** α (`testExecution.flakeReproduction.significance`): a record whose counts a no-op fix would show more often explains nothing. */
  readonly significance: number;
  /** The preloaded modules whose one run per side is strong (`testExecution.flakeReproduction.deterministicShims`). */
  readonly deterministicShims: readonly string[];
  readonly moves: readonly IdentityMove[];
  /** The suites' identities now; null for a suite with no live suite (nothing moves out of it). */
  readonly suites: SuiteIdentities | null;
  readonly contentKeyAt: ContentKeyAt;
}

/** No declared fix and no move (a fixture's history, or a checkout without git): nothing is explained by content. */
export const NO_CAUSE_EVIDENCE: CauseEvidence = Object.freeze({
  declared: Object.freeze([]), reproductions: Object.freeze([]), statisticalRuns: Number.POSITIVE_INFINITY, significance: 0, deterministicShims: Object.freeze([]),
  moves: Object.freeze([]), suites: null, contentKeyAt: () => null,
});

/** A suspect reproduced fixes explain: each recorded failure measured the content one of them changed, and said what its reproduction said. */
export interface FixedSuspect {
  readonly suspect: FlakySuspect;
  /** The fixes that explain the failures, in the order of the failures they explain (each once). */
  readonly fixes: readonly DeclaredCauseFix[];
}

/** A suspect whose test left the hermetic suite by a recorded move to the live suite. */
export interface MovedSuspect {
  readonly suspect: FlakySuspect;
  readonly move: IdentityMove;
}

/**
 * An artifact a named test judges, and when that artifact was last
 * REGENERATED — the mechanical explanation for that test's failures that
 * predate the regeneration.
 *
 * The shape is caller-data, never a derivation here: which test judges
 * which artifact is knowledge the caller's suite owns (the web suite's
 * flaky guard names the perf-freshness arm and the profile report's own
 * regeneration instant), and the verdict holds only the judgement. An
 * entry excludes nothing beyond its own exact identity.
 */
export interface ArtifactRegeneration {
  /** The exact ledger identity of the test that judges the artifact. */
  readonly identity: string;
  /** When the artifact was last regenerated (epoch ms). */
  readonly regeneratedAtMs: number;
}

/**
 * A suspect a regeneration explains: the indictment itself plus the
 * regeneration that explains it, so a muted note can name both.
 */
export interface RegeneratedSuspect {
  readonly suspect: FlakySuspect;
  readonly regeneration: ArtifactRegeneration;
}

/** The flaky verdict with its explanations: what reds, what a regeneration or a reproduced fix explains. */
export interface FlakyVerdict {
  /** The suspects that are still unread bug reports — these are the reds. */
  readonly reds: readonly FlakySuspect[];
  /**
   * The suspects a later regeneration of the artifact they judge explains:
   * every recorded failure predates the regeneration instant, so the red
   * was the known pre-regeneration state (the mint-last posture), not a
   * flake. A failure at or after the instant is a recurrence and reds.
   */
  readonly regenerated: readonly RegeneratedSuspect[];
  /**
   * The suspects a DECLARED AND REPRODUCED FIX explains: every indicting run
   * measured the test and its cause exactly as they stood BEFORE the fix
   * commit (its parent's bytes) and failed with a digest the recorded
   * reproduction saw there, the fix changed a declared cause semantically,
   * and the latest run measured other bytes. Anything else reds.
   */
  readonly fixed: readonly FixedSuspect[];
  /**
   * The suspects whose test LEFT the hermetic suite by a recorded move: the
   * identity is no longer in the hermetic suite and the move's destination
   * is in the live suite's manifest. A test that merely vanished reds.
   */
  readonly moved: readonly MovedSuspect[];
}

/**
 * THE FLAKY VERDICT WITH ITS EXPLANATIONS — the LIVE arms' one door.
 *
 * A suspect leaves the reds only when it is EXPLAINED, by one of two things:
 *
 * - A DECLARED AND REPRODUCED FIX (FLAKE-REPRO). A commit declared it fixed
 *   the cause (`Flake-cause:`), and a recorded reproduction of that (test,
 *   fix) proves it under one set of conditions: on the fix's parent the test
 *   failed with a digest (once, or at least once in a statistical record of
 *   the configured N runs), on the fix it passed every run. Every indicting
 *   failure must have measured the parent's bytes at the declared paths (the
 *   test's own file among them) AND failed with a digest the parent's runs
 *   saw; the fix must have changed a declared cause SEMANTICALLY (the test's
 *   own file may be that cause: a comment or layout edit never is); the
 *   latest run measured other bytes. One failure for another reason, a row
 *   with no tree or no digest, a path absent anywhere, a record that does
 *   not match: red.
 * - A RECORDED MOVE of its test to the live suite: the identity (a skip
 *   row's own test) is absent from the hermetic suite now, and the move's
 *   destination is in the live suite's manifest. Absence alone: red.
 * - A REGENERATION of the artifact the test judges (caller-data): every
 *   recorded failure strictly predates the artifact's regeneration instant.
 *
 * Returns null for a window below 2, exactly as the raw verdict does.
 */
export function flakyVerdictWithin(
  entries: readonly RunFailureRows[],
  windowRuns: number,
  excludePrefix?: string,
  regenerated: readonly ArtifactRegeneration[] = [],
  causes: CauseEvidence = NO_CAUSE_EVIDENCE,
): FlakyVerdict | null {
  const raw = indictments(entries, windowRuns, excludePrefix);
  if (raw === null) return null;
  const reds: FlakySuspect[] = [];
  const regeneratedOut: RegeneratedSuspect[] = [];
  const fixedOut: FixedSuspect[] = [];
  const movedOut: MovedSuspect[] = [];
  const latestTree = entries.slice(-windowRuns).at(-1)?.treeId;
  // A RECURRENCE VOIDS THE FIX FOR EVERY TEST IT EXPLAINS (design NH-D): a
  // digest a fix's reproduction saw, failing on ANY bytes other than the fix's
  // parent's for ANY identity that fix is declared for, voids the fix for that
  // digest for all of them. "Other bytes" includes bytes OLDER than the parent:
  // content keys carry no order, so the rule cannot tell an earlier tree from a
  // later one and errs strict (correctness F-L4: more red, never less). Ordering
  // by ancestry is owned (FLAKE-RECURRENCE-ORDER).
  const recurred = new Set<string>();
  for (const { identity, failedOn } of raw) {
    for (const declared of causes.declared.filter((entry) => entry.identity === identity && entry.change.semantic)) {
      const before = causes.contentKeyAt(`${declared.commit}^`, declared.paths);
      for (const { tree, digest } of failedOn) {
        if (tree !== null && digest !== null && causes.contentKeyAt(tree, declared.paths) !== before) recurred.add(`${declared.commit}\u0000${digest}`);
      }
    }
  }
  for (const { failedOn, ...suspect } of raw) {
    // A DECLARED AND REPRODUCED FIX explains the suspect: see the header.
    // (A test can fail for two causes fixed in two commits: each failure
    // must be one fix's, by bytes AND by what it said.)
    const usable = latestTree === undefined ? [] : causes.declared
      .filter((declared) => declared.identity === suspect.identity && declared.change.semantic)
      .flatMap((declared) => {
        const before = causes.contentKeyAt(`${declared.commit}^`, declared.paths);
        const after = causes.contentKeyAt(declared.commit, declared.paths);
        // What a failure measured is judged by the bytes of every declared
        // path, the test's own file WHOLE; the latest run measured a known
        // tree whose bytes differ (a cause the latest tree no longer holds is
        // other bytes).
        const latest = causes.contentKeyAt(latestTree, declared.paths);
        if (!contentKeyComplete(before) || !contentKeyComplete(after) || latest === null || latest === before) return [];
        const paths = [...declared.paths].sort().join("\n");
        const reproduction = causes.reproductions.find((record) => record.identity === declared.identity &&
          record.fix.commit === declared.commit && [...record.paths].sort().join("\n") === paths &&
          record.parent.contentDigest === contentKeyDigest(before) && record.fix.contentDigest === contentKeyDigest(after));
        const shown = reproduction === undefined ? undefined : reproducedDigests(reproduction, causes.statisticalRuns, causes.significance, causes.deterministicShims);
        if (shown === undefined || !("digests" in shown)) return [];
        const digests = new Set([...shown.digests].filter((digest) => !recurred.has(`${declared.commit}\u0000${digest}`)));
        return [{ declared, before, digests, locations: shown.locations }];
      });
    // A failure is the reproduced one when it said what the reproduction's parent runs said AND happened where they did
    // (its location among theirs for that digest; a row that recorded no location matches only a reproduction whose
    // failures named none either — absence never matches a place).
    const fixedBy = failedOn.map(({ tree, digest, location }) => tree === null || digest === null ? undefined
      : usable.find((fix) => fix.digests.has(digest) && (fix.locations[digest] ?? []).includes(location ?? "") && causes.contentKeyAt(tree, fix.declared.paths) === fix.before));
    if (usable.length > 0 && fixedBy.every((fix) => fix !== undefined)) {
      fixedOut.push({ suspect, fixes: [...new Set(fixedBy.map((fix) => fix!.declared))] });
      continue;
    }
    // A RECORDED MOVE to the live suite explains it: the test is gone from
    // the hermetic suite and its destination is in the live manifest.
    const test = testIdentityOfRow(suspect.identity);
    const suites = causes.suites;
    const move = suites === null || suites.hermetic.has(test) ? undefined
      : causes.moves.find((recorded) => recorded.from === test && suites.live.has(recorded.to));
    if (move !== undefined) {
      movedOut.push({ suspect, move });
      continue;
    }
    // A regeneration of the artifact this test judges explains every
    // failure recorded strictly before it. Provenance a verdict cannot read
    // (a null timestamp, a non-finite instant) never proves
    // pre-regeneration, so it counts as a real failure.
    const regeneration = regenerated
      .filter((r) => r.identity === suspect.identity)
      .find((r) =>
        suspect.failedAt.every((at) => {
          if (at === null) return false;
          const atMs = Date.parse(at);
          return (
            Number.isFinite(atMs) && Number.isFinite(r.regeneratedAtMs) && atMs < r.regeneratedAtMs
          );
        }),
      );
    if (regeneration !== undefined) {
      regeneratedOut.push({ suspect, regeneration });
      continue;
    }
    reds.push(suspect);
  }
  return { reds, regenerated: regeneratedOut, fixed: fixedOut, moved: movedOut };
}

/**
 * The fixed-suspects' note — what a green run prints, so a suspect a declared
 * fix explains is SAID with its fix commit and the content it changed; the
 * raw ledger rows stand.
 */
export function fixedSuspectsMessage(fixed: readonly FixedSuspect[]): string {
  const perSuspect = fixed
    .map((f) => `${f.suspect.identity}: indicted but every recorded failure (${f.suspect.failedAt.join(", ")}) measured the content ` +
      `a declared fix changed, and failed as its recorded reproduction did (${f.fixes.map((fix) => `${fix.commit}: ${fix.paths.join(", ")}`).join("; ")}); a failure on any other content, or saying anything else, reds regardless`)
    .join("; ");
  return `flaky-test memory: ${String(fixed.length)} test(s) indicted but explained by a declared fix of their cause — the raw ledger rows stand. ${perSuspect}`;
}

/** The moved-suspects' note: each suspect with the recorded move that took its test to the live suite. */
export function movedSuspectsMessage(moved: readonly MovedSuspect[]): string {
  const perSuspect = moved
    .map((m) => `${m.suspect.identity}: indicted (${m.suspect.failedAt.join(", ")}) but its test left the hermetic suite in ${m.move.commit} ` +
      `and is ${m.move.to} in the live suite's manifest; if it returns to the hermetic suite it reds again`)
    .join("; ");
  return `flaky-test memory: ${String(moved.length)} test(s) indicted but moved to the live suite by a recorded move — the raw ledger rows stand. ${perSuspect}`;
}


/**
 * The regeneration-muted-suspects' note — the same honesty for the
 * mechanical dimension: a green verdict that explained suspects by a
 * regeneration and said nothing would read as "the tree was always clean",
 * the false history the raw rows exist to prevent. The note names the
 * regeneration instant, so a reader can see the boundary the exclusion
 * was judged against and knows a failure recorded at or after it reds
 * regardless.
 */
export function regeneratedSuspectsMessage(regenerated: readonly RegeneratedSuspect[]): string {
  const perSuspect = regenerated
    .map(
      (r) =>
        `${r.suspect.identity}: indicted but explained by the artifact's regeneration at ` +
        `${new Date(r.regeneration.regeneratedAtMs).toISOString()} — every recorded failure ` +
        `(${r.suspect.failedAt.join(", ")}) predates it, the known pre-regeneration state; ` +
        `a failure recorded at or after it reds regardless`,
    )
    .join("; ");
  return (
    `flaky-test memory: ${String(regenerated.length)} test(s) indicted but explained by a later ` +
    `regeneration of the artifact they judge — the raw ledger rows stand. ${perSuspect}`
  );
}

/**
 * The guard's failure message, built once for both suites' LIVE arms — two
 * guards whose reds must say the same thing share the sentence here, so the
 * wording cannot drift between suites.
 *
 * The message carries the verdict's whole evidence: the suspect identities
 * with the runs they failed in, the window that was applied, and the
 * population examined — a red the reader can act on without re-running
 * anything, and a green run's log line that says what it looked at.
 */
export function flakySuspectsMessage(
  suspects: readonly FlakySuspect[],
  windowRuns: number,
  rowsExamined: readonly RunFailureRows[],
): string {
  return (
    `flaky-test memory: ${String(suspects.length)} test(s) failed within the last ` +
    `${String(windowRuns)} recorded run(s) but not in the latest one. A flaky failure is an ` +
    `unread bug report: investigate the failure, do not re-run it away — the suspect clears ` +
    `when its fix is declared (a Flake-cause: trailer) and reproduced (\`harness flake reproduce\`: ` +
    `it failed so on the fix's parent and passes on the fix, under the same conditions), or when its test's move to ` +
    `the live suite is recorded (\`harness flake move\`); nothing ages a failure out (the suspect archive is never trimmed). ` +
    `(examined ${String(rowsExamined.length)} recorded run(s), ` +
    `${String(rowsExamined.reduce((n, r) => n + r.failures.length, 0))} failure row(s); ` +
    `suspects: ${suspects.map((s) => `${s.identity} failed at ${s.failedAt.join(", ")}`).join("; ")})`
  );
}

/**
 * WHAT CHANGED BETWEEN TWO JUDGED RUNS — the one comparison a writer makes
 * after every qualification run (this repository's writers diffed failure
 * identities with scratch scripts, round after round). `new`: failing now,
 * not in the baseline (re-run each alone before calling it yours — a load
 * flake reads the same); `persisting`: in both; `fixed`: in the baseline
 * only. A run that recorded no failure list is `unmeasured`, never "all fixed".
 */
export type RunFailureDiff =
  | Readonly<{ verdict: "unmeasured"; reason: string }>
  | Readonly<{ verdict: "compared"; new: readonly string[]; persisting: readonly string[]; changed: readonly string[]; fixed: readonly string[] }>;

/**
 * `changed` ⊆ `persisting`: an identity failing in both runs whose recorded
 * digests ({@link failureDigest}) differ — it fails DIFFERENTLY now (a red
 * guard with more offenders than before is a new defect hiding under an old
 * identity: FIX1-RUN-DIFF-CHANGED). Identities without a digest on either
 * side are never `changed` (unknown, not equal).
 */
export function diffRunFailures(baseline: JudgedRunRecord, current: JudgedRunRecord): RunFailureDiff {
  if (baseline.failures === undefined || current.failures === undefined) {
    return { verdict: "unmeasured", reason: `the ${baseline.failures === undefined ? "baseline" : "current"} run recorded no failure list` };
  }
  const before = new Set(baseline.failures);
  const after = new Set(current.failures);
  const persisting = [...after].filter((row) => before.has(row)).sort();
  return {
    verdict: "compared",
    new: [...after].filter((row) => !before.has(row)).sort(),
    persisting,
    // Fails differently: what it said, or where it happened, differs (each judged where both runs recorded it).
    changed: persisting.filter((row) => {
      const differs = (was: string | undefined, now: string | undefined): boolean => was !== undefined && now !== undefined && was !== now;
      return differs(baseline.failureDigests?.[row], current.failureDigests?.[row]) || differs(baseline.failureLocations?.[row], current.failureLocations?.[row]);
    }),
    fixed: [...before].filter((row) => !after.has(row)).sort(),
  };
}
