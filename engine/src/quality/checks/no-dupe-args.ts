/**
 * no-dupe-args check (EXP462 — ESLint no-dupe-args).
 *
 * Flags duplicate parameter names in function declarations:
 * `function f(a, a) {}`. The second `a` shadows the first — almost
 * always a typo. JS-family + Python `def`. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const FN_PARAMS_RE = /(?:function\s*\*?\s*[A-Za-z_$]?[\w$]*\s*\(|\b[a-zA-Z_$][\w$]*\s*=>|\bdef\s+\w+\s*\()\s*([^)]*)\)/;
const ARROW_PARAMS_RE = /\(\s*([^)]*)\)\s*=>/;

export function checkNoDupeArgs(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language) && f.language !== "python") continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      const m = FN_PARAMS_RE.exec(code) ?? ARROW_PARAMS_RE.exec(code);
      if (!m) continue;
      const params = (m[1] ?? "").split(",").map(p => {
        const t = p.trim();
        // Extract the parameter name (before any `=`, `:`, or type annotation).
        return t.replace(/^(\.\.\.)?/, "").replace(/[=:].*$/, "").trim();
      }).filter(t => t.length > 0);
      const seen = new Set<string>();
      for (const p of params) {
        if (seen.has(p)) {
          findings.push({
            checkId: "no-dupe-args", severity: "warning", filePath: f.path,
            line: i + 1, column: 1, symbol: p,
            message: `Duplicate parameter '${p}' — the second shadows the first`,
            extra: { file: f.path, param: p },
          });
        }
        seen.add(p);
      }
    }
  }
  return findings;
}
