/**
 * EXP462 information-theory signals (8 signals).
 *
 * Source: EXP387 (14 math signals already in the engine) + EXP462 new
 * information-theory formulas. Each signal is O(n) on the token stream.
 * - Kolmogorov complexity: K(x) ≈ |compressed| / |x| via a simple
 * RLE + frequency-coding proxy (no zlib to avoid a dependency).
 * - Rényi entropy: H_α = (1/(1-α)) log Σ p_i^α, for α = 2 (default).
 * - Tsallis entropy: S_q = (1 - Σ p_i^q) / (q - 1), for q = 2 (default).
 * - KL divergence: D(P||Q) = Σ p_i log(p_i / q_i) — drift between two
 * token-frequency distributions (first vs second half of the file set).
 * - JS divergence: symmetric square root of KL(P||M) + KL(Q||M).
 * - Fisher information: I = Σ (d/dθ log p)^2 — sensitivity proxy via
 * the variance of the log-frequency.
 * - Mutual information: MI(X;Y) = Σ p_xy log(p_xy / p_x p_y) — module
 * correlation via shared token overlap.
 * - Hartley entropy: H_0 = log2(|alphabet|).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

/** Build a token-frequency map from the whole codebase. */
function tokenFreq(ctx: SignalContext): Map<string, number> {
  const freq = new Map<string, number>();
  for (const fa of ctx.fileAnalyses) {
    for (const t of fa.tokenStream) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return freq;
}

/** Shannon entropy in bits. */
function shannon(freq: Map<string, number>, total: number): number {
  if (total === 0) return 0;
  let h = 0;
  for (const c of freq.values()) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

export function computeKolmogorovComplexity(ctx: SignalContext) {
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (fns.length === 0) return { kolmogorovComplexity: { meanK: 0, minK: 0, maxK: 0, compressibility: 0 } };
  // K(x) ≈ compressibility proxy: ratio of distinct tokens to total tokens.
  // Lower ratio = more compressible = lower K.
  const ks = fns.map(f => {
    const total = f.tokens.length;
    if (total === 0) return 1;
    const distinct = new Set(f.tokens).size;
    return round(distinct / total, 4);
  });
  const mean = round(ks.reduce((a, b) => a + b, 0) / ks.length, 4);
  return {
    kolmogorovComplexity: {
      meanK: mean,
      minK: round(Math.min(...ks), 4),
      maxK: round(Math.max(...ks), 4),
      compressibility: round(1 - mean, 4),
    },
  };
}

export function computeRenyiEntropy(ctx: SignalContext) {
  const freq = tokenFreq(ctx);
  const total = [...freq.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { renyiEntropy: { order: 2, entropy: 0, hartleyEntropy: 0, shannonEntropy: 0, minEntropy: 0 } };
  const order = 2; // default α=2 (collision entropy)
  let sumPq = 0;
  for (const c of freq.values()) {
    const p = c / total;
    sumPq += p ** order;
  }
  const renyi = round((1 / (1 - order)) * Math.log2(sumPq || 1), 4);
  const shannonH = round(shannon(freq, total), 4);
  const minEnt = round(-Math.log2(Math.max(...[...freq.values()].map(c => c / total))), 4);
  const hartley = round(Math.log2(freq.size), 4);
  return { renyiEntropy: { order, entropy: renyi, hartleyEntropy: hartley, shannonEntropy: shannonH, minEntropy: minEnt } };
}

export function computeTsallisEntropy(ctx: SignalContext) {
  const freq = tokenFreq(ctx);
  const total = [...freq.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { tsallisEntropy: { q: 2, entropy: 0, effectiveStates: 0 } };
  const q = 2; // default q=2
  let sumPq = 0;
  for (const c of freq.values()) {
    const p = c / total;
    sumPq += p ** q;
  }
  const tsallis = round((1 - sumPq) / (q - 1), 4);
  const effective = round(Math.exp(tsallis), 4);
  return { tsallisEntropy: { q, entropy: tsallis, effectiveStates: effective } };
}

export function computeKlDivergence(ctx: SignalContext) {
  const fas = ctx.fileAnalyses;
  if (fas.length < 2) return { klDivergence: { divergence: 0, isSignificant: false, sampleSize: 0 } };
  const half = Math.floor(fas.length / 2);
  const freqP = new Map<string, number>();
  const freqQ = new Map<string, number>();
  for (let i = 0; i < half; i++) for (const t of fas[i]!.tokenStream) freqP.set(t, (freqP.get(t) ?? 0) + 1);
  for (let i = half; i < fas.length; i++) for (const t of fas[i]!.tokenStream) freqQ.set(t, (freqQ.get(t) ?? 0) + 1);
  const totalP = [...freqP.values()].reduce((a, b) => a + b, 0) || 1;
  const totalQ = [...freqQ.values()].reduce((a, b) => a + b, 0) || 1;
  let kl = 0;
  for (const [t, c] of freqP) {
    const p = c / totalP;
    const q = (freqQ.get(t) ?? 0.5) / totalQ; // Laplace smoothing
    kl += p * Math.log2(p / q);
  }
  return { klDivergence: { divergence: round(kl, 4), isSignificant: kl > 0.5, sampleSize: fas.length } };
}

export function computeJsDivergence(ctx: SignalContext) {
  const fas = ctx.fileAnalyses;
  if (fas.length < 2) return { jsDivergence: { divergence: 0, similarity: 1, squareRoot: 0 } };
  const half = Math.floor(fas.length / 2);
  const freqP = new Map<string, number>();
  const freqQ = new Map<string, number>();
  for (let i = 0; i < half; i++) for (const t of fas[i]!.tokenStream) freqP.set(t, (freqP.get(t) ?? 0) + 1);
  for (let i = half; i < fas.length; i++) for (const t of fas[i]!.tokenStream) freqQ.set(t, (freqQ.get(t) ?? 0) + 1);
  const totalP = [...freqP.values()].reduce((a, b) => a + b, 0) || 1;
  const totalQ = [...freqQ.values()].reduce((a, b) => a + b, 0) || 1;
  // JS = (KL(P||M) + KL(Q||M)) / 2 where M = (P+Q)/2.
  const allKeys = new Set([...freqP.keys(), ...freqQ.keys()]);
  let js = 0;
  for (const k of allKeys) {
    const p = (freqP.get(k) ?? 0) / totalP;
    const q = (freqQ.get(k) ?? 0) / totalQ;
    const m = (p + q) / 2;
    if (m === 0) continue;
    if (p > 0) js += 0.5 * p * Math.log2(p / m);
    if (q > 0) js += 0.5 * q * Math.log2(q / m);
  }
  return { jsDivergence: { divergence: round(js, 4), similarity: round(1 - js / Math.log2(2), 4), squareRoot: round(Math.sqrt(js), 4) } };
}

export function computeFisherInformation(ctx: SignalContext) {
  const freq = tokenFreq(ctx);
  const total = [...freq.values()].reduce((a, b) => a + b, 0) || 1;
  // Fisher info ≈ Σ (d/dp log p)^2 = Σ (1/p)^2 × var(p) ≈ Σ 1/p for a
  // multinomial. We use the diagonal approximation: I = Σ 1/p_i.
  let fisher = 0;
  for (const c of freq.values()) {
    const p = c / total;
    if (p > 0) fisher += 1 / p;
  }
  return { fisherInformation: { meanFisher: round(fisher / freq.size, 4), maxFisher: round(Math.max(...[...freq.values()].map(c => 1 / (c / total || 1))), 4), totalInformation: round(fisher, 4) } };
}

export function computeMutualInformation(ctx: SignalContext) {
  // MI between modules: for each pair of modules that share tokens, compute
  // MI(token ∈ A, token ∈ B) ≈ shared / total × log(shared / (pA × pB)).
  // O(n²) on modules — bounded by the module count.
  const modules = ctx.modules.slice(0, 50); // cap for tractability
  const modTokens = new Map<string, Set<string>>();
  for (const fa of ctx.fileAnalyses) {
    const mod = fa.filePath.split("/").slice(0, -1).join("/") || ".";
    if (!modTokens.has(mod)) modTokens.set(mod, new Set());
    for (const t of fa.tokenStream) modTokens.get(mod)!.add(t);
  }
  const totalTokens = [...modTokens.values()].reduce((s, ts) => s + ts.size, 0) || 1;
  let coupled = 0, total = 0;
  let maxMI = 0, sumMI = 0;
  for (let i = 0; i < modules.length; i++) {
    const ti = modTokens.get(modules[i]!.path);
    if (!ti) continue;
    for (let j = i + 1; j < modules.length; j++) {
      const tj = modTokens.get(modules[j]!.path);
      if (!tj) continue;
      total += 1;
      let shared = 0;
      for (const t of ti) if (tj.has(t)) shared += 1;
      if (shared === 0) continue;
      const pA = ti.size / totalTokens, pB = tj.size / totalTokens;
      const pAB = shared / totalTokens;
      const mi = pAB * Math.log2(pAB / (pA * pB || 1));
      if (mi > 0.01) coupled += 1;
      if (mi > maxMI) maxMI = mi;
      sumMI += mi;
    }
  }
  return { mutualInformation: { meanMI: round(total > 0 ? sumMI / total : 0, 4), maxMI: round(maxMI, 4), coupledPairs: coupled, totalPairs: total } };
}

export function computeHartleyEntropy(ctx: SignalContext) {
  const freq = tokenFreq(ctx);
  const total = [...freq.values()].reduce((a, b) => a + b, 0);
  return { hartleyEntropy: { entropy: round(Math.log2(freq.size || 1), 4), alphabetSize: freq.size, tokenCount: total } };
}
