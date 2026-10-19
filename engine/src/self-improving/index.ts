/**
 * EXP424 — Self-improving workflow orchestrator.
 *
 * The canonical entry point for the self-improving loop:
 * 1. The harness runs a task (logs all commands to the CommandLog).
 * 2. The mistake detector inspects every command (logs all mistakes).
 * 3. The success detector extracts successful patterns.
 * 4. The learner turns mistakes → prevention rules + successes → best practices.
 * 5. The workflow improver identifies inefficiencies + suggests improvements.
 * 6. The LLM boundary measures generation vs mechanical output.
 * 7. The next task benefits from the rules (fewer mistakes).
 *
 * The LLM's only job is GENERATE. Everything else (detection, learning,
 * improvement, error handling, context management) is MECHANICAL.
 */

import {
  CommandLog,
  type CommandRecord,
  type MistakeRecord,
} from "./command-log.ts";
import {
  type BestPractice,
  BestPracticesStore,
  type LearnedRule,
  LearnedRulesStore,
  type SelfImprovingConfig,
  loadSelfImprovingConfig,
} from "./config.ts";
import {
  type CleanOperation,
  type RoundResult,
  runLearningRound,
} from "./learner.ts";
import {
  type VerificationOutcome,
} from "./mistake-detector.ts";
import {
  analyzeInefficiencies,
  applyImprovements,
  type InefficiencyFinding,
} from "./workflow-improver.ts";
import type { Improvement } from "./config.ts";
import {
  classifyResponse,
  type LLMResponseClassification,
  interceptRequest,
  buildFailureSignal,
} from "./llm-boundary.ts";

/** A self-improving workflow instance (one per harness run). */
export class SelfImprovingWorkflow {
  readonly log: CommandLog;
  readonly rules: LearnedRulesStore;
  readonly practices: BestPracticesStore;
  readonly config: SelfImprovingConfig;
  private round = 0;
  private readonly improvements: Improvement[] = [];

  constructor(config?: Partial<SelfImprovingConfig>) {
    this.config = loadSelfImprovingConfig(config);
    this.log = new CommandLog();
    this.rules = new LearnedRulesStore();
    this.practices = new BestPracticesStore();
  }

  /**
   * Run one learning round over the current log. Returns the full
   * RoundResult + the identified inefficiencies.
   */
  runRound(options?: {
    verifications?: ReadonlyMap<string, VerificationOutcome>;
    expectedResults?: ReadonlyMap<string, string>;
    contextBudget?: number;
    declaredTasks?: ReadonlyMap<string, string>;
    knownFiles?: ReadonlySet<string>;
    cleanSet?: readonly CleanOperation[];
    source?: string;
  }): {
    roundResult: RoundResult;
    inefficiencies: InefficiencyFinding[];
    improvementsApplied: Improvement[];
    improvementsRecommended: Improvement[];
  } {
    this.round += 1;
    const roundResult = runLearningRound(
      this.log,
      this.rules,
      this.practices,
      this.config,
      this.round,
      options?.source ?? `round-${this.round}`,
      options,
    );
    const inefficiencies = analyzeInefficiencies(this.log, this.config);
    const { applied, recommended } = applyImprovements(inefficiencies, this.round, options?.source ?? `round-${this.round}`);
    this.improvements.push(...applied, ...recommended);
    return {
      roundResult,
      inefficiencies,
      improvementsApplied: applied,
      improvementsRecommended: recommended,
    };
  }

  /**
   * Classify an LLM response (generation vs mechanical). Used after the
   * LLM responds to verify it only generated.
   */
  classifyLLMResponse(rawResponse: string): LLMResponseClassification {
    return classifyResponse(rawResponse, this.config);
  }

  /**
   * Intercept a request before sending to the LLM. Removes mechanical
   * context (errors, retries, fallbacks) and returns the cleaned context +
   * the removed spans (which the harness handles mechanically).
   */
  interceptRequest(context: string): { cleanedContext: string; removedSpans: { category: string; text: string }[] } {
    return interceptRequest(context, this.config);
  }

  /**
   * Build a failure signal for the LLM (replaces raw errors).
   */
  buildFailureSignal(previousAttempt: string, reason: string): string {
    return buildFailureSignal(previousAttempt, reason);
  }

  /** Total rules learned so far. */
  ruleCount(): number { return this.rules.size(); }
  /** Total best practices learned so far. */
  practiceCount(): number { return this.practices.size(); }
  /** Total improvements identified so far. */
  improvementCount(): number { return this.improvements.length; }
}

export type {
  CommandLog,
  CommandRecord,
  MistakeRecord,
  BestPractice,
  LearnedRule,
  SelfImprovingConfig,
  RoundResult,
  InefficiencyFinding,
  Improvement,
  VerificationOutcome,
  CleanOperation,
  LLMResponseClassification,
};
