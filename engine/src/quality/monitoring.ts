/**
 * Real-time quality monitoring (EXP386).
 *
 * After each edit, re-run the analysis and report the *delta* vs. the
 * previous report. The delta is a structured object showing:
 * - score change (overall + per category)
 * - new findings introduced by the edit
 * - findings resolved by the edit
 * - severity-weighted impact
 *
 * The caller is responsible for re-running the analysis; this module just
 * compares two reports + scores. It does NOT perform I/O — it's a pure
 * function of (before, after).
 *
 * Use case: an interactive editor applies a small edit (e.g. adds a
 * function) and wants to know "did this edit improve or degrade quality?"
 * The editor calls `runAnalysis` on the new content, then `monitorDelta`
 * to see the impact.
 */

import type { Finding, QualityConfig, QualityReport } from "./base.ts";
import { scoreQuality, type QualityScore } from "./scoring.ts";

export interface FindingDelta {
  /** New findings in `after` that were not in `before`. */
  readonly added: readonly Finding[];
  /** Findings in `before` that are gone in `after`. */
  readonly removed: readonly Finding[];
  /** Findings present in both reports (unchanged). */
  readonly unchangedCount: number;
}

export interface CategoryDelta {
  readonly category: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
}

export interface QualityDelta {
  readonly overallBefore: number;
  readonly overallAfter: number;
  readonly overallDelta: number;
  readonly gradeBefore: string;
  readonly gradeAfter: string;
  readonly categories: readonly CategoryDelta[];
  readonly findings: FindingDelta;
  /** Severity-weighted impact: positive = net improvement, negative = net regression. */
  readonly impact: number;
  /** One-line human-readable summary. */
  readonly summary: string;
}

function findingKey(f: Finding): string {
  return `${f.checkId}|${f.filePath}|${f.line}|${f.column}|${f.symbol ?? ""}`;
}

/** Compare two reports + scores and emit a structured delta.
 * EXP462: `config` is required for precision-weighted scoring. */
export function monitorDelta(
  before: QualityReport,
  after: QualityReport,
  config: QualityConfig,
  beforeScore?: QualityScore,
  afterScore?: QualityScore,
): QualityDelta {
  const bs = beforeScore ?? scoreQuality(before, config);
  const as_ = afterScore ?? scoreQuality(after, config);

  // Build set-based diff of findings.
  const beforeKeys = new Map<string, Finding>();
  for (const f of before.findings) beforeKeys.set(findingKey(f), f);
  const afterKeys = new Map<string, Finding>();
  for (const f of after.findings) afterKeys.set(findingKey(f), f);
  const added: Finding[] = [];
  const removed: Finding[] = [];
  let unchangedCount = 0;
  for (const [k, f] of afterKeys) {
    if (beforeKeys.has(k)) unchangedCount += 1;
    else added.push(f);
  }
  for (const [k, f] of beforeKeys) {
    if (!afterKeys.has(k)) removed.push(f);
  }

  // Per-category delta.
  const categoryMap = new Map<string, { before: number; after: number }>();
  for (const c of bs.categories) categoryMap.set(c.category, { before: c.score, after: c.score });
  for (const c of as_.categories) {
    const entry = categoryMap.get(c.category);
    if (entry) entry.after = c.score;
    else categoryMap.set(c.category, { before: 100, after: c.score });
  }
  const categories: CategoryDelta[] = [];
  for (const [cat, { before: b, after: a }] of categoryMap) {
    categories.push({
      category: cat,
      before: b,
      after: a,
      delta: Number((a - b).toFixed(1)),
    });
  }
  categories.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  // Severity-weighted impact: each removed finding contributes +weight, each
  // added contributes -weight. R47: read the weights from the single config
  // owner (`config.scoring.severityPenalty`) instead of a local duplicate of
  // `DEFAULT_SEVERITY_PENALTY` (No Scattered Helpers / drift risk).
  const severityPenalty = config.scoring.severityPenalty;
  let impact = 0;
  for (const f of removed) impact += severityPenalty[f.severity] ?? 1;
  for (const f of added) impact -= severityPenalty[f.severity] ?? 1;
  impact = Number(impact.toFixed(2));

  const overallDelta = Number((as_.overall - bs.overall).toFixed(1));
  const arrow = overallDelta > 0 ? "+" : "";
  const summary = `Overall: ${bs.overall} → ${as_.overall} (${arrow}${overallDelta}, grade ${bs.grade}→${as_.grade}); ${added.length} added, ${removed.length} removed findings; impact ${impact > 0 ? "+" : ""}${impact}`;

  return {
    overallBefore: bs.overall,
    overallAfter: as_.overall,
    overallDelta,
    gradeBefore: bs.grade,
    gradeAfter: as_.grade,
    categories,
    findings: { added, removed, unchangedCount },
    impact,
    summary,
  };
}

/** Convenience: re-run analysis on a single edited file and report the delta.
 * This is the typical "after each edit" call — the caller passes the old
 * report, the new content of the edited file, and the unchanged files
 * around it. Returns the new report + delta. */
