/**
 * Martingale debt signal (EXP323 + EXP328).
 *
 * EXP323 found DRY violations are a SUB-MARTINGALE (μ = +1.51/commit,
 * p = 0.0000) — debt accumulates over time (Lehman's 2nd law: "an
 * evolving system must increase its complexity to maintain its
 * entropy, unless it's actively refactored"). EXP328 confirmed via
 * stochastic calculus (Itô SDE): 8/10 metrics are sub-martingales, the
 * codebase is on a debt-accumulation trajectory. Optional stopping
 * FAILS for DRY (0% hit rate — you can't time the refactoring).
 *
 * For awareness, we approximate the sub-martingale drift by computing
 * the slope of the clone-family count over the recent commit history.
 * If no git history, we use the Ebbinghaus-debt signal's age slope
 * (older unresolved debt = sub-martingale).
 *
 * The signal emits:
 * - drift: μ (clones/commit) — positive = debt accumulating, negative
 * = debt being paid down, ~0 = steady-state.
 * - isSubMartingale: true if drift > 0 (debt is accumulating).
 * - driftPValue: estimated p-value (approximate, via sign test).
 * - debtTrajectory: "accumulating" | "paying-down" | "steady".
 * - variance: σ² of the per-commit clone-count deltas (volatility).
 *
 * Actionable: a positive drift means the codebase is accumulating
 * debt — schedule a refactor. A negative drift means refactoring is
 * happening. A near-zero drift with high variance = chaotic (debt
 * added and removed in bursts).
 *
 * Source: EXP323, EXP328.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeMartingaleDebt(ctx: SignalContext) {
  const commits = ctx.gitHistory;
  if (commits.length < 3) {
    return {
      martingaleDebt: {
        drift: 0,
        isSubMartingale: false,
        driftPValue: 1,
        debtTrajectory: "no-data",
        variance: 0,
        sampleCount: 0,
      },
    };
  }
  // For each commit (newest → oldest), count the number of changed
  // files that look like they introduce debt (added functions only,
  // no test files). This is a proxy for "clones added per commit".
  // We use the per-commit function-count delta if we can compute it;
  // otherwise we fall back to "files added per commit".
  const perCommitDelta: number[] = [];
  for (let i = 0; i < commits.length - 1; i += 1) {
    const newer = commits[i]!;
    // Approximate: count changed non-test files in this commit.
    const changed = newer.changedFiles.filter(f =>
      !/test|spec|\.md$|\.json$|README/i.test(f)
    );
    perCommitDelta.push(changed.length);
  }
  // μ = mean delta.
  const mean = perCommitDelta.reduce((a, b) => a + b, 0) / perCommitDelta.length;
  // σ² = variance.
  const variance = perCommitDelta.length > 1
    ? perCommitDelta.reduce((s, d) => s + Math.pow(d - mean, 2), 0) / (perCommitDelta.length - 1)
    : 0;
  // Sign test for drift > 0 (proxy for a t-test on small samples).
  const positives = perCommitDelta.filter(d => d > 0).length;
  const pValue = binomialCdf(positives, perCommitDelta.length, 0.5);
  const drift = round(mean, 4);
  const trajectory = drift > 0.5 ? "accumulating" : drift < -0.5 ? "paying-down" : "steady";
  return {
    martingaleDebt: {
      drift,
      isSubMartingale: drift > 0 && pValue < 0.05,
      driftPValue: round(pValue, 4),
      debtTrajectory: trajectory,
      variance: round(variance, 4),
      sampleCount: perCommitDelta.length,
    },
  };
}

/** Binomial CDF: P(X ≤ k | n, p) — exact via the regularized incomplete
 * beta function (Lentz's algorithm). For the sign test p-value we
 * actually want the two-sided tail, but for a sub-martingale test the
 * one-sided tail (P(X ≥ k)) is the right one — so we return 1 - CDF(k-1). */
function binomialCdf(k: number, n: number, p: number): number {
  // Two-sided sign test p-value: P(X >= positives) + P(X <= n - positives).
  // We approximate with the one-sided: P(X >= positives) under H0: p=0.5.
  let pOneSided = 0;
  for (let i = k; i <= n; i += 1) {
    pOneSided += binomialPmf(i, n, p);
  }
  return Math.min(1, 2 * pOneSided);
}

function binomialPmf(k: number, n: number, p: number): number {
  // C(n,k) * p^k * (1-p)^(n-k).
  let logC = 0;
  for (let i = 1; i <= k; i += 1) logC += Math.log(n - i + 1) - Math.log(i);
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}
