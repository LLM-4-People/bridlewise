import { shinglesArray, jaccardArrays } from "../shared/similarity.ts";

/**
 * Build the array of k-shingles from a token array.
 *
 * delegates to the canonical `shinglesArray` owner in
 * `src/shared/similarity.ts` (was a private near-duplicate body — "No
 * Scattered Helpers" violation). The `\u0001` separator is preserved so
 * existing clone-helpers consumers see byte-identical shingles.
 */
export function shingleArray(tokens: readonly string[], k: number): string[] {
  return shinglesArray(tokens, k, "\u0001");
}

/**
 * Jaccard similarity between two arrays of tokens.
 *
 * delegates to the canonical `jaccardArrays` owner in
 * `src/shared/similarity.ts` (was a private near-duplicate body — "No
 * Scattered Helpers" violation). The shared owner has the same
 * conservative empty-set policy (returns 0 when either array is empty).
 */
export function jaccardOf(a: readonly string[], b: readonly string[]): number {
  return jaccardArrays(a, b);
}

export function createUnionFind(n: number): {
  parent: Int32Array;
  find: (i: number) => number;
  union: (a: number, b: number) => void;
} {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let cur = i;
    while (parent[cur] !== cur) {
      const up = parent[cur]!;
      const next = parent[up] ?? up;
      parent[cur] = next;
      cur = next;
    }
    return cur;
  };
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  return { parent, find, union };
}

export function extractCloneCandidates<T extends { functions: readonly { filePath: string; name: string; tokens: readonly string[]; bodyChars: number }[] }>(
  fa: T,
  minBody: number,
  minTokens: number,
): Array<{ filePath: string; name: string; tokens: readonly string[]; bodyChars: number }> {
  return fa.functions
    .filter(f => f.bodyChars >= minBody && f.tokens.length >= minTokens)
    .map(f => ({ filePath: f.filePath, name: f.name, tokens: f.tokens, bodyChars: f.bodyChars }));
}

export interface CloneFamilyResult {
  pairs: Array<{ a: number; b: number; jaccard: number }>;
  familyOf: Int32Array;
  familyCount: number;
}

export function buildCloneFamilies(
  fns: readonly { tokens: readonly string[] }[],
  opts: { k: number; bucketCap: number; threshold: number },
): CloneFamilyResult {
  const shinglesByFn: string[][] = fns.map(f => shingleArray(f.tokens, opts.k));
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < shinglesByFn.length; i += 1) {
    const seen = new Set<string>();
    for (const s of shinglesByFn[i]!) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (!buckets.has(s)) buckets.set(s, []);
      buckets.get(s)!.push(i);
    }
  }
  for (const [key, idxs] of buckets) {
    if (idxs.length > opts.bucketCap) buckets.delete(key);
  }
  const { find, union } = createUnionFind(fns.length);
  const pairs: Array<{ a: number; b: number; jaccard: number }> = [];
  const seenPairs = new Set<number>();
  for (const idxs of buckets.values()) {
    for (let i = 0; i < idxs.length; i += 1) {
      for (let j = i + 1; j < idxs.length; j += 1) {
        const a = idxs[i]!;
        const b = idxs[j]!;
        const key = a * fns.length + b;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const jac = jaccardOf(shinglesByFn[a]!, shinglesByFn[b]!);
        if (jac >= opts.threshold) {
          union(a, b);
          pairs.push({ a, b, jaccard: jac });
        }
      }
    }
  }
  const familyOf = new Int32Array(fns.length);
  const rootSet = new Set<number>();
  for (let i = 0; i < fns.length; i += 1) {
    const root = find(i);
    familyOf[i] = root;
    rootSet.add(root);
  }
  return { pairs, familyOf, familyCount: rootSet.size };
}
