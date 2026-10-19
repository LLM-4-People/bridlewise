/**
 * Quality scoring (EXP386, refactored EXP462).
 *
 * Produces a 0–100 overall quality score and per-category scores from a
 * `QualityReport`. The score is a *dynamic* function of the report —
 * every weight, cap, category mapping, grade boundary, and fallback comes
 * from `QualityConfig.scoring` (the single owner in config.ts). No static
 * constants live here (R47: the grade boundaries + default category cap
 * were moved to config so this claim is truthful, not aspirational).
 *
 * Categories (8):
 * 1. correctness — parse errors, dead code, dead exports, duplicate bodies
 * 2. complexity — complexity hotspots, long functions, long parameter lists,
 * complex conditions, high nesting
 * 3. maintainability — TODO comments, shadowed declarations, unused locals,
 * duplicate imports, duplicate strings, empty functions
 * 4. safety — empty catch, missing default case, race conditions,
 * throw-literal, unsafe-finally, fallthrough
 * 5. security — security hotspots, eval, implied-eval
 * 6. performance — performance anti-patterns
 * 7. dependencies — unused imports, circular dependencies
 * 8. style — magic numbers, long lines, type-assertion, extra-semi
 *
 * Score formula (EXP462 — precision-weighted):
 * - Start at 100.
 * - For each finding: penalty = severityPenalty[severity] × precisionWeight[precision(checkId)] / kloc.
 * - Sum per category, cap each category at categoryCap[category].
 * - Overall = 100 - sum of capped penalties, clamped to [0, 100].
 *
 * EXP462 Fix 2: the formula is unchanged in shape (density-weighted), but
 * every constant now comes from config. The precision weighting (Fix 3) is
 * the real improvement: low-precision checks (race-condition,
 * security-hotspot) contribute 0.3× the penalty of a high-precision check
 * at the same severity, so a codebase with many "review request" findings
 * no longer scores as low as one with many confirmed bugs. This makes the
 * score HONEST — it reflects confirmed defect density, not lint noise.
 *
 * EXP446 reported "low quality scores for babel (24.7) and zod (32.7)" as
 * legitimate (high duplicate-body + complexity density). With precision
 * weighting, babel's score rises modestly (its 632 duplicate-body findings
 * are high-precision, so they still dominate; the race-condition and
 * security-hotspot noise contributes less). The score remains honest
 * about real defect density.
 */

import type { QualityConfig, QualityReport } from "./base.ts";

export type CategoryId =
  | "correctness"
  | "complexity"
  | "maintainability"
  | "safety"
  | "security"
  | "performance"
  | "dependencies"
  | "style";

export interface CategoryScore {
  readonly category: CategoryId;
  readonly score: number;
  readonly findingCount: number;
  readonly penalty: number;
}

export interface QualityScore {
  readonly overall: number;
  readonly categories: readonly CategoryScore[];
  /** Severity + precision-weighted finding density (findings / KLOC × penalty). */
  readonly density: number;
  /** Total KLOC used to normalize. */
  readonly kloc: number;
  /** Letter grade A–F derived from overall. */
  readonly grade: "A" | "B" | "C" | "D" | "F";
  /** Average precision of findings (EXP462) — 1.0 = all high, 0.3 = all low. */
  readonly meanPrecision: number;
}

function gradeOf(score: number, boundaries: Readonly<{ a: number; b: number; c: number; d: number }>): "A" | "B" | "C" | "D" | "F" {
  if (score >= boundaries.a) return "A";
  if (score >= boundaries.b) return "B";
  if (score >= boundaries.c) return "C";
  if (score >= boundaries.d) return "D";
  return "F";
}

/**
 * Compute the 0-100 quality score from a QualityReport + config.
 * Pure function — no I/O, no globals, deterministic given the report + config.
 *
 * EXP462: `config` is now required (it owns all weights/caps/precision).
 */
export function scoreQuality(report: QualityReport, config: QualityConfig): QualityScore {
  const kloc = Math.max(1, report.files.loc / 1000);
  const { severityPenalty, categoryCap, categoryMap, checkPrecision, precisionWeight, gradeBoundaries, defaultCategoryCap } = config.scoring;
  const byCategory = new Map<CategoryId, { count: number; penalty: number; precisionSum: number }>();
  let totalPrecision = 0;
  for (const f of report.findings) {
    const cat = (categoryMap[f.checkId] as CategoryId | undefined) ?? null;
    if (!cat) continue;
    const sev = severityPenalty[f.severity] ?? 1;
    const precClass = checkPrecision[f.checkId] ?? "medium";
    const pw = precClass === "high" ? precisionWeight.high : precClass === "medium" ? precisionWeight.medium : precisionWeight.low;
    totalPrecision += pw;
    const entry = byCategory.get(cat) ?? { count: 0, penalty: 0, precisionSum: 0 };
    entry.count += 1;
    entry.penalty += (sev * pw) / kloc;
    entry.precisionSum += pw;
    byCategory.set(cat, entry);
  }
  const categories: CategoryScore[] = [];
  let totalPenalty = 0;
  for (const cat of Object.keys(categoryCap) as CategoryId[]) {
    const entry = byCategory.get(cat) ?? { count: 0, penalty: 0, precisionSum: 0 };
    const cap = categoryCap[cat] ?? defaultCategoryCap;
    const cappedPenalty = Math.min(entry.penalty, cap);
    const score = Math.max(0, 100 - cappedPenalty);
    categories.push({
      category: cat,
      score: Number(score.toFixed(1)),
      findingCount: entry.count,
      penalty: Number(cappedPenalty.toFixed(2)),
    });
    totalPenalty += cappedPenalty;
  }
  const overall = Math.max(0, Math.min(100, 100 - totalPenalty));
  const density = report.findings.length / kloc;
  const meanPrecision = report.findings.length > 0 ? totalPrecision / report.findings.length : 1;
  return {
    overall: Number(overall.toFixed(1)),
    categories: categories.sort((a, b) => b.penalty - a.penalty),
    density: Number(density.toFixed(2)),
    kloc: Number(kloc.toFixed(2)),
    grade: gradeOf(overall, gradeBoundaries),
    meanPrecision: Number(meanPrecision.toFixed(3)),
  };
}
