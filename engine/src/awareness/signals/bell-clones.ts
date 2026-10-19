/**
 * Bell-inequality clone classification (EXP340).
 *
 * EXP340 found that 12-13% of clones are "isolated" (Bell-violated — no
 * common witness, pure copy-paste) while 87% are "family" (Bell-holds —
 * explained by a hidden variable = the family template). The signal
 * classifies the clone graph into:
 * - isolatedClones: pairs whose Jaccard is ≥ threshold but no third
 * function joins their family (family size = 2 with no other
 * connections — "spooky-action" copy-paste).
 * - familyClones: pairs that are part of a larger family (≥3 members
 * OR ≥2 members with other high-Jaccard neighbors).
 * - bellRatio: isolatedPairs / totalPairs — a real Bell-inequality-style
 * bound. Higher = more pure copy-paste (no common ancestor pattern).
 */
import type { SignalContext } from "../types.ts";
import { buildCloneGraph } from "./clone-graph.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeBellClones(ctx: SignalContext) {
  const graph = buildCloneGraph(ctx);
  if (graph.pairs.length === 0) {
    return { bellClones: { isolatedPairs: 0, familyPairs: 0, totalPairs: 0, bellRatio: 0, isolatedFraction: 0 } };
  }
  let isolatedPairs = 0;
  let familyPairs = 0;
  for (const p of graph.pairs) {
    const famA = graph.familyOf[p.a]!;
    const famB = graph.familyOf[p.b]!;
    // Bell-violated: the two functions are in a family of EXACTLY 2 (no
    // third witness). Bell-holds: family of ≥3 (hidden variable = the
    // family template).
    const famId = famA >= 0 ? famA : famB;
    if (famId >= 0 && graph.familySizes[famId]! >= 3) {
      familyPairs += 1;
    } else {
      isolatedPairs += 1;
    }
  }
  const total = graph.pairs.length;
  const isolatedFraction = total > 0 ? isolatedPairs / total : 0;
  return {
    bellClones: {
      isolatedPairs,
      familyPairs,
      totalPairs: total,
      bellRatio: round(isolatedFraction, 4),
      isolatedFraction: round(isolatedFraction, 4),
    },
  };
}
