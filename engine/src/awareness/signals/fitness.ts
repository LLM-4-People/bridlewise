/**
 * EXP442-derived fitness/physics signals (5 signals).
 *
 * Source: EXPERIMENTS-SURVEY.md EXP442 (novel-principles) — 6 POSITIVE
 * formulas. EXP462 implements 5 as awareness signals:
 * - AL2 fitness (Tierra): function fitness = complexity × callers.
 * - Le Chatelier churn resistance: resistance = 1 / (dependents × churn).
 * - OBAFGKM temperature: classify functions by change-rate "temperature".
 * - Peierls call-chain symmetry: symmetric call chains = mirror symmetry.
 * - Born-Haber energy conservation: energy_in = energy_out for refactors.
 *
 * Each is O(n) or O(n log n) on the module graph — they reuse the
 * architecture signal's module records + the file analyses' functions.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

/** Build a caller-count map from imports. */
function callerCounts(ctx: SignalContext): Map<string, number> {
  const counts = new Map<string, number>();
  for (const fa of ctx.fileAnalyses) {
    for (const imp of fa.imports) {
      if (!imp.resolvedPath) continue;
      counts.set(imp.resolvedPath, (counts.get(imp.resolvedPath) ?? 0) + 1);
    }
  }
  return counts;
}

export function computeAl2Fitness(ctx: SignalContext) {
  const callers = callerCounts(ctx);
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (fns.length === 0) return { al2Fitness: { meanFitness: 0, maxFitness: 0, topFit: [] } };
  const scored = fns.map(f => ({
    name: f.name,
    fitness: round(f.complexity * (callers.get(f.filePath) ?? 0), 3),
    complexity: f.complexity,
    callers: callers.get(f.filePath) ?? 0,
  }));
  scored.sort((a, b) => b.fitness - a.fitness);
  const meanFitness = round(scored.reduce((s, f) => s + f.fitness, 0) / scored.length, 3);
  return {
    al2Fitness: {
      meanFitness,
      maxFitness: scored[0]?.fitness ?? 0,
      topFit: scored.slice(0, 5),
    },
  };
}

export function computeLeChatelier(ctx: SignalContext) {
  const modules = ctx.modules;
  if (modules.length === 0) return { leChatelier: { meanResistance: 0, minResistance: 0, unstableModules: 0, totalModules: 0 } };
  // Churn rate ≈ outDegree (modules that import a lot change more).
  // Resistance = inDegree / (outDegree + 1) — high in-degree + low out-degree = stable.
  const resistances = modules.map(m => ({
    name: m.name,
    resistance: round(m.inDegree / (m.outDegree + 1), 4),
  }));
  resistances.sort((a, b) => a.resistance - b.resistance);
  const meanResistance = round(resistances.reduce((s, r) => s + r.resistance, 0) / resistances.length, 4);
  const unstable = resistances.filter(r => r.resistance < 0.5).length;
  return {
    leChatelier: {
      meanResistance,
      minResistance: resistances[0]?.resistance ?? 0,
      unstableModules: unstable,
      totalModules: modules.length,
    },
  };
}

export function computeObafgkm(ctx: SignalContext) {
  // Classify functions by "temperature" = change rate (proxy: git history
  // changed-file frequency, or if no git, complexity as a proxy).
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  const commits = ctx.gitHistory;
  const fileChurn = new Map<string, number>();
  if (commits.length > 0) {
    for (const c of commits) for (const f of c.changedFiles) fileChurn.set(f, (fileChurn.get(f) ?? 0) + 1);
  }
  const temps = fns.map(f => fileChurn.get(f.filePath) ?? f.complexity);
  // OBAFGKM stellar classification: O (hottest, >30000K) → M (coolest, <3500K).
  // We map churn percentiles to the 7 classes.
  const sorted = [...temps].sort((a, b) => b - a);
  const n = sorted.length;
  const cls = (t: number): number => {
    const idx = sorted.indexOf(t);
    if (idx < 0) return 6;
    const pct = idx / Math.max(1, n);
    if (pct < 1 / 7) return 0; // O
    if (pct < 2 / 7) return 1; // B
    if (pct < 3 / 7) return 2; // A
    if (pct < 4 / 7) return 3; // F
    if (pct < 5 / 7) return 4; // G
    if (pct < 6 / 7) return 5; // K
    return 6; // M
  };
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const t of temps) counts[cls(t)] = (counts[cls(t)] ?? 0) + 1;
  const names = ["O", "B", "A", "F", "G", "K", "M"];
  const maxIdx = counts.indexOf(Math.max(...counts));
  return {
    obafgkm: {
      oType: counts[0] ?? 0, bType: counts[1] ?? 0, aType: counts[2] ?? 0, fType: counts[3] ?? 0,
      gType: counts[4] ?? 0, kType: counts[5] ?? 0, mType: counts[6] ?? 0,
      dominantClass: names[maxIdx] ?? "M",
    },
  };
}

export function computePeierlsSymmetry(ctx: SignalContext) {
  // Peierls: a call chain A→B→C has mirror symmetry if A→B and B→C have the
  // same "direction" (both import-increasing or both import-decreasing).
  // We approximate: count import-paths of length 2 (A→B→C) and check if
  // in-degree(A) ≈ in-degree(C) (mirror).
  const modules = ctx.modules;
  const byPath = new Map(modules.map(m => [m.path, m]));
  let symmetric = 0, asymmetric = 0;
  // Build adjacency.
  const adj = new Map<string, Set<string>>();
  for (const fa of ctx.fileAnalyses) {
    const mod = fa.filePath.split("/").slice(0, -1).join("/") || ".";
    for (const imp of fa.imports) {
      if (!imp.resolvedPath) continue;
      const impMod = imp.resolvedPath.split("/").slice(0, -1).join("/") || ".";
      if (mod === impMod) continue;
      if (!adj.has(mod)) adj.set(mod, new Set());
      adj.get(mod)!.add(impMod);
    }
  }
  for (const [a, neighbors] of adj) {
    for (const b of neighbors) {
      for (const c of adj.get(b) ?? []) {
        if (c === a) continue;
        const ma = byPath.get(a), mc = byPath.get(c);
        if (!ma || !mc) continue;
        if (Math.abs(ma.inDegree - mc.inDegree) <= 1) symmetric += 1;
        else asymmetric += 1;
      }
    }
  }
  const total = symmetric + asymmetric;
  return {
    peierlsSymmetry: {
      symmetricChains: symmetric,
      asymmetricChains: asymmetric,
      symmetryFraction: total > 0 ? round(symmetric / total, 4) : 0,
      totalChains: total,
    },
  };
}

export function computeBornHaber(ctx: SignalContext) {
  // Born-Haber: energy in (formation) = energy out (lattice).
  // Formation energy ≈ sum of function complexities (cost to create).
  // Lattice energy ≈ sum of module in-degrees (cost of the structure).
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  const formationEnergy = round(fns.reduce((s, f) => s + f.complexity, 0), 3);
  const latticeEnergy = round(ctx.modules.reduce((s, m) => s + m.inDegree, 0), 3);
  const imbalance = round(Math.abs(formationEnergy - latticeEnergy), 3);
  return {
    bornHaber: {
      formationEnergy,
      latticeEnergy,
      energyImbalance: imbalance,
      isConserved: imbalance < Math.max(formationEnergy, latticeEnergy) * 0.1,
    },
  };
}
