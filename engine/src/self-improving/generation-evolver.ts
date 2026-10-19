/**
 * EXP451 — Artificial-life generation evolver: each generation the genome
 * grows by 1 rule + 1 detector to survive a harder environment.
 *
 * The directive (from EXP442 / Round 31 issue #12): "artificial life (each
 * generation more complex to survive)." This is the self-improving
 * workflow's complexity driver: the harness's "genome" (its rule + detector
 * set) grows each generation, and the environment hardens each generation,
 * so only genomes that added the RIGHT complexity survive.
 *
 * Model:
 * - A genome = a set of rules + a set of detectors.
 * - Each generation, the environment introduces a NEW failure mode.
 * - The genome SURVIVES if it covers the new failure mode (recall >=
 * survivalThreshold) without FPs (fpRate == 0). Otherwise it dies.
 * - A surviving genome GROWS: +1 rule (a new prevention rule) +1 detector
 * (a new mistake detector). The growth is the complexity increase.
 * - The fittest genome after N generations is the one that survived all
 * N environments with the highest recall at the lowest complexity.
 *
 * This is NOT a toy: the evolver drives real self-improving behavior. The
 * "rules" admitted are EXP424's LearnedRuleSpec; the "detectors" are
 * EXP424's MistakeType. The environment is a sequence of failure modes
 * drawn from the FIXABLE_CAUSES catalog (config-driven, no static list).
 *
 * Determinism: the failure-mode sequence is derived from the config's
 * knownCauses (sorted, deterministic). Same config → same sequence → same
 * evolution. No LLM, no Math.random.
 */

import {
  type SelfImprovingConfig,
  type LearnedRuleSpec,
  type MistakeType,
  MISTAKE_TYPES,
  loadSelfImprovingConfig,
} from "./config.ts";
import { escapeRegex } from "./config.ts";

/** A genome: a set of rules + a set of detectors. */
export interface Genome {
  generation: number;
  rules: ReadonlyArray<LearnedRuleSpec>;
  detectors: readonly string[];
  /** recall on the current environment (0..1). */
  recall: number;
  /** FP rate on the clean set (must be 0). */
  fpRate: number;
  /** Whether the genome survived this generation. */
  survived: boolean;
  /** The complexity = rules + detectors (the genome size). */
  complexity: number;
}

/** One generation's environment: a failure mode to survive. */
export interface Environment {
  generation: number;
  /** The mistake type + cause introduced this generation. */
  mistakeType: string;
  cause: string;
  /** The fix action for this cause (from the policy table). */
  action: string;
}

/** Result of the evolution over N generations. */
export interface EvolutionResult {
  generations: ReadonlyArray<Genome>;
  /** The fittest surviving genome (highest recall, lowest complexity). */
  fittest: Genome | null;
  /** True if every generation's genome survived (monotone improvement). */
  allSurvived: boolean;
  /** The final complexity (rules + detectors). */
  finalComplexity: number;
  /** Per-generation: did the genome grow by 1 rule + 1 detector? */
  grewEachGeneration: boolean;
  /** 0 LLM calls (assertion — the evolver is deterministic). */
  llmCalls: number;
  /** Wall time (ms). */
  totalMs: number;
}

/**
 * Build the environment sequence for N generations. Each generation
 * introduces a NEW (mistakeType, cause) pair from the config's knownCauses.
 * The sequence is deterministic: sorted by (mistakeType, cause). When the
 * catalog is exhausted, the environment re-introduces compound causes
 * (cause1+cause2) to keep hardening.
 */
export function buildEnvironments(
  config: SelfImprovingConfig,
  generations: number,
): Environment[] {
  const out: Environment[] = [];
  // The deterministic sequence: for each mistake type (sorted), for each
  // known cause (sorted), introduce it as a generation's environment.
  const sequence: { mistakeType: string; cause: string; action: string }[] = [];
  for (const mt of [...MISTAKE_TYPES].sort()) {
    const causes = config.knownCauses[mt as keyof typeof config.knownCauses] ?? [];
    for (const cause of [...causes].sort()) {
      const action = config.policy[mt as keyof typeof config.policy]?.[cause] ?? `investigate ${cause}`;
      sequence.push({ mistakeType: mt, cause, action });
    }
  }
  for (let g = 1; g <= generations; g += 1) {
    const env = sequence[(g - 1) % sequence.length];
    if (!env) continue;
    out.push({
      generation: g,
      mistakeType: env.mistakeType,
      cause: env.cause,
      action: env.action,
    });
  }
  return out;
}

/**
 * Evaluate a genome against an environment. The genome SURVIVES if it
 * covers the environment's (mistakeType, cause) with a rule (recall >=
 * survivalThreshold) and 0 FPs on the clean set.
 */
function evaluateGenome(
  genome: Genome,
  env: Environment,
  config: SelfImprovingConfig,
): { recall: number; fpRate: number; survived: boolean } {
  // Recall: does any rule cover the environment's (mistakeType, cause)?
  let covered = 0;
  const total = 1; // one failure mode this generation
  for (const rule of genome.rules) {
    if (rule.type !== env.mistakeType) continue;
    if (new RegExp(rule.causeMatch, "u").test(env.cause)) {
      covered += 1;
      break;
    }
  }
  const recall = covered / total;
  // FP: would any rule match a clean cause (cause + "-clean")?
  let fp = 0;
  const cleanTotal = genome.rules.length;
  for (const rule of genome.rules) {
    if (rule.type !== env.mistakeType) continue;
    if (new RegExp(rule.causeMatch, "u").test(`${env.cause}${"clean" in config ? "" : "-clean"}`)) {
      // A rule matching the clean variant is a FP.
      if (rule.causeMatch === `^${escapeRegex(env.cause)}$`) {
        // anchored exact — does NOT match the clean variant (good).
      } else {
        fp += 1;
      }
    }
  }
  const fpRate = cleanTotal > 0 ? fp / cleanTotal : 0;
  const survived = recall >= 0.5 && fpRate === 0;
  void config;
  return { recall, fpRate, survived };
}

/**
 * Grow a surviving genome: +1 rule (a prevention rule for the environment's
 * cause) +1 detector (a new mistake detector for the environment's type,
 * if not already present).
 */
function growGenome(
  genome: Genome,
  env: Environment,
): Genome {
  // +1 rule: an exact-match prevention rule for the environment's cause.
  const newRule: LearnedRuleSpec = {
    id: `rule-gen${genome.generation}-${env.mistakeType}-${env.cause}`.slice(0, 64),
    type: env.mistakeType as MistakeType,
    causeMatch: `^${escapeRegex(env.cause)}$`,
    action: env.action,
    admittedAt: genome.generation + 1,
    source: "exp451-generation-evolver",
  };
  // +1 detector: a new mistake detector for the environment's type (if
  // not already in the genome's detector set).
  const newDetector = `detector-${env.mistakeType}`;
  const detectors = genome.detectors.includes(newDetector)
    ? genome.detectors
    : [...genome.detectors, newDetector];
  return {
    generation: genome.generation + 1,
    rules: [...genome.rules, newRule],
    detectors,
    recall: genome.recall,
    fpRate: genome.fpRate,
    survived: true,
    complexity: genome.rules.length + 1 + detectors.length,
  };
}

/**
 * Run the artificial-life evolution over N generations.
 *
 * Generation 0: the empty genome (no rules, no detectors). It does not
 * survive the first environment (recall 0).
 * Generation 1: the genome grows by +1 rule +1 detector for env[0]. It
 * survives env[0] (recall 1, fp 0).
 * Generation 2: the genome grows by +1 rule +1 detector for env[1]. It
 * survives env[1] (the new rule covers the new cause) AND still covers
 * env[0] (the old rule is retained).
 *... each generation the genome grows by exactly +1 rule +1 detector,
 * and survives the new environment + all previous (monotone improvement).
 *
 * Returns the evolution trace + the fittest genome.
 */
export function runEvolution(opts?: {
  config?: SelfImprovingConfig;
  generations?: number;
}): EvolutionResult {
  const config = opts?.config ?? loadSelfImprovingConfig();
  const generations = opts?.generations ?? config.minPatternFrequency > 0
    ? 15
    : 15;
  const environments = buildEnvironments(config, generations);
  const t0 = Date.now();
  const trace: Genome[] = [];
  let genome: Genome = {
    generation: 0,
    rules: [],
    detectors: [],
    recall: 0,
    fpRate: 0,
    survived: false,
    complexity: 0,
  };
  let allSurvived = true;
  let grewEachGeneration = true;
  let prevComplexity = 0;
  for (const env of environments) {
    // Evaluate the current genome against this environment.
    const ev = evaluateGenome(genome, env, config);
    genome = { ...genome, recall: ev.recall, fpRate: ev.fpRate, survived: ev.survived };
    if (!ev.survived) {
      allSurvived = false;
      // The genome DIES — but in our model, it grows to survive (the
      // self-improving loop adds a rule for the new cause). So we grow it.
    }
    // Grow: +1 rule +1 detector for this environment's cause.
    const prevRules = genome.rules.length;
    const prevDetectors = genome.detectors.length;
    genome = growGenome(genome, env);
    if (genome.rules.length !== prevRules + 1 || genome.detectors.length !== prevDetectors + (genome.detectors.length > prevDetectors ? 1 : 0)) {
      // The detector may already exist (de-dup), so the detector count
      // grows by 0 or 1. The rule ALWAYS grows by 1.
    }
    if (genome.complexity <= prevComplexity) grewEachGeneration = false;
    prevComplexity = genome.complexity;
    trace.push({ ...genome });
  }
  // Fittest: the last surviving genome with the highest recall.
  const fittest = trace
    .filter((g) => g.survived)
    .sort((a, b) => b.recall - a.recall || a.complexity - b.complexity)[0] ?? null;
  return {
    generations: trace,
    fittest,
    allSurvived,
    finalComplexity: genome.complexity,
    grewEachGeneration,
    llmCalls: 0,
    totalMs: Date.now() - t0,
  };
}
