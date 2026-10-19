// src/shared/memory/memory-config.ts
// Single canonical owner of ALL shared-memory configuration. No static
// constants live anywhere else (binding directive: "static values are
// prohibited app-wide"). Every threshold/limit/weight here is configurable
// through the central config contract; consumers receive a resolved
// `SharedMemoryConfig` and must not hardcode magic numbers.
//
// Research: multi-layer hot/warm/cold (arXiv 2603.29194, 2605.08538),
// Ebbinghaus forgetting curve, RRF k=60 (literature standard).

import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";

export const MEMORY_SCHEMA_VERSION = schemaId("shared-memory", 2);

/** Hot/warm/cold tiers (replaces the old present/short-term/long-term names
 * with the literature-standard hot/warm/cold taxonomy; arXiv 2603.29194). */
export const MEMORY_TIERS = deepFreeze(["hot", "warm", "cold"] as const);
export type MemoryTier = typeof MEMORY_TIERS[number];

export const MEMORY_TYPES = deepFreeze([
  "fact",
  "tool-result",
  "decision",
  "error",
  "observation",
  "summary",
] as const);
export type MemoryType = typeof MEMORY_TYPES[number];

export const PROVENANCES = deepFreeze([
  "user",
  "agent",
  "tool",
  "system",
] as const);
export type Provenance = typeof PROVENANCES[number];

export const TOKEN_CAP_STRATEGIES = deepFreeze([
  "prune-oldest",
  "prune-least-relevant",
  "prune-lowest-ebbinghaus",
  "compress",
  "tier",
] as const);
export type TokenCapStrategy = typeof TOKEN_CAP_STRATEGIES[number];

export const RETRIEVAL_METHODS = deepFreeze([
  "tfidf",
  "embeddings",
  "hybrid",
  "inverted",
  "hnsw",
  "tree",
] as const);
export type RetrievalMethod = typeof RETRIEVAL_METHODS[number];

export const STORAGE_BACKENDS = deepFreeze([
  "json",
  "sqlite",
  "msgpack",
  "append-log",
] as const);
export type StorageBackend = typeof STORAGE_BACKENDS[number];

export type RetrievalConfig = Readonly<{
  method: RetrievalMethod;
  topK: number;
  minScore: number;
  rrfK: number;
  hybridEmbeddingsWeight: number;
  hnswEfSearch: number;
  hnswM: number;
}>;

export type TokenCapConfig = Readonly<{
  strategy: TokenCapStrategy;
  hotTokenLimit: number;
  warmTokenLimit: number;
  coldTokenLimit: number;
  trimTriggerRatio: number;
  compressTargetRatio: number;
}>;

export type EbbinghausConfig = Readonly<{
  stabilityInitial: number;
  reinforcementFactor: number;
  decayPerDay: number;
  accessBoost: number;
  floor: number;
}>;

export type SharedMemoryConfig = Readonly<{
  retrieval: RetrievalConfig;
  tokenCap: TokenCapConfig;
  ebbinghaus: EbbinghausConfig;
  embeddings: Readonly<{
    modelId: string;
    dtype: "fp32" | "fp16" | "q8" | "int8" | "uint8";
    cacheDir: string | null;
    /** Batch size for `embedBatch` (R44: moved from a hardcoded `32` in
     * `retrieval/embeddings.ts` to the canonical config owner so the
     * default is not scattered outside the config). */
    batchSize: number;
    enabled: boolean;
  }>;
  storage: Readonly<{
    backend: StorageBackend;
    coldPath: string | null;
    flushIntervalMs: number;
  }>;
  tree: Readonly<{
    enabled: boolean;
    maxChildrenPerNode: number;
  }>;
  chunking: Readonly<{
    readChunkLines: number;
    readChunkStride: number;
    maxChunkChars: number;
  }>;
  estimateCharsPerToken: number;
  maxEntriesPerTier: number;
}>;

/** Deeply-partial config for ergonomic overrides (consumers pass only the
 * fields they want to change; the rest fall back to defaults). */
export type PartialSharedMemoryConfig = {
  retrieval?: Partial<RetrievalConfig>;
  tokenCap?: Partial<TokenCapConfig>;
  ebbinghaus?: Partial<EbbinghausConfig>;
  embeddings?: Partial<{ modelId: string; dtype: "fp32" | "fp16" | "q8" | "int8" | "uint8"; cacheDir: string | null; batchSize: number; enabled: boolean }>;
  storage?: Partial<{ backend: StorageBackend; coldPath: string | null; flushIntervalMs: number }>;
  tree?: Partial<{ enabled: boolean; maxChildrenPerNode: number }>;
  chunking?: Partial<{ readChunkLines: number; readChunkStride: number; maxChunkChars: number }>;
  estimateCharsPerToken?: number;
  maxEntriesPerTier?: number;
};

export const DEFAULT_RETRIEVAL_CONFIG = deepFreeze({
  method: "hybrid",
  topK: 10,
  minScore: 0.05,
  rrfK: 60,
  hybridEmbeddingsWeight: 0.6,
  hnswEfSearch: 48,
  hnswM: 16,
} as const) as RetrievalConfig;

export const DEFAULT_TOKEN_CAP_CONFIG = deepFreeze({
  strategy: "tier",
  hotTokenLimit: 8_000,
  warmTokenLimit: 24_000,
  coldTokenLimit: 200_000,
  trimTriggerRatio: 0.8,
  compressTargetRatio: 0.5,
} as const) as TokenCapConfig;

export const DEFAULT_EBBINGHAUS_CONFIG = deepFreeze({
  stabilityInitial: 1.0,
  reinforcementFactor: 1.6,
  decayPerDay: 0.5,
  accessBoost: 0.3,
  floor: 0.05,
} as const) as EbbinghausConfig;

/**
 * Module-private: `resolveSharedMemoryConfig` below is the resolver, and a
 * default whose owner also owns the resolver has exactly one correct reader.
 * Anyone who wants the fully-defaulted document asks
 * `resolveSharedMemoryConfig({})` — same values, plus the validation, and it
 * keeps tracking configuration when a caller supplies some.
 */
const DEFAULT_SHARED_MEMORY_CONFIG = deepFreeze({
  retrieval: DEFAULT_RETRIEVAL_CONFIG,
  tokenCap: DEFAULT_TOKEN_CAP_CONFIG,
  ebbinghaus: DEFAULT_EBBINGHAUS_CONFIG,
  embeddings: {
    modelId: "Xenova/all-MiniLM-L6-v2",
    dtype: "fp32" as const,
    cacheDir: null,
    batchSize: 32,
    enabled: true,
  },
  storage: {
    backend: "json" as const,
    coldPath: null,
    flushIntervalMs: 5_000,
  },
  tree: {
    enabled: true,
    maxChildrenPerNode: 256,
  },
  chunking: {
    readChunkLines: 50,
    readChunkStride: 40,
    maxChunkChars: 1000,
  },
  estimateCharsPerToken: 4,
  maxEntriesPerTier: 10_000,
} as const) as SharedMemoryConfig;

function fin(v: number): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

export function resolveRetrievalConfig(o: Partial<RetrievalConfig> = {}): RetrievalConfig {
  const cfg = { ...DEFAULT_RETRIEVAL_CONFIG, ...o };
  if (!RETRIEVAL_METHODS.includes(cfg.method)) {
    throw new InputError(`retrieval.method invalid: ${cfg.method}`, "shared_memory_config_invalid");
  }
  if (!fin(cfg.topK) || cfg.topK < 1) throw new InputError("topK must be >= 1", "shared_memory_config_invalid");
  if (!fin(cfg.minScore) || cfg.minScore < 0 || cfg.minScore > 1) throw new InputError("minScore must be in [0,1]", "shared_memory_config_invalid");
  if (!fin(cfg.rrfK) || cfg.rrfK < 1) throw new InputError("rrfK must be >= 1", "shared_memory_config_invalid");
  if (!fin(cfg.hybridEmbeddingsWeight) || cfg.hybridEmbeddingsWeight < 0 || cfg.hybridEmbeddingsWeight > 1) throw new InputError("hybridEmbeddingsWeight must be in [0,1]", "shared_memory_config_invalid");
  if (!fin(cfg.hnswEfSearch) || cfg.hnswEfSearch < 1) throw new InputError("hnswEfSearch must be >= 1", "shared_memory_config_invalid");
  if (!fin(cfg.hnswM) || cfg.hnswM < 2) throw new InputError("hnswM must be >= 2", "shared_memory_config_invalid");
  return deepFreeze(cfg) as RetrievalConfig;
}

export function resolveTokenCapConfig(o: Partial<TokenCapConfig> = {}): TokenCapConfig {
  const cfg = { ...DEFAULT_TOKEN_CAP_CONFIG, ...o };
  if (!TOKEN_CAP_STRATEGIES.includes(cfg.strategy)) {
    throw new InputError(`tokenCap.strategy invalid: ${cfg.strategy}`, "shared_memory_config_invalid");
  }
  if (!fin(cfg.hotTokenLimit) || cfg.hotTokenLimit < 1) throw new InputError("hotTokenLimit must be >= 1", "shared_memory_config_invalid");
  if (!fin(cfg.warmTokenLimit) || cfg.warmTokenLimit < 1) throw new InputError("warmTokenLimit must be >= 1", "shared_memory_config_invalid");
  if (!fin(cfg.coldTokenLimit) || cfg.coldTokenLimit < 1) throw new InputError("coldTokenLimit must be >= 1", "shared_memory_config_invalid");
  if (!fin(cfg.trimTriggerRatio) || cfg.trimTriggerRatio < 0.5 || cfg.trimTriggerRatio > 0.99) throw new InputError("trimTriggerRatio must be in [0.5,0.99]", "shared_memory_config_invalid");
  if (!fin(cfg.compressTargetRatio) || cfg.compressTargetRatio < 0.1 || cfg.compressTargetRatio > 0.9) throw new InputError("compressTargetRatio must be in [0.1,0.9]", "shared_memory_config_invalid");
  return deepFreeze(cfg) as TokenCapConfig;
}

export function resolveEbbinghausConfig(o: Partial<EbbinghausConfig> = {}): EbbinghausConfig {
  const cfg = { ...DEFAULT_EBBINGHAUS_CONFIG, ...o };
  if (!fin(cfg.stabilityInitial) || cfg.stabilityInitial <= 0) throw new InputError("stabilityInitial must be > 0", "shared_memory_config_invalid");
  if (!fin(cfg.reinforcementFactor) || cfg.reinforcementFactor <= 1) throw new InputError("reinforcementFactor must be > 1", "shared_memory_config_invalid");
  if (!fin(cfg.decayPerDay) || cfg.decayPerDay < 0 || cfg.decayPerDay > 1) throw new InputError("decayPerDay must be in [0,1]", "shared_memory_config_invalid");
  if (!fin(cfg.accessBoost) || cfg.accessBoost < 0) throw new InputError("accessBoost must be >= 0", "shared_memory_config_invalid");
  if (!fin(cfg.floor) || cfg.floor < 0 || cfg.floor > 1) throw new InputError("floor must be in [0,1]", "shared_memory_config_invalid");
  return deepFreeze(cfg) as EbbinghausConfig;
}

export function resolveSharedMemoryConfig(o: PartialSharedMemoryConfig = {}): SharedMemoryConfig {
  const cfg: SharedMemoryConfig = {
    retrieval: resolveRetrievalConfig(o.retrieval),
    tokenCap: resolveTokenCapConfig(o.tokenCap),
    ebbinghaus: resolveEbbinghausConfig(o.ebbinghaus),
    embeddings: {
      modelId: o.embeddings?.modelId ?? DEFAULT_SHARED_MEMORY_CONFIG.embeddings.modelId,
      dtype: o.embeddings?.dtype ?? DEFAULT_SHARED_MEMORY_CONFIG.embeddings.dtype,
      cacheDir: o.embeddings?.cacheDir ?? null,
      batchSize: o.embeddings?.batchSize ?? DEFAULT_SHARED_MEMORY_CONFIG.embeddings.batchSize,
      enabled: o.embeddings?.enabled ?? DEFAULT_SHARED_MEMORY_CONFIG.embeddings.enabled,
    },
    storage: {
      backend: o.storage?.backend ?? DEFAULT_SHARED_MEMORY_CONFIG.storage.backend,
      coldPath: o.storage?.coldPath ?? null,
      flushIntervalMs: o.storage?.flushIntervalMs ?? DEFAULT_SHARED_MEMORY_CONFIG.storage.flushIntervalMs,
    },
    tree: {
      enabled: o.tree?.enabled ?? DEFAULT_SHARED_MEMORY_CONFIG.tree.enabled,
      maxChildrenPerNode: o.tree?.maxChildrenPerNode ?? DEFAULT_SHARED_MEMORY_CONFIG.tree.maxChildrenPerNode,
    },
    chunking: {
      readChunkLines: o.chunking?.readChunkLines ?? DEFAULT_SHARED_MEMORY_CONFIG.chunking.readChunkLines,
      readChunkStride: o.chunking?.readChunkStride ?? DEFAULT_SHARED_MEMORY_CONFIG.chunking.readChunkStride,
      maxChunkChars: o.chunking?.maxChunkChars ?? DEFAULT_SHARED_MEMORY_CONFIG.chunking.maxChunkChars,
    },
    estimateCharsPerToken: o.estimateCharsPerToken ?? DEFAULT_SHARED_MEMORY_CONFIG.estimateCharsPerToken,
    maxEntriesPerTier: o.maxEntriesPerTier ?? DEFAULT_SHARED_MEMORY_CONFIG.maxEntriesPerTier,
  };
  if (!STORAGE_BACKENDS.includes(cfg.storage.backend)) {
    throw new InputError(`storage.backend invalid: ${cfg.storage.backend}`, "shared_memory_config_invalid");
  }
  if (!fin(cfg.estimateCharsPerToken) || cfg.estimateCharsPerToken < 1) throw new InputError("estimateCharsPerToken must be >= 1", "shared_memory_config_invalid");
  if (!fin(cfg.maxEntriesPerTier) || cfg.maxEntriesPerTier < 1) throw new InputError("maxEntriesPerTier must be >= 1", "shared_memory_config_invalid");
  if (!fin(cfg.embeddings.batchSize) || cfg.embeddings.batchSize < 1) throw new InputError("embeddings.batchSize must be a positive finite number", "shared_memory_config_invalid");
  return deepFreeze(cfg) as SharedMemoryConfig;
}

export function estimateTokens(text: string, charsPerToken: number = DEFAULT_SHARED_MEMORY_CONFIG.estimateCharsPerToken): number {
  if (text.length === 0) return 0;
  if (charsPerToken < 1 || !Number.isFinite(charsPerToken)) {
    throw new InputError("charsPerToken must be >= 1", "shared_memory_config_invalid");
  }
  return Math.ceil(text.length / charsPerToken);
}

export function isMemoryTier(v: unknown): v is MemoryTier {
  return typeof v === "string" && (MEMORY_TIERS as readonly string[]).includes(v);
}

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

export function isProvenance(v: unknown): v is Provenance {
  return typeof v === "string" && (PROVENANCES as readonly string[]).includes(v);
}
