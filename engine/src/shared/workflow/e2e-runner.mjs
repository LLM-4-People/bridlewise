// e2e-runner.mjs — Run the full test suite on the integration/ folder.
//
// THIS IS THE SINGLE CANONICAL OWNER of the workflow e2e runner. Every
// consumer imports from here — do NOT duplicate this runner.
//
// The declaration is on THIS file because this is the file the consumers
// reach: `scripts/harness-root/merge-round.mjs` imports `runE2e` from it and
// `merge-round.test.mjs` imports its collector. It used to live only on
// `docs/history/src-shared-workflow/e2e-runner.mjs`, an archived RECORD with
// zero consumers — the ownership marker on the unreachable copy, and nothing
// at all on the reachable one.
//
// Binding user directive (2026-07-21):
// "so the e2e agent can just run the whole thing for testing.
// including test units and all."
//
// EXP471 fix: the runner previously collected ONLY *.test.{mjs,js}. The
// integration/ tree is overwhelmingly *.test.ts (363 files, 0.mjs), so the
// e2e gate was a silent no-op. Now *.test.ts (and *.test.mts/*.test.cts) are
// collected and run with `node --test --experimental-strip-types` (Node
// >=22.6 strips TS types natively; Node >=23.6 enables it by default). The
// flag is added only when.ts-family files are present so pure-.js trees are
// unaffected.
//
// The e2e runner:
// 1. Collects every test file (*.test.{mjs,js,ts,mts,cts}) in integration/.
// 2. Runs `node --test [--experimental-strip-types] <files>` on them.
// 3. Parses the TAP/pretty output for pass/fail counts.
// 4. Returns { passed, testCount, failCount, summary, files, failures }.

import { existsSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// Test extensions collected. The.ts-family (.ts/.mts/.cts) requires type
// stripping; the flag is added only when at least one such file is present.
const TEST_RE = /\.test\.(mjs|js|ts|mts|cts)$/;
const TS_TEST_RE = /\.test\.(ts|mts|cts)$/;

/**
 * Recursively collect test files (*.test.{mjs,js,ts,mts,cts}) under `dir`.
 * @param {string} dir
 * @returns {string[]}
 */
export function collectTestFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  function walk(d) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && TEST_RE.test(e.name)) out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

/**
 * Detect whether the running node supports --experimental-strip-types.
 * Node >=22.6.0 / >=23.6.0 recognize the flag. We probe by version parse; a
 * future node that removes the flag still accepts type-stripping by default.
 * @returns {boolean}
 */
export function supportsStripTypes() {
  const m = process.versions.node.match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (major > 23) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 6;
  return false;
}

/**
 * Run the e2e test on integration/.
 * @param {object} opts
 * @param {string} opts.integrationDir
 * @param {number} opts.timeoutMs REQUIRED: the suite's bound. The merge gate passes
 *   `DEFAULT_E2E_SUITE_TIMEOUT_MS` (engine/src/workflow/workflow-config.ts, the one owner);
 *   this argv-dispatching `.mjs` stays outside the harness module graph
 *   (test/prevention/entrypoint-recording-wiring.test.ts), so it holds no default of its own.
 * @param {boolean} [opts.stripTypes] override strip-types detection
 * @param {number} [opts.concurrency] override test-concurrency (default: 4, or 1 when only 1 file)
 * @returns {Promise<{passed: boolean, testCount: number, failCount: number, passCount: number, summary: string, files: string[], failures: string[]}>}
 */
export async function runE2e({ integrationDir, timeoutMs, stripTypes, concurrency } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    // An unbounded suite is never run: no bound given is a failed gate, said so.
    return {
      passed: false,
      testCount: 0,
      failCount: 0,
      passCount: 0,
      summary: `no suite bound: runE2e needs timeoutMs (a positive integer of milliseconds), got ${String(timeoutMs)}`,
      files: [],
      failures: [],
    };
  }
  const files = collectTestFiles(integrationDir);
  if (files.length === 0) {
    return {
      passed: false,
      testCount: 0,
      failCount: 0,
      passCount: 0,
      summary: "no test files found in integration/",
      files: [],
      failures: [],
    };
  }

  const hasTs = files.some((f) => TS_TEST_RE.test(f));
  const useStrip = stripTypes !== undefined ? stripTypes : (hasTs && supportsStripTypes());
  // Use test concurrency for parallel execution. The full suite has 8000+
  // tests across 360+ files; serial execution takes ~14 min while concurrency=4
  // cuts it significantly. Default to 4 (or 1 when only a single file — no
  // benefit from concurrency overhead for one file).
  const useConcurrency = concurrency !== undefined ? concurrency : (files.length > 1 ? 4 : 1);

  let stdout = "";
  let exitCode = 0;
  let timedOut = false;
  // Strip test-runner env vars so the child `node --test` uses the default
  // (pretty) output format, not the TAP format inherited from a parent
  // `node --test` process (NODE_TEST_CONTEXT=child-v8 changes the format).
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_IN_TEST_CONTEXT;
  const stripFlag = useStrip ? "--experimental-strip-types --no-warnings=ExperimentalWarning" : "";
  const concurrencyFlag = useConcurrency > 1 ? `--test-concurrency=${useConcurrency}` : "";
  const cmd = `node --test ${stripFlag} ${concurrencyFlag} ${files.map((f) => `"${f}"`).join(" ")}`;
  try {
    stdout = execSync(cmd, {
      cwd: integrationDir,
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      env: childEnv,
    });
  } catch (e) {
    stdout = (e.stdout || "") + (e.stderr || "");
    exitCode = e.status ?? 1;
    if (e.killed) timedOut = true;
  }

  const testCount = countMatches(stdout, /[ℹ#]\s+tests\s+\d+/);
  const passCount = countMatches(stdout, /[ℹ#]\s+pass\s+\d+/);
  const failCount = countMatches(stdout, /[ℹ#]\s+fail\s+\d+/);
  const skipCount = countMatches(stdout, /[ℹ#]\s+skip(?:ped)?\s+\d+/);

  const failures = extractFailures(stdout, integrationDir);
  const passed = !timedOut && failCount === 0 && exitCode === 0;

  return {
    passed,
    testCount: testCount || (failCount + passCount),
    passCount,
    failCount,
    skipCount,
    summary: timedOut
      ? `e2e timed out after ${timeoutMs}ms`
      : `${passCount} pass, ${failCount} fail, ${skipCount} skip (${files.length} files)`,
    files: files.map((f) => relative(integrationDir, f)),
    failures,
    timedOut,
    exitCode,
    stripTypes: useStrip,
    tsFiles: hasTs,
    concurrency: useConcurrency,
  };
}

function countMatches(text, re) {
  const m = text.match(re);
  if (!m) return 0;
  const n = parseInt(m[0].replace(/[^0-9]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

/** Extract individual failing tests from node --test output.
 * Returns an array of { file, name } where file is the test file path
 * (relative to integrationDir if possible) and name is the test name.
 *
 * The node --test pretty format is:
 * ✖ <test name> (Xms) <- inline (before summary, no file)
 * ℹ tests N
 * ℹ pass N
 * ℹ fail N
 *...
 * ✖ failing tests: <- START of the detailed section
 *
 * test at <abs-or-rel-path>:<line>:<col>
 * ✖ <test name> (Xms)
 * <error stack>
 *
 * We only collect failures from AFTER the "✖ failing tests:" marker so
 * each failure has a file path (set by the preceding "test at" line).
 * Failures before the marker (inline) are redundant with the summary.
 */
function extractFailures(text, integrationDir) {
  const out = [];
  const lines = text.split("\n");
  // Find the "✖ failing tests:" marker.
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/✖\s+failing tests:/.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }
  let currentFile = null;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const fileMatch = line.match(/^test at\s+(.+?):\d+:\d+/);
    if (fileMatch) {
      let f = fileMatch[1];
      if (integrationDir && !f.startsWith(".")) {
        try {
          const rel = relative(integrationDir, f);
          if (!rel.startsWith("..")) f = rel;
        } catch { /* keep original */ }
      }
      currentFile = f;
      continue;
    }
    const failMatch = line.match(/^\s*✖\s+(.+?)\s+\([\d.]+m?s\)/);
    if (failMatch) {
      out.push({ file: currentFile, name: failMatch[1].trim() });
    }
  }
  return out;
}

// CLI: `node e2e-runner.mjs --integration <dir> --timeout-ms <ms>`
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let integrationDir = resolve(HERE, "integration");
  let timeoutMs;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--integration" && args[i + 1]) integrationDir = resolve(args[++i]);
    else if (args[i] === "--timeout-ms" && args[i + 1]) timeoutMs = Number(args[++i]);
  }
  if (timeoutMs === undefined) {
    console.error("usage: node e2e-runner.mjs --integration <dir> --timeout-ms <ms>  (the merge gate's bound is DEFAULT_E2E_SUITE_TIMEOUT_MS in engine/src/workflow/workflow-config.ts)");
    process.exit(2);
  }
  runE2e({ integrationDir, timeoutMs }).then((r) => {
    console.log(JSON.stringify({
      passed: r.passed,
      testCount: r.testCount,
      passCount: r.passCount,
      failCount: r.failCount,
      skipCount: r.skipCount,
      summary: r.summary,
      files: r.files,
      failures: r.failures.slice(0, 20).map((f) => ({ file: f.file, name: f.name })),
      timedOut: r.timedOut,
      exitCode: r.exitCode,
      stripTypes: r.stripTypes,
      tsFiles: r.tsFiles,
    }, null, 2));
    process.exit(r.passed ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
