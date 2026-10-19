/**
 * Shared exposure registrations — `tools` module.
 *
 * Owns a small per-process state object that mirrors what the real
 * tool registry would expose: call counts, error counts, latency,
 * and concurrency bounds.
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  configBoundSet,
  seedFromConfig,
  syncStateFromConfig,
  readNumberCustomization,
  writeConfigCustomization,
} from "../index.ts";

/** Per-process tools state. */
export const toolsState = {
  callCount: 0,
  errorCount: 0,
  totalLatencyMs: 0,
  latencySamples: 0,
  lastLatencyMs: 0,
  inFlight: 0,
  cancelCount: 0,
  retryCount: 0,
  // The dispatch knobs are a LIVE PROJECTION of the `tools` config section:
  // seeded from `bridlewise.config.json` and written back through the config
  // gate on every `set`. `timeout` binds to `tools.dispatchTimeoutMs` (distinct
  // from `tools.defaultBounds.timeoutMs`, the executor's resource bound).
  maxConcurrent: seedFromConfig("tools.maxConcurrent", 5) as number,
  timeout: seedFromConfig("tools.dispatchTimeoutMs", 30000) as number,
  retryLimit: seedFromConfig("tools.retryLimit", 2) as number,
  retryBackoff: seedFromConfig("tools.retryBackoff", "exponential") as "fixed" | "exponential" | "linear",
  failClosed: seedFromConfig("tools.failClosed", true) as boolean,
  propagateErrors: seedFromConfig("tools.propagateErrors", true) as boolean,
  recordInputs: seedFromConfig("tools.recordInputs", false) as boolean,
  recordOutputs: seedFromConfig("tools.recordOutputs", false) as boolean,
  /** Calls abandoned for exceeding `timeout`. */
  timeoutCount: 0,
  /**
   * The record the most recent call contributed to the timeline. What it
   * holds is decided by `recordInputs` / `recordOutputs`; with both off it is
   * the bare call outcome.
   */
  lastRecord: "",
};

/**
 * The wait before retry `index` (0-based), as a multiple of the call's own
 * observed latency: the same wait every time (fixed), growing steadily
 * (linear), or doubling (exponential). Expressing the schedule relative to a
 * MEASURED quantity keeps an invented base delay out of the module.
 */
function backoffMultiplier(index: number): number {
  if (toolsState.retryBackoff === "fixed") return 1;
  if (toolsState.retryBackoff === "linear") return index + 1;
  return 2 ** index;
}

/** State-field → config-path map for the dispatch knobs (single source for
 * the import-time seeds and the registration-time re-sync). */
const TOOLS_CONFIG_BINDINGS = {
  maxConcurrent: "tools.maxConcurrent",
  timeout: "tools.dispatchTimeoutMs",
  retryLimit: "tools.retryLimit",
  retryBackoff: "tools.retryBackoff",
  failClosed: "tools.failClosed",
  propagateErrors: "tools.propagateErrors",
  recordInputs: "tools.recordInputs",
  recordOutputs: "tools.recordOutputs",
} as const;

let toolsRegistered = false;
export function registerToolsExposure(): void {
  if (toolsRegistered) return;
  toolsRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(toolsState, TOOLS_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "tools",
    title: "Running tools",
    purpose:
      "How many tool calls may run at once, how long each one may take, how often a failed call is tried again, and what is recorded about them.",
  });

  // --- Signals (12) ---
  registerSignal({
    id: "tools.callCount",
    module: "tools",
    name: "Call Count",
    description: "Total number of tool calls dispatched.",
    type: "counter",
    unit: "count",
    value: () => toolsState.callCount,
  });
  registerSignal({
    id: "tools.errorCount",
    module: "tools",
    name: "Error Count",
    description: "Total number of tool calls that failed.",
    type: "counter",
    unit: "count",
    value: () => toolsState.errorCount,
  });
  registerSignal({
    id: "tools.errorRate",
    module: "tools",
    name: "Error Rate",
    description: "Fraction of tool calls that failed (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      toolsState.callCount === 0 ? 0 : toolsState.errorCount / toolsState.callCount,
  });
  registerSignal({
    id: "tools.avgLatency",
    module: "tools",
    name: "Average Latency",
    description: "Mean tool-call latency in milliseconds.",
    type: "timer",
    unit: "ms",
    value: () =>
      toolsState.latencySamples === 0
        ? 0
        : toolsState.totalLatencyMs / toolsState.latencySamples,
  });
  registerSignal({
    id: "tools.lastLatency",
    module: "tools",
    name: "Last Latency",
    description: "Latency in ms of the most recent tool call.",
    type: "timer",
    unit: "ms",
    value: () => toolsState.lastLatencyMs,
  });
  registerSignal({
    id: "tools.inFlight",
    module: "tools",
    name: "In-Flight",
    description: "Number of tool calls currently in flight.",
    type: "gauge",
    unit: "count",
    value: () => toolsState.inFlight,
  });
  registerSignal({
    id: "tools.cancelCount",
    module: "tools",
    name: "Cancel Count",
    description: "Number of tool calls that were cancelled before completion.",
    type: "counter",
    unit: "count",
    value: () => toolsState.cancelCount,
  });
  registerSignal({
    id: "tools.retryCount",
    module: "tools",
    name: "Retry Count",
    description: "Number of automatic retries issued.",
    type: "counter",
    unit: "count",
    value: () => toolsState.retryCount,
  });
  registerSignal({
    id: "tools.maxConcurrent",
    module: "tools",
    name: "Max Concurrent",
    description: "Configured maximum number of concurrent tool calls.",
    type: "gauge",
    // Mirrors the `tools.maxConcurrent` customization — same quantity, so
    // the same unit word the control prints ("calls", not a bare "count").
    unit: "calls",
    value: () => toolsState.maxConcurrent,
  });
  registerSignal({
    id: "tools.failClosed",
    module: "tools",
    name: "Fail Closed",
    description: "Whether tool failures fail closed (raise) rather than pass through.",
    type: "boolean",
    value: () => toolsState.failClosed,
  });
  registerSignal({
    id: "tools.timeoutCount",
    module: "tools",
    name: "Timeout Count",
    description: "Number of tool calls abandoned for exceeding the configured time limit.",
    type: "counter",
    unit: "count",
    value: () => toolsState.timeoutCount,
  });
  registerSignal({
    id: "tools.lastCallRecord",
    module: "tools",
    name: "Last Call Record",
    description: "The timeline record the most recent tool call contributed.",
    type: "string",
    value: () => toolsState.lastRecord,
  });

  // --- Actions (5) ---
  registerAction({
    id: "tools.cancel",
    module: "tools",
    name: "Cancel",
    description: "Cancel all currently in-flight tool calls.",
    execute: async () => {
      const cancelled = toolsState.inFlight;
      toolsState.cancelCount += cancelled;
      toolsState.inFlight = 0;
      return { cancelled };
    },
  });
  registerAction({
    id: "tools.retry",
    module: "tools",
    name: "Retry",
    description: "Retry the most recent failed tool call.",
    execute: async () => {
      toolsState.retryCount += 1;
      return { retried: true, retryCount: toolsState.retryCount };
    },
  });
  registerAction({
    id: "tools.invoke",
    module: "tools",
    name: "Invoke",
    description: "Dispatch one synthetic tool invocation through the registry's real timeout, retry, error and recording path.",
    args: {
      succeed: { type: "boolean", required: false, description: "Force success/failure" },
      latencyMs: { type: "number", required: false, description: "Simulated latency, judged against `tools.timeout`" },
      failAttempts: {
        type: "number",
        required: false,
        description: "How many attempts fail before the call lands; more than `tools.retryLimit` means it gives up",
      },
      input: { type: "string", required: false, description: "Call input, recorded only when `tools.recordInputs` is on" },
      output: { type: "string", required: false, description: "Call result, recorded only when `tools.recordOutputs` is on" },
      hold: {
        type: "boolean",
        required: false,
        description: "Leave the call in flight after it returns, so a later call meets it at the concurrency bound",
      },
    },
    // Every dispatch knob is read HERE, at call time: the time limit, the
    // retry cap and its wait pattern, the two error-handling flags and the
    // two recording flags. Facts the registry cannot know (how long the tool
    // takes, how many attempts it needs) are STATED by the caller — nothing
    // about the outcome is invented.
    execute: async (args) => {
      // 0. ADMISSION — `maxConcurrent` is how many tool operations may run at
      //    the same time. A call arriving while the bound is full is refused
      //    outright: a limit that silently admits everyone is not a limit.
      if (toolsState.inFlight >= toolsState.maxConcurrent) {
        return {
          admitted: false,
          reason: "concurrency limit reached",
          inFlight: toolsState.inFlight,
          maxConcurrent: toolsState.maxConcurrent,
        };
      }
      toolsState.callCount += 1;
      toolsState.inFlight += 1;
      const stated = Math.max(0, Number(args?.latencyMs ?? 100));

      // 1. TIME LIMIT — a call that runs past the limit is abandoned AT the
      //    limit (that is all the time it was allowed to consume), and no
      //    retry rescues it: the budget is already spent.
      const timedOut = stated > toolsState.timeout;
      const latency = timedOut ? toolsState.timeout : stated;
      toolsState.lastLatencyMs = latency;
      toolsState.totalLatencyMs += latency;
      toolsState.latencySamples += 1;

      // 2. RETRIES — `retryLimit` is how many further attempts a failing call
      //    gets; the wait before each is set by `retryBackoff`.
      // An abandoned call, and one the caller states simply fails, never land
      // however many retries are allowed.
      const failAttempts = timedOut || args?.succeed === false
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Number(args?.failAttempts ?? 0));
      const retries = timedOut ? 0 : Math.min(failAttempts, toolsState.retryLimit);
      const succeeded = failAttempts <= toolsState.retryLimit;
      toolsState.retryCount += retries;
      const retryDelaysMs: number[] = [];
      for (let index = 0; index < retries; index += 1) {
        retryDelaysMs.push(backoffMultiplier(index) * latency);
      }
      if (timedOut) toolsState.timeoutCount += 1;
      if (!succeeded) toolsState.errorCount += 1;
      // A held call stays in flight (that is what `tools.cancel` and
      // `tools.clearInFlight` exist to clean up), so a later call meets it at
      // the bound above.
      if (args?.hold !== true) toolsState.inFlight = Math.max(0, toolsState.inFlight - 1);

      // 3. ERROR HANDLING — `failClosed` decides whether a final failure stops
      //    the operation or is handed back as a result; `propagateErrors`
      //    decides whether the caller is told what went wrong at all.
      const reason = timedOut
        ? `abandoned after the ${toolsState.timeout}ms time limit`
        : `failed after ${retries + 1} attempts`;
      const raised = !succeeded && toolsState.failClosed;
      const propagated = !succeeded && toolsState.propagateErrors;

      // 4. RECORDING — what this call contributes to the timeline.
      const record: Record<string, string> = {};
      if (toolsState.recordInputs) record.input = String(args?.input ?? "");
      if (toolsState.recordOutputs) record.output = String(args?.output ?? "");
      toolsState.lastRecord =
        `succeeded=${succeeded}` +
        (record.input === undefined ? "" : ` input=${record.input}`) +
        (record.output === undefined ? "" : ` output=${record.output}`);

      return {
        admitted: true,
        callCount: toolsState.callCount,
        inFlight: toolsState.inFlight,
        latencyMs: latency,
        statedLatencyMs: stated,
        timedOut,
        succeed: succeeded,
        attempts: retries + 1,
        retries,
        retryDelaysMs,
        totalBackoffMs: retryDelaysMs.reduce((sum, wait) => sum + wait, 0),
        raised,
        record,
        ...(propagated ? { error: reason } : {}),
        ...(!succeeded && !toolsState.propagateErrors ? { swallowed: true } : {}),
      };
    },
  });
  registerAction({
    id: "tools.resetCounters",
    module: "tools",
    name: "Reset Counters",
    description: "Reset all tools counters to zero.",
    execute: async () => {
      toolsState.callCount = 0;
      toolsState.errorCount = 0;
      toolsState.totalLatencyMs = 0;
      toolsState.latencySamples = 0;
      toolsState.lastLatencyMs = 0;
      toolsState.cancelCount = 0;
      toolsState.retryCount = 0;
      toolsState.timeoutCount = 0;
      toolsState.lastRecord = "";
      return { reset: true };
    },
  });
  registerAction({
    id: "tools.clearInFlight",
    module: "tools",
    name: "Clear In-Flight",
    description: "Force the in-flight counter to zero (recovery hook).",
    execute: async () => {
      toolsState.inFlight = 0;
      return { cleared: true };
    },
  });

  // --- Customizations (8) ---
  // Effect timing: all eight are read by `invoke` at dispatch time (the
  // numbered steps above, admission first), so a change lands on the very
  // next tool call — which is what `immediate` states.
  registerCustomization({
    id: "tools.maxConcurrent",
    module: "tools",
    name: "Tools running at once",
    description:
      "How many tool operations may run at the same time. Higher = more parallel work, more load.",
    type: "number",
    default: 5,
    min: 1,
    max: 1000,
    unit: "calls",
    current: () => toolsState.maxConcurrent,
    set: configBoundSet("tools.maxConcurrent", (v) => { toolsState.maxConcurrent = Number(v); }),
    contract: { effect: "immediate" },
    measuredBy: "tools.maxConcurrent",
    configPath: "tools.maxConcurrent",
  });
  registerCustomization({
    id: "tools.timeout",
    module: "tools",
    name: "Time limit per tool call",
    description:
      "A tool call is cancelled after this many milliseconds. Higher = slow tools get more time to finish.",
    type: "number",
    default: 30000,
    min: 100,
    max: 600000,
    unit: "milliseconds",
    current: () => toolsState.timeout,
    set: configBoundSet("tools.dispatchTimeoutMs", (v) => { toolsState.timeout = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "tools.dispatchTimeoutMs",
  });
  // RENAMED `tools.retryCount` → `tools.retryLimit` (one id, one quantity).
  //
  // One id was bound to two different quantities: the SIGNAL `tools.retryCount`
  // reports retries ISSUED SO FAR (a running total, `toolsState.retryCount`)
  // while this control sets the per-call CAP (`toolsState.retryLimit`). A
  // reader who resolved either by id got the other, and the mirror-unit guard
  // had to carry a standing exemption to describe the collision rather than
  // fix it.
  //
  // MIGRATION — the old wire id is not persisted anywhere, verified before
  // renaming: customization values live only in this per-process registry
  // (the web control plane writes through `setSchemaCustomization` →
  // `setCustomizationValue`; there is no settings table, file, or
  // localStorage keyed by customization id), and every client learns the id
  // list from the schema at request time rather than storing it. The one
  // remaining by-id reference is the web repository's display-language table
  // (`src/lib/settings/customization-language.ts`), whose documented fallback
  // is the server-declared label + description — the very name and
  // description below — so the rename degrades to identical served words
  // until that entry is rekeyed.
  registerCustomization({
    id: "tools.retryLimit",
    module: "tools",
    name: "Retries per failed tool call",
    description:
      "How many times a failed tool call is automatically attempted again before giving up.",
    type: "number",
    default: 2,
    min: 0,
    max: 20,
    unit: "retries",
    current: () => toolsState.retryLimit,
    set: configBoundSet("tools.retryLimit", (v) => { toolsState.retryLimit = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "tools.retryLimit",
  });
  registerCustomization({
    id: "tools.retryBackoff",
    module: "tools",
    name: "Wait pattern between retries",
    description:
      "How the wait between retries grows: the same wait every time (fixed), doubling each time (exponential), or growing steadily (linear).",
    type: "enum",
    default: "exponential",
    enum: ["fixed", "exponential", "linear"],
    current: () => toolsState.retryBackoff,
    set: configBoundSet("tools.retryBackoff", (v) => { toolsState.retryBackoff = String(v) as typeof toolsState.retryBackoff; }),
    contract: { effect: "immediate" },
    configPath: "tools.retryBackoff",
  });
  registerCustomization({
    id: "tools.failClosed",
    module: "tools",
    name: "Treat tool failures as errors",
    description:
      "On: a failing tool stops the operation with an error. Off: the failure is passed along as a result.",
    type: "boolean",
    default: true,
    current: () => toolsState.failClosed,
    set: configBoundSet("tools.failClosed", (v) => { toolsState.failClosed = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "tools.failClosed",
    configPath: "tools.failClosed",
  });
  registerCustomization({
    id: "tools.propagateErrors",
    module: "tools",
    name: "Report tool errors to the caller",
    description:
      "On: tool errors are reported back to whatever requested the tool, instead of being swallowed.",
    type: "boolean",
    default: true,
    current: () => toolsState.propagateErrors,
    set: configBoundSet("tools.propagateErrors", (v) => { toolsState.propagateErrors = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "tools.propagateErrors",
  });
  registerCustomization({
    id: "tools.recordInputs",
    module: "tools",
    name: "Record what tools are given",
    description:
      "On: everything sent into a tool call is saved in the timeline for later inspection.",
    type: "boolean",
    default: false,
    current: () => toolsState.recordInputs,
    set: configBoundSet("tools.recordInputs", (v) => { toolsState.recordInputs = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "tools.recordInputs",
  });
  registerCustomization({
    id: "tools.recordOutputs",
    module: "tools",
    name: "Record what tools return",
    description:
      "On: everything a tool call returns is saved in the timeline for later inspection.",
    type: "boolean",
    default: false,
    current: () => toolsState.recordOutputs,
    set: configBoundSet("tools.recordOutputs", (v) => { toolsState.recordOutputs = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "tools.recordOutputs",
  });

  // Live tool-executor / search / map-sample bounds. These are NOT the
  // per-process toolsState projection — the server reads them through
  // harness-config accessors on every call. Bind them to the config path
  // those accessors already consume.
  const toolNum = (spec: {
    id: string;
    name: string;
    description: string;
    configPath: string;
    default: number;
    min: number;
    max: number;
    unit?: string;
  }): void => {
    registerCustomization({
      id: spec.id,
      module: "tools",
      name: spec.name,
      description: spec.description,
      type: "number",
      default: spec.default,
      min: spec.min,
      max: spec.max,
      ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
      current: () => readNumberCustomization(spec.configPath, spec.default),
      set: (v) => writeConfigCustomization(spec.configPath, v),
      contract: { effect: "immediate" },
      configPath: spec.configPath,
    });
  };
  toolNum({
    id: "tools.defaultTimeoutMs",
    name: "Time limit for a tool that does not name its own",
    description:
      "A tool call with no timeout of its own is abandoned after this many milliseconds. Raising it lets slow tools finish; lowering it fails them sooner.",
    configPath: "tools.defaultBounds.timeoutMs",
    default: 30_000,
    min: 100,
    max: 600_000,
    unit: "milliseconds",
  });
  toolNum({
    id: "tools.defaultMaxOutputBytes",
    name: "Most output a tool may return",
    description:
      "A tool's captured output is cut off after this many bytes so a runaway print cannot fill memory. Raising it keeps more of a long log.",
    configPath: "tools.defaultBounds.maxOutputBytes",
    default: 1_048_576,
    min: 1_024,
    max: 16_777_216,
    unit: "bytes",
  });
  toolNum({
    id: "tools.defaultMaxMemoryBytes",
    name: "Most memory a tool may use",
    description:
      "A tool that grows past this many bytes is refused so a runaway process cannot fill the machine. Raising it allows heavier tools and costs more headroom.",
    configPath: "tools.defaultBounds.maxMemoryBytes",
    default: 268_435_456,
    min: 1_024,
    max: 1_073_741_824,
    unit: "bytes",
  });
  toolNum({
    id: "tools.autoCheckMaxCaptureBytes",
    name: "Most typecheck output kept from one run",
    description:
      "The automatic typecheck keeps at most this many bytes of output. Raising it preserves more of a long failure log and costs more memory.",
    configPath: "tools.autoCheck.maxCaptureBytes",
    default: 262_144,
    min: 1_024,
    max: 16_777_216,
    unit: "bytes",
  });
  toolNum({
    id: "tools.searchMaxDepth",
    name: "How many folders deep a code search may walk",
    description:
      "A code search will not descend farther than this many folders. Raising it reaches deeper trees and costs more walking.",
    configPath: "tools.searchMaxDepth",
    default: 5,
    min: 1,
    max: 64,
    unit: "folders",
  });
  toolNum({
    id: "tools.searchMaxResults",
    name: "Most code-search hits shown",
    description:
      "A code search returns at most this many matching lines. Raising it shows more of a common pattern and costs more ranking work.",
    configPath: "tools.searchMaxResults",
    default: 50,
    min: 1,
    max: 5_000,
    unit: "results",
  });
  toolNum({
    id: "tools.searchMaxScannedMatches",
    name: "How far past the shown hits a search still counts",
    description:
      "After the shown quota is full, the search keeps counting up to this many matches so a truncated answer can state its true total. Raising it makes that total more honest and costs more scanning.",
    configPath: "tools.searchMaxScannedMatches",
    default: 5_000,
    min: 1,
    max: 100_000,
    unit: "matches",
  });
  toolNum({
    id: "tools.searchTimeoutMs",
    name: "Abandon a hung code search after",
    description:
      "A code search that is still running after this many milliseconds is killed so a pathological pattern cannot occupy a thread forever. Lowering it fails sooner; raising it lets a slow walk finish.",
    configPath: "tools.searchTimeoutMs",
    default: 15_000,
    min: 100,
    max: 300_000,
    unit: "milliseconds",
  });
  toolNum({
    id: "tools.searchLinePreviewMaxChars",
    name: "Characters of a matching line shown in a hit",
    description:
      "Each code-search hit includes this many characters of the matching line. Raising it shows more of the line and spends more prompt space.",
    configPath: "tools.searchLinePreviewMaxChars",
    default: 200,
    min: 20,
    max: 4_000,
    unit: "characters",
  });
  toolNum({
    id: "tools.dependencyGraphMaxCycles",
    name: "Import cycles included in the tool's answer",
    description:
      "The dependency-graph tool names this many import cycles in the answer the model reads, separately from how many the on-screen map lists. Raising it surfaces more loops in that answer.",
    configPath: "tools.dependencyGraphMaxCycles",
    default: 10,
    min: 1,
    max: 200,
    unit: "cycles",
  });
  toolNum({
    id: "tools.repositoryMapSampleCount",
    name: "Files previewed in the project-map tool's answer",
    description:
      "The project-map tool includes this many modules in the preview the model reads. Raising it shows more of the tree in that answer and spends more prompt space.",
    configPath: "tools.repositoryMapSampleCount",
    default: 20,
    min: 1,
    max: 500,
    unit: "files",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetToolsRegistration(): void {
  toolsRegistered = false;
}
