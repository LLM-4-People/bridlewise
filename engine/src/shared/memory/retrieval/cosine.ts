// src/shared/memory/retrieval/cosine.ts
// CANONICAL cosine similarity. The single owner of cosine math for ALL
// memory + retrieval + duplicate-detection code. Replaces the FOUR previous
// implementations:
// 1. memory/tool-result-retrieval.ts `cosine` (Float32Array)
// 2. memory/tool-result-retrieval.ts `cosineNormalized` (Float32Array dot)
// 3. quality-packs/prevention/embedding-provider.ts `cosine` (dot, assumes normalized)
// 4. shared/tf-idf.ts `cosineSimilarity` + `cosineFromMaps` (Map-based)
// All four are gone; every consumer imports from here.

import { InputError } from "../../../kernel/errors.ts";

/** Cosine similarity for two Float32Array vectors (full normalization). */
export function cosineF32(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    // Length mismatch is a real error, not a swallowed fallback.
    throw new InputError(
      `cosineF32: length mismatch ${a.length} vs ${b.length}`,
      "shared_memory_cosine_length_mismatch",
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Cosine similarity for two PRE-NORMALIZED vectors (cosine = dot product).
 * Faster path for embeddings that are already L2-normalized. */
export function cosineNormalizedF32(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new InputError(
      `cosineNormalizedF32: length mismatch ${a.length} vs ${b.length}`,
      "shared_memory_cosine_length_mismatch",
    );
  }
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return s;
}

/** Cosine similarity for two sparse term-frequency/idf Maps. */
export function cosineMaps(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const smaller = a.size < b.size ? a : b;
  const larger = a.size < b.size ? b : a;
  for (const [, ca] of a) na += ca * ca;
  for (const [, cb] of b) nb += cb * cb;
  for (const [term, cv] of smaller) {
    const other = larger.get(term);
    if (other !== undefined) dot += cv * other;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Dispatch helper: pick the right cosine variant by vector type. */
export function cosine(a: Float32Array | ReadonlyMap<string, number>, b: Float32Array | ReadonlyMap<string, number>): number {
  if (a instanceof Float32Array && b instanceof Float32Array) {
    return cosineF32(a, b);
  }
  if (a instanceof Map && b instanceof Map) {
    return cosineMaps(a as Map<string, number>, b as Map<string, number>);
  }
  throw new InputError(
    "cosine: both args must be Float32Array or both ReadonlyMap<string,number>",
    "shared_memory_cosine_type_mismatch",
  );
}
