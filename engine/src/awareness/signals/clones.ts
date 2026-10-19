/**
 * Clones signal: Jaccard-shingle clone family count, clone coverage,
 * and top families.
 *
 * Reuses the EXP335 / EXP340 approach: shingle each function body (k=
 * `cloneShingleK`), bucket by shingle, compute Jaccard only for pairs
 * sharing a shingle. Union-Find builds clone families.
 *
 * EXP340 (Bell): 12-13% of clones are "isolated" (no common witness —
 * pure copy-paste). EXP345 (wavelet): F1=0.877, training-free. We use
 * the Jaccard baseline — it is the simplest training-free detector.
 */
import type { SignalContext, FunctionRecord } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";
import { shingleArray, jaccardOf, extractCloneCandidates, buildCloneFamilies } from "../clone-helpers.ts";

type Fn = { filePath: string; name: string; tokens: readonly string[]; bodyChars: number };

export function computeClones(ctx: SignalContext) {
  const minBody = ctx.config.thresholds.cloneMinBodySize;
  const minTokens = ctx.config.thresholds.cloneMinTokens;
  const threshold = ctx.config.thresholds.cloneJaccardThreshold;
  const k = ctx.config.thresholds.cloneShingleK;
  const bucketCap = ctx.config.thresholds.cloneBucketCap;

  const allFns: Fn[] = ctx.fileAnalyses.flatMap(fa => extractCloneCandidates(fa, minBody, minTokens));
  if (allFns.length < 2) {
    return { clones: { familyCount: 0, cloneCoverage: 0, topFamilies: [] } };
  }

  const { familyOf } = buildCloneFamilies(allFns, { k, bucketCap, threshold });
  // Build families.
  const families = new Map<number, number[]>();
  for (let i = 0; i < allFns.length; i += 1) {
    const r = familyOf[i]!;
    if (!families.has(r)) families.set(r, []);
    families.get(r)!.push(i);
  }
  // Only families with > 1 member are clones.
  const shinglesByFn: string[][] = allFns.map(f => shingleArray(f.tokens, k));
  let familyCount = 0;
  let clonedFunctions = 0;
  const familyList: Array<{ representative: string; members: number; avgJaccard: number }> = [];
  for (const idxs of families.values()) {
    if (idxs.length > 1) {
      familyCount += 1;
      clonedFunctions += idxs.length;
      // Representative = first member's name.
      const rep = allFns[idxs[0]!]!;
      // Compute avg Jaccard among family members (sample up to 10).
      const sample = idxs.slice(0, 10);
      let sum = 0; let count = 0;
      for (let i = 0; i < sample.length; i += 1) {
        for (let j = i + 1; j < sample.length; j += 1) {
          sum += jaccardOf(shinglesByFn[sample[i]!]!, shinglesByFn[sample[j]!]!);
          count += 1;
        }
      }
      const avg = count > 0 ? sum / count : 1;
      familyList.push({ representative: `${rep.filePath}:${rep.name}`, members: idxs.length, avgJaccard: round(avg, 3) });
    }
  }
  familyList.sort((a, b) => b.members - a.members);
  const topFamilies = familyList.slice(0, ctx.config.topN.topCloneFamilies);
  const cloneCoverage = allFns.length > 0 ? clonedFunctions / allFns.length : 0;
  return {
    clones: {
      familyCount,
      cloneCoverage: round(cloneCoverage, 4),
      topFamilies,
    },
  };
}

/** Generate k-shingles from a token list. */

// Suppress unused warning for FunctionRecord re-export.
export type { FunctionRecord };
