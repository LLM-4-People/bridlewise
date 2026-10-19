// src/shared/memory/retrieval/types.ts
// Shared retrieval types (kept separate to avoid circular imports between
// embeddings.ts and retriever.ts).

export type EmbeddingsConfigLike = Readonly<{
  modelId?: string;
  dtype?: "fp32" | "fp16" | "q8" | "int8" | "uint8";
  cacheDir?: string | null;
  wasmPaths?: string;
  batchSize?: number;
}>;

export type RankHit = Readonly<{ docIndex: number; score: number }>;
