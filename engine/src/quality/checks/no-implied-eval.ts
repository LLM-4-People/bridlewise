/**
 * no-implied-eval check (EXP462 — ESLint no-implied-eval).
 *
 * Flags `setTimeout("string",...)`, `setInterval("string",...)`,
 * `new Function("string")` — these are "implied eval": the string
 * argument is compiled and executed at runtime, equivalent to eval.
 * Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsOnly, isTestFile } from "./shared.ts";

const IMPLIED_EVAL_RE = /\b(setTimeout|setInterval)\s*\(\s*["'`]/;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/;

export function checkNoImpliedEval(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsOnly(lines[i] ?? "");
      if (IMPLIED_EVAL_RE.test(code)) {
        findings.push({
          checkId: "no-implied-eval", severity: "warning", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "setTimeout/setInterval with a string argument is implied eval",
          extra: { file: f.path },
        });
      }
      if (NEW_FUNCTION_RE.test(code)) {
        findings.push({
          checkId: "no-implied-eval", severity: "warning", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "new Function() is implied eval — avoid",
          extra: { file: f.path },
        });
      }
    }
  }
  return findings;
}
