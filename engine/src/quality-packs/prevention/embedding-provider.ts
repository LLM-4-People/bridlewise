// src/quality-packs/prevention/embedding-provider.ts
//
// THIN ADAPTER (EXP436): delegates to the CANONICAL shared embeddings
// provider at `src/shared/memory/retrieval/embeddings.ts`. This file was a
// DUPLICATE loader (all-MiniLM-L6-v2 via @xenova/transformers) — now it is
// a single-owner re-export so the D3 duplicate-body detector keeps its
// stable import path while the loader lives in ONE place. The cosine math
// also delegates to the canonical `src/shared/memory/retrieval/cosine.ts`.
//
// Research sources preserved from the original module:
// - EXP393 (`semantic-embeddings`): HYBRID decision — add @xenova/transformers.
// - EXP397 (`embeddings-test`): all-MiniLM-L6-v2, 384-dim, fp32 fastest on CPU.
// - EXP406/407: threshold 0.92, minBodySize=80 eliminate the 5 small-FN FPs.
//
// The old `EmbeddingProvider` shape (embedBatch + cosine + dispose) is kept
// so D3 is unchanged; it is built ON TOP of the shared EmbeddingsProvider.

import {
  getEmbeddingsProvider,
  type EmbeddingVector,
} from "../../shared/memory/retrieval/embeddings.ts";
import { cosineF32, cosineNormalizedF32 } from "../../shared/memory/retrieval/cosine.ts";

export type { EmbeddingVector };

export interface EmbeddingProviderOptions {
  /** Model identifier (default `Xenova/all-MiniLM-L6-v2`). */
  model?: string | undefined;
  /** ONNX dtype (default `fp32` — fastest on CPU per EXP393 ablation). */
  dtype?: "fp32" | "fp16" | "q8" | "int8" | "uint8" | undefined;
  /** Cache directory for the model. */
  cacheDir?: string | undefined;
  /** WASM paths override (for `onnxruntime-web`). */
  wasmPaths?: string | undefined;
}

/** D3-facing provider — wraps the canonical shared EmbeddingsProvider. */
export interface EmbeddingProvider {
  /** Embed a batch of texts. Returns pre-normalized vectors (cosine = dot). */
  embedBatch(texts: readonly string[]): Promise<EmbeddingVector[]>;
  /** Cosine similarity between two vectors (handles normalized + general). */
  cosine(a: EmbeddingVector, b: EmbeddingVector): number;
  /** Release the underlying model (idempotent). */
  dispose(): Promise<void>;
}

/**
 * Get the embedding provider. Returns `null` if @xenova/transformers is not
 * installed (graceful fallback — Pass 3 produces no findings). Delegates to
 * the canonical process-level singleton in the shared memory module.
 */
export async function getEmbeddingProvider(
  options: EmbeddingProviderOptions = {},
  _reload = false,
): Promise<EmbeddingProvider | null> {
  const opts: { modelId?: string; dtype?: "fp32" | "fp16" | "q8" | "int8" | "uint8"; cacheDir?: string | null; wasmPaths?: string } = {};
  if (options.model !== undefined) opts.modelId = options.model;
  if (options.dtype !== undefined) opts.dtype = options.dtype;
  if (options.cacheDir !== undefined) opts.cacheDir = options.cacheDir;
  if (options.wasmPaths !== undefined) opts.wasmPaths = options.wasmPaths;
  const shared = getEmbeddingsProvider(opts);
  try {
    await shared.init();
  } catch {
    return null;
  }
  if (!shared.isAvailable()) return null;
  return {
    async embedBatch(texts: readonly string[]): Promise<EmbeddingVector[]> {
      return shared.embedBatch(texts);
    },
    cosine(a: EmbeddingVector, b: EmbeddingVector): number {
      // Embeddings are pre-normalized → use the fast dot-product path. Fall
      // back to the full normalized cosine if lengths ever differ.
      if (a.length === b.length) return cosineNormalizedF32(a, b);
      return cosineF32(a, b);
    },
    async dispose(): Promise<void> {
      await shared.dispose();
    },
  };
}

/** Test helper: reset the shared singleton. NOT for production use. */
export function _resetEmbeddingProviderForTests(): void {
  // Re-exported from the canonical module so tests keep their import path.
  // (The shared singleton is reset here.)
  getEmbeddingsProvider({}).dispose();
}
