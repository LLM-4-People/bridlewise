/**
 * no-cond-assign check (EXP462 — ESLint no-cond-assign).
 *
 * Flags assignment (`=`) inside a condition (`if (...)`, `while (...)`,
 * `do... while (...)`, `for (...;...;...)`). Assignment in a condition
 * is almost always a typo for `==`/`===`. The check distinguishes `=`
 * (assignment) from `==`/`===` (comparison). Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings } from "./shared.ts";

const COND_RE = /\b(if|while|for)\s*\(\s*(.+)\)/;
// Match a single `=` that is NOT part of `==`, `===`, `!=`, `<=`, `>=`.
// `(?<![=!<>])` excludes assignment preceded by `=!<>`; `(?!=)` excludes `==`.
const ASSIGN_IN_COND_RE = /(?<![=!<>])=(?!=)/;

export function checkNoCondAssign(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      const m = COND_RE.exec(code);
      if (!m) continue;
      const cond = m[2] ?? "";
      if (!ASSIGN_IN_COND_RE.test(cond)) continue;
      findings.push({
        checkId: "no-cond-assign", severity: "warning", filePath: f.path,
        line: i + 1, column: 1, symbol: null,
        message: "Assignment (=) in a condition — did you mean == or ===?",
        extra: { file: f.path, condition: cond.slice(0, 60) },
      });
    }
  }
  return findings;
}
