/**
 * no-extra-boolean-cast check (EXP462 — ESLint no-extra-boolean-cast).
 *
 * Flags redundant boolean casts: `if (!!x)`, `if (Boolean(x))` inside a
 * boolean context (if/while/for condition). The condition is already
 * coerced to boolean, so the extra cast is noise. JS-family. Severity: info.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const EXTRA_BOOL_RE = /\b(if|while|for)\s*\(\s*(!!|Boolean\()/;

export function checkNoExtraBooleanCast(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      if (!EXTRA_BOOL_RE.test(code)) continue;
      findings.push({
        checkId: "no-extra-boolean-cast", severity: "info", filePath: f.path,
        line: i + 1, column: 1, symbol: null,
        message: "Redundant boolean cast (!! or Boolean()) in a boolean context",
        extra: { file: f.path },
      });
    }
  }
  return findings;
}
