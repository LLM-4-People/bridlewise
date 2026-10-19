/**
 * Canonical statistical helpers.
 *
 * ONE source of truth for the statistical primitives used across the
 * harness (`pearson`, `median`, `percentileOf`). Previously these were
 * scattered as duplicate/near-duplicate bodies across:
 * `src/shared/git-churn.ts` — `pearson`, `median`, `percentileOf`
 * (exported alongside the git-churn computation)
 * `src/awareness/fisher-ranking.ts` — a private `pearson` near-duplicate
 * body (same algorithm, slightly different structure)
 *
 * Per "No Scattered Helpers" +, both consumers now
 * import from this single owner. The bodies are byte-equivalent to the
 * git-churn originals (the canonical, more-optimized form: smaller/larger
 * iteration for `pearson`, binary-search percentile for `percentileOf`).
 */

/**
 * Pearson correlation between two paired arrays. Returns -1..1.
 *
 * Returns `0` for: length mismatch, empty input, or zero variance in either
 * array (denominator 0).
 */
export function pearson(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length === 0) return 0;
  const n = xs.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (den === 0) return 0;
  return num / den;
}

/** Compute the median of a numeric array (pure). Returns 0 for empty input. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * Percentile of a value within a sorted-ascending array. Pure function.
 * Returns 0..1. Used by OBAFGKM (churn percentile per function) and
 * AL2 (fitness percentile).
 *
 * Uses the "Type 4" (parzen) formula: percentile = (count of values
 * strictly less than v) / (n - 1). This gives the minimum value a
 * percentile of 0 and the maximum a percentile of 1 — intuitive for the
 * OBAFGKM use case (the hottest function gets 1.0, not (n-1)/n).
 */
export function percentileOf(value: number, sortedAsc: readonly number[]): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return value >= sortedAsc[0]! ? 1 : 0;
  // Boundary cases: below min → 0, at/above max → 1.
  if (value <= (sortedAsc[0] ?? 0)) return 0;
  if (value >= (sortedAsc[sortedAsc.length - 1] ?? 0)) return 1;
  // Binary search for the insertion point.
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedAsc[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the count of values strictly less than `value`.
  // Type 4 formula: percentile = (count less than v) / (n - 1).
  return lo / (sortedAsc.length - 1);
}

/**
 * A SEEDED pseudo-random source (mulberry32): the same seed gives the same
 * sequence in every process, so an evaluation's assignment and shuffle are
 * reproducible from its seed alone. Values in [0, 1). The ONE seeded source
 * (prompt-registry F-PR-7: the matrix executor held a private copy; the
 * prompt experiments' assignment reuses this one). Not for secrets.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `items` in a Fisher-Yates order drawn from {@link seededRandom}(`seed`): the same seed, the same order. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const shuffled = [...items];
  if (shuffled.length <= 1) return shuffled;
  const next = seededRandom(seed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const held = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = held;
  }
  return shuffled;
}
