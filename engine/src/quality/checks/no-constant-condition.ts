/**
 * no-constant-condition check (EXP462 — ESLint no-constant-condition).
 *
 * Flags `if (true)`, `if (false)`, `while (true)` (when not the idiomatic
 * infinite loop `while (true) {... break; }`), `do {... } while (false)`.
 * Constant conditions are either dead code (`if (false)`) or always-true
 * guards (`if (true)`) that hide the real intent. The check skips
 * `while (true)` since that's an idiomatic infinite loop. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings } from "./shared.ts";

const CONST_COND_RE = /\bif\s*\(\s*(true|false|null|undefined)\s*\)/;
const DO_WHILE_FALSE_RE = /\bwhile\s*\(\s*false\s*\)/;

export function checkNoConstantCondition(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      if (CONST_COND_RE.test(code)) {
        findings.push({
          checkId: "no-constant-condition", severity: "warning", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "Constant condition (if(true/false)) — dead code or always-true guard",
          extra: { file: f.path },
        });
      }
      if (DO_WHILE_FALSE_RE.test(code)) {
        findings.push({
          checkId: "no-constant-condition", severity: "warning", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "do...while(false) — loop body runs exactly once, not a loop",
          extra: { file: f.path },
        });
      }
    }
  }
  return findings;
}
