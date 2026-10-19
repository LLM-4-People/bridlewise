/**
 * EXP454 — Dedup + compression LOWER LAYER. Public API.
 *
 * Apply everywhere: `store(data, moduleId, llmVisible)` → `retrieve(id)`.
 * Modules don't know dedup or compression happened.
 *
 * The PROHIBITED hardcoded JS_KEYWORDS list (EXP449 dedup-v2.ts:205-214) is
 * replaced by DYNAMIC keyword detection in dynamic-keywords.ts:
 * - babel-tokens (parser-authoritative, JS/TS)
 * - tree-sitter (multi-language)
 * - frequency-learned (corpus-derived, language-agnostic)
 * - auto (pick by detected language)
 */

export {
  DEFAULT_DEDUP_COMPRESSION_CONFIG, validateConfig, resolveModuleConfig,
  type DedupCompressionConfig, type DedupMode, type CompressionMode,
  type ModuleId, type KeywordStrategy,
} from "./config.ts";

export {
  normalizeBlock, normalizeBlockAsync, normalizeBabelTokens,
  normalizeTreeSitter, normalizeWithLearnedKeywords,
  learnKeywordsFromCorpus, chooseStrategy, detectExtension,
  type NormToken, type NormalizeResult,
} from "./dynamic-keywords.ts";

export {
  dedup, dedupAsync,
  type DedupReport, type DedupResult,
} from "./dedup.ts";

export {
  compress, minify,
  type CompressionReport, type CompressionResult,
} from "./compression.ts";

export {
  decompress, type DecompressionResult,
} from "./decompression.ts";

export {
  DedupCompressionStore,
  type StoreEntry, type StoreResult, type RetrieveResult,
} from "./lower-layer.ts";

export {
  computeSignals, type LayerSignals, type LayerAction,
} from "./exposure.ts";

export {
  initLowerLayer, getStore, layerSignalsOrNull,
  storeMemoryEntry, storeToolResult,
  storeSearchResult, storeContextTurn, storeAwarenessSignal,
  storeEdit, storeLLMOutput, retrieve, layerSignals, storeForModule,
} from "./module-integration.ts";
