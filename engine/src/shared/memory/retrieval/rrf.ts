// src/shared/memory/retrieval/rrf.ts
// Reciprocal Rank Fusion. Single owner (was duplicated in
// tool-result-retrieval.ts). Research: RRF k=60 is the literature standard
// (Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet...",
// SIGIR 2009). k is configurable via RetrievalConfig (no static constant).

import type { RankHit } from "./types.ts";
import { InputError } from "../../../kernel/errors.ts";

export function reciprocalRankFusion(
  rankings: readonly (readonly RankHit[])[],
  k: number,
): readonly RankHit[] {
  if (k < 1 || !Number.isFinite(k)) {
    throw new InputError(
      "rrf: k must be a positive finite number",
      "shared_memory_rrf_invalid_k",
    );
  }
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank += 1) {
      const entry = ranking[rank];
      if (!entry) continue;
      const contribution = 1 / (k + rank + 1);
      scores.set(entry.docIndex, (scores.get(entry.docIndex) ?? 0) + contribution);
    }
  }
  const fused = [...scores.entries()].map(([docIndex, score]) => ({ docIndex, score }));
  fused.sort((a, b) => b.score - a.score);
  return fused;
}
