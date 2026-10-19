/**
 * Long-line check (EXP386).
 *
 * Flags lines ≥ `thresholds.longLine` columns. Long lines hurt readability
 * and force horizontal scrolling in code review; many style guides cap lines
 * at 80, 100, or 120 columns.
 *
 * Language-agnostic — a line is a line. The check measures code-unit width
 * (character count, not bytes or display columns), which is the closest
 * language-neutral approximation. Tabs count as 1 character (configurable
 * in the future via a `tabWidth` threshold; for now, a tab is one column).
 *
 * Threshold: `config.thresholds.longLine` (default 120, dynamic from
 * central config — not hardcoded).
 *
 * False-positive avoidance:
 * - Skip lines that are entirely a long URL in a comment.
 * - Skip lines that are a single long string literal.
 * - Cap findings per file (avoid flooding on auto-generated code).
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

const MAX_PER_FILE = 50;

export function checkLongLines(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const threshold = config.thresholds.longLine;
  for (const f of files) {
    const lines = f.content.split("\n");
    let count = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.length < threshold) continue;
      // Skip pure-comment lines that contain a URL — they're unavoidable.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) {
        if (/https?:\/\//.test(trimmed)) continue;
      }
      // Skip lines that are a single long string literal (the only content
      // is one quoted string). Heuristic: starts with whitespace + a quote
      // and ends with the matching quote.
      if (/^\s*["'`]/.test(line) && /["'`],?\s*$/.test(line) && line.split(/["'`]/).length <= 4) continue;
      findings.push({
        checkId: "long-line",
        severity: "info",
        filePath: f.path,
        line: i + 1,
        column: threshold + 1,
        symbol: null,
        message: `Line is ${line.length} columns long (≥ ${threshold})`,
        extra: { length: line.length, threshold, file: f.path },
      });
      count += 1;
      if (count >= MAX_PER_FILE) break;
    }
  }
  return findings;
}
