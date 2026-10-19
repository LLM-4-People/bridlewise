/**
 * Long-parameter-list check (EXP386).
 *
 * Flags functions/methods with ≥ `thresholds.longParameterList` parameters.
 * Long parameter lists are a readability + maintainability hazard — they
 * usually indicate the function does too much or that parameters should be
 * grouped into an options object/struct.
 *
 * Uses the per-symbol `paramCount` already computed by the parsers — no
 * additional parsing required. Works for all 6 languages because every
 * parser populates `paramCount` from the AST.
 *
 * Threshold: `config.thresholds.longParameterList` (default 5, dynamic from
 * central config — not hardcoded).
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

export function checkLongParameterList(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const threshold = config.thresholds.longParameterList;
  for (const f of files) {
    for (const sym of f.symbols) {
      if (sym.paramCount >= threshold) {
        findings.push({
          checkId: "long-parameter-list",
          severity: sym.paramCount >= threshold * 2 ? "warning" : "info",
          filePath: f.path,
          line: sym.line,
          column: 0,
          symbol: sym.name,
          message: `${sym.kind === "method" ? "Method" : "Function"} '${sym.name}' takes ${sym.paramCount} parameters (≥ ${threshold})`,
          extra: {
            paramCount: sym.paramCount,
            threshold,
            kind: sym.kind,
            file: f.path,
          },
        });
      }
    }
  }
  return findings;
}
