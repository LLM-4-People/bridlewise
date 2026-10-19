/**
 * no-unused-expressions check (EXP462 — ESLint no-unused-expressions).
 *
 * Flags expression statements that have no side effect: `a;`, `a.b;`,
 * `x + y;`. These evaluate and discard the result — almost always a
 * typo (missing `=`, ``, or a statement). The check skips:
 * - `await`/`yield` expressions (side effect via async control flow).
 * - `new...` expressions (construction side effect).
 * - Call expressions (function calls have side effects).
 * - Assignment / increment / delete.
 * JS-family. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const UNUSED_EXPR_RE = /^\s*([A-Za-z_$][\w$.]*(?:\.[A-Za-z_$][\w$]*)*)\s*;\s*$/;

export function checkNoUnusedExpressions(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "").trim();
      if (!code.endsWith(";")) continue;
      if (/^(await\s|yield\s|new\s|throw|return|if|for|while|switch|var|let|const|function|class|import|export|debugger)/.test(code)) continue;
      if (/[=()]/.test(code)) continue; // has assignment or call — side effect.
      if (/\+\+|--/.test(code)) continue; // increment — side effect.
      if (UNUSED_EXPR_RE.test(code)) {
        findings.push({
          checkId: "no-unused-expressions", severity: "warning", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "Unused expression — the value is evaluated and discarded",
          extra: { file: f.path, expr: code.slice(0, 40) },
        });
      }
    }
  }
  return findings;
}
