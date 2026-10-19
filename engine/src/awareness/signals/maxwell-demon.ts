/**
 * Maxwell's-demon information-flow signal (EXP307 + EXP324).
 *
 * EXP307 modeled the harness's CUSUM gate as a Maxwell's demon: the
 * demon's benefit is 123.50 nats (information gained by reading the
 * CUSUM signal) vs Landauer cost 15.25 nats (the energy cost of
 * erasing the signal) = 8.1× NET POSITIVE — the demon is
 * thermodynamically valid. EXP324 measured each signal's Fisher
 * information (the Cramér-Rao inverse): Jaccard 1-NN MI=9.79 bits,
 * Complexity Fisher=767 (most sensitive), PageRank Fisher=2.3 (least).
 *
 * For awareness, this signal estimates the INFORMATION FLOW EFFICIENCY
 * of the codebase's import graph: how much "information" (entropy
 * reduction) does each module provide to its importers?
 *
 * Approximation: for each module, the demon's benefit = entropy of the
 * module's vocabulary × (in-degree / total-modules). The Landauer cost
 * is the bit-cost of the module's tokens. Net = benefit − cost.
 *
 * The signal emits:
 * - meanDemonEfficiency: average (benefit/cost) ratio across modules.
 * - isThermodynamicallyValid: true if meanDemonEfficiency > 1.
 * - topDemon: the module with the highest demon efficiency (it's the
 * most informative hub — reading it saves more than it costs).
 * - totalInformationGain: sum of (benefit − cost) across modules.
 *
 * Actionable: a topDemon with high efficiency is the highest-priority
 * module to keep well-documented (it pays back the most per read).
 *
 * Source: EXP307, EXP324.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";
import { moduleOfPath } from "../module-helpers.ts";

export function computeMaxwellDemon(ctx: SignalContext) {
  const modules = ctx.modules;
  if (modules.length === 0) {
    return { maxwellDemon: { meanDemonEfficiency: 0, isThermodynamicallyValid: false, topDemon: "", topDemonEfficiency: 0, totalInformationGain: 0 } };
  }
  // Compute per-module in-degree.
  const inDeg = new Map<string, number>();
  for (const m of modules) inDeg.set(m.path, 0);
  const moduleOf = (filePath: string): string | null => moduleOfPath(filePath, modules);
  for (const fa of ctx.fileAnalyses) {
    for (const imp of fa.imports) {
      if (!imp.resolvedPath) continue;
      const target = moduleOf(imp.resolvedPath);
      if (target) inDeg.set(target, (inDeg.get(target) ?? 0) + 1);
    }
  }
  // Per-module entropy (vocabulary size).
  const moduleEntropy = new Map<string, number>();
  const moduleTokens = new Map<string, number>();
  for (const fa of ctx.fileAnalyses) {
    const mod = moduleOf(fa.filePath);
    if (!mod) continue;
    const seen = new Set<string>();
    for (const t of fa.tokenStream) seen.add(t);
    const e = moduleEntropy.get(mod) ?? 0;
    moduleEntropy.set(mod, e + (seen.size > 0 ? Math.log2(seen.size) : 0));
    moduleTokens.set(mod, (moduleTokens.get(mod) ?? 0) + fa.tokenStream.length);
  }
  // Per-module demon efficiency = (entropy × inDeg / N) / bit-cost.
  // bit-cost = log2(moduleTokens) (Landauer erasure cost — proportional
  // to the number of bits the demon has to read).
  let totalGain = 0;
  let sumEff = 0;
  let countEff = 0;
  let topDemon = "";
  let topEff = -Infinity;
  for (const m of modules) {
    const entropy = moduleEntropy.get(m.path) ?? 0;
    const tokens = moduleTokens.get(m.path) ?? 0;
    const inDegree = inDeg.get(m.path) ?? 0;
    if (tokens === 0) continue;
    const benefit = (entropy * inDegree) / modules.length;
    const cost = Math.log2(Math.max(1, tokens));
    const efficiency = cost > 0 ? benefit / cost : 0;
    sumEff += efficiency;
    countEff += 1;
    totalGain += benefit - cost;
    if (efficiency > topEff) { topEff = efficiency; topDemon = m.name; }
  }
  const meanEff = countEff > 0 ? sumEff / countEff : 0;
  return {
    maxwellDemon: {
      meanDemonEfficiency: round(meanEff, 4),
      isThermodynamicallyValid: meanEff > 1,
      topDemon,
      topDemonEfficiency: round(topEff, 4),
      totalInformationGain: round(totalGain, 4),
    },
  };
}
