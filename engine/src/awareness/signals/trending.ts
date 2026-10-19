/**
 * Trending signal: most recently changed files + most recently changed
 * modules.
 *
 * Computed from git history if available (last `gitHistoryDepth`
 * commits → changed files → top recent files). If git is unavailable,
 * falls back to file mtime (the engine fills `latestMtimeMs` on each
 * module).
 *
 * The "trending modules" are the modules with the highest recent-commit
 * count (most commits in the recent window). The "recent files" are
 * the individual files most recently touched.
 */
import type { SignalContext, ModuleRecord } from "../types.ts";

export function computeTrending(ctx: SignalContext) {
  if (ctx.config.useGitHistory && ctx.gitHistory.length > 0) {
    const recent = ctx.gitHistory.slice(0, ctx.config.thresholds.gitHistoryDepth);
    const fileCount = new Map<string, number>(); // filePath → commit count
    for (const c of recent) {
      for (const f of c.changedFiles) {
        fileCount.set(f, (fileCount.get(f) ?? 0) + 1);
      }
    }
    const sortedFiles = [...fileCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const topRecentFiles = sortedFiles.slice(0, ctx.config.topN.topRecentFiles).map(([filePath, count]) => ({ filePath, ageDays: 0, commitCount: count }));
    // Trending modules: count commits per module.
    const moduleCounts = new Map<string, number>();
    const moduleLookup = buildModuleLookup(ctx.modules);
    for (const c of recent) {
      for (const f of c.changedFiles) {
        const m = moduleLookup(f);
        if (m) moduleCounts.set(m.path, (moduleCounts.get(m.path) ?? 0) + 1);
      }
    }
    const topTrendingModules = [...moduleCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, ctx.config.topN.topTrendingModules)
      .map(([path, count]) => {
        const m = ctx.modules.find(mm => mm.path === path)!;
        return { ...m, recentCommits: count };
      });
    return {
      trending: {
        topRecentFiles: topRecentFiles as readonly Readonly<{ filePath: string; ageDays: number; commitCount: number }>[],
        topTrendingModules: topTrendingModules as readonly ModuleRecord[],
      },
    };
  }
  // No git history — fall back to mtime.
  const sortedByMtime = [...ctx.modules].sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
  const topTrendingModules = sortedByMtime.slice(0, ctx.config.topN.topTrendingModules);
  // For recent files, walk file analyses and find the latest mtime — but we
  // don't have per-file mtime here (the engine fills modules). So we use
  // the modules' latest files. For simplicity, return the top-trending
  // modules and an empty recent-files list (callers can use git history).
  return {
    trending: {
      topRecentFiles: [] as readonly Readonly<{ filePath: string; ageDays: number }>[],
      topTrendingModules: topTrendingModules as readonly ModuleRecord[],
    },
  };
}

function buildModuleLookup(modules: readonly ModuleRecord[]): (filePath: string) => ModuleRecord | null {
  return (filePath: string): ModuleRecord | null => {
    let best: ModuleRecord | null = null;
    for (const m of modules) {
      if (filePath === m.path || filePath.startsWith(m.path + "/")) {
        if (best === null || m.path.length > best.path.length) best = m;
      }
    }
    return best;
  };
}
