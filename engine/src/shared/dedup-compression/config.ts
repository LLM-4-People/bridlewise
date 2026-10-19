/**
 * EXP454 — Dedup + compression LOWER LAYER configuration.
 *
 * This file is the SINGLE SOURCE OF TRUTH for every tunable value in the
 * dedup-compression lower layer. There are NO hardcoded constants, keyword
 * lists, thresholds, or magic numbers anywhere else in the layer. Every
 * value lives here with: default, type, range/enum, validation, and
 * documentation. Per-module overrides are first-class.
 *
 * Design rules honored:
 * - no static values outside config (user: "static values like that are
 * prohibited app-wide");
 * - one canonical owner per concept (this file owns all tunables);
 * - per-module overrides (memory, tool results, search, context,
 * awareness, editor, llm-output) so each module can be tuned
 * independently;
 * - gemma-tolerance budget: compression applied to LLM-visible context
 * must stay within this budget so gemma can still generate correct edits.
 */

// ===== dedup modes =====

// The array owns the vocabulary and the union is derived from it, so a mode
// cannot exist as a type without appearing in the list benchmarks and
// validators iterate. Written the other way round, a seventh mode compiled
// while every sweep over the modes silently measured six.
const DEDUP_MODES = Object.freeze(["none", "line", "block", "semantic", "hash", "ast"] as const);

export type DedupMode = typeof DEDUP_MODES[number];

// ===== compression modes =====

// Module-private, unlike its dedup sibling: nothing outside this module needs
// the compression list today, and an export nobody imports is surface that
// looks supported and is not. Deriving the union from it works either way —
// export it when a caller exists, not in anticipation of one.
const COMPRESSION_MODES = Object.freeze([
  "none",
  "minify",
  "gzip",
  "brotli",
  "deflate",
  "minify+gzip",
  "minify+brotli",
] as const);

export type CompressionMode = typeof COMPRESSION_MODES[number];

// ===== module identifiers (per-module overrides keyed by these) =====

export type ModuleId =
  | "memory"
  | "tool-results"
  | "search"
  | "context"
  | "awareness"
  | "editor"
  | "llm-output"
  | "default";

// ===== dynamic keyword detection strategy =====

export type KeywordStrategy =
  // Use @babel/parser's tokenizer: token.type.keyword!== null => keyword.
  // Parser-authoritative, no hardcoded list. JS/TS only.
  | "babel-tokens"
  // Use web-tree-sitter: identifier nodes => ID, keywords are syntactic.
  // Multi-language. Needs WASM per language.
  | "tree-sitter"
  // Learn keywords from the corpus: words appearing in >= threshold fraction
  // of blocks are treated as keywords. Fully dynamic, language-agnostic.
  | "frequency-learned"
  // Auto: pick babel-tokens for JS/TS, tree-sitter if available for the
  // detected language, frequency-learned otherwise.
  | "auto";

// ===== the canonical config shape =====

export interface DedupCompressionConfig {
  // --- dedup ---
  dedupMode: DedupMode;
  /** Jaccard threshold for block/semantic near-dup (1.0 = exact). */
  blockSimilarityThreshold: number;
  /** Lines shorter than this are not deduped (braces, blank lines). */
  minLineLengthForDedup: number;
  /** Minimum block size (chars) before semantic dedup considers it. */
  minBlockSizeForSemantic: number;

  // --- compression ---
  compressionMode: CompressionMode;
  /** gzip/deflate level 1-9; brotli quality 0-11. */
  compressionLevel: number;
  stripLineComments: boolean;
  stripBlockComments: boolean;
  collapseWhitespace: boolean;
  removeBlankLines: boolean;

  // --- dynamic keywords ---
  keywordStrategy: KeywordStrategy;
  /** For frequency-learned: word is a keyword if it appears in >= this
   * fraction of blocks (0-1). */
  keywordFrequencyThreshold: number;
  /** tree-sitter language WASM map (extension -> wasm name). Empty = auto. */
  treeSitterLanguages: Record<string, string>;

  // --- gemma-tolerance budget ---
  /** Max char-reduction % allowed on LLM-VISIBLE (decompressed) context.
   * Lossless compression (brotli/gzip) decompresses to original so this
   * is 0% reduction on the visible side. Minify is lossy (comments lost)
   * so it counts against this budget. Set to 0 to require lossless-only
   * for LLM-visible context. */
  gemmaToleranceMaxReductionPct: number;
  /** If true, minify is never applied to LLM-visible context (only to
   * storage). Storage compression can be lossy; LLM-visible must be
   * lossless so gemma sees the original text. */
  llmVisibleLosslessOnly: boolean;

  // --- per-module overrides (merge over defaults) ---
  modules: Partial<Record<ModuleId, Partial<DedupCompressionConfig>>>;

  // --- operational ---
  /** If the dedup+compress pipeline takes longer than this (ms), skip it
   * and store raw. Prevents latency spikes on tiny inputs. */
  maxPipelineMs: number;
  /** Inputs smaller than this (chars) skip the pipeline (no benefit). */
  minInputSizeForPipeline: number;
  /** Whether the lower layer is enabled at all (global kill switch). */
  enabled: boolean;
}

// ===== default config (the ONLY place defaults live) =====

export const DEFAULT_DEDUP_COMPRESSION_CONFIG: DedupCompressionConfig = Object.freeze({
  dedupMode: "semantic",
  blockSimilarityThreshold: 0.85,
  minLineLengthForDedup: 4,
  minBlockSizeForSemantic: 40,

  compressionMode: "brotli",
  compressionLevel: 11,
  stripLineComments: true,
  stripBlockComments: true,
  collapseWhitespace: true,
  removeBlankLines: true,

  keywordStrategy: "auto",
  keywordFrequencyThreshold: 0.5,
  treeSitterLanguages: {},

  gemmaToleranceMaxReductionPct: 0,
  llmVisibleLosslessOnly: true,

  modules: Object.freeze({
    memory: Object.freeze({
      dedupMode: "semantic",
      compressionMode: "brotli",
      compressionLevel: 11,
    }),
    "tool-results": Object.freeze({
      dedupMode: "hash",
      compressionMode: "brotli",
      compressionLevel: 11,
    }),
    search: Object.freeze({
      dedupMode: "block",
      compressionMode: "brotli",
      compressionLevel: 9,
    }),
    context: Object.freeze({
      dedupMode: "semantic",
      compressionMode: "none", // LLM-visible: keep lossless, no storage compress
      llmVisibleLosslessOnly: true,
    }),
    awareness: Object.freeze({
      dedupMode: "line",
      compressionMode: "brotli",
      compressionLevel: 9,
    }),
    editor: Object.freeze({
      dedupMode: "ast",
      compressionMode: "brotli",
      compressionLevel: 11,
    }),
    "llm-output": Object.freeze({
      dedupMode: "semantic",
      compressionMode: "minify+brotli",
      compressionLevel: 11,
      llmVisibleLosslessOnly: false, // output is minified for storage
    }),
    default: Object.freeze({
      dedupMode: "semantic",
      compressionMode: "brotli",
    }),
  }),

  maxPipelineMs: 50,
  minInputSizeForPipeline: 64,
  enabled: true,
});

// ===== validation =====

export function validateConfig(c: DedupCompressionConfig): string[] {
  const errs: string[] = [];
  if (c.blockSimilarityThreshold < 0 || c.blockSimilarityThreshold > 1)
    errs.push("blockSimilarityThreshold must be in [0,1]");
  if (c.minLineLengthForDedup < 0) errs.push("minLineLengthForDedup must be >= 0");
  if (c.minBlockSizeForSemantic < 0) errs.push("minBlockSizeForSemantic must be >= 0");
  if (c.compressionLevel < 0 || c.compressionLevel > 11)
    errs.push("compressionLevel must be in [0,11]");
  if (c.keywordFrequencyThreshold < 0 || c.keywordFrequencyThreshold > 1)
    errs.push("keywordFrequencyThreshold must be in [0,1]");
  if (c.gemmaToleranceMaxReductionPct < 0 || c.gemmaToleranceMaxReductionPct > 100)
    errs.push("gemmaToleranceMaxReductionPct must be in [0,100]");
  if (c.maxPipelineMs < 0) errs.push("maxPipelineMs must be >= 0");
  if (c.minInputSizeForPipeline < 0) errs.push("minInputSizeForPipeline must be >= 0");
  return errs;
}

// ===== per-module config resolution =====

export function resolveModuleConfig(
  base: DedupCompressionConfig,
  moduleId: ModuleId,
): DedupCompressionConfig {
  const override = base.modules[moduleId];
  if (!override) return base;
  // shallow-merge override over base; modules key is preserved as-is
  const merged: DedupCompressionConfig = { ...base, ...override };
  merged.modules = base.modules;
  return Object.freeze(merged);
}
