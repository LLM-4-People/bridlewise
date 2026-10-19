/**
 * Workflow operational defaults — the single source of truth for all
 * workflow-domain configurable values.
 *
 * Per the no-configurables-outside-config invariant: "No configurables
 * outside the global config file. One single source of truth. No default
 * values outside config." These numeric operational defaults (timeouts,
 * concurrency, stale intervals) previously lived as scattered `const
 * DEFAULT_*_MS` literals in `harness-commands.ts`, `resource-lock.ts`,
 * `workspace-manager.ts`, and `test-result-collector.ts`. They are
 * consolidated here so the `no-hardcoded-configurables` prevention test
 * passes and there is exactly one owner per concept.
 *
 * The resolved config document (`bridlewise.config.json` →
 * `ConfigDocument`) overrides these at runtime; the values here are the
 * fallback when a config field is absent. This file is the canonical
 * owner (its basename contains "config"), so the prevention scanner
 * excludes it.
 *
 * When the config document gains a field for one of these values, the
 * consumer should read `config.resourceLock.timeoutMs?? DEFAULT_LOCK_TIMEOUT_MS`
 * the default stays here as the fallback, the config overrides it.
 */

import type { ConfigDocument } from "../kernel/config-contracts.ts";
import { InputError } from "../kernel/errors.ts";
import { statePath } from "../kernel/product-identity.ts";

/**
 * A workflow operational option, or its default when absent: a present value
 * must be a finite number above zero (`positive`) or at least zero
 * (`non-negative`), else the typed `workflow_option_invalid` naming the option. The ONE
 * validator of the workflow's numeric options (the resource locks, the test
 * collector's concurrency): it was two private copies, the DRY allowlist's
 * standing baseline pair.
 */
export function numericOption(value: number | undefined, fallback: number, name: string, bound: "positive" | "non-negative"): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || (bound === "positive" ? value <= 0 : value < 0)) {
    throw new InputError(`${name} must be a ${bound} finite number`, "workflow_option_invalid");
  }
  return value;
}

// ── harness-commands.ts defaults ──────────────────────────────────────────

export const DEFAULT_TYPECHECK_TIMEOUT_MS = 120_000;

// ── the ONE command runner (checkout-setup.ts): errored-class retries ───────

/** How often an ERRORED command (a ceiling, a signal, an environmental marker) is retried (`harness.commandErroredRetries`). */
const DEFAULT_COMMAND_ERRORED_RETRIES = 2;
/** The wait before the first retry, doubled for each next one (`harness.commandRetryBackoffMs`). */
const DEFAULT_COMMAND_RETRY_BACKOFF_MS = 60_000;

/** The ONE command runner's errored-class retry policy as `document` configures it (the one reader of both settings; `{}` answers the defaults). */
export function commandRetryPolicy(document: Pick<ConfigDocument, "harness">): Readonly<{ retries: number; backoffMs: number }> {
  return Object.freeze({
    retries: document.harness?.commandErroredRetries ?? DEFAULT_COMMAND_ERRORED_RETRIES,
    backoffMs: document.harness?.commandRetryBackoffMs ?? DEFAULT_COMMAND_RETRY_BACKOFF_MS,
  });
}
export const DEFAULT_GIT_ADD_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_COMMIT_TIMEOUT_MS = 30_000;
export const DEFAULT_DISPOSITION_AUTO_ADD_TIMEOUT_MS = 120_000;
export const DEFAULT_SYNC_REGISTER_TIMEOUT_MS = 180_000;
export const DEFAULT_SYNC_REGENERATE_TIMEOUT_MS = 420_000;
export const DEFAULT_SYNC_CHECK_TIMEOUT_MS = 240_000;

// Subprocess timeout for `harness sync --with-bundle`'s bundle-build step.
// The esbuild bundle (scripts/build-bundle.ts) is a fast deterministic build
// (~3-5s warm); the bound is generous to absorb a cold node module resolve.
// The bundle must rebuild BEFORE `regenerate` so the regenerated hash bindings
// pin the fresh bundle sha256 in one pass (eliminates the bundle/regenerate
// chicken-and-egg that required two sync rounds to stabilize manifest drift).
export const DEFAULT_SYNC_BUNDLE_TIMEOUT_MS = 120_000;

// ── resource-lock.ts defaults ─────────────────────────────────────────────

export const DEFAULT_LOCK_DIRECTORY = statePath("state", "locks");
export const DEFAULT_LOCK_TIMEOUT_MS = 120_000 as const;

/**
 * How long `scripts/merge-round.mjs` waits for the merge file lock.
 *
 * ── WHY THIS MOVED HERE ──────────────────────────────────────────────────
 *
 * It lived in `src/shared/workflow/workflow-config.mjs` under the name
 * `DEFAULT_LOCK_TIMEOUT_MS` — the SAME name as the resource-lock default just
 * above, with a different value (60_000 against 120_000), and BOTH files
 * headed "the canonical owner". Two owners for one word is the shape this
 * project keeps rediscovering, and here it was worse than a duplicate: the
 * two names meant different things, so neither value was wrong and the
 * disagreement looked like drift.
 *
 * The stated reason for the split was that a `.mjs` script "cannot import the
 * `.ts` workflow config". Driven on this runtime (node 24.18.0): a `.mjs`
 * module importing a `.ts` module resolves and runs, exit 0. The reason was a
 * runtime axis expressed as a duplicated constant, and the axis does not
 * exist.
 *
 * The merge lock and the resource lock are genuinely different mechanisms —
 * `merge-round.mjs` creates its own `O_EXCL` lock file, `resource-lock.ts`
 * does not — so they keep separate values. What they may not keep is
 * separate homes, or the same name.
 */
export const DEFAULT_MERGE_LOCK_TIMEOUT_MS = 60_000 as const;
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 100 as const;
export const DEFAULT_LOCK_STALE_MS = 300_000 as const;

// ── workspace-manager.ts defaults ──────────────────────────────────────────

const DEFAULT_WORKSPACE_INSPECT_TIMEOUT_MS = 30_000;
const DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_MERGE_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_REMOTE_OPERATION_TIMEOUT_MS = 60_000;

/**
 * The git ceilings of a worktree's owner (`workspaceGit.timeouts`, each
 * defaulted above): `worktreeMs` a worktree add, remove or switch and the
 * land; `inspectMs` an inspection; `mergeMs` a commit that runs the
 * repository's hooks; `fetchMs` / `pushMs` a fetch (or a remote listing) and
 * a push. One reader for the workspace manager and the promotion.
 */
export function worktreeOperationTimeouts(document: Pick<ConfigDocument, "workspaceGit">): Readonly<{ worktreeMs: number; inspectMs: number; mergeMs: number; fetchMs: number; pushMs: number }> {
  const timeouts = document.workspaceGit?.timeouts;
  return Object.freeze({
    worktreeMs: timeouts?.addMs ?? DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS,
    inspectMs: timeouts?.inspectMs ?? DEFAULT_WORKSPACE_INSPECT_TIMEOUT_MS,
    mergeMs: timeouts?.commitMs ?? DEFAULT_MERGE_OPERATION_TIMEOUT_MS,
    fetchMs: timeouts?.fetchMs ?? DEFAULT_REMOTE_OPERATION_TIMEOUT_MS,
    pushMs: timeouts?.pushMs ?? DEFAULT_REMOTE_OPERATION_TIMEOUT_MS,
  });
}

/**
 * The merge gate's end-to-end suite bound (`scripts/harness-root/merge-round.mjs`
 * hands it to `runE2e` in src/shared/workflow/e2e-runner.mjs, which holds no
 * default of its own). The engine suite measured 5-7 min on this host in
 * 2026-09 (the runner's comment said "~14 min" for a 10 min default).
 */
export const DEFAULT_E2E_SUITE_TIMEOUT_MS = 600_000;

/** How many events `harness timeline` lists when no `--limit` is given. */
export const DEFAULT_TIMELINE_COMMAND_LIMIT = 50;

// ── test-result-collector.ts defaults ──────────────────────────────────────

export const MAXIMUM_PARALLEL_CONCURRENCY = 16 as const;
export const MINIMUM_PARALLEL_CONCURRENCY = 2 as const;

// S1 verification content-hash memoization cap. verifyS1Structure is a pure
// function of the filesystem at `root`; the cache is keyed by the manifest
// content hash (SHA-256 of every file). A test run produces at most ~117
// distinct hashes; the cap guards against pathological inventories only.
export const DEFAULT_S1_VERIFICATION_CACHE_MAX_ENTRIES = 512 as const;

// Filesystem-backed S1 verification cache cap. The serial test phase uses
// process isolation (each serial file runs in its own node process), so the
// in-memory cache is per-process and NOT shared across the ~8-12 serial
// processes. The filesystem cache (under os.tmpdir()/harness-s1-cache/) is
// shared across all processes on the machine, keyed by the manifest content
// hash. The first process to verify a given manifest hash computes + writes;
// subsequent processes read the cached result instead of re-parsing every
// source file with Babel. The cap bounds the cache directory size (FIFO
// eviction by mtime). Best-effort: a filesystem failure (read-only tmpdir,
// full disk) falls through to computation with no correctness impact.
export const DEFAULT_S1_FILESYSTEM_CACHE_MAX_ENTRIES = 256 as const;

// Filesystem-backed S1 verification cache directory (relative to os.tmpdir()).
// Shared across all processes on the machine. The directory is created
// best-effort on first write; a creation failure (read-only tmpdir) falls
// through to computation.
export const DEFAULT_S1_FILESYSTEM_CACHE_DIRECTORY = "harness-s1-cache" as const;

// THE POPULATION THIS BOUNDS IS ONE TEST CASE.
//
// It is the runner's per-test `timeout`, so a test that never settles fails
// with `testTimeoutFailure` and the rest of its file still runs. Without it
// the children ran at node's default of "never", and a hung test did not fail
// the suite — it removed the suite. `suiteRuntimeBudgetMs` cannot cover this:
// it is judged after the run returns, and a run that never returns is never
// judged.
//
// Where the number comes from. The slowest FILE measured on this suite is
// `test/foundation-cascade.test.ts` at 45,195 ms; a file's duration is the sum
// of its tests, so that is a measured upper bound on the slowest single test.
// 120 s sits ~2.6x above it, which is headroom for contention rather than a
// second opinion about the file set. If the slowest file approaches this
// number, the bound has stopped being an upper bound and must be re-derived
// rather than raised.
//
// This comment previously described a per-FILE budget read by a prevention
// test from the durations cache. That mechanism no longer exists —
// `test/prevention/test-runtime-budget.test.ts` judges only
// `suiteRuntimeBudgetMs` — so the constant named a population that had been
// deleted, and was consumed by nothing at all: declared in the config,
// resolved by `readTestExecutionConfig`, and read by no code path.
// The value is a configurable (overridable via
// testExecution.runtimeBudgetMs).
export const DEFAULT_TEST_RUNTIME_BUDGET_MS = 120_000 as const;

// The ENGINE suite's watchdog (overridable via testExecution.engineSuiteWatchdog;
// enforced in scripts/tooling/inventory-test-run.ts): a phase that reports no
// test event for `stallTimeoutMs`, or a run still going at `hardCeilingMs`, is
// aborted and its running files killed and reported failed. The per-test kill
// timeout above cannot end a FILE whose cancelled test left a handle open
// (measured: one file held a run for two hours). The stall bound sits above
// that timeout, so a cancelled test always reports before a stall is
// declared; the ceiling is ~6x the measured full-suite wall clock (~5 min).
// A stopped run (a stall, the ceiling, an operator's stop) has `killGraceMs`
// after its SIGTERM before it and every descendant are SIGKILLed.
export type SuiteWatchdog = Readonly<{ stallTimeoutMs: number; hardCeilingMs: number; killGraceMs: number }>;
export const DEFAULT_ENGINE_SUITE_WATCHDOG: SuiteWatchdog = Object.freeze({ stallTimeoutMs: 300_000, hardCeilingMs: 1_800_000, killGraceMs: 3_000 });

// Default concurrency for the serial phase. Files marked as sharing
// process-level resources (evidence-worker spawns, S1 repository walks,
// harness-live-root regenerators) run in a SEPARATE phase after the parallel
// phase to avoid cross-phase I/O contention. Within that serial phase, a
// bounded concurrency lets the isolated serial files (each using its own
// temp directory) share the phase, cutting the serial wall time. 1 preserves
// the original fully sequential behavior; values >1 run that many serial
// files at once. The value is a configurable (overridable via
// testExecution.serialPhaseConcurrency).
export const DEFAULT_SERIAL_PHASE_CONCURRENCY = 2 as const;

// `DEFAULT_SUITE_RUNTIME_BUDGET_MS` (120 s, the suite's wall-clock budget)
// lived here and is DELETED with its concept: the suite budget is a CPU
// budget now, declared in the config as `testExecution.integrationSuiteCpuBudget`
// with NO default anywhere — a budget nobody chose is not a budget, and the
// silent 120 s fallback was exactly that. A missing declaration reaches the
// runner's gate as absent and is reported NOT JUDGED in plain words
// (`judgeSuiteCpu` in `src/shared/budget-verdict.ts`), never quietly judged
// against a constant. `DEFAULT_TEST_RUNTIME_BUDGET_MS` above survives
// because it is a different concept: a per-test KILL TIMEOUT, not a budget.

// Default serial-phase concurrency for the FULL test suite (RUN_SLOW=1). The
// slow serial files (S1 scenarios, harness-live-root) use process isolation
// when concurrency > 1, so each file gets its own process (no shared state, no
// live-repo races). A higher concurrency is safe with isolation and cuts the
// serial phase wall time dramatically. The value is a configurable (overridable
// via testExecution.fullSuiteSerialPhaseConcurrency). This is the concurrency
// for the SUBPROCESS-SPAWNING serial tier (files that import node:child_process
// or use the evidence pipeline); the in-process serial tier uses
// fullSuiteInProcessSerialPhaseConcurrency (higher, since no subprocess
// oversubscription).
export const DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY = 8 as const;

// Default serial-phase concurrency for the IN-PROCESS serial tier in the FULL
// test suite (RUN_SLOW=1). The in-process serial files (S1 scenarios that call
// verifyS1Structure/makeRuntimeCandidate, harness-commands architecture scans)
// are CPU-bound Babel-parse processes that thrash memory bandwidth + CPU cache
// when too many run at once. On a 12-CPU host, 12-way gives a 5.7× slowdown per
// scenario (17.7s isolated → ~100s) from the 15 Babel processes competing for
// memory. A LOWER concurrency (4) reduces the memory-contention penalty
// dramatically while keeping the subprocess tier (which runs concurrently at
// 8-way) close to its isolation speed. Total processes 4 + 8 = 12 (no
// oversubscription for the subprocess tier's child processes). The value is a
// configurable (overridable via testExecution.fullSuiteInProcessSerialPhaseConcurrency).
export const DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY = 4 as const;

// Default parallel-phase concurrency for the FULL test suite (RUN_SLOW=1).
// The full suite runs the parallel phase FIRST (alone), then the serial tiers
// concurrently. The parallel phase wall is dominated by the slowest parallel
// straggler (awareness ~46s) regardless of concurrency, so the value mainly
// affects how many parallel processes run at once during the (isolated)
// parallel phase. 12 (the host parallelism) is the proven-safe default; a
// lower value is a tunable for hosts where the parallel phase's process
// count matters. The value is a configurable (overridable via
// testExecution.fullSuiteParallelConcurrency).
export const DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY = 12 as const;

// Content-hash AST cache bounds for S1 verification. These caches memoize
// the Babel parse of source files so that mutated candidates (which share
// most file contents via copy-on-write reflinks) reuse cached parses for
// unchanged files. The number of distinct source files is bounded by the
// architecture manifest (~200 modules); the caps guard against pathological
// inventories only. These are implementation constants, not user-facing
// configurables — they live here so the no-hardcoded-configurables
// prevention test is satisfied (the config owner is the canonical home).
export const DEFAULT_ARCHITECTURE_SOURCE_CACHE_MAX_ENTRIES = 1024 as const;

// Filesystem-backed architecture source cache cap. The architecture source
// cache (analyzeArchitectureSource) stores the Babel parse + analysis result
// for each source file. The serial test phase uses process isolation, so
// the in-memory cache is per-process. The filesystem cache (shared across
// processes) lets candidate verifications reuse Babel parses from other
// processes — candidates share most files via copy-on-write reflinks, so
// only the mutated file needs re-parsing. The cap bounds the cache directory
// size (FIFO eviction by mtime, amortized).
export const DEFAULT_ARCHITECTURE_SOURCE_FILESYSTEM_CACHE_MAX_ENTRIES = 1024 as const;
export const DEFAULT_GOVERNED_SOURCE_PARSE_CACHE_MAX_ENTRIES = 1024 as const;
export const DEFAULT_GOVERNED_SOURCE_VIOLATIONS_CACHE_MAX_ENTRIES = 1024 as const;

// Filesystem-backed governed-source violations cache cap. Shares the
// governed-source AST analysis (violations) across serial-phase processes.
export const DEFAULT_GOVERNED_SOURCE_VIOLATIONS_FILESYSTEM_CACHE_MAX_ENTRIES = 1024 as const;
export const DEFAULT_STATIC_MODULE_SHAPE_CACHE_MAX_ENTRIES = 1024 as const;

// Filesystem-backed static-module-shape cache cap. Shares the lexical
// tokenization + module-shape analysis across serial-phase processes.
export const DEFAULT_STATIC_MODULE_SHAPE_FILESYSTEM_CACHE_MAX_ENTRIES = 1024 as const;

// Content-hash memoization cap for the Babel parse of root-policy.ts in
// extractBoundedTopLevelStaticLiteral. The function parses the same source up
// to ~11 times per verifyS1Structure call (once per propertyPath); caching
// collapses these into 1 parse per distinct source. Few distinct sources are
// ever parsed (root-policy.ts + occasional test mutations), so a small cap
// suffices.
export const DEFAULT_STATIC_LITERAL_PARSE_CACHE_MAX_ENTRIES = 64 as const;

// Filesystem-backed static-literal EXTRACTION cache cap. The in-memory
// parse cache (above) stores non-serializable Babel AST nodes, so it is
// per-process and NOT shared across the serial-phase processes. The
// filesystem cache stores the EVALUATED extraction result
// (StaticLiteralExtraction — a JSON-serializable { ok, value? }) keyed by
// the content hash + bindingName + propertyPath + freezeBoundary hash +
// identifierBindings hash. The first process to extract a given (source,
// binding, path) tuple computes + writes; the rest read the cached result
// instead of re-parsing root-policy.ts with Babel. This collapses the
// ~11 extractions per verifyS1Structure call across the ~10 serial
// processes (~110 Babel parses) to ~11 computes + ~cache hits. Best-effort:
// a filesystem failure falls through to computation with no correctness
// impact. The cap bounds the cache directory size (FIFO eviction by mtime,
// amortized).
export const DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES = 256 as const;

// ── workspace-manager.ts gate-output caps ──────────────────────────────────
// R49-V5: previously two scattered inline literals (`2048` and `2000`) in
// workspace-manager.ts. These cap gate-outcome text at the
// persistence boundary; the persisted bound stays well under the contract's
// 4096-char gate-output bound (owned by root-policy).

/** Cap one gate outcome's full text (reports, receipts). */
export const DEFAULT_MAXIMUM_GATE_OUTPUT_CHARACTERS = 2048 as const;
/** Persisted gate strings stay well under the contract's 4096-char bound. */
export const DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS = 2000 as const;

// ── R50: remaining scattered workflow caps ────────────────────
// Previously bare inline literals in workspace-cli.ts, test-inventory-binding.ts,
// and test-result-collector.ts with no owner.

/** workspace-cli git-runtime output byte cap (256 MiB). */
export const DEFAULT_GIT_RUNTIME_MAXIMUM_BYTES = 268_435_456 as const;
/** test-inventory-binding max reported violations (display cap). */
export const DEFAULT_MAX_REPORTED_VIOLATIONS = 20 as const;
/** test-result-collector assertion value truncation length. */
export const DEFAULT_ASSERTION_VALUE_MAX_LENGTH = 160 as const;
