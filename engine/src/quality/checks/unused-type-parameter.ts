/**
 * unused-type-parameter check (EXP462 — TS no-unused-type-parameter).
 *
 * Flags TypeScript generic type parameters that are declared but never
 * used in the signature: `function f<T>: void` (T is never referenced).
 * The check scans the signature for the type parameter name outside its
 * declaration. TS-only. Severity: info.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings } from "./shared.ts";

const GENERIC_DECL_RE = /(?:function|class|interface|type)\s+[A-Za-z_$][\w$]*\s*<([^>]+)>|<[A-Za-z_$][\w$]*\s*(?:extends\s+[A-Za-z_$][\w$.]*)?\s*>\s*[(<]/;

export function checkUnusedTypeParameter(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.language !== "typescript") continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      const m = GENERIC_DECL_RE.exec(code);
      if (!m) continue;
      const params = (m[1] ?? m[0] ?? "").split(",").map(p => p.trim().replace(/\s+extends\s+.*/, "").replace(/^\s*<\s*/, "").replace(/[^A-Za-z_$][\w$]*$/, "").trim()).filter(p => /^[A-Za-z_$][\w$]*$/.test(p));
      for (const tp of params) {
        // Count references to tp in the rest of the line (after the `>`).
        const after = code.slice(code.indexOf(">") + 1);
        const refCount = (after.match(new RegExp(`\\b${tp}\\b`, "g")) ?? []).length;
        if (refCount === 0) {
          findings.push({
            checkId: "unused-type-parameter", severity: "info", filePath: f.path,
            line: i + 1, column: 1, symbol: tp,
            message: `Type parameter '${tp}' is declared but never used in the signature`,
            extra: { file: f.path, param: tp },
          });
        }
      }
    }
  }
  return findings;
}
