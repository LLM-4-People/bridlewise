// src/shared/memory/storage/serde.ts
// Canonical serialization for MemoryEntry. Float32Array and Map are not
// JSON-safe; this module is the single owner of the wire format. All
// backends (json, sqlite, msgpack, append-log) consume it.

import type { MemoryEntry } from "../memory-entry.ts";
import { buildMemoryEntry, computeEntryDigest, verifyEntryIntegrity } from "../memory-entry.ts";
import { handleError } from "../../debug/debug-system.ts";

/** JSON-safe wire record. */
export type WireRecord = Readonly<{
  id: string;
  tier: string;
  type: string;
  content: string;
  provenance: string;
  sourceId: string | null;
  conversationId: string;
  projectId: string;
  context: string | null;
  timestamp: string;
  lastAccessed: string;
  accessCount: number;
  ebbinghausScore: number;
  tags: readonly string[];
  embedding: number[] | null;
  tfVector: [string, number][] | null;
  tokenEstimate: number;
  digest: string;
  metadata: Readonly<Record<string, string>>;
}>;

export function toWire(entry: MemoryEntry): WireRecord {
  return {
    id: entry.id,
    tier: entry.tier,
    type: entry.type,
    content: entry.content,
    provenance: entry.provenance,
    sourceId: entry.sourceId,
    conversationId: entry.conversationId,
    projectId: entry.projectId,
    context: entry.context,
    timestamp: entry.timestamp,
    lastAccessed: entry.lastAccessed,
    accessCount: entry.accessCount,
    ebbinghausScore: entry.ebbinghausScore,
    tags: entry.tags,
    embedding: entry.embedding ? Array.from(entry.embedding) : null,
    tfVector: entry.tfVector ? [...entry.tfVector.entries()] : null,
    tokenEstimate: entry.tokenEstimate,
    digest: entry.digest,
    metadata: entry.metadata,
  };
}

export function fromWire(w: WireRecord): MemoryEntry {
  const embedding = w.embedding ? new Float32Array(w.embedding) : null;
  const tfVector = w.tfVector ? new Map(w.tfVector) : null;
  const entry: MemoryEntry = {
    id: w.id,
    tier: w.tier as MemoryEntry["tier"],
    type: w.type as MemoryEntry["type"],
    content: w.content,
    provenance: w.provenance as MemoryEntry["provenance"],
    sourceId: w.sourceId,
    conversationId: w.conversationId,
    projectId: w.projectId,
    context: w.context,
    timestamp: w.timestamp,
    lastAccessed: w.lastAccessed,
    accessCount: w.accessCount,
    ebbinghausScore: w.ebbinghausScore,
    tags: w.tags,
    embedding,
    tfVector,
    tokenEstimate: w.tokenEstimate,
    digest: w.digest,
    metadata: w.metadata,
  };
  return entry;
}

/** Integrity-check a loaded entry. Returns null if corrupt (tamper detection
 * per the HARD test protocol: "corruption detection"). */
export function safeFromWire(w: WireRecord): MemoryEntry | null {
  try {
    const entry = fromWire(w);
    if (!verifyEntryIntegrity(entry)) return null;
    return entry;
  } catch (corruptErr) {
    // A corrupt wire record is dropped (corruption detection per the HARD
    // test protocol). Route through the debug owner so the corruption is
    // observable, not silently swallowed.
    handleError(corruptErr, { module: "shared-memory-serde", operation: "safe-from-wire" });
    return null;
  }
}

/** Build a fresh entry (re-exported for backends that reconstruct). */
export { buildMemoryEntry, computeEntryDigest };
