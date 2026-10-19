/**
 * Free-probability signal (EXP84 + EXP320).
 *
 * EXP84 applied Voiculescu free probability to the codebase: it found
 * 1312 hidden-coupling pairs (W=20) where two functions have non-
 * commuting token correlations Jaccard misses. EXP220 confirmed the
 * win: V3 O8 caught at strict, V4 N4+N6 caught (unique wins Jaccard
 * misses). Detects non-commuting token correlations.
 *
 * For awareness, we approximate "free independence" via a SIMPLER proxy:
 * for each pair of token-classes (e.g. ID_x and ID_y), compute whether
 * their joint occurrence distribution deviates from the product of
 * their marginal distributions (a χ² independence test). Pairs that
 * FAIL the independence test are "coupled" — a hidden-clone signal.
 *
 * The signal emits:
 * coupledPairs: number of token-class pairs that fail independence.
 * freeIndependent: true if no pairs fail (the codebase is "freely
 * independent" — no hidden couplings).
 * topCoupled: top-3 coupled token-class pairs (the strongest
 * hidden-clone signals).
 * noncommutingFraction: fraction of tested pairs that are coupled.
 *
 * Actionable: a high coupledPairs count means the codebase has hidden
 * structural relationships Jaccard misses — review topCoupled.
 *
 * Source: EXP84, EXP320.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeFreeProbability(ctx: SignalContext) {
  // Build a per-file token-class co-occurrence matrix.
  // Token classes: top-N most-frequent tokens (capped to keep it fast).
  // R48: N is now read from the single awareness config owner
  // (`config.thresholds.freeProbabilityTopTokens`) — was a hardcoded `20`
  // with a lying "configurable via threshold? kept inline for simplicity"
  // comment.
  const N = ctx.config.thresholds.freeProbabilityTopTokens;
  const fileCount = ctx.fileAnalyses.length;
  if (fileCount < 3) {
    return { freeProbability: { coupledPairs: 0, freeIndependent: true, noncommutingFraction: 0, topCoupled: [] } };
  }
  // Find top-N tokens.
  const freq = new Map<string, number>();
  for (const fa of ctx.fileAnalyses) {
    const seen = new Set<string>();
    for (const t of fa.tokenStream) {
      if (seen.has(t)) continue;
      seen.add(t);
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const topTokens = [...freq.entries()]
    .filter(([, c]) => c >= 2 && c < fileCount) // must appear in >=2 files but not everywhere
    .sort((a, b) => b[1] - a[1])
    .slice(0, N)
    .map(([t]) => t);
  if (topTokens.length < 2) {
    return { freeProbability: { coupledPairs: 0, freeIndependent: true, noncommutingFraction: 0, topCoupled: [] } };
  }
  // Co-occurrence matrix.
  const cooc = Array.from({ length: topTokens.length }, () => new Array<number>(topTokens.length).fill(0));
  const marginal = new Array<number>(topTokens.length).fill(0);
  for (const fa of ctx.fileAnalyses) {
    const present = new Set<number>();
    for (const t of fa.tokenStream) {
      const idx = topTokens.indexOf(t);
      if (idx >= 0) present.add(idx);
    }
    for (const i of present) {
      marginal[i]! += 1;
      for (const j of present) {
        if (i !== j) cooc[i]![j]! += 1;
      }
    }
  }
  // χ² independence test for each pair (i, j).
  let coupledPairs = 0;
  const topCoupled: Array<{ tokens: string; chiSquare: number; observed: number; expected: number }> = [];
  for (let i = 0; i < topTokens.length; i += 1) {
    for (let j = i + 1; j < topTokens.length; j += 1) {
      const observed = cooc[i]![j]!;
      const pi = marginal[i]! / fileCount;
      const pj = marginal[j]! / fileCount;
      const expected = pi * pj * fileCount;
      if (expected < 1) continue; // skip low-frequency pairs (no signal)
      const chiSq = Math.pow(observed - expected, 2) / expected;
      if (chiSq >= 3.84) { // p<0.05 critical value
        coupledPairs += 1;
        topCoupled.push({ tokens: `${topTokens[i]}+${topTokens[j]}`, chiSquare: round(chiSq, 4), observed, expected: round(expected, 4) });
      }
    }
  }
  topCoupled.sort((a, b) => b.chiSquare - a.chiSquare);
  const totalPairs = (topTokens.length * (topTokens.length - 1)) / 2;
  const noncommutingFraction = round(totalPairs > 0 ? coupledPairs / totalPairs : 0, 4);
  return {
    freeProbability: {
      coupledPairs,
      freeIndependent: coupledPairs === 0,
      noncommutingFraction,
      topCoupled: topCoupled.slice(0, 3),
    },
  };
}
