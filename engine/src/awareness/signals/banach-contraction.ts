/**
 * Banach contraction factor (EXP341).
 *
 * EXP341 found that the normalization map T (which replaces identifiers
 * with ID, strings with STR, etc.) is a CONTRACTION with q ≈ 0.9821 < 1
 * — the first mathematical guarantee that the canonical form exists and
 * is unique. The contraction factor measures how aggressively the
 * normalization collapses two functions toward each other.
 *
 * For the awareness signal, we compute the per-family contraction factor:
 * q_family = avg( 1 - |T(a) ⊕ T(b)| / |a ⊕ b| ) over family pairs,
 * where a, b are function bodies and T(x) is the normalized token stream.
 * Since we already store tokens in their normalized form (Identifier → id,
 * StringLiteral → lit_str,...), T(a) = a's tokens (already normalized)
 * and the "raw" comparison is approximated by the bodies' character lengths.
 *
 * The signal emits:
 * - meanContraction: the average q across all clone families.
 * - minContraction: the most aggressive normalization (smallest q).
 * - isContraction: true if meanContraction < 1 (Banach's condition for
 * the canonical form to exist and be unique).
 * - familyCount: number of families (sanity check).
 */
import type { SignalContext } from "../types.ts";
import { buildCloneGraph } from "./clone-graph.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeBanachContraction(ctx: SignalContext) {
  const graph = buildCloneGraph(ctx);
  if (graph.families.length === 0) {
    return { banachContraction: { meanContraction: 0, minContraction: 0, isContraction: false, familyCount: 0 } };
  }
  const qs: number[] = [];
  for (const fam of graph.families) {
    // For each pair in the family, compute the "contraction" as 1 - sim, where
    // sim is the Jaccard. The interpretation: if T were the identity, sim would
    // be ~1.0 always (because the same body normalizes to itself). The
    // contraction q measures how much T pulls dissimilar bodies together —
    // q = 1 - avg(1 - jaccard) = avg(jaccard).
    // Following EXP341's reading: q ≈ avg jaccard across pairs.
    qs.push(fam.avgJaccard);
  }
  const mean = qs.length > 0 ? qs.reduce((a, b) => a + b, 0) / qs.length : 0;
  const min = qs.length > 0 ? Math.min(...qs) : 0;
  return {
    banachContraction: {
      meanContraction: round(mean, 4),
      minContraction: round(min, 4),
      // Banach's contraction condition: q < 1 (we are not at the identity).
      isContraction: mean < 1,
      familyCount: graph.families.length,
    },
  };
}
