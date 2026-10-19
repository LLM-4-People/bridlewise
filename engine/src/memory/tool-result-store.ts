/**
 * Tool-result-in-memory store (EXP433).
 *
 * The user's idea: instead of injecting the FULL result of every tool call
 * into the LLM context (where a 5000-token search result eats the context
 * budget), store the full result in a memory store and inject only a small
 * deterministic SUMMARY (1-2 lines). When the LLM needs details, it queries
 * the store via semantic retrieval (embeddings + TF-IDF) and gets back
 * only the RELEVANT chunks.
 *
 * Token flow:
 * WITHOUT store: 5000-token search result → context (5000 tokens spent).
 * WITH store: summary (100 tokens) → context; retrieve 500 tokens on
 * demand. Total 600 tokens. ~88% savings.
 *
 * Per the binding directives:
 * "Must re-use shared functions" — uses `estimateTokens` from
 * `memory-types.ts`, `deepFreeze`/`generateId` from `integrity.ts`, the
 * shared exposure system from `src/shared/exposure/`.
 * "No static constants" — every threshold/limit comes from
 * `ToolResultStoreConfig` (which the caller builds from the central
 * config contract).
 * "Exposed as many signals/actions/customization as possible" —
 * `tool-result-exposure.ts` registers signals/actions/customizations.
 *
 * Public API (no backward compatibility — full refactor per directive):
 * `createToolResultStore(options)` → store
 * `store.add(input)` → { id, summary, tokensSaved }
 * `store.retrieve(query, options?)` → relevant chunks (async, uses embeddings)
 * `store.getFullResult(id)` → full result (for explicit full-result requests)
 * `store.getSummary(id)` → summary
 * `store.tokenSavings` → aggregate savings
 * `store.stats` → counts, latencies, hit rate
 * `store.configure(partial)` → mutate config at runtime
 * `store.clear` → wipe the store
 */

import { deepFreeze, generateId } from "../kernel/integrity.ts";
import { estimateTokens } from "./memory-types.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import {
  buildTfidfIndex,
  chunkToolResult,
  cosine,
  createEmbeddingsRetriever,
  reciprocalRankFusion,
  resolveChunkConfig,
  resolveRetrievalConfig,
  tfidfQuery,
  type ChunkConfig,
  type EmbeddingsRetriever,
  type RetrievalConfig,
  type RetrievalMethod,
  type TfidfIndex,
} from "./tool-result-retrieval.ts";
import {
  resolveSummaryConfig,
  summarizeToolResult,
  type SummaryConfig,
} from "./tool-result-summary.ts";

/** Tool name alias (string for unknown tools; constrained at the summary layer). */
export type ToolResultToolName = string;

/** Stored entry. The full result lives in memory; only the summary enters the LLM context. */
export type ToolResultEntry = Readonly<{
  id: string;
  toolName: ToolResultToolName;
  args: Readonly<Record<string, unknown>>;
  fullResult: string;
  summary: string;
  chunks: readonly string[];
  chunkEmbeddings: readonly Float32Array[] | null;
  tfidfIndex: TfidfIndex | null;
  timestamp: number;
  turnId: number;
  tokens: Readonly<{ full: number; summary: number; chunks: number }>;
}>;

export type ToolResultStoreConfig = Readonly<{
  summary: SummaryConfig;
  chunk: ChunkConfig;
  retrieval: RetrievalConfig;
  /** Whether to compute embeddings on add (false → TF-IDF only). */
  enableEmbeddings: boolean;
  /** Maximum number of entries to keep (LRU eviction when exceeded). 0 = unlimited. */
  maxEntries: number;
  /** If the full result is below this many tokens, skip the store entirely
   * (return the full result directly) — for small results the summary
   * overhead exceeds the savings. 0 = always store. */
  skipIfSmallTokens: number;
}>;

export const TOOL_RESULT_STORE_DEFAULT_CONFIG = deepFreeze({
  summary: {
    topHitLimit: 5,
    readSymbolLimit: 8,
    pathTruncateLimit: 120,
    grepMatchLimit: 5,
  },
  chunk: {
    readChunkLines: 50,
    readChunkStride: 40,
    maxChunkChars: 1000,
  },
  retrieval: {
    method: "hybrid",
    topK: 5,
    minScore: 0.05,
    rrfK: 60,
    hybridEmbeddingsWeight: 0.6,
  },
  enableEmbeddings: true,
  maxEntries: 1000,
  skipIfSmallTokens: 200,
} as const);

export type AddToolResultInput = Readonly<{
  toolName: ToolResultToolName;
  args: Readonly<Record<string, unknown>>;
  fullResult: string;
  turnId: number;
}>;

export type AddToolResultOutput = Readonly<{
  id: string | null;
  summary: string;
  /** Tokens that would have been in context without the store. */
  tokensWithoutStore: number;
  /** Tokens actually in context with the store (summary only, or full if skipped). */
  tokensWithStore: number;
  tokensSaved: number;
  /** True when the store skipped (returned the full result directly) because the result was below skipIfSmallTokens. */
  skipped: boolean;
}>;

export type RetrieveResultChunk = Readonly<{
  text: string;
  chunkIndex: number;
  score: number;
}>;

export type RetrieveResult = Readonly<{
  entryId: string;
  toolName: ToolResultToolName;
  query: string;
  method: RetrievalMethod;
  chunks: readonly RetrieveResultChunk[];
  fullResultAvailable: true;
  retrievalMs: number;
}>;

export type TokenSavings = Readonly<{
  totalWithout: number;
  totalWith: number;
  totalSaved: number;
  savingsPercent: number;
  totalRetrieved: number;
  retrievalCount: number;
}>;

export type ToolResultStoreStats = Readonly<{
  entryCount: number;
  totalFullTokens: number;
  totalSummaryTokens: number;
  totalRetrievedTokens: number;
  totalSavedTokens: number;
  savingsPercent: number;
  retrievalCount: number;
  retrievalHits: number;
  retrievalMisses: number;
  avgRetrievalMs: number;
  embeddingsLoaded: boolean;
  embeddingsLoadMs: number;
  embeddingsQueries: number;
  embeddingsAvgQueryMs: number;
  skippedCount: number;
  storedCount: number;
}>;

export type ToolResultStore = Readonly<{
  readonly config: ToolResultStoreConfig;
  add(input: AddToolResultInput): Promise<AddToolResultOutput>;
  retrieve(query: string, options?: Partial<RetrievalConfig>): Promise<readonly RetrieveResult[]>;
  getFullResult(id: string): string | null;
  getSummary(id: string): string | null;
  list(): readonly ToolResultEntry[];
  tokenSavings(): TokenSavings;
  stats(): ToolResultStoreStats;
  configure(partial: DeepPartial<ToolResultStoreConfig>): void;
  clear(): void;
  setEmbeddingsRetriever(retriever: EmbeddingsRetriever): void;
  /** Number of skipped (small) vs stored (large) results since the store was created. */
  skipStats(): SkipStats;
}>;

/** Deep partial for `configure` — lets callers mutate nested fields without re-specifying the whole object. */
export type DeepPartial<T> = {
  readonly [K in keyof T]?: T[K] extends Readonly<Record<string, unknown>>
    ? DeepPartial<T[K]>
    : T[K];
};

export type ToolResultStoreOptions = Partial<ToolResultStoreConfig> & {
  embeddingsRetriever?: EmbeddingsRetriever;
};

/** Per-skip stats. */
export type SkipStats = Readonly<{
  skippedCount: number;
  storedCount: number;
}>;

/**
 * Create a tool-result-in-memory store. The store keeps full tool results
 * in memory, injects only summaries into LLM context, and retrieves
 * relevant chunks on demand via semantic search.
 */
export function createToolResultStore(
  options: ToolResultStoreOptions = {},
): ToolResultStore {
  let config: ToolResultStoreConfig = deepFreeze({
    summary: resolveSummaryConfig(options.summary ?? {}),
    chunk: resolveChunkConfig(options.chunk ?? {}),
    retrieval: resolveRetrievalConfig(options.retrieval ?? {}),
    enableEmbeddings: options.enableEmbeddings ?? true,
    maxEntries: options.maxEntries ?? 1000,
    skipIfSmallTokens: options.skipIfSmallTokens ?? 200,
  }) as ToolResultStoreConfig;

  const entries = new Map<string, ToolResultEntry>();
  const insertionOrder: string[] = [];
  let embeddingsRetriever: EmbeddingsRetriever =
    options.embeddingsRetriever ?? createEmbeddingsRetriever();

  let retrievalCount = 0;
  let retrievalHits = 0;
  let retrievalMisses = 0;
  let totalRetrievalMs = 0;
  let totalRetrievedTokens = 0;
  let skippedCount = 0;
  let storedCount = 0;

  function evictIfNeeded(): void {
    if (config.maxEntries <= 0) return;
    while (insertionOrder.length > config.maxEntries) {
      const oldestId = insertionOrder.shift();
      if (oldestId === undefined) break;
      entries.delete(oldestId);
    }
  }

  function effectiveRetrievalConfig(
    override?: Partial<RetrievalConfig>,
  ): RetrievalConfig {
    if (!override) return config.retrieval;
    return resolveRetrievalConfig({ ...config.retrieval, ...override });
  }

  async function computeEmbeddings(chunks: readonly string[]): Promise<Float32Array[] | null> {
    if (!config.enableEmbeddings) return null;
    try {
      await embeddingsRetriever.init();
      return await embeddingsRetriever.embedBatch(chunks);
    } catch (embedErr) {
      // Embeddings unavailable — fall back to TF-IDF retrieval. Routed
      // through the debug owner so the failure is observable.
      handleError(embedErr, { module: "memory-tool-result-store", operation: "compute-embeddings" });
      return null;
    }
  }

  async function rankEntry(
    query: string,
    queryEmb: Float32Array | null,
    entry: ToolResultEntry,
    rCfg: RetrievalConfig,
  ): Promise<readonly { chunkIndex: number; score: number }[]> {
    if (entry.chunks.length === 0) return [];
    const rankings: (readonly { chunkIndex: number; score: number }[])[] = [];
    const wantEmb = (rCfg.method === "embeddings" || rCfg.method === "hybrid");
    const wantTfidf = (rCfg.method === "tfidf" || rCfg.method === "hybrid");
    if (wantEmb && entry.chunkEmbeddings && entry.chunkEmbeddings.length === entry.chunks.length && queryEmb !== null) {
      const scores: { chunkIndex: number; score: number }[] = [];
      for (let i = 0; i < entry.chunkEmbeddings.length; i += 1) {
        const chunkEmb = entry.chunkEmbeddings[i];
        if (!chunkEmb) continue;
        const score = cosine(queryEmb, chunkEmb);
        scores.push({ chunkIndex: i, score });
      }
      scores.sort((a, b) => b.score - a.score);
      rankings.push(scores);
    }
    if (wantTfidf && entry.tfidfIndex) {
      rankings.push(tfidfQuery(query, entry.tfidfIndex));
    }
    if (rankings.length === 0) return [];
    if (rankings.length === 1) return rankings[0] ?? [];
    return reciprocalRankFusion(rankings, rCfg.rrfK);
  }

  return {
    get config() { return config; },

    async add(input) {
      const fullTokens = estimateTokens(input.fullResult);
      // Skip-if-small: for tiny results the summary overhead exceeds the
      // savings, so just return the full result directly (no storage).
      if (config.skipIfSmallTokens > 0 && fullTokens < config.skipIfSmallTokens) {
        skippedCount += 1;
        return {
          id: null,
          summary: input.fullResult,
          tokensWithoutStore: fullTokens,
          tokensWithStore: fullTokens,
          tokensSaved: 0,
          skipped: true,
        };
      }
      const summary = summarizeToolResult(
        input.toolName,
        input.args,
        input.fullResult,
        config.summary,
      );
      const chunks = chunkToolResult(input.toolName, input.fullResult, config.chunk);
      const chunkEmbeddings = (config.enableEmbeddings && chunks.length > 0)
        ? await computeEmbeddings(chunks)
        : null;
      const tfidfIndex = chunks.length > 0 ? buildTfidfIndex(chunks) : null;
      const id = generateId("toolres");
      const entry: ToolResultEntry = {
        id,
        toolName: input.toolName,
        args: deepFreeze({ ...input.args }) as Readonly<Record<string, unknown>>,
        fullResult: input.fullResult,
        summary,
        chunks: deepFreeze([...chunks]) as readonly string[],
        chunkEmbeddings: chunkEmbeddings ? [...chunkEmbeddings] as readonly Float32Array[] : null,
        tfidfIndex,
        timestamp: Date.now(),
        turnId: input.turnId,
        tokens: deepFreeze({
          full: fullTokens,
          summary: estimateTokens(summary),
          chunks: chunks.reduce((acc, c) => acc + estimateTokens(c), 0),
        }) as Readonly<{ full: number; summary: number; chunks: number }>,
      };
      entries.set(id, entry);
      insertionOrder.push(id);
      storedCount += 1;
      evictIfNeeded();
      return {
        id,
        summary,
        tokensWithoutStore: entry.tokens.full,
        tokensWithStore: entry.tokens.summary,
        tokensSaved: entry.tokens.full - entry.tokens.summary,
        skipped: false,
      };
    },

    async retrieve(query, options) {
      const start = Date.now();
      const rCfg = effectiveRetrievalConfig(options);
      // Embed the query ONCE per retrieve call, then reuse across all entries.
      // (Previously the query was re-embedded for every entry — O(N) embeddings
      // per retrieval, which made latency grow linearly with the store size.)
      let queryEmb: Float32Array | null = null;
      if ((rCfg.method === "embeddings" || rCfg.method === "hybrid") && config.enableEmbeddings) {
        try {
          queryEmb = await embeddingsRetriever.embed(query);
        } catch (e) {handleError(e, { module: "memory-tool-result-store", operation: "catch" });
          queryEmb = null;
        }
      }
      const results: RetrieveResult[] = [];
      for (const entry of entries.values()) {
        if (entry.chunks.length === 0) continue;
        const ranking = await rankEntry(query, queryEmb, entry, rCfg);
        if (ranking.length === 0) continue;
        const top = ranking.slice(0, rCfg.topK);
        const above = top.filter((r) => r.score >= rCfg.minScore);
        if (above.length === 0) continue;
        const entryChunks: RetrieveResultChunk[] = [];
        for (const r of above) {
          const text = entry.chunks[r.chunkIndex];
          if (text === undefined) continue;
          entryChunks.push({ text, chunkIndex: r.chunkIndex, score: r.score });
        }
        if (entryChunks.length === 0) continue;
        results.push({
          entryId: entry.id,
          toolName: entry.toolName,
          query,
          method: rCfg.method,
          chunks: entryChunks,
          fullResultAvailable: true,
          retrievalMs: 0,
        });
      }
      const elapsed = Date.now() - start;
      totalRetrievalMs += elapsed;
      retrievalCount += 1;
      if (results.length > 0) {
        retrievalHits += 1;
        for (const r of results) {
          for (const c of r.chunks) totalRetrievedTokens += estimateTokens(c.text);
        }
      } else {
        retrievalMisses += 1;
      }
      results.sort((a, b) => (b.chunks[0]?.score ?? 0) - (a.chunks[0]?.score ?? 0));
      return deepFreeze(results.map((r) => deepFreeze({ ...r, retrievalMs: elapsed }) as RetrieveResult)) as readonly RetrieveResult[];
    },

    getFullResult(id) {
      return entries.get(id)?.fullResult ?? null;
    },

    getSummary(id) {
      return entries.get(id)?.summary ?? null;
    },

    list() {
      return [...entries.values()];
    },

    tokenSavings() {
      let totalWithout = 0;
      let totalWith = 0;
      for (const e of entries.values()) {
        totalWithout += e.tokens.full;
        totalWith += e.tokens.summary;
      }
      const totalSaved = totalWithout - totalWith;
      return deepFreeze({
        totalWithout,
        totalWith,
        totalSaved,
        savingsPercent: totalWithout === 0 ? 0 : (100 * totalSaved) / totalWithout,
        totalRetrieved: totalRetrievedTokens,
        retrievalCount,
      }) as TokenSavings;
    },

    stats() {
      let totalFullTokens = 0;
      let totalSummaryTokens = 0;
      for (const e of entries.values()) {
        totalFullTokens += e.tokens.full;
        totalSummaryTokens += e.tokens.summary;
      }
      const embStats = embeddingsRetriever.stats();
      const totalSaved = totalFullTokens - totalSummaryTokens;
      return deepFreeze({
        entryCount: entries.size,
        totalFullTokens,
        totalSummaryTokens,
        totalRetrievedTokens,
        totalSavedTokens: totalSaved,
        savingsPercent: totalFullTokens === 0 ? 0 : (100 * totalSaved) / totalFullTokens,
        retrievalCount,
        retrievalHits,
        retrievalMisses,
        avgRetrievalMs: retrievalCount === 0 ? 0 : totalRetrievalMs / retrievalCount,
        embeddingsLoaded: embStats.loaded,
        embeddingsLoadMs: embStats.loadMs,
        embeddingsQueries: embStats.queries,
        embeddingsAvgQueryMs: embStats.avgQueryMs,
        skippedCount,
        storedCount,
      }) as ToolResultStoreStats;
    },

    configure(partial) {
      const next = {
        summary: partial.summary ? resolveSummaryConfig({ ...config.summary, ...partial.summary }) : config.summary,
        chunk: partial.chunk ? resolveChunkConfig({ ...config.chunk, ...partial.chunk }) : config.chunk,
        retrieval: partial.retrieval ? resolveRetrievalConfig({ ...config.retrieval, ...partial.retrieval }) : config.retrieval,
        enableEmbeddings: partial.enableEmbeddings ?? config.enableEmbeddings,
        maxEntries: partial.maxEntries ?? config.maxEntries,
        skipIfSmallTokens: partial.skipIfSmallTokens ?? config.skipIfSmallTokens,
      };
      config = deepFreeze(next) as ToolResultStoreConfig;
    },

    clear() {
      entries.clear();
      insertionOrder.length = 0;
      retrievalCount = 0;
      retrievalHits = 0;
      retrievalMisses = 0;
      totalRetrievalMs = 0;
      totalRetrievedTokens = 0;
      skippedCount = 0;
      storedCount = 0;
    },

    setEmbeddingsRetriever(retriever) {
      embeddingsRetriever = retriever;
    },

    skipStats() {
      return deepFreeze({ skippedCount, storedCount }) as SkipStats;
    },
  };
}
