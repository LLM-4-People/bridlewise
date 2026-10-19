/**
 * Quantum error correction (QEC) code distance (EXP346).
 *
 * EXP346 found that the codebase's clone redundancy provides a dual
 * protection: well-protected "logical states" (code distance d ≥ 20)
 * vs a fragile d=1 tail. The code distance of a clone family is the
 * minimum number of functions that must change to break the family's
 * redundancy — for our Union-Find family, this is the family size
 * minus 1 (the number of redundant copies).
 *
 * The signal emits:
 * - meanDistance: mean code distance across families.
 * - maxDistance: the most well-protected family's distance.
 * - fragileCount: families with d=1 (single-copy, no redundancy).
 * - protectedCount: families with d ≥ protectedThreshold (default 5).
 * - protectionRatio: protectedCount / totalFamilies.
 */
import type { SignalContext } from "../types.ts";
import { buildCloneGraph } from "./clone-graph.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeQecDistance(ctx: SignalContext) {
  const graph = buildCloneGraph(ctx);
  if (graph.families.length === 0) {
    return { qecDistance: { meanDistance: 0, maxDistance: 0, fragileCount: 0, protectedCount: 0, protectionRatio: 0, familyCount: 0 } };
  }
  const distances = graph.families.map(f => Math.max(1, f.members.length - 1));
  let sum = 0;
  let max = 0;
  let fragile = 0;
  let protected_ = 0;
  const protectedThreshold = ctx.config.thresholds.qecProtectedDistance;
  for (const d of distances) {
    sum += d;
    if (d > max) max = d;
    if (d === 1) fragile += 1;
    if (d >= protectedThreshold) protected_ += 1;
  }
  const mean = sum / distances.length;
  return {
    qecDistance: {
      meanDistance: round(mean, 2),
      maxDistance: max,
      fragileCount: fragile,
      protectedCount: protected_,
      protectionRatio: round(protected_ / graph.families.length, 4),
      familyCount: graph.families.length,
    },
  };
}
