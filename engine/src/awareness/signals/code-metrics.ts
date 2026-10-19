/**
 * EXP462 code-metrics signals (5 signals).
 *
 * - Halstead complexity: vocabulary + length + volume + difficulty + effort.
 * - Maintainability index: MI = max(0, 171 - 5.2 ln(V) - 0.23 CC - 16.2 ln(LOC)).
 * - Cyclomatic debt: Σ (complexity - threshold) for hotspots.
 * - LCOM cohesion: lack of cohesion in modules (proxy via token overlap).
 * - Coupling: fan-in/fan-out statistics.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeHalsteadComplexity(ctx: SignalContext) {
  // n1 = distinct operators, n2 = distinct operands, N1 = total operators, N2 = total operands.
  // Proxy: operators = keywords + punctuation; operands = identifiers + literals.
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (fns.length === 0) return { halsteadComplexity: { vocabulary: 0, length: 0, volume: 0, difficulty: 0, effort: 0 } };
  let totalN1 = 0, totalN2 = 0, allOps = new Set<string>(), allOperands = new Set<string>();
  for (const f of fns) {
    for (const t of f.tokens) {
      // Heuristic: uppercase/quoted = operand, keyword/punct = operator, identifier = operand.
      if (/^[A-Z_][A-Z0-9_]*$/.test(t) || /^STR|^NUM|^LIT/.test(t)) { totalN2 += 1; allOperands.add(t); }
      else if (/^[a-z_]/.test(t)) { totalN2 += 1; allOperands.add(t); }
      else { totalN1 += 1; allOps.add(t); }
    }
  }
  const n1 = allOps.size, n2 = allOperands.size, N1 = totalN1, N2 = totalN2;
  const vocab = n1 + n2;
  const length = N1 + N2;
  const volume = round(length > 0 ? length * Math.log2(vocab || 1) : 0, 2);
  const difficulty = round(n2 > 0 ? (n1 / 2) * (N2 / n2) : 0, 2);
  const effort = round(difficulty * volume, 2);
  return { halsteadComplexity: { vocabulary: vocab, length, volume, difficulty, effort } };
}

export function computeMaintainabilityIndex(ctx: SignalContext) {
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  const loc = ctx.fileAnalyses.reduce((s, fa) => s + fa.lineCount, 0);
  if (fns.length === 0 || loc === 0) return { maintainabilityIndex: { mi: 0, normalizedMi: 0, grade: "F" } };
  // Halstead volume V (approximated).
  let V = 0;
  for (const f of fns) V += f.tokens.length * Math.log2(new Set(f.tokens).size || 1);
  const meanV = V / (fns.length || 1);
  const meanCC = fns.reduce((s, f) => s + f.complexity, 0) / (fns.length || 1);
  // MI = max(0, 171 - 5.2 ln(V) - 0.23 CC - 16.2 ln(LOC))
  const mi = Math.max(0, 171 - 5.2 * Math.log(meanV || 1) - 0.23 * meanCC - 16.2 * Math.log(loc));
  const normalized = round(Math.min(100, mi), 2);
  const grade = normalized >= 85 ? "A" : normalized >= 70 ? "B" : normalized >= 55 ? "C" : normalized >= 40 ? "D" : "F";
  return { maintainabilityIndex: { mi: round(mi, 2), normalizedMi: normalized, grade } };
}

export function computeCyclomaticDebt(ctx: SignalContext) {
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  const threshold = ctx.config.thresholds.complexityHotspot;
  if (fns.length === 0) return { cyclomaticDebt: { totalDebt: 0, meanDebt: 0, maxDebt: 0, debtRatio: 0 } };
  const debts = fns.map(f => Math.max(0, f.complexity - threshold));
  const total = round(debts.reduce((a, b) => a + b, 0), 2);
  return {
    cyclomaticDebt: {
      totalDebt: total,
      meanDebt: round(total / fns.length, 4),
      maxDebt: round(Math.max(...debts), 2),
      debtRatio: round(debts.filter(d => d > 0).length / fns.length, 4),
    },
  };
}

export function computeLcomCohesion(ctx: SignalContext) {
  // LCOM (lack of cohesion): for each module, count pairs of functions
  // that share NO tokens. High LCOM = low cohesion.
  const byMod = new Map<string, { fns: string[][]; name: string }>();
  for (const fa of ctx.fileAnalyses) {
    const mod = fa.filePath.split("/").slice(0, -1).join("/") || ".";
    if (!byMod.has(mod)) byMod.set(mod, { fns: [], name: mod.split("/").pop() ?? mod });
    for (const f of fa.functions) byMod.get(mod)!.fns.push([...f.tokens]);
  }
  if (byMod.size === 0) return { lcomCohesion: { meanLCOM: 0, maxLCOM: 0, lowCohesionCount: 0, totalClasses: 0 } };
  const lcoms = [];
  for (const m of byMod.values()) {
    let noShare = 0, total = 0;
    for (let i = 0; i < m.fns.length; i++) {
      for (let j = i + 1; j < m.fns.length; j++) {
        total += 1;
        const si = new Set(m.fns[i]!), sj = new Set(m.fns[j]!);
        let shared = false;
        for (const t of si) if (sj.has(t)) { shared = true; break; }
        if (!shared) noShare += 1;
      }
    }
    lcoms.push(total > 0 ? noShare / total : 0);
  }
  return {
    lcomCohesion: {
      meanLCOM: round(lcoms.reduce((a, b) => a + b, 0) / (lcoms.length || 1), 4),
      maxLCOM: round(Math.max(...lcoms), 4),
      lowCohesionCount: lcoms.filter(l => l > 0.5).length,
      totalClasses: byMod.size,
    },
  };
}

export function computeCoupling(ctx: SignalContext) {
  const modules = ctx.modules;
  if (modules.length === 0) return { coupling: { meanFanIn: 0, meanFanOut: 0, maxFanIn: 0, maxFanOut: 0, totalEdges: 0 } };
  const fanIn = modules.map(m => m.inDegree);
  const fanOut = modules.map(m => m.outDegree);
  return {
    coupling: {
      meanFanIn: round(fanIn.reduce((a, b) => a + b, 0) / (fanIn.length || 1), 4),
      meanFanOut: round(fanOut.reduce((a, b) => a + b, 0) / (fanOut.length || 1), 4),
      maxFanIn: Math.max(...fanIn),
      maxFanOut: Math.max(...fanOut),
      totalEdges: fanOut.reduce((a, b) => a + b, 0),
    },
  };
}
