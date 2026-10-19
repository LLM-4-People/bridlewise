/**
 * Quality signal: issue density (issues per KLOC) and top categories.
 *
 * Aggregates the health-signal issues, complexity hotspots, circular
 * dependencies, and dead exports into a single "issue density" — the
 * number of issues per 1000 lines of code. This is the "quality
 * indication" the user requested.
 *
 * This signal depends on the health + complexity + dependencies signals;
 * the engine passes them in via `ctx` (already-computed signals are
 * available as `ctx.priorSignals`).
 */
import type { SignalContext, AwarenessSnapshot } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

type Prior = Pick<AwarenessSnapshot, "health" | "complexity" | "dependencies" | "fileCount" | "totalLoc">;

export function computeQuality(_ctx: SignalContext, prior: Prior) {
  const totalLoc = prior.totalLoc;
  if (totalLoc === 0) {
    return { quality: { issueDensity: 0, issuesPerKloc: 0, totalIssues: 0, topCategories: [] } };
  }
  const categories: Array<{ category: string; count: number }> = [];
  const h = prior.health;
  if (h) {
    categories.push({ category: "todo", count: h.todoCount });
    categories.push({ category: "emptyCatch", count: h.emptyCatchCount });
    categories.push({ category: "magicNumber", count: h.magicNumberCount });
    categories.push({ category: "deadExport", count: h.deadExportCount });
  }
  const c = prior.complexity;
  if (c) categories.push({ category: "complexityHotspot", count: c.hotspotCount });
  const d = prior.dependencies;
  if (d) categories.push({ category: "circularDep", count: d.circularCount });
  const totalIssues = categories.reduce((a, b) => a + b.count, 0);
  const issuesPerKloc = totalIssues / (totalLoc / 1000);
  const sorted = [...categories].filter(c => c.count > 0).sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, 5);
  return {
    quality: {
      issueDensity: round(issuesPerKloc / 10, 3), // issues per 100 LOC
      issuesPerKloc: round(issuesPerKloc, 3),
      totalIssues,
      topCategories: top as readonly Readonly<{ category: string; count: number }>[],
    },
  };
}
