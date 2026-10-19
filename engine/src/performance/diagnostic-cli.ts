import { extractErrorMessage, HarnessError, InputError } from "../kernel/errors.ts";
import { wrapResult, type CommandAnswer } from "../workflow/command-result.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import {
  createDiagnosticRunner,
  type DiagnosticRunResult,
} from "./diagnostic-modes.ts";
import { DIAGNOSTIC_MODE_IDS, type DiagnosticModeId } from "./performance-config.ts";
import { configuredPerformanceConfig } from "./configured-performance.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * `harness diagnostic` — collect an isolated snapshot of CPU, memory, I/O,
 * event-loop, process, and cgroup state and report it: the harness envelope
 * (`--json`, the default) or the snapshot summary (`--text`), the harness
 * CLI's one output option.
 *
 * Usage:
 * node src/cli.ts harness diagnostic [--mode cpu|memory|io|event-loop|process|cgroup] [--json|--text]
 *
 * The command does not require a provider or API key. It uses the central
 * {@link createDiagnosticRunner} with the config sourced from the pinned
 * central config document's `performance` section
 * ({@link configuredPerformanceConfig}: an undeclared section is the declared
 * default, a refused document propagates). With no `--mode` flag it runs every
 * enabled diagnostic mode; with `--mode` it runs only the named mode.
 */

export type DiagnosticCliOptions = Readonly<{
  mode: DiagnosticModeId | null;
}>;

export function parseDiagnosticArgs(argv: readonly string[]): DiagnosticCliOptions {
  const opts: { mode: DiagnosticModeId | null } = {
    mode: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new InputError(`flag ${arg} requires a value`, "input_error");
      i += 1;
      return v;
    };
    switch (arg) {
      case "--mode": {
        const v = next();
        if (!DIAGNOSTIC_MODE_IDS.includes(v as DiagnosticModeId)) {
          throw new InputError(
            `--mode must be one of ${DIAGNOSTIC_MODE_IDS.join(", ")}, got '${v}'`,
            "input_error",
          );
        }
        opts.mode = v as DiagnosticModeId;
        break;
      }
      default: throw new InputError(`unknown diagnostic flag: ${arg}`, "input_error");
    }
  }
  return deepFreeze(opts);
}

/** What `harness diagnostic` reports: each mode's snapshot, beside the modes this host supports. */
export type DiagnosticCliReport = Readonly<{ schemaVersion: string; supportedModes: readonly DiagnosticModeId[]; results: readonly DiagnosticRunResult[] }>;

/** Runs the asked mode (every enabled one by default); its answer passes iff no mode timed out (a run that throws is a typed refusal, `diagnostic_run_failed`). */
export function runDiagnosticCli(argv: readonly string[]): CommandAnswer<DiagnosticCliReport> {
  const opts = parseDiagnosticArgs(argv);
  const config = configuredPerformanceConfig();
  const runner = createDiagnosticRunner({ config });

  let results: readonly DiagnosticRunResult[];
  try {
    if (opts.mode === null) {
      results = runner.runAll();
    } else {
      results = deepFreeze([runner.run(opts.mode)]);
    }
  } catch (error) {
    throw new HarnessError(`diagnostic run failed: ${extractErrorMessage(error)}`, "diagnostic_run_failed");
  }

  const report: DiagnosticCliReport = deepFreeze({
    schemaVersion: schemaId("diagnostic-cli", 1),
    supportedModes: runner.supportedModes(),
    results: deepFreeze(results),
  });
  return deepFreeze({
    result: wrapResult("diagnostic", report, { status: results.every((r) => !r.timedOut) ? "pass" : "fail" }),
    text: () => `${formatDiagnosticReport(results)}\n`,
  });
}

function formatDiagnosticReport(results: readonly DiagnosticRunResult[]): string {
  const lines: string[] = [];
  lines.push("=== Harness Diagnostic Snapshot ===");
  for (const result of results) {
    lines.push(`  ${result.mode}:`);
    lines.push(`    runId=${result.runId} duration=${result.durationMs.toFixed(3)}ms timedOut=${result.timedOut}`);
    lines.push(`    ${JSON.stringify(result.snapshot).slice(0, 200)}`);
  }
  lines.push("===================================");
  return lines.join("\n");
}
