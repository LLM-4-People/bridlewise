/**
 * Shared exposure registrations — `bias` module.
 *
 * Owns a small per-process state object that mirrors what the real
 * bias subsystem would expose: detections, preventions, and the
 * distribution of detected bias types.
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

/** Per-process bias state. */
export const biasState = {
  detectionCount: 0,
  preventionCount: 0,
  falseAlarmCount: 0,
  resetCount: 0,
  clearCount: 0,
  biasTypeCounts: new Map<string, number>(),
  // The detection/handling knobs are a LIVE PROJECTION of the `bias` config
  // section: seeded from `bridlewise.config.json` and written back through
  // the config gate on every `set`.
  biasTypes: new Set<string>(
    String(seedFromConfig("bias.biasTypes", "gender,race,age,religion,nationality"))
      .split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  ),
  threshold: seedFromConfig("bias.threshold", 0.5) as number,
  preventionMode: seedFromConfig("bias.preventionMode", "warn") as "off" | "warn" | "block",
  auditMode: seedFromConfig("bias.auditMode", "summary") as "summary" | "detailed" | "off",
  recordInputs: seedFromConfig("bias.recordInputs", false) as boolean,
  escalateToOperator: seedFromConfig("bias.escalateToOperator", true) as boolean,
  maxAuditRows: seedFromConfig("bias.maxAuditRows", 1000) as number,
  /** The audit log: one row per audited detection, capped at `maxAuditRows`. */
  auditLog: [] as string[],
};

/** State-field → config-path map (single source for the import-time seeds and the registration-time re-sync). */
const BIAS_CONFIG_BINDINGS = {
  biasTypes: "bias.biasTypes",
  threshold: "bias.threshold",
  preventionMode: "bias.preventionMode",
  auditMode: "bias.auditMode",
  recordInputs: "bias.recordInputs",
  escalateToOperator: "bias.escalateToOperator",
  maxAuditRows: "bias.maxAuditRows",
} as const;

let biasRegistered = false;
export function registerBiasExposure(): void {
  if (biasRegistered) return;
  biasRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(biasState, BIAS_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "bias",
    title: "Fair-answer checks",
    purpose:
      "How the system watches its own answers for slanted wording, what it does when it finds some, and how much of that it writes down.",
  });

  // --- Signals (11) ---
  registerSignal({
    id: "bias.detectionCount",
    module: "bias",
    name: "Detection Count",
    description: "Total number of bias issues detected.",
    type: "counter",
    unit: "count",
    value: () => biasState.detectionCount,
  });
  registerSignal({
    id: "bias.preventionCount",
    module: "bias",
    name: "Prevention Count",
    description: "Total number of bias issues prevented from propagating.",
    type: "counter",
    unit: "count",
    value: () => biasState.preventionCount,
  });
  registerSignal({
    id: "bias.falseAlarmCount",
    module: "bias",
    name: "False Alarm Count",
    description: "Number of bias detections that were false alarms.",
    type: "counter",
    unit: "count",
    value: () => biasState.falseAlarmCount,
  });
  registerSignal({
    id: "bias.preventionRate",
    module: "bias",
    name: "Prevention Rate",
    description: "Fraction of detected biases that were prevented (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      biasState.detectionCount === 0
        ? 0
        : biasState.preventionCount / biasState.detectionCount,
  });
  registerSignal({
    id: "bias.typeCount",
    module: "bias",
    name: "Type Count",
    description: "Number of distinct bias types under surveillance.",
    type: "gauge",
    unit: "count",
    value: () => biasState.biasTypes.size,
  });
  registerSignal({
    id: "bias.resetCount",
    module: "bias",
    name: "Reset Count",
    description: "Number of times the bias subsystem has been reset.",
    type: "counter",
    unit: "count",
    value: () => biasState.resetCount,
  });
  registerSignal({
    id: "bias.clearCount",
    module: "bias",
    name: "Clear Count",
    description: "Number of times the bias state has been cleared.",
    type: "counter",
    unit: "count",
    value: () => biasState.clearCount,
  });
  registerSignal({
    id: "bias.threshold",
    module: "bias",
    name: "Threshold",
    description: "Current score threshold for bias detection.",
    type: "gauge",
    // This signal MIRRORS the `bias.threshold` customization, so it must
    // declare the same unit the control prints. It said "ratio" — a
    // fraction-of-a-whole claim — for what is a score cutoff.
    unit: "score",
    value: () => biasState.threshold,
  });
  registerSignal({
    id: "bias.preventionMode",
    module: "bias",
    name: "Prevention Mode",
    description: "Whether bias prevention is set to off, warn, or block.",
    type: "string",
    value: () => biasState.preventionMode,
  });
  registerSignal({
    id: "bias.auditMode",
    module: "bias",
    name: "Audit Mode",
    description: "Current audit logging mode.",
    type: "string",
    value: () => biasState.auditMode,
  });
  registerSignal({
    id: "bias.auditRowCount",
    module: "bias",
    name: "Audit Row Count",
    description: "Number of rows currently retained in the audit log.",
    type: "gauge",
    unit: "count",
    value: () => biasState.auditLog.length,
  });

  // --- Actions (6) ---
  registerAction({
    id: "bias.reset",
    module: "bias",
    name: "Reset",
    description: "Reset all bias counters.",
    execute: async () => {
      biasState.detectionCount = 0;
      biasState.preventionCount = 0;
      biasState.falseAlarmCount = 0;
      biasState.biasTypeCounts.clear();
      biasState.auditLog.length = 0;
      biasState.resetCount += 1;
      return { reset: true, resetCount: biasState.resetCount };
    },
  });
  registerAction({
    id: "bias.clear",
    module: "bias",
    name: "Clear",
    description: "Clear the bias state (preserves configuration).",
    execute: async () => {
      biasState.clearCount += 1;
      return { cleared: true, clearCount: biasState.clearCount };
    },
  });
  registerAction({
    id: "bias.reportDetection",
    module: "bias",
    name: "Report Detection",
    description: "Record a synthetic bias detection (for testing).",
    args: {
      type: { type: "string", required: false, description: "Bias type" },
      prevented: { type: "boolean", required: false, description: "Whether it was prevented (overrides preventionMode)" },
      falseAlarm: { type: "boolean", required: false, description: "Whether it was a false alarm" },
      score: { type: "number", required: false, description: "Bias score (0..1), judged against `bias.threshold`" },
      input: { type: "string", required: false, description: "Detector input, audited only when `bias.recordInputs` is on" },
    },
    execute: async (args) => {
      const type = String(args?.type ?? "gender");
      // Surveillance gate: findings for types not under surveillance are not
      // detections.
      if (!biasState.biasTypes.has(type)) {
        return { flagged: false, reason: "type not under surveillance", type };
      }
      // `threshold` gate: a finding scoring below the threshold is not
      // flagged as bias.
      const score = typeof args?.score === "number" ? args.score : undefined;
      if (score !== undefined && score < biasState.threshold) {
        return { flagged: false, reason: "below threshold", score, threshold: biasState.threshold };
      }
      biasState.detectionCount += 1;
      biasState.biasTypeCounts.set(type, (biasState.biasTypeCounts.get(type) ?? 0) + 1);
      // `preventionMode` decides the default action on a finding: `block`
      // prevents propagation, `warn` only warns, `off` does neither. An
      // explicit `prevented` arg still records the caller's own outcome.
      const prevented = args?.prevented === undefined
        ? biasState.preventionMode === "block"
        : Boolean(args?.prevented);
      const warned = biasState.preventionMode === "warn";
      if (prevented) biasState.preventionCount += 1;
      if (args?.falseAlarm === true) biasState.falseAlarmCount += 1;
      const escalated = biasState.escalateToOperator;
      // Audit logging per `auditMode`, capped at `maxAuditRows` (oldest rows
      // dropped first). Detector inputs are recorded only when
      // `recordInputs` is on.
      const audited = biasState.auditMode !== "off";
      if (audited) {
        let row = `type=${type} prevented=${prevented}`;
        if (biasState.auditMode === "detailed") {
          row += ` score=${score ?? "n/a"} warned=${warned} escalated=${escalated} falseAlarm=${args?.falseAlarm === true}`;
          if (biasState.recordInputs && typeof args?.input === "string") {
            row += ` input=${args.input}`;
          }
        }
        biasState.auditLog.push(row);
        while (biasState.auditLog.length > biasState.maxAuditRows) {
          biasState.auditLog.shift();
        }
      }
      return {
        flagged: true,
        detectionCount: biasState.detectionCount,
        type,
        prevented,
        warned,
        escalated,
        audited,
      };
    },
  });
  registerAction({
    id: "bias.readAudit",
    module: "bias",
    name: "Read Audit",
    description: "Read the most recent audit log rows.",
    args: {
      limit: { type: "number", required: false, description: "Maximum rows to return (default 100)" },
    },
    execute: async (args) => {
      const limit = Math.max(0, Number(args?.limit ?? 100));
      return {
        rowCount: biasState.auditLog.length,
        rows: biasState.auditLog.slice(-limit),
      };
    },
  });
  registerAction({
    id: "bias.addType",
    module: "bias",
    name: "Add Type",
    description: "Add a bias type to the surveillance set.",
    args: {
      type: { type: "string", required: true, description: "Bias type to add" },
    },
    execute: async (args) => {
      const type = String(args?.type ?? "");
      biasState.biasTypes.add(type);
      return { types: Array.from(biasState.biasTypes) };
    },
  });
  registerAction({
    id: "bias.removeType",
    module: "bias",
    name: "Remove Type",
    description: "Remove a bias type from the surveillance set.",
    args: {
      type: { type: "string", required: true, description: "Bias type to remove" },
    },
    execute: async (args) => {
      const type = String(args?.type ?? "");
      biasState.biasTypes.delete(type);
      return { types: Array.from(biasState.biasTypes) };
    },
  });

  // --- Customizations (7) ---
  // All seven are read live by `reportDetection` (or, for the audit cap,
  // applied by `set` itself) — verified by the customization-liveness suite —
  // so changes are immediate.
  registerCustomization({
    id: "bias.threshold",
    module: "bias",
    name: "Bias flag cutoff score",
    description:
      "A finding scoring at least this is flagged as bias and handled per the prevention mode. Lower = more findings flagged.",
    type: "number",
    default: 0.5,
    min: 0,
    max: 1,
    unit: "score",
    current: () => biasState.threshold,
    set: configBoundSet("bias.threshold", (v) => { biasState.threshold = Number(v); }),
    contract: { effect: "immediate" },
    measuredBy: "bias.threshold",
    configPath: "bias.threshold",
  });
  registerCustomization({
    id: "bias.preventionMode",
    module: "bias",
    name: "What happens on a bias finding",
    description:
      "'off' does nothing, 'warn' notes the finding, 'block' stops the response that triggered it.",
    type: "enum",
    default: "warn",
    enum: ["off", "warn", "block"],
    current: () => biasState.preventionMode,
    set: configBoundSet("bias.preventionMode", (v) => { biasState.preventionMode = String(v) as typeof biasState.preventionMode; }),
    contract: { effect: "immediate" },
    measuredBy: "bias.preventionMode",
    configPath: "bias.preventionMode",
  });
  registerCustomization({
    id: "bias.auditMode",
    module: "bias",
    name: "Audit log detail",
    description:
      "How much of each bias check is written to the audit log: nothing ('off'), one condensed line ('summary'), or full detail ('detailed').",
    type: "enum",
    default: "summary",
    enum: ["off", "summary", "detailed"],
    current: () => biasState.auditMode,
    set: configBoundSet("bias.auditMode", (v) => { biasState.auditMode = String(v) as typeof biasState.auditMode; }),
    contract: { effect: "immediate" },
    measuredBy: "bias.auditMode",
    configPath: "bias.auditMode",
  });
  registerCustomization({
    id: "bias.biasTypes",
    module: "bias",
    name: "Bias categories watched",
    description:
      "A comma-separated list of the bias categories checked for; findings outside these categories are not flagged.",
    type: "string",
    default: "gender,race,age,religion,nationality",
    current: () => Array.from(biasState.biasTypes).join(","),
    set: configBoundSet("bias.biasTypes", (v) => {
      biasState.biasTypes = new Set(
        String(v).split(",").map((s) => s.trim()).filter((s) => s.length > 0),
      );
    }),
    contract: { effect: "immediate" },
    measuredBy: "bias.typeCount",
    configPath: "bias.biasTypes",
  });
  registerCustomization({
    id: "bias.recordInputs",
    module: "bias",
    name: "Record checked text in the audit log",
    description:
      "On: the text each bias check examined is saved in the audit log alongside the finding (detailed audit mode only).",
    type: "boolean",
    default: false,
    current: () => biasState.recordInputs,
    set: configBoundSet("bias.recordInputs", (v) => { biasState.recordInputs = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "bias.recordInputs",
  });
  registerCustomization({
    id: "bias.escalateToOperator",
    module: "bias",
    name: "Bring findings to your attention",
    description:
      "On: bias findings are surfaced to you rather than only being logged.",
    type: "boolean",
    default: true,
    current: () => biasState.escalateToOperator,
    set: configBoundSet("bias.escalateToOperator", (v) => { biasState.escalateToOperator = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "bias.escalateToOperator",
  });
  registerCustomization({
    id: "bias.maxAuditRows",
    module: "bias",
    name: "Most audit log entries kept",
    description:
      "The audit log keeps at most this many entries; older ones are dropped, and lowering the cap drops them right away.",
    type: "number",
    default: 1000,
    min: 0,
    max: 1000000,
    unit: "rows",
    current: () => biasState.maxAuditRows,
    set: configBoundSet("bias.maxAuditRows", (v) => {
      biasState.maxAuditRows = Number(v);
      // A lowered cap applies immediately: drop oldest rows beyond it.
      while (biasState.auditLog.length > biasState.maxAuditRows) {
        biasState.auditLog.shift();
      }
    }),
    contract: { effect: "immediate" },
    measuredBy: "bias.auditRowCount",
    configPath: "bias.maxAuditRows",
  });
  // `bias.detectionStrategy` was REMOVED (not wired to a dead store): this
  // stub contains no detector — detections are recorded synthetically via
  // `bias.reportDetection` — so a lexical/semantic/hybrid strategy could
  // never influence behaviour. Re-add it when the real bias detector
  // (src/safety/bias-detector.ts) backs this registration.
}

/** Reset the per-module registration flag (test-only). */
export function resetBiasRegistration(): void {
  biasRegistered = false;
}
