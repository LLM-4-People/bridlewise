/**
 * Shared exposure registrations — `memory` module.
 *
 * Owns a small per-process state object that mirrors what a future live
 * memory store would expose. All signals read from this state, all
 * actions mutate it, and all customizations read/set it — through the
 * shared exposure system (`src/shared/exposure/`).
 *
 * The exposure surface itself is stable; only the callbacks change when
 * this stub is replaced with a real `MemoryStore`.
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
  readStringCustomization,
  writeConfigCustomization,
} from "../index.ts";
// The search-engine vocabulary's owner: the offered choices are exactly the
// kinds the real store's resolver accepts, derived rather than restated. The
// memory resolver is also the one door to the memory defaults themselves —
// `resolveMemoryConfig({}).searchResultLimit` is the default the search row
// declares, so the catalog, the query builder, the config leaf, and this row
// can never hold different numbers.
import { MEMORY_SEARCH_ENGINE_KINDS, resolveMemoryConfig } from "../../../memory/memory-types.ts";
// The capture-and-search defaults the config contract owns beside the schema
// that declares the leaves — cited here (the one place a "return to default"
// write consults), never restated.
import {
  DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS,
  DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS,
  DEFAULT_MEMORY_PREVIEW_MAX_CHARS,
  DEFAULT_MEMORY_SEARCH_MAX_LIMIT,
  DEFAULT_MEMORY_RETRIEVAL_LIMIT,
  DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS,
} from "../../../kernel/config-contracts.ts";

/**
 * Per-process memory state. The tunable knobs (`windowSize` … `maxCorrupted`)
 * are a LIVE PROJECTION of the `memory` config section: each is seeded from
 * `bridlewise.config.json` at module load and its customization `set` writes
 * the config file (through the write gate) and updates this projection, so a
 * settings change is read by the very next action AND survives a restart. The
 * counters (`entryCount`, `retrievalCount`, …) are runtime measurements, not
 * config. The window-trim knobs bind to `memory.windowTrimThreshold` /
 * `memory.windowTrimStep` — distinct from the top-level `memory.trimThreshold`,
 * which governs the real MemoryStore's whole-context trim.
 *
 * BESIDE the projection rows sit the REAL store's own knobs (the
 * `memory` section's whole-context facts): the token budget the run's context
 * manager trims within, the tier capacities, the per-entry size ceilings, and
 * the search engine. They are projection-less by design — their consumers
 * (`server/context/context-bridge.ts`, `server/context/memory-bridge.ts`)
 * resolve the section once per process and hold the result, so `current`
 * reads the document while the behavior follows the resolved cache: each
 * row declares `effect: "restart"` and says so in its own words, the same
 * honest timing the performance module's sampler knobs declare.
 */
export const memoryState = {
  entryCount: 0,
  presentCount: 0,
  shortTermCount: 0,
  longTermCount: 0,
  retrievalCount: 0,
  retrievalHits: 0,
  totalRetrievalLatencyMs: 0,
  retrievalSamples: 0,
  totalTokens: 0,
  compactCount: 0,
  pruneCount: 0,
  clearCount: 0,
  corruptedEntries: 0,
  /** Estimated token size of the present (in-context) window. */
  presentTokens: 0,
  windowSize: seedFromConfig("memory.windowSize", 4096) as number,
  trimThreshold: seedFromConfig("memory.windowTrimThreshold", 0.85) as number,
  trimStep: seedFromConfig("memory.windowTrimStep", 0.1) as number,
  promoteOnTurnBoundary: seedFromConfig("memory.promoteOnTurnBoundary", true) as boolean,
  defaultTier: seedFromConfig("memory.defaultTier", "short") as "present" | "short" | "long",
  /** Corrupted-entry tolerance before the store refuses writes. */
  maxCorrupted: seedFromConfig("memory.maxCorrupted", 0) as number,
};

/** State-field → config-path map for the memory knobs (single source for the
 * import-time seeds and the registration-time re-sync). */
const MEMORY_CONFIG_BINDINGS = {
  windowSize: "memory.windowSize",
  trimThreshold: "memory.windowTrimThreshold",
  trimStep: "memory.windowTrimStep",
  promoteOnTurnBoundary: "memory.promoteOnTurnBoundary",
  defaultTier: "memory.defaultTier",
  maxCorrupted: "memory.maxCorrupted",
} as const;

let memoryRegistered = false;
export function registerMemoryExposure(): void {
  if (memoryRegistered) return;
  memoryRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(memoryState, MEMORY_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "memory",
    title: "What the assistant remembers",
    purpose:
      "How much the assistant keeps at hand while it works, when older material starts being dropped, and where a new memory is filed.",
  });

  // --- Signals (10) ---
  registerSignal({
    id: "memory.entryCount",
    module: "memory",
    name: "Entry Count",
    description: "Total number of memory entries across all tiers.",
    type: "counter",
    unit: "count",
    value: () => memoryState.entryCount,
  });
  registerSignal({
    id: "memory.presentCount",
    module: "memory",
    name: "Present Count",
    description: "Number of entries in the in-memory present tier.",
    type: "gauge",
    unit: "count",
    value: () => memoryState.presentCount,
  });
  registerSignal({
    id: "memory.shortTermCount",
    module: "memory",
    name: "Short-Term Count",
    description: "Number of entries in the persisted short-term tier.",
    type: "gauge",
    unit: "count",
    value: () => memoryState.shortTermCount,
  });
  registerSignal({
    id: "memory.longTermCount",
    module: "memory",
    name: "Long-Term Count",
    description: "Number of entries in the durable long-term tier.",
    type: "gauge",
    unit: "count",
    value: () => memoryState.longTermCount,
  });
  registerSignal({
    id: "memory.retrievalCount",
    module: "memory",
    name: "Retrieval Count",
    description: "Total number of retrieval queries issued.",
    type: "counter",
    unit: "count",
    value: () => memoryState.retrievalCount,
  });
  registerSignal({
    id: "memory.hitRate",
    module: "memory",
    name: "Hit Rate",
    description: "Fraction of retrievals that returned at least one hit (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      memoryState.retrievalCount === 0
        ? 0
        : memoryState.retrievalHits / memoryState.retrievalCount,
  });
  registerSignal({
    id: "memory.avgRetrievalLatency",
    module: "memory",
    name: "Average Retrieval Latency",
    description: "Mean retrieval latency in milliseconds.",
    type: "timer",
    unit: "ms",
    value: () =>
      memoryState.retrievalSamples === 0
        ? 0
        : memoryState.totalRetrievalLatencyMs / memoryState.retrievalSamples,
  });
  registerSignal({
    id: "memory.totalTokens",
    module: "memory",
    name: "Total Tokens",
    description: "Estimated token size of all stored memory entries.",
    type: "gauge",
    unit: "tokens",
    value: () => memoryState.totalTokens,
  });
  registerSignal({
    id: "memory.compactCount",
    module: "memory",
    name: "Compact Count",
    description: "Number of times the memory store has been compacted.",
    type: "counter",
    unit: "count",
    value: () => memoryState.compactCount,
  });
  registerSignal({
    id: "memory.corruptedEntries",
    module: "memory",
    name: "Corrupted Entries",
    description: "Number of entries that failed integrity verification.",
    type: "gauge",
    unit: "count",
    // Any integrity failure is abnormal by this module's own semantics (the
    // store refuses writes beyond the tolerance) — declared, not invented.
    abnormal: { warnAbove: 0 },
    value: () => memoryState.corruptedEntries,
  });

  // --- Actions (6) ---
  registerAction({
    id: "memory.clear",
    module: "memory",
    name: "Clear",
    description: "Clear all memory tiers and reset counters.",
    execute: async () => {
      memoryState.entryCount = 0;
      memoryState.presentCount = 0;
      memoryState.shortTermCount = 0;
      memoryState.longTermCount = 0;
      memoryState.totalTokens = 0;
      memoryState.presentTokens = 0;
      memoryState.clearCount += 1;
      return { cleared: true, clearCount: memoryState.clearCount };
    },
  });
  registerAction({
    id: "memory.prune",
    module: "memory",
    name: "Prune",
    description: "Record a prune pass (the stub store tracks no entry ages, so no entries are dropped yet).",
    execute: async () => {
      memoryState.pruneCount += 1;
      return { pruned: true, pruneCount: memoryState.pruneCount };
    },
  });
  registerAction({
    id: "memory.compact",
    module: "memory",
    name: "Compact",
    description: "Summarize and compact low-priority entries.",
    execute: async () => {
      memoryState.compactCount += 1;
      return { compacted: true, compactCount: memoryState.compactCount };
    },
  });
  registerAction({
    id: "memory.addEntry",
    module: "memory",
    name: "Add Entry",
    description: "Add a synthetic memory entry to the configured default tier.",
    args: {
      tokens: { type: "number", required: false, description: "Estimated token size" },
      tier: { type: "string", required: false, description: "Tier (present|short|long)" },
    },
    execute: async (args) => {
      // `maxCorrupted` guard: beyond the tolerated number of corrupted
      // entries the store refuses writes (integrity first).
      if (memoryState.corruptedEntries > memoryState.maxCorrupted) {
        return {
          added: false,
          refused: true,
          reason: `corrupted entries (${memoryState.corruptedEntries}) exceed maxCorrupted (${memoryState.maxCorrupted}); store refuses writes`,
        };
      }
      const tier = String(args?.tier ?? memoryState.defaultTier) as "present" | "short" | "long";
      const tokens = Number(args?.tokens ?? 10);
      memoryState.entryCount += 1;
      if (tier === "present") memoryState.presentCount += 1;
      else if (tier === "short") memoryState.shortTermCount += 1;
      else memoryState.longTermCount += 1;
      memoryState.totalTokens += tokens;
      let trimmedTokens = 0;
      if (tier === "present") {
        memoryState.presentTokens += tokens;
        // Present-window trimming: `windowSize` caps the tokens retained in
        // the present window; a pass starts once usage exceeds
        // `trimThreshold` of capacity and drops `trimStep` of the window per
        // pass until the window fits.
        if (memoryState.presentTokens > memoryState.trimThreshold * memoryState.windowSize) {
          const chunk = Math.max(1, Math.ceil(memoryState.trimStep * memoryState.windowSize));
          do {
            const drop = Math.min(chunk, memoryState.presentTokens);
            memoryState.presentTokens -= drop;
            memoryState.totalTokens -= drop;
            trimmedTokens += drop;
          } while (memoryState.presentTokens > memoryState.windowSize);
        }
      }
      return { added: true, tier, tokens, trimmedTokens };
    },
  });
  registerAction({
    id: "memory.turnBoundary",
    module: "memory",
    name: "Turn Boundary",
    description: "Process a turn boundary: auto-promote present entries to short-term when `promoteOnTurnBoundary` is enabled.",
    execute: async () => {
      if (!memoryState.promoteOnTurnBoundary) {
        return { promoted: 0, promoteOnTurnBoundary: false };
      }
      const promoted = memoryState.presentCount;
      memoryState.shortTermCount += promoted;
      memoryState.presentCount = 0;
      memoryState.presentTokens = 0;
      return { promoted, promoteOnTurnBoundary: true };
    },
  });
  registerAction({
    id: "memory.retrieve",
    module: "memory",
    name: "Retrieve",
    description: "Issue a retrieval against the memory state and record its measured latency.",
    args: {
      hit: { type: "boolean", required: true, description: "Whether the retrieval hit (true) or missed (false)" },
    },
    // `hit` is REQUIRED and the latency is MEASURED. Both were invented: the
    // hit was a 70% coin flip and the latency a random 5–25ms, and both fed
    // operator-facing signals (`memory.retrievalHitRate`,
    // `memory.avgRetrievalLatency`). Deny-by-default: a caller that does not
    // know the outcome cannot record one.
    execute: async (args) => {
      const startedAt = performance.now();
      memoryState.retrievalCount += 1;
      const hit = args?.hit === true;
      if (hit) memoryState.retrievalHits += 1;
      const latency = performance.now() - startedAt;
      memoryState.totalRetrievalLatencyMs += latency;
      memoryState.retrievalSamples += 1;
      return { hit, latencyMs: latency };
    },
  });

  // --- Customizations (16) ---
  // The first six are read by the module's live behaviour (`addEntry`,
  // `turnBoundary` — verified by the customization-liveness suite), and the
  // behaviour reads the state at each call: a change takes effect
  // immediately, and `effect: "immediate"` states exactly that.
  registerCustomization({
    id: "memory.windowSize",
    module: "memory",
    name: "Working-memory size",
    description:
      "How much recent material is kept immediately at hand, in tokens (a token is roughly three-quarters of a word). Higher = more is kept before older items are trimmed.",
    type: "number",
    default: 4096,
    min: 256,
    max: 1_000_000,
    unit: "tokens",
    current: () => memoryState.windowSize,
    set: configBoundSet("memory.windowSize", (v) => { memoryState.windowSize = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "memory.windowSize",
  });
  registerCustomization({
    id: "memory.trimThreshold",
    module: "memory",
    name: "When trimming starts",
    description:
      "Once working memory is this full (as a fraction of its size, 0..1), older items start being trimmed away.",
    type: "number",
    default: 0.85,
    min: 0,
    max: 1,
    unit: "fraction",
    current: () => memoryState.trimThreshold,
    set: configBoundSet("memory.windowTrimThreshold", (v) => { memoryState.trimThreshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "memory.windowTrimThreshold",
  });
  registerCustomization({
    id: "memory.trimStep",
    module: "memory",
    name: "How much one trim removes",
    description:
      "Each trim pass removes this fraction of working memory. Higher = fewer but bigger cuts.",
    type: "number",
    default: 0.1,
    min: 0.01,
    max: 0.9,
    unit: "fraction",
    current: () => memoryState.trimStep,
    set: configBoundSet("memory.windowTrimStep", (v) => { memoryState.trimStep = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "memory.windowTrimStep",
  });
  // `memory.decayRate` and `memory.retentionDays` were REMOVED (not wired to
  // a dead store): this stub store tracks aggregate counts only — entries
  // carry no per-entry weights and no timestamps, so no code path could ever
  // consume a decay rate or a retention age. Rendering those knobs would
  // promise behaviour the module cannot deliver. Re-add them when the real
  // MemoryStore (which tracks ages and weights) backs this registration.
  registerCustomization({
    id: "memory.promoteOnTurnBoundary",
    module: "memory",
    name: "Keep recent memories automatically",
    description:
      "On: at the end of each conversation turn, items in working memory are moved to longer-lasting storage on their own.",
    type: "boolean",
    default: true,
    current: () => memoryState.promoteOnTurnBoundary,
    set: configBoundSet("memory.promoteOnTurnBoundary", (v) => { memoryState.promoteOnTurnBoundary = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "memory.promoteOnTurnBoundary",
  });
  registerCustomization({
    id: "memory.defaultTier",
    module: "memory",
    name: "Where new memories go",
    description:
      "The storage a new memory lands in when none is chosen: 'present' (this conversation only), 'short' (recent), or 'long' (lasting).",
    type: "enum",
    default: "short",
    enum: ["present", "short", "long"],
    current: () => memoryState.defaultTier,
    set: configBoundSet("memory.defaultTier", (v) => { memoryState.defaultTier = String(v) as typeof memoryState.defaultTier; }),
    contract: { effect: "immediate" },
    configPath: "memory.defaultTier",
  });
  registerCustomization({
    id: "memory.maxCorrupted",
    module: "memory",
    name: "Damaged-entry tolerance",
    description:
      "How many memory entries that fail their integrity check are tolerated before the store refuses to save anything new. 0 = strictest.",
    type: "number",
    default: 0,
    min: 0,
    max: 1000,
    unit: "entries",
    current: () => memoryState.maxCorrupted,
    set: configBoundSet("memory.maxCorrupted", (v) => { memoryState.maxCorrupted = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "memory.maxCorrupted",
  });

  // --- Customizations: the real store's whole-context knobs (10) ---
  // The `memory` config section's own facts, as the shipped config file
  // carries them (one owner for "what is this knob when untouched" — the
  // numbers below are the file's values, so a fresh install and the declared
  // default answer identically). Projection-less rows: `current` reads the
  // document through the config store, `set` writes through the gate, and
  // the runtime consumer resolves the section once per process — which is
  // why every row declares the restart timing instead of promising immediacy.
  const REAL_STORE_DEFAULTS = {
    contextTokenLimit: 32_768,
    trimThreshold: 0.8,
    recentTurnWindow: 10,
    shortTermTurnLimit: 50,
    longTermFactLimit: 1_000,
    summaryMaxTokens: 512,
    contentMaxCharacters: 1_048_576,
    maxTagsPerEntry: 64,
    maxTopicCharacters: 512,
    searchEngine: "inverted-index",
  } as const;

  registerCustomization({
    id: "memory.contextTokenLimit",
    module: "memory",
    name: "Whole-conversation size",
    description:
      "How much conversation the assistant keeps in view, in tokens, when the chosen model does not declare its own window (a model that declares one wins over this number). Higher = more history stays word-for-word before the oldest turns are summarized away. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.contextTokenLimit,
    min: 1024,
    max: 1_048_576,
    unit: "tokens",
    current: () => readNumberCustomization("memory.contextTokenLimit", REAL_STORE_DEFAULTS.contextTokenLimit),
    set: (v) => writeConfigCustomization("memory.contextTokenLimit", v),
    contract: { effect: "restart" },
    configPath: "memory.contextTokenLimit",
  });
  registerCustomization({
    id: "memory.contextTrimThreshold",
    module: "memory",
    name: "When the whole conversation starts shrinking",
    description:
      "Once the conversation reaches this share of its size limit, the oldest turns are summarized into short notes and dropped so the newest material fits. Higher = shrinking starts later. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.trimThreshold,
    min: 0.5,
    max: 0.99,
    unit: "fraction",
    current: () => readNumberCustomization("memory.trimThreshold", REAL_STORE_DEFAULTS.trimThreshold),
    set: (v) => writeConfigCustomization("memory.trimThreshold", v),
    contract: { effect: "restart" },
    configPath: "memory.trimThreshold",
  });
  registerCustomization({
    id: "memory.recentTurnWindow",
    module: "memory",
    name: "Turns kept word-for-word",
    description:
      "How many of the newest conversation turns are always kept exactly as written while older turns are summarized away. Higher = more verbatim recent context and less room for older material. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.recentTurnWindow,
    min: 1,
    max: 100_000,
    unit: "turns",
    current: () => readNumberCustomization("memory.recentTurnWindow", REAL_STORE_DEFAULTS.recentTurnWindow),
    set: (v) => writeConfigCustomization("memory.recentTurnWindow", v),
    contract: { effect: "restart" },
    configPath: "memory.recentTurnWindow",
  });
  registerCustomization({
    id: "memory.summaryMaxTokens",
    module: "memory",
    name: "Size of a summarized turn",
    description:
      "When an older turn is summarized away, its summary is kept no larger than this many tokens. Higher = richer memory of dropped turns at the cost of the conversation's budget. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.summaryMaxTokens,
    min: 32,
    max: 65_536,
    unit: "tokens",
    current: () => readNumberCustomization("memory.summaryMaxTokens", REAL_STORE_DEFAULTS.summaryMaxTokens),
    set: (v) => writeConfigCustomization("memory.summaryMaxTokens", v),
    contract: { effect: "restart" },
    configPath: "memory.summaryMaxTokens",
  });
  registerCustomization({
    id: "memory.shortTermTurnLimit",
    module: "memory",
    name: "Recent memories kept",
    description:
      "How many entries the recent tier of saved memories holds before the oldest are dropped to make room. Higher = longer recall of recent work at the cost of storage. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.shortTermTurnLimit,
    min: 1,
    max: 1_000_000,
    unit: "entries",
    current: () => readNumberCustomization("memory.shortTermTurnLimit", REAL_STORE_DEFAULTS.shortTermTurnLimit),
    set: (v) => writeConfigCustomization("memory.shortTermTurnLimit", v),
    contract: { effect: "restart" },
    configPath: "memory.shortTermTurnLimit",
  });
  registerCustomization({
    id: "memory.longTermFactLimit",
    module: "memory",
    name: "Lasting memories kept",
    description:
      "How many entries the lasting tier of saved memories holds before the oldest are dropped to make room. Higher = older facts stay recallable at the cost of storage. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.longTermFactLimit,
    min: 1,
    max: 10_000_000,
    unit: "entries",
    current: () => readNumberCustomization("memory.longTermFactLimit", REAL_STORE_DEFAULTS.longTermFactLimit),
    set: (v) => writeConfigCustomization("memory.longTermFactLimit", v),
    contract: { effect: "restart" },
    configPath: "memory.longTermFactLimit",
  });
  registerCustomization({
    id: "memory.searchEngine",
    module: "memory",
    name: "How saved memories are searched",
    description:
      "Which engine answers a search over saved memories: 'lexical' scores how many query words each entry contains (fast, exact words only), 'inverted-index' builds a lookup from words to entries so larger stores answer quicker. Takes effect after a restart.",
    type: "enum",
    default: REAL_STORE_DEFAULTS.searchEngine,
    enum: [...MEMORY_SEARCH_ENGINE_KINDS],
    current: () => readStringCustomization("memory.searchEngine", REAL_STORE_DEFAULTS.searchEngine),
    set: (v) => writeConfigCustomization("memory.searchEngine", v),
    contract: { effect: "restart" },
    configPath: "memory.searchEngine",
  });
  registerCustomization({
    id: "memory.contentMaxCharacters",
    module: "memory",
    name: "Largest single memory",
    description:
      "The most characters one saved memory may hold; a larger save is refused rather than stored truncated. Higher = bigger memories allowed at the cost of storage. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.contentMaxCharacters,
    min: 1024,
    max: 10_485_760,
    unit: "characters",
    current: () => readNumberCustomization("memory.contentMaxCharacters", REAL_STORE_DEFAULTS.contentMaxCharacters),
    set: (v) => writeConfigCustomization("memory.contentMaxCharacters", v),
    contract: { effect: "restart" },
    configPath: "memory.contentMaxCharacters",
  });
  registerCustomization({
    id: "memory.maxTagsPerEntry",
    module: "memory",
    name: "Labels one memory may carry",
    description:
      "How many tags a single saved memory may have; a save with more is refused. Higher = finer-grained filtering of memories at the cost of noisier entries. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.maxTagsPerEntry,
    min: 1,
    max: 4_096,
    unit: "tags",
    current: () => readNumberCustomization("memory.maxTagsPerEntry", REAL_STORE_DEFAULTS.maxTagsPerEntry),
    set: (v) => writeConfigCustomization("memory.maxTagsPerEntry", v),
    contract: { effect: "restart" },
    configPath: "memory.maxTagsPerEntry",
  });
  registerCustomization({
    id: "memory.maxTopicCharacters",
    module: "memory",
    name: "How long a memory's topic may be",
    description:
      "The most characters a saved memory's topic line may hold; a longer topic is refused at save time. Higher = more descriptive topics at the cost of noisier search matches. Takes effect after a restart.",
    type: "number",
    default: REAL_STORE_DEFAULTS.maxTopicCharacters,
    min: 1,
    max: 8_192,
    unit: "characters",
    current: () => readNumberCustomization("memory.maxTopicCharacters", REAL_STORE_DEFAULTS.maxTopicCharacters),
    set: (v) => writeConfigCustomization("memory.maxTopicCharacters", v),
    contract: { effect: "restart" },
    configPath: "memory.maxTopicCharacters",
  });

  // --- Customizations: the server's capture-and-search limits (7) ---
  // The `memory` section's capture-and-search leaves. Unlike the ten above,
  // their consumers read the config file on each call (the harness-config
  // reader re-reads on every mtime change), so a change takes effect on the
  // very next search, tool result, or prompt build — `effect: "immediate"` is
  // the observed timing, not a promise. Two surfaces capture the value once
  // at process start (the tool manifest's advertised hint and the memory
  // panel's request-validation cap); the rows that touch them say so in their
  // own words. Each leaf was read by server code for years while the write
  // gate refused the path — a knob that could never be set; the schema now
  // declares every path a reader consumes, and the defaults below cite the
  // contract's own constants so the value exists in one place only.
  registerCustomization({
    id: "memory.searchResultLimit",
    module: "memory",
    name: "Results a memory search returns",
    description:
      "How many saved memories one search hands back when the caller does not name a count. Higher = broader recall per search at the cost of a longer answer. The fetch_memory tool's advertised hint text refreshes after a restart.",
    type: "number",
    default: resolveMemoryConfig({}).searchResultLimit,
    min: 1,
    max: 100_000,
    unit: "results",
    current: () => readNumberCustomization("memory.searchResultLimit", resolveMemoryConfig({}).searchResultLimit),
    set: (v) => writeConfigCustomization("memory.searchResultLimit", v),
    contract: { effect: "immediate" },
    configPath: "memory.searchResultLimit",
  });
  registerCustomization({
    id: "memory.searchMaxLimit",
    module: "memory",
    name: "Most results one memory search may return",
    description:
      "The ceiling any memory search clamps a requested result count to. Higher = a single search may return more at the cost of a heavier query; the memory panel's own request cap refreshes after a restart.",
    type: "number",
    default: DEFAULT_MEMORY_SEARCH_MAX_LIMIT,
    min: 1,
    max: 100_000,
    unit: "results",
    current: () => readNumberCustomization("memory.searchMaxLimit", DEFAULT_MEMORY_SEARCH_MAX_LIMIT),
    set: (v) => writeConfigCustomization("memory.searchMaxLimit", v),
    contract: { effect: "immediate" },
    configPath: "memory.searchMaxLimit",
  });
  registerCustomization({
    id: "memory.retrievalLimit",
    module: "memory",
    name: "Memories pulled into the conversation",
    description:
      "How many saved memories are fetched and offered to the model alongside a new message. Higher = richer recall at the cost of a more crowded prompt.",
    type: "number",
    default: DEFAULT_MEMORY_RETRIEVAL_LIMIT,
    min: 1,
    max: 1_000,
    unit: "memories",
    current: () => readNumberCustomization("memory.retrievalLimit", DEFAULT_MEMORY_RETRIEVAL_LIMIT),
    set: (v) => writeConfigCustomization("memory.retrievalLimit", v),
    contract: { effect: "immediate" },
    configPath: "memory.retrievalLimit",
  });
  registerCustomization({
    id: "memory.interactionContentMaxChars",
    module: "memory",
    name: "Largest saved chat turn",
    description:
      "The most characters a finished exchange (the message and its reply) may occupy when saved as a memory. Higher = fuller saved history at the cost of storage.",
    type: "number",
    default: DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS,
    min: 1,
    max: 10_485_760,
    unit: "characters",
    current: () => readNumberCustomization("memory.interactionContentMaxChars", DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS),
    set: (v) => writeConfigCustomization("memory.interactionContentMaxChars", v),
    contract: { effect: "immediate" },
    configPath: "memory.interactionContentMaxChars",
  });
  registerCustomization({
    id: "memory.toolResultContentMaxChars",
    module: "memory",
    name: "Largest saved tool result",
    description:
      "The most characters of a successful tool's output kept when the harness saves it as a memory. Higher = fuller saved tool history at the cost of storage.",
    type: "number",
    default: DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS,
    min: 1,
    max: 10_485_760,
    unit: "characters",
    current: () => readNumberCustomization("memory.toolResultContentMaxChars", DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS),
    set: (v) => writeConfigCustomization("memory.toolResultContentMaxChars", v),
    contract: { effect: "immediate" },
    configPath: "memory.toolResultContentMaxChars",
  });
  registerCustomization({
    id: "memory.toolResultArgsMaxChars",
    module: "memory",
    name: "Largest saved tool request",
    description:
      "The most characters of a tool's request kept beside its saved result so the model can recall what was asked. Higher = more context per saved memory at the cost of storage.",
    type: "number",
    default: DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS,
    min: 1,
    max: 1_048_576,
    unit: "characters",
    current: () => readNumberCustomization("memory.toolResultArgsMaxChars", DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS),
    set: (v) => writeConfigCustomization("memory.toolResultArgsMaxChars", v),
    contract: { effect: "immediate" },
    configPath: "memory.toolResultArgsMaxChars",
  });
  registerCustomization({
    id: "memory.previewMaxChars",
    module: "memory",
    name: "Recalled memory preview length",
    description:
      "How much of each recalled memory is shown to the model in the recalled-context section. Higher = fuller previews at the cost of a more crowded prompt.",
    type: "number",
    default: DEFAULT_MEMORY_PREVIEW_MAX_CHARS,
    min: 1,
    max: 1_048_576,
    unit: "characters",
    current: () => readNumberCustomization("memory.previewMaxChars", DEFAULT_MEMORY_PREVIEW_MAX_CHARS),
    set: (v) => writeConfigCustomization("memory.previewMaxChars", v),
    contract: { effect: "immediate" },
    configPath: "memory.previewMaxChars",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetMemoryRegistration(): void {
  memoryRegistered = false;
}
