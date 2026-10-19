/**
 * Canonical set-similarity primitives.
 *
 * ONE source of truth for k-shingle generation and Jaccard similarity across
 * the entire harness (duplicate-body-detector, async-effect-normalizer, and
 * any future consumer). Replaces the duplicate `shingles`/`jaccard` copies
 * that previously lived in:
 * - `quality-packs/prevention/duplicate-body-detector.ts`
 * - `quality-packs/prevention/async-effect-normalizer.ts`
 */

/**
 * Build the set of k-shingles from a token array.
 *
 * If the token array is shorter than `k`, a single shingle containing all
 * tokens joined by `"|"` is returned (so empty input → `Set("")` — a
 * one-element set, NOT an empty set).
 */
export function shingles(tokens: readonly string[], k: number): Set<string> {
  return new Set(shinglesArray(tokens, k, "|"));
}

/**
 * Build the ARRAY of k-shingles from a token array.
 *
 * If the token array is shorter than `k`, a single shingle containing all
 * tokens joined by `separator` is returned (so empty input → `[""]` — a
 * one-element array, NOT an empty array).
 *
 * The `separator` joins the k tokens within one shingle. The default `"|"`
 * is safe for code tokens (identifiers/keywords rarely contain `|`). For
 * shingling over arbitrary text that may contain `|`, pass a control
 * character like `"\u0001"` (used by the awareness clone-helpers) so
 * token boundaries cannot collide with the separator.
 *
 * This is the canonical owner for the array-shingle semantic that was
 * previously duplicated as a private near-duplicate body in:
 * - `src/awareness/clone-helpers.ts:1` (`shingleArray` — `\u0001` separator)
 * - `src/quality/checks/duplicates.ts:45` (`shingles` — `" "` separator)
 * Both consumers now delegate to this single owner.
 */
export function shinglesArray(
  tokens: readonly string[],
  k: number,
  separator: string = "|",
): string[] {
  if (tokens.length < k) return [tokens.join(separator)];
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - k; i += 1) {
    out.push(tokens.slice(i, i + k).join(separator));
  }
  return out;
}

/**
 * Jaccard similarity between two sets: `|A ∩ B| / |A ∪ B|`.
 *
 * Returns `0` when either set is empty (conservative — an empty body must not
 * match everything). When both sets are empty, returns `0`.
 *
 * This is the "conservative" variant used by the duplicate-body detector and
 * async-effect normalizer (an empty body must never be reported as a near-
 * duplicate of a populated one). The dedup engine uses the {@link
 * jaccardLenient} variant instead (two empty sets are identical → 1).
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Lenient Jaccard similarity between two sets: `|A ∩ B| / |A ∪ B|`.
 *
 * Differs from {@link jaccard} ONLY in the empty-set policy: when BOTH sets
 * are empty, returns `1` (mathematically, two empty sets are identical).
 * When EITHER set is empty (but not both), returns `0` (a populated set is
 * not identical to an empty one).
 *
 * This is the "lenient" variant used by the dedup engine
 * (`src/shared/dedup-compression/dedup.ts`): two empty blocks are treated
 * as identical (Jaccard=1) so the dedup pass collapses them. Previously
 * the dedup engine had its OWN private near-duplicate `jaccard` body with
 * this lenient empty-set policy — a "No Scattered Helpers" violation. The
 * canonical owner is now `src/shared/similarity.ts`; the dedup engine
 * imports `jaccardLenient` from here.
 */
export function jaccardLenient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  // Iterate the smaller set for the intersection check (the dedup engine's
  // original optimization — preserved so the consolidation does not regress
  // dedup throughput on large block sets).
  const smaller = a.size < b.size ? a : b;
  const larger = a.size < b.size ? b : a;
  let inter = 0;
  for (const x of smaller) if (larger.has(x)) inter += 1;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Jaccard similarity between two ARRAYS of tokens. Convenience wrapper that
 * converts the arrays to sets and delegates to {@link jaccard} (conservative
 * empty-set policy: an empty array → 0).
 *
 * This is the canonical owner for the array→set Jaccard semantic that was
 * previously duplicated as a private near-duplicate body in:
 * - `src/safety/bias-detector.ts:172` (`jaccard(a, b)` — arrays, conservative)
 * - `src/awareness/clone-helpers.ts:10` (`jaccardOf(a, b)` — arrays, conservative)
 * Both consumers now import from this single owner instead of re-defining
 * the body.
 */
export function jaccardArrays(a: readonly string[], b: readonly string[]): number {
  return jaccard(new Set(a), new Set(b));
}
