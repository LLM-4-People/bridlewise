/**
 * ONE OWNER for "is the Vite dep-optimizer cache older than the source the
 * dev server serves" — and the refusal that clears it.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
 *
 * After editing `server/` or `engine/src/`, the running dev server served a
 * STALE dependency graph: rooms failed to load with
 * `Cannot read properties of undefined (reading 'call')` and the browser
 * showed `504 Outdated Optimize Dep`. Restarting through `scripts/sd.mjs`
 * did NOT clear it — the remedy was a hand-run `mv node_modules/.vite*`
 * aside, which is exactly the step a future edit loop will forget.
 *
 * The mechanism: Vite's dep-optimizer reuses `node_modules/.vite` when its
 * own inputs (config hash, lockfile hash) are unchanged. It does NOT key on
 * the SOURCE the dev server transforms — and this monorepo's pages import
 * `engine/` and `server/` modules that live outside the scanned entries, so
 * an edit there moves no hash the optimizer reads. The cache outlives the
 * tree it was built from.
 *
 * ── THE SIGNAL, AND WHY IT IS THE CHEAPEST HONEST ONE ────────────────────
 *
 * "The source the dev server serves is newer than the cache" is approximated
 * by "the newest mtime among the served roots is newer than the cache's own
 * stamp". The cache's stamp is the newest mtime inside `node_modules/.vite`
 * itself (the optimizer rewrites its marker on every re-bundle, so the cache
 * directory's own clock is the cache's age). The served roots are the trees
 * the dev server can be asked for: `src/`, `server/`, `shared/`,
 * `engine/src/`, plus the root config files that change the module graph
 * (`vite.config.ts`, `svelte.config.ts`, the `tsconfig*` chain).
 *
 * This is deliberately an mtime comparison, not a content hash: the dev loop
 * edits a file and restarts in seconds, and a content hash of four trees is
 * the cost this check exists to AVOID paying on every boot. The known blind
 * side runs the safe way: a file whose mtime moved without changing the
 * graph (a `touch`, a mode flip) over-clears — one cold re-bundle, seconds —
 * where the opposite error serves a stale graph and costs a diagnosis cycle.
 *
 * Everything below is split pure (the walk, the stamp read, the verdict,
 * fixture-driven in `tests/prevention/vite-dep-cache-staleness.test.ts`) from
 * live (the filesystem reads against the real tree), so the deciding logic is
 * tested without a machine — the same shape `dev-server-freshness.ts` uses.
 *
 * DEPENDENCY-FREE ON PURPOSE: node built-ins only, like its neighbours.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The roots the dev server can be asked to serve a module from. */
export const SERVED_ROOTS: readonly string[] = ["src", "server", "shared", "engine/src"];

/**
 * The root-level files whose edit changes the module graph the optimizer
 * pre-bundles against. A config edit can add or remove a dependency the
 * scanner sees, so these vote alongside the served trees.
 */
export const GRAPH_CONFIG_FILES: readonly string[] = [
  "vite.config.ts",
  "svelte.config.ts",
  "tsconfig.json",
  "tsconfig.server.json",
  "tsconfig.templates.json",
  "tsconfig.tests.json",
];

/** The dep-optimizer's directory, relative to the repository root. */
export const DEP_CACHE_DIR = "node_modules/.vite";

/**
 * Directory names the source walk never descends into. A served tree's
 * `node_modules`/`.git`/`dist` is not source the dev server wrote, and
 * following the `engine/large-codebases` SYMLINK would walk a 4.1 GB
 * vendored corpus — so the walk stats real directories only and never
 * follows links. A new generated-or-vendored directory that appears under a
 * served root belongs here the day it appears, not after it is walked.
 */
const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "large-codebases",
]);

/**
 * The newest mtime among the files under `roots` (relative to `root`),
 * recursively, or `null` when nothing along the way reads — absence,
 * reported by the caller as NOT JUDGED, never a guess. Directories in
 * `WALK_SKIP_DIRS` are not descended into and symlinks are not followed, so
 * a vendored corpus or a generated `dist/` under a served root cannot move
 * the stamp.
 */
export function newestSourceMtimeMs(root: string, roots: readonly string[]): number | null {
  let newest: number | null = null;
  const note = (mtimeMs: number): void => {
    if (newest === null || mtimeMs > newest) newest = mtimeMs;
  };
  const walkDir = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // A symlink is never followed: `engine/large-codebases` is a symlink to
      // a 4.1 GB corpus, and a linked directory is not this tree's source.
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name)) walkDir(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        note(statSync(path).mtimeMs);
      } catch {
        // The file vanished mid-walk; it simply does not vote.
      }
    }
  };
  for (const rel of roots) walkDir(join(root, rel));
  return newest;
}

/**
 * The newest mtime among the root-level files an edit to which changes the
 * module graph (`vite.config.ts` & co.), or `null` when none read.
 */
export function graphConfigMtimeMs(root: string, files: readonly string[]): number | null {
  let newest: number | null = null;
  for (const rel of files) {
    try {
      const mtimeMs = statSync(join(root, rel)).mtimeMs;
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch {
      // A config file that does not exist does not vote.
    }
  }
  return newest;
}

/**
 * The cache's own age stamp: the newest mtime of anything inside
 * `node_modules/.vite`, or `null` when the cache is absent or unreadable.
 * The optimizer rewrites its marker files on every re-bundle, so the newest
 * entry's mtime is the moment the cache was last built. An ABSENT cache is
 * not stale — it is empty, and the verdict treats it as a fresh build.
 */
export function depCacheStampMs(root: string, cacheDir: string = DEP_CACHE_DIR): number | null {
  const base = join(root, cacheDir);
  let newest: number | null = null;
  const walkDir = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      try {
        const mtimeMs = statSync(path).mtimeMs;
        if (newest === null || mtimeMs > newest) newest = mtimeMs;
      } catch {
        continue;
      }
      if (entry.isDirectory()) walkDir(path);
    }
  };
  walkDir(base);
  return newest;
}

/**
 * THE VERDICT, pure over its inputs. Returns the refusal line when the cache
 * is older than the source, `null` when it is fresh (or absent — an absent
 * cache is rebuilt, not cleared). The `sourceNewestMs` is the max of the
 * served-tree and graph-config stamps; the caller computes both and passes
 * the winner so this function stays a pure comparison.
 */
export function depCacheStalenessVerdict(
  sourceNewestMs: number | null,
  cacheStampMs: number | null,
): string | null {
  if (sourceNewestMs === null) return null; // nothing readable to judge by
  if (cacheStampMs === null) return null; // no cache — the next boot builds one
  if (sourceNewestMs <= cacheStampMs) return null; // cache at or newer than source
  return (
    `the Vite dep-optimizer cache (${DEP_CACHE_DIR}) predates the source the dev server serves ` +
    `(source newest ${new Date(sourceNewestMs).toISOString()}, cache built ` +
    `${new Date(cacheStampMs).toISOString()}). A stale cache serves the module graph of the ` +
    `tree it was built in — after an edit under server/ or engine/src/, one answered room ` +
    `loads with "Cannot read properties of undefined (reading 'call')" and 504 Outdated ` +
    `Optimize Dep. Clearing it so the next boot re-bundles against the current tree.`
  );
}

/**
 * The one call the lifecycle script makes: judge the real tree, and return
 * the refusal when the cache is stale (the caller clears + reports). `null`
 * means fresh, absent, or unreadable — never a guess in the permissive
 * direction that matters (a stale cache kept), and the over-clear direction
 * costs seconds, not a cycle.
 */
export function staleDepCacheVerdict(repositoryRoot: string): string | null {
  const source = newestSourceMtimeMs(repositoryRoot, SERVED_ROOTS);
  const config = graphConfigMtimeMs(repositoryRoot, GRAPH_CONFIG_FILES);
  const sourceNewestMs =
    source === null ? config : config === null ? source : Math.max(source, config);
  return depCacheStalenessVerdict(sourceNewestMs, depCacheStampMs(repositoryRoot));
}
