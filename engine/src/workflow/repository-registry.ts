/**
 * THE REPOSITORY REGISTRY — the one home of the state every checkout of a
 * repository must share: `<git common dir>/<product name>/`. A linked
 * worktree, a workspace, a candidate made with `git worktree` and the
 * canonical checkout all resolve the same common directory, so they read the
 * same records and take the same locks.
 *
 * Its areas, one owner each:
 *
 * - `workspaces/` — the workspace records (`workspace-registry.ts`);
 * - `locks/` — the repository-wide locks (the workspace admission and merge
 *   locks; a promotion's lock per target ref);
 * - `timeline/` — the workspace timeline shards and the integrator's ledger;
 * - `promotion/` — a promotion profile's private scratch (the lockfile
 *   derivation) and its cache (`promotion/projection.ts`).
 *
 * The common directory is asked of git through the pinned worktree port
 * (`configuredWorktreeGitPort`, `src/git/worktree-port.ts`), never
 * re-derived: one derivation for every consumer (a5-design M6). This module
 * itself runs no process: a reader of the registry (a signal) loads paths and
 * nothing else.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { deepFreeze, sha256 } from "../kernel/integrity.ts";
import { PRODUCT_NAME } from "../kernel/product-identity.ts";
import type { WorktreeGitPort } from "../git/worktree-port.ts";

/** Where a repository's shared state lives. */
export type RepositoryRegistry = Readonly<{
  /** The git common directory (absolute). */
  commonDir: string;
  /** The directory holding the repository (the common dir's parent for a `.git` dir): `workspaceIsolation.workspaceRoot` is relative to it. */
  home: string;
  /** `<common dir>/<product name>`. */
  root: string;
}>;

/** The registry's areas (see the header), each a directory under its root. */
export const REPOSITORY_REGISTRY_AREAS = deepFreeze({
  workspaces: "workspaces",
  locks: "locks",
  timeline: "timeline",
  promotion: "promotion",
} as const);

export type RepositoryRegistryArea = keyof typeof REPOSITORY_REGISTRY_AREAS;

/** The registry of the repository whose git common directory is `commonDir` (absolute). */
export function repositoryRegistry(commonDir: string): RepositoryRegistry {
  return deepFreeze({
    commonDir,
    home: basename(commonDir) === ".git" ? dirname(commonDir) : commonDir,
    root: join(commonDir, PRODUCT_NAME),
  });
}

/** The registry of the repository holding `cwd` (any directory inside any of its checkouts), asked of git. */
export function resolveRepositoryRegistry(git: Pick<WorktreeGitPort, "commonDir">, cwd: string, timeoutMs: number): RepositoryRegistry {
  return repositoryRegistry(git.commonDir(cwd, timeoutMs));
}

/**
 * A short, stable name of the repository (its common directory's real path,
 * digested to `length` hex characters): what a folder shared by several
 * repositories (a workspace root two clones point at) is scoped by, so their
 * promotion candidates and promoter homes never collide.
 */
export function repositoryId(registry: RepositoryRegistry, length: number): string {
  return sha256(existsSync(registry.commonDir) ? realpathSync(registry.commonDir) : registry.commonDir).slice(0, length);
}

/** One area's directory (not created here: its owner creates it, private, on first write). */
export function repositoryRegistryArea(registry: RepositoryRegistry, area: RepositoryRegistryArea): string {
  return join(registry.root, REPOSITORY_REGISTRY_AREAS[area]);
}

/**
 * The folder the repository's worktrees live in (`workspaceIsolation.workspaceRoot`:
 * absolute, or relative to the repository home): a workspace, a promotion's
 * candidate and its promoter home.
 */
export function workspaceRootOf(registry: RepositoryRegistry, configured: string): string {
  return isAbsolute(configured) ? configured : resolve(registry.home, configured);
}
