/**
 * Quantum decoherence stability (EXP309).
 *
 * EXP309 found that the codebase's "quantum decoherence" — the rate at
 * which coherent patterns (functions with similar complexity) lose
 * coherence over git history — is a stable health metric. For the
 * awareness signal, we approximate decoherence as the variance of the
 * per-commit complexity distribution. A codebase with LOW variance
 * across commits is "coherent" (stable); a codebase with HIGH variance
 * is "decohering" (chaotic).
 *
 * For the awareness signal, we compute:
 * - coherenceScore: 1 - normalized variance (1 = perfectly stable).
 * - meanCommitSize: average files-changed per commit.
 * - varianceCommitSize: variance of files-changed per commit.
 * - isStable: true if coherenceScore > stabilityThreshold (default 0.7).
 * - commitCount: number of commits in the window.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeQuantumStability(ctx: SignalContext) {
  if (ctx.gitHistory.length === 0) {
    return { quantumStability: { coherenceScore: 0, meanCommitSize: 0, varianceCommitSize: 0, isStable: false, commitCount: 0 } };
  }
  const sizes = ctx.gitHistory.map(c => c.changedFiles.length);
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  let variance = 0;
  for (const s of sizes) variance += (s - mean) * (s - mean);
  variance /= sizes.length;
  // Normalize variance to [0, 1] using a logistic bound.
  const normalizedVar = variance / (variance + mean * mean + 1);
  const coherence = 1 - normalizedVar;
  const stabilityThreshold = ctx.config.thresholds.quantumStabilityThreshold;
  return {
    quantumStability: {
      coherenceScore: round(coherence, 4),
      meanCommitSize: round(mean, 2),
      varianceCommitSize: round(variance, 2),
      isStable: coherence > stabilityThreshold,
      commitCount: ctx.gitHistory.length,
    },
  };
}
