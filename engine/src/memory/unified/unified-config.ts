/**
 * Central config for the unified memory + context subsystem.
 *
 * SINGLE owner of every threshold, cap, weight, and budget used by the
 * unified memory store, context manager, injection controller, drift
 * detector, and trust enforcer. Per the binding directive ("everything
 * dynamically computed, no static constants"), no numeric constant that
 * is not derived from runtime state lives outside this module.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { resolveEbbinghausConfig, type EbbinghausConfig } from "./ebbinghaus.ts";
import { resolveEmbeddingsConfig, type EmbeddingsConfig } from "./unified-embeddings.ts";
import { DEFAULT_INJECTION_CONFIG, type InjectionConfig } from "./proactive-injector.ts";
import { DEFAULT_TRUST_CONFIG, type TrustConfig } from "./trust-enforcer.ts";
import { DEFAULT_DRIFT_CONFIG, type DriftConfig } from "./drift-detector.ts";
import { DEFAULT_TOOL_RESULT_CONFIG, minimumLruCapacityForContext, type ToolResultConfig } from "./unified-tool-result-store.ts";
import { resolveTokenizerConfig, type TokenizerConfig } from "./tokenizer.ts";
import { InputError } from "../../kernel/errors.ts";
import { refuseUnknownKeys } from "../../shared/type-guards.ts";

export type RetrievalMethod = "tfidf" | "embeddings" | "hybrid" | "inverted";

/**
 * Retrieval-score boost weights applied by the unified memory store after
 * the raw TF-IDF / embeddings / hybrid fusion. Each is a positive delta added
 * to the fused score; 0 disables that boost. Single owner of the boost
 * constants (binding directive: no static constants in callers).
 */
export type RetrievalBoostConfig = Readonly<{
  /** Boost for persistent-anchor kinds (fact, awareness) — corrects the
   * short-doc cosine bias so facts out-rank longer noise. */
  kindFactAwarenessBoost: number;
  /** Boost for decision entries. */
  kindDecisionBoost: number;
  /** Boost when the entry's topic token appears in the query. */
  topicMatchBoost: number;
  /** Boost when any entry tag appears in the query tokens. */
  tagMatchBoost: number;
  /** Boost when any entry tag matches a hot-module tag. */
  hotModuleBoost: number;
}>;

export const DEFAULT_RETRIEVAL_BOOST_CONFIG: RetrievalBoostConfig = deepFreeze({
  kindFactAwarenessBoost: 0.20,
  kindDecisionBoost: 0.10,
  topicMatchBoost: 0.15,
  tagMatchBoost: 0.10,
  hotModuleBoost: 0.10,
});

export type UnifiedConfig = Readonly<{
  contextTokenLimit: number;
  trimThreshold: number;
  recentTurnWindow: number;
  summaryTokenBudget: number;
  /** Min recent turns kept (continuity). */
  minRecentTurnsKept: number;
  retrievalMethod: RetrievalMethod;
  retrievalTopK: number;
  retrievalMinScore: number;
  rrfK: number;
  hybridEmbeddingsWeight: number;
  /** IDF floor for query filtering at scale. 0 = no filtering. */
  idfFloor: number;
  /** Entry count at/above which `idfFloor` kicks in (large-scale gating). */
  largeScaleIdfFloorThreshold: number;
  /** Capacity for the LRU retrieve cache. 0 = disabled. */
  lruCacheCapacity: number;
  /** Initial capacity hint for the inverted index. */
  invertedIndexInitialCapacity: number;
  /** Batch size for eager `computeEmbeddings` over entries. */
  embeddingBatchSize: number;
  /** Path for the on-disk content store. null = temp file. */
  contentStorePath: string | null;
  /** Retrieval-score boost weights (single owner; no hardcoded deltas). */
  retrievalBoost: RetrievalBoostConfig;
  tokenizer: TokenizerConfig;
  ebbinghaus: EbbinghausConfig;
  embeddings: EmbeddingsConfig;
  injection: InjectionConfig;
  trust: TrustConfig;
  drift: DriftConfig;
  toolResult: ToolResultConfig;
}>;

const DEFAULT_UNIFIED_CONFIG: UnifiedConfig = deepFreeze({
  contextTokenLimit: 32_768,
  trimThreshold: 0.80,
  recentTurnWindow: 10,
  summaryTokenBudget: 200,
  minRecentTurnsKept: 5,
  retrievalMethod: "hybrid" as const,
  retrievalTopK: 10,
  retrievalMinScore: 0.05,
  rrfK: 60,
  hybridEmbeddingsWeight: 0.6,
  idfFloor: 0,
  largeScaleIdfFloorThreshold: 100_000,
  lruCacheCapacity: 128,
  invertedIndexInitialCapacity: 1024,
  embeddingBatchSize: 32,
  contentStorePath: null,
  retrievalBoost: DEFAULT_RETRIEVAL_BOOST_CONFIG,
  // The sub-documents come from their own RESOLVERS, not from their default
  // constants. Same values, obtained the one way every other caller obtains
  // them, so this composed default cannot quietly stop matching what a
  // sub-resolver actually produces.
  tokenizer: resolveTokenizerConfig(),
  ebbinghaus: resolveEbbinghausConfig(),
  embeddings: resolveEmbeddingsConfig(),
  injection: DEFAULT_INJECTION_CONFIG,
  trust: DEFAULT_TRUST_CONFIG,
  drift: DEFAULT_DRIFT_CONFIG,
  toolResult: DEFAULT_TOOL_RESULT_CONFIG,
});

/**
 * The tool-result config with its LRU capacity raised to whatever this
 * context limit can name. A caller asking for MORE slots than the coupling
 * requires is honoured — that is a memory-versus-recall preference and is
 * theirs to make. Asking for FEWER is not a preference, it is a request for
 * dangling references, and there is no key that expresses it.
 */
function withDerivedLruCapacity(toolResult: ToolResultConfig, contextTokenLimit: number): ToolResultConfig {
  const required = minimumLruCapacityForContext(contextTokenLimit);
  if (toolResult.lruCapacity >= required) return toolResult;
  return { ...toolResult, lruCapacity: required };
}

export function resolveUnifiedConfig(overrides: Partial<UnifiedConfig> = {}): UnifiedConfig {
  // A name this resolver does not know is refused rather than dropped: the
  // merge below reads a fixed key list, so a misspelling would leave the
  // default in place and read as applied.
  refuseUnknownKeys(overrides, DEFAULT_UNIFIED_CONFIG, "unified memory", "unified_config_unknown_key");
  const cfg: UnifiedConfig = {
    contextTokenLimit: overrides.contextTokenLimit ?? DEFAULT_UNIFIED_CONFIG.contextTokenLimit,
    trimThreshold: overrides.trimThreshold ?? DEFAULT_UNIFIED_CONFIG.trimThreshold,
    recentTurnWindow: overrides.recentTurnWindow ?? DEFAULT_UNIFIED_CONFIG.recentTurnWindow,
    summaryTokenBudget: overrides.summaryTokenBudget ?? DEFAULT_UNIFIED_CONFIG.summaryTokenBudget,
    minRecentTurnsKept: overrides.minRecentTurnsKept ?? DEFAULT_UNIFIED_CONFIG.minRecentTurnsKept,
    retrievalMethod: overrides.retrievalMethod ?? DEFAULT_UNIFIED_CONFIG.retrievalMethod,
    retrievalTopK: overrides.retrievalTopK ?? DEFAULT_UNIFIED_CONFIG.retrievalTopK,
    retrievalMinScore: overrides.retrievalMinScore ?? DEFAULT_UNIFIED_CONFIG.retrievalMinScore,
    rrfK: overrides.rrfK ?? DEFAULT_UNIFIED_CONFIG.rrfK,
    hybridEmbeddingsWeight: overrides.hybridEmbeddingsWeight ?? DEFAULT_UNIFIED_CONFIG.hybridEmbeddingsWeight,
    idfFloor: overrides.idfFloor ?? DEFAULT_UNIFIED_CONFIG.idfFloor,
    largeScaleIdfFloorThreshold: overrides.largeScaleIdfFloorThreshold ?? DEFAULT_UNIFIED_CONFIG.largeScaleIdfFloorThreshold,
    lruCacheCapacity: overrides.lruCacheCapacity ?? DEFAULT_UNIFIED_CONFIG.lruCacheCapacity,
    invertedIndexInitialCapacity: overrides.invertedIndexInitialCapacity ?? DEFAULT_UNIFIED_CONFIG.invertedIndexInitialCapacity,
    embeddingBatchSize: overrides.embeddingBatchSize ?? DEFAULT_UNIFIED_CONFIG.embeddingBatchSize,
    contentStorePath: overrides.contentStorePath ?? DEFAULT_UNIFIED_CONFIG.contentStorePath,
    retrievalBoost: overrides.retrievalBoost ?? DEFAULT_UNIFIED_CONFIG.retrievalBoost,
    tokenizer: resolveTokenizerConfig(overrides.tokenizer ?? {}),
    ebbinghaus: resolveEbbinghausConfig(overrides.ebbinghaus ?? {}),
    embeddings: resolveEmbeddingsConfig(overrides.embeddings ?? {}),
    injection: overrides.injection ?? DEFAULT_UNIFIED_CONFIG.injection,
    trust: overrides.trust ?? DEFAULT_UNIFIED_CONFIG.trust,
    drift: overrides.drift ?? DEFAULT_UNIFIED_CONFIG.drift,
    // THE CAPACITY IS NOT A FREE PARAMETER — see the derivation's own source.
    // The store evicts by entry count and the context evicts by token weight,
    // and the two were coupled with nothing saying so: every abridged payload
    // still inside the context is a reference the model may follow, so a
    // capacity below the number of references the limit can hold makes ids
    // that resolve to nothing REACHABLE. Raising the limit alone used to be
    // enough to produce them in bulk. It is derived here rather than
    // configured, so the pair cannot be written into disagreement.
    toolResult: withDerivedLruCapacity(
      overrides.toolResult ?? DEFAULT_UNIFIED_CONFIG.toolResult,
      overrides.contextTokenLimit ?? DEFAULT_UNIFIED_CONFIG.contextTokenLimit,
    ),
  };
  if (cfg.contextTokenLimit < 1 || !Number.isFinite(cfg.contextTokenLimit)) {
    throw new InputError("contextTokenLimit must be >= 1");
  }
  if (cfg.trimThreshold < 0.5 || cfg.trimThreshold > 0.99 || !Number.isFinite(cfg.trimThreshold)) {
    throw new InputError("trimThreshold must be in [0.5, 0.99]");
  }
  if (cfg.recentTurnWindow < 1 || !Number.isFinite(cfg.recentTurnWindow)) {
    throw new InputError("recentTurnWindow must be >= 1");
  }
  if (cfg.summaryTokenBudget < 32 || !Number.isFinite(cfg.summaryTokenBudget)) {
    throw new InputError("summaryTokenBudget must be >= 32");
  }
  if (cfg.minRecentTurnsKept < 0 || !Number.isFinite(cfg.minRecentTurnsKept)) {
    throw new InputError("minRecentTurnsKept must be >= 0");
  }
  if (!["tfidf", "embeddings", "hybrid", "inverted"].includes(cfg.retrievalMethod)) {
    throw new InputError(`retrievalMethod invalid: ${cfg.retrievalMethod}`);
  }
  if (cfg.retrievalTopK < 1 || !Number.isFinite(cfg.retrievalTopK)) {
    throw new InputError("retrievalTopK must be >= 1");
  }
  if (cfg.retrievalMinScore < 0 || cfg.retrievalMinScore > 1 || !Number.isFinite(cfg.retrievalMinScore)) {
    throw new InputError("retrievalMinScore must be in [0, 1]");
  }
  if (cfg.rrfK < 1 || !Number.isFinite(cfg.rrfK)) {
    throw new InputError("rrfK must be >= 1");
  }
  if (cfg.hybridEmbeddingsWeight < 0 || cfg.hybridEmbeddingsWeight > 1 || !Number.isFinite(cfg.hybridEmbeddingsWeight)) {
    throw new InputError("hybridEmbeddingsWeight must be in [0, 1]");
  }
  if (cfg.lruCacheCapacity < 0 || !Number.isFinite(cfg.lruCacheCapacity)) {
    throw new InputError("lruCacheCapacity must be >= 0");
  }
  if (cfg.invertedIndexInitialCapacity < 1 || !Number.isFinite(cfg.invertedIndexInitialCapacity)) {
    throw new InputError("invertedIndexInitialCapacity must be >= 1");
  }
  if (cfg.largeScaleIdfFloorThreshold < 1 || !Number.isFinite(cfg.largeScaleIdfFloorThreshold)) {
    throw new InputError("largeScaleIdfFloorThreshold must be >= 1");
  }
  if (cfg.embeddingBatchSize < 1 || !Number.isFinite(cfg.embeddingBatchSize)) {
    throw new InputError("embeddingBatchSize must be >= 1");
  }
  {
    const b = cfg.retrievalBoost;
    const boosts: ReadonlyArray<readonly [number, string]> = [
      [b.kindFactAwarenessBoost, "retrievalBoost.kindFactAwarenessBoost"],
      [b.kindDecisionBoost, "retrievalBoost.kindDecisionBoost"],
      [b.topicMatchBoost, "retrievalBoost.topicMatchBoost"],
      [b.tagMatchBoost, "retrievalBoost.tagMatchBoost"],
      [b.hotModuleBoost, "retrievalBoost.hotModuleBoost"],
    ];
    for (const [v, name] of boosts) {
      if (!Number.isFinite(v) || v < 0) {
        throw new InputError(`${name} must be a finite non-negative number`);
      }
    }
  }
  return deepFreeze(cfg) as UnifiedConfig;
}
