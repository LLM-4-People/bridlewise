/**
 * Code-health aggregate check (EXP446).
 *
 * The user's 23-check list includes "code-health" as a distinct benchmark
 * item. This file produces ONE aggregate "code-health" finding per file that
 * has any of the 5 health sub-check findings (todo-comment, empty-catch,
 * magic-number, missing-default, unused-local). The aggregate finding's
 * `extra.subFindings` lists the sub-checks that fired, so the LLM can drill
 * down via the per-check diagnostics.
 *
 * This is a *meta-check*: it does not duplicate detection logic — it
 * re-exports + re-invokes the existing sub-checks from `code-health.ts`
 * and aggregates the results into a single summary. Per the binding
 * directive "DRY, KISS, YAGNI", we reuse — not re-implement — the
 * sub-checks.
 *
 * The aggregate is useful as a single "is this file healthy?" signal for
 * scoring/ranking (e.g. "show me the 5 least-healthy files in the
 * codebase"). The sub-checks remain individually enabled so users can
 * disable the aggregate without disabling the sub-checks.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import {
  checkTodoComments,
  checkEmptyCatch,
  checkMagicNumbers,
  checkMissingDefault,
  checkUnusedLocals,
} from "./code-health.ts";

const SUB_CHECK_IDS = new Set([
  "todo-comment",
  "empty-catch",
  "magic-number",
  "missing-default-case",
  "unused-local",
]);

/** Run all 5 sub-checks once and return their findings. */
function collectSubFindings(
  files: readonly ParsedFile[],
  config: QualityConfig,
): Finding[] {
  const out: Finding[] = [];
  out.push(...checkTodoComments(files, config));
  out.push(...checkEmptyCatch(files, config));
  out.push(...checkMagicNumbers(files, config));
  out.push(...checkMissingDefault(files, config));
  out.push(...checkUnusedLocals(files, config));
  return out;
}

export function checkCodeHealth(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  if (config.skipCodeHealthAggregate) return [];
  const sub = collectSubFindings(files, config);
  // Group by file → which sub-checks fired there.
  const byFile = new Map<string, Set<string>>();
  for (const f of sub) {
    if (!SUB_CHECK_IDS.has(f.checkId)) continue;
    let set = byFile.get(f.filePath ?? "");
    if (!set) { set = new Set(); byFile.set(f.filePath ?? "", set); }
    set.add(f.checkId);
  }
  const findings: Finding[] = [];
  for (const [filePath, set] of byFile) {
    const subFindings = [...set].sort();
    findings.push({
      checkId: "code-health",
      severity: "warning",
      filePath: filePath.length > 0 ? filePath : "",
      line: 0,
      column: 0,
      symbol: null,
      message: `File has ${subFindings.length} code-health issue(s): ${subFindings.join(", ")}`,
      extra: { file: filePath, subFindings },
    });
  }
  return findings;
}
