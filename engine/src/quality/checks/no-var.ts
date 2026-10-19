/**
 * no-var check (EXP462 — ESLint no-var).
 *
 * Flags `var` declarations in JS/TS. `var` is function-scoped (not
 * block-scoped), causing hoisting bugs. Use `let`/`const` instead.
 * JS-family only. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const VAR_RE = /\bvar\s+/;

export function checkNoVar(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      if (!VAR_RE.test(code)) continue;
      findings.push({
        checkId: "no-var", severity: "warning", filePath: f.path,
        line: i + 1, column: 1, symbol: null,
        message: "Use let/const — var is function-scoped and causes hoisting bugs",
        extra: { file: f.path },
      });
    }
  }
  return findings;
}
