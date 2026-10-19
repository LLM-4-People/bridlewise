// src/shared/memory/retrieval/embeddings.ts
// CANONICAL embeddings provider. Single owner of the @xenova/transformers
// lazy loader. Replaces the TWO previous implementations:
// 1. memory/tool-result-retrieval.ts `createEmbeddingsRetriever`
// 2. quality-packs/prevention/embedding-provider.ts `getEmbeddingProvider`
// Both loaded all-MiniLM-L6-v2 via @xenova/transformers with nearly identical
// setup (env.allowLocalModels, allowRemoteModels=false, numThreads=1,
// pipeline feature-extraction fp32). Now ONE process-level singleton here.
//
// Graceful fallback: if @xenova/transformers is not installed (Landlock/
// offline), every call returns null and retrieval falls back to TF-IDF.
// Research (EXP393/397): all-MiniLM-L6-v2, 384-dim, 22MB, Apache-2.0,
// +60pp recall over TF-IDF on paraphrased queries.

import type { EmbeddingsConfigLike } from "./types.ts";
import { InputError } from "../../../kernel/errors.ts";
import { handleError } from "../../debug/debug-system.ts";
import { resolveSharedMemoryConfig } from "../memory-config.ts";

export type EmbeddingVector = Float32Array;

export type EmbeddingsStats = Readonly<{
  loaded: boolean;
  loadMs: number;
  queries: number;
  totalQueryMs: number;
  avgQueryMs: number;
  modelId: string;
}>;

export type EmbeddingsProvider = Readonly<{
  init(): Promise<void>;
  isLoaded(): boolean;
  isAvailable(): boolean;
  embed(text: string): Promise<EmbeddingVector>;
  embedBatch(texts: readonly string[]): Promise<EmbeddingVector[]>;
  stats(): EmbeddingsStats;
  dispose(): Promise<void>;
}>;

let _provider: EmbeddingsProvider | null = null;
let _disposed = false;

type ExtractorOutput = { data: Float32Array; dims: number[] };
type ExtractorFn = (texts: string[], opts?: { pooling?: string; normalize?: boolean }) => Promise<ExtractorOutput>;

export function getEmbeddingsProvider(config: EmbeddingsConfigLike = {}): EmbeddingsProvider {
  if (_provider && !_disposed) return _provider;
  // The defaults come from the canonical memory-config owner, and they come
  // through its RESOLVER rather than from its default constant — this used to
  // be a hardcoded `"Xenova/all-MiniLM-L6-v2"` / `"fp32"` / `32` literal
  // triple, then a second copy of the owner's fill-in step. Now there is one
  // fill-in step and this asks it.
  const embeddings = resolveSharedMemoryConfig({
    embeddings: {
      ...(config.modelId === undefined ? {} : { modelId: config.modelId }),
      ...(config.dtype === undefined ? {} : { dtype: config.dtype }),
      ...(config.batchSize === undefined ? {} : { batchSize: config.batchSize }),
    },
  }).embeddings;
  const modelId = embeddings.modelId;
  const dtype = embeddings.dtype;
  const cacheDir = config.cacheDir;
  const wasmPaths = config.wasmPaths;
  const batchSize = embeddings.batchSize;

  let extractor: ExtractorFn | null = null;
  let loadingPromise: Promise<void> | null = null;
  let unavailable = false;
  let loadMs = 0;
  let queries = 0;
  let totalQueryMs = 0;

  const provider: EmbeddingsProvider = {
    async init() {
      if (extractor) return;
      if (loadingPromise) { await loadingPromise; return; }
      loadingPromise = (async () => {
        let transformers: typeof import("@xenova/transformers");
        try {
          transformers = await import("@xenova/transformers");
        } catch (importErr) {
          // The optional embeddings dependency is not installed — the
          // provider reports unavailable via isAvailable. Route through
          // the debug owner so the missing dep is observable.
          handleError(importErr, { module: "shared-memory-embeddings", operation: "import-transformers" });
          unavailable = true;
          return;
        }
        const env = transformers.env as {
          allowLocalModels: boolean;
          allowRemoteModels: boolean;
          cacheDir?: string;
          backends: { onnx: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } } };
        };
        env.allowLocalModels = true;
        env.allowRemoteModels = false; // offline-only (Landlock: no network)
        if (cacheDir) env.cacheDir = cacheDir;
        if (wasmPaths) env.backends.onnx.wasm.wasmPaths = wasmPaths;
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        const t0 = Date.now();
        const pipeline = transformers.pipeline as unknown as (
          task: string, model: string, opts?: { dtype?: string },
        ) => Promise<ExtractorFn>;
        try {
          extractor = await pipeline("feature-extraction", modelId, { dtype });
        } catch (e) {handleError(e, { module: "shared-memory-retrieval-embeddings", operation: "catch" });
          unavailable = true;
        }
        loadMs = Date.now() - t0;
      })();
      await loadingPromise;
    },
    isLoaded() { return extractor !== null; },
    isAvailable() { return !unavailable && extractor !== null; },
    async embed(text: string) {
      if (!extractor) {
        await this.init();
        if (!extractor) throw new InputError("embeddings provider unavailable");
      }
      const t0 = Date.now();
      const out = await extractor!([text], { pooling: "mean", normalize: true });
      const dt = Date.now() - t0;
      queries += 1;
      totalQueryMs += dt;
      const dim = out.dims[1] ?? 0;
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i += 1) v[i] = out.data[i] ?? 0;
      return v;
    },
    async embedBatch(texts: readonly string[]) {
      if (!extractor) {
        await this.init();
        if (!extractor) throw new InputError("embeddings provider unavailable");
      }
      if (texts.length === 0) return [];
      const out: EmbeddingVector[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const t0 = Date.now();
        const res = await extractor!(batch as string[], { pooling: "mean", normalize: true });
        const dt = Date.now() - t0;
        queries += batch.length;
        totalQueryMs += dt;
        const dim = res.dims[1] ?? 0;
        for (let j = 0; j < batch.length; j += 1) {
          const v = new Float32Array(dim);
          for (let k = 0; k < dim; k += 1) v[k] = res.data[j * dim + k] ?? 0;
          out.push(v);
        }
      }
      return out;
    },
    stats() {
      return {
        loaded: extractor !== null,
        loadMs,
        queries,
        totalQueryMs,
        avgQueryMs: queries === 0 ? 0 : totalQueryMs / queries,
        modelId,
      };
    },
    async dispose() {
      unavailable = true;
      extractor = null;
      loadingPromise = null;
    },
  };
  _provider = provider;
  _disposed = false;
  return provider;
}

/** Test helper: reset the singleton. NOT for production use. */
export function _resetEmbeddingsProviderForTests(): void {
  _provider = null;
  _disposed = false;
}
