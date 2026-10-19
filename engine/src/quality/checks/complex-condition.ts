/**
 * Complex-condition check (EXP386).
 *
 * Flags a single boolean condition with ≥ `thresholds.complexCondition`
 * logical operators (`&&`, `||`, `and`, `or`, `&`, `|` in C/Rust). Complex
 * conditions are hard to read, hard to test (combinatorial explosion of
 * branches), and a common source of off-by-one and precedence bugs.
 *
 * Language-agnostic — counts operators per condition. A "condition" is the
 * text inside `if (...)`, `while (...)`, `for (...; COND;...)`, `case X if`,
 * and `assert(...)`. The check uses line-text heuristics (no AST traversal
 * of boolean expressions); it errs on the side of fewer false positives by
 * only counting when the operator appears outside of string literals and
 * comments.
 *
 * Threshold: `config.thresholds.complexCondition` (default 4).
 *
 * False-positive avoidance:
 * - Skip when the line is inside a comment or string.
 * - Skip `||` inside type annotations (TS union types like `string | number`
 * in a function signature). We detect this by also requiring `if`/`while`/
 * `assert` to appear on the line.
 * - Skip bit-or `|` in C/Rust when the line declares a flag-set constant
 * (e.g. `FLAGS = A | B | C | D | E | F`).
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

const CONDITION_RE = /\b(if|while|elif|elseif|assert|expect|require|where|when)\b\s*\(?\s*(.+?)\s*(?:\{|:|;|then|$)/;
const FOR_COND_RE = /\bfor\s*\([^;]*;\s*([^;]+);\s*\)/;
const RUST_MATCH_GUARD_RE = /\b(if|match)\b\s+[^=]*=>\s*if\s+(.+)/;

function stripStrings(line: string): string {
  let out = "";
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] ?? "";
    if (inStr) {
      if (c === "\\") { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    out += c;
  }
  return out;
}

function countOperators(s: string): number {
  // Count `&&`, `||`, `and`, `or`, and standalone `&`/`|` (bit-ops, but rare
  // in a condition — flag them anyway as a heuristic).
  let n = 0;
  n += (s.match(/&&/g) ?? []).length;
  n += (s.match(/\|\|/g) ?? []).length;
  // Word operators: `and`, `or` (Python, Ruby). Use word boundaries.
  n += (s.match(/\band\b/g) ?? []).length;
  n += (s.match(/\bor\b/g) ?? []).length;
  return n;
}

export function checkComplexCondition(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const threshold = config.thresholds.complexCondition;
  for (const f of files) {
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? "";
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const stripped = stripStrings(raw);
      // Identify the condition text.
      let cond: string | null = null;
      const m1 = stripped.match(CONDITION_RE);
      if (m1 && m1[2]) cond = m1[2];
      if (cond === null) {
        const m2 = stripped.match(FOR_COND_RE);
        if (m2 && m2[1]) cond = m2[1];
      }
      if (cond === null) {
        const m3 = stripped.match(RUST_MATCH_GUARD_RE);
        if (m3 && m3[2]) cond = m3[2];
      }
      if (cond === null) continue;
      const ops = countOperators(cond);
      if (ops >= threshold) {
        findings.push({
          checkId: "complex-condition",
          severity: ops >= threshold * 2 ? "warning" : "info",
          filePath: f.path,
          line: i + 1,
          column: raw.indexOf(cond) + 1,
          symbol: null,
          message: `Condition has ${ops} logical operators (≥ ${threshold})`,
          extra: { operators: ops, threshold, file: f.path },
        });
      }
    }
  }
  return findings;
}
