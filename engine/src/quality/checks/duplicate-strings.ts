/**
 * Duplicate-string check (EXP386).
 *
 * Flags string literals that appear ≥ `thresholds.duplicateStringMin` times
 * across a single file (default 3). Repeated string literals are a DRY
 * violation — they should be extracted to a named constant. This is the
 * string analog of the `duplicate-body` check.
 *
 * Language-agnostic — uses a line-text heuristic to find quoted strings:
 * - double-quoted: "..."
 * - single-quoted: '...'
 * - backtick (JS/TS template literals): `...`
 * - triple-quoted (Python): not handled here (the heuristic would
 * over-match across line boundaries — left for a future AST pass).
 *
 * Only flags strings ≥ `thresholds.duplicateStringMinLen` chars (default 10)
 * — short strings like "," or "yes" are too common to be useful signals.
 *
 * False-positive avoidance:
 * - Skip string literals in import statements (`import "x"`, `from "x"`,
 * `#include "x.h"`, `use "x"`).
 * - Skip string literals that look like format strings or i18n keys
 * (start with `%` or `i18n.`).
 * - Cap findings per file to avoid flooding on test files (which often
 * repeat string literals as test inputs).
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

const MAX_PER_FILE = 30;
const STRING_RE = /(["'`])((?:\\.|(?!\1).)*)\1/g;

function isImportLine(line: string): boolean {
  const t = line.trim();
  return /^\s*(import|from|use|include|#include|package)\b/.test(t);
}

export function checkDuplicateStrings(
  files: readonly ParsedFile[],
  config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const minOccurrences = config.thresholds.duplicateStringMin;
  const minLen = config.thresholds.duplicateStringMinLen;
  for (const f of files) {
    const lines = f.content.split("\n");
    // string → list of (line, col)
    const occurrences = new Map<string, Array<{ line: number; col: number }>>();
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (isImportLine(line)) continue;
      STRING_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = STRING_RE.exec(line)) !== null) {
        const value = m[2] ?? "";
        if (value.length < minLen) continue;
        // Skip format strings / i18n keys.
        if (value.startsWith("%") || value.startsWith("i18n.")) continue;
        const list = occurrences.get(value);
        if (list) list.push({ line: i + 1, col: m.index + 1 });
        else occurrences.set(value, [{ line: i + 1, col: m.index + 1 }]);
      }
    }
    let count = 0;
    for (const [value, locs] of occurrences) {
      if (locs.length < minOccurrences) continue;
      // Report on each occurrence after the first (the duplicates).
      for (let k = 1; k < locs.length; k += 1) {
        findings.push({
          checkId: "duplicate-string",
          severity: "info",
          filePath: f.path,
          line: locs[k]!.line,
          column: locs[k]!.col,
          symbol: null,
          message: `String literal "${value.slice(0, 40)}${value.length > 40 ? "..." : ""}" repeated ${locs.length}× in this file (first at line ${locs[0]!.line})`,
          extra: {
            count: locs.length,
            firstLine: locs[0]!.line,
            value: value.slice(0, 80),
            file: f.path,
          },
        });
        count += 1;
        if (count >= MAX_PER_FILE) break;
      }
      if (count >= MAX_PER_FILE) break;
    }
  }
  return findings;
}
