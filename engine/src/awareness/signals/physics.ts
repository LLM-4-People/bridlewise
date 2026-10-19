/**
 * EXP462 physics signals (4 signals).
 *
 * - Lagrangian L = T - V (kinetic = churn rate; potential = complexity).
 * - Hamiltonian H = T + V (total energy).
 * - Entropy production = dS/dt (irreversible change rate).
 * - Free energy F = U - TS (available work).
 *
 * These reuse the thermodynamics signal's definitions where possible.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

function kineticAndPotential(ctx: SignalContext): { T: number; V: number } {
  // T = churn rate (commits/day).
  let T = 0;
  if (ctx.gitHistory.length >= 2) {
    const newest = ctx.gitHistory[0]!.timestampMs;
    const oldest = ctx.gitHistory[ctx.gitHistory.length - 1]!.timestampMs;
    const days = Math.max(1, (newest - oldest) / 86_400_000);
    T = ctx.gitHistory.length / days;
  }
  // V = mean complexity.
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  const V = fns.length > 0 ? fns.reduce((s, f) => s + f.complexity, 0) / fns.length : 0;
  return { T, V };
}

export function computeLagrangian(ctx: SignalContext) {
  const { T, V } = kineticAndPotential(ctx);
  return {
    lagrangian: {
      kinetic: round(T, 4),
      potential: round(V, 4),
      lagrangian: round(T - V, 4),
      totalEnergy: round(T + V, 4),
    },
  };
}

export function computeHamiltonian(ctx: SignalContext) {
  const { T, V } = kineticAndPotential(ctx);
  const H = T + V;
  return {
    hamiltonian: {
      hamiltonian: round(H, 4),
      kinetic: round(T, 4),
      potential: round(V, 4),
      isConserved: Math.abs(T - V) < 0.5 * (T + V || 1),
    },
  };
}

export function computeEntropyProduction(ctx: SignalContext) {
  // dS/dt ≈ (entropy now) × (churn rate). High production = irreversible change.
  const tokenSet = new Set<string>();
  for (const fa of ctx.fileAnalyses) for (const t of fa.tokenStream) tokenSet.add(t);
  const S = tokenSet.size > 0 ? Math.log(tokenSet.size) : 0;
  let T = 0;
  if (ctx.gitHistory.length >= 2) {
    const newest = ctx.gitHistory[0]!.timestampMs;
    const oldest = ctx.gitHistory[ctx.gitHistory.length - 1]!.timestampMs;
    const days = Math.max(1, (newest - oldest) / 86_400_000);
    T = ctx.gitHistory.length / days;
  }
  const production = S * T;
  return {
    entropyProduction: {
      production: round(production, 4),
      isIrreversible: T > 0.5,
      commitCount: ctx.gitHistory.length,
      meanEntropyRate: round(T > 0 ? S / T : 0, 4),
    },
  };
}

export function computeFreeEnergy(ctx: SignalContext) {
  // F = U - TS where U = mean complexity, S = entropy, T = churn rate.
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  const U = fns.length > 0 ? fns.reduce((s, f) => s + f.complexity, 0) / fns.length : 0;
  const tokenSet = new Set<string>();
  for (const fa of ctx.fileAnalyses) for (const t of fa.tokenStream) tokenSet.add(t);
  const S = tokenSet.size > 0 ? Math.log(tokenSet.size) : 0;
  let T = 0;
  if (ctx.gitHistory.length >= 2) {
    const newest = ctx.gitHistory[0]!.timestampMs;
    const oldest = ctx.gitHistory[ctx.gitHistory.length - 1]!.timestampMs;
    const days = Math.max(1, (newest - oldest) / 86_400_000);
    T = ctx.gitHistory.length / days;
  }
  return {
    freeEnergy: {
      freeEnergy: round(U - T * S, 4),
      internalEnergy: round(U, 4),
      temperature: round(T, 4),
      entropy: round(S, 4),
    },
  };
}
