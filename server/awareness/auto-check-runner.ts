/**
 * Auto-check runner — executes REAL quality/validation checks against a
 * project path and returns a completed status + structured output.
 *
 * Previously the "Run typecheck" / "Run lint" buttons only registered a
 * "running" record that never completed. This module runs the
 * actual check so the auto-checks panel shows real results.
 *
 * Checks:
 * typecheck: `npx tsc --noEmit` in the project directory (real
 * TypeScript typecheck; passes on exit 0, fails otherwise).
 * lint: the canonical quality indicator (awareness-based, no
 * tree-sitter dependency). The verdict compares the MEASURED sub-metrics
 * against the declared lint-gate thresholds (`webUi.quality.lintGate`);
 * an unmeasured required sub-metric FAILS the check (deny-by-default).
 * The composite score/grade appear in the output as information only.
 *
 * Both are bounded by a timeout and capture structured output. The
 * runner is the single owner of the checkName → execution mapping.
 */

import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { createRequire } from "node:module";
import { recordEffectAsync, guarded } from "../kernel/canonical.ts";
// The process itself is created by the confinement owner's single door
// (`spawnPlanned`), which is why `spawn` is no longer imported here.
import {
  prepareConfinedSpawn,
  readGuardianOutcome,
  spawnPlanned,
  type ConfinedSpawn,
} from "../safety/landlock-runner.ts";
import { getQualityIndicatorAsync } from "./quality-bridge.ts";

/**
 * The OWNERSHIP gate the quality bridge accepts, taken from its own signature
 * rather than by importing `fs-gate.ts` — one less edge in this module's graph,
 * and the type cannot drift from the parameter it describes.
 *
 * Named `ownershipGate` at every use below and NOT `gate`, because `runLint`
 * already binds `const gate = getLintGateConfig()` — the LINT gate, a different
 * thing entirely. A parameter called `gate` put that `const` in the temporal
 * dead zone and the read threw "Cannot access 'gate' before initialization",
 * which the retry loop then swallowed into a `lint_failed` status: a crash
 * reported as a verdict. Two things called "gate" in one function is the defect;
 * the rename is the fix.
 */
type OwnershipGate = NonNullable<Parameters<typeof getQualityIndicatorAsync>[1]>;
import { MapNotReadyError, AwarenessNotReadyError, ProjectPathError } from "../kernel/errors.ts";
import { serverConfig } from "../kernel/config.ts";
import { getAutoCheckMaxCaptureBytes, getLintGateConfig } from "../kernel/harness-config.ts";
import { webWarn } from "../observability/debug-bridge.ts";

export type AutoCheckOutcome = Readonly<{
  readonly status: "passed" | "failed" | "warning";
  readonly output: Readonly<Record<string, unknown>>;
}>;

// The max stdout/stderr capture cap is config-driven (previously an
// inline 256-KiB literal). Read at CALL time via
// `getAutoCheckMaxCaptureBytes` so a config edit (mtime invalidation) is
// picked up without a process restart. No module-level constant — the
// config owner is the single source of truth.

const moduleRequire = createRequire(import.meta.url);

/** Resolve a module specifier without throwing when it is not found. */
function tryResolve(spec: string, opts?: { paths?: string[] }): string | null {
  try {
    return opts !== undefined ? moduleRequire.resolve(spec, opts) : moduleRequire.resolve(spec);
  } catch {
    // Not installed at the requested location — return null so the caller
    // can fall through to the next candidate (a typed absence, not a throw).
    return null;
  }
}

/**
 * WHERE THE TYPECHECKER COMES FROM — this server's own install, and nowhere
 * else.
 *
 * ── THE ESCAPE THIS CLOSES, WHICH WAS DRIVEN END TO END ───────────────────
 *
 * This used to PREFER the project's own `typescript`, resolving it with the
 * project as the lookup root, and the check then ran it with the server's full
 * authority. The project directory is writable from inside the sandbox, so
 * that made the program a piece of model-controlled content: a confined
 * `execute_command` wrote `<project>/node_modules/typescript/{package.json,
 * lib/typescript.js,bin/tsc}`, the check executed `bin/tsc`, and the payload
 * wrote a file OUTSIDE the project and overwrote one inside the harness's
 * PROTECTED source tree — both things the same confined command had just been
 * refused. The check reported `passed`.
 *
 * "The project's pinned tsc version" was the reason for preferring it, and it
 * is a real convenience with no safe form: a version chosen by a file the
 * model can write IS the model choosing the program. There is no lookup order
 * that fixes that, so the preference is gone rather than reordered — a second
 * place to go looking for the same answer is a fallback source, and this one
 * was a fallback source that could be planted.
 *
 * ── AND WHY THIS IS NOT THE WHOLE FIX ─────────────────────────────────────
 *
 * Resolving from our own install makes the program ours; it does not make the
 * INPUT ours. `tsc` reads the project's `tsconfig.json`, and a compiler
 * reading a project-controlled configuration is exactly the shape that made
 * `git` dangerous. So the check is also confined, with the checker's own
 * directory allow-listed read-and-execute — see `runTypecheck`. Neither half
 * is sufficient and the pair is cheap.
 *
 * TypeScript's `package.json` `exports` field does not expose `./bin/tsc`, so
 * the package main is resolved and the `bin/tsc` path derived from it.
 * Returns null when this server has no `typescript` at all, which is an
 * honest absence the caller reports rather than papering over with a second
 * lookup.
 */
function resolveOwnTsc(): string | null {
  const main = tryResolve("typescript");
  if (main === null) return null;
  // main is <root>/node_modules/typescript/lib/<entry>; bin is two dirs up + bin/tsc
  const tsc = join(dirname(dirname(main)), "bin", "tsc");
  return existsSync(tsc) ? tsc : null;
}

/**
 * The directory the checker lives in — allow-listed READ and EXECUTE so the
 * confined check can actually run its own toolchain, and never writable, so a
 * confined command cannot arrange for the next check to run its code.
 *
 * This is the narrow rule the previous round decided it did not want to make.
 * The blocker it recorded — `EACCES` on `node_modules/typescript/bin/tsc` when
 * the check was confined — was real and was read as a reason to leave the
 * check unconfined. It is a reason to allow the checker's own tree: one path,
 * read-only, derived from where the checker actually resolved to.
 *
 * WHY THE INSTALL DIRECTORY AND NOT THE PACKAGE, WHICH IS MEASURED RATHER THAN
 * PREFERRED. The obvious narrower rule is the `typescript` package itself, and
 * it was tried first. It fails: `typescript`'s `bin/tsc` is a launcher that
 * `execve`s a NATIVE compiler shipped in a SIBLING package
 * (`@typescript/typescript-<platform>-<arch>`), which the package's own
 * directory does not contain. Confined to the package alone the check died
 * with `process.execve failed with error code EACCES` — the same shape as the
 * blocker recorded last round, one directory further in, and a good
 * illustration of why "it failed with EACCES" is never by itself a reason to
 * stop confining something.
 *
 * So the rule is the directory the checker's package was installed into, which
 * is where its platform sibling is by construction. It is derived from where
 * the checker actually resolved to rather than named; it is THIS SERVER's
 * install and never the project's; and it carries no write flag, so the
 * property that matters is untouched — a confined command cannot alter the
 * checker, and therefore cannot arrange for the next check to run its code.
 */
function checkerToolPaths(tscScript: string): readonly string[] {
  // <install>/typescript/bin/tsc → <install>
  return [dirname(dirname(dirname(tscScript)))];
}

/**
 * The check names this runner can actually execute. THE ARRAY OWNS THE
 * VOCABULARY — a Zod enum reads it directly (`z.enum` needs a tuple, not a
 * Set), and the Set view below derives from it, so a check added here reaches
 * the runner, the `run.checks/rerun` input schema, and the membership test in
 * one edit with no second list to drift.
 */
export const RUNNABLE_CHECK_NAMES = ["typecheck", "lint"] as const;
export type RunnableCheckName = (typeof RUNNABLE_CHECK_NAMES)[number];

/** The membership view of {@link RUNNABLE_CHECK_NAMES}. */
export const RUNNABLE_CHECKS: ReadonlySet<string> = new Set(RUNNABLE_CHECK_NAMES);

export function isRunnableCheck(name: string): boolean {
  return RUNNABLE_CHECKS.has(name);
}

/**
 * Run a named check against a project path. Returns a completed
 * outcome (status + structured output). Unknown check names return a
 * typed "not runnable" outcome so the caller can fall back to the
 * generic register path.
 *
 * `ownershipGate` is FORWARDED to the quality bridge, which takes an OPTIONAL
 * one — and an omitted gate is an unchecked call that looks identical to a
 * checked one. The ownership of this path IS established upstream
 * (`blocks/checks.ts` resolves `db.getProject(projectId, user.userId)` before
 * calling), so this is not the repair of a live leak; it is the invariant being
 * enforced where the bridge enforces it rather than argued from a call chain a
 * reader has to reconstruct. The identical call in the run route already passed
 * one, and this one sat one directory outside the guard's universe until the
 * universe stopped being a directory.
 */
export async function runAutoCheck(checkName: string, projectPath: string, ownershipGate?: OwnershipGate): Promise<AutoCheckOutcome> {
  switch (checkName) {
    case "typecheck":
      return await runTypecheck(projectPath);
    case "lint":
      return await runLint(projectPath, ownershipGate);
    default:
      return {
        status: "warning",
        output: { error: "check_not_runnable", checkName, message: `No runner is configured for check '${checkName}'.` },
      };
  }
}

/**
 * Spawn a subprocess and capture its stdout/stderr WITHOUT blocking the event
 * loop (replaces the synchronous child_process call that wedged the
 * single-threaded HTTP server for the typecheck duration). The child runs
 * asynchronously; the event loop stays responsive (HTTP requests are served
 * while tsc runs). A bounded `timeoutMs` kills the child with SIGTERM so a
 * wedged compiler cannot run forever. Output is capped at `maxCaptureBytes`
 * — accumulation stops past the cap so a runaway compiler cannot
 * grow memory unboundedly. Resolves (never rejects) with the captured
 * stdout/stderr (already capped), exit status, signal, and a `timedOut`
 * flag; the caller translates these into a typed outcome.
 */
type SpawnCaptureResult = Readonly<{
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}>;

function spawnCapture(
  plan: Extract<ConfinedSpawn, { kind: "confined" | "unconfined" }>,
  effectName: string,
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; stdio: readonly ("ignore" | "pipe")[] }>,
  timeoutMs: number,
  maxCaptureBytes: number,
): Promise<SpawnCaptureResult> {
  // RECORDING CHOKE POINT for the `process` effect kind on the auto-check
  // path: every check subprocess (typecheck's tsc today, any future check)
  // spawns through this function, so spawn → exit is recorded here as one
  // `process` effect with the real exit status and measured duration.
  // `spawnCaptureInner` RESOLVES (never rejects) and signals failure by
  // RESULT — non-zero/absent exit status or a timeout kill — so `failedWhen`
  // is required; return-vs-throw alone would record every failure as
  // "succeeded". A spawn error resolves with `status: null`, which is
  // likewise classified as failed. The name is the executable's basename
  // (`node`, `npx`), the honest identity of what ran.
  //
  // Same known gap as execute_command's spawn: a check subprocess may write
  // files (tsBuildInfo, caches) and nothing real captures which paths it
  // touched, so no file list is recorded — only THAT the process ran, with
  // its real exit code. Fabricating a touched-file list is prohibited.
  return recordEffectAsync(
    "process",
    effectName,
    () => spawnCaptureInner(plan, options, timeoutMs, maxCaptureBytes),
    {
      failedWhen: (r) => r.timedOut || r.status !== 0,
      errorOf: (r) => ({
        message: r.timedOut
          ? `timed out after ${timeoutMs}ms (SIGTERM)`
          : `exit ${r.status ?? "null"}${r.stderr.trim().length > 0 ? `: ${r.stderr.trim()}` : ""}`,
        code: r.timedOut ? "process_timeout" : "process_failed",
      }),
    },
  );
}

function spawnCaptureInner(
  plan: Extract<ConfinedSpawn, { kind: "confined" | "unconfined" }>,
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; stdio: readonly ("ignore" | "pipe")[] }>,
  timeoutMs: number,
  maxCaptureBytes: number,
): Promise<SpawnCaptureResult> {
  return new Promise<SpawnCaptureResult>((resolve) => {
    // StringDecoder (not raw `.toString("utf8")` per chunk) so a multi-byte
    // UTF-8 character split across chunk boundaries is NOT corrupted into
    // replacement chars — the decoder buffers the incomplete trailing
    // sequence until the next chunk completes it. Bug found + fixed this
    // round.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (r: SpawnCaptureResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      // THE ONE DOOR. This module holds no `spawn` of its own — the confinement
      // owner starts every process this server creates, so a check cannot
      // acquire an unconfined child by forgetting to ask.
      child = spawnPlanned(plan, options);
    } catch (err) {
      settle({ stdout: "", stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`, status: null, signal: null, timedOut: false });
      return;
    }
    child.stdout?.on("data", guarded("awareness.check.stdout", (d: Buffer) => {
      if (stdout.length < maxCaptureBytes) {
        stdout += stdoutDecoder.write(d.subarray(0, Math.min(d.length, maxCaptureBytes - stdout.length)));
        if (stdout.length > maxCaptureBytes) stdout = stdout.slice(0, maxCaptureBytes);
      }
    }));
    child.stderr?.on("data", guarded("awareness.check.stderr", (d: Buffer) => {
      if (stderr.length < maxCaptureBytes) {
        stderr += stderrDecoder.write(d.subarray(0, Math.min(d.length, maxCaptureBytes - stderr.length)));
        if (stderr.length > maxCaptureBytes) stderr = stderr.slice(0, maxCaptureBytes);
      }
    }));
    child.on("error", guarded("awareness.check.error", (err: Error) => {
      settle({ stdout, stderr: stderr.length > 0 ? `${stderr}\nspawn error: ${err.message}` : `spawn error: ${err.message}`, status: null, signal: null, timedOut });
    }));
    child.on("close", guarded("awareness.check.close", (status: number | null, signal: NodeJS.Signals | null) => {
      // Flush any buffered incomplete trailing bytes (the decoder's end emits
      // a replacement char for a dangling sequence — correct final behavior).
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      settle({ stdout: stdout.slice(0, maxCaptureBytes), stderr: stderr.slice(0, maxCaptureBytes), status, signal, timedOut });
    }));
    if (timeoutMs > 0) {
      timer = setTimeout(guarded("awareness.check.timeout", () => {
        timedOut = true;
        // SIGTERM lets tsc flush; the 'close' event resolves with signal=SIGTERM.
        // The kill can only fail if the child already exited between the timer
        // firing and the call — a benign race. Route it through the centralized
        // debug bridge instead of swallowing it.
        try { child.kill("SIGTERM"); } catch (killErr) {
          webWarn("auto-check-runner", "typecheck child kill failed (already exited?)", () => ({ error: killErr instanceof Error ? killErr.message : String(killErr) }));
        }
      }), timeoutMs);
    }
  });
}

async function runTypecheck(projectPath: string): Promise<AutoCheckOutcome> {
  const cwd = resolve(projectPath);
  if (!existsSync(cwd)) {
    return { status: "failed", output: { error: "project_not_found", path: projectPath } };
  }
  const hasTsconfig = existsSync(resolve(cwd, "tsconfig.json"));
  const tscScript = resolveOwnTsc();
  if (tscScript === null) {
    // A GUIDED ABSENCE, NOT A SECOND LOOKUP. The previous fall-through was
    // `npx tsc`, which is a different place to go looking for the same answer
    // — and one that reaches the network and a cache outside the project. A
    // missing checker is something to say plainly, with what to do about it.
    return {
      status: "failed",
      output: {
        error: "typechecker_not_installed",
        message:
          "This harness has no TypeScript typechecker installed, so the typecheck could not run. Install TypeScript in the harness (npm install typescript) and run the check again.",
      },
    };
  }
  const cap = getAutoCheckMaxCaptureBytes();
  // async spawn — the typecheck runs OFF the event loop so the HTTP
  // server never blocks (root cause of the prior synchronous-spawn wedge).
  // the capture cap is config-driven (tools.autoCheck.maxCaptureBytes).
  const args = [tscScript, "--noEmit", ...(hasTsconfig ? ["-p", "tsconfig.json"] : [])];
  // CONFINED, LIKE EVERY OTHER SUBPROCESS THIS SERVER STARTS. The checker is
  // ours now, but its INPUT — `tsconfig.json`, and every file it is pointed
  // at — belongs to the project, and a compiler steered by project-controlled
  // configuration is the same capability as a command the model chose. The
  // checker's own directory travels with the request as a read-and-execute
  // rule, which is what makes confinement possible here at all.
  const plan = prepareConfinedSpawn({
    command: process.execPath,
    args,
    projectRoot: cwd,
    toolPaths: checkerToolPaths(tscScript),
  });
  if (plan.kind === "refused") {
    return {
      status: "failed",
      output: {
        error: "typecheck_refused",
        confinement: "refused",
        confinementCode: plan.code,
        ran: false,
        message: plan.message,
      },
    };
  }
  const release = plan.kind === "confined" ? plan.release : (): void => {};
  try {
    const res = await spawnCapture(plan, basename(process.execPath), {
      cwd,
      env: serverConfig.subprocessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }, serverConfig.typecheckTimeoutMs, cap);
    // Under confinement the process that exited is the GUARDIAN, and it has
    // two quite different endings: it restricted itself and became the
    // checker, or it refused and the checker never existed. Reading the second
    // as "the typecheck failed" would report a check that never ran as a
    // check that found problems — a false statement in the direction the
    // reader acts on.
    const outcome = plan.kind === "confined"
      ? readGuardianOutcome(res.status, res.stderr)
      : ({ kind: "payload_ran", stderr: res.stderr } as const);
    if (outcome.kind === "refused_before_exec") {
      return {
        status: "failed",
        output: {
          error: "typecheck_refused",
          confinement: "refused",
          confinementCode: String(outcome.code),
          ran: false,
          message: `The typecheck was not run: ${outcome.message}`,
        },
      };
    }
    const stdout = res.stdout.slice(0, cap);
    const stderr = outcome.stderr.slice(0, cap);
    const timedOut = res.timedOut;
    const exitCode = res.status ?? null;
    const passed = exitCode === 0 && !timedOut;
    const errorCount = countTsErrors(stdout);
    return {
      status: passed ? "passed" : "failed",
      output: {
        exitCode,
        timedOut,
        errorCount,
        // WHAT AUTHORITY THIS CHECK ACTUALLY HAD, stated on every result
        // including the ones that passed — the same honesty rule the model's
        // own commands are held to.
        confinement: plan.kind === "confined" ? "confined" : "unconfined",
        ran: true,
        stdout,
        stderr,
      },
    };
  } catch (err) {
    webWarn("auto-check-runner", "typecheck spawn failed", () => ({ error: err instanceof Error ? err.message : String(err) }));
    return {
      status: "failed",
      output: { error: "typecheck_spawn_failed", message: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    // The guardian read its spec before it restricted itself, so the moment
    // this check has any terminal state the file is gone. Idempotent.
    release();
  }
}

/** Count `error TS` lines in tsc output for a quick summary metric. */
function countTsErrors(stdout: string): number {
  let n = 0;
  for (const line of stdout.split("\n")) {
    if (/\berror TS\d+/.test(line)) n += 1;
  }
  return n;
}

async function runLint(projectPath: string, ownershipGate?: OwnershipGate): Promise<AutoCheckOutcome> {
  // The quality indicator runs the awareness + repository-map workers
  // OFF the event loop (502-wedge fix). Under heavy parallel load (e.g. the
  // test suite spawning many workers concurrently) a worker can TRANSIENTLY
  // fail to start/finish, surfacing as a typed `MapNotReadyError` or
  // `AwarenessNotReadyError`. A single bounded retry on those typed transient
  // errors recovers the score without masking a real failure: a
  // `ProjectPathError` (genuine misconfiguration) fails immediately, and a
  // second transient failure still surfaces as an honest "lint_failed".
  // The quality indicator always returns a score for any codebase (good or
  // bad); it only throws when a WORKER fails — so retrying is appropriate.
  const LINT_RETRY_DELAY_MS = 200;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const indicator = await getQualityIndicatorAsync(projectPath, ownershipGate);
      // The verdict reads the MEASURED sub-metrics against the DECLARED
      // lint-gate thresholds (`webUi.quality.lintGate` — single owner).
      // The composite score/grade are a configured index, informational
      // only — they never decide the status (the prior >=80/>=60 cutoffs
      // over the uncalibrated composite let a failed computation pass).
      //
      // Truth table (deny-by-default):
      //   any required sub-metric unmeasured → FAILED (a check must never
      //     pass because its computation failed)
      //   all measured, any declared threshold breached → WARNING
      //   all measured, no breach → PASSED
      const gate = getLintGateConfig();
      const m = indicator.measured;
      const unmeasured = (["quality", "complexity", "clones", "typeLevel"] as const)
        .filter((k) => !m[k]);

      const hotspotCount = indicator.complexity?.hotspotCount ?? null;
      const cloneRatio = indicator.cloneStats?.cloneRatio ?? null;
      const typedFileFraction = indicator.typeLevel?.typedFileFraction ?? null;

      const breaches: string[] = [];
      if (m.quality && indicator.issuesPerKloc > gate.maxIssuesPerKloc) {
        breaches.push(`issuesPerKloc ${indicator.issuesPerKloc.toFixed(1)} > ${gate.maxIssuesPerKloc}`);
      }
      if (hotspotCount !== null && hotspotCount > gate.maxComplexityHotspots) {
        breaches.push(`complexityHotspots ${hotspotCount} > ${gate.maxComplexityHotspots}`);
      }
      if (cloneRatio !== null && cloneRatio > gate.maxCloneRatio) {
        breaches.push(`cloneRatio ${cloneRatio.toFixed(3)} > ${gate.maxCloneRatio}`);
      }
      if (typedFileFraction !== null && typedFileFraction < gate.minTypedFileFraction) {
        breaches.push(`typedFileFraction ${typedFileFraction.toFixed(3)} < ${gate.minTypedFileFraction}`);
      }

      const status: AutoCheckOutcome["status"] =
        unmeasured.length > 0 ? "failed"
          : breaches.length > 0 ? "warning"
            : "passed";
      return {
        status,
        output: {
          // score/grade are the configured composite index — INFORMATIONAL
          // ONLY (kept for display; the status above never reads them).
          score: indicator.overallScore,
          grade: indicator.grade,
          totalIssues: indicator.totalIssues,
          issuesPerKloc: indicator.issuesPerKloc,
          // null = not measured (honest absence, not a fabricated 0).
          cloneRatio,
          hotspotCount,
          typedFileFraction,
          // The verdict's inputs, so the panel can say WHY: which signals
          // were unmeasured and which declared thresholds were breached.
          unmeasured,
          breaches,
          gate,
          recommendations: indicator.recommendations,
        },
      };
    } catch (err) {
      // A genuine project-path problem is not transient — fail immediately.
      if (err instanceof ProjectPathError) {
        webWarn("auto-check-runner", "lint failed (project path)", () => ({ error: err.message }));
        return { status: "failed", output: { error: "lint_failed", message: err.message } };
      }
      // A transient worker-not-ready error: retry once (the second failure
      // below falls through to the honest "lint_failed" outcome).
      const transient = err instanceof MapNotReadyError || err instanceof AwarenessNotReadyError;
      // ANYTHING ELSE IS NOT AN ANSWER ABOUT THE PROJECT'S QUALITY, SO IT IS
      // RE-THROWN.
      //
      // This branch used to be `if (!transient || attempt === 1)` — every
      // unexpected error left here as `{"error":"lint_failed"}`, which is a
      // CRASH REPORTED AS A VERDICT. It happened: a shadowed binding put a
      // `const` in the temporal dead zone, and the resulting `ReferenceError`
      // reached the user as a lint result about their code. The instance was
      // renamed away (see `OwnershipGate` above) and the loop that swallowed it
      // was left exactly as it was, so the next `TypeError` from any bridge
      // would arrive dressed as a domain answer.
      //
      // The three types below are the ones this call is KNOWN to produce and
      // that have a meaning here. A `ReferenceError`, a `TypeError`, an
      // `InputError` from a bridge — anything not named — is a defect in this
      // program, and a defect must not be given a plausible shape.
      if (!transient) throw err;
      if (attempt === 1) {
        webWarn("auto-check-runner", "lint failed (worker not ready after retry)", () => ({ error: err instanceof Error ? err.message : String(err) }));
        return {
          status: "failed",
          output: { error: "lint_failed", message: err instanceof Error ? err.message : String(err) },
        };
      }
      await new Promise<void>((r) => setTimeout(r, LINT_RETRY_DELAY_MS));
    }
  }
  // Unreachable (the loop returns on every path), but kept for type safety.
  return { status: "failed", output: { error: "lint_failed", message: "retry exhausted" } };
}
