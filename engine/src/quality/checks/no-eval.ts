/**
 * no-eval check (EXP462 — ESLint no-eval).
 *
 * Flags direct `eval(...)` calls. `eval` executes arbitrary code passed as
 * a string, enabling code injection and breaking JIT optimization. This
 * is a subset of `security-hotspot`'s code-injection pattern, but as a
 * dedicated check it's high-precision (only `eval`, not `exec`/`Function`)
 * and configurable independently. Severity: warning (it's a security
 * lint, not a confirmed vulnerability — the eval'd string may be static).
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isTestFile } from "./shared.ts";

const EVAL_RE = /\beval\s*\(/;

export function checkNoEval(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      if (!EVAL_RE.test(code)) continue;
      findings.push({
        checkId: "no-eval", severity: "warning", filePath: f.path,
        line: i + 1, column: code.indexOf("eval") + 1, symbol: null,
        message: "eval() executes arbitrary strings — avoid; use Function or a parser",
        extra: { file: f.path },
      });
    }
  }
  return findings;
}
