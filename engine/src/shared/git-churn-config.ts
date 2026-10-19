/**
 * Canonical configuration owner for the shared git-churn helper.
 *
 * ONE source of truth for the git-churn tunables (default history depth and
 * per-commit timeout). Previously these lived as scattered `const
 * GIT_CHURN_DEFAULT_DEPTH = 100` / `GIT_CHURN_DEFAULT_TIMEOUT_MS = 10_000`
 * literals in `src/shared/git-churn.ts` — a violation (configurable
 * values outside the config owner). This file is the canonical owner; the
 * helper reads its defaults from here so the values are validated, named,
 * documented, and overridable from one place.
 *
 * Design rules honored:
 * no static configurables outside a `*-config.ts` canonical owner
 *;
 * one canonical owner per concept (this file owns the git-churn tunables);
 * bounds validated at the trust boundary (the resolver throws a typed
 * `InputError` on invalid bounds — never a silent fallback).
 */

import { InputError } from "../kernel/errors.ts";

/**
 * Tunables for `computeGitChurn`.
 *
 * `defaultDepth`: number of recent commits to scan (the `--no-merges`
 * walk). Larger = more history, slower; smaller = faster, less signal.
 * `defaultTimeoutMs`: per-`git log` subprocess timeout. Bounds the
 * walk so a wedged git never stalls the harness.
 */
export type GitChurnConfig = Readonly<{
  defaultDepth: number;
  defaultTimeoutMs: number;
}>;

/** The single canonical default config. Module-private — external
 * consumers use {@link resolveGitChurnConfig} (the validated accessor).
 * Mirrors the `intelligence-config.ts` pattern: defaults are not exported
 * so the dead-export scanner does not flag them. */
const DEFAULT_GIT_CHURN_CONFIG: GitChurnConfig = Object.freeze({
  defaultDepth: 100,
  defaultTimeoutMs: 10_000,
});

function isFinitePositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

/**
 * Resolve a git-churn config from a partial override, validating every
 * field at the trust boundary. Invalid bounds throw a typed `InputError`
 * (`git_churn_config_invalid`) — never a silent fallback that would
 * silently break the walk (the "wired but inert" class).
 */
export function resolveGitChurnConfig(
  override: Partial<GitChurnConfig> = {},
): GitChurnConfig {
  const defaultDepth = override.defaultDepth ?? DEFAULT_GIT_CHURN_CONFIG.defaultDepth;
  const defaultTimeoutMs = override.defaultTimeoutMs ?? DEFAULT_GIT_CHURN_CONFIG.defaultTimeoutMs;
  if (!isFinitePositiveInt(defaultDepth)) {
    throw new InputError(
      `gitChurn.defaultDepth must be a positive finite integer (got ${String(defaultDepth)})`,
      "git_churn_config_invalid",
    );
  }
  if (!isFinitePositiveInt(defaultTimeoutMs)) {
    throw new InputError(
      `gitChurn.defaultTimeoutMs must be a positive finite integer (got ${String(defaultTimeoutMs)})`,
      "git_churn_config_invalid",
    );
  }
  return Object.freeze({ defaultDepth, defaultTimeoutMs });
}
