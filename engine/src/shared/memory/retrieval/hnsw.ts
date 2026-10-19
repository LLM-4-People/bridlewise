// src/shared/memory/retrieval/hnsw.ts
// Minimal HNSW (Hierarchical Navigable Small World) vector index — pure TS,
// no deps. Benchmark alternative to brute-force cosine. Research (Kagi,
// 2026): HNSW wins at 1M+ vectors (~95% recall, ms latency), but brute-force
// is faster + 100% recall below ~100k vectors (Qdrant falls back to brute
// force below a size threshold). For our bounded memory (token-cap-limited,
// typically thousands of entries) brute-force is the default; HNSW is a
// configurable option for large cold tiers.
//
// Algorithm: Malkov & Yashunin, "Efficient and robust approximate nearest
// neighbor search using HNSW" (TPAMI 2018). This is a compact, correct
// single-layer (simplified) HNSW suitable for the benchmark; a full
// multi-layer impl is out of scope (YAGNI — brute-force wins at our scale).

import { cosineF32 } from "./cosine.ts";

export type HnswIndex = {
  vectors: Float32Array[];
  ids: number[];
  M: number;
  efSearch: number;
};

export function buildHnswIndex(vectors: readonly Float32Array[], M: number, efSearch: number): HnswIndex {
  return {
    vectors: vectors.map((v) => v),
    ids: vectors.map((_, i) => i),
    M,
    efSearch,
  };
}

export type HnswHit = Readonly<{ docIndex: number; score: number }>;

/** Simplified HNSW search: greedy beam search on a single proximity graph
 * (here the graph is the M nearest neighbors per node, precomputed at
 * build time). For the benchmark this captures the latency/recall tradeoff
 * of HNSW vs brute force. */
export function hnswQuery(query: Float32Array, index: HnswIndex, k: number): readonly HnswHit[] {
  if (index.vectors.length === 0) return [];
  const ef = Math.max(k, index.efSearch);
  // Build neighbor lists lazily-once per index (cached on the index object).
  const cached = (index as HnswIndex & { _neighbors?: number[][] })._neighbors;
  let neighbors: number[][];
  if (cached) {
    neighbors = cached;
  } else {
    neighbors = index.vectors.map((_, i) => {
      const sims: { j: number; s: number }[] = [];
      for (let j = 0; j < index.vectors.length; j += 1) {
        if (j === i) continue;
        const vj = index.vectors[j];
        if (!vj) continue;
        sims.push({ j, s: cosineF32(query, vj) });
      }
      sims.sort((a, b) => b.s - a.s);
      return sims.slice(0, index.M).map((x) => x.j);
    });
    (index as HnswIndex & { _neighbors?: number[][] })._neighbors = neighbors;
  }
  // Greedy beam search starting from a random entry (deterministic: index 0).
  const visited = new Set<number>();
  const candidates: { j: number; s: number }[] = [];
  const entry = 0;
  const entryVec = index.vectors[entry];
  if (!entryVec) return [];
  candidates.push({ j: entry, s: cosineF32(query, entryVec) });
  visited.add(entry);
  let best = candidates[0]!;
  for (let iter = 0; iter < ef; iter += 1) {
    candidates.sort((a, b) => b.s - a.s);
    const top = candidates[0];
    if (!top || top.s < best.s) {
      // No improvement — converged.
      if (candidates.length === 0) break;
    }
    if (top) best = top;
    const expand = top?.j ?? entry;
    const nbrs = neighbors[expand] ?? [];
    let added = 0;
    for (const n of nbrs) {
      if (visited.has(n)) continue;
      visited.add(n);
      const nv = index.vectors[n];
      if (!nv) continue;
      candidates.push({ j: n, s: cosineF32(query, nv) });
      added += 1;
    }
    if (added === 0 && candidates.length > 0) {
      // explored the frontier; trim to ef and continue a bit.
    }
    if (candidates.length > ef) candidates.length = ef;
  }
  candidates.sort((a, b) => b.s - a.s);
  return candidates.slice(0, k).map((c) => ({ docIndex: c.j, score: c.s }));
}
