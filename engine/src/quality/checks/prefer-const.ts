/**
 * prefer-const check (EXP462 — ESLint prefer-const).
 *
 * Flags `let x =...` where x is never reassigned in the same file. This
 * is a heuristic (no full scope analysis) — it checks whether the
 * variable name appears with an assignment operator (`=`, `+=`, etc.)
 * AFTER the declaration line. If not, it's likely const-correct. False
 * positives are possible if the variable is reassigned in a different
 * scope or via destructuring. JS-family only. Severity: info.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const LET_DECL_RE = /\blet\s+([A-Za-z_$][\w$]*)\s*=/;

export function checkPreferConst(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    const stripped = lines.map(l => stripCommentsAndStrings(l));
    for (let i = 0; i < stripped.length; i += 1) {
      const m = LET_DECL_RE.exec(stripped[i] ?? "");
      if (!m) continue;
      const name = m[1]!;
      // Check if the variable is reassigned AFTER the declaration.
      // On the declaration line, scan from the character AFTER the `let x =...;`.
      // On subsequent lines, scan the whole line.
      const declMatch = stripped[i] ?? "";
      const declEnd = declMatch.indexOf(";", m.index ?? 0);
      const restOfDecl = declEnd >= 0 ? declMatch.slice(declEnd + 1) : "";
      let reassigned = false;
      const re = new RegExp(`\\b${name.replace(/[$]/g, "\\$&")}\\s*(=|\\+=|-=|\\*=|/=|%=|\\+\\+|--|<<=|>>=|>>>=|&=|\\|=|\\^=)`);
      if (re.test(restOfDecl)) reassigned = true;
      for (let j = i + 1; j < stripped.length && !reassigned; j += 1) {
        if (re.test(stripped[j] ?? "")) { reassigned = true; break; }
      }
      if (!reassigned) {
        findings.push({
          checkId: "prefer-const", severity: "info", filePath: f.path,
          line: i + 1, column: 1, symbol: name,
          message: `'${name}' is never reassigned — use const`,
          extra: { file: f.path, name },
        });
      }
    }
  }
  return findings;
}
