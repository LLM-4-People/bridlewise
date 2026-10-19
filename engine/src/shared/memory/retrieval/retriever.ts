// src/shared/memory/retrieval/retriever.ts
// CANONICAL retrieval facade. Single entry point for ALL memory retrieval.
// Dispatches to the right method via RetrievalConfig.method and fuses
// results (RRF) for hybrid. Replaces the ad-hoc retrieval in
// memory-search.ts + tool-result-retrieval.ts.

import { buildInvertedIndex, invertedQuery } from "./inverted-index.ts";
import { buildTfidfIndex, tfidfQuery } from "./tfidf.ts";
import type { TextTokenizerConfig } from "./text-utils.ts";
import { cosineF32, cosineMaps } from "./cosine.ts";
import { getEmbeddingsProvider, type EmbeddingsProvider } from "./embeddings.ts";
import { reciprocalRankFusion } from "./rrf.ts";
import { deepFreeze } from "../../../kernel/integrity.ts";
import { buildHnswIndex, hnswQuery } from "./hnsw.ts";
import type { MemoryEntry, MemorySearchQuery, MemorySearchResult } from "../memory-entry.ts";
import type { RetrievalConfig } from "../memory-config.ts";
import type { RankHit } from "./types.ts";
import { handleError } from "../../debug/debug-system.ts";

export type RetrieverDeps = Readonly<{
  config: RetrievalConfig;
  tokenizer: TextTokenizerConfig;
  embeddings: EmbeddingsProvider;
}>;

// EXP436 root-cause fix: cache the built TF-IDF/inverted index per entries
// array so repeated queries on the same entry set DON'T rebuild the index.
// Previously `retrieve` called buildTfidfIndex/buildInvertedIndex on EVERY
// query → O(N·queries) rebuild cost. Now the index is built ONCE per unique
// entries array (keyed by reference via WeakMap) and reused across queries.
// The index is built on the FULL entry set (more accurate IDF); query filters
// are applied to the RESULTS, not the index.
type CachedIndex = Readonly<{
  tfidf: ReturnType<typeof buildTfidfIndex>;
  inverted: ReturnType<typeof buildInvertedIndex>;
  docs: readonly string[];
}>;

const indexCache = new WeakMap<readonly MemoryEntry[], CachedIndex>();

function getCachedIndex(entries: readonly MemoryEntry[], tokenizer: TextTokenizerConfig): CachedIndex {
  const cached = indexCache.get(entries);
  if (cached !== undefined) return cached;
  const docs = entries.map((e) => e.content);
  const built: CachedIndex = deepFreeze({
    tfidf: buildTfidfIndex(docs, tokenizer),
    inverted: buildInvertedIndex(docs, tokenizer),
    docs,
  });
  indexCache.set(entries, built);
  return built;
}

export function createRetriever(config: RetrievalConfig, tokenizer: TextTokenizerConfig, embeddings?: EmbeddingsProvider): RetrieverDeps {
  return { config, tokenizer, embeddings: embeddings ?? getEmbeddingsProvider() };
}

function applyFilters(entries: readonly MemoryEntry[], query: MemorySearchQuery): readonly MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const e of entries) {
    if (query.tier !== null && e.tier !== query.tier) continue;
    if (query.type !== null && e.type !== query.type) continue;
    if (query.provenance !== null && e.provenance !== query.provenance) continue;
    if (query.conversationId !== null && e.conversationId !== query.conversationId) continue;
    if (query.projectId !== null && e.projectId !== query.projectId) continue;
    if (query.fromTime !== null && e.timestamp < query.fromTime) continue;
    if (query.toTime !== null && e.timestamp > query.toTime) continue;
    if (query.tags.length > 0) {
      const set = new Set(e.tags);
      if (!query.tags.every((t) => set.has(t))) continue;
    }
    out.push(e);
  }
  return out;
}

function toResults(hits: readonly RankHit[], entries: readonly MemoryEntry[], matchedFields: readonly string[]): readonly MemorySearchResult[] {
  const out: MemorySearchResult[] = [];
  for (const h of hits) {
    const e = entries[h.docIndex];
    if (!e) continue;
    if (h.score < 0) continue;
    out.push({ entry: e, score: h.score, matchedFields });
  }
  return out;
}

/** Brute-force cosine over embeddings (exact; the default for <100k). */
function bruteForceEmbeddings(queryVec: Float32Array, entries: readonly MemoryEntry[], minScore: number, topK: number): readonly RankHit[] {
  const hits: RankHit[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || !e.embedding) continue;
    const s = cosineF32(queryVec, e.embedding);
    if (s >= minScore) hits.push({ docIndex: i, score: s });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

export async function retrieve(
  deps: RetrieverDeps,
  query: MemorySearchQuery,
  entries: readonly MemoryEntry[],
): Promise<readonly MemorySearchResult[]> {
  const filtered = applyFilters(entries, query);
  if (filtered.length === 0) return [];
  const { config, tokenizer } = deps;
  const text = query.text ?? "";
  const topK = query.limit === null ? config.topK : Math.min(query.limit, config.topK);

  if (text.length === 0) {
    // No text query — return filtered, most-recent first.
    const sorted = [...filtered].sort((a, b) => b.timestamp > a.timestamp ? 1 : -1);
    return sorted.slice(0, topK).map((e) => ({ entry: e, score: 1, matchedFields: ["filter"] }));
  }

  const method = config.method;

  // Build a set of indices (into the full entries array) that pass the filter,
  // so we can score against the cached full-entries index and filter results.
  const filteredIdxSet = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    if (filtered.includes(entries[i]!)) filteredIdxSet.add(i);
  }

  if (method === "tfidf") {
    const idx = getCachedIndex(entries, tokenizer);
    const hits = tfidfQuery(text, idx.tfidf, tokenizer)
      .filter((h) => h.score >= config.minScore && filteredIdxSet.has(h.docIndex))
      .slice(0, topK);
    return toResults(hits, entries, ["tfidf"]);
  }

  if (method === "inverted") {
    const idx = getCachedIndex(entries, tokenizer);
    const hits = invertedQuery(text, idx.inverted, tokenizer)
      .filter((h) => h.score >= config.minScore && filteredIdxSet.has(h.docIndex))
      .slice(0, topK);
    return toResults(hits, entries, ["inverted"]);
  }

  if (method === "hnsw") {
    const emb = deps.embeddings;
    if (!emb.isAvailable()) {
      const idx = getCachedIndex(entries, tokenizer);
      const hits = tfidfQuery(text, idx.tfidf, tokenizer)
        .filter((h) => h.score >= config.minScore && filteredIdxSet.has(h.docIndex))
        .slice(0, topK);
      return toResults(hits, entries, ["tfidf-fallback"]);
    }
    const qVec = await emb.embed(text);
    const withEmb = filtered.filter((e) => e.embedding !== null);
    const vecs = withEmb.map((e) => e.embedding!);
    const hIdx = buildHnswIndex(vecs, config.hnswM, config.hnswEfSearch);
    const hits = hnswQuery(qVec, hIdx, topK).filter((h) => h.score >= config.minScore);
    return toResults(hits, withEmb, ["hnsw"]);
  }

  if (method === "embeddings") {
    const emb = deps.embeddings;
    if (!emb.isAvailable()) {
      const idx = getCachedIndex(entries, tokenizer);
      const hits = tfidfQuery(text, idx.tfidf, tokenizer)
        .filter((h) => h.score >= config.minScore && filteredIdxSet.has(h.docIndex))
        .slice(0, topK);
      return toResults(hits, entries, ["tfidf-fallback"]);
    }
    const qVec = await emb.embed(text);
    const hits = bruteForceEmbeddings(qVec, filtered, config.minScore, topK);
    return toResults(hits, filtered, ["embeddings"]);
  }

  if (method === "tree") {
    const qType = classifyQueryType(text);
    const subtree = filtered.filter((e) => e.type === qType);
    const subtreeIdxSet = new Set<number>();
    for (let i = 0; i < entries.length; i++) {
      if (subtree.includes(entries[i]!)) subtreeIdxSet.add(i);
    }
    const idx = getCachedIndex(entries, tokenizer);
    const hits = tfidfQuery(text, idx.tfidf, tokenizer)
      .filter((h) => h.score >= config.minScore && subtreeIdxSet.has(h.docIndex))
      .slice(0, topK);
    return toResults(hits, entries, ["tree", qType]);
  }

  // hybrid (default)
  const idx = getCachedIndex(entries, tokenizer);
  const tfidfHits = tfidfQuery(text, idx.tfidf, tokenizer)
    .filter((h) => h.score >= config.minScore && filteredIdxSet.has(h.docIndex));
  const rankings: RankHit[][] = [tfidfHits as RankHit[]];
  if (deps.embeddings.isAvailable()) {
    try {
      const qVec = await deps.embeddings.embed(text);
      const embHits = bruteForceEmbeddings(qVec, filtered, 0, config.topK * 2);
      rankings.push(embHits as RankHit[]);
    } catch (e) {handleError(e, { module: "shared-memory-retrieval-retriever", operation: "catch" });
      // embeddings failed — fall back to TF-IDF only (don't swallow silently;
      // reported via retriever stats in the store).
      rankings.push([]);
    }
  }
  const fused = reciprocalRankFusion(rankings, config.rrfK).slice(0, topK);
  return toResults(fused, filtered, ["hybrid"]);
}

/** Heuristic query-type classifier (configurable; used by tree traversal).
 * Maps a query to a MemoryType so retrieval can prune the tree. */
export function classifyQueryType(text: string): import("../memory-config.ts").MemoryType {
  const t = text.toLowerCase();
  if (/\b(error|fail|crash|bug|exception|broken)\b/.test(t)) return "error";
  if (/\b(decide|decision|choice|should we|approve|reject)\b/.test(t)) return "decision";
  if (/\b(tool|search|grep|read|fetch|run|exec|result)\b/.test(t)) return "tool-result";
  if (/\b(fact|is|define|what is|means|equals)\b/.test(t)) return "fact";
  if (/\b(observe|notice|saw|found|seen|state)\b/.test(t)) return "observation";
  return "summary";
}

export { cosineMaps };
