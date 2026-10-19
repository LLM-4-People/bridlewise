// src/shared/memory/shared-memory-store.ts
// Multi-layer (hot/warm/cold) shared memory store with tree classification,
// full metadata, pluggable retrieval (tfidf/embeddings/hybrid/inverted/
// hnsw/tree), pluggable storage (json/sqlite/msgpack/append-log), Ebbinghaus
// decay + reinforcement, and token-cap strategies.
//
// NOTE (SPO audit R42): this store is NOT currently instantiated by any
// production consumer. The web UI conversation memory goes through
// `integration/src/memory/memory-store.ts` (via the web UI
// `server/memory-bridge.ts`); the integration runtime context manager
// uses `integration/src/memory/unified/unified-memory-store.ts`. The
// retrieval primitives under `src/shared/memory/retrieval/` (cosine,
// tfidf, embeddings, text-utils) ARE reused by `tool-result-retrieval.ts`
// and `memory-search.ts`. This store + its config/entry/tree/token-cap/
// storage/exposure architecture is a parallel implementation kept for the
// shared-memory research surface. It must NOT be treated as the canonical
// memory store owner (that is `memory-store.ts` for the conversation tier
// and `unified/unified-memory-store.ts` for the retrieval tier).

import { existsSync, rmSync } from "node:fs";
import { generateId } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";
import { handleError } from "../debug/debug-system.ts";
import {
  estimateTokens,
  isMemoryTier,
  isMemoryType,
  isProvenance,
  resolveSharedMemoryConfig,
  type PartialSharedMemoryConfig,
  type RetrievalMethod,
  type SharedMemoryConfig,
  type StorageBackend,
  type TokenCapStrategy,
} from "./memory-config.ts";
import {
  buildMemoryEntry,
  computeEntryDigest,
  createSearchQuery,
  verifyEntryIntegrity,
  type AddMemoryInput,
  type MemoryEntry,
  type MemorySearchQuery,
  type MemorySearchResult,
} from "./memory-entry.ts";
import { ebbinghausScore, reinforceStability } from "./ebbinghaus.ts";
import { DEFAULT_TOKENIZER_CONFIG, termFrequency, tokenize, type TextTokenizerConfig } from "./retrieval/text-utils.ts";
import { createRetriever, retrieve, type RetrieverDeps } from "./retrieval/retriever.ts";
import { getEmbeddingsProvider, type EmbeddingsProvider } from "./retrieval/embeddings.ts";
import { applyTokenCap, type TokenCapContext } from "./token-cap.ts";
import { buildMemoryTree, treePathFilter, type TreeNode } from "./memory-tree.ts";
import { createStorage, type MemoryStoragePort } from "./storage/backend.ts";

export type SharedMemoryStoreOptions = Readonly<{
  config?: Partial<SharedMemoryConfig>;
  storage?: MemoryStoragePort;
  embeddings?: EmbeddingsProvider;
  tokenizer?: TextTokenizerConfig;
  clock?: () => string;
  projectId?: string;
}>;

export type SharedMemoryStoreStats = Readonly<{
  totalCount: number;
  countByTier: Readonly<Record<string, number>>;
  countByType: Readonly<Record<string, number>>;
  totalTokens: number;
  tokensByTier: Readonly<Record<string, number>>;
  retrievalCount: number;
  retrievalTotalMs: number;
  retrievalAvgMs: number;
  corruptedDropped: number;
  storageBytesWritten: number;
  storageOps: number;
  embeddingsAvailable: boolean;
  embeddingsStats: unknown;
}>;

export type SharedMemoryStore = Readonly<{
  /** Live resolved config. Reads always reflect the LATEST runtime
   * reconfiguration (setRetrievalMethod/setTokenCapStrategy/
   * setStorageBackend), not the construction-time snapshot. */
  readonly config: SharedMemoryConfig;
  readonly projectId: string;
  add(input: AddMemoryInput): MemoryEntry;
  addAsync(input: AddMemoryInput): Promise<MemoryEntry>;
  addHot(content: string, type: AddMemoryInput["type"], provenance: AddMemoryInput["provenance"], opts?: Partial<AddMemoryInput>): MemoryEntry;
  addWarm(content: string, type: AddMemoryInput["type"], provenance: AddMemoryInput["provenance"], opts?: Partial<AddMemoryInput>): MemoryEntry;
  addCold(content: string, type: AddMemoryInput["type"], provenance: AddMemoryInput["provenance"], opts?: Partial<AddMemoryInput>): MemoryEntry;
  get(id: string): MemoryEntry | null;
  all(): readonly MemoryEntry[];
  byTier(tier: import("./memory-config.ts").MemoryTier): readonly MemoryEntry[];
  byType(type: import("./memory-config.ts").MemoryType): readonly MemoryEntry[];
  byConversation(conversationId: string): readonly MemoryEntry[];
  tree(): TreeNode;
  search(query: MemorySearchQuery): Promise<readonly MemorySearchResult[]>;
  searchText(text: string, limit?: number): Promise<readonly MemorySearchResult[]>;
  /** Promote overflowing hot→warm→cold per the tier token-cap strategy. */
  enforceCaps(): void;
  /** Switch the retrieval method at runtime (exposure write path). Rebuilds
   * the retriever so the NEXT search() dispatches on the new method. Throws
   * a typed InputError on an unknown method (config re-resolution). */
  setRetrievalMethod(method: RetrievalMethod): void;
  /** Switch the token-cap strategy at runtime (exposure write path).
   * enforceCaps() reads the live config, so the next enforcement pass uses
   * the new strategy. Throws a typed InputError on an unknown strategy. */
  setTokenCapStrategy(strategy: TokenCapStrategy): void;
  /** Switch the storage backend at runtime (exposure write path). Closes the
   * old port, opens the new one, and re-persists the full in-memory snapshot
   * in the new backend's format so reload() reads a file the ACTIVE backend
   * understands. Throws a typed InputError on an unknown backend. */
  setStorageBackend(backend: StorageBackend): void;
  /** Persist cold tier to the storage backend. */
  flush(): void;
  /** Reconstruct cold tier from the storage backend. */
  reload(): void;
  stats(): SharedMemoryStoreStats;
  close(): void;
}>;

export function createSharedMemoryStore(options: SharedMemoryStoreOptions = {}): SharedMemoryStore {
  // `config` and `storage`/`retriever` are `let`: the exposure write path
  // (setRetrievalMethod/setTokenCapStrategy/setStorageBackend) swaps them at
  // runtime, and every consumer below reads the variables live.
  let config = resolveSharedMemoryConfig(options.config ?? {});
  const tokenizer = options.tokenizer ?? DEFAULT_TOKENIZER_CONFIG;
  const clock = options.clock ?? (() => new Date().toISOString());
  const projectId = options.projectId ?? "default";
  let storage = options.storage ?? createStorage({ backend: config.storage.backend, path: config.storage.coldPath });
  const embeddings = options.embeddings ?? getEmbeddingsProvider({
    modelId: config.embeddings.modelId,
    dtype: config.embeddings.dtype,
    cacheDir: config.embeddings.cacheDir,
  });

  // Hot + warm are in-memory; cold is backed by the storage backend.
  let hot: MemoryEntry[] = [];
  let warm: MemoryEntry[] = [];
  let cold: MemoryEntry[] = [];
  let retrievalCount = 0;
  let retrievalTotalMs = 0;
  let corruptedDropped = 0;
  // Best retrieval score seen per entry id. search() records it; enforceCaps
  // feeds it to the "prune-least-relevant" strategy so relevance ranking is
  // driven by REAL retrieval history (previously a permanently-empty map was
  // passed, which made the strategy degrade to insertion order).
  const lastRelevance = new Map<string, number>();

  // Initialize embeddings eagerly if enabled (so retriever.isAvailable works).
  if (config.embeddings.enabled) {
    embeddings.init().catch((initErr) => {
      // Reported via isAvailable; route through the debug owner so a
      // persistent init failure is observable.
      handleError(initErr, { module: "shared-memory-store", operation: "embeddings-init" });
    });
  }

  function now(): string { return clock(); }

  function defaultConversationId(): string { return generateId("conv"); }

  async function maybeEmbed(content: string): Promise<Float32Array | null> {
    if (!config.embeddings.enabled) return null;
    if (!embeddings.isAvailable()) return null;
    try {
      return await embeddings.embed(content);
    } catch (embedErr) {
      // Embeddings unavailable for this content — fall back to TF-IDF.
      handleError(embedErr, { module: "shared-memory-store", operation: "maybe-embed" });
      return null;
    }
  }

  function tfFor(content: string): Map<string, number> {
    return termFrequency(tokenize(content, tokenizer));
  }

  function tierForNewEntry(tier: AddMemoryInput["tier"]): import("./memory-config.ts").MemoryTier {
    if (tier && isMemoryTier(tier)) return tier;
    return "hot";
  }

  function pushToTier(entry: MemoryEntry): void {
    if (entry.tier === "hot") hot.push(entry);
    else if (entry.tier === "warm") warm.push(entry);
    else cold.push(entry);
  }

  async function addAsync(input: AddMemoryInput): Promise<MemoryEntry> {
    if (!isMemoryType(input.type)) {
      throw new InputError(`shared-memory: invalid type ${String(input.type)}`, "shared_memory_invalid_type");
    }
    if (!isProvenance(input.provenance)) {
      throw new InputError(`shared-memory: invalid provenance ${String(input.provenance)}`, "shared_memory_invalid_provenance");
    }
    const tier = tierForNewEntry(input.tier);
    const embedding = input.embedding !== undefined ? input.embedding : await maybeEmbed(input.content);
    const tfVector = input.tfVector !== undefined ? input.tfVector : tfFor(input.content);
    const entry = buildMemoryEntry(
      {
        ...input,
        tier,
        embedding,
        tfVector,
        conversationId: input.conversationId ?? defaultConversationId(),
        projectId: input.projectId ?? projectId,
      },
      { tier, conversationId: input.conversationId ?? defaultConversationId(), projectId: input.projectId ?? projectId, timestamp: now(), charsPerToken: config.estimateCharsPerToken },
    );
    pushToTier(entry);
    storage.append(entry);
    return entry;
  }

  // The public `add` is sync to match the old API; embedding is computed
  // eagerly via an internal promise that resolves the entry. For simplicity
  // + determinism in the benchmark, when embeddings are enabled the caller
  // uses `addAsync`. `add` stores the entry immediately and back-fills the
  // embedding (the entry id is stable; the embedding is attached on next
  // reload if computed). To keep the contract simple, `add` computes TF
  // synchronously and attaches the embedding when already loaded.
  function addSync(input: AddMemoryInput): MemoryEntry {
    if (!isMemoryType(input.type)) {
      throw new InputError(`shared-memory: invalid type ${String(input.type)}`, "shared_memory_invalid_type");
    }
    if (!isProvenance(input.provenance)) {
      throw new InputError(`shared-memory: invalid provenance ${String(input.provenance)}`, "shared_memory_invalid_provenance");
    }
    const tier = tierForNewEntry(input.tier);
    const tfVector = input.tfVector !== undefined ? input.tfVector : tfFor(input.content);
    let embedding: Float32Array | null = input.embedding ?? null;
    if (config.embeddings.enabled && embeddings.isAvailable()) {
      // Fire-and-attach: compute embedding, then attach to the stored entry.
      embeddings.embed(input.content).then((v) => {
        const idx = all().findIndex((e) => e.id === entry.id);
        if (idx >= 0) attachEmbedding(idx, v);
      }).catch((embedErr) => {
        // Reported via isAvailable; route through the debug owner.
        handleError(embedErr, { module: "shared-memory-store", operation: "add-async-embed" });
      });
    }
    const entry = buildMemoryEntry(
      { ...input, tier, embedding, tfVector, conversationId: input.conversationId ?? defaultConversationId(), projectId: input.projectId ?? projectId },
      { tier, conversationId: input.conversationId ?? defaultConversationId(), projectId: input.projectId ?? projectId, timestamp: now(), charsPerToken: config.estimateCharsPerToken },
    );
    pushToTier(entry);
    storage.append(entry);
    return entry;
  }

  function attachEmbedding(index: number, v: Float32Array): void {
    // Rebuild the entry at the computed global index with the embedding.
    const entries = all();
    const e = entries[index];
    if (!e) return;
    const rebuilt: MemoryEntry = { ...e, embedding: v };
    if (e.tier === "hot") { const i = hot.indexOf(e); if (i >= 0) hot[i] = rebuilt; }
    else if (e.tier === "warm") { const i = warm.indexOf(e); if (i >= 0) warm[i] = rebuilt; }
    else { const i = cold.indexOf(e); if (i >= 0) cold[i] = rebuilt; }
  }

  function all(): readonly MemoryEntry[] {
    return [...hot, ...warm, ...cold];
  }

  function tierTokens(entries: readonly MemoryEntry[]): number {
    let s = 0;
    for (const e of entries) s += e.tokenEstimate;
    return s;
  }

  function enforceTierCap(entries: MemoryEntry[], limit: number, relevanceById: ReadonlyMap<string, number>): { keep: MemoryEntry[]; evicted: MemoryEntry[]; compressed: MemoryEntry[] } {
    const ctx: TokenCapContext = {
      config: config.tokenCap,
      relevanceById,
      totalTokens: tierTokens(entries),
      scopeLimit: limit,
    };
    const decision = applyTokenCap(entries, ctx);
    return {
      keep: [...decision.keep] as MemoryEntry[],
      evicted: [...decision.evict] as MemoryEntry[],
      // "compress" strategy output — previously computed by applyTokenCap and
      // silently DROPPED here, which made strategy="compress" a no-op lie.
      // The store now consumes it (see compressEntry in enforceCaps).
      compressed: [...decision.compress] as MemoryEntry[],
    };
  }

  /** Re-resolve the live config with a validated patch. This is the single
   * runtime write path for reconfiguration: resolveSharedMemoryConfig re-runs
   * ALL invariants, so an invalid value throws a typed InputError and the
   * previous config stays in place unchanged. */
  function reconfigure(patch: PartialSharedMemoryConfig): void {
    config = resolveSharedMemoryConfig({
      retrieval: { ...config.retrieval, ...patch.retrieval },
      tokenCap: { ...config.tokenCap, ...patch.tokenCap },
      ebbinghaus: { ...config.ebbinghaus },
      embeddings: { ...config.embeddings },
      storage: { ...config.storage, ...patch.storage },
      tree: { ...config.tree },
      chunking: { ...config.chunking },
      estimateCharsPerToken: config.estimateCharsPerToken,
      maxEntriesPerTier: config.maxEntriesPerTier,
    });
  }

  let retriever: RetrieverDeps = createRetriever(config.retrieval, tokenizer, embeddings);

  const store: SharedMemoryStore = {
    // Getter, not a snapshot: exposure `current()` readers must observe the
    // config as reconfigured at runtime.
    get config() { return config; },
    projectId,
    add: addSync,
    addAsync: addAsync,
    addHot(content, type, provenance, opts = {}) {
      return addSync({ ...opts, tier: "hot", content, type, provenance });
    },
    addWarm(content, type, provenance, opts = {}) {
      return addSync({ ...opts, tier: "warm", content, type, provenance });
    },
    addCold(content, type, provenance, opts = {}) {
      return addSync({ ...opts, tier: "cold", content, type, provenance });
    },
    get(id) {
      for (const e of all()) if (e.id === id) return e;
      return null;
    },
    all() { return all(); },
    byTier(tier) { return all().filter((e) => e.tier === tier); },
    byType(type) { return all().filter((e) => e.type === type); },
    byConversation(conversationId) { return all().filter((e) => e.conversationId === conversationId); },
    tree() { return buildMemoryTree(all()); },
    async search(query) {
      const t0 = Date.now();
      const results = await retrieve(retriever, query, all());
      const dt = Date.now() - t0;
      retrievalCount += 1;
      retrievalTotalMs += dt;
      // Reinforce stability for retrieved entries (spaced repetition).
      const ids = new Set(results.map((r) => r.entry.id));
      reinforceAccess(ids);
      // Record the best score per entry so "prune-least-relevant" ranks by
      // real retrieval history.
      for (const r of results) {
        const previous = lastRelevance.get(r.entry.id) ?? 0;
        if (r.score > previous) lastRelevance.set(r.entry.id, r.score);
      }
      return results;
    },
    async searchText(text, limit) {
      return store.search(createSearchQuery({ text, ...(limit === undefined ? {} : { limit }) }));
    },
    enforceCaps() {
      // Relevance from real retrieval history (search() records the best
      // score per entry id) — NOT a fresh empty map, which would silently
      // degrade "prune-least-relevant" to insertion order.
      const relevanceById = lastRelevance;
      // Tier strategy: hot overflow → warm; warm overflow → cold; cold → prune.
      // Compressed entries stay in their tier with content shrunk in place.
      const hotCap = enforceTierCap(hot, config.tokenCap.hotTokenLimit, relevanceById);
      hot = [...hotCap.keep, ...hotCap.compressed.map(compressEntry)];
      warm.push(...hotCap.evicted.map(demoteTo("warm")));
      const warmCap = enforceTierCap(warm, config.tokenCap.warmTokenLimit, relevanceById);
      warm = [...warmCap.keep, ...warmCap.compressed.map(compressEntry)];
      cold.push(...warmCap.evicted.map(demoteTo("cold")));
      const coldCap = enforceTierCap(cold, config.tokenCap.coldTokenLimit, relevanceById);
      cold = [...coldCap.keep, ...coldCap.compressed.map(compressEntry)];
      // cold evictions are dropped (pruned) — durable history is the storage backend.
    },
    setRetrievalMethod(method) {
      reconfigure({ retrieval: { method } });
      // The retriever captures RetrievalConfig at creation — rebuild it so
      // search() dispatches on the NEW method.
      retriever = createRetriever(config.retrieval, tokenizer, embeddings);
    },
    setTokenCapStrategy(strategy) {
      // enforceCaps() reads config.tokenCap live; nothing else to rebuild.
      reconfigure({ tokenCap: { strategy } });
    },
    setStorageBackend(backend) {
      if (backend === storage.backend) return;
      const previousBackend = storage.backend;
      // Validate + commit the config first (throws typed InputError on an
      // unknown backend, leaving the old port untouched).
      reconfigure({ storage: { backend } });
      const snapshot = all();
      storage.close();
      // The backends share coldPath; a leftover file in the OLD format would
      // make the new port fail to open (sqlite) or read it as corruption.
      // Dropping it loses nothing: all tiers are held in memory and the full
      // snapshot is re-persisted in the new format below.
      if (config.storage.coldPath !== null && existsSync(config.storage.coldPath)) {
        rmSync(config.storage.coldPath, { force: true });
      }
      try {
        storage = createStorage({ backend, path: config.storage.coldPath });
      } catch (openErr) {
        // Roll back so the store stays usable on a failed swap (e.g.
        // node:sqlite unavailable), then rethrow the typed error.
        reconfigure({ storage: { backend: previousBackend } });
        storage = createStorage({ backend: previousBackend, path: config.storage.coldPath });
        storage.flush(snapshot);
        throw openErr;
      }
      // Re-persist the full in-memory snapshot in the NEW backend's format so
      // reload() reads a file the active backend understands.
      storage.flush(snapshot);
    },
    flush() {
      storage.flush(all());
    },
    reload() {
      const loaded = storage.load();
      // Drop any corrupt entries (verifyEntryIntegrity already applied).
      const valid = loaded.filter((e) => verifyEntryIntegrity(e));
      corruptedDropped += loaded.length - valid.length;
      cold = valid.filter((e) => e.tier === "cold");
      warm = valid.filter((e) => e.tier === "warm");
      hot = valid.filter((e) => e.tier === "hot");
    },
    stats() {
      const entries = all();
      const countByTier: Record<string, number> = { hot: 0, warm: 0, cold: 0 };
      const countByType: Record<string, number> = {};
      const tokensByTier: Record<string, number> = { hot: 0, warm: 0, cold: 0 };
      let totalTokens = 0;
      for (const e of entries) {
        countByTier[e.tier] = (countByTier[e.tier] ?? 0) + 1;
        countByType[e.type] = (countByType[e.type] ?? 0) + 1;
        tokensByTier[e.tier] = (tokensByTier[e.tier] ?? 0) + e.tokenEstimate;
        totalTokens += e.tokenEstimate;
      }
      return {
        totalCount: entries.length,
        countByTier,
        countByType,
        totalTokens,
        tokensByTier,
        retrievalCount,
        retrievalTotalMs,
        retrievalAvgMs: retrievalCount === 0 ? 0 : retrievalTotalMs / retrievalCount,
        corruptedDropped,
        storageBytesWritten: storage.bytesWritten(),
        storageOps: storage.opCount(),
        embeddingsAvailable: embeddings.isAvailable(),
        embeddingsStats: embeddings.stats(),
      };
    },
    close() { storage.close(); },
  };
  return store;

  function demoteTo(tier: import("./memory-config.ts").MemoryTier): (e: MemoryEntry) => MemoryEntry {
    return (e) => ({ ...e, tier });
  }

  /** "compress" strategy consumption point: shrink the entry content in place
   * to compressTargetRatio of its chars (deterministic prefix summary),
   * recomputing tokenEstimate, tfVector, and the integrity digest (id and
   * timestamp are stable, so entry identity survives and
   * verifyEntryIntegrity still passes). The stale embedding is dropped — it
   * described the uncompressed content. */
  function compressEntry(e: MemoryEntry): MemoryEntry {
    const targetChars = Math.max(1, Math.floor(e.content.length * config.tokenCap.compressTargetRatio));
    if (targetChars >= e.content.length) return e;
    const content = e.content.slice(0, targetChars);
    return {
      ...e,
      content,
      tokenEstimate: Math.max(1, Math.ceil(content.length / config.estimateCharsPerToken)),
      tfVector: tfFor(content),
      embedding: null,
      digest: computeEntryDigest(e.id, content, e.timestamp),
    };
  }

  function reinforceAccess(ids: Set<string>): void {
    const entries = all();
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      if (!e || !ids.has(e.id)) continue;
      const stability = reinforceStability(1.0 / Math.max(0.05, e.ebbinghausScore), config.ebbinghaus);
      const ageDays = Math.max(0, (Date.now() - new Date(e.timestamp).getTime()) / 86_400_000);
      const score = ebbinghausScore({ elapsedDays: ageDays, stability, config: config.ebbinghaus });
      const updated: MemoryEntry = {
        ...e,
        ebbinghausScore: score,
        accessCount: e.accessCount + 1,
        lastAccessed: now(),
      };
      // Write back to the right tier array.
      if (e.tier === "hot") { const j = hot.indexOf(e); if (j >= 0) hot[j] = updated; }
      else if (e.tier === "warm") { const j = warm.indexOf(e); if (j >= 0) warm[j] = updated; }
      else { const j = cold.indexOf(e); if (j >= 0) cold[j] = updated; }
    }
  }
}

export { treePathFilter, estimateTokens };
