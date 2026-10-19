/**
 * Fiber-bundle non-triviality (EXP321).
 *
 * EXP321 found that the codebase's "fiber bundle" structure is non-trivial
 * — the local "fibers" (per-module function token distributions) are not
 * all isomorphic; there are non-trivial transition functions between
 * modules. For the awareness signal, we approximate the fiber bundle by
 * taking each module as the "base" and the function-token distribution as
 * the "fiber". A bundle is trivial if all fibers are isomorphic (the
 * same token distribution); non-trivial if the fibers differ.
 *
 * We compute the Jensen-Shannon divergence between each module's token
 * distribution and the global distribution. The signal emits:
 * - nonTrivial: true if mean divergence > 0 (any variation).
 * - meanDivergence: average JS divergence (information-theoretic).
 * - maxDivergence: the module whose fiber is most distinct.
 * - topDistinctModule: name of the most-distinct module.
 * - moduleCount: number of modules in the bundle.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";
import { moduleOf } from "../module-helpers.ts";

export function computeFiberBundle(ctx: SignalContext) {
  const moduleTokens = new Map<string, Map<string, number>>();
  for (const fa of ctx.fileAnalyses) {
    const mod = moduleOf(fa.filePath, ctx);
    if (!moduleTokens.has(mod)) moduleTokens.set(mod, new Map());
    const dst = moduleTokens.get(mod)!;
    for (const t of fa.tokenStream) {
      dst.set(t, (dst.get(t) ?? 0) + 1);
    }
  }
  if (moduleTokens.size < 2) {
    return { fiberBundle: { nonTrivial: false, meanDivergence: 0, maxDivergence: 0, topDistinctModule: "", moduleCount: moduleTokens.size } };
  }
  // Global distribution.
  const global = new Map<string, number>();
  let totalGlobal = 0;
  for (const dst of moduleTokens.values()) {
    for (const [t, c] of dst) {
      global.set(t, (global.get(t) ?? 0) + c);
      totalGlobal += c;
    }
  }
  if (totalGlobal === 0) {
    return { fiberBundle: { nonTrivial: false, meanDivergence: 0, maxDivergence: 0, topDistinctModule: "", moduleCount: moduleTokens.size } };
  }
  // JS divergence of each module vs global.
  let sum = 0;
  let max = 0;
  let topModule = "";
  for (const [mod, dst] of moduleTokens) {
    let moduleTotal = 0;
    for (const c of dst.values()) moduleTotal += c;
    if (moduleTotal === 0) continue;
    const divergence = jsDivergence(dst, moduleTotal, global, totalGlobal);
    sum += divergence;
    if (divergence > max) { max = divergence; topModule = mod; }
  }
  const mean = sum / moduleTokens.size;
  return {
    fiberBundle: {
      nonTrivial: mean > 0.001,
      meanDivergence: round(mean, 4),
      maxDivergence: round(max, 4),
      topDistinctModule: topModule,
      moduleCount: moduleTokens.size,
    },
  };
}

function jsDivergence(p: Map<string, number>, pTotal: number, q: Map<string, number>, qTotal: number): number {
  // Symmetric JS divergence = (KL(p||m) + KL(q||m)) / 2, m = (p+q)/2.
  // p, q are unnormalized counts.
  let result = 0;
  const keys = new Set<string>();
  for (const k of p.keys()) keys.add(k);
  for (const k of q.keys()) keys.add(k);
  for (const k of keys) {
    const pProb = (p.get(k) ?? 0) / pTotal;
    const qProb = (q.get(k) ?? 0) / qTotal;
    const m = (pProb + qProb) / 2;
    if (m === 0) continue;
    if (pProb > 0) result += 0.5 * pProb * Math.log2(pProb / m);
    if (qProb > 0) result += 0.5 * qProb * Math.log2(qProb / m);
  }
  return result;
}
