import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";

/**
 * Bias detection + prevention configuration.
 *
 * Single source of truth for every bias threshold. Nothing in the
 * detector/preventer hardcodes a number — every limit comes from here.
 *
 * The eight bias types model the LLM-to-machine interface failure modes
 * the user named on 2026-07-21: confirmation, anchoring, selection,
 * recency, availability, representation, sampling, metric. Each type has
 * an enabled flag and type-specific thresholds; the preventer also draws
 * on shared limits (forced balance ratio, coverage minimum, etc.).
 *
 * Per binding directive "everything dynamically computed, no static
 * variables/consts": callers should construct this via
 * `resolveBiasConfig` so overrides flow through validation. The
 * `BIAS_DEFAULT_CONFIG` object below is the only static value, and it
 * lives in this file (the config owner), not in any detector/preventer
 * code path.
 */
export const BIAS_TYPES = deepFreeze([
  "confirmation",
  "anchoring",
  "selection",
  "recency",
  "availability",
  "representation",
  "sampling",
  "metric",
] as const);

export type BiasType = typeof BIAS_TYPES[number];

export type BiasStance = "for" | "against" | "neutral";

export type BiasThresholdConfig = Readonly<{
  enabled: boolean;
  /** Minimum number of recorded events before this bias is evaluated. */
  minEvents: number;
  /** Detection threshold (interpretation is type-specific; see below). */
  threshold: number;
}>;

export type BiasConfig = Readonly<{
  /** Per-bias-type thresholds. Keys not present fall back to defaults. */
  biases: Readonly<Record<BiasType, BiasThresholdConfig>>;
  /** Maximum ratio of `for` vs `against` searches before confirmation bias fires. */
  confirmationMaxForAgainstRatio: number;
  /** Minimum number of contradicting searches required to clear confirmation bias. */
  confirmationMinAgainstSearches: number;
  /** Cosine/Jaccard similarity above which two answers are treated as "converged" (anchoring). */
  anchoringConvergenceSimilarity: number;
  /** Turn interval at which the preventer forces a from-scratch re-evaluation. */
  anchoringReevaluationInterval: number;
  /** Minimum fraction of relevant files the LLM must read to clear selection bias. */
  selectionCoverageMinimum: number;
  /** Maximum ratio of supporting to contradicting files before selection bias fires. */
  selectionMaxSupportingContradictingRatio: number;
  /** Minimum cosine similarity to an established memory fact to clear recency bias. */
  recencyMinMemoryAlignment: number;
  /** Maximum cosine similarity to recent context before recency bias fires (when memory alignment is low). */
  recencyMaxRecentAlignment: number;
  /** Memory trust enforcement cascade — reused from EXP360/371 (DRY). */
  recencyEnforcement: Readonly<{
    enabled: boolean;
    bypassAfterFails: number;
  }>;
  /**
   * Minimum retention score contribution so a near-zero Ebbinghaus retention
   * fact still ranks above zero in the availability-bias relevance scoring
   * (prevents a freshly-forgotten fact from being invisible to retrieval).
   * Configurable: previously a hardcoded `0.01` floor in
   * `bias-preventer.ts`.
   */
  retentionScoreFloor: number;
  /** Top-K relevant memory entries used as the availability-bias reference set. */
  availabilityTopK: number;
  /** Minimum fraction of the top-K most-relevant entries the answer must reflect to clear availability bias. */
  availabilityMinRelevantCoverage: number;
  /** Minimum fraction of codebase patterns the LLM's suggestions must match to clear representation bias. */
  representationMinPatternMatch: number;
  /** Minimum fraction of the codebase the search must index to clear sampling bias. */
  samplingMinCoverage: number;
  /** When sampling is below `samplingMinCoverage`, the strategy must be documented or bias fires. */
  samplingAllowDocumentedStrategy: boolean;
  /** Minimum number of inspected functions to decide whether a metric is biased (metric bias). */
  metricMinInspected: number;
  /** Maximum false-positive rate before a metric is flagged as biased. */
  metricMaxFalsePositiveRate: number;
  /** Whether the preventer should annotate metric findings with context. */
  metricProvideContext: boolean;
}>;

const BIAS_DEFAULT_CONFIG = deepFreeze({
  biases: {
    confirmation: { enabled: true, minEvents: 4, threshold: 0.5 },
    anchoring: { enabled: true, minEvents: 2, threshold: 0.85 },
    selection: { enabled: true, minEvents: 5, threshold: 0.5 },
    recency: { enabled: true, minEvents: 1, threshold: 0.5 },
    availability: { enabled: true, minEvents: 1, threshold: 0.4 },
    representation: { enabled: true, minEvents: 1, threshold: 0.5 },
    sampling: { enabled: true, minEvents: 1, threshold: 0.9 },
    metric: { enabled: true, minEvents: 5, threshold: 0.3 },
  },
  confirmationMaxForAgainstRatio: 3,
  confirmationMinAgainstSearches: 1,
  anchoringConvergenceSimilarity: 0.85,
  anchoringReevaluationInterval: 10,
  selectionCoverageMinimum: 0.8,
  selectionMaxSupportingContradictingRatio: 3,
  recencyMinMemoryAlignment: 0.3,
  recencyMaxRecentAlignment: 0.7,
  recencyEnforcement: { enabled: true, bypassAfterFails: 3 },
  retentionScoreFloor: 0.01,
  availabilityTopK: 5,
  availabilityMinRelevantCoverage: 0.4,
  representationMinPatternMatch: 0.5,
  samplingMinCoverage: 0.9,
  samplingAllowDocumentedStrategy: true,
  metricMinInspected: 5,
  metricMaxFalsePositiveRate: 0.3,
  metricProvideContext: true,
} as const);

const BIAS_TYPE_SET = new Set<string>(BIAS_TYPES);

export function isBiasType(value: unknown): value is BiasType {
  return typeof value === "string" && BIAS_TYPE_SET.has(value);
}

function resolveOneBias(
  key: BiasType,
  base: BiasThresholdConfig,
  overrides?: Partial<BiasThresholdConfig>,
): BiasThresholdConfig {
  const merged: BiasThresholdConfig = {
    enabled: overrides?.enabled ?? base.enabled,
    minEvents: overrides?.minEvents ?? base.minEvents,
    threshold: overrides?.threshold ?? base.threshold,
  };
  if (!Number.isFinite(merged.minEvents) || merged.minEvents < 0) {
    throw new InputError(
      `bias.${key}.minEvents must be a non-negative finite number`,
      "bias_config_invalid",
    );
  }
  if (!Number.isFinite(merged.threshold) || merged.threshold < 0 || merged.threshold > 1) {
    throw new InputError(
      `bias.${key}.threshold must be a finite number in [0, 1]`,
      "bias_config_invalid",
    );
  }
  return merged;
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError(`${field} must be a positive finite number`, "bias_config_invalid");
  }
}

function assertUnitRange(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new InputError(`${field} must be a finite number in [0, 1]`, "bias_config_invalid");
  }
}

/**
 * Construct a validated `BiasConfig`. Unknown bias keys in `overrides`
 * are rejected; missing keys fall back to `BIAS_DEFAULT_CONFIG`.
 */
export function resolveBiasConfig(overrides: Partial<BiasConfig> = {}): BiasConfig {
  const baseBiases = BIAS_DEFAULT_CONFIG.biases;
  const overrideBiases: Readonly<Partial<Record<BiasType, Partial<BiasThresholdConfig>>>> =
    overrides.biases ?? {};
  for (const key of Object.keys(overrideBiases)) {
    if (!isBiasType(key)) {
      throw new InputError(
        `unknown bias type "${key}" in overrides.biases`,
        "bias_config_invalid",
      );
    }
  }
  const biases = {} as Record<BiasType, BiasThresholdConfig>;
  for (const t of BIAS_TYPES) {
    biases[t] = resolveOneBias(t, baseBiases[t], overrideBiases[t]);
  }

  const confirmationMaxForAgainstRatio =
    overrides.confirmationMaxForAgainstRatio ?? BIAS_DEFAULT_CONFIG.confirmationMaxForAgainstRatio;
  const confirmationMinAgainstSearches =
    overrides.confirmationMinAgainstSearches ?? BIAS_DEFAULT_CONFIG.confirmationMinAgainstSearches;
  const anchoringConvergenceSimilarity =
    overrides.anchoringConvergenceSimilarity ?? BIAS_DEFAULT_CONFIG.anchoringConvergenceSimilarity;
  const anchoringReevaluationInterval =
    overrides.anchoringReevaluationInterval ?? BIAS_DEFAULT_CONFIG.anchoringReevaluationInterval;
  const selectionCoverageMinimum =
    overrides.selectionCoverageMinimum ?? BIAS_DEFAULT_CONFIG.selectionCoverageMinimum;
  const selectionMaxSupportingContradictingRatio =
    overrides.selectionMaxSupportingContradictingRatio ??
    BIAS_DEFAULT_CONFIG.selectionMaxSupportingContradictingRatio;
  const recencyMinMemoryAlignment =
    overrides.recencyMinMemoryAlignment ?? BIAS_DEFAULT_CONFIG.recencyMinMemoryAlignment;
  const recencyMaxRecentAlignment =
    overrides.recencyMaxRecentAlignment ?? BIAS_DEFAULT_CONFIG.recencyMaxRecentAlignment;
  const recencyEnforcementBase =
    overrides.recencyEnforcement ?? BIAS_DEFAULT_CONFIG.recencyEnforcement;
  const retentionScoreFloor =
    overrides.retentionScoreFloor ?? BIAS_DEFAULT_CONFIG.retentionScoreFloor;
  const availabilityTopK = overrides.availabilityTopK ?? BIAS_DEFAULT_CONFIG.availabilityTopK;
  const availabilityMinRelevantCoverage =
    overrides.availabilityMinRelevantCoverage ?? BIAS_DEFAULT_CONFIG.availabilityMinRelevantCoverage;
  const representationMinPatternMatch =
    overrides.representationMinPatternMatch ?? BIAS_DEFAULT_CONFIG.representationMinPatternMatch;
  const samplingMinCoverage =
    overrides.samplingMinCoverage ?? BIAS_DEFAULT_CONFIG.samplingMinCoverage;
  const samplingAllowDocumentedStrategy =
    overrides.samplingAllowDocumentedStrategy ?? BIAS_DEFAULT_CONFIG.samplingAllowDocumentedStrategy;
  const metricMinInspected =
    overrides.metricMinInspected ?? BIAS_DEFAULT_CONFIG.metricMinInspected;
  const metricMaxFalsePositiveRate =
    overrides.metricMaxFalsePositiveRate ?? BIAS_DEFAULT_CONFIG.metricMaxFalsePositiveRate;
  const metricProvideContext =
    overrides.metricProvideContext ?? BIAS_DEFAULT_CONFIG.metricProvideContext;

  assertPositiveFinite(confirmationMaxForAgainstRatio, "confirmationMaxForAgainstRatio");
  assertPositiveFinite(confirmationMinAgainstSearches, "confirmationMinAgainstSearches");
  assertUnitRange(anchoringConvergenceSimilarity, "anchoringConvergenceSimilarity");
  assertPositiveFinite(anchoringReevaluationInterval, "anchoringReevaluationInterval");
  assertUnitRange(selectionCoverageMinimum, "selectionCoverageMinimum");
  assertPositiveFinite(selectionMaxSupportingContradictingRatio, "selectionMaxSupportingContradictingRatio");
  assertUnitRange(recencyMinMemoryAlignment, "recencyMinMemoryAlignment");
  assertUnitRange(recencyMaxRecentAlignment, "recencyMaxRecentAlignment");
  if (!Number.isFinite(retentionScoreFloor) || retentionScoreFloor < 0 || retentionScoreFloor > 1) {
    throw new InputError("retentionScoreFloor must be a finite number in [0, 1]", "bias_config_invalid");
  }
  assertPositiveFinite(availabilityTopK, "availabilityTopK");
  assertUnitRange(availabilityMinRelevantCoverage, "availabilityMinRelevantCoverage");
  assertUnitRange(representationMinPatternMatch, "representationMinPatternMatch");
  assertUnitRange(samplingMinCoverage, "samplingMinCoverage");
  assertPositiveFinite(metricMinInspected, "metricMinInspected");
  assertUnitRange(metricMaxFalsePositiveRate, "metricMaxFalsePositiveRate");
  if (!Number.isFinite(recencyEnforcementBase.bypassAfterFails) || recencyEnforcementBase.bypassAfterFails < 1) {
    throw new InputError("recencyEnforcement.bypassAfterFails must be >= 1", "bias_config_invalid");
  }

  const config: BiasConfig = {
    biases: deepFreeze(biases),
    confirmationMaxForAgainstRatio,
    confirmationMinAgainstSearches,
    anchoringConvergenceSimilarity,
    anchoringReevaluationInterval,
    selectionCoverageMinimum,
    selectionMaxSupportingContradictingRatio,
    recencyMinMemoryAlignment,
    recencyMaxRecentAlignment,
    recencyEnforcement: deepFreeze({
      enabled: recencyEnforcementBase.enabled,
      bypassAfterFails: recencyEnforcementBase.bypassAfterFails,
    }),
    retentionScoreFloor,
    availabilityTopK,
    availabilityMinRelevantCoverage,
    representationMinPatternMatch,
    samplingMinCoverage,
    samplingAllowDocumentedStrategy,
    metricMinInspected,
    metricMaxFalsePositiveRate,
    metricProvideContext,
  };
  return deepFreeze(config);
}
