/**
 * Experiment source-directory exclusion — the single source of truth.
 *
 * Experiment code (`src/exp420/`, `src/auto-learning/`, `src/llm-beyond-max/`,
 * `src/unified/`, …) is merged into the tree for active experimentation but is
 * NOT confirmed production code. Only "confirmed" codebase code is scanned by
 * the architecture manifest, the test inventory, and the prevention tests.
 *
 * The exclusion patterns live in `ROOT_POLICY.configuration
 *.experimentSourceExclusions` (one canonical owner) and are matched against
 * the FIRST path segment under a scan root (`src/` or `test/`). Matching the
 * first segment — not a bare directory name — is what distinguishes
 * `src/unified/` (experiment) from `src/memory/unified/` (production): after
 * stripping the `src/` root the first segments are `unified` vs `memory`.
 *
 * Opt-in: setting the `HARNESS_INCLUDE_EXPERIMENTS` environment variable to
 * `1` or `true` re-includes experiment code in every scanner. The harness CLI
 * `--include-experiments` flag sets that variable so in-process scans and
 * subprocess scans (test inventory) both honour it through this one check.
 *
 * Glob semantics: `*` matches within a single path segment (it does not cross
 * `/`), consistent with standard glob/minimatch behaviour. Patterns are
 * applied to a single segment, so `exp*` matches `exp420` but never `memory`.
 */

import { ROOT_POLICY } from "../kernel/root-policy.ts";

/** The env-var opt-in. Truthy values: `1` or `true` (case-insensitive). */
export const EXPERIMENT_INCLUDE_ENV_VAR = "HARNESS_INCLUDE_EXPERIMENTS";

/**
 * Scan roots under which experiment subdirectories may live. A path is an
 * experiment path only when its segment directly below one of these roots
 * matches an exclusion pattern. `src/` covers source; `test/` covers tests;
 * `_experiments/` covers the relocated experiment source tree (exp477 moved
 * the experiment source dirs out of `src/` into `_experiments/`). The whole
 * `_experiments/` tree is also skipped by `repositoryScanExclusions` in
 * `root-policy.ts` (defense-in-depth); this root makes the opt-in
 * (`HARNESS_INCLUDE_EXPERIMENTS`) re-include `_experiments/` for any scanner
 * that uses `shouldExcludeExperiment` directly.
 */
export const EXPERIMENT_SCAN_ROOTS = ["src/", "test/", "scripts/", "_experiments/"] as const;

/**
 * @returns the configured experiment-source exclusion patterns (glob-style,
 * matched against a single top-level segment under a scan root).
 */
export function experimentSourcePatterns(): readonly string[] {
  return ROOT_POLICY.configuration.experimentSourceExclusions;
}

/**
 * @returns `true` when experiment code is opted back into scanning via the
 * `HARNESS_INCLUDE_EXPERIMENTS` environment variable.
 */
export function experimentsIncluded(): boolean {
  const raw = process.env[EXPERIMENT_INCLUDE_ENV_VAR];
  if (raw === undefined) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Match a single path segment against a glob pattern. `*` matches any run of
 * characters within the segment (never `/`, but the input is already a single
 * segment so it contains no `/`). All other regex metacharacters are escaped.
 */
export function matchSegment(name: string, pattern: string): boolean {
  if (pattern.length === 0) return name.length === 0;
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*"; // `*` matches within a segment, never crosses `/` (standard glob).
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re, "u").test(name);
}

/**
 * Test whether a repository-relative path is inside an experiment
 * subdirectory under any scan root. Only the segment directly below a scan
 * root is matched, so nested production dirs (e.g. `src/memory/unified/`) are
 * never treated as experiments.
 *
 * @param relativePath repository-relative path with forward slashes
 * (e.g. `src/exp420/index.ts`).
 * @param scanRoots roots to check against (defaults to `EXPERIMENT_SCAN_ROOTS`).
 */
export function isExperimentPath(
  relativePath: string,
  scanRoots: readonly string[] = EXPERIMENT_SCAN_ROOTS,
): boolean {
  return matchedExperimentSegment(relativePath, scanRoots) !== undefined;
}

/**
 * The single walk behind `isExperimentPath`. It returns WHICH segment matched
 * rather than only whether one did, so a caller that must explain the
 * exclusion (`repositoryScanExclusionFor`) and a caller that only needs the
 * yes/no answer share one implementation instead of two that can disagree.
 *
 * @returns the matching segment directly below a scan root, or `undefined`.
 */
function matchedExperimentSegment(
  relativePath: string,
  scanRoots: readonly string[] = EXPERIMENT_SCAN_ROOTS,
): string | undefined {
  const patterns = experimentSourcePatterns();
  if (patterns.length === 0) return undefined;
  for (const root of scanRoots) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (!relativePath.startsWith(prefix)) continue;
    const rest = relativePath.slice(prefix.length);
    const slash = rest.indexOf("/");
    const segment = slash === -1 ? rest : rest.slice(0, slash);
    if (segment.length === 0) continue;
    for (const pattern of patterns) {
      if (matchSegment(segment, pattern)) return segment;
    }
  }
  return undefined;
}

/**
 * @returns `true` when the path should be EXCLUDED from scanning: it is an
 * experiment path AND experiments have not been opted back in.
 */
export function shouldExcludeExperiment(
  relativePath: string,
  scanRoots: readonly string[] = EXPERIMENT_SCAN_ROOTS,
): boolean {
  if (experimentsIncluded()) return false;
  return isExperimentPath(relativePath, scanRoots);
}

/**
 * Why the repository scan refuses a path — the SAME census the scanners use to
 * decide what they walk, exposed so that the census of what we IMPORT can be
 * judged against it.
 *
 * This exists because the two censuses were previously independent. The module
 * walk pruned excluded directories, and the module graph then filtered every
 * dependency down to the paths the walk had produced — so an import that
 * crossed into an excluded directory was not a violation, it was an edge that
 * disappeared. One lived in the tree unnoticed: a value re-export from a
 * production barrel into `_experiments/`, recorded in the manifest as a real
 * dependency while every guard whose universe came from these exclusions was
 * short by it. Deriving both answers here makes that shape a contradiction —
 * "we refuse to scan this, and we import it" — instead of a silence.
 *
 * Two owners, both canonical, neither restated:
 * - `repositoryScanExclusions` — directory NAMES pruned wherever they appear
 *   in a path (`.git`, `node_modules`, `_experiments`, `runs`, …). No opt-in
 *   exists for these; they are never walked.
 * - `experimentSourceExclusions`, via `shouldExcludeExperiment` — segment
 *   patterns under a scan root, which the `HARNESS_INCLUDE_EXPERIMENTS`
 *   opt-in re-includes. Honouring the opt-in is deliberate: when experiments
 *   are scanned they are legitimate import targets, so the exclusion and the
 *   permission move together rather than drifting apart.
 *
 * @param relativePath repository-relative path with forward slashes.
 * @returns the reason the scan excludes it, or `undefined` when it does not.
 */
export function repositoryScanExclusionFor(
  relativePath: string,
): Readonly<{ reason: "repository-scan" | "experiment"; segment: string }> | undefined {
  // Widened to `readonly string[]` deliberately: the policy declares these as
  // literal types, and an arbitrary path segment is not one of them until the
  // membership test says so. Narrowing the INPUT to the literal union instead
  // would make the check unable to receive the paths it exists to judge.
  const excludedNames: readonly string[] = ROOT_POLICY.configuration.repositoryScanExclusions;
  for (const segment of relativePath.split("/")) {
    if (segment.length === 0) continue;
    if (excludedNames.includes(segment)) return { reason: "repository-scan", segment };
  }
  if (!experimentsIncluded()) {
    const segment = matchedExperimentSegment(relativePath);
    if (segment !== undefined) return { reason: "experiment", segment };
  }
  return undefined;
}

/**
 * Hardlink rejection policy for the safe repository reader. Mirrors the
 * `HARNESS_INCLUDE_EXPERIMENTS` opt-in pattern: one canonical env var is the
 * single source of truth so in-process scans AND subprocess scans (the test
 * inventory runs as a subprocess and inherits `process.env`) honour it through
 * one check.
 *
 * The production floor lives in
 * `ROOT_POLICY.verification.safeRepositoryRead.rejectHardlinks` (default
 * `true`): a second path to the same inode can bypass write isolation and
 * TOCTOU rechecks, so hardlinked repository files are rejected under
 * self-protection. The operator opts out for dev mode by setting
 * `selfProtection.enabled: false`; the CLI (`applySafeReadPolicy` in
 * `src/cli.ts`) propagates that to this env var.
 *
 * Truthy values: `1` or `true` (enforce). Falsy values: `0` or `false`
 * (skip). When unset, the floor (`true`) applies.
 */
const HARDLINK_REJECT_ENV_VAR = "HARNESS_REJECT_HARDLINKS";

/**
 * @returns `true` when hardlinked repository files (nlink > 1) must be
 * rejected. Honours the `HARNESS_REJECT_HARDLINKS` env var; when
 * unset, returns the production floor.
 */
export function shouldRejectHardlinks(): boolean {
  const raw = process.env[HARDLINK_REJECT_ENV_VAR];
  if (raw !== undefined) {
    const lower = raw.toLowerCase();
    if (raw === "0" || lower === "false") return false;
    if (raw === "1" || lower === "true") return true;
  }
  return ROOT_POLICY.verification.safeRepositoryRead.rejectHardlinks;
}

/**
 * Env var controlling repository-tree symlink rejection. Same dev-mode bypass
 * pattern as `HARNESS_REJECT_HARDLINKS`: the operator opts out for dev mode
 * by setting `selfProtection.enabled: false`; the CLI propagates that to
 * this env var. Dev workspaces routinely use a `node_modules` symlink
 * (e.g. `node_modules ->../candidate/node_modules`) and may contain broken
 * workspace symlinks; rejecting them crashes the evidence/qualification
 * pipeline in dev. The production floor (self-protection on) keeps rejection
 * enabled.
 *
 * Truthy values: `1` or `true` (enforce). Falsy values: `0` or `false`
 * (skip — symlinks are skipped, not followed). When unset, the floor
 * (`true`) applies.
 */
const SYMLINK_REJECT_ENV_VAR = "HARNESS_REJECT_SYMLINKS";

/**
 * The env-var names for the safe-repository-reader hardlink/symlink rejection
 * policy. Exported so the dev-mode propagation helper
 * (`src/shared/dev-mode-env.ts`) and the CLI bootstrap share ONE owner of
 * these names (DRY — no duplicated string literals).
 */
export const SAFE_READ_REJECT_ENV_VARS = {
  hardlinks: HARDLINK_REJECT_ENV_VAR,
  symlinks: SYMLINK_REJECT_ENV_VAR,
} as const;

/**
 * Env var name for the dev-mode config-file mode bypass. The config file
 * mode check (`inspectConfigFile` in `config.ts`) requires mode 0600 as a
 * production security floor. Git normalizes tracked file modes to 0644 (it
 * tracks only the executable bit, not the group/other read bits), so a
 * config file under git control is 0644 after any commit/checkout — which
 * would fail the 0600 check on every test run in a dev workspace. In dev
 * mode (`selfProtection.enabled: false`), this env var is set to `"0"` so
 * the mode check is skipped, mirroring the hardlink/symlink dev-mode
 * bypass. The config file carries no secrets (the API key lives in the
 * env, not the config), so the 0644 mode in a dev workspace is acceptable.
 * Lives here (alongside the other dev-mode env-var names) so `config.ts`
 * can import it without a circular dependency on `dev-mode-env.ts` (which
 * imports `readConfigDocumentRaw` from `config.ts`).
 */
export const CONFIG_MODE_REQUIRE_ENV_VAR = "HARNESS_REQUIRE_CONFIG_MODE";

/**
 * @returns `true` when symbolic-link repository entries must be rejected.
 * Honours the `HARNESS_REJECT_SYMLINKS` env var; when unset, returns
 * the production floor.
 */
export function shouldRejectSymlinks(): boolean {
  const raw = process.env[SYMLINK_REJECT_ENV_VAR];
  if (raw !== undefined) {
    const lower = raw.toLowerCase();
    if (raw === "0" || lower === "false") return false;
    if (raw === "1" || lower === "true") return true;
  }
  return ROOT_POLICY.verification.safeRepositoryRead.rejectSymlinks;
}
