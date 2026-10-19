// src/shared/memory/memory-entry.ts
// Canonical memory entry with FULL metadata. One owner of the entry shape;
// all memory stores (the old memory-store.ts, the old tool-result-store,
// attempt-history) consume this type. No parallel entry shapes.

import { deepFreeze, generateId, sha256 } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";
import {
  isMemoryTier,
  isMemoryType,
  isProvenance,
  type MemoryTier,
  type MemoryType,
  type Provenance,
} from "./memory-config.ts";

export type MemoryEntry = Readonly<{
  id: string;
  tier: MemoryTier;
  type: MemoryType;
  content: string;
  /** Who produced this entry: user | agent | tool | system. */
  provenance: Provenance;
  /** Agent or tool id that produced the entry (null for user/system). */
  sourceId: string | null;
  conversationId: string;
  projectId: string;
  /** Free-form context tag (e.g. "refactor", "debug", "search"). */
  context: string | null;
  timestamp: string;
  lastAccessed: string;
  accessCount: number;
  /** Ebbinghaus retention strength in [0,1]. */
  ebbinghausScore: number;
  tags: readonly string[];
  /** Pre-computed embedding (Float32Array) or null when embeddings disabled. */
  embedding: Float32Array | null;
  /** Pre-computed TF term-frequency vector (sparse) or null. */
  tfVector: ReadonlyMap<string, number> | null;
  /** Token estimate of `content`. */
  tokenEstimate: number;
  /** Integrity digest over (id, content, timestamp) — tamper detection. */
  digest: string;
  metadata: Readonly<Record<string, string>>;
}>;

export type AddMemoryInput = Readonly<{
  tier?: MemoryTier;
  type: MemoryType;
  content: string;
  provenance: Provenance;
  sourceId?: string | null;
  conversationId?: string;
  projectId?: string;
  context?: string | null;
  timestamp?: string;
  tags?: readonly string[];
  embedding?: Float32Array | null;
  tfVector?: ReadonlyMap<string, number> | null;
  tokenEstimate?: number;
  metadata?: Readonly<Record<string, string>>;
}>;

export type MemorySearchQuery = Readonly<{
  text: string | null;
  conversationId: string | null;
  projectId: string | null;
  tier: MemoryTier | null;
  type: MemoryType | null;
  provenance: Provenance | null;
  tags: readonly string[];
  fromTime: string | null;
  toTime: string | null;
  /** At most this many results; null = the store's own configured bound (`retrieval.topK`). */
  limit: number | null;
}>;

export type MemorySearchResult = Readonly<{
  entry: MemoryEntry;
  score: number;
  matchedFields: readonly string[];
}>;

export function computeEntryDigest(id: string, content: string, timestamp: string): string {
  return sha256(`${id}\u0000${content.length}\u0000${timestamp}`);
}

export function buildMemoryEntry(input: AddMemoryInput, defaults: {
  tier: MemoryTier;
  conversationId: string;
  projectId: string;
  timestamp: string;
  charsPerToken: number;
}): MemoryEntry {
  if (!isMemoryType(input.type)) {
    throw new InputError(`buildMemoryEntry: invalid type ${String(input.type)}`, "shared_memory_invalid_type");
  }
  if (!isProvenance(input.provenance)) {
    throw new InputError(`buildMemoryEntry: invalid provenance ${String(input.provenance)}`, "shared_memory_invalid_provenance");
  }
  const tier = input.tier ?? defaults.tier;
  if (!isMemoryTier(tier)) {
    throw new InputError(`buildMemoryEntry: invalid tier ${String(tier)}`, "shared_memory_invalid_tier");
  }
  const timestamp = input.timestamp ?? defaults.timestamp;
  const conversationId = input.conversationId ?? defaults.conversationId;
  const projectId = input.projectId ?? defaults.projectId;
  const id = generateId("mem");
  const tokenEstimate = input.tokenEstimate ??
    Math.max(1, Math.ceil(input.content.length / defaults.charsPerToken));
  const entry: MemoryEntry = {
    id,
    tier,
    type: input.type,
    content: input.content,
    provenance: input.provenance,
    sourceId: input.sourceId ?? null,
    conversationId,
    projectId,
    context: input.context ?? null,
    timestamp,
    lastAccessed: timestamp,
    accessCount: 0,
    ebbinghausScore: 1.0,
    tags: input.tags ? deepFreeze([...input.tags]) : deepFreeze([]),
    embedding: input.embedding ?? null,
    tfVector: input.tfVector ?? null,
    tokenEstimate,
    digest: computeEntryDigest(id, input.content, timestamp),
    metadata: input.metadata ? deepFreeze({ ...input.metadata }) : deepFreeze({}),
  };
  return deepFreeze(entry) as MemoryEntry;
}

export function verifyEntryIntegrity(entry: MemoryEntry): boolean {
  if (entry.digest !== computeEntryDigest(entry.id, entry.content, entry.timestamp)) {
    return false;
  }
  if (entry.embedding !== null && !(entry.embedding instanceof Float32Array)) {
    return false;
  }
  if (entry.tfVector !== null && !(entry.tfVector instanceof Map)) {
    return false;
  }
  if (!isMemoryTier(entry.tier) || !isMemoryType(entry.type) || !isProvenance(entry.provenance)) {
    return false;
  }
  return true;
}

export function createSearchQuery(input: {
  text?: string;
  conversationId?: string;
  projectId?: string;
  tier?: MemoryTier;
  type?: MemoryType;
  provenance?: Provenance;
  tags?: readonly string[];
  fromTime?: string;
  toTime?: string;
  limit?: number;
}): MemorySearchQuery {
  // An absent limit is the store's own configured bound (the retriever's
  // `topK`), never a code default in front of it (a2b-design H3).
  const limit = input.limit ?? null;
  if (limit !== null && (limit < 1 || !Number.isFinite(limit))) {
    throw new InputError("search limit must be a positive finite number", "shared_memory_invalid_search_limit");
  }
  return deepFreeze({
    text: input.text ?? null,
    conversationId: input.conversationId ?? null,
    projectId: input.projectId ?? null,
    tier: input.tier ?? null,
    type: input.type ?? null,
    provenance: input.provenance ?? null,
    tags: input.tags ? deepFreeze([...input.tags]) : deepFreeze([]),
    fromTime: input.fromTime ?? null,
    toTime: input.toTime ?? null,
    limit,
  }) as MemorySearchQuery;
}
