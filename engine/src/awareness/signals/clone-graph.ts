/**
 * Shared clone-graph builder — used by `clones.ts` and the novel-clone
 * signals (Bell, Banach, QEC, AG-spectrum). Computes k-shingles for each
 * function body and Union-Find families, exposing both the Jaccard
 * pair scores and the family partitions.
 *
 * Centralizing this avoids re-shingling the codebase 4× for 4 separate
 * clone-family consumers. The function bodies are already tokenized by
 * the language adapter; we just shingle + bucket + Union-Find here.
 */
import type { SignalContext, FunctionRecord } from "../types.ts";
import { shingleArray, jaccardOf, extractCloneCandidates, buildCloneFamilies } from "../clone-helpers.ts";

export interface CloneFunction {
  filePath: string;
  name: string;
  tokens: readonly string[];
  bodyChars: number;
}

export interface ClonePair {
  a: number;
  b: number;
  jaccard: number;
}

export interface CloneFamily {
  /** Indices into the `functions` array. */
  members: number[];
  /** Average pairwise Jaccard within the family. */
  avgJaccard: number;
  /** Minimum pairwise Jaccard (the "weakest link"). */
  minJaccard: number;
}

export interface CloneGraph {
  functions: CloneFunction[];
  pairs: ClonePair[];
  families: CloneFamily[];
  /** Per-function family id (or -1 if not in any family). */
  familyOf: Int32Array;
  /** Family sizes (length = number of families). */
  familySizes: Int32Array;
}

/** Build the clone graph: shingle each function, bucket by shared shingle,
 * compute Jaccard for candidate pairs, and Union-Find the families. */
export function buildCloneGraph(ctx: SignalContext): CloneGraph {
  const minBody = ctx.config.thresholds.cloneMinBodySize;
  const minTokens = ctx.config.thresholds.cloneMinTokens;
  const threshold = ctx.config.thresholds.cloneJaccardThreshold;
  const k = ctx.config.thresholds.cloneShingleK;
  const bucketCap = ctx.config.thresholds.cloneBucketCap;

  const functions: CloneFunction[] = ctx.fileAnalyses.flatMap(fa => extractCloneCandidates(fa, minBody, minTokens));
  if (functions.length < 2) {
    return { functions, pairs: [], families: [], familyOf: new Int32Array(0), familySizes: new Int32Array(0) };
  }

  const { pairs: clonePairs, familyOf: ufFamilyOf } = buildCloneFamilies(functions, { k, bucketCap, threshold });
  const pairs: ClonePair[] = clonePairs;

  // Build families.
  const familiesMap = new Map<number, number[]>();
  for (let i = 0; i < functions.length; i += 1) {
    const r = ufFamilyOf[i]!;
    if (!familiesMap.has(r)) familiesMap.set(r, []);
    familiesMap.get(r)!.push(i);
  }
  const familyOf = new Int32Array(functions.length).fill(-1);
  const shinglesByFn: string[][] = functions.map(f => shingleArray(f.tokens, k));
  const families: CloneFamily[] = [];
  let famIdx = 0;
  for (const idxs of familiesMap.values()) {
    if (idxs.length > 1) {
      for (const i of idxs) familyOf[i] = famIdx;
      const sample = idxs.slice(0, 20);
      let sum = 0; let count = 0; let min = 1;
      for (let i = 0; i < sample.length; i += 1) {
        for (let j = i + 1; j < sample.length; j += 1) {
          const jacc = jaccardOf(shinglesByFn[sample[i]!]!, shinglesByFn[sample[j]!]!);
          sum += jacc; count += 1;
          if (jacc < min) min = jacc;
        }
      }
      families.push({ members: idxs, avgJaccard: count > 0 ? sum / count : 1, minJaccard: min });
      famIdx += 1;
    }
  }
  const familySizes = Int32Array.from(families, f => f.members.length);
  return { functions, pairs, families, familyOf, familySizes };
}

/** Generate k-shingles. */

/** Suppress unused re-export warning. */
export type { FunctionRecord };
