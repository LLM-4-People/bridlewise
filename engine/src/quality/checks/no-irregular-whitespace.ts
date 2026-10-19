/**
 * no-irregular-whitespace check (EXP462 — ESLint no-irregular-whitespace).
 *
 * Flags irregular whitespace characters: non-breaking space (U+00A0),
 * zero-width space (U+200B), zero-width non-joiner (U+200C), zero-width
 * joiner (U+200D), line separator (U+2028), paragraph separator (U+2029),
 * and other Unicode whitespace that's invisible in most editors. These
 * cause subtle bugs (e.g. a non-breaking space in a string that's
 * compared with a regular space). Language-agnostic. Severity: info.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

const IRREGULAR_WS = /[\u00A0\u1680\u2000-\u200A\u200B\u200C\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF]/g;

export function checkNoIrregularWhitespace(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      IRREGULAR_WS.lastIndex = 0;
      const m = IRREGULAR_WS.exec(line);
      if (!m) continue;
      const cp = m[0].codePointAt(0) ?? 0;
      findings.push({
        checkId: "no-irregular-whitespace", severity: "info", filePath: f.path,
        line: i + 1, column: m.index + 1, symbol: null,
        message: `Irregular whitespace U+${cp.toString(16).toUpperCase().padStart(4, "0")} — invisible in most editors`,
        extra: { file: f.path, codepoint: cp },
      });
    }
  }
  return findings;
}
