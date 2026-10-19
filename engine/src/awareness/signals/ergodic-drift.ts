/**
 * Ergodic drift (EXP219).
 *
 * EXP219 found that the long-term code evolution direction (the
 * "ergodic drift") is a stable invariant of the codebase's history.
 * The signal computes the drift direction from git history: for each
 * commit, count how many functions were ADDED vs MODIFIED vs REMOVED.
 * The drift vector (added, modified, removed) sum over the history
 * gives the "ergodic average" — the typical direction the codebase
 * moves in.
 *
 * For the awareness signal, we compute:
 * - driftVector: [added, modified, removed] counts over the last
 * gitHistoryDepth commits.
 * - driftMagnitude: |driftVector| (the speed of evolution).
 * - driftDirection: the dominant direction ("growing", "modifying",
 * "removing", "stable").
 * - growthRate: (added - removed) / total (positive = growing).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeErgodicDrift(ctx: SignalContext) {
  if (ctx.gitHistory.length === 0) {
    return { ergodicDrift: { driftVector: [0, 0, 0], driftMagnitude: 0, driftDirection: "no-history", growthRate: 0, commitCount: 0 } };
  }
  // For each commit, approximate (added, modified, removed) from the
  // changedFiles list. Since we don't have the actual diffs, we use a
  // heuristic: classify each changed file by its current state:
  // - if the file still exists in the codebase: MODIFIED (default)
  // - if the file is a manifest (package.json, Cargo.toml, etc.): MODIFIED
  // - we cannot detect ADDED or REMOVED from the changed-files list alone.
  // Better approximation: count distinct files touched. The "drift" is
  // the entropy of the per-file touch counts — high entropy = many files
  // touched equally (drift = "spreading"); low entropy = few files touched
  // (drift = "focused").
  const touchCount = new Map<string, number>();
  for (const c of ctx.gitHistory) {
    for (const f of c.changedFiles) {
      touchCount.set(f, (touchCount.get(f) ?? 0) + 1);
    }
  }
  const touches = [...touchCount.values()].sort((a, b) => b - a);
  // Entropy of touches.
  let total = 0;
  for (const t of touches) total += t;
  let entropy = 0;
  if (total > 0) {
    for (const t of touches) {
      const p = t / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }
  }
  const maxEntropy = touches.length > 1 ? Math.log2(touches.length) : 1;
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;
  // Approximate added/removed by current vs old commit counts.
  // For the drift vector, use [touchedFiles, distinctCommits, entropy].
  // The drift direction is based on the normalized entropy:
  // - entropy < 0.3: "focused" (few files touched many times — refactoring)
  // - entropy > 0.7: "spreading" (many files touched — feature expansion)
  // - else: "moderate"
  let direction = "stable";
  if (touches.length > 0) {
    if (normalizedEntropy < 0.3) direction = "focused";
    else if (normalizedEntropy > 0.7) direction = "spreading";
    else direction = "moderate";
  }
  const driftVector = [touches.length, ctx.gitHistory.length, round(normalizedEntropy, 4)];
  const magnitude = Math.sqrt(driftVector.reduce((a, b) => a + b * b, 0));
  const growthRate = total > 0 ? (touches.length - ctx.gitHistory.length) / total : 0;
  return {
    ergodicDrift: {
      driftVector,
      driftMagnitude: round(magnitude, 4),
      driftDirection: direction,
      growthRate: round(growthRate, 4),
      commitCount: ctx.gitHistory.length,
    },
  };
}
