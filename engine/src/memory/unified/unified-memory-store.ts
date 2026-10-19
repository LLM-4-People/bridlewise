/**
 * Unified memory store — combines ALL 10 techniques:
 *
 * 1. TF-IDF (lexical, from EXP351) — implemented via the inverted index.
 * 2. Embeddings (all-MiniLM-L6-v2, from EXP397/433) — cosine over
 * normalized 384-dim vectors, lazy-loaded.
 * 3. Hybrid (TF-IDF + embeddings RRF, from EXP433) — reciprocal-rank
 * fusion of both rankings.
 * 4. Ebbinghaus (retention scheduling, from EXP202/353/418) — R(t) =
 * e^(-t/S), FSRS-4 reinforcement, fading boost, prune.
 * 5. Trust enforcement (cascade, from EXP394/360) — see TrustEnforcer.
 * 6. Drift detection (gemma-only 0% FP, from EXP416) — see DriftDetector.
 * 7. Trim with continuity (C09+summary, from EXP435) — see ConversationSummary.
 * 8. Proactive-injection query classification (from EXP420) — see createClassifier.
 * 9. Tool results in memory (95.1% savings, from EXP433) — see ToolResultStore.
 * 10. Inverted index (1.8ms retrieve at 1M, from EXP418) — see InvertedIndex.
 *
 * The store is the single source of truth for memory entries; the
 * context manager owns the conversation window; the trust enforcer
 * owns the cascade; the drift detector owns the topic-vector drift
 * check. Each subsystem has one canonical owner (DRY directive).
 *
 * Per `separateLossyHistoriesAllowed: false`, the in-memory store is a
 * rebuildable projection, never a parallel history.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOwnedTemporaryDirectory } from "../../filesystem/private-state.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import {
  applyFadingBoost,
  reinforce as ebbinghausReinforce,
  retention as ebbinghausRetention,
  shouldPrune as ebbinghausShouldPrune,
} from "./ebbinghaus.ts";
import { ContentStore } from "./content-store.ts";
import { cosine as cosineEmbeddings, cosineNormalized, type EmbeddingsProvider } from "./unified-embeddings.ts";
import { InvertedIndex } from "./unified-inverted-index.ts";
import { LruCache } from "./cache.ts";
import { estimateTokens, semanticHash, tokenize, termFrequency } from "./tokenizer.ts";
import type { UnifiedConfig } from "./unified-config.ts";
import { handleError } from "../../shared/debug/debug-system.ts";

export type MemoryKind = "fact" | "turn" | "tool-result" | "decision" | "observation" | "summary" | "awareness";

export interface UnifiedMemoryEntry {
  readonly id: number;
  readonly turn: number;
  readonly role: "system" | "user" | "assistant";
  readonly hash: string;
  readonly tokens: number;
  readonly kind: MemoryKind;
  readonly tags: string[];
  readonly topic: string | null;
  readonly conversationId: string | null;
  readonly timestamp: string;
  strength: number;
  accessCount: number;
  lastAccessedTurn: number;
  readonly storedAt: number;
  embedding: Float32Array | null;
}

export interface RetrievedMemory {
  readonly id: number;
  readonly turn: number;
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly similarity: number;
  readonly score: number;
  readonly retention: number;
  readonly strength: number;
  readonly kind: MemoryKind;
  readonly tags: string[];
  readonly topic: string | null;
  readonly hash: string;
}

export interface UnifiedMemoryStore {
  readonly config: UnifiedConfig;
  readonly entries: readonly UnifiedMemoryEntry[];
  readonly size: number;
  readonly embeddingsProvider: EmbeddingsProvider;
  add(input: AddMemoryInput): UnifiedMemoryEntry | null;
  addBulk(items: ReadonlyArray<AddMemoryInput>): { added: number; duplicates: number };
  retrieve(queryText: string, topK: number, threshold: number, currentTurn: number, hotModules?: readonly string[]): Promise<readonly RetrievedMemory[]>;
  /** Compute embeddings for entries that don't have them yet. */
  computeEmbeddings(filter?: (entry: UnifiedMemoryEntry) => boolean): Promise<number>;
  /** Wait for pending embedding computations. */
  waitForEmbeddings(): Promise<void>;
  getContent(entry: UnifiedMemoryEntry): string;
  getEntry(id: number): UnifiedMemoryEntry | null;
  pruneFaded(currentTurn: number): number;
  recomputeAllTfidf(): void;
  finalize(): void;
  close(): void;
  destroy(): void;
  stats(): UnifiedMemoryStats;
  setEmbeddingsProvider(provider: EmbeddingsProvider): void;
}

export type AddMemoryInput = Readonly<{
  turn: number;
  role: "system" | "user" | "assistant";
  content: string;
  kind: MemoryKind;
  tags?: readonly string[];
  topic?: string | null;
  conversationId?: string | null;
  timestamp?: string;
  computeEmbedding?: boolean;
}>;

export type UnifiedMemoryStats = Readonly<{
  totalEntriesStored: number;
  retrievals: number;
  relevantInjections: number;
  totalReinforced: number;
  totalPruned: number;
  duplicateDedups: number;
  embeddings: Readonly<{
    available: boolean;
    loaded: boolean;
    loadMs: number;
    queries: number;
    avgQueryMs: number;
    dims: number;
  }>;
  invertedIndex: Readonly<{
    postings: number;
    finalized: boolean;
  }>;
  contentStoreBytes: number;
  lruHits: number;
  lruMisses: number;
  heapUsedMB: number;
}>;

const NULL_INDEX = 0xffffffff;

export function createUnifiedMemoryStore(config: UnifiedConfig, options?: {
  embeddingsProvider?: EmbeddingsProvider;
  contentPath?: string;
}): UnifiedMemoryStore {
  const cfg = config;
  const entries: UnifiedMemoryEntry[] = [];
  const df = new Map<string, number>();
  const hashToId = new Map<string, number>();
  const invertedIndex = new InvertedIndex(cfg.invertedIndexInitialCapacity);
  // No configured path: a file in an owned temporary folder of this process
  // (removed when it exits), never a predictable name in the shared temp root.
  const contentPath = options?.contentPath ?? cfg.contentStorePath ?? join(createOwnedTemporaryDirectory(tmpdir(), "unified-memory-"), "content.bin");
  const contentStore = new ContentStore(contentPath, cfg.invertedIndexInitialCapacity);
  const lruCache = cfg.lruCacheCapacity > 0 ? new LruCache<string, RetrievedMemory[]>(cfg.lruCacheCapacity) : null;
  let embeddingsProvider = options?.embeddingsProvider ?? null;
  let idToIndex = new Uint32Array(cfg.invertedIndexInitialCapacity);
  idToIndex.fill(NULL_INDEX);
  let indexFinalized = false;
  let totalEntriesStored = 0;
  let retrievals = 0;
  let relevantInjections = 0;
  let totalReinforced = 0;
  let totalPruned = 0;
  let duplicateDedups = 0;
  let lruHits = 0;
  let lruMisses = 0;

  function ensureIdCapacity(id: number): void {
    if (id < idToIndex.length) return;
    let cap = idToIndex.length;
    while (cap <= id) cap *= 2;
    const grown = new Uint32Array(cap);
    grown.fill(NULL_INDEX);
    grown.set(idToIndex);
    idToIndex = grown;
    contentStore.ensureCapacity(cap);
    invertedIndex.ensureCapacity(cap);
  }

  function idf(term: string): number {
    const n = entries.length;
    const d = df.get(term) ?? 0;
    return Math.log((1 + n) / (1 + d)) + 1;
  }

  function tfidfVector(tokens: readonly string[]): Map<string, number> {
    const tf = termFrequency(tokens);
    const vec = new Map<string, number>();
    for (const [term, tfVal] of tf) vec.set(term, tfVal * idf(term));
    let norm = 0;
    for (const v of vec.values()) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (const [k, v] of vec) vec.set(k, v / norm);
    return vec;
  }

  function retentionValue(entry: UnifiedMemoryEntry, currentTurn: number): number {
    const t = currentTurn - (entry.lastAccessedTurn || entry.turn);
    return ebbinghausRetention(t, entry.strength);
  }

  function reinforceEntry(entry: UnifiedMemoryEntry, currentTurn: number): void {
    const r = retentionValue(entry, currentTurn);
    entry.strength = ebbinghausReinforce(entry.strength, entry.accessCount + 1, r, cfg.ebbinghaus.decayReinforceGain);
    entry.accessCount += 1;
    entry.lastAccessedTurn = currentTurn;
    totalReinforced += 1;
  }

  async function waitForEmbeddingsImpl(): Promise<void> {
    if (embeddingsProvider === null || !embeddingsProvider.isAvailable()) return;
    await embeddingsProvider.init();
    // Yield to allow pending.then callbacks to complete.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function computeEmbeddingsImpl(filter?: (entry: UnifiedMemoryEntry) => boolean): Promise<number> {
    if (embeddingsProvider === null || !embeddingsProvider.isAvailable()) return 0;
    await embeddingsProvider.init();
    if (!embeddingsProvider.isLoaded()) return 0;
    const toCompute = filter ? entries.filter(filter) : entries.filter((e) => e.embedding === null);
    if (toCompute.length === 0) return 0;
    const contents = toCompute.map((e) => contentStore.get(e.id));
    const batchSize = cfg.embeddingBatchSize;
    let computed = 0;
    for (let i = 0; i < contents.length; i += batchSize) {
      const batch = contents.slice(i, i + batchSize);
      const embs = await embeddingsProvider.embedBatch(batch);
      for (let j = 0; j < embs.length; j += 1) {
        const entry = toCompute[i + j];
        if (entry !== undefined) {
          entry.embedding = embs[j] ?? null;
          computed += 1;
        }
      }
    }
    return computed;
  }

  return {
    config: cfg,
    get entries() {
      return entries as readonly UnifiedMemoryEntry[];
    },
    get size() {
      return entries.length;
    },
    embeddingsProvider: embeddingsProvider as EmbeddingsProvider,
    setEmbeddingsProvider(provider: EmbeddingsProvider) {
      embeddingsProvider = provider;
    },
    waitForEmbeddings: waitForEmbeddingsImpl,
    computeEmbeddings: computeEmbeddingsImpl,
    add(input: AddMemoryInput): UnifiedMemoryEntry | null {
      const tokens = tokenize(input.content, cfg.tokenizer);
      if (tokens.length === 0) return null;
      const hash = semanticHash(tokens);
      const existingId = hashToId.get(hash);
      if (existingId !== undefined) {
        const idx = idToIndex[existingId] ?? NULL_INDEX;
        if (idx !== NULL_INDEX) {
          const existing = entries[idx];
          if (existing !== undefined) {
            reinforceEntry(existing, input.turn);
            duplicateDedups += 1;
            return existing;
          }
        }
      }
      hashToId.set(hash, contentStore.size);
      const id = contentStore.add(input.content);
      ensureIdCapacity(id);
      invertedIndex.addFromTokens(id, tokens);
      indexFinalized = false;
      const embedding: Float32Array | null = null;
      const entry: UnifiedMemoryEntry = {
        id,
        turn: input.turn,
        role: input.role,
        hash,
        tokens: estimateTokens(input.content, cfg.tokenizer),
        kind: input.kind,
        tags: [...(input.tags ?? [])],
        topic: input.topic ?? null,
        conversationId: input.conversationId ?? null,
        timestamp: input.timestamp ?? new Date().toISOString(),
        strength: cfg.ebbinghaus.stabilityInitial,
        accessCount: 0,
        lastAccessedTurn: input.turn,
        storedAt: Date.now(),
        embedding,
      };
      idToIndex[id] = entries.length;
      entries.push(entry);
      totalEntriesStored += 1;
      // Optionally compute embedding eagerly.
      if (input.computeEmbedding && embeddingsProvider !== null && embeddingsProvider.isAvailable()) {
        embeddingsProvider.embed(input.content).then((e) => {
          entry.embedding = e;
        }).catch((embedErr) => {
          // Leave embedding null; retrieval falls back to TF-IDF. Routed
          // through the debug owner so a persistent embeddings failure is
          // observable, not silently swallowed.
          handleError(embedErr, { module: "memory-unified-unified-memory-store", operation: "add-eager-embedding" });
        });
      }
      return entry;
    },
    addBulk(items: ReadonlyArray<AddMemoryInput>): { added: number; duplicates: number } {
      let added = 0;
      let duplicates = 0;
      for (const item of items) {
        const e = this.add(item);
        if (e !== null) added += 1;
        else duplicates += 1;
      }
      return { added, duplicates };
    },
    async retrieve(
      queryText: string,
      topK: number,
      threshold: number,
      currentTurn: number,
      hotModules: readonly string[] = [],
    ): Promise<readonly RetrievedMemory[]> {
      retrievals += 1;
      if (entries.length === 0) return [];
      const cacheKey = `${queryText}\0${topK}\0${threshold}\0${currentTurn}`;
      if (lruCache) {
        const cached = lruCache.get(cacheKey);
        if (cached !== undefined) {
          lruHits += 1;
          return cached;
        }
        lruMisses += 1;
      }
      if (!indexFinalized) this.finalize();

      const method = cfg.retrievalMethod;
      const hotSet = new Set(hotModules.map((m) => m.toLowerCase()));
      const nEntries = contentStore.size;
      const effectiveFloor = entries.length >= cfg.largeScaleIdfFloorThreshold ? cfg.idfFloor : 0;

      let tfidfHits: Array<{ id: number; score: number }> = [];
      let embeddingsHits: Array<{ id: number; score: number }> = [];

      // TF-IDF / inverted branch.
      if (method === "tfidf" || method === "hybrid" || method === "inverted") {
        const qTokens = tokenize(queryText, cfg.tokenizer);
        if (qTokens.length > 0) {
          const qVec = tfidfVector(qTokens);
          const r = effectiveFloor > 0
            ? invertedIndex.queryFilteredArray(qVec, effectiveFloor, nEntries)
            : invertedIndex.queryArray(qVec, nEntries);
          for (const entryId of r.candidates) {
            const s = r.scores[entryId] ?? 0;
            if (s >= threshold) tfidfHits.push({ id: entryId, score: s });
          }
          tfidfHits.sort((a, b) => b.score - a.score);
        }
      }

      // Embeddings branch.
      if ((method === "embeddings" || method === "hybrid") && embeddingsProvider !== null && embeddingsProvider.isAvailable()) {
        try {
          const qVec = await embeddingsProvider.embed(queryText);
          const withEmb = entries.filter((e) => e.embedding !== null) as UnifiedMemoryEntry[];
          if (withEmb.length > 0) {
            for (const e of withEmb) {
              const emb = e.embedding;
              if (emb === null) continue;
              const s = cosineNormalized(qVec, emb);
              if (s >= threshold) embeddingsHits.push({ id: e.id, score: s });
            }
            embeddingsHits.sort((a, b) => b.score - a.score);
          } else {
            // Embeddings not computed yet — fall back to TF-IDF.
            if (tfidfHits.length === 0) {
              const qTokens = tokenize(queryText, cfg.tokenizer);
              if (qTokens.length > 0) {
                const qVec = tfidfVector(qTokens);
                const r = invertedIndex.queryArray(qVec, nEntries);
                for (const entryId of r.candidates) {
                  const s = r.scores[entryId] ?? 0;
                  if (s >= threshold) tfidfHits.push({ id: entryId, score: s });
                }
                tfidfHits.sort((a, b) => b.score - a.score);
              }
            }
          }
        } catch (embedErr) {
          handleError(embedErr, { module: "memory-unified-unified-memory-store", operation: "retrieve-embeddings-fallback" });
          // embeddings failed — fall back to TF-IDF only.
          if (tfidfHits.length === 0) {
            const qTokens = tokenize(queryText, cfg.tokenizer);
            if (qTokens.length > 0) {
              const qVec = tfidfVector(qTokens);
              const r = invertedIndex.queryArray(qVec, nEntries);
              for (const entryId of r.candidates) {
                const s = r.scores[entryId] ?? 0;
                if (s >= threshold) tfidfHits.push({ id: entryId, score: s });
              }
              tfidfHits.sort((a, b) => b.score - a.score);
            }
          }
        }
      } else if (method === "embeddings" && (embeddingsProvider === null || !embeddingsProvider.isAvailable())) {
        // Embeddings unavailable — fall back to TF-IDF.
        const qTokens = tokenize(queryText, cfg.tokenizer);
        if (qTokens.length > 0) {
          const qVec = tfidfVector(qTokens);
          const r = invertedIndex.queryArray(qVec, nEntries);
          for (const entryId of r.candidates) {
            const s = r.scores[entryId] ?? 0;
            if (s >= threshold) tfidfHits.push({ id: entryId, score: s });
          }
          tfidfHits.sort((a, b) => b.score - a.score);
        }
      }

      // Fuse via RRF if hybrid.
      let fusedHits: Array<{ id: number; score: number }>;
      if (method === "hybrid" && tfidfHits.length > 0 && embeddingsHits.length > 0) {
        fusedHits = reciprocalRankFusion(
          [tfidfHits, embeddingsHits],
          cfg.rrfK,
          cfg.hybridEmbeddingsWeight,
        );
      } else if (method === "hybrid") {
        // One side empty — use the non-empty side.
        fusedHits = tfidfHits.length > 0 ? tfidfHits : embeddingsHits;
      } else if (method === "embeddings") {
        fusedHits = embeddingsHits.length > 0 ? embeddingsHits : tfidfHits;
      } else {
        fusedHits = tfidfHits;
      }

      // Apply Ebbinghaus retention + fading boost + hot-module boost + kind boost + topic boost.
      const qTokens = tokenize(queryText, cfg.tokenizer);
      const qTokenSet = new Set(qTokens);
      const scored: Array<{ entry: UnifiedMemoryEntry; sim: number; score: number; r: number }> = [];
      for (const hit of fusedHits) {
        const idx = idToIndex[hit.id] ?? NULL_INDEX;
        if (idx === NULL_INDEX) continue;
        const entry = entries[idx];
        if (entry === undefined) continue;
        const r = retentionValue(entry, currentTurn);
        let score = hit.score;
        // Fading boost (Ebbinghaus).
        score = applyFadingBoost(score, r, cfg.ebbinghaus);
        // Kind boost: facts are persistent anchors — boost them so they
        // out-rank longer noise entries that have higher raw TF-IDF cosine
        // (shorter docs are favored in pure cosine; this corrects that bias).
        if (entry.kind === "fact" || entry.kind === "awareness") {
          score += cfg.retrievalBoost.kindFactAwarenessBoost;
        } else if (entry.kind === "decision") {
          score += cfg.retrievalBoost.kindDecisionBoost;
        }
        // Topic match boost: if the entry's topic appears in the query,
        // boost it (the topic is a high-signal field, not just content).
        if (entry.topic !== null && qTokenSet.has(entry.topic.toLowerCase())) {
          score += cfg.retrievalBoost.topicMatchBoost;
        }
        // Tag match boost: if any entry tag appears in the query tokens.
        for (const tag of entry.tags) {
          if (qTokenSet.has(tag.toLowerCase())) {
            score += cfg.retrievalBoost.tagMatchBoost;
            break;
          }
        }
        // Hot-module boost.
        if (hotSet.size > 0) {
          for (const tag of entry.tags) {
            if (hotSet.has(tag.toLowerCase())) {
              score += cfg.retrievalBoost.hotModuleBoost;
              break;
            }
          }
        }
        scored.push({ entry, sim: hit.score, score, r });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, topK);
      if (top.length > 0) relevantInjections += 1;
      for (const s of top) reinforceEntry(s.entry, currentTurn);

      const results: RetrievedMemory[] = top.map((s) => ({
        id: s.entry.id,
        turn: s.entry.turn,
        role: s.entry.role,
        content: contentStore.get(s.entry.id),
        similarity: s.sim,
        score: s.score,
        retention: s.r,
        strength: s.entry.strength,
        kind: s.entry.kind,
        tags: s.entry.tags,
        topic: s.entry.topic,
        hash: s.entry.hash,
      }));
      if (lruCache) lruCache.set(cacheKey, results);
      return results;
    },
    getContent(entry: UnifiedMemoryEntry): string {
      return contentStore.get(entry.id);
    },
    getEntry(id: number): UnifiedMemoryEntry | null {
      const idx = idToIndex[id] ?? NULL_INDEX;
      if (idx === NULL_INDEX) return null;
      return entries[idx] ?? null;
    },
    pruneFaded(currentTurn: number): number {
      const before = entries.length;
      const keep: UnifiedMemoryEntry[] = [];
      for (const e of entries) {
        const isFact = e.kind === "fact" || e.kind === "awareness";
        const r = retentionValue(e, currentTurn);
        if (ebbinghausShouldPrune(r, cfg.ebbinghaus, isFact)) {
          totalPruned += 1;
          idToIndex[e.id] = NULL_INDEX;
        } else {
          keep.push(e);
        }
      }
      entries.length = 0;
      entries.push(...keep);
      for (let i = 0; i < entries.length; i += 1) {
        idToIndex[entries[i]!.id] = i;
      }
      if (lruCache) lruCache.clear();
      return before - entries.length;
    },
    recomputeAllTfidf(): void {
      invertedIndex.clear();
      for (const e of entries) {
        const content = contentStore.get(e.id);
        const tokens = tokenize(content, cfg.tokenizer);
        invertedIndex.addFromTokens(e.id, tokens);
      }
      df.clear();
      const computedDf = invertedIndex.computeDf();
      for (const [k, v] of computedDf) df.set(k, v);
      invertedIndex.finalize(df, contentStore.size);
      indexFinalized = true;
      if (lruCache) lruCache.clear();
    },
    finalize(): void {
      contentStore.flush();
      df.clear();
      const computedDf = invertedIndex.computeDf();
      for (const [k, v] of computedDf) df.set(k, v);
      invertedIndex.finalize(df, contentStore.size);
      indexFinalized = true;
    },
    close(): void {
      contentStore.close();
    },
    destroy(): void {
      contentStore.destroy();
    },
    stats(): UnifiedMemoryStats {
      const embStats = embeddingsProvider?.stats() ?? {
        loaded: false, loadMs: 0, queries: 0, totalQueryMs: 0, avgQueryMs: 0, dims: 0, available: false,
      };
      return deepFreeze({
        totalEntriesStored,
        retrievals,
        relevantInjections,
        totalReinforced,
        totalPruned,
        duplicateDedups,
        embeddings: {
          available: embStats.available,
          loaded: embStats.loaded,
          loadMs: embStats.loadMs,
          queries: embStats.queries,
          avgQueryMs: embStats.avgQueryMs,
          dims: embStats.dims,
        },
        invertedIndex: {
          postings: invertedIndex.postingsCount,
          finalized: invertedIndex.isFinalized,
        },
        contentStoreBytes: contentStore.fileSize,
        lruHits,
        lruMisses,
        heapUsedMB: process.memoryUsage().heapUsed / (1024 * 1024),
      }) as UnifiedMemoryStats;
    },
  };
}

/** Reciprocal Rank Fusion (RRF). Standard k=60 from the literature. */
function reciprocalRankFusion(
  rankings: ReadonlyArray<ReadonlyArray<{ id: number; score: number }>>,
  k: number,
  embeddingsWeight: number,
): Array<{ id: number; score: number }> {
  const scores = new Map<number, number>();
  const weights = [1 - embeddingsWeight, embeddingsWeight];
  for (let r = 0; r < rankings.length; r += 1) {
    const ranking = rankings[r];
    if (ranking === undefined) continue;
    const w = weights[r] ?? (1 / rankings.length);
    for (let i = 0; i < ranking.length; i += 1) {
      const hit = ranking[i];
      if (hit === undefined) continue;
      const rrf = 1 / (k + i + 1);
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + w * rrf);
    }
  }
  const out: Array<{ id: number; score: number }> = [];
  for (const [id, score] of scores) out.push({ id, score });
  out.sort((a, b) => b.score - a.score);
  return out;
}

export { cosineEmbeddings };
