/**
 * EXP454 — the LOWER LAYER. Transparent dedup+compression applied to ALL
 * data flowing through the harness. Modules call `store(data, moduleId)` and
 * `retrieve(id)`; they don't know dedup or compression happened.
 *
 * Pipeline: store → dedup → compress → keep in store
 * retrieve → decompress → (dedup is NOT reversed; it's lossy for
 * block count but the kept blocks are exact). For lossless
 * compression, retrieve returns the deduped text verbatim.
 *
 * The store is content-addressed: identical inputs (post-dedup) share one
 * compressed blob. This gives cross-module dedup for free (two modules
 * storing the same fact share one blob).
 */

import type { DedupCompressionConfig, ModuleId } from "./config.ts";
import { resolveModuleConfig } from "./config.ts";
import { dedup, dedupAsync, type DedupReport, type DedupResult } from "./dedup.ts";
import { compress, type CompressionReport } from "./compression.ts";
import { decompress } from "./decompression.ts";
import { sha256 } from "./shared-helpers.ts";

export interface StoreEntry {
  id: string;
  moduleId: ModuleId;
  dedupReport: DedupReport;
  compressionReport: CompressionReport;
  /** effective mode used (after gemma-tolerance downgrade) */
  effectiveCompressionMode: string;
  /** compressed blob */
  blob: Buffer;
  /** whether this data is LLM-visible (gemma tolerance applied) */
  llmVisible: boolean;
  storedAt: number;
}

export interface StoreResult {
  id: string;
  /** true if this input deduped to an already-stored entry (cross-call dedup) */
  dedupHit: boolean;
  dedupReport: DedupReport;
  compressionReport: CompressionReport;
  storeMs: number;
  /** heap size of the stored blob (bytes) */
  storedBytes: number;
}

export interface RetrieveResult {
  text: string;
  ok: boolean;
  decompressMs: number;
  /** whether this retrieve hit the in-memory cache */
  cacheHit: boolean;
}

/** The lower-layer store. One per process. Content-addressed by the SHA-256
 * of the deduped text, so identical deduped inputs share one blob. */
export class DedupCompressionStore {
  private entries = new Map<string, StoreEntry>();
  private contentIndex = new Map<string, string>(); // sha256(deduped) -> id
  private readonly base: DedupCompressionConfig;
  /** RSS baseline (bytes) at construction, for memory accounting. */
  private rss0 = process.memoryUsage().rss;
  /**
   * Number of `store*` calls that hit an already-stored content hash (a
   * cross-call dedup). Incremented on EVERY dedup hit (sync, async, and
   * raw), so the exposure signal `dedupHitRate` reflects real activity
   * (R44 fix for the R31-V9 wired-but-inert bug where `dedupHits` was
   * declared but never incremented → `dedupHitRate` was always 0).
   */
  private dedupHits = 0;

  constructor(base: DedupCompressionConfig) {
    this.base = base;
  }

  /** Store data for a module. Synchronous (tree-sitter dedup not available
   * here — use storeAsync for that). */
  store(text: string, moduleId: ModuleId, llmVisible: boolean): StoreResult {
    const t0 = Date.now();
    const cfg = resolveModuleConfig(this.base, moduleId);
    if (!cfg.enabled || text.length < cfg.minInputSizeForPipeline) {
      return this.storeRaw(text, moduleId, llmVisible, t0);
    }
    const dedupRes = dedup(text, cfg);
    return this.commitDedupResult(dedupRes, cfg, moduleId, llmVisible, t0);
  }

  /** Asynchronous store (supports tree-sitter semantic dedup). */
  async storeAsync(text: string, moduleId: ModuleId, llmVisible: boolean): Promise<StoreResult> {
    const t0 = Date.now();
    const cfg = resolveModuleConfig(this.base, moduleId);
    if (!cfg.enabled || text.length < cfg.minInputSizeForPipeline) {
      return this.storeRaw(text, moduleId, llmVisible, t0);
    }
    const dedupRes = await dedupAsync(text, cfg);
    return this.commitDedupResult(dedupRes, cfg, moduleId, llmVisible, t0);
  }

  /**
   * R49-V9: shared commit path for `store` + `storeAsync`. Both previously
   * carried byte-identical bodies after the dedup call (content-hash lookup,
   * cross-call dedup-hit accounting, compress, entry creation, result) — a
   * "No Scattered Helpers" near-duplicate. This is the single owner of the
   * post-dedup commit so the two entry points cannot drift.
   */
  private commitDedupResult(
    dedupRes: DedupResult,
    cfg: DedupCompressionConfig,
    moduleId: ModuleId,
    llmVisible: boolean,
    t0: number,
  ): StoreResult {
    const dedupedText = dedupRes.content;
    const contentHash = sha256(dedupedText);
    const existingId = this.contentIndex.get(contentHash);
    if (existingId) {
      this.dedupHits += 1;
      const existing = this.entries.get(existingId)!;
      return {
        id: existingId, dedupHit: true,
        dedupReport: dedupRes.report,
        compressionReport: existing.compressionReport,
        storeMs: Date.now() - t0, storedBytes: existing.blob.length,
      };
    }
    const compRes = compress(dedupedText, cfg, llmVisible);
    const id = contentHash.slice(0, 32);
    const entry: StoreEntry = {
      id, moduleId,
      dedupReport: dedupRes.report,
      compressionReport: compRes.report,
      effectiveCompressionMode: compRes.effectiveMode,
      blob: compRes.compressed,
      llmVisible, storedAt: Date.now(),
    };
    this.entries.set(id, entry);
    this.contentIndex.set(contentHash, id);
    return {
      id, dedupHit: false,
      dedupReport: dedupRes.report,
      compressionReport: compRes.report,
      storeMs: Date.now() - t0, storedBytes: compRes.compressed.length,
    };
  }

  /** Retrieve decompressed (deduped) text by id. */
  retrieve(id: string): RetrieveResult {
    const entry = this.entries.get(id);
    if (!entry) return { text: "", ok: false, decompressMs: 0, cacheHit: false };
    const res = decompress(entry.blob, entry.effectiveCompressionMode as never);
    return { text: res.text, ok: res.ok, decompressMs: res.decompressMs, cacheHit: true };
  }

  /** Total bytes stored across all blobs. */
  storedBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.blob.length;
    return total;
  }

  /** Total bytes that would have been stored without the layer. */
  originalBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.dedupReport.dedupedChars;
    return total;
  }

  /** Number of entries. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Number of `store*` calls that hit an already-stored content hash
   * (cross-call dedup). The exposure signal `dedupHitRate` reads this.
   */
  dedupHitCount(): number {
    return this.dedupHits;
  }

  /** Process RSS delta over baseline (bytes). */
  rssDelta(): number {
    return process.memoryUsage().rss - this.rss0;
  }

  /** All entries (for exposure/reporting). */
  entriesList(): StoreEntry[] {
    return [...this.entries.values()];
  }

  private storeRaw(
    text: string, moduleId: ModuleId, llmVisible: boolean, t0: number,
  ): StoreResult {
    const contentHash = sha256(text);
    const existingId = this.contentIndex.get(contentHash);
    if (existingId) {
      this.dedupHits += 1;
      return {
        id: existingId, dedupHit: true,
        dedupReport: emptyReport(text),
        compressionReport: emptyCompReport(text),
        storeMs: Date.now() - t0, storedBytes: Buffer.byteLength(text, "utf8"),
      };
    }
    const blob = Buffer.from(text, "utf8");
    const id = contentHash.slice(0, 32);
    this.entries.set(id, {
      id, moduleId,
      dedupReport: emptyReport(text),
      compressionReport: emptyCompReport(text),
      effectiveCompressionMode: "none",
      blob, llmVisible, storedAt: Date.now(),
    });
    this.contentIndex.set(contentHash, id);
    return {
      id, dedupHit: false,
      dedupReport: emptyReport(text),
      compressionReport: emptyCompReport(text),
      storeMs: Date.now() - t0, storedBytes: blob.length,
    };
  }
}


function emptyReport(text: string): DedupReport {
  return {
    mode: "none", originalChars: text.length, originalLines: 0, originalBlocks: 0,
    dedupedChars: text.length, dedupedLines: 0, dedupedBlocks: 0,
    removedLines: 0, removedBlocks: 0, nearDupCount: 0,
    charReductionPct: 0, lineReductionPct: 0, blockReductionPct: 0,
    keywordStrategy: null, keywordCount: null, identifierCount: null, parseError: null,
  };
}

function emptyCompReport(text: string): CompressionReport {
  return {
    mode: "none", originalChars: text.length, compressedBytes: text.length,
    compressionRatio: 1, charSavingsPct: 0, decompressedChars: text.length,
    roundTripOk: true, downgradedForGemma: false, compressMs: 0, cpuMs: 0,
  };
}
