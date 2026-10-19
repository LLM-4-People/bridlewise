// src/shared/memory/memory-exposure.ts
// Registers signals, actions, and customizations for the shared memory
// module through the shared exposure system (binding directive: "use the
// shared exposure system (EXP425)"). Reuses registerSignal/registerAction/
// registerCustomization from src/shared/exposure/.

import {
  registerAction,
  registerCustomization,
  registerSignal,
} from "../exposure/index.ts";
import type { SharedMemoryStore, SharedMemoryStoreStats } from "./shared-memory-store.ts";
// THE ENUM A CONTROL OFFERS IS THE VOCABULARY ITSELF, NOT A COPY OF IT. Each
// of these lists used to be written out again beside `as RetrievalMethod[]`,
// which reads as a type check and is not one: a list holding FEWER members is
// assignable, so a method added to the owner and forgotten here left a
// setting the store accepts and the settings surface never offers.
import {
  RETRIEVAL_METHODS,
  STORAGE_BACKENDS,
  TOKEN_CAP_STRATEGIES,
  type RetrievalMethod,
  type StorageBackend,
  type TokenCapStrategy,
} from "./memory-config.ts";

const MODULE = "sharedMemory";

export function registerMemoryExposure(store: SharedMemoryStore): void {
  const stats = (): SharedMemoryStoreStats => store.stats();

  const gauge = (id: string, name: string, desc: string, read: () => number | string | boolean, unit?: string) => {
    const base = {
      id: `${MODULE}.${id}`,
      module: MODULE,
      name,
      description: desc,
      type: "gauge" as const,
      value: (() => read()) as (args?: Readonly<Record<string, unknown>>) => number | string | boolean,
    };
    registerSignal(unit !== undefined ? { ...base, unit } : base);
  };

  gauge("totalCount", "Total Count", "total stored entries", () => stats().totalCount, "count");
  gauge("hotCount", "Hot Count", "entries in the hot tier", () => stats().countByTier.hot ?? 0, "count");
  gauge("warmCount", "Warm Count", "entries in the warm tier", () => stats().countByTier.warm ?? 0, "count");
  gauge("coldCount", "Cold Count", "entries in the cold tier", () => stats().countByTier.cold ?? 0, "count");
  gauge("totalTokens", "Total Tokens", "estimated tokens across all tiers", () => stats().totalTokens, "tokens");
  gauge("hotTokens", "Hot Tokens", "tokens in the hot tier", () => stats().tokensByTier.hot ?? 0, "tokens");
  gauge("warmTokens", "Warm Tokens", "tokens in the warm tier", () => stats().tokensByTier.warm ?? 0, "tokens");
  gauge("coldTokens", "Cold Tokens", "tokens in the cold tier", () => stats().tokensByTier.cold ?? 0, "tokens");
  gauge("retrievalCount", "Retrieval Count", "number of search() calls", () => stats().retrievalCount, "count");
  gauge("retrievalAvgMs", "Retrieval Avg Latency", "average retrieval latency", () => stats().retrievalAvgMs, "ms");
  gauge("corruptedDropped", "Corrupted Dropped", "entries dropped on reload (tamper/parse)", () => stats().corruptedDropped, "count");
  gauge("storageBytesWritten", "Storage Bytes Written", "cumulative bytes written to disk", () => stats().storageBytesWritten, "bytes");
  gauge("storageOps", "Storage Ops", "cumulative storage operations", () => stats().storageOps, "count");
  gauge("embeddingsAvailable", "Embeddings Available", "whether the embeddings model is loaded", () => stats().embeddingsAvailable, "boolean");

  registerAction({
    id: `${MODULE}.flush`,
    module: MODULE,
    name: "Flush",
    description: "persist cold tier to the storage backend",
    execute: async () => { store.flush(); return "flushed"; },
  });
  registerAction({
    id: `${MODULE}.reload`,
    module: MODULE,
    name: "Reload",
    description: "reconstruct tiers from the storage backend",
    execute: async () => { store.reload(); return "reloaded"; },
  });
  registerAction({
    id: `${MODULE}.enforceCaps`,
    module: MODULE,
    name: "Enforce Caps",
    description: "promote overflowing hot->warm->cold per token-cap strategy",
    execute: async () => { store.enforceCaps(); return "caps enforced"; },
  });

  registerCustomization({
    id: `${MODULE}.retrievalMethod`,
    module: MODULE,
    name: "Retrieval Method",
    description: "retrieval method (tfidf|embeddings|hybrid|inverted|hnsw|tree)",
    type: "enum",
    default: "hybrid",
    enum: RETRIEVAL_METHODS,
    // R44: read the CURRENT value from the store's resolved config (was a
    // hardcoded literal ` => "hybrid"` — the same wired-but-inert class
    // as the 748% bug: the customization reported "hybrid" even when the
    // store was actually configured for "tfidf"/"embeddings"/etc.).
    current: () => store.config.retrieval.method,
    // Wired write path (was an empty no-op setter — a rendered control whose
    // set changed nothing). setRetrievalMethod re-resolves the store config and
    // rebuilds the retriever, so the NEXT search() dispatches on the new
    // method. Invalid values throw a typed InputError.
    set: (value) => { store.setRetrievalMethod(value as RetrievalMethod); },
  });
  registerCustomization({
    id: `${MODULE}.storageBackend`,
    module: MODULE,
    name: "Storage Backend",
    description: "storage backend (json|sqlite|msgpack|append-log)",
    type: "enum",
    default: "json",
    enum: STORAGE_BACKENDS,
    // R44: read the CURRENT value from the store's resolved config (was a
    // hardcoded literal ` => "json"` — wired-but-inert).
    current: () => store.config.storage.backend,
    // Wired write path (was an empty no-op setter). setStorageBackend swaps the
    // live persistence port and re-persists the in-memory snapshot in the
    // new backend's format, so flush/reload/append run against the selected
    // backend from this point on.
    set: (value) => { store.setStorageBackend(value as StorageBackend); },
  });
  registerCustomization({
    id: `${MODULE}.tokenCapStrategy`,
    module: MODULE,
    name: "Token Cap Strategy",
    description: "token cap strategy (prune-oldest|prune-least-relevant|prune-lowest-ebbinghaus|compress|tier)",
    type: "enum",
    default: "tier",
    enum: TOKEN_CAP_STRATEGIES,
    // R44: read the CURRENT value from the store's resolved config (was a
    // hardcoded literal ` => "tier"` — wired-but-inert).
    current: () => store.config.tokenCap.strategy,
    // Wired write path (was an empty no-op setter). setTokenCapStrategy commits
    // the strategy to the store's live config; enforceCaps() reads it at
    // call time, so the next enforcement pass prunes/compresses/tiers per
    // the selected strategy.
    set: (value) => { store.setTokenCapStrategy(value as TokenCapStrategy); },
  });
}

export { MODULE as SHARED_MEMORY_MODULE };
