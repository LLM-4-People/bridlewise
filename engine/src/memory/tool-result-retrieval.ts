/**
 * Semantic retrieval for the tool-result-in-memory store (EXP433).
 *
 * Two strategies with a clean fallback chain:
 * 1. Embeddings (preferred) — `@xenova/transformers` with the
 * `all-MiniLM-L6-v2` model (384-dim, 22 MB on disk, Apache-2.0).
 * Selected by EXP397 as the harness's optional embedding dependency
 * for memory retrieval (+60pp recall over TF-IDF on paraphrased
 * queries with zero token overlap). For tool-result retrieval this
 * matters: an LLM asking "where is the assertion creator?" should
 * retrieve chunks from a `search_code` query that ran for
 * `makeAssertNode`, even when the LLM's words differ.
 * 2. TF-IDF (offline fallback) — pure TS, zero deps. Used when the
 * `@xenova/transformers` package is not installed, when the model
 * file is missing, or when the operator configures
 * `toolResult.retrievalMethod = "tfidf"`. Recall is worse on
 * zero-overlap queries (EXP397: 13% vs 73%) but lexical retrieval
 * is correct for queries that share tokens with the result.
 * 3. Hybrid (RRF) — reciprocal-rank fusion of embeddings + TF-IDF.
 * Best of both when both methods are available: lexical retrieval
 * catches exact-keyword queries, embeddings catch paraphrases.
 *
 * Per the binding directives ("Everything dynamically computed" + "No
 * static constants"), every threshold/weight here is configurable through
 * `RetrievalConfig`. The chunk-size and stride come from the same config
 * (no hardcoded magic numbers).
 *
 * Honest attribution: the embeddings model is loaded lazily on the first
 * `embed` call. Cold-load latency (~150ms on this machine) is reported
 * via `embeddingsStats`. Subsequent `embed` calls are <5ms.
 */

import { deepFreeze } from "../kernel/integrity.ts";
import {
  buildTfidfIndex as buildTfidfIndexShared,
  tfidfQuery as tfidfQueryShared,
} from "../shared/memory/retrieval/tfidf.ts";
import {
  tokenize as sharedTokenize,
  termFrequency as sharedTermFrequency,
  type TextTokenizerConfig,
} from "../shared/memory/retrieval/text-utils.ts";
import { InputError } from "../kernel/errors.ts";

/** Re-export the canonical cosine implementations (single owner: shared/memory/retrieval/cosine.ts). */
export { cosineF32 as cosine, cosineNormalizedF32 as cosineNormalized } from "../shared/memory/retrieval/cosine.ts";

/** Chunking configuration. */
export type ChunkConfig = Readonly<{
  /** Number of lines per chunk for `read_file` results. */
  readChunkLines: number;
  /** Stride (lines) between chunks for `read_file`. Stride < chunkLines gives overlap. */
  readChunkStride: number;
  /** Maximum characters per chunk for non-line-oriented results. */
  maxChunkChars: number;
}>;

const CHUNK_DEFAULT_CONFIG = deepFreeze({
  readChunkLines: 50,
  readChunkStride: 40,
  maxChunkChars: 1000,
} as const) as ChunkConfig;

export function resolveChunkConfig(input: Partial<ChunkConfig>): ChunkConfig {
  const cfg = { ...CHUNK_DEFAULT_CONFIG, ...input };
  if (cfg.readChunkLines < 1 || !Number.isFinite(cfg.readChunkLines)) {
    throw new InputError("chunk.readChunkLines must be a positive finite number");
  }
  if (cfg.readChunkStride < 1 || cfg.readChunkStride > cfg.readChunkLines) {
    throw new InputError("chunk.readChunkStride must be in [1, readChunkLines]");
  }
  if (cfg.maxChunkChars < 64 || !Number.isFinite(cfg.maxChunkChars)) {
    throw new InputError("chunk.maxChunkChars must be >= 64 and finite");
  }
  return deepFreeze(cfg) as ChunkConfig;
}

/** Retrieval method selector. */
export const RETRIEVAL_METHODS = deepFreeze(["embeddings", "tfidf", "hybrid"] as const);
export type RetrievalMethod = typeof RETRIEVAL_METHODS[number];

export type RetrievalConfig = Readonly<{
  method: RetrievalMethod;
  topK: number;
  minScore: number;
  /** RRF k constant (smoothing). 60 is the standard value from the literature. */
  rrfK: number;
  /** Weight for embeddings in hybrid mode (0..1; TF-IDF gets 1 - this). */
  hybridEmbeddingsWeight: number;
}>;

const RETRIEVAL_DEFAULT_CONFIG = deepFreeze({
  method: "hybrid",
  topK: 5,
  minScore: 0.05,
  rrfK: 60,
  hybridEmbeddingsWeight: 0.6,
} as const) as RetrievalConfig;

export function resolveRetrievalConfig(input: Partial<RetrievalConfig>): RetrievalConfig {
  const cfg = { ...RETRIEVAL_DEFAULT_CONFIG, ...input };
  if (!RETRIEVAL_METHODS.includes(cfg.method)) {
    throw new InputError(`retrieval.method must be one of ${RETRIEVAL_METHODS.join("|")}`);
  }
  if (cfg.topK < 1 || !Number.isFinite(cfg.topK)) {
    throw new InputError("retrieval.topK must be a positive finite number");
  }
  if (cfg.minScore < 0 || cfg.minScore > 1 || !Number.isFinite(cfg.minScore)) {
    throw new InputError("retrieval.minScore must be in [0, 1]");
  }
  if (cfg.rrfK < 1 || !Number.isFinite(cfg.rrfK)) {
    throw new InputError("retrieval.rrfK must be >= 1 and finite");
  }
  if (cfg.hybridEmbeddingsWeight < 0 || cfg.hybridEmbeddingsWeight > 1 || !Number.isFinite(cfg.hybridEmbeddingsWeight)) {
    throw new InputError("retrieval.hybridEmbeddingsWeight must be in [0, 1]");
  }
  return deepFreeze(cfg) as RetrievalConfig;
}

/** Chunk a tool result for retrieval. The chunking strategy depends on the tool. */
export function chunkToolResult(
  toolName: string,
  fullResult: string,
  config: ChunkConfig = CHUNK_DEFAULT_CONFIG,
): readonly string[] {
  if (fullResult.length === 0) return [];
  if (toolName === "read_file") {
    const lines = fullResult.split("\n");
    const chunks: string[] = [];
    for (let i = 0; i < lines.length; i += config.readChunkStride) {
      const slice = lines.slice(i, i + config.readChunkLines).join("\n");
      if (slice.length > 0) chunks.push(slice);
      if (i + config.readChunkLines >= lines.length) break;
    }
    return chunks;
  }
  // search_code / grep: each line is a chunk (lines are short, structured).
  // For very long lines (rare), fall back to character-window chunking.
  const lines = fullResult.split("\n").filter((l) => l.length > 0);
  const chunks: string[] = [];
  for (const line of lines) {
    if (line.length <= config.maxChunkChars) {
      chunks.push(line);
    } else {
      for (let i = 0; i < line.length; i += config.maxChunkChars) {
        chunks.push(line.slice(i, i + config.maxChunkChars));
      }
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Embeddings retriever — lazy-loaded singleton.
// ---------------------------------------------------------------------------

export type EmbeddingsStats = Readonly<{
  loaded: boolean;
  loadMs: number;
  queries: number;
  totalQueryMs: number;
  avgQueryMs: number;
}>;

export type EmbeddingsRetriever = Readonly<{
  init(): Promise<void>;
  isLoaded(): boolean;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: readonly string[]): Promise<Float32Array[]>;
  stats(): EmbeddingsStats;
}>;

/** Lazily-loaded embeddings retriever. Resolves the model from local cache only (offline). */
export function createEmbeddingsRetriever(options?: {
  /** Override the cache directory (default: use the package's bundled.cache). */
  cacheDir?: string;
  /** Override the model id (default: Xenova/all-MiniLM-L6-v2). */
  modelId?: string;
  /** Override the wasm path for onnxruntime-web (default: auto-detect from node_modules). */
  wasmPaths?: string;
}): EmbeddingsRetriever {
  type ExtractorOutput = { data: Float32Array; dims: number[] };
  type ExtractorFn = (texts: string[], opts?: { pooling?: string; normalize?: boolean }) => Promise<ExtractorOutput>;
  let extractor: ExtractorFn | null = null;
  let loadingPromise: Promise<void> | null = null;
  let loadMs = 0;
  let queries = 0;
  let totalQueryMs = 0;
  const cacheDir = options?.cacheDir;
  const modelId = options?.modelId ?? "Xenova/all-MiniLM-L6-v2";
  const wasmPaths = options?.wasmPaths;
  return {
    async init() {
      if (extractor) return;
      if (loadingPromise) { await loadingPromise; return; }
      loadingPromise = (async () => {
        const transformers = await import("@xenova/transformers");
        const env = transformers.env as {
          allowLocalModels: boolean;
          allowRemoteModels: boolean;
          cacheDir?: string;
          backends: { onnx: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } } };
        };
        env.allowLocalModels = true;
        env.allowRemoteModels = false;
        if (cacheDir) env.cacheDir = cacheDir;
        if (wasmPaths) env.backends.onnx.wasm.wasmPaths = wasmPaths;
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        const t0 = Date.now();
        const pipeline = transformers.pipeline as unknown as (
          task: string,
          model: string,
          opts?: { dtype?: string },
        ) => Promise<ExtractorFn>;
        extractor = await pipeline("feature-extraction", modelId, { dtype: "fp32" });
        loadMs = Date.now() - t0;
      })();
      await loadingPromise;
    },
    isLoaded() { return extractor !== null; },
    async embed(text: string) {
      if (!extractor) {
        await (loadingPromise ?? this.init());
        if (!extractor) throw new InputError("embeddings retriever failed to load");
      }
      const t0 = Date.now();
      const out = await extractor([text], { pooling: "mean", normalize: true });
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
        await (loadingPromise ?? this.init());
        if (!extractor) throw new InputError("embeddings retriever failed to load");
      }
      if (texts.length === 0) return [];
      const t0 = Date.now();
      const out = await extractor([...texts], { pooling: "mean", normalize: true });
      const dt = Date.now() - t0;
      queries += texts.length;
      totalQueryMs += dt;
      const dim = out.dims[1] ?? 0;
      const result: Float32Array[] = [];
      for (let j = 0; j < texts.length; j += 1) {
        const v = new Float32Array(dim);
        for (let k = 0; k < dim; k += 1) v[k] = out.data[j * dim + k] ?? 0;
        result.push(v);
      }
      return result;
    },
    stats() {
      return {
        loaded: extractor !== null,
        loadMs,
        queries,
        totalQueryMs,
        avgQueryMs: queries === 0 ? 0 : totalQueryMs / queries,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// TF-IDF retriever — pure TS, zero deps.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","do","does","did",
  "to","of","in","on","for","with","that","this","these","those","it","its",
  "as","at","by","from","or","and","not","no","but","if","then","than","so",
  "such","where","which","who","whom","whose","when","why","how","what",
  "i","you","he","she","we","they","me","him","her","us","them","my","your",
  "his","their","our","function","method","module","file","code","find",
  "give","show","tell","get","want","need","help","use","using","used",
  "please","can","could","would","should","may","might","will","shall",
  "has","have","had","there","here","thing","stuff","something","about",
  "into","out","up","down","over","under","again","once","also","any","all",
]);

/** Tokenizer config for tool-result retrieval — delegates to the canonical tokenize. */
const TOOL_RESULT_TOKENIZER_CONFIG: TextTokenizerConfig = {
  minLength: 2,
  stopwords: STOPWORDS,
  keepCodePunct: true,
};

/** Delegate to the canonical tokenize (single owner: shared/memory/retrieval/text-utils.ts). */
export function tokenize(text: string): readonly string[] {
  return sharedTokenize(text, TOOL_RESULT_TOKENIZER_CONFIG);
}

export type TfidfIndex = Readonly<{
  /** Per-chunk term-frequency vectors. */
  readonly chunkVectors: readonly ReadonlyMap<string, number>[];
  /** Inverse document frequency per term. */
  readonly idf: ReadonlyMap<string, number>;
  /** The chunks the index was built from. */
  readonly chunks: readonly string[];
}>;

/** Delegate to the canonical termFrequency (single owner: shared/memory/retrieval/text-utils.ts). */
export function termFrequency(tokens: readonly string[]): Map<string, number> {
  return sharedTermFrequency(tokens);
}

/** Build a TF-IDF index over a set of chunks — delegates to the canonical TF-IDF owner. */
export function buildTfidfIndex(chunks: readonly string[]): TfidfIndex {
  const shared = buildTfidfIndexShared(chunks, TOOL_RESULT_TOKENIZER_CONFIG);
  return deepFreeze({
    chunkVectors: shared.docVectors,
    idf: shared.idf,
    chunks,
  }) as TfidfIndex;
}

/** Score a query against a TF-IDF index — delegates to the canonical TF-IDF owner. */
export function tfidfQuery(
  query: string,
  index: TfidfIndex,
): readonly { chunkIndex: number; score: number }[] {
  const hits = tfidfQueryShared(
    query,
    { docVectors: index.chunkVectors, idf: index.idf, docCount: index.chunks.length },
    TOOL_RESULT_TOKENIZER_CONFIG,
  );
  return hits.map((h) => ({ chunkIndex: h.docIndex, score: h.score }));
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF) for hybrid mode.
// ---------------------------------------------------------------------------

export function reciprocalRankFusion(
  rankings: readonly (readonly { chunkIndex: number; score: number }[])[],
  k: number,
): readonly { chunkIndex: number; score: number }[] {
  const rrfScores = new Map<number, number>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank += 1) {
      const entry = ranking[rank];
      if (!entry) continue;
      const contribution = 1 / (k + rank + 1);
      rrfScores.set(entry.chunkIndex, (rrfScores.get(entry.chunkIndex) ?? 0) + contribution);
    }
  }
  const fused = [...rrfScores.entries()].map(([chunkIndex, score]) => ({ chunkIndex, score }));
  fused.sort((a, b) => b.score - a.score);
  return fused;
}
