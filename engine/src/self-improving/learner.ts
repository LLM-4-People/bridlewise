/**
 * EXP424 — Self-improving Learner: the deterministic no-LLM loop that
 * turns mistakes → prevention rules + successes → best practices.
 *
 * Reuses EXP363's pattern (extract → propose → validate → admit) and
 * extends it to:
 * - mistakes AND successes (symmetric learning),
 * - cross-run accumulation (the rules persist across runs),
 * - FP prevention on the clean set (the safety net).
 *
 * NO LLM. The learner is fully deterministic. The LLM-call counter is
 * threaded through so tests can assert 0 LLM calls during learning.
 */

import {
  type CommandLog,
  type MistakeRecord,
} from "./command-log.ts";
import {
  type BestPractice,
  BestPracticesStore,
  escapeRegex,
  type LearnedRule,
  LearnedRulesStore,
  type SelfImprovingConfig,
} from "./config.ts";
import {
  detectAllMistakes,
  type VerificationOutcome,
} from "./mistake-detector.ts";
import {
  detectSuccessPatterns,
  patternToBestPractice,
  type SuccessPattern,
} from "./success-detector.ts";
import { canonicalHash } from "../kernel/integrity.ts";

/** A proposed rule (before validation). */
export interface ProposedRule {
  spec: {
    id: string;
    type: MistakeRecord["type"];
    causeMatch: string;
    action: string;
    admittedAt: number;
    source: string;
  };
  pattern: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number };
}

/** A clean operation (used for the FP check). */
export interface CleanOperation {
  type: MistakeRecord["type"];
  cause: string;
  wouldFail: false;
}

/** Result of one learning round. */
export interface RoundResult {
  round: number;
  mistakesObserved: number;
  patternsExtracted: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[];
  patternsNovel: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[];
  rulesProposed: ProposedRule[];
  rulesAdmitted: ProposedRule[];
  rulesRejected: ProposedRule[];
  patternsUnmatched: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[];
  unknownTypes: string[];
  totalRules: number;
  patternsSuccess: SuccessPattern[];
  practicesAdmitted: BestPractice[];
  totalPractices: number;
  /** Pre-rule mistake rate (fraction of mistakes NOT covered). */
  preErrorRate: number;
  /** Post-rule mistake rate (after applying the updated rule set). */
  postErrorRate: number;
  /** FP rate after applying rules (must be 0). */
  falsePositiveRate: number;
}

/**
 * Extract recurring mistake patterns by per-type frequency analysis.
 * Deterministic: count + confidence (count/total-of-type). Filters by
 * minPatternFrequency + minConfidence, ranks by count, tie-broken
 * alphabetically.
 */
export function extractPatterns(
  mistakes: readonly MistakeRecord[],
  config: SelfImprovingConfig,
): { patterns: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[]; unknownTypes: string[] } {
  const byTypeAndCause = new Map<string, { type: MistakeRecord["type"]; cause: string; count: number }>();
  const typeTotals = new Map<string, number>();
  const unknownTypes = new Set<string>();

  for (const m of mistakes) {
    const key = `${m.type}:${m.cause}`;
    const existing = byTypeAndCause.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byTypeAndCause.set(key, { type: m.type, cause: m.cause, count: 1 });
    }
    typeTotals.set(m.type, (typeTotals.get(m.type) ?? 0) + 1);
  }

  // Detect unknown types (types not in knownCauses).
  for (const typeKey of typeTotals.keys()) {
    const known = config.knownCauses[typeKey as keyof typeof config.knownCauses];
    if (!known) unknownTypes.add(typeKey);
  }

  const patterns: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[] = [];
  for (const p of byTypeAndCause.values()) {
    if (p.count < config.minPatternFrequency) continue;
    const total = typeTotals.get(p.type) ?? 0;
    const confidence = total > 0 ? p.count / total : 0;
    if (confidence < config.minConfidence) continue;
    patterns.push({ ...p, confidence });
  }

  // Per-type cap (maxPatternsPerTypePerRound is per type).
  const byType = new Map<string, typeof patterns>();
  for (const p of patterns) {
    const list = byType.get(p.type) ?? [];
    list.push(p);
    byType.set(p.type, list);
  }
  const capped: typeof patterns = [];
  for (const [, list] of byType.entries()) {
    list.sort((a, b) =>
      b.count - a.count ||
      (a.cause < b.cause ? -1 : a.cause > b.cause ? 1 : 0));
    capped.push(...list.slice(0, config.maxRulesPerTypePerRound));
  }
  return { patterns: capped, unknownTypes: [...unknownTypes] };
}

/**
 * Filter to patterns not already covered by an existing rule.
 */
export function novelPatterns(
  patterns: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[],
  existingRules: readonly { spec: { causeMatch: string; type: string } }[],
): { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[] {
  return patterns.filter((p) => {
    for (const r of existingRules) {
      if (r.spec.type !== p.type) continue;
      if (new RegExp(r.spec.causeMatch, "u").test(p.cause)) return false;
    }
    return true;
  });
}

/**
 * Propose rules via the deterministic policy table. Returns proposed +
 * unmatched (patterns with no policy entry).
 */
export function proposeRules(
  patterns: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[],
  config: SelfImprovingConfig,
  round: number,
  source: string,
): { proposed: ProposedRule[]; unmatched: { type: MistakeRecord["type"]; cause: string; count: number; confidence: number }[] } {
  const proposed: ProposedRule[] = [];
  const unmatched: typeof patterns = [];

  for (const p of patterns) {
    // Look up the policy: policy[type][cause] = action.
    const policyForType = config.policy[p.type as keyof typeof config.policy];
    if (!policyForType) {
      unmatched.push(p);
      continue;
    }
    const action = policyForType[p.cause];
    if (!action) {
      unmatched.push(p);
      continue;
    }
    proposed.push({
      spec: {
        id: `rule-${p.type}-${p.cause}`,
        type: p.type,
        causeMatch: `^${escapeRegex(p.cause)}$`,
        action,
        admittedAt: round,
        source,
      },
      pattern: p,
    });
  }

  return { proposed, unmatched };
}

/**
 * Validate a proposed rule: admits only if (a) it covers ≥1 mistake AND
 * (b) 0 FPs on the clean set. Returns the admission decision + reason.
 */
export function validateRule(
  rule: ProposedRule,
  mistakes: readonly MistakeRecord[],
  cleanSet: readonly CleanOperation[],
): { admitted: boolean; reason: string; learnedRule?: LearnedRule } {
  // (a) coverage: at least one mistake must match.
  let coverage = 0;
  for (const m of mistakes) {
    if (m.type !== rule.spec.type) continue;
    if (new RegExp(rule.spec.causeMatch, "u").test(m.cause)) coverage += 1;
  }
  if (coverage === 0) {
    return { admitted: false, reason: "no_coverage" };
  }
  // (b) FP check: zero clean operations may match.
  let falsePositives = 0;
  for (const op of cleanSet) {
    if (op.type !== rule.spec.type) continue;
    if (new RegExp(rule.spec.causeMatch, "u").test(op.cause)) falsePositives += 1;
  }
  if (falsePositives > 0) {
    return { admitted: false, reason: `false_positive:${falsePositives}` };
  }
  const spec = rule.spec;
  const provenanceHash = canonicalHash({ ...spec, coverage, falsePositives });
  const learnedRule: LearnedRule = {
    ...spec,
    provenanceHash,
  };
  return { admitted: true, reason: "ok", learnedRule };
}

/**
 * Apply proposed rules: respects maxRules ceiling, dedups by id, delegates
 * admission to the validator. Returns admitted + rejected.
 */
export function applyProposedRules(
  proposed: ProposedRule[],
  store: LearnedRulesStore,
  config: SelfImprovingConfig,
  mistakes: readonly MistakeRecord[],
  cleanSet: readonly CleanOperation[],
): { admitted: ProposedRule[]; rejected: ProposedRule[] } {
  const admitted: ProposedRule[] = [];
  const rejected: ProposedRule[] = [];
  for (const rule of proposed) {
    if (store.size() >= config.maxRules) {
      rejected.push(rule);
      continue;
    }
    if (store.has(rule.spec.id)) {
      rejected.push(rule);
      continue;
    }
    const result = validateRule(rule, mistakes, cleanSet);
    if (result.admitted && result.learnedRule) {
      store.add(result.learnedRule);
      admitted.push(rule);
    } else {
      rejected.push(rule);
    }
  }
  return { admitted, rejected };
}

/**
 * Apply a learned rule set to a batch of simulated operations. Returns:
 * - prevented: a rule caught a real failure.
 * - errors: no rule covered the operation.
 * - falsePositives: a rule WRONGLY caught a clean operation.
 */
export function applyRulesToOperations(
  ops: { type: MistakeRecord["type"]; cause: string; wouldFail: boolean }[],
  store: LearnedRulesStore,
): { prevented: number; errors: number; falsePositives: number } {
  let prevented = 0;
  let errors = 0;
  let falsePositives = 0;
  for (const op of ops) {
    let covered = false;
    for (const r of store.all()) {
      if (r.type !== op.type) continue;
      if (new RegExp(r.causeMatch, "u").test(op.cause)) {
        covered = true;
        break;
      }
    }
    if (covered) {
      if (op.wouldFail) prevented += 1;
      else falsePositives += 1;
    } else {
      if (op.wouldFail) errors += 1;
    }
  }
  return { prevented, errors, falsePositives };
}

/**
 * Run ONE learning round over a CommandLog. Returns the full RoundResult.
 */
export function runLearningRound(
  log: CommandLog,
  rulesStore: LearnedRulesStore,
  practicesStore: BestPracticesStore,
  config: SelfImprovingConfig,
  round: number,
  source: string,
  options?: {
    verifications?: ReadonlyMap<string, VerificationOutcome>;
    expectedResults?: ReadonlyMap<string, string>;
    contextBudget?: number;
    declaredTasks?: ReadonlyMap<string, string>;
    knownFiles?: ReadonlySet<string>;
    cleanSet?: readonly CleanOperation[];
  },
): RoundResult {
  // (1) Detect ALL mistakes in the log (deterministic).
  const mistakes = detectAllMistakes(log, options);
  // (2) Compute pre-rule error rate (fraction of mistakes NOT covered).
  const pre = computeErrorRate(mistakes, rulesStore);
  // (3) Extract recurring patterns + detect novel types.
  const { patterns, unknownTypes } = extractPatterns(mistakes, config);
  // (4) Filter to patterns not already covered.
  const existingRules = rulesStore.all().map((r) => ({ spec: { causeMatch: r.causeMatch, type: r.type } }));
  const patternsNovel = novelPatterns(patterns, existingRules);
  // (5) Propose rules via the policy table.
  const { proposed, unmatched } = proposeRules(patternsNovel, config, round, source);
  // (6) Validate + admit (0 FPs required).
  const cleanSet = options?.cleanSet ?? [];
  const { admitted, rejected } = applyProposedRules(proposed, rulesStore, config, mistakes, cleanSet);
  // (7) Detect success patterns + admit best practices.
  const successPatterns = detectSuccessPatterns(log, config);
  const practicesAdmitted: BestPractice[] = [];
  const maxNewPractices = Math.max(0, config.maxPractices - practicesStore.size());
  for (const p of successPatterns.slice(0, Math.min(config.maxPracticesPerRound, maxNewPractices))) {
    const bp = patternToBestPractice(p, round, source);
    if (!practicesStore.has(bp.id)) {
      practicesStore.add(bp);
      practicesAdmitted.push(bp);
    }
  }
  // (8) Compute post-rule error rate (after applying the updated rule set).
  const post = computeErrorRate(mistakes, rulesStore);
  // (9) Compute FP rate (should be 0 — the validator guarantees it).
  const fpRate = computeFalsePositiveRate(rulesStore, cleanSet);
  return {
    round,
    mistakesObserved: mistakes.length,
    patternsExtracted: patterns,
    patternsNovel,
    rulesProposed: proposed,
    rulesAdmitted: admitted,
    rulesRejected: rejected,
    patternsUnmatched: unmatched,
    unknownTypes,
    totalRules: rulesStore.size(),
    patternsSuccess: successPatterns,
    practicesAdmitted,
    totalPractices: practicesStore.size(),
    preErrorRate: pre,
    postErrorRate: post,
    falsePositiveRate: fpRate,
  };
}

/** Compute the error rate: fraction of mistakes NOT covered by a rule. */
export function computeErrorRate(
  mistakes: readonly MistakeRecord[],
  store: LearnedRulesStore,
): number {
  if (mistakes.length === 0) return 0;
  let uncovered = 0;
  for (const m of mistakes) {
    let covered = false;
    for (const r of store.all()) {
      if (r.type !== m.type) continue;
      if (new RegExp(r.causeMatch, "u").test(m.cause)) {
        covered = true;
        break;
      }
    }
    if (!covered) uncovered += 1;
  }
  return uncovered / mistakes.length;
}

/** Compute the FP rate: fraction of clean operations WRONGLY covered. */
export function computeFalsePositiveRate(
  store: LearnedRulesStore,
  cleanSet: readonly CleanOperation[],
): number {
  if (cleanSet.length === 0) return 0;
  let falsePositives = 0;
  for (const op of cleanSet) {
    for (const r of store.all()) {
      if (r.type !== op.type) continue;
      if (new RegExp(r.causeMatch, "u").test(op.cause)) {
        falsePositives += 1;
        break;
      }
    }
  }
  return falsePositives / cleanSet.length;
}

/**
 * Mark which mistakes are now covered after learning. Returns a NEW list
 * of MistakeRecords with `coveredAfterLearning: true` for the covered ones.
 */
export function markCoveredAfterLearning(
  mistakes: readonly MistakeRecord[],
  store: LearnedRulesStore,
): MistakeRecord[] {
  return mistakes.map((m) => {
    let covered = false;
    for (const r of store.all()) {
      if (r.type !== m.type) continue;
      if (new RegExp(r.causeMatch, "u").test(m.cause)) {
        covered = true;
        break;
      }
    }
    return { ...m, coveredAfterLearning: covered };
  });
}

/**
 * LLM-call counter. Tests assert this stays 0 during learning. The actual
 * coding tasks may use the LLM; the LEARNING loop does not.
 */
export class LlmCallCounter {
  private count = 0;
  bump(): void { this.count += 1; }
  value(): number { return this.count; }
  reset(): void { this.count = 0; }
}
