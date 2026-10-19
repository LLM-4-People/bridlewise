/**
 * no-extra-semi check (EXP462 — ESLint no-extra-semi).
 *
 * Flags extra semicolons: `;;`, `};`, `let x = 1;;`. Extra semicolons are
 * empty statements — harmless but noisy. JS-family only. Severity: info.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const DOUBLE_SEMI_RE = /;;/;

export function checkNoExtraSemi(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      if (DOUBLE_SEMI_RE.test(code)) {
        findings.push({
          checkId: "no-extra-semi", severity: "info", filePath: f.path,
          line: i + 1, column: 1, symbol: null,
          message: "Extra semicolon (empty statement)",
          extra: { file: f.path },
        });
      }
    }
  }
  return findings;
}
