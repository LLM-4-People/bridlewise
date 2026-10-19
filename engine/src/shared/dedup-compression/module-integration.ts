/**
 * EXP454 — module integration. Wires the dedup-compression LOWER LAYER into
 * each module so dedup+compression is applied everywhere transparently.
 *
 * The lower layer is the single owner of dedup+compression. Modules call
 * `store*` / `retrieve`; they don't implement their own dedup/compression.
 * Per-module config (config.ts `modules`) tunes each module independently.
 * The store is initialized ONCE at harness startup with the resolved config.
 */

import type { ModuleId } from "./config.ts";
import { DedupCompressionStore, type StoreResult, type RetrieveResult, computeSignals, type LayerSignals } from "./index.ts";
import type { DedupCompressionConfig } from "./config.ts";
import { InputError } from "../../kernel/errors.ts";

/** A process-wide singleton store. One per harness instance. */
let globalStore: DedupCompressionStore | null = null;

/** Initialize (or re-initialize) the global lower-layer store. Called once
 * at harness startup with the resolved config. */
export function initLowerLayer(cfg: DedupCompressionConfig): DedupCompressionStore {
  globalStore = new DedupCompressionStore(cfg);
  return globalStore;
}

/** Get the global store (throws if not initialized). */
export function getStore(): DedupCompressionStore {
  if (!globalStore) throw new InputError("lower-layer not initialized — call initLowerLayer first");
  return globalStore;
}

/**
 * Compute the layer's exposure signals, or `null` when the layer is not
 * initialized (dedup disabled). The `null` is the honest absent answer — the
 * store holds nothing because nothing ran — never a fabricated zero. The
 * exposure registration maps the `null` to the empty reading so its signals
 * stay scalar (always-readable) while reporting the true empty state.
 */
export function layerSignalsOrNull(): LayerSignals | null {
  return globalStore === null ? null : computeSignals(globalStore);
}

// ===== per-module adapters (applied everywhere) =====
// Each routes through the global store with its ModuleId; the store resolves
// the per-module config from config.ts. LLM-visible data is lossless.

/** Memory: dedup entries (semantic) + compress (brotli). LLM-visible. */
export function storeMemoryEntry(content: string): StoreResult {
  return getStore().store(content, "memory", true);
}

/** Tool results: dedup (hash — exact-match cache) + compress (brotli). */
export function storeToolResult(content: string): StoreResult {
  return getStore().store(content, "tool-results", false);
}

/** Search results: dedup (block) + compress (brotli). */
export function storeSearchResult(content: string): StoreResult {
  return getStore().store(content, "search", false);
}

/** Context turns: dedup (semantic) — NO storage compression (LLM-visible). */
export function storeContextTurn(content: string): StoreResult {
  return getStore().store(content, "context", true);
}

/** Awareness signals: dedup (line) + compress (brotli). */
export function storeAwarenessSignal(content: string): StoreResult {
  return getStore().store(content, "awareness", false);
}

/** Editor edits: dedup (ast) + compress (brotli). */
export function storeEdit(content: string): StoreResult {
  return getStore().store(content, "editor", false);
}

/** LLM output: dedup (semantic) + compress (minify+brotli) for storage. */
export function storeLLMOutput(content: string): StoreResult {
  return getStore().store(content, "llm-output", false);
}

/** Retrieve by id (transparent decompression). */
export function retrieve(id: string): RetrieveResult {
  return getStore().retrieve(id);
}

/** Compute and return the layer's exposure signals. */
export function layerSignals(): LayerSignals {
  return computeSignals(getStore());
}

/** Convenience: store for a given module id directly. */
export function storeForModule(content: string, moduleId: ModuleId, llmVisible: boolean): StoreResult {
  return getStore().store(content, moduleId, llmVisible);
}
