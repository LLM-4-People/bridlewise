/**
 * Shared exposure registrations — `learning` module.
 *
 * Owns a small per-process state object that mirrors what the real
 * learning subsystem would expose: rules learned from errors, error
 * reduction over time, and generalization to novel inputs.
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  configBoundSet,
  seedFromConfig,
  syncStateFromConfig,
} from "../index.ts";

/** Per-process learning state. */
export const learningState = {
  ruleCount: 0,
  rulesApplied: 0,
  rulesRejected: 0,
  errorReduction: 0,
  generalizationRate: 0,
  relearnCount: 0,
  clearRulesCount: 0,
  totalConfidence: 0,
  // The learning knobs are a LIVE PROJECTION of the `learning` config section:
  // seeded from `bridlewise.config.json` and written back through the config
  // gate on every `set`.
  maxRules: seedFromConfig("learning.maxRules", 100) as number,
  minConfidence: seedFromConfig("learning.minConfidence", 0.7) as number,
  plateauThreshold: seedFromConfig("learning.plateauThreshold", 0.05) as number,
  relearnInterval: seedFromConfig("learning.relearnInterval", 1000) as number,
  autoLearnEnabled: seedFromConfig("learning.autoLearnEnabled", true) as boolean,
  recallThreshold: seedFromConfig("learning.recallThreshold", 0.6) as number,
};

/** State-field → config-path map for the learning knobs (single source for
 * the import-time seeds and the registration-time re-sync). */
const LEARNING_CONFIG_BINDINGS = {
  maxRules: "learning.maxRules",
  minConfidence: "learning.minConfidence",
  plateauThreshold: "learning.plateauThreshold",
  relearnInterval: "learning.relearnInterval",
  autoLearnEnabled: "learning.autoLearnEnabled",
  recallThreshold: "learning.recallThreshold",
} as const;

let learningRegistered = false;
export function registerLearningExposure(): void {
  if (learningRegistered) return;
  learningRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(learningState, LEARNING_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "learning",
    title: "Rules learned from mistakes",
    purpose:
      "Whether the system turns its own past errors into rules it follows later, how sure it must be to keep one, and how many it holds.",
  });

  // --- Signals (9) ---
  registerSignal({
    id: "learning.ruleCount",
    module: "learning",
    name: "Rule Count",
    description: "Number of learned rules currently retained.",
    type: "gauge",
    unit: "count",
    value: () => learningState.ruleCount,
  });
  registerSignal({
    id: "learning.errorReductionRate",
    module: "learning",
    name: "Error Reduction Rate",
    description: "Estimated fraction by which learned rules reduce errors (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () => learningState.errorReduction,
  });
  registerSignal({
    id: "learning.generalizationRate",
    module: "learning",
    name: "Generalization Rate",
    description: "Fraction of rules that generalize to novel inputs (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () => learningState.generalizationRate,
  });
  registerSignal({
    id: "learning.rulesApplied",
    module: "learning",
    name: "Rules Applied",
    description: "Total number of times a learned rule was applied.",
    type: "counter",
    unit: "count",
    value: () => learningState.rulesApplied,
  });
  registerSignal({
    id: "learning.rulesRejected",
    module: "learning",
    name: "Rules Rejected",
    description: "Total number of times a learned rule was rejected by review.",
    type: "counter",
    unit: "count",
    value: () => learningState.rulesRejected,
  });
  registerSignal({
    id: "learning.avgConfidence",
    module: "learning",
    name: "Average Confidence",
    description: "Mean confidence of retained rules (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      learningState.ruleCount === 0
        ? 0
        : learningState.totalConfidence / learningState.ruleCount,
  });
  registerSignal({
    id: "learning.relearnCount",
    module: "learning",
    name: "Relearn Count",
    description: "Number of times the rule set has been relearned from scratch.",
    type: "counter",
    unit: "count",
    value: () => learningState.relearnCount,
  });
  registerSignal({
    id: "learning.clearRulesCount",
    module: "learning",
    name: "Clear Rules Count",
    description: "Number of times all rules have been cleared.",
    type: "counter",
    unit: "count",
    value: () => learningState.clearRulesCount,
  });
  registerSignal({
    id: "learning.autoLearnEnabled",
    module: "learning",
    name: "Auto-Learn Enabled",
    description: "Whether automatic rule learning is enabled.",
    type: "boolean",
    value: () => learningState.autoLearnEnabled,
  });
  // --- Actions (5) ---
  registerAction({
    id: "learning.clearRules",
    module: "learning",
    name: "Clear Rules",
    description: "Drop every learned rule.",
    execute: async () => {
      learningState.ruleCount = 0;
      learningState.totalConfidence = 0;
      learningState.rulesApplied = 0;
      learningState.rulesRejected = 0;
      learningState.clearRulesCount += 1;
      return { cleared: true, clearRulesCount: learningState.clearRulesCount };
    },
  });
  registerAction({
    id: "learning.relearn",
    module: "learning",
    name: "Relearn",
    description: "Relearn every rule from scratch.",
    execute: async () => {
      learningState.relearnCount += 1;
      return { relearned: true, relearnCount: learningState.relearnCount };
    },
  });
  registerAction({
    id: "learning.addRule",
    module: "learning",
    name: "Add Rule",
    description: "Add a synthetic rule (for testing).",
    args: {
      confidence: { type: "number", required: false, description: "Rule confidence (0..1)" },
    },
    execute: async (args) => {
      const confidence = Math.max(
        0,
        Math.min(1, Number(args?.confidence ?? 0.8)),
      );
      // `minConfidence` gate: a rule below the retention floor is not kept.
      if (confidence < learningState.minConfidence) {
        learningState.rulesRejected += 1;
        return { added: false, reason: "below minConfidence", confidence, ruleCount: learningState.ruleCount };
      }
      // `maxRules` gate: the retained set is capped.
      if (learningState.ruleCount >= learningState.maxRules) {
        return { added: false, reason: "maxRules reached", confidence, ruleCount: learningState.ruleCount };
      }
      learningState.ruleCount += 1;
      learningState.totalConfidence += confidence;
      return { added: true, ruleCount: learningState.ruleCount, confidence };
    },
  });
  registerAction({
    id: "learning.applyRule",
    module: "learning",
    name: "Apply Rule",
    description: "Mark one rule application (for testing).",
    args: {
      accepted: { type: "boolean", required: false, description: "Accepted or rejected" },
      score: { type: "number", required: false, description: "Recall score (0..1), judged against `learning.recallThreshold`" },
    },
    execute: async (args) => {
      // `recallThreshold` gate: a rule scoring below the threshold is not
      // recalled at all — nothing is applied or rejected.
      if (typeof args?.score === "number" && args.score < learningState.recallThreshold) {
        return { recalled: false, score: args.score, recallThreshold: learningState.recallThreshold };
      }
      const accepted = args?.accepted === undefined ? true : Boolean(args?.accepted);
      if (accepted) {
        learningState.rulesApplied += 1;
        return { recalled: true, accepted, rulesApplied: learningState.rulesApplied };
      }
      learningState.rulesRejected += 1;
      // A rejected application is the module's error signal. `autoLearnEnabled`
      // learns a corrective rule from it (retained at the confidence floor),
      // and `relearnInterval` triggers an automatic relearn pass every N such
      // errors.
      let autoLearned = false;
      if (learningState.autoLearnEnabled && learningState.ruleCount < learningState.maxRules) {
        learningState.ruleCount += 1;
        learningState.totalConfidence += learningState.minConfidence;
        autoLearned = true;
      }
      let relearned = false;
      if (learningState.rulesRejected % learningState.relearnInterval === 0) {
        learningState.relearnCount += 1;
        relearned = true;
      }
      return {
        recalled: true,
        accepted,
        rulesApplied: learningState.rulesApplied,
        rulesRejected: learningState.rulesRejected,
        autoLearned,
        relearned,
      };
    },
  });
  registerAction({
    id: "learning.setReduction",
    module: "learning",
    name: "Set Reduction",
    description: "Set the current error-reduction estimate (for testing).",
    args: {
      rate: { type: "number", required: true, description: "Reduction rate (0..1)" },
    },
    execute: async (args) => {
      const rate = Math.max(0, Math.min(1, Number(args?.rate ?? 0)));
      const previous = learningState.errorReduction;
      learningState.errorReduction = rate;
      // `plateauThreshold`: an improvement delta below the threshold means
      // learning has plateaued.
      const plateaued = Math.abs(rate - previous) < learningState.plateauThreshold;
      return { rate, previous, plateaued };
    },
  });

  // --- Customizations (6) ---
  // All six are read live by the rule actions (`addRule`, `applyRule`,
  // `setReduction` — verified by the customization-liveness suite), so
  // changes are immediate.
  registerCustomization({
    id: "learning.maxRules",
    module: "learning",
    name: "Most rules kept",
    description:
      "At most this many learned rules are kept; once the cap is reached, new rules are refused.",
    type: "number",
    default: 100,
    min: 0,
    max: 100000,
    unit: "rules",
    current: () => learningState.maxRules,
    set: configBoundSet("learning.maxRules", (v) => { learningState.maxRules = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "learning.maxRules",
  });
  registerCustomization({
    id: "learning.minConfidence",
    module: "learning",
    name: "Confidence needed to keep a rule",
    description:
      "A learned rule whose confidence score falls below this is discarded instead of kept.",
    type: "number",
    default: 0.7,
    min: 0,
    max: 1,
    unit: "score",
    current: () => learningState.minConfidence,
    set: configBoundSet("learning.minConfidence", (v) => { learningState.minConfidence = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "learning.minConfidence",
  });
  registerCustomization({
    id: "learning.plateauThreshold",
    module: "learning",
    name: "When learning counts as stalled",
    description:
      "If improvement between learning passes is smaller than this fraction, learning is treated as having levelled off.",
    type: "number",
    default: 0.05,
    min: 0,
    max: 1,
    unit: "fraction",
    current: () => learningState.plateauThreshold,
    set: configBoundSet("learning.plateauThreshold", (v) => { learningState.plateauThreshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "learning.plateauThreshold",
  });
  registerCustomization({
    id: "learning.relearnInterval",
    module: "learning",
    name: "Errors between re-learning passes",
    description:
      "After this many observed errors, the rule set is automatically re-learned from scratch.",
    type: "number",
    default: 1000,
    min: 1,
    max: 1000000,
    unit: "errors",
    current: () => learningState.relearnInterval,
    set: configBoundSet("learning.relearnInterval", (v) => { learningState.relearnInterval = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "learning.relearnInterval",
  });
  registerCustomization({
    id: "learning.autoLearnEnabled",
    module: "learning",
    name: "Learn from mistakes automatically",
    description:
      "On: a corrective rule is created from each observed error without being asked.",
    type: "boolean",
    default: true,
    current: () => learningState.autoLearnEnabled,
    set: configBoundSet("learning.autoLearnEnabled", (v) => { learningState.autoLearnEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "learning.autoLearnEnabled",
    configPath: "learning.autoLearnEnabled",
  });
  // `learning.teacherStudentEnabled` and `learning.ruleFormat` were REMOVED
  // (not wired to a dead store): this stub has no teacher-student
  // distillation machinery and stores no rule content (only counts), so a
  // distillation toggle and a storage format could never influence
  // behaviour. Re-add them when the real learning subsystem backs this
  // registration.
  registerCustomization({
    id: "learning.recallThreshold",
    module: "learning",
    name: "Score needed to apply a rule",
    description:
      "A learned rule is only applied when its match score for the current situation is at least this.",
    type: "number",
    default: 0.6,
    min: 0,
    max: 1,
    unit: "score",
    current: () => learningState.recallThreshold,
    set: configBoundSet("learning.recallThreshold", (v) => { learningState.recallThreshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "learning.recallThreshold",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetLearningRegistration(): void {
  learningRegistered = false;
}
