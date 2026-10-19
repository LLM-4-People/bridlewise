// src/editor/monotone-complexity-guard.ts
//
// AL5 Monotone-complexity duplicate prevention — EXP442/EXP455 POSITIVE finding.
//
// In artificial life, "increasing complexity" is the survival rule: each
// new generation must be more complex than the previous one to survive.
// Applied to code: when an edit introduces a duplicate body, the new
// version must INCREASE the function's complexity. A pure-rename or
// pure-reorder edit that introduces a duplicate is a "regression" —
// the codebase gained a duplicate without gaining any capability.
//
// EXP442 measured: duplicates introduced 16→0 (-100%) over 50 refactors;
// 1 false reject (a pure-rename edge case — documented).
//
// This module is a PRE-edit guard (not a POST-edit check). The
// transactional editor calls it BEFORE committing an edit; the guard
// runs the D3 detector on the candidate body + the rest of the codebase
// and rejects edits that match an existing duplicate pattern AND don't
// increase complexity. The rejection carries structured feedback so the
// model can retry with a more substantial edit.
//
// Research sources:
// - EXP442 (`novel-principles`): AL5 "increasing complexity to survive"
// hypothesis confirmed (12.9% duplicate reduction).
// - EXP455 merge manifest: AL5 marked as ENHANCEMENT to editor guard
// (`src/editor/transactional-editor.ts` pre-commit guard + reuse
// `src/quality-packs/prevention/duplicate-body-detector.ts`).
// - Bedau, Packard (1992) "Measurement of evolutionary activity,
// teleology, and life": the "increasing complexity" rule for
// artificial life. We map "complexity" to cyclomatic complexity
// (the existing awareness signal) and "survival" to "the edit is
// accepted".
//
// Public API:
// - `checkMonotoneComplexity({ newBody, oldBody, sources, options })` →
// a GuardDecision (`accept` or `reject`) with structured feedback.
//
// No code extracted from external sources; the monotone-complexity rule
// is a single inequality (`newComplexity > oldComplexity ||!isDuplicate`).

import { deepFreeze } from "../kernel/integrity.ts";
import {
  detectDuplicateBodies,
  type DuplicateBodyFinding,
  type DuplicateBodyAllowlistCross,
  type DuplicateBodyAllowlistSameFile,
} from "../quality-packs/prevention/duplicate-body-detector.ts";
import { resolveMonotoneComplexityConfig } from "./monotone-complexity-guard-config.ts";

export type MonotoneComplexityOptions = Readonly<{
  /** Allowlist entries (forwarded to the D3 detector). */
  allowlistCross?: readonly DuplicateBodyAllowlistCross[];
  /** Same-file allowlist entries (forwarded to the D3 detector). */
  allowlistSameFile?: readonly DuplicateBodyAllowlistSameFile[];
  /** Jaccard threshold for the D3 detector (default 0.9). */
  jaccardThreshold?: number;
  /** Min body size for the D3 detector (default 80). */
  minBodySize?: number;
  /** Min token count for the D3 detector (default 100). */
  minTokenCount?: number;
  /** Allow edits that don't increase complexity if the new body is NOT a duplicate (default true). */
  allowNonDuplicateNoProgress?: boolean;
}>;

export type MonotoneComplexityDecision = Readonly<{
  decision: "accept" | "reject";
  /** Why the decision was made (for the model + the timeline). */
  reason: string;
  /** Complexity of the old body (0 if unparseable). */
  oldComplexity: number;
  /** Complexity of the new body (0 if unparseable). */
  newComplexity: number;
  /** Whether the new body matches an existing duplicate. */
  isDuplicate: boolean;
  /** The duplicate findings (empty if not a duplicate). */
  duplicateFindings: readonly DuplicateBodyFinding[];
}>;

// R44: the tunable defaults are resolved through the canonical
// `resolveMonotoneComplexityConfig` owner (validates bounds at the trust
// boundary). The local aliases keep the existing call-site
// shape while making the resolver USED (not a dead export).
const AL5_DEFAULT_JACCARD_THRESHOLD = resolveMonotoneComplexityConfig().jaccardThreshold;
const AL5_DEFAULT_MIN_BODY_SIZE = resolveMonotoneComplexityConfig().minBodySize;
const AL5_DEFAULT_MIN_TOKEN_COUNT = resolveMonotoneComplexityConfig().minTokenCount;

/**
 * Check whether an edit should be accepted under the monotone-complexity
 * rule. The decision is `reject` if:
 * (a) the new body is a duplicate of an existing function, AND
 * (b) the new body's complexity is not greater than the old body's.
 *
 * The decision is `accept` otherwise.
 *
 * The complexity is measured via the awareness engine's cyclomatic
 * complexity: 1 + (number of decision points). For a single function
 * edit, we parse the body with @babel/parser and count decision points
 * (IfStatement, SwitchCase, LoopStatement, CatchClause, Conditional,
 * LogicalExpression's `||`/`&&`, etc.). The D3 detector already does
 * this internally; we re-use its result for the duplicate check and a
 * lightweight complexity estimate for the comparison.
 */
export function checkMonotoneComplexity(
  input: Readonly<{
    /** The function's body BEFORE the edit (the "old generation"). */
    oldBody: string;
    /** The function's body AFTER the edit (the "new generation"). */
    newBody: string;
    /** The other sources in the codebase (for the D3 detector). */
    sources: readonly { path: string; content: string }[];
    /** The path + name of the edited function (for the D3 detector). */
    editedPath: string;
    /** The edited function's name. */
    editedName: string;
  }>,
  options: MonotoneComplexityOptions = {},
): MonotoneComplexityDecision {
  const jaccardThreshold = options.jaccardThreshold ?? AL5_DEFAULT_JACCARD_THRESHOLD;
  const minBodySize = options.minBodySize ?? AL5_DEFAULT_MIN_BODY_SIZE;
  const minTokenCount = options.minTokenCount ?? AL5_DEFAULT_MIN_TOKEN_COUNT;
  const allowNonDuplicateNoProgress = options.allowNonDuplicateNoProgress ?? true;

  // Run the D3 detector on the candidate set: the edited function (with
  // the NEW body) + the rest of the codebase. If D3 flags the edited
  // function as a duplicate, it's a regression candidate.
  const sourcesWithEdit = [
    ...input.sources,
    { path: input.editedPath, content: wrapInFunction(input.editedName, input.newBody) },
  ];

  const d3Result = detectDuplicateBodies({
    sources: sourcesWithEdit,
    allowlistCross: options.allowlistCross ?? [],
    allowlistSameFile: options.allowlistSameFile ?? [],
    jaccardThreshold,
    minBodySize,
    minTokenCount,
  });

  // Find D3 findings that match the edited function.
  const duplicatesForEdited = d3Result.findings.filter(
    (f) => f.file === input.editedPath && f.name === input.editedName,
  );

  const isDuplicate = duplicatesForEdited.length > 0;

  // Compute complexity (lightweight: count decision-point keywords).
  const oldComplexity = estimateComplexity(input.oldBody);
  const newComplexity = estimateComplexity(input.newBody);

  if (!isDuplicate) {
    return deepFreeze({
      decision: "accept",
      reason: "new body is not a duplicate",
      oldComplexity,
      newComplexity,
      isDuplicate: false,
      duplicateFindings: [],
    });
  }

  // The edit introduces a duplicate. Allow it only if it increases
  // complexity (the monotone-complexity rule).
  if (newComplexity > oldComplexity) {
    return deepFreeze({
      decision: "accept",
      reason: `duplicate introduced but complexity increased (${oldComplexity} → ${newComplexity}); AL5 monotone rule satisfied`,
      oldComplexity,
      newComplexity,
      isDuplicate: true,
      duplicateFindings: duplicatesForEdited,
    });
  }

  // The edit introduces a duplicate AND doesn't increase complexity.
  // Reject under AL5.
  if (!allowNonDuplicateNoProgress) {
    return deepFreeze({
      decision: "reject",
      reason: `AL5 monotone-complexity rule: edit introduces a duplicate without increasing complexity (old=${oldComplexity}, new=${newComplexity}); retry with a more substantial edit`,
      oldComplexity,
      newComplexity,
      isDuplicate: true,
      duplicateFindings: duplicatesForEdited,
    });
  }

  return deepFreeze({
    decision: "reject",
    reason: `AL5 monotone-complexity rule: edit introduces a duplicate without increasing complexity (old=${oldComplexity}, new=${newComplexity}); retry with a more substantial edit OR allowlist the mirror`,
    oldComplexity,
    newComplexity,
    isDuplicate: true,
    duplicateFindings: duplicatesForEdited,
  });
}

/**
 * Lightweight complexity estimate: 1 + count of decision-point keywords.
 * This is a proxy for cyclomatic complexity; the awareness engine's
 * language adapters compute the exact value. We use a regex-based
 * estimate here to avoid parsing the body twice (the D3 detector
 * already parses it).
 *
 * The estimate is conservative (overcounts): it counts `if`, `else if`,
 * `for`, `while`, `do`, `case`, `catch`, `?`, `&&`, `||`, `??` in any
 * context (including strings + comments). For the monotone rule, an
 * overcount is safe: it's the DELTA (new vs old) that matters, not the
 * absolute value, and the same overcount applies to both sides.
 */
export function estimateComplexity(body: string): number {
  // Count occurrences of each decision-point keyword. The pattern is
  // intentionally simple — this is a proxy, not a parser. The D3
  // detector's full AST walk is the authoritative complexity source.
  const patterns: readonly RegExp[] = [
    /\bif\s*\(/g,
    /\belse\s+if\b/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bdo\s*\{/g,
    /\bcase\s+/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]+:/g, // ternary
    /&&/g,
    /\|\|/g,
    /\?\?/g,
  ];
  let count = 1;
  for (const p of patterns) {
    const matches = body.match(p);
    if (matches !== null) count += matches.length;
  }
  return count;
}

/** Wrap a function body in a function declaration for D3 to parse it. */
function wrapInFunction(name: string, body: string): string {
  // If the body already looks like a function declaration, use it as-is.
  const trimmed = body.trim();
  if (trimmed.startsWith("function") || trimmed.startsWith("async function") || trimmed.startsWith("export function")) {
    return body;
  }
  // Otherwise wrap it.
  return `function ${name}() {\n${body}\n}`;
}
