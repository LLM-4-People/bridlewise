/**
 * EXP424 — Self-improving workflow: canonical configuration authority.
 *
 * One owner of every threshold, catalog, policy table, and schema. Every
 * other module reads this config — there are NO static success values, no
 * hardcoded thresholds, no inline policies. The behavior is fully driven by
 * the (optionally overridden) config so tests can prove thresholds drive
 * behavior by mutating them.
 *
 * Reuses EXP363's pattern (deterministic policy table + 0-LLM learning)
 * and extends it across ALL command types (not just errors): commands,
 * mistakes, successes, redundancies, deviations, and workflow
 * inefficiencies. The LLM only generates; the harness detects, learns,
 * and improves mechanically.
 */

import { z } from "zod";

import { InputError } from "../kernel/errors.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { schemaId } from "../kernel/product-identity.ts";

/** The schema version for the persisted learned-rules store. */
const LEARNED_RULES_STORE_SCHEMA_VERSION = schemaId("learned-rules-store", 2);

/** Canonical command-type catalog (the only place these live). */
export const COMMAND_TYPES = [
  "search",
  "edit",
  "execute",
  "read_file",
  "write_file",
  "tool",
  "agent",
  "quality",
  "memory",
  "context",
  "other",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** Mistake categories the detector classifies (the only catalog). */
export const MISTAKE_TYPES = [
  "command_failed",
  "wrong_result",
  "redundant_call",
  "deviation",
  "bandaid",
  "workaround",
  "hallucination",
  "false_positive",
  "context_overflow",
  "tool_misuse",
] as const;
export type MistakeType = (typeof MISTAKE_TYPES)[number];

/** Workflow-inefficiency categories the improver identifies. */
const INEFFICIENCY_TYPES = [
  "duplicate_calls",
  "missing_cache",
  "missing_shortcut",
  "missing_tool",
  "bad_tool_choice",
  "context_waste",
  "retry_storm",
  "feedback_loop",
  "unbatched_calls",
  "low_cache_hit_rate",
] as const;
export type InefficiencyType = (typeof INEFFICIENCY_TYPES)[number];

/** Fixable causes — each maps to a deterministic prevention rule. */
export const FIXABLE_CAUSES: Readonly<Record<string, string>> = {
  "invalid_regex": "validate_regex",
  "missing_preimage": "verify_preimage",
  "wrong_tool": "suggest_tool",
  "syntax_error": "lint_before_apply",
  "stale_context": "refresh_context",
  "oversized_payload": "enforce_budget",
  "duplicate_query": "cache_result",
  "unbounded_search": "bound_search",
  "missing_file": "verify_path",
  "wrong_directory": "verify_cwd",
  "tool_misuse_args": "validate_args",
  "uncaught_throw": "typed_error",
  "swallowed_catch": "surface_error",
  "matches_true": "no_hardcoded_success",
  "retry_exhausted": "fallback_action",
};

/** Causes that have NO deterministic rule (structural, future research). */
export const UNFIXABLE_CAUSES: Readonly<Record<string, string>> = {
  "semantic_mismatch": "needs_semantic_layer",
  "model_limitation": "needs_better_model",
  "unknown_unknown": "needs_research",
};

/** Clean-cause suffix used to build the FP test set (near-miss patterns). */

/**
 * A learned rule spec. The validator enforces: covers ≥1 mistake AND 0 FPs
 * on the clean set. Rules are persisted to disk as validated JSON.
 */
const LEARNED_RULE_SPEC_SCHEMA = z.object({
  id: z.string().min(1),
  type: z.enum(MISTAKE_TYPES),
  causeMatch: z.string().min(1),
  action: z.string().min(1),
  /** Round number when the rule was admitted. */
  admittedAt: z.number().int().nonnegative(),
  /** Free-form provenance: which experiments/sessions produced it. */
  source: z.string().min(1),
});
export type LearnedRuleSpec = z.infer<typeof LEARNED_RULE_SPEC_SCHEMA>;

/** A persisted learned-rule entry (with the spec + provenance hash). */
const LEARNED_RULE_SCHEMA = LEARNED_RULE_SPEC_SCHEMA.extend({
  provenanceHash: z.string().length(64),
});
export type LearnedRule = z.infer<typeof LEARNED_RULE_SCHEMA>;

/** Schema for the persisted store. */
const RULES_STORE_SCHEMA = z.object({
  schemaVersion: z.literal(LEARNED_RULES_STORE_SCHEMA_VERSION),
  rules: z.array(LEARNED_RULE_SCHEMA),
  updatedAt: z.string().min(1),
});
export type RulesStore = z.infer<typeof RULES_STORE_SCHEMA>;

/**
 * Best practices learned from successful commands. Reuse the same shape as
 * learned rules but track `success_count` and `confidence` instead of
 * mistake coverage.
 */
const BEST_PRACTICE_SPEC_SCHEMA = z.object({
  id: z.string().min(1),
  type: z.enum(COMMAND_TYPES),
  pattern: z.string().min(1),
  practice: z.string().min(1),
  successCount: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  admittedAt: z.number().int().nonnegative(),
  source: z.string().min(1),
});
export type BestPracticeSpec = z.infer<typeof BEST_PRACTICE_SPEC_SCHEMA>;

export const BEST_PRACTICE_SCHEMA = BEST_PRACTICE_SPEC_SCHEMA.extend({
  provenanceHash: z.string().length(64),
});
export type BestPractice = z.infer<typeof BEST_PRACTICE_SCHEMA>;

/**
 * Workflow improvement (an identified inefficiency + suggested improvement).
 * Improvements are EITHER auto-applied (if `safe: true` and `action` is
 * whitelisted) OR surfaced to the user as a recommendation.
 */
export const IMPROVEMENT_SCHEMA = z.object({
  id: z.string().min(1),
  type: z.enum(INEFFICIENCY_TYPES),
  evidence: z.string().min(1),
  suggestion: z.string().min(1),
  safe: z.boolean(),
  admittedAt: z.number().int().nonnegative(),
  source: z.string().min(1),
});
export type Improvement = z.infer<typeof IMPROVEMENT_SCHEMA>;

/** Inner cause → action mapping. */
type CauseActionMap = Readonly<Record<string, string>>;

/** The canonical policy table: mistake-type + cause → action. */
export type PolicyTable = Readonly<Record<MistakeType, CauseActionMap>>;

/**
 * The self-improving config. Every threshold is here — no module may pick
 * its own. Tests mutate these to prove the thresholds drive behavior.
 */
const SELFIMPROVING_CONFIG_SCHEMA = z.object({
  /** Min frequency for a pattern to be considered recurring. */
  minPatternFrequency: z.number().int().positive(),
  /** Min confidence (count/total-of-type) for a pattern to be considered. */
  minConfidence: z.number().min(0).max(1),
  /** Max rules per type per round (cap on admission rate). */
  maxRulesPerTypePerRound: z.number().int().positive(),
  /** Global rule ceiling across all types. */
  maxRules: z.number().int().positive(),
  /** Whether to accumulate patterns across rounds or reset each round. */
  accumulateAcrossRounds: z.boolean(),
  /** Min success count for a best practice. */
  minSuccessCount: z.number().int().positive(),
  /** Min confidence for a best practice. */
  minPracticeConfidence: z.number().min(0).max(1),
  /** Max best practices to admit per round. */
  maxPracticesPerRound: z.number().int().positive(),
  /** Max global best practices. */
  maxPractices: z.number().int().positive(),
  /** Min occurrences for an inefficiency to be flagged. */
  minInefficiencyOccurrences: z.number().int().positive(),
  /** Cache hit-rate threshold below which we flag low_cache_hit_rate. */
  lowCacheHitRateThreshold: z.number().min(0).max(1),
  /** Duplicate-call threshold (same call ≥ N times = inefficiency). */
  duplicateCallThreshold: z.number().int().positive(),
  /** R49-V6: char length above which a successful command output is flagged
   * as context_waste (the harness should slice/compress instead of
   * re-injecting the full output). Single owner — previously a hardcoded
   * `5000` inline literal in workflow-improver.ts. */
  largeOutputChars: z.number().int().positive(),
  /** The LLM boundary policy: which output categories count as mechanical. */
  mechanicalCategories: z.array(z.string()),
  /** The LLM boundary: which output categories count as generation. */
  generationCategories: z.array(z.string()),
  /** The deterministic policy table (mistake-type + cause → action). */
  policy: z.record(z.enum(MISTAKE_TYPES), z.record(z.string(), z.string())),
  /** Known-cause catalog (per mistake type). */
  knownCauses: z.record(z.enum(MISTAKE_TYPES), z.array(z.string()).readonly()),
});
export type SelfImprovingConfig = z.infer<typeof SELFIMPROVING_CONFIG_SCHEMA>;

/** Default deterministic policy table built from FIXABLE_CAUSES. */
const DEFAULT_POLICY: PolicyTable = Object.fromEntries(
  MISTAKE_TYPES.map((t) => [
    t,
    Object.fromEntries(
      Object.entries(FIXABLE_CAUSES).map(([cause, action]) => [cause, action]),
    ),
  ]),
) as PolicyTable;

/** Default known-cause catalog (fixable + unfixable, per mistake type). */
const DEFAULT_KNOWN_CAUSES: Readonly<Record<MistakeType, readonly string[]>> =
  Object.fromEntries(
    MISTAKE_TYPES.map((t) => [
      t,
      [...Object.keys(FIXABLE_CAUSES), ...Object.keys(UNFIXABLE_CAUSES)],
    ]),
  ) as unknown as Readonly<Record<MistakeType, readonly string[]>>;

/** The default config — every threshold + the policy table. */
export const DEFAULT_SELF_IMPROVING_CONFIG: SelfImprovingConfig = {
  minPatternFrequency: 2,
  minConfidence: 0.10,
  maxRulesPerTypePerRound: 5,
  maxRules: 500,
  accumulateAcrossRounds: true,
  minSuccessCount: 3,
  minPracticeConfidence: 0.60,
  maxPracticesPerRound: 5,
  maxPractices: 200,
  minInefficiencyOccurrences: 2,
  lowCacheHitRateThreshold: 0.30,
  duplicateCallThreshold: 3,
  largeOutputChars: 5000,
  mechanicalCategories: [
    "error_handling",
    "tool_selection",
    "context_management",
    "quality_check",
    "hallucination_check",
    "memory_management",
    "workflow_improvement",
    "retry",
    "fallback",
    "search_invocation",
    "edit_application",
    "verification",
  ],
  generationCategories: [
    "code",
    "text",
    "explanation",
    "decision",
    "plan",
    "natural_language",
    "rationale",
  ],
  policy: DEFAULT_POLICY,
  knownCauses: DEFAULT_KNOWN_CAUSES,
};

/**
 * Load the self-improving config, optionally overriding fields. The merge
 * is validated — an invalid override throws `InputError` (never silently
 * falls back). This is the ONLY way to obtain a config.
 */
export function loadSelfImprovingConfig(
  overrides?: Partial<SelfImprovingConfig>,
): SelfImprovingConfig {
  if (!overrides) return DEFAULT_SELF_IMPROVING_CONFIG;
  const merged = { ...DEFAULT_SELF_IMPROVING_CONFIG, ...overrides };
  const result = SELFIMPROVING_CONFIG_SCHEMA.safeParse(merged);
  if (!result.success) {
    throw new InputError(
      `Invalid self-improving config: ${result.error.message}`,
      "self_improving_config_invalid",
    );
  }
  return result.data;
}

/**
 * Escape a string for safe use in a `^...$` regex (used by the policy table
 * builder so the policy entries are precise — they do not over-match
 * near-miss clean patterns).
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * In-memory learned-rules store. Persists as validated JSON; a corrupted
 * store starts empty (never injects bad rules). The single owner of the
 * rule collection.
 */
export class LearnedRulesStore {
  private readonly rules = new Map<string, LearnedRule>();

  constructor(initial?: readonly LearnedRule[]) {
    if (initial) for (const r of initial) this.add(r);
  }

  add(rule: LearnedRule): void {
    this.rules.set(rule.id, rule);
  }

  has(id: string): boolean {
    return this.rules.has(id);
  }

  get(id: string): LearnedRule | undefined {
    return this.rules.get(id);
  }

  all(): LearnedRule[] {
    return [...this.rules.values()];
  }

  size(): number {
    return this.rules.size;
  }

  clear(): void {
    this.rules.clear();
  }

  /** Persist the store to JSON (validates before writing). */
  serialize(): string {
    const data: RulesStore = {
      schemaVersion: LEARNED_RULES_STORE_SCHEMA_VERSION,
      rules: this.all(),
      updatedAt: new Date().toISOString(),
    };
    const parsed = RULES_STORE_SCHEMA.parse(data);
    return JSON.stringify(parsed, null, 2);
  }

  /** Reload from JSON (corrupted/invalid → empty store, never throws). */
  static deserialize(json: string): LearnedRulesStore {
    try {
      const parsed: unknown = JSON.parse(json);
      const result = RULES_STORE_SCHEMA.safeParse(parsed);
      if (!result.success) return new LearnedRulesStore();
      return new LearnedRulesStore(result.data.rules);
    } catch (e) {
      // R49-V7: route the swallowed catch through the debug owner
      // so a corrupted store or a real bug is visible when debug is on, while
      // preserving the "never throws — returns empty store" contract.
      handleError(e, { module: "self-improving-config", operation: "learned-rules-store-deserialize" });
      return new LearnedRulesStore();
    }
  }
}

/**
 * In-memory best-practices store. Same persistence pattern as LearnedRulesStore
 * (corrupted → empty, never injects bad data).
 */
export class BestPracticesStore {
  private readonly practices = new Map<string, BestPractice>();

  constructor(initial?: readonly BestPractice[]) {
    if (initial) for (const p of initial) this.add(p);
  }

  add(practice: BestPractice): void {
    this.practices.set(practice.id, practice);
  }

  has(id: string): boolean {
    return this.practices.has(id);
  }

  all(): BestPractice[] {
    return [...this.practices.values()];
  }

  size(): number {
    return this.practices.size;
  }

  clear(): void {
    this.practices.clear();
  }
}
