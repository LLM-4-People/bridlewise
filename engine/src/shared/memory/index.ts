// src/shared/memory/index.ts
// Public API barrel for the shared memory architecture (EXP436).
// ONE import path for everything memory-related. Resolves the duplication
// flagged by the user (tokenize x3, cosine x4, embeddings-loader x2,
// tfidf x2, memory-store x2).

export {
  MEMORY_SCHEMA_VERSION,
  MEMORY_TIERS,
  MEMORY_TYPES,
  PROVENANCES,
  TOKEN_CAP_STRATEGIES,
  RETRIEVAL_METHODS,
  STORAGE_BACKENDS,
  DEFAULT_RETRIEVAL_CONFIG,
  DEFAULT_TOKEN_CAP_CONFIG,
  DEFAULT_EBBINGHAUS_CONFIG,
  resolveSharedMemoryConfig,
  resolveRetrievalConfig,
  resolveTokenCapConfig,
  resolveEbbinghausConfig,
  estimateTokens,
  isMemoryTier,
  isMemoryType,
  isProvenance,
} from "./memory-config.ts";
export type {
  MemoryTier,
  MemoryType,
  Provenance,
  TokenCapStrategy,
  RetrievalMethod,
  StorageBackend,
  RetrievalConfig,
  TokenCapConfig,
  EbbinghausConfig,
  SharedMemoryConfig,
} from "./memory-config.ts";

export {
  buildMemoryEntry,
  computeEntryDigest,
  verifyEntryIntegrity,
  createSearchQuery,
} from "./memory-entry.ts";
export type {
  MemoryEntry,
  AddMemoryInput,
  MemorySearchQuery,
  MemorySearchResult,
} from "./memory-entry.ts";

export { ebbinghausScore, reinforceStability, retentionRank } from "./ebbinghaus.ts";

export { tokenize, termFrequency, DEFAULT_TOKENIZER_CONFIG } from "./retrieval/text-utils.ts";
export type { TextTokenizerConfig } from "./retrieval/text-utils.ts";
export { cosine, cosineF32, cosineNormalizedF32, cosineMaps } from "./retrieval/cosine.ts";
export { buildTfidfIndex, tfidfQuery, tfidfWeightVector, bm25Idf, bm25Score } from "./retrieval/tfidf.ts";
export type { TfidfIndex, TfidfHit } from "./retrieval/tfidf.ts";
export { getEmbeddingsProvider, _resetEmbeddingsProviderForTests } from "./retrieval/embeddings.ts";
export type { EmbeddingsProvider, EmbeddingVector, EmbeddingsStats } from "./retrieval/embeddings.ts";
export { reciprocalRankFusion } from "./retrieval/rrf.ts";
export { buildInvertedIndex, invertedQuery } from "./retrieval/inverted-index.ts";
export type { InvertedIndex, InvertedHit } from "./retrieval/inverted-index.ts";
export { buildHnswIndex, hnswQuery } from "./retrieval/hnsw.ts";
export type { HnswIndex, HnswHit } from "./retrieval/hnsw.ts";
export { createRetriever, retrieve, classifyQueryType } from "./retrieval/retriever.ts";
export type { RetrieverDeps } from "./retrieval/retriever.ts";

export { buildMemoryTree, treePathFilter } from "./memory-tree.ts";
export type { TreeNode } from "./memory-tree.ts";

export { applyTokenCap } from "./token-cap.ts";
export type { TokenCapContext, TokenCapDecision } from "./token-cap.ts";

export { createStorage } from "./storage/backend.ts";
export type { MemoryStoragePort, StorageFactoryOptions } from "./storage/backend.ts";
export { toWire, fromWire, safeFromWire } from "./storage/serde.ts";
export type { WireRecord } from "./storage/serde.ts";
export { encodeMsgpack, decodeMsgpack } from "./storage/msgpack-backend.ts";

export { createSharedMemoryStore } from "./shared-memory-store.ts";
export type { SharedMemoryStore, SharedMemoryStoreOptions, SharedMemoryStoreStats } from "./shared-memory-store.ts";

export { registerMemoryExposure, SHARED_MEMORY_MODULE } from "./memory-exposure.ts";
