/**
 * no-unused-labels check (EXP462 — ESLint no-unused-labels).
 *
 * Flags labels that are declared but never referenced by a `break label`
 * or `continue label`. Labels are rare in modern code; unused ones are
 * dead syntax. JS-family only. Severity: info.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const LABEL_DECL_RE = /^(\s*)([A-Za-z_$][\w$]*)\s*:\s*(?:for|while|do|switch|\{)/;

export function checkNoUnusedLabels(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    const stripped = lines.map(l => stripCommentsAndStrings(l));
    for (let i = 0; i < stripped.length; i += 1) {
      const m = LABEL_DECL_RE.exec(lines[i] ?? "");
      if (!m) continue;
      const label = m[2]!;
      let used = false;
      for (let j = 0; j < stripped.length; j += 1) {
        if (j === i) continue;
        if (new RegExp(`\\b(break|continue)\\s+${label.replace(/[$]/g, "\\$&")}\\b`).test(stripped[j] ?? "")) {
          used = true; break;
        }
      }
      if (!used) {
        findings.push({
          checkId: "no-unused-labels", severity: "info", filePath: f.path,
          line: i + 1, column: 1, symbol: label,
          message: `Label '${label}' is declared but never referenced by break/continue`,
          extra: { file: f.path, label },
        });
      }
    }
  }
  return findings;
}
