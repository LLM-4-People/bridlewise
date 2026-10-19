/**
 * EXP462 combinatorics signals (4 signals).
 *
 * - Pólya enumeration: distinct colorings under a symmetry group.
 * - Burnside's lemma: orbits = (1/|G|) Σ |Fix(g)|.
 * - Catalan number: C_n = (2n)! / (n!(n+1)!) — tree/Dyck path count.
 * - Stirling number S(n,k): partitions of an n-set into k blocks.
 *
 * These are computed from the module graph (colorings = community
 * assignments, orbits = distinct module roles, trees = call-tree
 * shapes, partitions = module groupings).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function binomial(n: number, k: number): number {
  if (k > n - k) k = n - k;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

export function computePolyaEnumeration(ctx: SignalContext) {
  // Pólya: distinct colorings = (1/|G|) Σ |Fix(g)| where G is the automorphism
  // group of the graph. We approximate |G| by the number of module-role
  // classes (symmetric modules), and distinctColorings by the number of
  // distinct role-assignments. With k community colors:
  const k = Math.min(ctx.config.thresholds.combinatoricsCommunityColors, ctx.modules.length);
  const n = ctx.modules.length;
  if (n === 0 || k === 0) return { polyaEnumeration: { distinctColorings: 0, symmetryGroupSize: 0, totalColorings: 0 } };
  // Symmetry group size ≈ number of modules with the same in+out degree.
  const degCounts = new Map<string, number>();
  for (const m of ctx.modules) {
    const key = `${m.inDegree},${m.outDegree}`;
    degCounts.set(key, (degCounts.get(key) ?? 0) + 1);
  }
  let groupSize = 1;
  for (const c of degCounts.values()) if (c > 1) groupSize *= factorial(c);
  const total = round(Math.pow(k, n), 0);
  return { polyaEnumeration: { distinctColorings: round(total / groupSize, 0), symmetryGroupSize: groupSize, totalColorings: total } };
}

export function computeBurnsideLemma(ctx: SignalContext) {
  // Burnside: orbits = (1/|G|) Σ |Fix(g)|. Orbits ≈ distinct module roles.
  const degCounts = new Map<string, number>();
  for (const m of ctx.modules) {
    const key = `${m.inDegree},${m.outDegree}`;
    degCounts.set(key, (degCounts.get(key) ?? 0) + 1);
  }
  const groupSize = [...degCounts.values()].reduce((s, c) => s + (c > 1 ? factorial(c) : 1), 1) || 1;
  const fixedSum = ctx.modules.length; // identity fixes everything
  const orbits = round(fixedSum / groupSize, 0);
  return { burnsideLemma: { orbitCount: orbits, groupOrder: groupSize, meanFixedPoints: round(fixedSum / groupSize, 2) } };
}

export function computeCatalanNumber(ctx: SignalContext) {
  // Catalan C_n = (2n)! / (n!(n+1)!) = binomial(2n, n) / (n+1).
  // n = mean call-tree depth (proxy: mean nesting depth).
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  const n = fns.length > 0 ? Math.min(10, Math.round(fns.reduce((s, f) => s + f.bodyLines, 0) / fns.length / 10)) : 0;
  const catalan = n > 0 ? Math.round(binomial(2 * n, n) / (n + 1)) : 0;
  return { catalanNumber: { catalan, n, treeCount: catalan, dyckPathCount: catalan } };
}

export function computeStirlingNumber(ctx: SignalContext) {
  // Stirling S(n, k) = number of ways to partition n elements into k non-empty
  // subsets. n = module count, k = community count (approximate).
  const n = ctx.modules.length;
  const k = Math.min(n, 3);
  if (n === 0 || k === 0) return { stirlingNumber: { stirling: 0, n: 0, k: 0, partitionCount: 0 } };
  // Stirling second kind: S(n,k) = (1/k!) Σ (-1)^(k-j) C(k,j) j^n
  let sum = 0;
  for (let j = 0; j <= k; j++) {
    sum += (j % 2 === k % 2 ? 1 : -1) * binomial(k, j) * Math.pow(j, n);
  }
  const stirling = round(sum / factorial(k), 0);
  return { stirlingNumber: { stirling, n, k, partitionCount: stirling } };
}
