/**
 * Entropy signal: Shannon entropy of the token-stream distribution,
 * plus a Rényi entropy spectrum at multiple orders.
 *
 * EXP343 found the 5D Rényi spectrum REDISCOVERS known function families
 * in O(N) without pairwise Jaccard. Here we use it as a codebase
 * fingerprint: codebases with similar shape (lots of boilerplate) have
 * LOW entropy; codebases with diverse vocabulary have HIGH entropy.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeEntropy(ctx: SignalContext) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const fa of ctx.fileAnalyses) {
    for (const t of fa.tokenStream) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
      total += 1;
    }
  }
  if (total === 0) {
    return { entropy: { shannon: 0, renyiSpectrum: [], tokenCount: 0 } };
  }
  // Shannon: -sum p log2 p.
  let shannon = 0;
  for (const c of counts.values()) {
    const p = c / total;
    shannon -= p * Math.log2(p);
  }
  // Rényi entropy of order α: (1/(1-α)) log2(sum p^α).
  const orders = pickRenyiOrders(ctx);
  const renyiSpectrum = orders.map(order => {
    if (Math.abs(order - 1) < 1e-9) return { order, entropy: round(shannon, 4) };
    let sum = 0;
    for (const c of counts.values()) {
      const p = c / total;
      sum += Math.pow(p, order);
    }
    const h = (1 / (1 - order)) * Math.log2(sum);
    return { order, entropy: round(h, 4) };
  });
  return {
    entropy: {
      shannon: round(shannon, 4),
      renyiSpectrum: renyiSpectrum as readonly Readonly<{ order: number; entropy: number }>[],
      tokenCount: total,
    },
  };
}

function pickRenyiOrders(ctx: SignalContext): number[] {
  // Default: [0, 0.5, 1, 2, ∞]. Cap the count at config.topN.topRenyiOrders.
  const all = [0, 0.5, 1, 2, 4];
  const n = Math.min(ctx.config.topN.topRenyiOrders, all.length);
  return all.slice(0, n);
}
