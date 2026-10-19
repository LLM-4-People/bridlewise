/**
 * Shared exposure registrations — `context` module.
 *
 * Owns a small per-process state object that mirrors what the real
 * context manager would expose: trimming behaviour, overflow tracking,
 * and memory-retrieval counts.
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

/**
 * Per-process context state. The tunable knobs (`maxContext` …
 * `retrievalMinScore`) are a LIVE PROJECTION of the `context` config section:
 * each is seeded from `bridlewise.config.json` at module load and its
 * customization `set` writes the config file (through the write gate) and
 * updates this projection, so a settings change is read by the very next trim
 * or retrieval AND survives a restart. The counters (`trimCount`, …) are
 * runtime measurements, not config.
 */
export const contextState = {
  trimCount: 0,
  overflowCount: 0,
  memoryRetrievalCount: 0,
  totalTokens: 0,
  maxTokens: 32768,
  lastTrimAmount: 0,
  clearCount: 0,
  forceTrimCount: 0,
  maxContext: seedFromConfig("context.maxContext", 32768) as number,
  trimThreshold: seedFromConfig("context.trimThreshold", 0.85) as number,
  trimStep: seedFromConfig("context.trimStep", 0.1) as number,
  preserveSystem: seedFromConfig("context.preserveSystem", true) as boolean,
  preserveLast: seedFromConfig("context.preserveLast", true) as boolean,
  compactStrategy: seedFromConfig("context.compactStrategy", "oldest") as "oldest" | "summary" | "vector",
  /** Tokens belonging to system messages (preserved across trims when `preserveSystem`). */
  systemTokens: 0,
  /** Tokens of the most recent non-system add (preserved across trims when `preserveLast`). */
  lastAddTokens: 0,
  /** Tokens offloaded to vector memory by the `vector` compact strategy. */
  offloadedTokens: 0,
  retrievalTopK: seedFromConfig("context.retrievalTopK", 5) as number,
  retrievalMinScore: seedFromConfig("context.retrievalMinScore", 0.3) as number,
};

/** Fraction of trimmed tokens retained as a summary by the `summary` compact strategy. */
const SUMMARY_RESIDUE_FRACTION = 0.1;

/**
 * One trim pass over the context window. Honors the preserve flags (system
 * tokens and the most recent message are never trimmed when their flags are
 * set) and the compact strategy: `oldest` discards trimmed tokens, `summary`
 * retains a compressed residue in the window, `vector` offloads the trimmed
 * tokens to vector memory for later retrieval.
 */
function applyTrim(requested: number): { amount: number; residue: number; offloaded: number } {
  const preserved =
    (contextState.preserveSystem ? contextState.systemTokens : 0) +
    (contextState.preserveLast ? contextState.lastAddTokens : 0);
  const trimmable = Math.max(0, contextState.totalTokens - preserved);
  const amount = Math.max(0, Math.min(Math.floor(requested), trimmable));
  let residue = 0;
  let offloaded = 0;
  if (contextState.compactStrategy === "summary") {
    residue = Math.ceil(amount * SUMMARY_RESIDUE_FRACTION);
  } else if (contextState.compactStrategy === "vector") {
    offloaded = amount;
    contextState.offloadedTokens += amount;
  }
  contextState.totalTokens = contextState.totalTokens - amount + residue;
  contextState.lastTrimAmount = amount - residue;
  return { amount, residue, offloaded };
}

/** State-field → config-path map for the context knobs (single source for the
 * import-time seeds and the registration-time re-sync). */
const CONTEXT_CONFIG_BINDINGS = {
  maxContext: "context.maxContext",
  trimThreshold: "context.trimThreshold",
  trimStep: "context.trimStep",
  preserveSystem: "context.preserveSystem",
  preserveLast: "context.preserveLast",
  compactStrategy: "context.compactStrategy",
  retrievalTopK: "context.retrievalTopK",
  retrievalMinScore: "context.retrievalMinScore",
} as const;

let contextRegistered = false;
export function registerContextExposure(): void {
  if (contextRegistered) return;
  contextRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(contextState, CONTEXT_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "context",
    title: "What the model is told",
    purpose:
      "How much of the conversation travels with each message, what is dropped first once it no longer fits, and what is always kept.",
  });

  // --- Signals (10) ---
  registerSignal({
    id: "context.trimCount",
    module: "context",
    name: "Trim Count",
    description: "Total number of context trim operations.",
    type: "counter",
    unit: "count",
    value: () => contextState.trimCount,
  });
  registerSignal({
    id: "context.overflowCount",
    module: "context",
    name: "Overflow Count",
    description: "Number of times the context window exceeded its limit.",
    type: "counter",
    unit: "count",
    // Exceeding the declared window limit is abnormal by the module's own
    // definition of the limit — any overflow is worth surfacing.
    abnormal: { warnAbove: 0 },
    value: () => contextState.overflowCount,
  });
  registerSignal({
    id: "context.memoryRetrievalCount",
    module: "context",
    name: "Memory Retrieval Count",
    description: "Number of memory retrievals triggered by context management.",
    type: "counter",
    unit: "count",
    value: () => contextState.memoryRetrievalCount,
  });
  registerSignal({
    id: "context.totalTokens",
    module: "context",
    name: "Total Tokens",
    description: "Estimated token size of the current context window.",
    type: "gauge",
    unit: "tokens",
    value: () => contextState.totalTokens,
  });
  registerSignal({
    id: "context.utilization",
    module: "context",
    name: "Utilization",
    description: "Fraction of the context window currently in use (0..1).",
    type: "gauge",
    unit: "ratio",
    // Above 1.0 the window holds more than its declared capacity — the
    // module's own overflow condition, not an invented judgment.
    abnormal: { warnAbove: 1 },
    value: () =>
      contextState.maxContext === 0
        ? 0
        : contextState.totalTokens / contextState.maxContext,
  });
  registerSignal({
    id: "context.lastTrimAmount",
    module: "context",
    name: "Last Trim Amount",
    description: "Token count removed by the most recent trim.",
    type: "gauge",
    unit: "tokens",
    value: () => contextState.lastTrimAmount,
  });
  registerSignal({
    id: "context.clearCount",
    module: "context",
    name: "Clear Count",
    description: "Number of times the context was fully cleared.",
    type: "counter",
    unit: "count",
    value: () => contextState.clearCount,
  });
  registerSignal({
    id: "context.forceTrimCount",
    module: "context",
    name: "Force Trim Count",
    description: "Number of forced (operator-initiated) trim operations.",
    type: "counter",
    unit: "count",
    value: () => contextState.forceTrimCount,
  });
  registerSignal({
    id: "context.preserveSystem",
    module: "context",
    name: "Preserve System",
    description: "Whether system messages are preserved across trims.",
    type: "boolean",
    value: () => contextState.preserveSystem,
  });
  registerSignal({
    id: "context.preserveLast",
    module: "context",
    name: "Preserve Last",
    description: "Whether the most recent message is preserved across trims.",
    type: "boolean",
    value: () => contextState.preserveLast,
  });

  // --- Actions (5) ---
  registerAction({
    id: "context.forceTrim",
    module: "context",
    name: "Force Trim",
    description: "Force a context trim now, regardless of utilization.",
    args: {
      amount: { type: "number", required: false, description: "Tokens to trim" },
    },
    execute: async (args) => {
      const requested = Math.max(0, Number(args?.amount ?? contextState.totalTokens / 4));
      contextState.trimCount += 1;
      contextState.forceTrimCount += 1;
      const { amount, residue, offloaded } = applyTrim(requested);
      return {
        trimmed: true,
        amount,
        residue,
        offloaded,
        strategy: contextState.compactStrategy,
        remaining: contextState.totalTokens,
      };
    },
  });
  registerAction({
    id: "context.clear",
    module: "context",
    name: "Clear",
    description: "Clear the entire context window.",
    execute: async () => {
      contextState.totalTokens = 0;
      contextState.systemTokens = 0;
      contextState.lastAddTokens = 0;
      contextState.clearCount += 1;
      return { cleared: true, clearCount: contextState.clearCount };
    },
  });
  registerAction({
    id: "context.addTokens",
    module: "context",
    name: "Add Tokens",
    description: "Add synthetic tokens to the context (for testing).",
    args: {
      count: { type: "number", required: false, description: "Tokens to add" },
      kind: { type: "string", required: false, description: "Token kind: `system` or `message` (default)" },
    },
    execute: async (args) => {
      const count = Math.max(0, Number(args?.count ?? 100));
      const kind = String(args?.kind ?? "message");
      contextState.totalTokens += count;
      if (kind === "system") contextState.systemTokens += count;
      else contextState.lastAddTokens = count;
      if (contextState.totalTokens > contextState.maxContext) {
        contextState.overflowCount += 1;
      }
      return { added: count, kind, totalTokens: contextState.totalTokens };
    },
  });
  registerAction({
    id: "context.retrieveMemory",
    module: "context",
    name: "Retrieve Memory",
    description: "Trigger one memory retrieval (for testing).",
    args: {
      scores: { type: "string", required: false, description: "Comma-separated candidate retrieval scores (0..1)" },
    },
    execute: async (args) => {
      contextState.memoryRetrievalCount += 1;
      // A retrieval pass injects at most `retrievalTopK` entries, and only
      // those scoring at least `retrievalMinScore`.
      const candidates = String(args?.scores ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      const injected = candidates
        .filter((score) => score >= contextState.retrievalMinScore)
        .toSorted((a, b) => b - a)
        .slice(0, contextState.retrievalTopK);
      return {
        retrieved: true,
        count: contextState.memoryRetrievalCount,
        considered: candidates.length,
        injected: injected.length,
      };
    },
  });
  registerAction({
    id: "context.autoTrim",
    module: "context",
    name: "Auto Trim",
    description: "Run an automatic trim pass if utilization exceeds the threshold.",
    execute: async () => {
      const utilization = contextState.maxContext === 0
        ? 0
        : contextState.totalTokens / contextState.maxContext;
      if (utilization < contextState.trimThreshold) {
        return { trimmed: false, utilization };
      }
      const requested = Math.floor(contextState.totalTokens * contextState.trimStep);
      contextState.trimCount += 1;
      const { amount, residue, offloaded } = applyTrim(requested);
      return {
        trimmed: true,
        amount,
        residue,
        offloaded,
        strategy: contextState.compactStrategy,
        utilization,
      };
    },
  });

  // --- Customizations (8) ---
  // All eight are read live by the trim/retrieval actions (verified by the
  // customization-liveness suite), so changes are immediate.
  registerCustomization({
    id: "context.maxContext",
    module: "context",
    name: "Most conversation sent at once",
    description:
      "The upper limit, in tokens, on how much conversation and supporting material is held in the window at one time.",
    type: "number",
    default: 32768,
    min: 1024,
    max: 2_000_000,
    unit: "tokens",
    current: () => contextState.maxContext,
    set: configBoundSet("context.maxContext", (v) => { contextState.maxContext = Number(v); }),
    contract: { effect: "immediate" },
    measuredBy: "context.utilization",
    configPath: "context.maxContext",
  });
  registerCustomization({
    id: "context.trimThreshold",
    module: "context",
    name: "When older messages start being dropped",
    description:
      "Once the conversation fills this fraction of the limit (0..1), older parts start being trimmed.",
    type: "number",
    default: 0.85,
    min: 0,
    max: 1,
    unit: "fraction",
    current: () => contextState.trimThreshold,
    set: configBoundSet("context.trimThreshold", (v) => { contextState.trimThreshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "context.trimThreshold",
  });
  registerCustomization({
    id: "context.trimStep",
    module: "context",
    name: "How much one trim drops",
    description:
      "Each trim pass drops this fraction of the conversation. Higher = fewer but bigger cuts.",
    type: "number",
    default: 0.1,
    min: 0.01,
    max: 0.9,
    unit: "fraction",
    current: () => contextState.trimStep,
    set: configBoundSet("context.trimStep", (v) => { contextState.trimStep = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "context.trimStep",
  });
  registerCustomization({
    id: "context.preserveSystem",
    module: "context",
    name: "Always keep the standing instructions",
    description:
      "On: the standing instructions given to the assistant are never trimmed away, no matter how full the conversation gets.",
    type: "boolean",
    default: true,
    current: () => contextState.preserveSystem,
    set: configBoundSet("context.preserveSystem", (v) => { contextState.preserveSystem = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "context.preserveSystem",
    configPath: "context.preserveSystem",
  });
  registerCustomization({
    id: "context.preserveLast",
    module: "context",
    name: "Always keep the newest message",
    description:
      "On: the most recent message is never trimmed away, no matter how full the conversation gets.",
    type: "boolean",
    default: true,
    current: () => contextState.preserveLast,
    set: configBoundSet("context.preserveLast", (v) => { contextState.preserveLast = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "context.preserveLast",
    configPath: "context.preserveLast",
  });
  registerCustomization({
    id: "context.compactStrategy",
    module: "context",
    name: "How trimming chooses what to drop",
    description:
      "'oldest' discards trimmed messages outright; 'summary' keeps a condensed residue of them; 'vector' offloads them to recallable memory.",
    type: "enum",
    default: "oldest",
    enum: ["oldest", "summary", "vector"],
    current: () => contextState.compactStrategy,
    set: configBoundSet("context.compactStrategy", (v) => { contextState.compactStrategy = String(v) as typeof contextState.compactStrategy; }),
    contract: { effect: "immediate" },
    configPath: "context.compactStrategy",
  });
  registerCustomization({
    id: "context.retrievalTopK",
    module: "context",
    name: "Memories recalled per lookup",
    description:
      "How many stored memories are injected per retrieval pass. Higher = more recall, larger requests.",
    type: "number",
    default: 5,
    min: 1,
    max: 100,
    unit: "entries",
    current: () => contextState.retrievalTopK,
    set: configBoundSet("context.retrievalTopK", (v) => { contextState.retrievalTopK = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "context.retrievalTopK",
  });
  registerCustomization({
    id: "context.retrievalMinScore",
    module: "context",
    name: "Relevance needed to recall a memory",
    description:
      "A stored memory is only injected into the conversation when its relevance score is at least this (0..1).",
    type: "number",
    default: 0.3,
    min: 0,
    max: 1,
    unit: "score",
    current: () => contextState.retrievalMinScore,
    set: configBoundSet("context.retrievalMinScore", (v) => { contextState.retrievalMinScore = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "context.retrievalMinScore",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetContextRegistration(): void {
  contextRegistered = false;
}
