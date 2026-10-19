/**
 * Parse-error check (EXP386).
 *
 * Surfaces syntax errors from the parsers as findings. Parsers populate
 * `ParsedFile.parseErrors` whenever tree-sitter or babel reports a syntax
 * error (error recovery is enabled, so a single error doesn't abort the
 * parse). This is a "free" check — the data is already computed by parsing.
 *
 * Severity:
 * - error: the file has any parse error (the AST may be incomplete and
 * other checks may miss findings or produce false positives).
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

export function checkParseErrors(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    for (const e of f.parseErrors) {
      findings.push({
        checkId: "parse-error",
        severity: "error",
        filePath: e.filePath,
        line: e.line,
        column: 0,
        symbol: null,
        message: e.message.slice(0, 200),
        extra: { file: e.filePath },
      });
    }
  }
  return findings;
}
