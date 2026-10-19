/**
 * Embeddings provider (all-MiniLM-L6-v2) with TF-IDF fallback.
 *
 * From EXP397/433: `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2`
 * (384-dim, 22MB on disk, Apache-2.0). Lazy-loaded on first `embed`
 * call; cold-load ~150-200ms; subsequent calls <5ms. Selected by EXP397
 * as the harness's optional embedding dependency for memory retrieval
 * (+60pp recall over TF-IDF on paraphrased queries with zero token
 * overlap, +0% FP on 20 drift pairs).
 *
 * Offline-only: `allowRemoteModels = false` — never downloads. The model
 * must be in the local cache (`node_modules/@xenova/transformers/.cache/`).
 * If the package or model is missing, the provider returns `available =
 * false` and the retriever falls back to TF-IDF (per the binding
 * directive: unsupported tooling must produce a typed blocker, not
 * silently swallow).
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";

export type EmbeddingsConfig = Readonly<{
  modelId: string;
  dtype: "fp32" | "fp16" | "q8" | "int8" | "uint8";
  cacheDir: string | null;
  enabled: boolean;
}>;

/**
 * Module-private: `resolveEmbeddingsConfig` below is the resolver and the only
 * correct reader. Ask `resolveEmbeddingsConfig()` for the defaulted document.
 */
const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = deepFreeze({
  modelId: "Xenova/all-MiniLM-L6-v2",
  dtype: "fp32" as const,
  cacheDir: null,
  enabled: true,
});

export function resolveEmbeddingsConfig(overrides: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig {
  const cfg: EmbeddingsConfig = {
    modelId: overrides.modelId ?? DEFAULT_EMBEDDINGS_CONFIG.modelId,
    dtype: overrides.dtype ?? DEFAULT_EMBEDDINGS_CONFIG.dtype,
    cacheDir: overrides.cacheDir ?? null,
    enabled: overrides.enabled ?? DEFAULT_EMBEDDINGS_CONFIG.enabled,
  };
  if (cfg.modelId.length === 0) throw new InputError("embeddings.modelId must be non-empty");
  return deepFreeze(cfg) as EmbeddingsConfig;
}

export type EmbeddingsStats = Readonly<{
  loaded: boolean;
  loadMs: number;
  queries: number;
  totalQueryMs: number;
  avgQueryMs: number;
  dims: number;
  available: boolean;
}>;

export interface EmbeddingsProvider {
  readonly config: EmbeddingsConfig;
  isAvailable(): boolean;
  init(): Promise<void>;
  isLoaded(): boolean;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]>;
  stats(): EmbeddingsStats;
  resetStats(): void;
}

type ExtractorOutput = { data: Float32Array; dims: number[] };
type ExtractorFn = (texts: string[], opts?: { pooling?: string; normalize?: boolean }) => Promise<ExtractorOutput>;

export function createEmbeddingsProvider(options?: Partial<EmbeddingsConfig> & {
  wasmPaths?: string;
}): EmbeddingsProvider {
  const config = resolveEmbeddingsConfig(options ?? {});
  let extractor: ExtractorFn | null = null;
  let loadingPromise: Promise<void> | null = null;
  let loadMs = 0;
  let queries = 0;
  let totalQueryMs = 0;
  let dims = 0;
  let unavailable = false;
  const wasmPaths = options?.wasmPaths;

  return {
    config,
    isAvailable() {
      return !unavailable && config.enabled;
    },
    async init() {
      if (extractor) return;
      if (loadingPromise) { await loadingPromise; return; }
      if (unavailable) return;
      if (!config.enabled) { unavailable = true; return; }
      loadingPromise = (async () => {
        try {
          // Optional peer: keep TypeScript from resolving it as a required
          // module in the default install. The loader reports unavailable when
          // the host has not installed it.
          const transformersSpecifier = "@xenova/transformers";
          const transformers = await import(transformersSpecifier);
          const env = transformers.env as {
            allowLocalModels: boolean;
            allowRemoteModels: boolean;
            cacheDir?: string;
            backends: { onnx: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } } };
          };
          env.allowLocalModels = true;
          env.allowRemoteModels = false;
          if (config.cacheDir) env.cacheDir = config.cacheDir;
          if (wasmPaths) env.backends.onnx.wasm.wasmPaths = wasmPaths;
          env.backends.onnx.wasm.numThreads = 1;
          env.backends.onnx.wasm.proxy = false;
          const t0 = Date.now();
          const pipeline = transformers.pipeline as unknown as (
            task: string,
            model: string,
            opts?: { dtype?: string },
          ) => Promise<ExtractorFn>;
          extractor = await pipeline("feature-extraction", config.modelId, { dtype: config.dtype });
          loadMs = Date.now() - t0;
        } catch (err) {
          unavailable = true;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[embeddings] unavailable: ${msg}\n`);
        }
      })();
      await loadingPromise;
    },
    isLoaded() {
      return extractor !== null;
    },
    async embed(text: string) {
      if (!extractor) {
        await (loadingPromise ?? this.init());
        if (!extractor) throw new InputError("embeddings provider failed to load (unavailable)");
      }
      const t0 = Date.now();
      const out = await extractor([text], { pooling: "mean", normalize: true });
      const dt = Date.now() - t0;
      queries += 1;
      totalQueryMs += dt;
      dims = out.dims[1] ?? out.data.length;
      return out.data as Float32Array;
    },
    async embedBatch(texts: readonly string[]) {
      if (!extractor) {
        await (loadingPromise ?? this.init());
        if (!extractor) throw new InputError("embeddings provider failed to load (unavailable)");
      }
      const t0 = Date.now();
      const out = await extractor([...texts], { pooling: "mean", normalize: true });
      const dt = Date.now() - t0;
      queries += texts.length;
      totalQueryMs += dt;
      dims = out.dims[1] ?? (out.data.length / Math.max(1, texts.length));
      const dim = dims;
      const outArr = out.data as Float32Array;
      const result: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 1) {
        result.push(outArr.subarray(i * dim, (i + 1) * dim) as Float32Array);
      }
      return result;
    },
    stats() {
      return deepFreeze({
        loaded: extractor !== null,
        loadMs,
        queries,
        totalQueryMs,
        avgQueryMs: queries > 0 ? totalQueryMs / queries : 0,
        dims,
        available: !unavailable && config.enabled,
      }) as EmbeddingsStats;
    },
    resetStats() {
      queries = 0;
      totalQueryMs = 0;
    },
  };
}

/** Cosine similarity for two equal-length Float32Arrays (already normalized → dot product). */
export function cosineNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new InputError(`cosineNormalized: length mismatch ${a.length} vs ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    s += av * bv;
  }
  return s;
}

/** Cosine similarity for two arbitrary Float32Arrays. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new InputError(`cosine: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
