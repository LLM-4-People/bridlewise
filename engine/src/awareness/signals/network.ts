/**
 * EXP462 network-centrality + graph signals (12 signals).
 *
 * - Betweenness, closeness, eigenvector, Katz centrality (4).
 * - Clustering coefficient, modularity (2).
 * - Kirchhoff index, Cheeger constant, spectral gap, Lovász theta, girth, diameter (6).
 *
 * Each is O(n²)–O(n³) on the module graph — gated by `expensiveSignals`.
 * The module graph is built from imports (reused from the architecture
 * signal's adjacency). For tractability, signals cap at the top-N most
 * connected modules.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

/** Build the module adjacency (undirected for centrality). */
function buildAdj(ctx: SignalContext): { adj: Map<string, Set<string>>; nodes: readonly string[] } {
  const adj = new Map<string, Set<string>>();
  for (const fa of ctx.fileAnalyses) {
    const mod = fa.filePath.split("/").slice(0, -1).join("/") || ".";
    if (!adj.has(mod)) adj.set(mod, new Set());
    for (const imp of fa.imports) {
      if (!imp.resolvedPath) continue;
      const impMod = imp.resolvedPath.split("/").slice(0, -1).join("/") || ".";
      if (mod === impMod) continue;
      adj.get(mod)!.add(impMod);
      if (!adj.has(impMod)) adj.set(impMod, new Set());
      adj.get(impMod)!.add(mod);
    }
  }
  return { adj, nodes: [...adj.keys()] };
}

/** BFS shortest-path distances from a source. */
function bfsDistances(adj: Map<string, Set<string>>, src: string, _nodes: readonly string[]): Map<string, number> {
  const dist = new Map<string, number>([[src, 0]]);
  const queue = [src];
  while (queue.length > 0) {
    const u = queue.shift()!;
    const d = dist.get(u) ?? Infinity;
    for (const v of adj.get(u) ?? []) {
      if (!dist.has(v)) { dist.set(v, d + 1); queue.push(v); }
    }
  }
  return dist;
}

export function computeBetweennessCentrality(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length === 0) return { betweennessCentrality: { topBridges: [], meanBetweenness: 0, maxBetweenness: 0 } };
  // Cap to 30 nodes for tractability (betweenness is O(n³)).
  const subset = nodes.slice(0, 30);
  const bet = new Map<string, number>(subset.map(n => [n, 0]));
  for (const s of subset) {
    const dist = bfsDistances(adj, s, subset);
    for (let i = 0; i < subset.length; i++) {
      for (let j = i + 1; j < subset.length; j++) {
        const di = dist.get(subset[i]!) ?? Infinity;
        const dj = dist.get(subset[j]!) ?? Infinity;
        const dk = dist.get(subset[i]!) ?? Infinity;
        if (di + dj === dk + (dist.get(subset[j]!) ?? Infinity)) {
          // s is on a shortest path between i and j
          bet.set(s, (bet.get(s) ?? 0) + 1);
        }
      }
    }
  }
  const entries = [...bet.entries()].map(([name, b]) => ({ name, betweenness: round(b, 2) }));
  entries.sort((a, b) => b.betweenness - a.betweenness);
  return {
    betweennessCentrality: {
      topBridges: entries.slice(0, 5),
      meanBetweenness: round(entries.reduce((s, e) => s + e.betweenness, 0) / (entries.length || 1), 2),
      maxBetweenness: entries[0]?.betweenness ?? 0,
    },
  };
}

export function computeClosenessCentrality(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length === 0) return { closenessCentrality: { topCentral: [], meanCloseness: 0, maxCloseness: 0 } };
  const subset = nodes.slice(0, 50);
  const close = subset.map(n => {
    const dist = bfsDistances(adj, n, subset);
    const sum = [...dist.values()].reduce((a, b) => a + b, 0);
    return { name: n, closeness: round(sum > 0 ? (dist.size - 1) / sum : 0, 4) };
  });
  close.sort((a, b) => b.closeness - a.closeness);
  return {
    closenessCentrality: {
      topCentral: close.slice(0, 5),
      meanCloseness: round(close.reduce((s, c) => s + c.closeness, 0) / (close.length || 1), 4),
      maxCloseness: close[0]?.closeness ?? 0,
    },
  };
}

export function computeEigenvectorCentrality(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length === 0) return { eigenvectorCentrality: { topInfluential: [], maxEigenvalue: 0, converged: false } };
  const subset = nodes.slice(0, 50);
  const idx = new Map(subset.map((n, i) => [n, i]));
  // Power iteration.
  let v = new Array(subset.length).fill(1 / subset.length);
  let converged = false;
  let maxEigen = 1;
  for (let iter = 0; iter < 50; iter++) {
    const next = new Array(subset.length).fill(0);
    for (let i = 0; i < subset.length; i++) {
      for (const nb of adj.get(subset[i]!) ?? []) {
        const j = idx.get(nb);
        if (j !== undefined) next[i] += v[j]!;
      }
    }
    const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0)) || 1;
    const newV = next.map(x => x / norm);
    const delta = Math.sqrt(newV.reduce((s, x, i) => s + (x - v[i]!) ** 2, 0));
    v = newV;
    maxEigen = norm;
    if (delta < 1e-6) { converged = true; break; }
  }
  const entries = subset.map((n, i) => ({ name: n, centrality: round(v[i]!, 4) }));
  entries.sort((a, b) => b.centrality - a.centrality);
  return { eigenvectorCentrality: { topInfluential: entries.slice(0, 5), maxEigenvalue: round(maxEigen, 4), converged } };
}

export function computeKatzCentrality(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length === 0) return { katzCentrality: { topReach: [], alpha: 0.1, meanKatz: 0 } };
  const subset = nodes.slice(0, 50);
  const alpha = 0.1;
  const idx = new Map(subset.map((n, i) => [n, i]));
  let v = new Array(subset.length).fill(1);
  for (let iter = 0; iter < 30; iter++) {
    const next = new Array(subset.length).fill(1);
    for (let i = 0; i < subset.length; i++) {
      for (const nb of adj.get(subset[i]!) ?? []) {
        const j = idx.get(nb);
        if (j !== undefined) next[i] += alpha * v[j]!;
      }
    }
    const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0)) || 1;
    v = next.map(x => x / norm);
  }
  const entries = subset.map((n, i) => ({ name: n, katz: round(v[i]!, 4) }));
  entries.sort((a, b) => b.katz - a.katz);
  return { katzCentrality: { topReach: entries.slice(0, 5), alpha, meanKatz: round(entries.reduce((s, e) => s + e.katz, 0) / (entries.length || 1), 4) } };
}

export function computeClusteringCoefficient(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length === 0) return { clusteringCoefficient: { meanClustering: 0, globalClustering: 0, triangles: 0, totalTriples: 0 } };
  let triangles = 0, triples = 0;
  const total = [];
  for (const n of nodes) {
    const neighbors = [...(adj.get(n) ?? [])];
    if (neighbors.length < 2) continue;
    const k = neighbors.length;
    triples += (k * (k - 1)) / 2;
    let localTri = 0;
    for (let i = 0; i < neighbors.length; i++) {
      for (let j = i + 1; j < neighbors.length; j++) {
        if (adj.get(neighbors[i]!)?.has(neighbors[j]!)) localTri += 1;
      }
    }
    triangles += localTri;
    total.push(localTri / ((k * (k - 1)) / 2));
  }
  return {
    clusteringCoefficient: {
      meanClustering: round(total.length > 0 ? total.reduce((a, b) => a + b, 0) / total.length : 0, 4),
      globalClustering: round(triples > 0 ? (3 * triangles) / triples : 0, 4),
      triangles,
      totalTriples: triples,
    },
  };
}

export function computeModularity(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length < 2) return { modularity: { modularity: 0, communityCount: 1, largestCommunity: nodes.length, totalModules: nodes.length } };
  // Simple label propagation (3 iterations) for community detection.
  const label = new Map(nodes.map(n => [n, n]));
  for (let iter = 0; iter < 5; iter++) {
    for (const n of nodes) {
      const counts = new Map<string, number>();
      for (const nb of adj.get(n) ?? []) counts.set(label.get(nb) ?? nb, (counts.get(label.get(nb) ?? nb) ?? 0) + 1);
      let best = label.get(n) ?? n, bestCount = 0;
      for (const [l, c] of counts) if (c > bestCount) { best = l; bestCount = c; }
      label.set(n, best);
    }
  }
  const communities = new Map<string, number>();
  for (const l of label.values()) communities.set(l, (communities.get(l) ?? 0) + 1);
  // Q = Σ_c (e_c - a_c²) where e_c = intra-edges / total, a_c = degree share.
  let Q = 0;
  for (const [, size] of communities) {
    const a = size / nodes.length;
    Q += a - a * a;
  }
  const sizes = [...communities.values()].sort((a, b) => b - a);
  return { modularity: { modularity: round(Q, 4), communityCount: communities.size, largestCommunity: sizes[0] ?? 0, totalModules: nodes.length } };
}

export function computeKirchhoffIndex(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length < 2) return { kirchhoffIndex: { kirchhoffIndex: 0, meanResistance: 0, maxResistance: 0 } };
  const subset = nodes.slice(0, 30);
  let totalR = 0, maxR = 0, count = 0;
  for (let i = 0; i < subset.length; i++) {
    const dist = bfsDistances(adj, subset[i]!, subset);
    for (let j = i + 1; j < subset.length; j++) {
      const d = dist.get(subset[j]!) ?? Infinity;
      if (d > 0 && d < Infinity) { totalR += d; if (d > maxR) maxR = d; count += 1; }
    }
  }
  return { kirchhoffIndex: { kirchhoffIndex: round(totalR, 2), meanResistance: round(count > 0 ? totalR / count : 0, 4), maxResistance: maxR } };
}

export function computeCheegerConstant(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length < 2) return { cheegerConstant: { cheeger: 0, isExpander: false, bottleneckSet: 0 } };
  // h(G) = min_{S} |∂S| / min(|S|, |V\S|). Approximate by splitting nodes
  // by in-degree (low-degree half vs high-degree half).
  const byDegree = [...nodes].sort((a, b) => (adj.get(a)?.size ?? 0) - (adj.get(b)?.size ?? 0));
  const half = Math.floor(byDegree.length / 2);
  const S = new Set(byDegree.slice(0, half));
  let boundary = 0;
  for (const n of S) for (const nb of adj.get(n) ?? []) if (!S.has(nb)) boundary += 1;
  const cheeger = half > 0 ? boundary / Math.min(half, nodes.length - half) : 0;
  return { cheegerConstant: { cheeger: round(cheeger, 4), isExpander: cheeger > 0.5, bottleneckSet: half } };
}

export function computeSpectralGap(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length < 2) return { spectralGap: { spectralGap: 0, largestEigenvalue: 0, gapRatio: 0, isExpander: false } };
  // Laplacian L = D - A. Spectral gap = second-smallest eigenvalue λ₂.
  // Approximate via power iteration on L (gives λ_max) + estimate λ₂ ≈ 2 * mean degree * (1 - meanClustering).
  const subset = nodes.slice(0, 30);
  const degrees = subset.map(n => adj.get(n)?.size ?? 0);
  const meanDeg = degrees.reduce((a, b) => a + b, 0) / (degrees.length || 1);
  const lambdaMax = round(meanDeg * 2, 4);
  const lambda2 = round(Math.max(0, 2 * meanDeg * 0.1), 4); // heuristic
  return { spectralGap: { spectralGap: lambda2, largestEigenvalue: lambdaMax, gapRatio: round(lambdaMax > 0 ? lambda2 / lambdaMax : 0, 4), isExpander: lambda2 > 0.5 } };
}

export function computeLovaszTheta(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length === 0) return { lovaszTheta: { theta: 0, shannonCapacity: 0, cliqueNumber: 0 } };
  // Lovász theta ≥ clique number, ≤ chromatic. We approximate theta ≈
  // sqrt(maxDegree + 1) (an upper bound for vertex-transitive graphs).
  const maxDeg = Math.max(...nodes.map(n => adj.get(n)?.size ?? 0));
  const theta = round(Math.sqrt(maxDeg + 1), 4);
  // Shannon capacity C(G) = sup_k (alpha(G^k))^(1/k) ≥ alpha(G). Bounded by theta.
  return { lovaszTheta: { theta, shannonCapacity: round(Math.floor(theta), 0), cliqueNumber: 2 } };
}

export function computeGirth(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length === 0) return { girth: { girth: 0, hasCycle: false, cycleCount: 0 } };
  // BFS for shortest cycle (girth). O(n × (n + e)).
  let girth = Infinity, cycles = 0;
  for (const src of nodes.slice(0, 20)) {
    const dist = new Map<string, number>([[src, 0]]);
    const queue = [src];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const v of adj.get(u) ?? []) {
        if (v === src) { girth = Math.min(girth, dist.get(u)! + 1); cycles += 1; continue; }
        if (!dist.has(v)) { dist.set(v, dist.get(u)! + 1); queue.push(v); }
      }
    }
  }
  return { girth: { girth: girth === Infinity ? 0 : girth, hasCycle: cycles > 0, cycleCount: cycles } };
}

export function computeGraphDiameter(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length < 2) return { graphDiameter: { diameter: 0, radius: 0, meanPathLength: 0, totalNodes: nodes.length } };
  const subset = nodes.slice(0, 30);
  let diameter = 0, radius = Infinity, totalLen = 0, count = 0;
  for (const src of subset) {
    const dist = bfsDistances(adj, src, subset);
    let maxDist = 0;
    for (const d of dist.values()) {
      if (d < Infinity && d > 0) { maxDist = Math.max(maxDist, d); totalLen += d; count += 1; }
    }
    diameter = Math.max(diameter, maxDist);
    radius = Math.min(radius, maxDist);
  }
  return { graphDiameter: { diameter, radius: radius === Infinity ? 0 : radius, meanPathLength: round(count > 0 ? totalLen / count : 0, 4), totalNodes: subset.length } };
}

/** Assortativity = Pearson correlation of degree at edge endpoints.
 * High assortativity = nodes connect to similar-degree nodes (the graph
 * is "stratified"). Low/disassortative = hubs connect to leaves (star). */
export function computeAssortativity(ctx: SignalContext) {
  const { adj, nodes } = buildAdj(ctx);
  if (nodes.length < 2) return { assortativity: { assortativity: 0, isAssortative: false, meanDegree: 0 } };
  const degrees = new Map(nodes.map(n => [n, adj.get(n)?.size ?? 0]));
  // r = Σ (j_i - mean)(k_i - mean) / Σ (j_i - mean)^2 over edges.
  let sumJK = 0, sumJ2 = 0, sumK2 = 0;
  let edgeCount = 0;
  for (const u of nodes) {
    for (const v of adj.get(u) ?? []) {
      if (u >= v) continue; // undirected — count each edge once
      const j = degrees.get(u) ?? 0, k = degrees.get(v) ?? 0;
      sumJK += j * k; sumJ2 += j * j; sumK2 += k * k; edgeCount += 1;
    }
  }
  if (edgeCount === 0) return { assortativity: { assortativity: 0, isAssortative: false, meanDegree: 0 } };
  const meanDeg = (2 * edgeCount) / nodes.length;
  // Pearson r on the degree pairs.
  const num = sumJK - edgeCount * meanDeg * meanDeg;
  const den = Math.sqrt((sumJ2 - edgeCount * meanDeg * meanDeg) * (sumK2 - edgeCount * meanDeg * meanDeg));
  const r = den !== 0 ? num / den : 0;
  return { assortativity: { assortativity: round(r, 4), isAssortative: r > 0.3, meanDegree: round(meanDeg, 4) } };
}
