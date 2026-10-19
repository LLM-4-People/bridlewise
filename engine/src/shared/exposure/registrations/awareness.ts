/**
 * Shared exposure registrations — `awareness` module.
 *
 * The awareness module monitors the live state of the harness (signals,
 * computation time, update rate) and exposes that observability to
 * consumers. This stub backs the exposure with a small per-process
 * state object.
 */

import { guarded } from "../../../process/fault-policy.ts";
import {
  countActions,
  countAll,
  countCustomizations,
  countSignals,
  getSignal,
  readSignal,
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  configBoundSet,
  seedFromConfig,
  syncStateFromConfig,
} from "../index.ts";

/**
 * The readings a fresh process watches. ONE source for both the initial state
 * and the `awareness.enabledSignals` control's declared default: the control
 * used to advertise `""` while the module actually started watching these
 * three, so the settings surface offered a "reset to default" that would have
 * silently stopped every reading from being watched.
 */
const DEFAULT_ENABLED_SIGNALS: readonly string[] = [
  "search.queryCount",
  "memory.entryCount",
  "editor.editCount",
];

/** Per-process awareness state. */
export const awarenessState = {
  signalCount: 0,
  computationTimeMs: 0,
  updateRate: 0,
  lastUpdateMs: 0,
  refreshCount: 0,
  clearCount: 0,
  // The monitoring knobs are a LIVE PROJECTION of the `awareness` config
  // section: seeded from `bridlewise.config.json` and written back through
  // the config gate on every `set`.
  monitoredModules: new Set<string>(
    String(seedFromConfig("awareness.monitoredModules", "")).split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  ),
  compactMaxTokens: seedFromConfig("awareness.compactMaxTokens", 8192) as number,
  refreshIntervalMs: seedFromConfig("awareness.refreshIntervalMs", 1000) as number,
  enabledSignals: new Set<string>(
    String(seedFromConfig("awareness.enabledSignals", DEFAULT_ENABLED_SIGNALS.join(",")))
      .split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  ),
  backgroundMonitor: seedFromConfig("awareness.backgroundMonitor", true) as boolean,
  alertThreshold: seedFromConfig("awareness.alertThreshold", 0.9) as number,
  metric: seedFromConfig("awareness.metric", "all") as "all" | "signals" | "actions" | "customizations",
  detailedReport: seedFromConfig("awareness.detailedReport", false) as boolean,
};

/**
 * The background awareness monitor: a real (unref'd) interval that performs
 * a heartbeat refresh every `refreshIntervalMs` while `backgroundMonitor` is
 * enabled. Restarted whenever either customization changes; stopped on
 * registration reset. `unref()` keeps the timer from holding the process
 * open.
 */
let backgroundTimer: ReturnType<typeof setInterval> | undefined;
function applyBackgroundMonitor(): void {
  if (backgroundTimer !== undefined) {
    clearInterval(backgroundTimer);
    backgroundTimer = undefined;
  }
  if (!awarenessState.backgroundMonitor) return;
  backgroundTimer = setInterval(guarded("awareness.background-refresh", () => {
    performRefresh();
  }), awarenessState.refreshIntervalMs);
  backgroundTimer.unref?.();
}

/** One awareness refresh: recompute monitored-signal aggregates from the live registry. */
function performRefresh(): ReadonlyArray<{ id: string; value: number | string | boolean }> {
  const startedAt = performance.now();
  awarenessState.refreshCount += 1;
  awarenessState.lastUpdateMs = Date.now();
  const rows: Array<{ id: string; value: number | string | boolean }> = [];
  for (const id of awarenessState.enabledSignals) {
    if (getSignal(id) !== undefined) rows.push({ id, value: readSignal(id) });
  }
  awarenessState.signalCount = rows.length;
  awarenessState.computationTimeMs += performance.now() - startedAt;
  awarenessState.updateRate = awarenessState.computationTimeMs === 0
    ? 0
    : awarenessState.signalCount / (awarenessState.computationTimeMs / 1000);
  return rows;
}

/** Count the registry items the awareness view reports, per the `metric` filter. */
function viewCount(): number {
  switch (awarenessState.metric) {
    case "signals": return countSignals();
    case "actions": return countActions();
    case "customizations": return countCustomizations();
    default: return countAll();
  }
}

/** State-field → config-path map (single source for the import-time seeds and the registration-time re-sync). */
const AWARENESS_CONFIG_BINDINGS = {
  compactMaxTokens: "awareness.compactMaxTokens",
  refreshIntervalMs: "awareness.refreshIntervalMs",
  backgroundMonitor: "awareness.backgroundMonitor",
  alertThreshold: "awareness.alertThreshold",
  metric: "awareness.metric",
  enabledSignals: "awareness.enabledSignals",
  monitoredModules: "awareness.monitoredModules",
  detailedReport: "awareness.detailedReport",
} as const;

let awarenessRegistered = false;
export function registerAwarenessExposure(): void {
  if (awarenessRegistered) return;
  awarenessRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(awarenessState, AWARENESS_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "awareness",
    title: "Watching the system itself",
    purpose:
      "How closely the system watches its own live readings, how often it refreshes them, and how much of that it reports back to you.",
  });

  // --- Signals (10) ---
  registerSignal({
    id: "awareness.signalCount",
    module: "awareness",
    name: "Signal Count",
    description: "Number of signals currently being monitored.",
    type: "gauge",
    unit: "count",
    value: () => awarenessState.signalCount,
  });
  registerSignal({
    id: "awareness.computationTime",
    module: "awareness",
    name: "Computation Time",
    description: "Total time spent computing awareness updates in milliseconds.",
    type: "timer",
    unit: "ms",
    value: () => awarenessState.computationTimeMs,
  });
  registerSignal({
    id: "awareness.updateRate",
    module: "awareness",
    name: "Update Rate",
    description: "Mean number of awareness updates per second.",
    type: "gauge",
    unit: "updates/s",
    value: () => awarenessState.updateRate,
  });
  registerSignal({
    id: "awareness.lastUpdate",
    module: "awareness",
    name: "Last Update",
    description: "Epoch-millisecond instant of the most recent awareness update.",
    // The value is an INSTANT (`Date.now()`), not a duration. Declared as
    // `timer`/`ms` it rendered as a ~56-year duration — the declaration was
    // the bug, not the renderer.
    type: "timestamp",
    unit: "epoch ms",
    value: () => awarenessState.lastUpdateMs,
  });
  registerSignal({
    id: "awareness.refreshCount",
    module: "awareness",
    name: "Refresh Count",
    description: "Number of times the awareness view has been refreshed.",
    type: "counter",
    unit: "count",
    value: () => awarenessState.refreshCount,
  });
  registerSignal({
    id: "awareness.clearCount",
    module: "awareness",
    name: "Clear Count",
    description: "Number of times the awareness state has been cleared.",
    type: "counter",
    unit: "count",
    value: () => awarenessState.clearCount,
  });
  registerSignal({
    id: "awareness.monitoredModuleCount",
    module: "awareness",
    name: "Monitored Module Count",
    description: "Number of modules currently monitored.",
    type: "gauge",
    unit: "count",
    value: () => awarenessState.monitoredModules.size,
  });
  registerSignal({
    id: "awareness.enabledSignalCount",
    module: "awareness",
    name: "Enabled Signal Count",
    description: "Number of signals enabled in the current awareness filter.",
    type: "gauge",
    unit: "count",
    value: () => awarenessState.enabledSignals.size,
  });
  registerSignal({
    id: "awareness.backgroundMonitor",
    module: "awareness",
    name: "Background Monitor",
    description: "Whether the background awareness monitor is running.",
    type: "boolean",
    value: () => awarenessState.backgroundMonitor,
  });
  registerSignal({
    id: "awareness.alertActive",
    module: "awareness",
    name: "Alert Active",
    description: "Whether any awareness metric is currently above the alert threshold.",
    type: "boolean",
    value: () => awarenessState.updateRate > awarenessState.alertThreshold,
  });

  // --- Actions (5) ---
  registerAction({
    id: "awareness.refresh",
    module: "awareness",
    name: "Refresh",
    description: "Force an awareness refresh and recompute aggregates.",
    execute: async () => {
      const rows = performRefresh();
      const result: Record<string, unknown> = {
        refreshed: true,
        refreshCount: awarenessState.refreshCount,
        metric: awarenessState.metric,
        viewCount: viewCount(),
      };
      if (awarenessState.detailedReport) {
        // Per-signal detail rows, token-capped by `compactMaxTokens` (the
        // compacted awareness view retains at most that many tokens; a row
        // is ~chars/4 tokens).
        const detail: Array<{ id: string; value: number | string | boolean }> = [];
        let tokens = 0;
        let truncated = false;
        for (const row of rows) {
          const rowTokens = Math.ceil(JSON.stringify(row).length / 4);
          if (tokens + rowTokens > awarenessState.compactMaxTokens) {
            truncated = true;
            break;
          }
          tokens += rowTokens;
          detail.push(row);
        }
        result.signals = detail;
        result.truncated = truncated;
      }
      return result;
    },
  });
  registerAction({
    id: "awareness.clear",
    module: "awareness",
    name: "Clear",
    description: "Clear the awareness state and reset all counters.",
    execute: async () => {
      awarenessState.signalCount = 0;
      awarenessState.computationTimeMs = 0;
      awarenessState.updateRate = 0;
      awarenessState.lastUpdateMs = 0;
      awarenessState.clearCount += 1;
      return { cleared: true, clearCount: awarenessState.clearCount };
    },
  });
  registerAction({
    id: "awareness.addMonitoredModule",
    module: "awareness",
    name: "Add Monitored Module",
    description: "Add a module to the monitored set.",
    args: {
      module: { type: "string", required: true, description: "Module id to monitor" },
    },
    execute: async (args) => {
      const module = String(args?.module ?? "");
      awarenessState.monitoredModules.add(module);
      return { monitored: Array.from(awarenessState.monitoredModules) };
    },
  });
  registerAction({
    id: "awareness.removeMonitoredModule",
    module: "awareness",
    name: "Remove Monitored Module",
    description: "Remove a module from the monitored set.",
    args: {
      module: { type: "string", required: true, description: "Module id to stop monitoring" },
    },
    execute: async (args) => {
      const module = String(args?.module ?? "");
      awarenessState.monitoredModules.delete(module);
      return { monitored: Array.from(awarenessState.monitoredModules) };
    },
  });
  registerAction({
    id: "awareness.tick",
    module: "awareness",
    name: "Tick",
    description: "Process one awareness tick (for testing/simulation).",
    args: {
      signals: { type: "number", required: false, description: "Signal count delta" },
      timeMs: { type: "number", required: false, description: "Computation time delta" },
    },
    execute: async (args) => {
      const signals = Number(args?.signals ?? 0);
      const timeMs = Number(args?.timeMs ?? 1);
      awarenessState.signalCount += signals;
      awarenessState.computationTimeMs += timeMs;
      // `lastUpdateMs` is the INSTANT of the update (see the timestamp
      // signal); assigning the tick's duration delta here fed a duration
      // into a field every other writer fills with `Date.now()`.
      awarenessState.lastUpdateMs = Date.now();
      awarenessState.updateRate = awarenessState.computationTimeMs === 0
        ? 0
        : awarenessState.signalCount / (awarenessState.computationTimeMs / 1000);
      return {
        signalCount: awarenessState.signalCount,
        computationTimeMs: awarenessState.computationTimeMs,
        updateRate: awarenessState.updateRate,
      };
    },
  });

  // --- Customizations (8) ---
  // Every knob here is read live by the module (refresh/viewCount/the
  // background timer — `set` restarts the timer itself), so a change takes
  // effect immediately.
  registerCustomization({
    id: "awareness.compactMaxTokens",
    module: "awareness",
    name: "Monitoring summary size limit",
    description:
      "The condensed self-monitoring view is kept to at most this many tokens. Lower = shorter reports that may leave rows out.",
    type: "number",
    default: 8192,
    min: 256,
    max: 1_000_000,
    unit: "tokens",
    current: () => awarenessState.compactMaxTokens,
    set: configBoundSet("awareness.compactMaxTokens", (v) => { awarenessState.compactMaxTokens = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "awareness.compactMaxTokens",
  });
  registerCustomization({
    id: "awareness.refreshInterval",
    module: "awareness",
    name: "Monitoring refresh rate",
    description:
      "How often the self-monitoring view updates, in milliseconds. Lower = fresher numbers, more background work.",
    type: "number",
    default: 1000,
    min: 100,
    max: 60000,
    unit: "milliseconds",
    current: () => awarenessState.refreshIntervalMs,
    set: configBoundSet("awareness.refreshIntervalMs", (v) => {
      awarenessState.refreshIntervalMs = Number(v);
      applyBackgroundMonitor();
    }),
    contract: { effect: "immediate" },
    measuredBy: "awareness.refreshCount",
    configPath: "awareness.refreshIntervalMs",
  });
  registerCustomization({
    id: "awareness.backgroundMonitor",
    module: "awareness",
    name: "Background monitoring",
    description:
      "On: the system continuously watches its own activity in the background. Off: it only reports when asked.",
    type: "boolean",
    default: true,
    current: () => awarenessState.backgroundMonitor,
    set: configBoundSet("awareness.backgroundMonitor", (v) => {
      awarenessState.backgroundMonitor = Boolean(v);
      applyBackgroundMonitor();
    }),
    contract: { effect: "immediate" },
    measuredBy: "awareness.backgroundMonitor",
    configPath: "awareness.backgroundMonitor",
  });
  registerCustomization({
    id: "awareness.alertThreshold",
    module: "awareness",
    name: "Alert level",
    description:
      "If the rate of monitored updates rises above this many updates per second, an alert is raised. Lower = more sensitive alerting.",
    type: "number",
    default: 0.9,
    min: 0,
    max: 1000,
    unit: "updates per second",
    current: () => awarenessState.alertThreshold,
    set: configBoundSet("awareness.alertThreshold", (v) => { awarenessState.alertThreshold = Number(v); }),
    contract: { effect: "immediate" },
    measuredBy: "awareness.alertActive",
    configPath: "awareness.alertThreshold",
  });
  registerCustomization({
    id: "awareness.metric",
    module: "awareness",
    name: "What monitoring reports",
    description:
      "Which kind of information the self-monitoring view covers: everything, only live readings, only runnable operations, or only adjustable settings.",
    type: "enum",
    default: "all",
    enum: ["all", "signals", "actions", "customizations"],
    current: () => awarenessState.metric,
    set: configBoundSet("awareness.metric", (v) => { awarenessState.metric = String(v) as typeof awarenessState.metric; }),
    contract: { effect: "immediate" },
    configPath: "awareness.metric",
  });
  registerCustomization({
    id: "awareness.enabledSignals",
    module: "awareness",
    name: "Only watch these readings",
    description:
      "A comma-separated list of reading names to watch. Leave empty to watch none of them.",
    type: "string",
    default: DEFAULT_ENABLED_SIGNALS.join(","),
    current: () => Array.from(awarenessState.enabledSignals).join(","),
    set: configBoundSet("awareness.enabledSignals", (v) => {
      awarenessState.enabledSignals = new Set(
        String(v).split(",").map((s) => s.trim()).filter((s) => s.length > 0),
      );
    }),
    contract: { effect: "immediate" },
    measuredBy: "awareness.enabledSignalCount",
    configPath: "awareness.enabledSignals",
  });
  registerCustomization({
    id: "awareness.monitoredModules",
    module: "awareness",
    name: "Only watch these features",
    description:
      "A comma-separated list of feature names to watch. Leave empty to watch none of them.",
    type: "string",
    default: "",
    current: () => Array.from(awarenessState.monitoredModules).join(","),
    set: configBoundSet("awareness.monitoredModules", (v) => {
      awarenessState.monitoredModules = new Set(
        String(v).split(",").map((s) => s.trim()).filter((s) => s.length > 0),
      );
    }),
    contract: { effect: "immediate" },
    measuredBy: "awareness.monitoredModuleCount",
    configPath: "awareness.monitoredModules",
  });
  registerCustomization({
    id: "awareness.detailedReport",
    module: "awareness",
    name: "Detailed monitoring reports",
    description:
      "On: monitoring reports include one row per watched reading. Off: they show totals only.",
    type: "boolean",
    default: false,
    current: () => awarenessState.detailedReport,
    set: configBoundSet("awareness.detailedReport", (v) => { awarenessState.detailedReport = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "awareness.detailedReport",
  });

  // Start (or stop) the background monitor per the current configuration.
  applyBackgroundMonitor();
}

/** Reset the per-module registration flag (test-only). Stops the background monitor. */
export function resetAwarenessRegistration(): void {
  awarenessRegistered = false;
  if (backgroundTimer !== undefined) {
    clearInterval(backgroundTimer);
    backgroundTimer = undefined;
  }
}
