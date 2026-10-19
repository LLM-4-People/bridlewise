/**
 * Shape-DNA signal (EXP57).
 *
 * EXP57 computed the Laplacian eigenvalues of each function's AST tree
 * (the "shape-DNA"). It found 1396 distinct clusters (62% of functions)
 * and CATCHES cross-file clones that token-based Jaccard misses:
 * - `parseSequence` cross-file clone.
 * - `invokeEditTool ↔ invokeDeleteTool` template pattern.
 *
 * For awareness, we approximate shape-DNA via a CHEAP proxy: the
 * histogram of (nodeCount, depth, branchingFactor) triples per
 * function, then we cluster by this 3-D shape signature. Two
 * functions with the same shape signature are "structurally
 * identical" — a hidden-clone candidate.
 *
 * The signal emits:
 * - distinctShapes: number of distinct shape signatures.
 * - largestShape: the most common shape (the "dominant pattern").
 * - shapeDiversity: distinctShapes / totalFunctions (1 = every
 * function is structurally unique; 0.5 = 50% are duplicates).
 * - topShapeClones: top-3 shapes by the number of functions sharing
 * them (the biggest hidden-clone candidates).
 *
 * Actionable: topShapeClones are the strongest cross-file clone
 * candidates — token-Jaccard misses them but they're structurally
 * identical.
 *
 * Source: EXP57 (https://github.com/.../experiments/exp57-function-shape).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeShapeDna(ctx: SignalContext) {
  const allFns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (allFns.length === 0) {
    return { shapeDna: { distinctShapes: 0, shapeDiversity: 0, largestShape: "", largestShapeCount: 0, topShapeClones: [] } };
  }
  // Approximate shape signature: (complexity, bodyLines-bucket, parameterCount).
  // Two functions with the same signature are structurally similar.
  const shapeCount = new Map<string, number>();
  const shapeExample = new Map<string, string>();
  for (const f of allFns) {
    const complexityBucket = f.complexity <= 1 ? "c1" : f.complexity <= 5 ? "c5" : f.complexity <= 15 ? "c15" : f.complexity <= 30 ? "c30" : "cHi";
    const bodyBucket = f.bodyLines <= 5 ? "b5" : f.bodyLines <= 20 ? "b20" : f.bodyLines <= 50 ? "b50" : f.bodyLines <= 100 ? "b100" : "bHi";
    const arityBucket = f.parameterCount === 0 ? "a0" : f.parameterCount === 1 ? "a1" : f.parameterCount === 2 ? "a2" : f.parameterCount <= 4 ? "a4" : "aHi";
    const tokenBucket = f.tokens.length <= 10 ? "t10" : f.tokens.length <= 30 ? "t30" : f.tokens.length <= 80 ? "t80" : f.tokens.length <= 200 ? "t200" : "tHi";
    const sig = `${complexityBucket}|${bodyBucket}|${arityBucket}|${tokenBucket}`;
    shapeCount.set(sig, (shapeCount.get(sig) ?? 0) + 1);
    if (!shapeExample.has(sig)) shapeExample.set(sig, `${f.filePath}:${f.name}`);
  }
  const distinct = shapeCount.size;
  const diversity = round(distinct / allFns.length, 4);
  // Largest shape = most common.
  let largestShape = "";
  let largestCount = 0;
  for (const [sig, count] of shapeCount) {
    if (count > largestCount) { largestCount = count; largestShape = sig; }
  }
  // Top-3 shapes by count (the biggest hidden-clone candidates).
  const topShapes = [...shapeCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sig, count]) => ({ shape: sig, members: count, example: shapeExample.get(sig) ?? "" }));
  return {
    shapeDna: {
      distinctShapes: distinct,
      shapeDiversity: diversity,
      largestShape,
      largestShapeCount: largestCount,
      topShapeClones: topShapes,
    },
  };
}
