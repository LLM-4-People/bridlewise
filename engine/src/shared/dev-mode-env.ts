import { deepFreeze } from "../kernel/integrity.ts";
import { configDocumentPath, readConfigDocumentRawIfPresent } from "../kernel/config.ts";
import { resolveSelfProtectionConfig } from "../filesystem/self-protection/self-protection-config.ts";
import { SAFE_READ_REJECT_ENV_VARS, CONFIG_MODE_REQUIRE_ENV_VAR } from "./source-scan.ts";

/**
 * Dev-mode safe-read env-var propagation (EXP481).
 *
 * In a dev workspace (`selfProtection.enabled: false` in
 * `bridlewise.config.json`), the repository tree is seeded with hardlinks
 * (`cp -rl`, nlink=2) and a `node_modules` symlink. The safe repository reader
 * rejects both by default (production floor), which crashes every test that
 * walks the tree (foundation-cascade, evidence sessions, test-inventory,
 * candidate-format). The operator opt-out is the two env vars consumed by
 * `shouldRejectHardlinks` / `shouldRejectSymlinks`:
 *
 * - `HARNESS_REJECT_HARDLINKS=0` — skip hardlinked files instead of rejecting
 * - `HARNESS_REJECT_SYMLINKS=0` — skip symlinked entries instead of rejecting
 *
 * Previously the operator had to set these manually for EVERY test invocation.
 * This module is the single canonical helper that reads the config, detects
 * dev mode, and propagates the two env vars automatically — so the test runner
 * (`scripts/run-tests.ts`, `scripts/test-worker.ts`) and the CLI
 * (`src/cli.ts`) all derive the same policy from one owner.
 *
 * Existing explicit env-var values are preserved: the helper only sets a var
 * when it is `undefined`, so an operator who forces `=1` (production floor in
 * a dev workspace, e.g. for the symlink-rejection security tests) is never
 * overridden.
 */

export type DevModeEnvResult = Readonly<{
  devMode: boolean;
  hardlinks: string;
  symlinks: string;
  configMode: string;
}>;

/**
 * The config-file mode bypass env var lives in `source-scan.ts` (the shared
 * home for dev-mode env-var names) so `config.ts` can import it without a
 * circular dependency on this module. See the docstring there for the full
 * rationale.
 */
export { CONFIG_MODE_REQUIRE_ENV_VAR } from "./source-scan.ts";

/**
 * Read the `selfProtection.enabled` field from the on-disk config via the
 * single config-document reader (`readConfigDocumentRawIfPresent` in
 * `config.ts` — the SPO owner). Returns `true` only when dev mode was
 * written down (`enabled: false`); an absent section resolves to confined
 * (the one owner, `resolveSelfProtectionConfig`), and an ABSENT config is the
 * production floor (`false`). A config that exists but cannot be read or
 * decoded is REFUSED with the reader's typed code — never answered with a
 * guessed mode: the verified loader refuses the same document moments later,
 * and a bootstrap that guessed would decide the safe-read floor from nothing.
 */
export function isDevMode(root: string): boolean {
  const document = readConfigDocumentRawIfPresent(configDocumentPath(root));
  return document !== undefined && !resolveSelfProtectionConfig(document).enabled;
}

/**
 * Detect dev mode from the config and, when active, set the two safe-read
 * rejection env vars to `"0"` (skip instead of reject) unless they are
 * already explicitly set. Returns the resolved values for observability.
 *
 * This is the single canonical propagation point. The CLI bootstrap and the
 * test runner both call this so subprocesses (which inherit `process.env`)
 * observe a consistent policy without per-invocation manual env vars.
 */
export function applyDevModeSafeReadEnvVars(root: string): DevModeEnvResult {
  const devMode = isDevMode(root);
  if (devMode) {
    if (process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] === undefined) {
      process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = "0";
    }
    if (process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] === undefined) {
      process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = "0";
    }
    if (process.env[CONFIG_MODE_REQUIRE_ENV_VAR] === undefined) {
      process.env[CONFIG_MODE_REQUIRE_ENV_VAR] = "0";
    }
  }
  return deepFreeze({
    devMode,
    hardlinks: process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] ?? "",
    symlinks: process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] ?? "",
    configMode: process.env[CONFIG_MODE_REQUIRE_ENV_VAR] ?? "",
  });
}
