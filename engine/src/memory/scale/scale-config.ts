// src/memory/scale/scale-config.ts
// Centralized configuration for the billion-token memory store.
// NO static constants — every threshold is a configurable value with
// default, type, range, validation, and documentation.
// Research: IVF-PQ + FTS5 inverted index (Kagi 2026-07-22) — FTS5 gives an
// on-disk inverted index with O(log N) per query + BM25 ranking, keeping RAM
// bounded regardless of scale.

import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";

export type ScaleStoreConfig = Readonly<{
  /** Number of SQLite shards. Entries are distributed by hash(id) % shardCount. */
  shardCount: number;
  /** Directory for SQLite shard files. */
  dataDir: string | null;
  /** Prefix for shard filenames (shard_0000.sqlite,...). */
  shardPrefix: string;
  /** Hot-tier LRU cache size (number of entries kept in RAM). */
  hotTierSize: number;
  /** Batch size for bulk inserts (entries per transaction). */
  insertBatchSize: number;
  /** FTS5 tokenizer: "porter" (stemming, best recall) or "unicode61" (simple). */
  ftsTokenizer: "porter" | "unicode61";
  /** Search result limit per shard query. */
  searchLimit: number;
  /** Whether to enable the hot-tier cache (disable for pure disk benchmarks). */
  hotTierEnabled: boolean;
  /** SQLite pragma: journal mode (WAL = write-ahead log, best for concurrent read/write). */
  journalMode: "WAL" | "DELETE" | "TRUNCATE";
  /** SQLite pragma: synchronous (NORMAL = good balance of safety/speed). */
  synchronous: "OFF" | "NORMAL" | "FULL";
  /** SQLite pragma: cache size in KiB (negative = KiB, positive = pages). */
  cacheSizeKiB: number;
  /** SQLite pragma: mmap_size in bytes (0 = disabled). */
  mmapSize: number;
  /** Enable content compression (brotli) for stored entries. */
  compressionEnabled: boolean;
  /** Maximum content length per entry in characters (safety bound). */
  maxContentChars: number;
}>;

const SCALE_DEFAULT_CONFIG: ScaleStoreConfig = deepFreeze({
  shardCount: 8,
  dataDir: null,
  shardPrefix: "shard",
  hotTierSize: 10_000,
  insertBatchSize: 5_000,
  ftsTokenizer: "porter",
  searchLimit: 20,
  hotTierEnabled: true,
  journalMode: "WAL",
  synchronous: "NORMAL",
  cacheSizeKiB: 8_192,
  mmapSize: 0,
  compressionEnabled: false,
  maxContentChars: 1_048_576,
});

export function resolveScaleConfig(overrides: Partial<ScaleStoreConfig> = {}): ScaleStoreConfig {
  const config: ScaleStoreConfig = {
    shardCount: overrides.shardCount ?? SCALE_DEFAULT_CONFIG.shardCount,
    dataDir: overrides.dataDir ?? SCALE_DEFAULT_CONFIG.dataDir,
    shardPrefix: overrides.shardPrefix ?? SCALE_DEFAULT_CONFIG.shardPrefix,
    hotTierSize: overrides.hotTierSize ?? SCALE_DEFAULT_CONFIG.hotTierSize,
    insertBatchSize: overrides.insertBatchSize ?? SCALE_DEFAULT_CONFIG.insertBatchSize,
    ftsTokenizer: overrides.ftsTokenizer ?? SCALE_DEFAULT_CONFIG.ftsTokenizer,
    searchLimit: overrides.searchLimit ?? SCALE_DEFAULT_CONFIG.searchLimit,
    hotTierEnabled: overrides.hotTierEnabled ?? SCALE_DEFAULT_CONFIG.hotTierEnabled,
    journalMode: overrides.journalMode ?? SCALE_DEFAULT_CONFIG.journalMode,
    synchronous: overrides.synchronous ?? SCALE_DEFAULT_CONFIG.synchronous,
    cacheSizeKiB: overrides.cacheSizeKiB ?? SCALE_DEFAULT_CONFIG.cacheSizeKiB,
    mmapSize: overrides.mmapSize ?? SCALE_DEFAULT_CONFIG.mmapSize,
    compressionEnabled: overrides.compressionEnabled ?? SCALE_DEFAULT_CONFIG.compressionEnabled,
    maxContentChars: overrides.maxContentChars ?? SCALE_DEFAULT_CONFIG.maxContentChars,
  };
  if (config.shardCount < 1 || !Number.isFinite(config.shardCount)) {
    throw new InputError("shardCount must be a positive finite number", "scale_config_invalid");
  }
  if (config.hotTierSize < 0 || !Number.isFinite(config.hotTierSize)) {
    throw new InputError("hotTierSize must be a non-negative finite number", "scale_config_invalid");
  }
  if (config.insertBatchSize < 1 || !Number.isFinite(config.insertBatchSize)) {
    throw new InputError("insertBatchSize must be a positive finite number", "scale_config_invalid");
  }
  if (config.searchLimit < 1 || !Number.isFinite(config.searchLimit)) {
    throw new InputError("searchLimit must be a positive finite number", "scale_config_invalid");
  }
  if (config.cacheSizeKiB < 0 || !Number.isFinite(config.cacheSizeKiB)) {
    throw new InputError("cacheSizeKiB must be a non-negative finite number", "scale_config_invalid");
  }
  if (config.mmapSize < 0 || !Number.isFinite(config.mmapSize)) {
    throw new InputError("mmapSize must be a non-negative finite number", "scale_config_invalid");
  }
  if (config.maxContentChars < 1 || !Number.isFinite(config.maxContentChars)) {
    throw new InputError("maxContentChars must be a positive finite number", "scale_config_invalid");
  }
  return deepFreeze(config);
}
