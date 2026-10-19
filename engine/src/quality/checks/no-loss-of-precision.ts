/**
 * no-loss-of-precision check (EXP462 — ESLint no-loss-of-precision).
 *
 * Flags numeric literals that exceed JavaScript's safe-integer range
 * (Number.MAX_SAFE_INTEGER = 2^53 - 1 = 9007199254740991) and would
 * lose precision when converted to a float64. Also flags decimal
 * literals with more significant digits than float64 can represent.
 * JS-family. Severity: warning.
 */
import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { stripCommentsAndStrings, isJsFamily } from "./shared.ts";

const BIG_INT_LITERAL_RE = /\b(\d{16,})\b/g;

export function checkNoLossOfPrecision(files: readonly ParsedFile[], _config: QualityConfig): readonly Finding[] {
  const findings: Finding[] = [];
  const MAX_SAFE = 9007199254740991;
  for (const f of files) {
    if (!isJsFamily(f.path, f.language)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripCommentsAndStrings(lines[i] ?? "");
      BIG_INT_LITERAL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = BIG_INT_LITERAL_RE.exec(code)) !== null) {
        const num = m[1]!;
        // Skip BigInt literals (trailing `n`).
        if (code[m.index + num.length] === "n") continue;
        if (num.length > 16 || Number(num) > MAX_SAFE) {
          findings.push({
            checkId: "no-loss-of-precision", severity: "warning", filePath: f.path,
            line: i + 1, column: m.index + 1, symbol: null,
            message: `Numeric literal ${num.slice(0, 8)}... exceeds Number.MAX_SAFE_INTEGER — use BigInt (append n) to preserve precision`,
            extra: { file: f.path, literal: num },
          });
        }
      }
    }
  }
  return findings;
}
