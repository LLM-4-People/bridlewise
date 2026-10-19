/**
 * Benford's-law deviation signal (EXP42).
 *
 * EXP42 found that numeric literals in src/ follow Benford's law (the
 * logarithmic first-digit distribution) closely — deviations are
 * universal (digit-1 dominance from index arithmetic), NOT a
 * generation signal. Standalone Benford doesn't detect fabricated code,
 * BUT the deviation from Benford's expected distribution is a weak
 * relative fingerprint: codebases with very different Benford profiles
 * have different numeric vocabularies (e.g. test-heavy code has more
 * round numbers like 100, 1000).
 *
 * For awareness, the signal computes the first-digit distribution of
 * all numeric literals in the codebase, the Benford expected
 * distribution (log10(1+1/d)), and the chi-square deviation. A high
 * deviation signals a codebase that's either test-heavy, generated, or
 * uses a narrow numeric vocabulary — actionable for "is this codebase
 * uniform or diverse?".
 *
 * The signal reads the RAW source code (not the token stream) because
 * the tree-sitter adapters normalize numeric literals to "lit_num" (the
 * value is lost). Reading the source is bounded by `maxFilesPerSignal`
 * (configurable — defaults to all source files).
 *
 * Source: EXP42 (https://github.com/.../experiments/exp42-benfords-law).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

// Benford's law expected first-digit probabilities.
const BENFORD = [0, 0.30103, 0.17609, 0.12494, 0.09691, 0.07918, 0.06695, 0.05799, 0.05115, 0.04576];

export function computeBenford(ctx: SignalContext) {
  const firstDigitCount = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // index 1-9 used.
  let total = 0;
  // Read the raw source for numeric literals — the token stream normalizes
  // numbers to "lit_num" / "NUM_..." (the value is lost in normalization).
  // Bounded by the file count to keep it fast on large codebases.
  const maxFiles = ctx.config.thresholds.benfordMaxFiles;
  const filesToScan = ctx.fileAnalyses.slice(0, maxFiles);
  for (const fa of filesToScan) {
    const content = ctx.readFile(fa.filePath);
    if (content === null) continue;
    // Match numeric literals: integer or decimal, optionally negative.
    // Skip numbers inside strings/comments — approximate by excluding
    // lines that start with a comment marker.
    const lines = content.split("\n");
    for (const line of lines) {
      // Skip comment-heavy lines (heuristic: >50% comment markers).
      const commentMarkers = ["//", "#", "/*", "*", "--"];
      if (commentMarkers.some(m => line.trim().startsWith(m))) continue;
      // Match numbers. Regex handles: 123, 12.34, 0.5, -7, 1_000, 0x1A (skip hex).
      const matches = line.matchAll(/(?<![a-zA-Z_$.])(-?\d+(?:\.\d+)?)(?![a-zA-Z_$])/g);
      for (const m of matches) {
        const numStr = m[1]!;
        // Skip the leading 0 in 0x... / 0b... / 0o... (we don't want hex etc).
        if (/^0[xXbBoO]/.test(numStr)) continue;
        // Take the first DIGIT after the optional minus sign.
        const firstDigit = numStr.replace(/^-/, "").charAt(0);
        const d = Number(firstDigit);
        if (d < 1 || d > 9) continue;
        firstDigitCount[d]! += 1;
        total += 1;
      }
    }
  }
  if (total === 0) {
    return { benford: { firstDigitDistribution: [0,0,0,0,0,0,0,0,0], chiSquareDeviation: 0, totalNumbers: 0, dominantDigit: 0 } };
  }
  // Chi-square deviation from Benford.
  let chiSquare = 0;
  for (let d = 1; d <= 9; d += 1) {
    const observed = firstDigitCount[d]!;
    const expected = BENFORD[d]! * total;
    if (expected > 0) chiSquare += Math.pow(observed - expected, 2) / expected;
  }
  const distribution = Array.from({ length: 9 }, (_, i) => round(firstDigitCount[i + 1]! / total, 4));
  // Dominant digit = the one with the largest positive residual.
  let dominant = 1;
  let maxResidual = -Infinity;
  for (let d = 1; d <= 9; d += 1) {
    const residual = (firstDigitCount[d]! / total) - BENFORD[d]!;
    if (residual > maxResidual) { maxResidual = residual; dominant = d; }
  }
  return {
    benford: {
      firstDigitDistribution: distribution,
      chiSquareDeviation: round(chiSquare, 4),
      totalNumbers: total,
      dominantDigit: dominant,
    },
  };
}
