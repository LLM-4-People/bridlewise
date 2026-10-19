/**
 * Shared exposure registrations — `hallucination` module.
 *
 * Owns a small per-process state object that mirrors what the real
 * hallucination trap would expose: traps fired, hallucinations caught
 * or missed, and corrections issued.
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

/** Per-process hallucination state. */
export const hallucinationState = {
  trapCount: 0,
  catchCount: 0,
  missCount: 0,
  correctionCount: 0,
  falseAlarmCount: 0,
  resetCount: 0,
  clearCount: 0,
  // The detection knobs are a LIVE PROJECTION of the `hallucination` config
  // section: seeded from `bridlewise.config.json` and written back through
  // the config gate on every `set`.
  layers: new Set<string>(
    String(seedFromConfig("hallucination.layers", "factual,logical,self-contradiction,temporal"))
      .split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  ),
  threshold: seedFromConfig("hallucination.threshold", 0.5) as number,
  groundingThreshold: seedFromConfig("hallucination.groundingThreshold", 0.7) as number,
  autoCorrect: seedFromConfig("hallucination.autoCorrect", true) as boolean,
  escalateOnMiss: seedFromConfig("hallucination.escalateOnMiss", true) as boolean,
  layerMode: seedFromConfig("hallucination.layerMode", "all") as "all" | "factual" | "logical",
  evidenceTopK: seedFromConfig("hallucination.evidenceTopK", 5) as number,
  correctivePrompt: seedFromConfig("hallucination.correctivePrompt", true) as boolean,
};

/**
 * THE OWNER'S WRITE PATH for the catch counter — the ONLY place outside the
 * self-test actions (`fireTrap`) that may move `catchCount`.
 *
 * The pre-dispatch tool-call gate (the real hallucination producer) blocks a
 * hallucinated/looping/schema-mismatched call BEFORE it executes. Each block
 * IS a caught hallucination: the model invented a tool or an argument shape
 * that does not exist, and the gate stopped it from reaching the user. The
 * gate does not write this counter directly — it calls this owner, so the
 * signal's value and its only real source stay in one module. A catch that
 * never increments is the wired-but-inert class: the Instruments room showed
 * a permanent 0 while the gate was demonstrably blocking calls.
 */
export function recordHallucinationGateBlock(): void {
  hallucinationState.catchCount += 1;
}

/** State-field → config-path map (single source for the import-time seeds and the registration-time re-sync). */
const HALLUCINATION_CONFIG_BINDINGS = {
  layers: "hallucination.layers",
  threshold: "hallucination.threshold",
  groundingThreshold: "hallucination.groundingThreshold",
  autoCorrect: "hallucination.autoCorrect",
  escalateOnMiss: "hallucination.escalateOnMiss",
  layerMode: "hallucination.layerMode",
  evidenceTopK: "hallucination.evidenceTopK",
  correctivePrompt: "hallucination.correctivePrompt",
} as const;

let hallucinationRegistered = false;
export function registerHallucinationExposure(): void {
  if (hallucinationRegistered) return;
  hallucinationRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(hallucinationState, HALLUCINATION_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "hallucination",
    title: "Made-up-answer detection",
    purpose:
      "How hard the system looks for statements it cannot back up, and whether it corrects them, flags them for you, or lets them stand.",
  });

  // --- Signals (10) ---
  registerSignal({
    id: "hallucination.trapCount",
    module: "hallucination",
    name: "Trap Count",
    description: "Number of hallucination traps currently installed.",
    type: "gauge",
    unit: "count",
    value: () => hallucinationState.trapCount,
  });
  registerSignal({
    id: "hallucination.catchCount",
    module: "hallucination",
    name: "Catch Count",
    description: "Number of hallucinations caught before they reached the user.",
    type: "counter",
    unit: "count",
    value: () => hallucinationState.catchCount,
  });
  registerSignal({
    id: "hallucination.missCount",
    module: "hallucination",
    name: "Miss Count",
    description: "Number of hallucinations that escaped the traps.",
    type: "counter",
    unit: "count",
    // An escaped hallucination is the exact failure this module exists to
    // prevent — any count above zero is abnormal by its own semantics.
    abnormal: { warnAbove: 0 },
    value: () => hallucinationState.missCount,
  });
  registerSignal({
    id: "hallucination.correctionCount",
    module: "hallucination",
    name: "Correction Count",
    description: "Number of hallucinations corrected in-place.",
    type: "counter",
    unit: "count",
    value: () => hallucinationState.correctionCount,
  });
  registerSignal({
    id: "hallucination.catchRate",
    module: "hallucination",
    name: "Catch Rate",
    description: "Fraction of hallucinations caught (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () => {
      const total = hallucinationState.catchCount + hallucinationState.missCount;
      return total === 0 ? 0 : hallucinationState.catchCount / total;
    },
  });
  registerSignal({
    id: "hallucination.falseAlarmCount",
    module: "hallucination",
    name: "False Alarm Count",
    description: "Number of trap firings that were false alarms.",
    type: "counter",
    unit: "count",
    value: () => hallucinationState.falseAlarmCount,
  });
  registerSignal({
    id: "hallucination.resetCount",
    module: "hallucination",
    name: "Reset Count",
    description: "Number of times the hallucination traps have been reset.",
    type: "counter",
    unit: "count",
    value: () => hallucinationState.resetCount,
  });
  registerSignal({
    id: "hallucination.activeLayerCount",
    module: "hallucination",
    name: "Active Layer Count",
    description: "Number of hallucination layers currently active.",
    type: "gauge",
    unit: "count",
    value: () => hallucinationState.layers.size,
  });
  registerSignal({
    id: "hallucination.autoCorrect",
    module: "hallucination",
    name: "Auto-Correct",
    description: "Whether automatic correction is enabled.",
    type: "boolean",
    value: () => hallucinationState.autoCorrect,
  });
  registerSignal({
    id: "hallucination.escalateOnMiss",
    module: "hallucination",
    name: "Escalate On Miss",
    description: "Whether misses are escalated to the operator.",
    type: "boolean",
    value: () => hallucinationState.escalateOnMiss,
  });

  // --- Actions (5) ---
  registerAction({
    id: "hallucination.reset",
    module: "hallucination",
    name: "Reset",
    description: "Reset all hallucination counters.",
    execute: async () => {
      hallucinationState.trapCount = 0;
      hallucinationState.catchCount = 0;
      hallucinationState.missCount = 0;
      hallucinationState.correctionCount = 0;
      hallucinationState.falseAlarmCount = 0;
      hallucinationState.resetCount += 1;
      return { reset: true, resetCount: hallucinationState.resetCount };
    },
  });
  registerAction({
    id: "hallucination.clear",
    module: "hallucination",
    name: "Clear",
    description: "Clear the hallucination trap state (preserves configuration).",
    execute: async () => {
      hallucinationState.clearCount += 1;
      return { cleared: true, clearCount: hallucinationState.clearCount };
    },
  });
  registerAction({
    id: "hallucination.fireTrap",
    module: "hallucination",
    name: "Fire Trap",
    description: "Fire one hallucination trap (for testing).",
    args: {
      caught: { type: "boolean", required: false, description: "Caught or missed (overrides score/evidence judgement)" },
      corrected: { type: "boolean", required: false, description: "Corrected in-place (overrides autoCorrect)" },
      falseAlarm: { type: "boolean", required: false, description: "False alarm" },
      layer: { type: "string", required: false, description: "Layer the trap belongs to (must be active to fire)" },
      score: { type: "number", required: false, description: "Suspicion score (0..1), judged against `hallucination.threshold`" },
      evidenceScores: { type: "string", required: false, description: "Comma-separated grounding evidence scores (0..1)" },
    },
    execute: async (args) => {
      // Layer admission: a trap fires only if its layer is active AND the
      // layer mode admits it (`all` admits every active layer).
      const layer = typeof args?.layer === "string" ? args.layer : undefined;
      if (layer !== undefined) {
        const admitted =
          hallucinationState.layers.has(layer) &&
          (hallucinationState.layerMode === "all" || hallucinationState.layerMode === layer);
        if (!admitted) {
          return { fired: false, layer, layerMode: hallucinationState.layerMode };
        }
      }
      // Grounding judgement: the mean of the top `evidenceTopK` evidence
      // scores must clear `groundingThreshold` for the claim to count as
      // grounded.
      let grounded: boolean | undefined;
      let evidenceConsidered: number | undefined;
      if (typeof args?.evidenceScores === "string") {
        const considered = args.evidenceScores
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
          .toSorted((a, b) => b - a)
          .slice(0, hallucinationState.evidenceTopK);
        evidenceConsidered = considered.length;
        const mean = considered.length === 0
          ? 0
          : considered.reduce((sum, n) => sum + n, 0) / considered.length;
        grounded = mean >= hallucinationState.groundingThreshold;
      }
      let caught: boolean;
      if (args?.caught !== undefined) caught = Boolean(args.caught);
      else if (grounded !== undefined) caught = !grounded;
      else if (typeof args?.score === "number") caught = args.score >= hallucinationState.threshold;
      else caught = true;
      // `autoCorrect`: a caught hallucination is corrected in-place unless
      // the caller states otherwise; `correctivePrompt` re-prompts the model
      // on every correction.
      const corrected = args?.corrected !== undefined
        ? Boolean(args.corrected)
        : (caught && hallucinationState.autoCorrect);
      const falseAlarm = args?.falseAlarm === undefined ? false : Boolean(args?.falseAlarm);
      if (caught) hallucinationState.catchCount += 1;
      else hallucinationState.missCount += 1;
      if (corrected) hallucinationState.correctionCount += 1;
      if (falseAlarm) hallucinationState.falseAlarmCount += 1;
      const reprompted = corrected && hallucinationState.correctivePrompt;
      const escalated = !caught && hallucinationState.escalateOnMiss;
      const result: Record<string, unknown> = {
        fired: true,
        caught,
        corrected,
        falseAlarm,
        reprompted,
        escalated,
      };
      if (grounded !== undefined) {
        result.grounded = grounded;
        result.evidenceConsidered = evidenceConsidered;
      }
      return result;
    },
  });
  registerAction({
    id: "hallucination.installTrap",
    module: "hallucination",
    name: "Install Trap",
    description: "Install a new hallucination trap.",
    args: {
      count: { type: "number", required: false, description: "Number of traps to install" },
    },
    execute: async (args) => {
      const count = Math.max(1, Number(args?.count ?? 1));
      hallucinationState.trapCount += count;
      return { trapCount: hallucinationState.trapCount };
    },
  });
  registerAction({
    id: "hallucination.toggleLayer",
    module: "hallucination",
    name: "Toggle Layer",
    description: "Enable or disable a hallucination layer by name.",
    args: {
      layer: { type: "string", required: true, description: "Layer name" },
      enabled: { type: "boolean", required: true, description: "Enabled or disabled" },
    },
    execute: async (args) => {
      const layer = String(args?.layer ?? "");
      const enabled = Boolean(args?.enabled);
      if (enabled) hallucinationState.layers.add(layer);
      else hallucinationState.layers.delete(layer);
      return { layers: Array.from(hallucinationState.layers) };
    },
  });

  // --- Customizations (8) ---
  // All eight are read live by `fireTrap` (verified by the
  // customization-liveness suite), so changes are immediate.
  registerCustomization({
    id: "hallucination.threshold",
    module: "hallucination",
    name: "Detection cutoff score",
    description:
      "A statement whose suspicion score reaches this is treated as possibly made-up, which triggers the correction and escalation handling.",
    type: "number",
    default: 0.5,
    min: 0,
    max: 1,
    unit: "score",
    current: () => hallucinationState.threshold,
    set: configBoundSet("hallucination.threshold", (v) => { hallucinationState.threshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "hallucination.threshold",
  });
  registerCustomization({
    id: "hallucination.groundingThreshold",
    module: "hallucination",
    name: "Evidence score to count as supported",
    description:
      "A claim whose evidence scores average at least this counts as supported; below it, the claim is treated as made-up.",
    type: "number",
    default: 0.7,
    min: 0,
    max: 1,
    unit: "score",
    current: () => hallucinationState.groundingThreshold,
    set: configBoundSet("hallucination.groundingThreshold", (v) => { hallucinationState.groundingThreshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "hallucination.groundingThreshold",
  });
  registerCustomization({
    id: "hallucination.autoCorrect",
    module: "hallucination",
    name: "Fix flagged statements automatically",
    description:
      "On: when a possibly made-up statement is caught, it is corrected in place without being asked.",
    type: "boolean",
    default: true,
    current: () => hallucinationState.autoCorrect,
    set: configBoundSet("hallucination.autoCorrect", (v) => { hallucinationState.autoCorrect = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "hallucination.autoCorrect",
    configPath: "hallucination.autoCorrect",
  });
  registerCustomization({
    id: "hallucination.escalateOnMiss",
    module: "hallucination",
    name: "Flag unverifiable statements to you",
    description:
      "On: when a statement escapes the checks unverified, it is brought to your attention instead of passing silently.",
    type: "boolean",
    default: true,
    current: () => hallucinationState.escalateOnMiss,
    set: configBoundSet("hallucination.escalateOnMiss", (v) => { hallucinationState.escalateOnMiss = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "hallucination.escalateOnMiss",
    configPath: "hallucination.escalateOnMiss",
  });
  registerCustomization({
    id: "hallucination.layers",
    module: "hallucination",
    name: "Active detection layers",
    description:
      "A comma-separated list of the kinds of problem checked for: factual errors, logic errors, self-contradiction, and time/date errors.",
    type: "string",
    default: "factual,logical,self-contradiction,temporal",
    current: () => Array.from(hallucinationState.layers).join(","),
    set: configBoundSet("hallucination.layers", (v) => {
      hallucinationState.layers = new Set(
        String(v).split(",").map((s) => s.trim()).filter((s) => s.length > 0),
      );
    }),
    contract: { effect: "immediate" },
    measuredBy: "hallucination.activeLayerCount",
    configPath: "hallucination.layers",
  });
  registerCustomization({
    id: "hallucination.layerMode",
    module: "hallucination",
    name: "Which detection layers run",
    description:
      "'all' runs every active detection layer; 'factual' or 'logical' runs just that one layer.",
    type: "enum",
    default: "all",
    enum: ["all", "factual", "logical"],
    current: () => hallucinationState.layerMode,
    set: configBoundSet("hallucination.layerMode", (v) => { hallucinationState.layerMode = String(v) as typeof hallucinationState.layerMode; }),
    contract: { effect: "immediate" },
    configPath: "hallucination.layerMode",
  });
  registerCustomization({
    id: "hallucination.evidenceTopK",
    module: "hallucination",
    name: "Evidence snippets per claim",
    description:
      "How many of the best pieces of supporting evidence are weighed when checking each claim. Higher = more thorough, slower.",
    type: "number",
    default: 5,
    min: 1,
    max: 50,
    unit: "snippets",
    current: () => hallucinationState.evidenceTopK,
    set: configBoundSet("hallucination.evidenceTopK", (v) => { hallucinationState.evidenceTopK = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "hallucination.evidenceTopK",
  });
  registerCustomization({
    id: "hallucination.correctivePrompt",
    module: "hallucination",
    name: "Ask the model to retry on errors",
    description:
      "On: when a correction is made, the model is asked again with the problem pointed out.",
    type: "boolean",
    default: true,
    current: () => hallucinationState.correctivePrompt,
    set: configBoundSet("hallucination.correctivePrompt", (v) => { hallucinationState.correctivePrompt = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "hallucination.correctivePrompt",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetHallucinationRegistration(): void {
  hallucinationRegistered = false;
}
