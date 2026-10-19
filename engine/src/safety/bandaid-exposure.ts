/**
 * Bandaid-module shared exposure — signals, actions, customizations.
 *
 * Per the binding directive "exposed as many signals, actions, customization
 * as possible — use the shared exposure system (EXP425)", this module
 * registers the bandaid detector's observable signals (counts, learned
 * pragmas, overlaps), actions (re-learn, set consequential tools), and
 * customizations (min overlap, learned pragmas) on the shared exposure
 * registry so any consumer (the runtime, the LLM via a tool, the CLI, the
 * timeline) can read/adjust them through ONE canonical surface.
 *
 * Registration is idempotent: re-calling `registerBandaidExposure` clears the
 * bandaid module's prior rows and re-registers, so the live config is always
 * the source of truth.
 */
import {
  registerSignal,
  registerAction,
  registerCustomization,
  unregisterSignal,
  unregisterAction,
  unregisterCustomization,
  type CustomizationValue,
} from "../shared/exposure/index.ts";
import {
  type BandaidConfig,
  resolveBandaidConfig,
  type ConsequentialToolsMode,
} from "./bandaid-config.ts";
import { learnBandaidPatterns, type LearnedSource, type LearnedPatterns } from "./bandaid-pattern-learner.ts";
import { InputError } from "../kernel/errors.ts";

const MODULE_ID = "bandaid";

export type BandaidExposureState = Readonly<{
  readonly config: BandaidConfig;
  readonly lastLearned: LearnedPatterns | undefined;
  readonly detectedCount: number;
  readonly structuralFindings: number;
  readonly rootCauseFindings: number;
  readonly learnedPragmaCount: number;
  readonly learnedDeferredCount: number;
  /** Internal hook for `updateBandaidExposure` (counts are read-only getters). */
  readonly _setCounts: (detectedCount: number, structuralFindings: number, rootCauseFindings: number) => void;
}>;

/**
 * Register the bandaid module's signals/actions/customizations on the shared
 * exposure registry. Returns the live state so the caller (the runtime) can
 * update it as detection proceeds.
 */
export function registerBandaidExposure(initial: BandaidConfig): BandaidExposureState {
  // Clear prior registrations (idempotent re-register).
  unregisterSignal(`${MODULE_ID}.detectedCount`);
  unregisterSignal(`${MODULE_ID}.structuralFindings`);
  unregisterSignal(`${MODULE_ID}.rootCauseFindings`);
  unregisterSignal(`${MODULE_ID}.learnedPragmaCount`);
  unregisterSignal(`${MODULE_ID}.learnedDeferredCount`);
  unregisterAction(`${MODULE_ID}.relearn`);
  unregisterAction(`${MODULE_ID}.setConsequentialTools`);
  unregisterCustomization(`${MODULE_ID}.minRootCauseOverlap`);
  unregisterCustomization(`${MODULE_ID}.learnedSuppressionPragmas`);
  unregisterCustomization(`${MODULE_ID}.learnedDeferredMarkers`);
  unregisterCustomization(`${MODULE_ID}.consequentialToolsMode`);

  const state: {
    config: BandaidConfig;
    lastLearned: LearnedPatterns | undefined;
    detectedCount: number;
    structuralFindings: number;
    rootCauseFindings: number;
  } = {
    config: initial,
    lastLearned: undefined,
    detectedCount: 0,
    structuralFindings: 0,
    rootCauseFindings: 0,
  };

  registerSignal({
    id: `${MODULE_ID}.detectedCount`,
    module: MODULE_ID,
    name: "Detected Count",
    description: "Total bandaid findings raised by the detector.",
    type: "counter",
    unit: "count",
    value: () => state.detectedCount,
  });
  registerSignal({
    id: `${MODULE_ID}.structuralFindings`,
    module: MODULE_ID,
    name: "Structural Findings",
    description: "Bandaid findings from the AST structural detector (keyword-free).",
    type: "counter",
    unit: "count",
    value: () => state.structuralFindings,
  });
  registerSignal({
    id: `${MODULE_ID}.rootCauseFindings`,
    module: MODULE_ID,
    name: "Root-Cause-Not-Addressed Findings",
    description: "Bandaid findings from the root-cause containment comparison (keyword-free).",
    type: "counter",
    unit: "count",
    value: () => state.rootCauseFindings,
  });
  registerSignal({
    id: `${MODULE_ID}.learnedPragmaCount`,
    module: MODULE_ID,
    name: "Learned Suppression Pragmas",
    description: "Number of suppression-pragma regexes mined from the codebase (dynamic, no hardcoded list).",
    type: "gauge",
    unit: "count",
    value: () => state.config.learnedSuppressionPragmas.length,
  });
  registerSignal({
    id: `${MODULE_ID}.learnedDeferredCount`,
    module: MODULE_ID,
    name: "Learned Deferred Markers",
    description: "Number of deferred-fix marker regexes mined from the codebase (dynamic).",
    type: "gauge",
    unit: "count",
    value: () => state.config.learnedDeferredMarkers.length,
  });

  registerAction({
    id: `${MODULE_ID}.relearn`,
    module: MODULE_ID,
    name: "Re-learn Bandaid Patterns",
    description: "Re-mine suppression pragmas + deferred markers from the given sources and update the live config.",
    args: {
      sourcesJson: {
        type: "string",
        description: "JSON array of {path, content} sources to learn from.",
        required: true,
      },
    },
    execute: async (args) => {
      const raw = args?.sourcesJson;
      if (typeof raw !== "string" || raw.length === 0) {
        throw new InputError("bandaid.relearn: sourcesJson must be a non-empty JSON string");
      }
      const parsed = JSON.parse(raw) as readonly LearnedSource[];
      const learned = learnBandaidPatterns(parsed, state.config.learnOptions);
      state.config = resolveBandaidConfig({
        learnedSuppressionPragmas: [...learned.suppressionPragmas],
        learnedDeferredMarkers: [...learned.deferredMarkers],
      });
      state.lastLearned = learned;
      return learned;
    },
  });

  registerAction({
    id: `${MODULE_ID}.setConsequentialTools`,
    module: MODULE_ID,
    name: "Set Consequential Tools",
    description: "Override the consequential-tools mode/list for the workaround detector (dynamic, no hardcoded list).",
    args: {
      mode: { type: "string", description: '"all" or "list"', required: true },
      tools: { type: "string", description: "Comma-separated tool names (mode=list only).", required: false },
    },
    execute: async (args) => {
      const mode = args?.mode as ConsequentialToolsMode | undefined;
      if (mode !== "all" && mode !== "list") {
        throw new InputError('bandaid.setConsequentialTools: mode must be "all" or "list"');
      }
      const toolsStr = (args?.tools as string | undefined) ?? "";
      const tools = mode === "list" && toolsStr.length > 0 ? toolsStr.split(",").map((t) => t.trim()).filter((t) => t.length > 0) : [];
      state.config = resolveBandaidConfig({
        workaroundConsequentialToolsMode: mode,
        workaroundConsequentialTools: tools,
      });
      return { mode, tools };
    },
  });

  registerCustomization({
    id: `${MODULE_ID}.minRootCauseOverlap`,
    module: MODULE_ID,
    name: "Min Root-Cause Overlap",
    description: "Containment threshold below which an edit is flagged as root-cause-not-addressed.",
    type: "number",
    default: state.config.bandaidMinRootCauseOverlap,
    min: 0,
    max: 1,
    current: () => state.config.bandaidMinRootCauseOverlap,
    set: (value: CustomizationValue) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new InputError("bandaid.minRootCauseOverlap must be a number in [0, 1]");
      }
      state.config = resolveBandaidConfig({ bandaidMinRootCauseOverlap: value });
    },
  });
  registerCustomization({
    id: `${MODULE_ID}.learnedSuppressionPragmas`,
    module: MODULE_ID,
    name: "Learned Suppression Pragmas",
    description: "Regexes mined from the codebase for suppression-pragma comments (dynamic).",
    type: "string",
    default: state.config.learnedSuppressionPragmas.join("|"),
    current: () => state.config.learnedSuppressionPragmas.join("|"),
    set: (value: CustomizationValue) => {
      const v = typeof value === "string" && value.length > 0 ? value.split("|") : [];
      state.config = resolveBandaidConfig({ learnedSuppressionPragmas: v });
    },
  });
  registerCustomization({
    id: `${MODULE_ID}.learnedDeferredMarkers`,
    module: MODULE_ID,
    name: "Learned Deferred Markers",
    description: "Regexes mined from the codebase for deferred-fix comments (dynamic).",
    type: "string",
    default: state.config.learnedDeferredMarkers.join("|"),
    current: () => state.config.learnedDeferredMarkers.join("|"),
    set: (value: CustomizationValue) => {
      const v = typeof value === "string" && value.length > 0 ? value.split("|") : [];
      state.config = resolveBandaidConfig({ learnedDeferredMarkers: v });
    },
  });
  registerCustomization({
    id: `${MODULE_ID}.consequentialToolsMode`,
    module: MODULE_ID,
    name: "Consequential Tools Mode",
    description: 'How the workaround detector determines consequential tools: "all" (every tool) or "list".',
    type: "enum",
    default: state.config.workaroundConsequentialToolsMode,
    enum: ["all", "list"],
    current: () => state.config.workaroundConsequentialToolsMode,
    set: (value: CustomizationValue) => {
      if (value !== "all" && value !== "list") {
        throw new InputError('bandaid.consequentialToolsMode must be "all" or "list"');
      }
      state.config = resolveBandaidConfig({ workaroundConsequentialToolsMode: value });
    },
  });

  return {
    get config() { return state.config; },
    get lastLearned() { return state.lastLearned; },
    get detectedCount() { return state.detectedCount; },
    get structuralFindings() { return state.structuralFindings; },
    get rootCauseFindings() { return state.rootCauseFindings; },
    get learnedPragmaCount() { return state.config.learnedSuppressionPragmas.length; },
    get learnedDeferredCount() { return state.config.learnedDeferredMarkers.length; },
    /** Internal hook for `updateBandaidExposure` (counts are read-only getters). */
    _setCounts(detectedCount: number, structuralFindings: number, rootCauseFindings: number): void {
      state.detectedCount = detectedCount;
      state.structuralFindings = structuralFindings;
      state.rootCauseFindings = rootCauseFindings;
    },
  };
}

/**
 * Update the exposure state after a detection pass. The runtime calls this
 * with the report's counts so the signals reflect the latest detection.
 */
export function updateBandaidExposure(
  state: BandaidExposureState,
  report: Readonly<{ findings: readonly { category: string; patternLabel: string }[] }>,
): void {
  const detectedCount = report.findings.length;
  const structuralFindings = report.findings.filter((f) => f.category !== "root-cause-not-addressed" && f.patternLabel !== "manual-reimplementation").length;
  const rootCauseFindings = report.findings.filter((f) => f.category === "root-cause-not-addressed").length;
  const mut = state as unknown as { _setCounts?: (d: number, s: number, r: number) => void };
  if (typeof mut._setCounts === "function") {
    mut._setCounts(detectedCount, structuralFindings, rootCauseFindings);
  }
}
