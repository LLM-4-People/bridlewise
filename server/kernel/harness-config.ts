/**
 * Centralized harness-config reader — the ONE owner of `bridlewise.config.json`
 * access for the web UI.
 *
 * Before this module, `tool-executor.ts` kept a hardcoded `ALLOWED_COMMANDS` Set
 * and `mcp-bridge.ts` read the WRONG config path
 * (`mcp.servers` instead of the actual `tools.mcpServers` — so MCP servers were
 * silently empty). Both now route through this single reader so the harness
 * config is the sole source of truth and every consumer sees the same bytes.
 *
 * Every accessor answers from ONE resolved snapshot (see "THE RESOLVED
 * SNAPSHOT" below), refreshed at request start and by the server's own writes
 * — never by a per-call read. The document goes through the engine's ONE
 * config read/refusal API (`inspectConfigDocument` / `inspectConfigDocumentBytes`):
 * an ABSENT file is the documented empty result; a file that exists but cannot
 * be read or decoded keeps the last good snapshot in force, is reported as the
 * state `unreadable`, and refuses every write and raw read with the typed
 * `config_unreadable` (503) — never an empty document or a default.
 *
 * @config-owner
 */

import { existsSync, lstatSync, watch, type FSWatcher } from "node:fs";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import { basename, dirname } from "node:path";
import { atomicWriteFile, atomicWriteTargetOf } from "../../engine/src/filesystem/atomic-write.ts";
import { serverConfig, debugEnabled } from "./config.ts";
import { webConsoleError, webConsoleInfo } from "../observability/debug-bridge.ts";
import { registerComponent } from "../observability/component-registry.ts";
import { readFileText, fileTextBytesEqual, type FileTextSnapshot } from "../filesystem/file-read.ts";
// The config file's cross-process write lock: parallel processes (test
// forks, the dev servers, engine CLI invocations) write this one file, so
// every write path here holds the lock for its whole read-modify-write
// cycle — the atomic rename alone cannot stop two writers interleaving
// their cycles around each other.
import { withConfigWriteLock } from "../../engine/src/kernel/config-write-lock.ts";
import { resolveResponsesTransportConfig, type ResponsesTransportConfig, guarded, ROOT_POLICY } from "./canonical.ts";
// The harness's own declaration of the config document — the vocabulary of
// legal config paths and value domains. `writeConfigRaw` validates every
// candidate document against it (deny-by-default write gate), so the set of
// writable paths is DERIVED from the contract instead of restated as a list.
import { hasSecondName, canonicalJson, inspectConfigDocument, inspectConfigDocumentBytes, getConfigDocumentSchema, MCP_CONFIG_SCHEMA, resolveSelfProtectionConfig, resolveMemoryConfig } from "./canonical.ts";
// The privacy policy's config door: the resolver (which refuses a section
// that would weaken redaction, fail-closed) + the constructor + the types,
// all reached through the hub like every other harness import.
import type { SettingsStoreState } from "./canonical.ts";
import {
  createPrivacyPolicy,
  resolvePrivacyPolicyOptions,
  resolveDebugConfigSection,
  type ConfigDocument,
  type DebugConfig,
  type PrivacyPolicy,
} from "./canonical.ts";
import { DEFAULT_CAPTURE_PROVIDER_PAYLOADS } from "./canonical.ts";
// The memory section's capture-and-search defaults — owned by the engine's
// config contract (beside the schema that declares the leaves), applied here
// (never restated) when the document omits a leaf.
import {
  DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS,
  DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS,
  DEFAULT_MEMORY_PREVIEW_MAX_CHARS,
  DEFAULT_MEMORY_SEARCH_MAX_LIMIT,
  DEFAULT_MEMORY_RETRIEVAL_LIMIT,
  DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS,
} from "./canonical.ts";
// The redaction section's memo-bound default — owned by the engine's config
// contract (beside the schema that declares the leaf), applied here (never
// restated) when the document omits it.
import { DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES } from "./canonical.ts";
// The performance section's resource knobs — defaults owned by the engine's
// performance config contract, applied here (never restated).
import {
  DEFAULT_PERFORMANCE_CONFIG,
  performanceConfigOf,
  DEFAULT_RESOURCE_DELTAS_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
} from "./canonical.ts";
import type { SelfProtectionConfig } from "./canonical.ts";
import type { z } from "zod";
import { ConfigError, ValidationError } from "./errors.ts";

// SPO: ToolKind is now owned by `shared/web-ui-types.ts` (a pure file
// the server can import via NodeNext — no @harness/* path aliases). Both the
// server + the client import the ONE definition (no drift). Re-exported here
// so existing `import { type ToolKind } from "./harness-config.ts"` paths are
// unchanged.
import { TOOL_KINDS, type ToolKind } from "../../shared/web-ui-types.ts";
import { memberOf } from "./canonical.ts";
export type { ToolKind };

// SPO: GraphConfig + MetricsConfig are owned by `shared/wire-types.ts`
// (single wire-shape owner — the redacted config snapshot shape served via
// GET /api/config). Re-exported here so existing
// `import { type GraphConfig } from "./harness-config.ts"` paths are
// unchanged. The DEFAULT_* fallback consts + the read functions stay here
// (server reads the config file); only the TYPE is consolidated.
import type { GraphConfig, McpTransportId, MetricsConfig, PerformanceBudgetConfig } from "../../shared/wire-types.ts";
// The web-UI tunable DEFAULTS + their readers + the numeric coercers are
// declared ONCE in `shared/web-ui-defaults.ts` and imported by BOTH the
// server (here) and the client (`src/state/web-ui-config.ts`). They used to
// exist as byte-identical copies on each side.
import {
  asPositiveInt,
  asPositiveNumber,
  readGraphConfig,
  readMetricsConfig,
  DEFAULT_ARTIFACT_SANDBOX,
} from "../../shared/web-ui-defaults.ts";
import {
  DEFAULT_FARM_INIT_TIMEOUT_MS,
  DEFAULT_FARM_MAX_INIT_FAILURES,
  DEFAULT_FARM_PER_FILE_TIMEOUT_MS,
} from "../../engine/src/intelligence/intelligence-config.ts";
export type { GraphConfig, MetricsConfig, PerformanceBudgetConfig };

// ── Config shape (only the sections the web UI reads) ──
// McpServerEntry matches the canonical type (transport is a union, not a
// bare string) so the mcp-bridge can pass it to validateMcpServerEntry
// without a type error.

// The transport union (not a bare string) so a resolved entry flows into
// `resolveMcpServerConfigs` (the engine's canonical resolver) without a
// narrowing cast — the config schema already constrains the value to one of
// these, so the type asserts what the schema guarantees.
type McpTransportName = McpTransportId;

type McpServerAuth = Readonly<{
  type: "api-key" | "bearer" | "oauth";
  token: string;
  header?: string;
  envName?: string;
}>;

type McpServerEntry = Readonly<{
  id: string;
  transport: McpTransportName;
  enabled?: boolean;
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  readPaths?: readonly string[];
  url?: string;
  headers?: Readonly<Record<string, string>>;
  subprotocol?: string;
  retry?: Readonly<{ count: number; backoffMs: number }>;
  auth?: McpServerAuth;
  protocolVersion?: string;
  timeoutMs?: number;
}>;

type AgentsConfigSection = Readonly<{
  maximumConcurrentAgents?: number;
  profiles?: readonly Readonly<Record<string, unknown>>[];
  orchestration?: Readonly<Record<string, unknown>>;
}>;

type HarnessConfigShape = Readonly<{
  tools?: Readonly<{
    allowedCommands?: readonly string[];
    mcpServers?: readonly McpServerEntry[];
    enabled?: readonly string[];
    defaultBounds?: Readonly<{ timeoutMs: number; maxOutputBytes: number; maxMemoryBytes: number }>;
    /** The declared read/list ceilings (`tools.limits`), shared with the engine's own tools. */
    limits?: Readonly<{ maxReadBytes?: number; maxListEntries?: number }>;
    searchMaxDepth?: number;
    searchMaxResults?: number;
    /** Matches `search_code` keeps counting after it has collected everything
     *  it will show, so a truncated answer can report its own true total. */
    searchMaxScannedMatches?: number;
    /** Deadline after which a running `search_code` worker is terminated. */
    searchTimeoutMs?: number;
    /** Max characters of a matching line the `search_code` tool includes
     * in each result (the LLM-facing line preview). Was a hardcoded
     * `slice(0, 200)` in tool-executor.ts. */
    searchLinePreviewMaxChars?: number;
    /** Max dependency cycles the `get_dependency_graph` LLM tool includes
     * in its JSON output (the LLM tool result, separate from the UI's
     * `webUi.graph.maxCyclesDisplayed`). Was a hardcoded
     * `cycles.slice(0, 10)` in tool-executor.ts. */
    dependencyGraphMaxCycles?: number;
    /** Number of modules the `get_repository_map` LLM tool includes in its
     *  JSON `moduleSample` (the preview the LLM reads, not the full map). 
     *  Was a hardcoded `slice(0, 20)` in tool-executor.ts. */
    repositoryMapSampleCount?: number;
    /** configurable adapterId → kind mapping (override for the
     * default mapping in DEFAULT_TOOL_KIND_MAP). Keys are adapterIds,
     * values are ToolKind strings. */
    kinds?: Readonly<Record<string, string>>;
    /** auto-check (typecheck/lint) runner tunables. */
    autoCheck?: Readonly<{ maxCaptureBytes?: number }>;
    /** MCP module-wide defaults (applied to every `mcpServers` entry unless
     * the entry overrides them). Read by `getMcpDefaults`. The type is the
     * section schema's own output — a knob added to `tools.mcp` widens this
     * field through the schema, so no hand-maintained property list exists
     * here to drift. */
    mcp?: McpDefaults;
  }>;
  runtime?: Readonly<{
    responses?: NonNullable<ConfigDocument["runtime"]>["responses"];
    limits?: Readonly<{ maximumToolIterations?: number }>;
    defaultModel?: string;
    userPreferences?: Readonly<{
      tone?: "concise" | "detailed" | "friendly";
      emoji?: boolean;
      icons?: boolean;
      sentenceCase?: "normal" | "title" | "upper";
    }>;
    agents?: Readonly<AgentsConfigSection>;
  }>;
  agents?: Readonly<AgentsConfigSection>;
  memory?: Readonly<Record<string, unknown>>;
  extensions?: readonly Readonly<{
    name: string;
    type: string;
    version: string;
    description?: string;
    enabled?: boolean;
  }>[];
  /** code intelligence auto-index config. */
  codeIntelligence?: Readonly<{
    autoIndexOnProjectAdd?: boolean;
    /** Watch an indexed project's folder so disk edits refresh the map. */
    watchIndexedProjects?: boolean;
    /** Coalesce folder-watch events before starting another map pass. */
    indexWatchDebounceMs?: number;
    /** Frontend poll interval (ms) while the map is indexing in the
     * background worker. */
    indexPollMs?: number;
    /** Frontend total timeout (ms) before giving up on indexing. */
    indexTimeoutMs?: number;
    /** Server-side per-project map cache TTL (ms). */
    mapCacheTtlMs?: number;
    /** Quick-view index cache TTL (ms) — the per-project quick-view
     * (AST-based file lookup) cache lifetime. Previously an inline
     * constant (60_000) in intelligence-bridge; centralized here. */
    quickViewCacheTtlMs?: number;
    /** Default + max result limits for `search_code` / `find_reuse` (the
     * intelligence symbol/reuse search). Previously hardcoded `50` (default)
     * + `500` (max) scattered across intelligence-bridge.ts, the route,
     * and the tool-executor — the SAME value in three sites.
     * Owned here so the bridge default + the route clamp + the LLM-tool
     * fallback all read ONE source of truth. */
    searchDefaultLimit?: number;
    searchMaxLimit?: number;
    /** Default + max result limits for `retrieve_relevant_files` (EXP474
     * codebase-file retrieval). Previously hardcoded `15` (default) + `100`
     * (max) in the route. Owned here. */
    retrieveDefaultLimit?: number;
    retrieveMaxLimit?: number;
    /** Number of languages the repository-map prompt injection lists in the
     *  `<lang>=<count>` preview (the rest are omitted). Was a hardcoded
     *  `slice(0, 6)` in intelligence-bridge.ts. */
    repoMapLanguagePreview?: number;
    /** Crash-isolated extract farm watchdogs. Passed into
     * `generateRepositoryMapIsolated` so a settings change reaches the
     * next map build. */
    farm?: Readonly<{
      perFileTimeoutMs?: number;
      initTimeoutMs?: number;
      maxInitFailures?: number;
    }>;
    /** EXP474 codebase-file retrieval ranking knobs (phrase n-gram + slot
     * allocation + package/directory co-occurrence). The floors in
     * `getExp474RetrievalConfig` are the single owner of the defaults. */
    retrieval?: Readonly<Record<string, number>>;
    /** Auto-heal config — automatic stale-index detection + rebuild and
     * broken dependency-edge flagging. Every floor below is the
     * single owner of its default, overridable from the config file. */
    autoHeal?: Readonly<{
      /** Master switch. When false, stale-index detection is skipped (the
       * TTL-only cache behavior is restored). Broken-edge detection is
       * always available (it is a pure function over the map). */
      enabled?: boolean;
      /** File count at/below which the mtime sample covers EVERY source
       * file (full coverage; small codebases are cheap to stat fully). */
      staleFullCoverageThreshold?: number;
      /** Floor for the adaptive (sqrt-scaled) sample size on large
       * codebases. */
      staleSampleFloor?: number;
      /** Ceiling for the adaptive sample size (caps per-read stat cost on
       * very large codebases). */
      staleSampleCeiling?: number;
    }>;
  }>;
  /** Interactive chat artifacts: LLM-created apps/games/sheets/
   * presentations rendered live in a sandboxed iframe. `maxBytes` bounds
   * the artifact content; `iframeSandbox` is the sandbox attribute token
   * the frontend applies to the rendering iframe (security: ). */
  artifacts?: Readonly<{ maxBytes?: number; iframeSandbox?: string; idLength?: number }>;
  /** Redaction-adapter tuning (server/redaction.ts). The memo bound caps
   * how many distinct tool_calls argument payloads the redaction owner keeps
   * memoised (content-addressed, LRU-evicted). */
  redaction?: Readonly<{ toolCallArgumentsCacheEntries?: number }>;
  /** The privacy policy's config section — typed as the engine contract's
   * own projection (the section schema's output), never a hand-mirrored
   * shape, so a leaf added to the contract widens this field with no edit
   * here. Consumed by `getPrivacyPolicy()` — the masker's policy door. */
  privacy?: ConfigDocument["privacy"];
  /** The debug system's config section — the same contract-projection
   * discipline as `privacy` above. Consumed by
   * `resolveWebDebugBootstrap()` — the debug bootstrap's one resolver. */
  debug?: ConfigDocument["debug"];
  /** Web-UI tunables: dependency-graph force layout + metrics polling.
   * (`webUi.promptGenerator` is a purely-frontend option catalog read from
   * the redacted config snapshot via src/state/web-ui-config.ts; no server
   * accessor is needed, so it is intentionally NOT typed here to avoid
   * duplicating the client-side coerce logic.) */
  webUi?: Readonly<{
    graph?: Readonly<{
      maxNodes?: number;
      repulsion?: number;
      springLength?: number;
      springStrength?: number;
      centering?: number;
      damping?: number;
      iterations?: number;
      maxNodeRadius?: number;
      minNodeRadius?: number;
      nodeSpacing?: number;
      minSeparation?: number;
      labelMinNodeScreenPx?: number;
      labelTopDegreeCount?: number;
      labelGapPx?: number;
      labelPaddingPx?: number;
      minZoom?: number;
      maxZoom?: number;
      minCanvasPx?: number;
      maxFitScale?: number;
      fitMarginPx?: number;
      fallbackWidth?: number;
      fallbackHeight?: number;
      // ── Rendering + interaction tunables (SPO: graph rendering owner).
      // These are user-facing display/interaction knobs that MUST be
      // config-driven, not inline magic numbers in the
      // DependencyGraph component. The frontend reads them from the same
      // config snapshot via src/state/web-ui-config.ts (one source, two
      // projections — the harness-config-webui contract test asserts no
      // drift). See DependencyGraph.svelte for the consumer of each key.
      labelFontPx?: number;
      labelShowAllZoom?: number;
      hitPaddingPx?: number;
      wheelZoomFactor?: number;
      buttonZoomIn?: number;
      buttonZoomOut?: number;
      indexingPollMs?: number;
      maxCyclesDisplayed?: number;
    }>;
    metrics?: Readonly<{ pollMs?: number; historyMax?: number }>;
    /** quality scoring weights — the awareness-derived quality
     * score starts at `scoreMax` and subtracts bounded penalties for each
     * signal. Every weight below is the single owner of its default; the
     * quality bridge reads them through `getQualityConfig`. */
    quality?: Readonly<{
      scoreMax?: number;
      scoreMin?: number;
      penaltyCapIssuesPerKloc?: number;
      penaltyCapHotspots?: number;
      penaltyCapClones?: number;
      penaltyCapUntyped?: number;
      penaltyCapIssueDensity?: number;
      penaltyWeightIssuesPerKloc?: number;
      penaltyWeightHotspots?: number;
      penaltyWeightClones?: number;
      penaltyWeightUntyped?: number;
      penaltyWeightIssueDensity?: number;
      /** Number of top issue categories the quality recommendations list (the
       *  rest are omitted). Was a hardcoded `slice(0, 3)` in
       *  quality-bridge.ts. */
      topCategoriesCount?: number;
      /** Declared lint-gate thresholds over the MEASURED sub-metrics
       * (issues/KLOC, complexity hotspots, clone ratio, typed-file
       * fraction). The lint auto-check verdicts against these — never
       * against the composite score, which is a configured index. Declared
       * in the harness config schema (`webUi.quality.lintGate`). */
      lintGate?: Readonly<{
        maxIssuesPerKloc?: number;
        maxComplexityHotspots?: number;
        maxCloneRatio?: number;
        minTypedFileFraction?: number;
      }>;
    }>;
    /** self-improving analyzer thresholds. The Metrics dashboard
     * reads harness performance (response times, error rates, tool success
     * rates — already tracked by the canonical metrics collector) and
     * surfaces typed improvement suggestions. Every threshold below is
     * the single owner of its default; the analyzer reads them through
     * `getSelfImprovingConfig`. */
    selfImproving?: Readonly<{
      /** Minimum call count before a function is analyzed (below this the
       * sample is too small to be statistically meaningful). */
      minSampleCount?: number;
      /** Error rate (errorCount/callCount) at/above which a function is
       * flagged as failing (0–1). */
      errorRateThreshold?: number;
      /** Average duration (ms) at/above which a TOOL call is flagged slow. */
      slowToolMsThreshold?: number;
      /** Average duration (ms) at/above which an LLM call is flagged slow. */
      slowLlmMsThreshold?: number;
      /** Max suggestions returned per snapshot (bounds the payload). */
      maxSuggestions?: number;
    }>;
    /** Web-UI performance budget. The regression test reads these thresholds
     * via `getPerformanceBudgetConfig` and fails if a measured metric in the
     * Playwright profile report degrades past its budget. Every field is the
     * single default owner. See `shared/wire-types.ts`
     * `PerformanceBudgetConfig` for the full shape. */
    performance?: Readonly<Partial<PerformanceBudgetConfig>>;
    /** The prompt composer's option catalogs (`webUi.promptGenerator`); the
     * system prompt reads its TONE instructions from `tones` — one source
     * for that text (prompt-registry F-PR-3). */
    promptGenerator?: Readonly<{ tones?: readonly Readonly<{ id?: unknown; instruction?: unknown }>[] }>;
  }>;
  /** SPO: pre-dispatch hallucination/safety gate config.
   * The safety gate checks every LLM tool call BEFORE it reaches the
   * executor: ghost-tool detection, JSON-schema validation, loop detection.
   * Every field below is the single owner of its default; the safety
   * bridge reads them through `getSafetyGateConfig`. The defaults mirror the canonical gate's
   * `DEFAULT_TOOL_CALL_GATE_CONFIG` (resolved via `resolveToolCallGateConfig`). */
  safety?: Readonly<{
    toolCallGate?: Readonly<{
      /** Block calls to tool names not in the registry. */
      enableGhostToolDetection?: boolean;
      /** Validate call arguments against the tool's `parameters` JSON Schema. */
      enableSchemaValidation?: boolean;
      /** Block repeated identical (name + arguments) calls beyond a threshold. */
      enableLoopDetection?: boolean;
      /** Retain valid fields of a schema-failing call and merge the next delta. */
      enablePartialArgumentMemory?: boolean;
      /** Max retained per-tool partials held at once. */
      partialArgumentsLimit?: number;
      /** Max identical (name + arguments) calls within `loopWindow` before the
       * next identical call is blocked as a loop. */
      maxRepeatCount?: number;
      /** Sliding-window size (number of recent accepted calls) the loop
       * detector inspects. */
      loopWindow?: number;
      /** Consecutive identical BLOCKED calls (same tool + same block verdict)
       * after which the refusal message escalates to name the repetition.
       * Default 3: the first block teaches, the second warns, the third is the
       * pattern a watching human would intervene on — measured incident:
       * six identical gate-blocked calls with nothing escalating, each
       * burning a full turn's completion tokens. */
      blockEscalationAfter?: number;
      /** Consecutive identical BLOCKED calls at which the tool is auto-tripped
       * for the rest of the run (the breaker owner's row flips, the panel
       * shows the trip, the user can re-arm). Default 6 = 2× the escalation
       * default; 0 disables the auto-trip. */
      blockAutoTripAfter?: number;
    }>;
    /** Event-feed safety detector overrides (workaround, bandaid, step-skip,
     * deviation). The RAW value is handed to the engine's own validated
     * resolver (`resolveBandaidConfig`) by `getEventFeedSafetyConfig` — the
     * shape, its defaults and its cross-field rules all belong to the engine,
     * so a malformed section throws rather than silently disabling a detector. */
    eventFeed?: unknown;
  }>;
  /** Worker-thread pool tunables (Worker Thread Management
   * Owner). Applies to ALL backend `node:worker_threads` workers
   * (repository-map, quick-view, awareness). The pool
   * (`server/worker-pool.ts`) reads these through the single accessors
   * below. */
  workerThreads?: Readonly<{
    /** Per-task timeout (ms). A worker that doesn't post a result within
     * this window is terminated + the promise rejects with the caller's
     * typed error. Prevents the "worker-hang → permanent 'not ready'"
     * bug (a hung worker previously left the pending cache entry
     * forever). Default 120 000 (2 min — a large-codebase build can take
     * tens of seconds). A non-positive value disables the timeout. */
    timeoutMs?: number;
    /** Max concurrent worker threads. When at capacity, a NEW spawn (a
     * dedup hit already shares the in-flight worker) rejects with the
     * caller's typed error so the bridge can degrade. Bounds resource
     * use (file descriptors, memory) on a multi-project server.
     * Default 8. */
    maxConcurrent?: number;
  }>;
  /** Self-protection (the Landlock guardian). Read through
   * `getSelfProtectionConfig()` below, which hands the raw value to the
   * harness's own resolver rather than picking fields out of it here — the
   * shape, its defaults and its cross-field rules all belong to the harness. */
  selfProtection?: unknown;
  /** The performance section's resource-observability knobs (`performance`
   * in `bridlewise.config.json`). Only the fields the web server consumes
   * are picked out here; the full schema and its defaults belong to the
   * engine's performance config contract. Read through the accessors below. */
  performance?: Readonly<{
    resourceDeltas?: Readonly<{ enabled?: boolean }>;
    resourceSampler?: Readonly<{ enabled?: boolean; intervalMs?: number }>;
    /** Which diagnostic modes the diagnostic command skips. The vocabulary
     * (the legal member names) belongs to the engine's performance contract
     * (`DIAGNOSTIC_MODE_IDS`); this field only records what the file says.
     * Read through `performanceDiagnosticExcludedModes()` below. */
    diagnosticModes?: Readonly<{ excludedModes?: readonly string[] }>;
  }>;
  /** The ledger's operational section (`timeline` in
   * `bridlewise.config.json`). Read through `getTimelineConfig()` below and
   * handed to the timeline store mostly verbatim — the store owns its own
   * defaults, so an absent field falls through to the engine's declared
   * default rather than being restated here. */
  timeline?: Readonly<{
    maxDocumentBytes?: number;
    maxDocuments?: number;
    maxEdges?: number;
    dbFilename?: string;
    sqliteCacheSize?: number;
    sqliteBusyTimeoutMs?: number;
    queryDefaultLimit?: number;
    /** Whether provider-interaction payload capture is on. The declared
     * default lives in the config contract (`DEFAULT_CAPTURE_PROVIDER_PAYLOADS`)
     * and is applied by `captureProviderPayloadsEnabled()` — never here. */
    captureProviderPayloads?: boolean;
  }>;
}>;

// ── THE RESOLVED SNAPSHOT (one frozen parse bound to its path and source text) ──
//
// Every accessor below answers from this snapshot and NEVER touches the file:
// a per-call read put the document on every request's and every timer's path,
// so a file that went bad while the server ran threw out of an SSE beat (a
// crash) and out of the error mapper itself (every request hung). The
// snapshot is refreshed at the points where a change can matter:
//   - the server's own writes swap it synchronously (the write gate, restore);
//   - `refreshSettingsSnapshot()` re-reads the text (bytes compared first, so
//     an unchanged file costs no parse) — the router calls it once at the
//     start of every request, the boot preflight calls it before anything
//     else reads a setting;
//   - the first access for a path loads it (a test or tool that repoints
//     `HARNESS_CONFIG_PATH`).
//   - a watch on the store's folder refreshes it when the file changes, and
//     every run refreshes it at its start, so a tightened setting reaches
//     background work (a run between requests) without waiting for a request.
// A refresh that finds the store UNREADABLE — or REMOVED after a good file
// was read (an editor's delete-then-create, a checkout of the tracked file) —
// keeps the LAST GOOD snapshot in force (never `{}`, never the defaults: what
// was confined stays confined), records the state `unreadable` (logged,
// published as `settings.storeState`) and every save refuses (`readConfigRaw`
// reads the file itself). A document that decodes but fails a POSTURE door
// (the privacy section every egress redaction resolves: a hand edit that
// weakens it would refuse every response) is kept out the same way, with the
// state `refused`. Only a path that has NO good snapshot yet refuses an
// accessor — the boot case, which the preflight turns into a typed exit.

type ResolvedSnapshot = Readonly<{
  path: string;
  /** The text the value was decoded from; `undefined` for an absent store. */
  source: FileTextSnapshot | undefined;
  value: HarnessConfigShape;
}>;

let snapshot: ResolvedSnapshot | undefined;

/**
 * A WORKER ISOLATE READS NO SETTINGS FILE (wf1c-design M-6, WF-1b item 1):
 * the thread that spawns it HANDS it the snapshot in force. The main thread
 * publishes every snapshot it resolves as worker environment data (node
 * clones it into each Worker created afterwards — every spawner, pooled or
 * not, with no per-worker plumbing); a worker's refresh adopts what it was
 * handed and never touches the file. So a worker cannot read a half-saved or
 * hand-corrupted file the main thread is refusing, and cannot disagree with
 * the snapshot the main thread serves. A worker handed nothing (spawned
 * before any snapshot existed) refuses a setting read `config_unreadable`.
 */
const WORKER_SETTINGS_KEY = "bridlewise.harnessSettings";
type HandedSettings = Readonly<{ path: string; document: HarnessConfigShape }>;

function useSnapshot(next: ResolvedSnapshot): void {
  snapshot = next;
  if (isMainThread) setEnvironmentData(WORKER_SETTINGS_KEY, { path: next.path, document: next.value } satisfies HandedSettings);
}

/** A worker's refresh: adopt the handed snapshot, never read the file. */
function adoptHandedSettings(configPath: string): SettingsStoreState {
  const handed = getEnvironmentData(WORKER_SETTINGS_KEY) as HandedSettings | undefined;
  if (handed === undefined || handed.path !== configPath) {
    return noteStoreState({ state: "unreadable", path: configPath, reason: "worker_settings_not_handed: a worker isolate reads no settings file, and the thread that spawned it handed over none for this path" });
  }
  if (snapshot?.path !== configPath) snapshot = { path: configPath, source: undefined, value: deepFreezeConfig(handed.document) };
  return noteStoreState({ state: "ok", path: configPath });
}

const ABSENT_DOCUMENT: HarnessConfigShape = Object.freeze({});

/**
 * Recursively freeze a config object so the cached parse is read-only. A
 * caller that tries to mutate a cached field gets a TypeError in strict
 * mode (and a silent no-op in sloppy mode) — either way the shared cache
 * is never corrupted for other consumers. Write paths use `readConfigRaw`
 * (a fresh mutable parse) instead of the cache.
 */
function deepFreezeConfig<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeConfig(item);
  } else {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreezeConfig(v);
  }
  return Object.freeze(value);
}

/**
 * THE SERVER'S ONE CONFIG REFUSAL. The store exists but cannot be read or
 * decoded (the engine reader's typed code is carried in the message): every
 * raw read and every write refuses with `config_unreadable` (503), and so
 * does an accessor on a path with no good snapshot yet — never an empty
 * document. An empty answer here is what turned a corrupt file into
 * "self-protection absent, write accepted" (the gate compared the candidate
 * with `{}`), and what let every typed accessor quietly run on defaults.
 */
function configUnreadable(configPath: string, reason: string): ConfigError {
  // A ConfigError, NOT a ServiceUnavailableError: that class is retryable,
  // and retrying cannot fix a file on disk. 503 comes from the shared code
  // table (`config_unreadable`), the sentence the user reads from the
  // client's projection of it.
  return new ConfigError(
    "The harness settings file could not be read, so no change can be saved. "
    + "The setting that confines the model's commands to your project is stored there, and this server cannot tell what it currently says. "
    + `Check the file at ${configPath}. (${reason})`,
    CONFIG_UNREADABLE_CODE,
  );
}

export const CONFIG_UNREADABLE_CODE = "config_unreadable";

/**
 * THE STORE'S STATE — a refusal is a STATE this server reports, not only an
 * exception a caller may or may not see. Recorded by every refresh and every
 * raw read: `absent`, `ok`, or `unreadable` (with its reason). A transition
 * INTO `unreadable` is logged ONCE through the always-on console sink — not
 * the debug system, whose configuration lives in this same unreadable file —
 * and the recovery is logged too. Published as the `settings.storeState`
 * signal.
 */
export type { SettingsStoreState };

let storeState: SettingsStoreState | undefined;

function noteStoreState(next: SettingsStoreState): SettingsStoreState {
  const previous = storeState;
  storeState = next;
  if (previous !== undefined && previous.state === next.state && previous.path === next.path && previous.reason === next.reason) return next;
  // EVERY transition is logged (always-on), the first answer included: a
  // store that went absent, came back or was refused is an operator-visible
  // fact, never only a signal nobody polls.
  if (next.state === "unreadable" || next.state === "refused") {
    const serving = snapshot?.path === next.path ? "the last readable settings stay in force" : "no setting can be read";
    const saves = next.state === "unreadable" ? " and every settings save is refused" : "";
    webConsoleError(`[bridlewise web] ${CONFIG_UNREADABLE_CODE}: the settings file ${next.path} is ${next.state} (${next.reason ?? "unknown"}); ${serving}${saves} until it is fixed`);
  } else if (previous !== undefined) {
    webConsoleInfo(`[bridlewise web] the settings file ${next.path} is ${next.state} (was ${previous.state})`);
  }
  return next;
}

/** Why a store that WAS read no longer exists: kept as unreadable, never the defaults. */
const STORE_REMOVED_REASON = "config_document_removed: the settings file was removed after it was read; the last readable settings stay in force until it is restored";

/** A snapshot that came from a real document (not the absent store's empty one). */
function hasDocumentSnapshot(configPath: string): boolean {
  return snapshot?.path === configPath && snapshot.value !== ABSENT_DOCUMENT;
}

/**
 * THE POSTURE DOORS a decodable document must pass before it becomes the
 * snapshot — ONE declared list, one door per SECURITY section (wf1b2-design
 * S-1: only privacy had one, so a hand edit that disarmed the tool-call gate
 * or an event-feed detector left the store `ok` while every run refused).
 * Each door is EXACTLY the check the section's accessor runs (the policy
 * birth, the section floor), so a document either passes all of them or the
 * store is `refused` with the section named, the last good snapshot in force
 * and no request answering 503 for it:
 *
 * - `privacy`: the masker's policy birth (every egress redaction resolves it);
 * - `safety.toolCallGate`: the gate's posture floor (its three checks on);
 * - `safety.eventFeed`: the detectors' posture floor (no family disarmed);
 * - `debug`: the debug section's safety floor (its redactor on).
 */
const POSTURE_DOORS: ReadonlyArray<Readonly<{ section: string; of: (document: HarnessConfigShape) => unknown; admit: (section: unknown) => void }>> = Object.freeze([
  {
    section: "privacy",
    of: (document) => (document as { privacy?: unknown }).privacy,
    // A partial section is legal (its defaults fill the rest): the policy is built once here.
    admit: (privacy) => { createPrivacyPolicy(resolvePrivacyPolicyOptions(privacy as Parameters<typeof resolvePrivacyPolicyOptions>[0])); },
  },
  { section: "safety.toolCallGate", of: (document) => document.safety?.toolCallGate, admit: (gate) => { assertSafetyGatePosture(gate); } },
  { section: "safety.eventFeed", of: (document) => document.safety?.eventFeed, admit: (feed) => { assertSafetyEventFeedPosture(feed); } },
  { section: "debug", of: (document) => document.debug, admit: (debug) => { resolveDebugConfigSection(debug as Parameters<typeof resolveDebugConfigSection>[0]); } },
]);

/** The declared posture doors' sections, in order (the settings exposure and the tests read them). */
export const POSTURE_DOOR_SECTIONS: readonly string[] = Object.freeze(POSTURE_DOORS.map((door) => door.section));

function postureRefusal(document: HarnessConfigShape): string | undefined {
  for (const door of POSTURE_DOORS) {
    const section = door.of(document);
    if (section === undefined) continue;
    try {
      door.admit(section);
    } catch (refusal) {
      return `${door.section.replaceAll(".", "_")}_section_refused: ${refusal instanceof Error ? refusal.message : String(refusal)}`;
    }
  }
  return undefined;
}

/** The text last refused (decode or posture), so an unchanged refused file is not decoded again per request. */
let refusedText: Readonly<{ path: string; text: string; state: SettingsStoreState }> | undefined;

/** Adopts a decoded document unless a posture door refuses it (the last good stays in force). */
function adoptDocument(configPath: string, source: FileTextSnapshot | undefined, document: HarnessConfigShape): SettingsStoreState {
  const refusal = postureRefusal(document);
  if (refusal !== undefined) {
    const state = noteStoreState({ state: "refused", path: configPath, reason: refusal });
    if (source !== undefined) refusedText = { path: configPath, text: source.text, state };
    return state;
  }
  useSnapshot({ path: configPath, source, value: deepFreezeConfig(document) });
  return noteStoreState({ state: "ok", path: configPath });
}

function inspectionReason(inspection: Readonly<{ code: string; message: string }>): string {
  return `${inspection.code}: ${inspection.message}`;
}

/**
 * RE-RESOLVE the snapshot from the store's current text. NEVER throws: the
 * answer is the store's state. Unchanged text keeps the frozen value (no
 * parse, no rebuild of derived policies); a changed, decodable text swaps it;
 * an absent store resolves to the empty document (every accessor answers its
 * documented default); an unreadable store keeps the last good snapshot.
 */
export function refreshSettingsSnapshot(): SettingsStoreState {
  const configPath = serverConfig.harnessConfigPath;
  if (!isMainThread) return adoptHandedSettings(configPath);
  const previous = snapshot?.path === configPath ? snapshot : undefined;
  let raw: FileTextSnapshot;
  try {
    // Even inode/size/mtimeNs/ctimeNs can all survive a rapid same-size
    // in-place edit. Actual text is the change authority; the read owner
    // compares bytes before anything decodes.
    raw = readFileText(configPath, { previous: previous?.source });
  } catch {
    // The read failed: the one owner decides absent versus refused — this
    // module never guesses from an errno.
    const inspection = inspectConfigDocument(configPath);
    if (inspection.state === "unreadable") return noteStoreState({ state: "unreadable", path: configPath, reason: inspectionReason(inspection) });
    if (inspection.state === "absent") {
      // REMOVED after a good document was read: the last good stays in force
      // (wf1b-correctness §1e: `{}` here admitted a refused folder as a
      // project, and the project stayed registered after the file returned).
      if (hasDocumentSnapshot(configPath)) return noteStoreState({ state: "unreadable", path: configPath, reason: STORE_REMOVED_REASON });
      useSnapshot({ path: configPath, source: undefined, value: ABSENT_DOCUMENT });
      return noteStoreState({ state: "absent", path: configPath });
    }
    // Readable on the second look (a replacement landed between the two
    // reads): the next refresh compares against real text.
    return adoptDocument(configPath, undefined, inspection.document as HarnessConfigShape);
  }
  if (previous?.source !== undefined && previous.source.text === raw.text) {
    useSnapshot(previous.source === raw ? previous : { ...previous, source: raw });
    return noteStoreState({ state: "ok", path: configPath });
  }
  if (refusedText?.path === configPath && refusedText.text === raw.text) return noteStoreState(refusedText.state);
  const decoded = inspectConfigDocumentBytes(raw.bytes());
  if (decoded.state === "unreadable") {
    const state = noteStoreState({ state: "unreadable", path: configPath, reason: inspectionReason(decoded) });
    refusedText = { path: configPath, text: raw.text, state };
    return state;
  }
  // Deep-freeze so no caller can mutate the shared snapshot (a mutation would
  // silently corrupt every other consumer); write paths use `readConfigRaw`.
  return adoptDocument(configPath, raw, decoded.document as HarnessConfigShape);
}

/**
 * THE STORE WATCH — a changed settings file is refreshed when it changes, not
 * at the next request: a run executing between requests (allowed commands,
 * self-protection, egress privacy) must see a TIGHTENED setting promptly.
 * The folder is watched (an atomic replace swaps the file's inode, which a
 * watch on the file itself would lose); the refresh compares bytes, so a
 * spurious event costs one read. A symlinked store's target is not watched —
 * the request-start and run-start refreshes still cover it.
 *
 * IT SURVIVES ITS FOLDER: when the folder is deleted (or the watch fails),
 * the store is refreshed (a removed document keeps the last good in force)
 * and the watch moves to the nearest folder that still exists, event-driven,
 * moving DOWN as nearer folders come back (WF-1b3b design M4: a recreation
 * one level at a time stalled in the ancestor), until the store's folder is
 * back; then it watches the folder again and refreshes (wf1b2-correctness: a delete-then-recreate left the store
 * unwatched for the life of the server). Registered as a component for its
 * lifetime; the returned function stops it.
 */
export function watchSettingsStore(): () => void {
  const configPath = serverConfig.harnessConfigPath;
  const folder = dirname(configPath);
  const name = basename(configPath);
  let watcher: FSWatcher | undefined;
  let stopped = false;
  const unregisterComponent = registerComponent({
    kind: "settings-watch",
    label: configPath,
    provenance: "server/kernel/harness-config.ts watchSettingsStore",
    facts: { path: folder, file: name },
  });
  // The nearest folder that exists: the store's own, or the ancestor to
  // wait in until the store's folder is recreated.
  const nearestExisting = (): string => {
    let place = folder;
    while (!existsSync(place) && dirname(place) !== place) place = dirname(place);
    return place;
  };
  const arm = (): void => {
    watcher?.close();
    watcher = undefined;
    if (stopped) return;
    const place = nearestExisting();
    try {
      watcher = watch(place, { persistent: false }, guarded("settings.watch.event", (_event, changed) => {
        if (place !== folder) {
          // Parked in an ancestor: an event here may be a NEARER folder
          // coming back (a staged recreation `mkdir a` … `mkdir a/b`, one
          // level at a time — WF-1b3b design M4), so move down to the nearest
          // that exists, and refresh once the store's own folder is back.
          if (nearestExisting() !== place) {
            arm();
            if (existsSync(folder)) refreshSettingsSnapshot();
          }
          return;
        }
        if (!existsSync(folder)) {
          refreshSettingsSnapshot();
          arm();
          return;
        }
        if (changed === null || changed === name) refreshSettingsSnapshot();
      }));
    } catch (error) {
      webConsoleError(`[bridlewise web] the settings watch could not watch ${place} (${error instanceof Error ? error.message : String(error)}); settings are refreshed at each request and run start only`);
      return;
    }
    watcher.on("error", guarded("settings.watch.error", () => {
      // The watched folder went away under the watch: move to the one that exists.
      refreshSettingsSnapshot();
      arm();
    }));
    // A nearer folder created between the look and the watch raised no event here: move down now.
    if (place !== folder && nearestExisting() !== place) {
      arm();
      if (existsSync(folder)) refreshSettingsSnapshot();
    }
  };
  arm();
  return (): void => {
    stopped = true;
    watcher?.close();
    watcher = undefined;
    unregisterComponent();
  };
}

/** The store's last recorded state (a refresh when this path was never resolved). Never throws: it IS the answer. */
export function getSettingsStoreState(): SettingsStoreState {
  const configPath = serverConfig.harnessConfigPath;
  return storeState?.path === configPath ? storeState : refreshSettingsSnapshot();
}

/**
 * The ONE raw read of the document through the engine's read/refusal API,
 * for the write paths and the raw document route: `undefined` ONLY when no
 * file exists (a first write is possible), the decoded document otherwise,
 * and `config_unreadable` for every other failure. It records the state it
 * found but does not swap the snapshot (only a refresh or a write does).
 */
function readConfigDocumentIfPresent(configPath: string): Record<string, unknown> | undefined {
  // A worker isolate never reads (nor writes) the file: see WORKER_SETTINGS_KEY.
  if (!isMainThread) throw configUnreadable(configPath, "worker_settings_not_handed: a worker isolate reads no settings file");
  // The engine's one inspection decides absent / document / refusal (its
  // typed code travels in the reason); recorded, then REFUSED.
  const inspection = inspectConfigDocument(configPath);
  if (inspection.state === "ok") return inspection.document;
  // A store REMOVED after a good document was read refuses too: a save would
  // otherwise write a near-empty document over every setting.
  const reason = inspection.state === "unreadable" ? inspectionReason(inspection) : hasDocumentSnapshot(configPath) ? STORE_REMOVED_REASON : undefined;
  if (reason === undefined) return undefined;
  noteStoreState({ state: "unreadable", path: configPath, reason });
  throw configUnreadable(configPath, reason);
}

/** The resolved snapshot's value; loads it once per path. Refuses only when this path has no good snapshot. */
function readHarnessConfig(): HarnessConfigShape {
  const configPath = serverConfig.harnessConfigPath;
  if (snapshot?.path === configPath) return snapshot.value;
  const state = refreshSettingsSnapshot();
  if (snapshot?.path === configPath) return snapshot.value;
  throw configUnreadable(configPath, state.reason ?? "unknown");
}

// ── Public accessors (one per section) ──

/**
 * The whole resolved snapshot, read-only (frozen), for the readers that parse
 * a section themselves (agent delegation's profiles and timeout, the MCP
 * test's saved entry). They read the SNAPSHOT, never the file: one answer per
 * request, and the last good document while the store is refused.
 */
export function readSettingsDocument(): Readonly<Record<string, unknown>> {
  return readHarnessConfig() as Readonly<Record<string, unknown>>;
}

/**
 * Read the raw config as a mutable `Record<string, unknown>`. For write
 * paths (routes/config.ts PUT, routes/tools.ts toggle) that need to
 * modify and write back. This is the SINGLE read entry point for raw
 * config access — routes no longer call `readFileSync`/`JSON.parse`
 * directly (dedup: was duplicated in routes/config.ts, routes/tools.ts,
 * extensions-bridge.ts).
 *
 * Returns a fresh mutable parse, separate from the frozen typed cache, so
 * callers can change their copy without corrupting typed accessors. An
 * ABSENT file is the empty document (the first write creates it); a file
 * that exists but cannot be read or decoded is refused (`config_unreadable`),
 * never answered with `{}`.
 */
export function readConfigRaw(): Record<string, unknown> {
  return readConfigDocumentIfPresent(serverConfig.harnessConfigPath) ?? {};
}

/**
 * Atomically write the full config JSON to disk and invalidate the
 * typed-accessor cache. Atomic = write to a `.tmp` file then rename, so
 * a crash mid-write never corrupts the config. This is the SINGLE write
 * entry point for config edits — the web UI's PUT /api/config and
 * POST /api/tools/:name/toggle both route through here.
 *
 * DENY-BY-DEFAULT (the write gate): the candidate document is validated
 * against `getConfigDocumentSchema()` — the harness's OWN declaration of the
 * config document — before a single byte reaches the disk. That schema is
 * strict, so an unrecognised key (a path the config vocabulary does not
 * define), a wrong-typed value or an out-of-range number is REJECTED, not
 * written. The allowlist of writable paths is therefore DERIVED from the
 * config schema rather than restated as a list here: a section added to the
 * harness config contract becomes writable with no edit in the web UI, and
 * nothing outside that contract is ever writable.
 *
 * The gate lives HERE, at the single write entry point, rather than in
 * `routes/config.ts`, so that no future writer can reach the config file
 * without passing it (`routes/config.ts` documented an allowlist it did not
 * implement — the endpoint accepted arbitrary new JSON paths).
 */
export function writeConfigRaw(config: Record<string, unknown>): void {
  // The whole gate holds the config's cross-process write lock: the gate's
  // own read (`assertSelfProtectionUnchanged` reads the current file to
  // compare the section) and the write are one indivisible cycle, so a
  // parallel writer cannot land between them and cannot tear the read a
  // concurrent fork observes. Re-entrant within this process — a caller
  // holding the lock for a wider read-modify-write cycle writes through
  // this gate without deadlocking against itself.
  withConfigWriteLock(serverConfig.harnessConfigPath, () => {
    assertSelfProtectionUnchanged(config);
    assertWorkspaceCommandsUnchanged(config);
    const parsed = getConfigDocumentSchema().safeParse(config);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue !== undefined && issue.path.length > 0 ? ` at '${issue.path.join(".")}'` : "";
      throw new ValidationError(
        `Config write rejected by the config document schema${where}: ${issue?.message ?? "unknown validation failure"}`,
        "invalid_config_document",
      );
    }
    const configPath = serverConfig.harnessConfigPath;
    const json = JSON.stringify(config, null, 2) + "\n";
    // MODE 0600, AND IT IS NOT A DETAIL. The harness refuses to start against a
    // config file any other account can read — it exits with
    // `config_mode_insecure` — and an atomic write creates a fresh inode, so
    // without an explicit mode the new file takes whatever the umask gives
    // (0644 here). The rename then puts that permissive file where the strict
    // one was, and the next harness run will not start. Found by running the
    // harness suite after the web suite: one config edit through the web UI had
    // bricked it.
    //
    // The rule now lives in the SHARED atomic-write owner rather than here,
    // because the identical two calls sat in the editor bridge without it and
    // silently relaxed every file edited through the UI. `createMode` covers the
    // first-ever write; an existing config file's own mode is preserved by the
    // owner, which is the stronger guarantee and needs nothing remembered here.
    writeConfigBytesIfChanged(configPath, json);
  });
}

/**
 * THE LOCKED READ-MODIFY-WRITE CYCLE — the shape every caller that composes
 * a candidate from the current document must use instead of reading and then
 * calling `writeConfigRaw` as two steps.
 *
 * A caller that reads first and writes second holds nothing between the two:
 * a parallel process can land its own write inside that gap, and the
 * composed candidate — built from the pre-gap read — silently overwrites
 * it. That is the lost-update class measured on this file (two suite forks
 * each restoring "what they found" wrote each other's mid-cycle state back
 * out). Here the read, the caller's mutation, the gate and the write all
 * happen inside ONE hold of the cross-process write lock, so the compose
 * always sees a committed document.
 *
 * Returns the candidate that was written (the caller's own composition, for
 * response payloads that must not re-read).
 */
export function modifyConfigRaw(mutate: (doc: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  return withConfigWriteLock(serverConfig.harnessConfigPath, () => {
    const candidate = mutate(readConfigRaw());
    writeConfigRaw(candidate);
    return candidate;
  });
}

/**
 * Restore the config file to EXACT bytes — the byte-identical restore owner
 * for arms that must put the found state back (suite forks sharing the real
 * config). The bytes are read and compared INSIDE the lock, so the restore
 * is never a lost update: whatever the found bytes were, no concurrent
 * writer's cycle can interleave between the comparison and the write, and
 * the write itself is the atomic-rename owner (a reader never sees the
 * file truncated mid-restore). Mode 0600, same as every config write.
 */
export function restoreConfigFileBytes(bytes: string): void {
  withConfigWriteLock(serverConfig.harnessConfigPath, () => {
    writeConfigBytesIfChanged(serverConfig.harnessConfigPath, bytes);
  });
}

/**
 * Both callers hold the write lock; successful validation precedes this door.
 *
 * A SYMLINKED config is written THROUGH its link: every read here follows
 * the link, so the write replaces the file the link names (atomically, in
 * its own directory) and the link survives. Replacing the link itself —
 * what a no-op save once did — silently detached the operator's managed
 * file and left its target stale (wf1a-correctness §1).
 */
function writeConfigBytesIfChanged(configPath: string, bytes: string): void {
  const target = atomicWriteTargetOf(configPath, configLinkTargetRoots(configPath));
  let fileCanStay = false;
  try {
    const state = lstatSync(target);
    const mode = state.mode & 0o7777;
    // Atomic replacement produces a regular, singly linked file owned by
    // this process. A no-op must establish those postconditions too; stat
    // follows symlinks and decoded text cannot establish physical bytes.
    fileCanStay = state.isFile() && !hasSecondName(state.nlink)
      && state.uid === process.getuid?.() && (mode & 0o600) === mode
      && fileTextBytesEqual(target, bytes);
  } catch {
    // Missing/unreadable bytes cannot establish a no-op. The atomic owner
    // performs the required creation or reports the actual write refusal.
    fileCanStay = false;
  }
  if (!fileCanStay) {
    const written = atomicWriteFile(configPath, bytes, { createMode: 0o600, requiredMode: 0o600, createParentDirectories: false, linkTargetRoots: configLinkTargetRoots(configPath) });
    if (!written.success) throw written.error;
  }
  // Both accepted verbs swap the resolved snapshot synchronously, even when
  // no physical write was needed: the server's own save is in force for the
  // very next read, whatever the filesystem's timestamp granularity.
  refreshSettingsSnapshot();
}

/**
 * The file a config write replaces — the writer primitive's ONE link rule
 * (`atomicWriteTargetOf`): a final link is followed only into the config
 * document's own directory; a link out of it, a dangling link or a loop is
 * refused typed.
 */
function configLinkTargetRoots(configPath: string): readonly string[] {
  return [dirname(configPath)];
}

/**
 * SELF-PROTECTION CANNOT BE EDITED THROUGH THIS SERVER. Turning the sandbox
 * off, or widening what it allows, has to be written down in the file by
 * somebody with access to the machine.
 *
 * ── WHAT THIS CLOSES ──────────────────────────────────────────────────────
 *
 * `PUT /api/config` refused only keys whose NAME looked like a secret —
 * `apiKey`, `secret`, `password`, `token`, `credential`, `auth`. Nothing in
 * `selfProtection` matches any of those, so an admin session could set
 * `selfProtection.enabled` to false, or add an allow-rule covering the whole
 * disk, over HTTP. Six spellings of "allow everything" were measured through
 * that route, three of them reaching a write inside the harness's own
 * protected source, while the cockpit and every tool result went on reporting
 * `confined`. That is precisely the class the sandbox exists to prevent, and
 * it was reachable by the one API call that is supposed to be safe because it
 * is schema-checked.
 *
 * ── WHY HERE AND NOT IN THE ROUTE ─────────────────────────────────────────
 *
 * The route's check is a per-PATH check, and a per-path check has to be
 * updated when a path is added — the shape that fails by forgetting. This is
 * the single write entry point every config edit passes through, and it
 * compares the SECTION rather than a path, so `selfProtection.enabled`,
 * `selfProtection.additionalAllowRules[3].path` and a wholesale replacement of
 * the section are one rule with nothing to keep in step. A future writer that
 * never heard of self-protection is covered because it cannot reach the file
 * any other way.
 *
 * ── AND WHY REFUSING IS NOT AN OUTAGE ─────────────────────────────────────
 *
 * Nothing in the UI offers to edit this section, and the design already says
 * so in as many words: "turning the protection off is something an operator
 * has to write down". This makes that sentence true rather than aspirational.
 * The operator's channel is the config file itself, which needs access to the
 * machine the server runs on — a materially higher bar than an admin cookie,
 * which is the whole point.
 *
 * The comparison is on the canonical serialisation, so key order and
 * whitespace cannot make an unchanged section look changed.
 */
function assertSelfProtectionUnchanged(candidate: Record<string, unknown>): void {
  // ── A GATE THAT CANNOT READ MUST NOT LET THE WRITE THROUGH ──────────────
  //
  // The current document comes from the one read/refusal door: a file that
  // exists but is unreadable or undecodable REFUSES (`config_unreadable`)
  // before anything is compared, and only a genuinely absent file is the
  // empty document (a first write: there is nothing to preserve). The gate
  // once compared the candidate with the `{}` a corrupt file used to decode
  // to, so a write without `selfProtection` was accepted and stripped the
  // section (reproduced; `tests/unit/config-refusal-write-gate.test.ts`).
  const current = readConfigRaw();
  if (canonicalJson(current.selfProtection ?? null) === canonicalJson(candidate.selfProtection ?? null)) {
    return;
  }
  // THE SECOND CONFINEMENT SENTENCE IS DELETED, NOT CORRECTED.
  //
  // This message used to go on to state, as fact, that commands the model runs
  // are confined to the selected project. It said that in the same words
  // whether the measured state was `confined`, `off`, `unavailable` or
  // `unknown` — a fabrication in three of the four — and it was a SECOND owner
  // of a fact the status already owns, so the two could describe one thing
  // differently. Correcting it would have meant importing the measurement,
  // which is a cycle; and this refusal does not need the fact at all. What it
  // needs to say is what the setting controls and where it lives, and both are
  // true in every state.
  throw new ValidationError(
    "The setting that controls whether the model's commands are held inside your project cannot be changed through this server. "
    + "Changing it — or widening what those commands may reach — has to be written into the harness settings file directly, by someone with access to this machine. "
    + "The cockpit shows what is actually in force right now.",
    "self_protection_not_editable_here",
  );
}

/**
 * WHAT A WORKSPACE RUNS AND WHERE IT LANDS IS NOT WRITABLE HERE EITHER
 * (cfg-audit): `workspaceIsolation.commands` is argv a checkout's setup and a
 * workspace's gates execute on the host, unconfined, `workspaceIsolation.phases`
 * chooses which of them run, and `workspaceIsolation.landTargets` names the
 * branches a workspace may fast-forward — an admin cookie that could edit any
 * of them could plant a command the next checkout runs as the operator, or
 * open a product branch to workspace lands past its promotion door. Same rule
 * and channel as the self-protection section above: compared as a section,
 * refused typed, and written only into the settings file by someone with
 * access to the machine.
 */
function assertWorkspaceCommandsUnchanged(candidate: Record<string, unknown>): void {
  const executed = (document: Record<string, unknown>): string => {
    const isolation = document.workspaceIsolation as Record<string, unknown> | undefined;
    return canonicalJson({ commands: isolation?.commands ?? null, phases: isolation?.phases ?? null, landTargets: isolation?.landTargets ?? null });
  };
  if (executed(readConfigRaw()) === executed(candidate)) return;
  throw new ValidationError(
    "The commands a workspace or a new checkout runs, and the branches a workspace may land on, cannot be changed through this server. "
    + "The commands run on this machine outside every sandbox and the land targets decide what reaches a branch, so they have to be written into the harness settings file directly, by someone with access to this machine.",
    "workspace_commands_not_editable_here",
  );
}

/**
 * The allowed commands for `execute_command`. Returns a frozen Set for O(1) membership checks. When the
 * config omits `tools.allowedCommands`, returns an EMPTY set — every command
 * is rejected with a typed error (honest, not a silent fallback to a baked-in
 * list).
 */
export function getAllowedCommands(): ReadonlySet<string> {
  const cfg = readHarnessConfig();
  const commands = cfg.tools?.allowedCommands;
  if (!Array.isArray(commands)) return Object.freeze(new Set<string>());
  return Object.freeze(new Set(commands.filter((c): c is string => typeof c === "string")));
}

/**
 * Configured MCP servers (from `tools.mcpServers` — the ACTUAL config path).
 * Fixes the prior bug where `mcp-bridge.ts` read the non-existent top-level
 * `mcp.servers`, so every configured server was silently invisible.
 */
export function getMcpServers(): readonly McpServerEntry[] {
  const cfg = readHarnessConfig();
  const servers = cfg.tools?.mcpServers;
  if (!Array.isArray(servers)) return [];
  return servers.filter((s): s is McpServerEntry => s !== null && typeof s === "object");
}

/**
 * The `tools.mcp` module-wide defaults the operator actually set (retry count,
 * retry backoff, timeout, stdio termination grace). Returns ONLY the keys
 * present — an omitted key comes back `undefined` so the MCP module's own
 * defaults apply, which is what keeps the config file the single override
 * source and the module the single default owner (no number restated here).
 */
// The section schema's own output type: a knob added to `tools.mcp` widens
// the accessor's type through the schema, so no hand-maintained property
// list exists here to drift. With `exactOptionalPropertyTypes` the missing
// keys come back explicitly `| undefined`.
export type McpDefaults = Readonly<z.infer<typeof MCP_CONFIG_SCHEMA>>;
export function getMcpDefaults(): McpDefaults {
  const mcp = readHarnessConfig().tools?.mcp;
  if (mcp === undefined) return {};
  // The write gate's schema is the single bounds owner for this section —
  // floors AND ceilings alike. A document on disk that never passed the gate
  // (a hand edit) is invalid input: the read path refuses it loudly, naming
  // the offending key, rather than flowing an out-of-range bound into a
  // transport. Nothing here restates a number the schema already owns.
  const parsed = MCP_CONFIG_SCHEMA.safeParse(mcp);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? ` at tools.mcp.${issue.path.join(".")}` : " at tools.mcp";
    throw new ValidationError(
      `the MCP module defaults in the harness config are invalid${where}: ${issue?.message ?? "unknown validation failure"} — fix the value in settings or correct the config file`,
      "invalid_config_document",
    );
  }
  return parsed.data;
}

/** The `tools.enabled` list (tools the LLM may call). Empty when unset. */
export function getEnabledTools(): readonly string[] {
  const cfg = readHarnessConfig();
  const enabled = cfg.tools?.enabled;
  if (!Array.isArray(enabled)) return [];
  return enabled.filter((e): e is string => typeof e === "string");
}

/** The `memory` config section (contextTokenLimit, trimThreshold, etc.). */
export function getMemoryConfig(): Readonly<Record<string, unknown>> {
  const cfg = readHarnessConfig();
  return cfg.memory ?? {};
}

/**
 * The `memory.dedupCompression` config section (the dedup/compression lower
 * layer: enabled, llmInputDedup, dedupMode). The single config-owner accessor
 * so the dedup-bridge does not read `getMemoryConfig()` + cast inline (the
 * config owner owns ALL config reading). Returns null when the section is
 * absent or not an object (deny-by-default — dedup is OFF unless explicitly
 * configured).
 */
export function getDedupCompressionSection(): Readonly<Record<string, unknown>> | null {
  const raw = getMemoryConfig();
  const section = raw.dedupCompression;
  if (section === null || typeof section !== "object") return null;
  return section as Readonly<Record<string, unknown>>;
}

/**
 * Max characters of a tool's output stored in the memory entry's `content`
 * when the harness auto-saves a successful tool result (the `[toolName] …`
 * preview the LLM reads via `fetch_memory`). Was a hardcoded
 * `toolResult.output.slice(0, 2000)` in routes/run.ts (a
 * hardcoded configurable). Configurable via `memory.toolResultContentMaxChars`
 * (declared in the config contract; the default is owned by
 * `DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS` there).
 */
export function getToolMemoryContentMaxChars(): number {
  const cfg = readHarnessConfig();
  const v = cfg.memory?.toolResultContentMaxChars;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS;
}

/**
 * Max characters of a tool's arguments stored in the memory entry's
 * `originalRequest` (the JSON-serialized args the LLM reads for context).
 * Was a hardcoded `JSON.stringify(event.arguments).slice(0, 1000)` in
 * routes/run.ts. Configurable via `memory.toolResultArgsMaxChars` (declared
 * in the config contract; the default is owned by
 * `DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS` there).
 */
export function getToolMemoryArgsMaxChars(): number {
  const cfg = readHarnessConfig();
  const v = cfg.memory?.toolResultArgsMaxChars;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS;
}

/**
 * Max characters of a recalled memory entry shown in the "Recalled context"
 * section injected into the system prompt (the `preview` the LLM reads — the
 * full entry stays in the DB). Was a hardcoded `slice(0, 400)` in
 * context-bridge.ts. Configurable via `memory.previewMaxChars` (declared in
 * the config contract; the default is owned by
 * `DEFAULT_MEMORY_PREVIEW_MAX_CHARS` there).
 */
export function getMemoryPreviewMaxChars(): number {
  const cfg = readHarnessConfig();
  const v = cfg.memory?.previewMaxChars;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_MEMORY_PREVIEW_MAX_CHARS;
}

/**
 * Default result limit for memory search (`searchMemory` / `fetch_memory`)
 * when the caller omits or supplies an invalid `limit`. The single owner of
 * this default so the memory bridge, the memory route, and the `fetch_memory`
 * tool manifest cannot drift. Reads the config contract's declared
 * `memory.searchResultLimit` leaf — the one name for this concept; an
 * earlier spelling (`memory.searchDefaultLimit`) was a path the contract
 * refused, so the knob was never writable. The absent-key fallback is the
 * memory resolver's own catalog (`resolveMemoryConfig({}).searchResultLimit`)
 * — the one door to that default, so the engine's default and the route's
 * fallback can never drift.
 */
export function getMemorySearchDefaultLimit(): number {
  const cfg = readHarnessConfig();
  const v = cfg.memory?.searchResultLimit;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : resolveMemoryConfig({}).searchResultLimit;
}

/**
 * Max result limit for memory search (the route + the tool manifest clamp a
 * caller-supplied `limit` to this). The single owner of the cap so the memory
 * bridge, the memory route, and the `fetch_memory` tool share ONE ceiling
 * (previously the route hardcoded `1000` and the tool manifest hardcoded
 * `200` — three independent caps that could drift). Configurable via
 * `memory.searchMaxLimit` (declared in the config contract; the default is
 * owned by `DEFAULT_MEMORY_SEARCH_MAX_LIMIT` there).
 */
export function getMemorySearchMaxLimit(): number {
  const cfg = readHarnessConfig();
  const v = cfg.memory?.searchMaxLimit;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_MEMORY_SEARCH_MAX_LIMIT;
}

/**
 * Max number of memory entries retrieved for prompt injection
 * (`retrieveRelevantMemories` in the run route). Was a hardcoded `5` in
 * `routes/run.ts`. Configurable via `memory.retrievalLimit` (declared in the
 * config contract; the default is owned by `DEFAULT_MEMORY_RETRIEVAL_LIMIT`
 * there).
 */
export function getMemoryRetrievalLimit(): number {
  const cfg = readHarnessConfig();
  const v = cfg.memory?.retrievalLimit;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_MEMORY_RETRIEVAL_LIMIT;
}

/**
 * Max characters of a chat interaction stored by `storeInteraction` (the
 * `User: …\nAssistant: …` content auto-saved at end of run). Was uncapped —
 * a long LLM response was stored in full, bloating the memory store.
 * Configurable via `memory.interactionContentMaxChars` (declared in the
 * config contract; the default is owned by
 * `DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS` there).
 */
export function getInteractionContentMaxChars(): number {
  const cfg = readHarnessConfig();
  const v = cfg.memory?.interactionContentMaxChars;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS;
}

/**
 * Configured extensions (from the `extensions` config section). Dedup:
 * extensions-bridge.ts previously read the config file directly (duplicate
 * of this reader). Now it routes through here (single source of truth).
 */
export function getExtensions(): readonly Readonly<{
  name: string;
  type: string;
  version: string;
  description?: string;
  enabled?: boolean;
}>[] {
  const cfg = readHarnessConfig();
  const exts = cfg.extensions;
  if (!Array.isArray(exts)) return [];
  return exts.filter((e): e is NonNullable<typeof e> => e !== null && typeof e === "object");
}

/**
 * Agent config section (from `runtime.agents` or top-level `agents`). Dedup:
 * agent-types-bridge.ts previously read the config file directly (duplicate
 * of this reader). Now it routes through here (single source of truth).
 */
export function getAgentsConfig(): Readonly<AgentsConfigSection> {
  const cfg = readHarnessConfig();
  return cfg.runtime?.agents ?? cfg.agents ?? {};
}

/**
 * The `runtime.limits.maximumToolIterations` (tool-call loop bound — note the
 * PLURAL key matching `bridlewise.config.json`). The default is owned HERE
 * (the single config-accessor owner — no default values scattered
 * at call sites), so callers pass no literal. An optional `fallback` lets a
 * caller override the default (unused today but kept for an explicit per-call
 * bound if ever needed).
 *
 * BUG FIX: the reader previously read `maximumToolIteration`
 * (singular) while the config declares `maximumToolIterations` (plural), so
 * the configured value was NEVER read — every run fell back to the hardcoded
 * default. Reading the correct key makes the config the real source of truth.
 */
const DEFAULT_MAXIMUM_TOOL_ITERATION = 10;

export function getMaximumToolIterations(fallback?: number): number {
  const cfg = readHarnessConfig();
  const v = cfg.runtime?.limits?.maximumToolIterations;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  return fallback ?? DEFAULT_MAXIMUM_TOOL_ITERATION;
}

/**
 * User preferences injected into the system prompt (configurable from
 * the web, per-user in the DB). The config file's `runtime.userPreferences`
 * is the GLOBAL DEFAULT seed; the per-user DB override
 * (`user_prompt_prefs`, encrypted) wins field-by-field. The dropdown values
 * match the task spec: tone ∈ {concise, detailed, friendly}, sentenceCase ∈
 * {normal, title, upper}, emoji + icon booleans. Each has a sensible default
 * so the prompt section is only added when a preference differs from the
 * default. (Refactor: the prior casual/formal + default/case_sentence
 * values are replaced per — no backward compatibility.)
 */
export type PromptTone = "concise" | "detailed" | "friendly";
export type SentenceCase = "normal" | "title" | "upper";

export type UserPreferences = Readonly<{
  tone: PromptTone;
  emoji: boolean;
  icons: boolean;
  sentenceCase: SentenceCase;
}>;

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  tone: "concise",
  emoji: false,
  icons: true,
  sentenceCase: "normal",
};

/**
 * The instruction a response TONE adds to the system prompt: the entry of
 * the one tone catalog (`webUi.promptGenerator.tones`) whose id is `tone`,
 * or undefined when the catalog does not carry it. The system prompt used
 * to restate these sentences byte for byte (prompt-registry F-PR-3).
 */
export function getPromptToneInstruction(tone: PromptTone): string | undefined {
  const entry = readHarnessConfig().webUi?.promptGenerator?.tones?.find((option) => option.id === tone);
  return typeof entry?.instruction === "string" && entry.instruction.length > 0 ? entry.instruction : undefined;
}

export function getUserPreferences(): UserPreferences {
  const cfg = readHarnessConfig();
  const prefs = cfg.runtime?.userPreferences;
  if (prefs === undefined) return DEFAULT_USER_PREFERENCES;
  const tone: PromptTone =
    prefs.tone === "concise" || prefs.tone === "detailed" || prefs.tone === "friendly"
      ? prefs.tone
      : DEFAULT_USER_PREFERENCES.tone;
  const sentenceCase: SentenceCase =
    prefs.sentenceCase === "normal" || prefs.sentenceCase === "title" || prefs.sentenceCase === "upper"
      ? prefs.sentenceCase
      : DEFAULT_USER_PREFERENCES.sentenceCase;
  return {
    tone,
    emoji: typeof prefs.emoji === "boolean" ? prefs.emoji : DEFAULT_USER_PREFERENCES.emoji,
    icons: typeof prefs.icons === "boolean" ? prefs.icons : DEFAULT_USER_PREFERENCES.icons,
    sentenceCase,
  };
}

/**
 * The ledger's operational section, verbatim. The timeline store applies its
 * own declared defaults for absent fields (engine timeline-config.ts), so
 * this accessor deliberately does NOT restate them — a second set of store
 * defaults here is exactly the drift the single-owner rule forbids. The one
 * field with a server-applied default is the payload-capture switch, whose
 * declared default is imported from the config contract through the
 * canonical hub.
 */
export function getTimelineConfig(): NonNullable<HarnessConfigShape["timeline"]> {
  return readHarnessConfig().timeline ?? {};
}

/** Whether provider-interaction payload capture is on (default: the config contract's declared default). */
export function captureProviderPayloadsEnabled(): boolean {
  const v = getTimelineConfig().captureProviderPayloads;
  return typeof v === "boolean" ? v : DEFAULT_CAPTURE_PROVIDER_PAYLOADS;
}

/**
 * Whether per-effect resource deltas (CPU time + heap growth) are recorded
 * into the ledger's timing document and the metrics aggregates. The declared
 * default lives in the performance config contract
 * (`DEFAULT_RESOURCE_DELTAS_ENABLED`) and is applied here — never restated.
 */
export function performanceResourceDeltasEnabled(): boolean {
  const v = readHarnessConfig().performance?.resourceDeltas?.enabled;
  return typeof v === "boolean" ? v : DEFAULT_RESOURCE_DELTAS_ENABLED;
}

/**
 * The process resource sampler's resolved configuration: whether it runs and
 * at what period. Every default is the performance config contract's own
 * (`DEFAULT_RESOURCE_SAMPLER_ENABLED` / `DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS`),
 * applied — never restated — and an out-of-range interval from a document
 * that bypassed the write gate falls back to the declared default rather
 * than flowing into a timer.
 */
export function resourceSamplerConfig(): Readonly<{ enabled: boolean; intervalMs: number }> {
  const s = readHarnessConfig().performance?.resourceSampler;
  const interval = s?.intervalMs;
  return {
    enabled: typeof s?.enabled === "boolean" ? s.enabled : DEFAULT_RESOURCE_SAMPLER_ENABLED,
    intervalMs:
      typeof interval === "number" && Number.isInteger(interval) && interval > 0
        ? interval
        : DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
  };
}

/**
 * The diagnostic modes the diagnostic command skips, as the file says. The
 * declared default lives in the performance config contract
 * (`DEFAULT_PERFORMANCE_CONFIG.diagnosticModes.excludedModes` — no mode is
 * excluded) and is applied here, never restated; a malformed entry from a
 * document that bypassed the write gate falls back to the declared default
 * rather than flowing into the settings room's face.
 */
/**
 * The document's WHOLE `performance` section, resolved by the engine's one
 * resolution (`performanceConfigOf`: undeclared = the declared default) — what
 * the web server's metrics collector is built from (CFG-0 B4: it used the
 * frozen `DEFAULT_PERFORMANCE_CONFIG`, so an operator's section reached the
 * CLI's collector and never the server's).
 */
export function configuredPerformance(): ReturnType<typeof performanceConfigOf> {
  return performanceConfigOf((readHarnessConfig() as { performance?: unknown }).performance);
}

export function performanceDiagnosticExcludedModes(): readonly string[] {
  const v = readHarnessConfig().performance?.diagnosticModes?.excludedModes;
  return Array.isArray(v) ? v : DEFAULT_PERFORMANCE_CONFIG.diagnosticModes.excludedModes;
}

export type { McpServerEntry, HarnessConfigShape };

/**
 * Frontend poll interval (ms) while the repository map indexes in the
 * background worker thread. The frontend reads the same value from the
 * redacted config snapshot (`configSnapshot` → `codeIntelligence.indexPollMs`),
 * so this server-side value is owned by the config file alone — no
 * server-side accessor is needed (the frontend is the sole consumer).
 */
// (indexPollMs + indexTimeoutMs are read client-side from configSnapshot;
// no server accessor — see src/state/code-index.ts.)

/** Whether adding (or restoring) a project starts mapping it immediately.
 * Default on — the knob exists so an operator can wait until something
 * asks, not because the start-up pass is optional in the product. */
export function getAutoIndexOnProjectAdd(): boolean {
  return readHarnessConfig().codeIntelligence?.autoIndexOnProjectAdd !== false;
}

/** Watch an indexed project's folder for disk edits. Default on. */
export function getWatchIndexedProjects(): boolean {
  return readHarnessConfig().codeIntelligence?.watchIndexedProjects !== false;
}

/** Coalesce folder-watch events before another map pass. Default 400ms. */
export function getIndexWatchDebounceMs(): number {
  return pickPositiveInt(readHarnessConfig().codeIntelligence?.indexWatchDebounceMs, 400);
}

/** Server-side per-project repository-map cache TTL (ms). */
export function getMapCacheTtlMs(): number {
  const cfg = readHarnessConfig();
  const v = cfg.codeIntelligence?.mapCacheTtlMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 60_000;
}

/** Server-side per-project quick-view index cache TTL (ms). Default 60 000.
 * Owned here — previously an inline constant in
 * intelligence-bridge. */
export function getQuickViewCacheTtlMs(): number {
  const cfg = readHarnessConfig();
  const v = cfg.codeIntelligence?.quickViewCacheTtlMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 60_000;
}

// ── Intelligence search/retrieve result limits ──
// The default + max result limits for `search_code` / `find_reuse` and
// `retrieve_relevant_files`. Previously the SAME defaults (`50`/`500` for
// search, `15`/`100` for retrieve) were hardcoded across THREE sites —
// intelligence-bridge.ts (the bridge default), routes/intelligence.ts (the
// route clamp), and tool-executor.ts (the LLM-tool fallback) — so a tuning
// change required editing all three. The floors below are the ONE owner; every
// site reads through these accessors. `pickPositiveInt` is hoisted, so the
// accessors can precede its definition.

/** Default result limit for `search_code` / `find_reuse` when the caller
 * omits `limit`. Default 50. */
export function getIntelligenceSearchDefaultLimit(): number {
  return pickPositiveInt(readHarnessConfig().codeIntelligence?.searchDefaultLimit, 50);
}

/** Max result limit for `search_code` / `find_reuse` (the route clamps the
 * query `limit` to this). Default 500. */
export function getIntelligenceSearchMaxLimit(): number {
  return pickPositiveInt(readHarnessConfig().codeIntelligence?.searchMaxLimit, 500);
}

/** Default result limit for `retrieve_relevant_files` when the caller omits
 * `limit`. Default 15. */
export function getIntelligenceRetrieveDefaultLimit(): number {
  return pickPositiveInt(readHarnessConfig().codeIntelligence?.retrieveDefaultLimit, 15);
}

/** Max result limit for `retrieve_relevant_files` (the route clamps the
 * query `limit` to this). Default 100. */
export function getIntelligenceRetrieveMaxLimit(): number {
  return pickPositiveInt(readHarnessConfig().codeIntelligence?.retrieveMaxLimit, 100);
}

/**
 * Number of languages the repository-map prompt injection lists in the
 * `<lang>=<count>` preview (the rest are omitted to keep the system prompt
 * compact). Was a hardcoded `slice(0, 6)` in intelligence-bridge.ts. The
 * floor (6) matches the prior hardcoded value.
 */
export function getRepoMapLanguagePreviewCount(): number {
  return pickPositiveInt(readHarnessConfig().codeIntelligence?.repoMapLanguagePreview, 6);
}

export type CodeIntelligenceFarmConfig = Readonly<{
  perFileTimeoutMs: number;
  initTimeoutMs: number;
  maxInitFailures: number;
}>;

/** Watchdogs for crash-isolated extract. Floors are the
 * `DEFAULT_FARM_*` constants in intelligence-config. */
export function getFarmConfig(): CodeIntelligenceFarmConfig {
  const farm = readHarnessConfig().codeIntelligence?.farm;
  return {
    perFileTimeoutMs: pickPositiveInt(farm?.perFileTimeoutMs, DEFAULT_FARM_PER_FILE_TIMEOUT_MS),
    initTimeoutMs: pickPositiveInt(farm?.initTimeoutMs, DEFAULT_FARM_INIT_TIMEOUT_MS),
    maxInitFailures: pickPositiveInt(farm?.maxInitFailures, DEFAULT_FARM_MAX_INIT_FAILURES),
  };
}

// ── Auto-heal config ──
// Stale-index detection + broken-edge flagging. The floors below are the
// ONE owner of the auto-heal defaults; the config file
// (`codeIntelligence.autoHeal`) overrides each. The sample-size scaling is
// adaptive (sqrt) so per-read stat cost stays bounded on large codebases
// while small ones get full coverage — no static constant.

export interface AutoHealConfig {
  /** Master switch for stale-index detection. */
  readonly enabled: boolean;
  /** File count at/below which every source file is sampled. */
  readonly staleFullCoverageThreshold: number;
  /** Floor for the adaptive sample size. */
  readonly staleSampleFloor: number;
  /** Ceiling for the adaptive sample size. */
  readonly staleSampleCeiling: number;
}

/** Resolve the auto-heal config from the harness config file, applying the
 * canonical floors. Defaults: enabled, full-coverage ≤ 200 files, sample
 * floor 32, ceiling 256. */
export function getAutoHealConfig(): AutoHealConfig {
  const cfg = readHarnessConfig();
  const raw = cfg.codeIntelligence?.autoHeal;
  const enabled = raw?.enabled !== false;
  const staleFullCoverageThreshold = pickPositiveInt(raw?.staleFullCoverageThreshold, 200);
  const staleSampleFloor = pickPositiveInt(raw?.staleSampleFloor, 32);
  const staleSampleCeiling = pickPositiveInt(raw?.staleSampleCeiling, 256);
  return { enabled, staleFullCoverageThreshold, staleSampleFloor, staleSampleCeiling };
}

/** Pick a positive finite integer from a config value, falling back to `dflt`. */
function pickPositiveInt(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

/** Pick a non-negative finite integer from a config value, falling back to
 * `dflt`. Distinct from `pickPositiveInt`: 0 is a MEANINGFUL operator choice
 * (the explicit "disabled"), not a malformed value. */
function pickNonNegativeInt(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
}

// ── SPO: safety gate config ──
// The pre-dispatch hallucination/safety gate reads its tunables from the
// `safety.toolCallGate` section of the global config file. The defaults
// mirror the canonical gate's `DEFAULT_TOOL_CALL_GATE_CONFIG` so the gate
// works out-of-the-box (all three features on) without a config section.
// The safety bridge (`safety-bridge.ts`) is the ONLY consumer of this
// accessor — it resolves the config once per run when creating the gate.
// Reusing the canonical `resolveToolCallGateConfig` ensures the
// override-merge semantics (partial config spread over defaults) are
// identical to the canonical gate's own behavior — no drift.
import { resolveToolCallGateConfig, type ToolCallGateConfig } from "./canonical.ts";
import { resolveBandaidConfig, type BandaidConfig, type BandaidConfigOverrides } from "./canonical.ts";
import { assertSafetyEventFeedPosture, assertSafetyGatePosture } from "./canonical.ts";

/**
 * The SINGLE accessor for the safety gate config. Reads `safety.toolCallGate`
 * from the config file, merges over the canonical gate's defaults via
 * `resolveToolCallGateConfig`, and returns a frozen `ToolCallGateConfig`.
 * When the section is absent, all three features default to ON (the
 * canonical gate's conservative default — deny-by-default: the gate is
 * active unless explicitly disabled).
 */
export function getSafetyGateConfig(): ToolCallGateConfig {
  const cfg = readHarnessConfig();
  const raw = cfg.safety?.toolCallGate;
  // The posture door for the gate's three checks: a section that turns one
  // off is refused HERE too, not just at the write gate — bytes that never
  // passed the gate (a hand edit between restarts) are caught at the next
  // per-run resolution and at the boot pin, both of which come through this
  // accessor. The resolvers themselves stay override-permissive (the engine
  // tests' contract); the floors govern the PERSISTED section.
  assertSafetyGatePosture(raw);
  // Build the override with conditional spreads so only DEFINED values are
  // included (with `exactOptionalPropertyTypes: true`, passing
  // `boolean | undefined` would override the canonical default with
  // `undefined` — a subtle bug). The spread of `{}` when the condition is
  // false adds nothing; absent config keys fall through to the canonical
  // gate's defaults via `resolveToolCallGateConfig`.
  return resolveToolCallGateConfig({
    maxRepeatCount: pickPositiveInt(raw?.maxRepeatCount, 5),
    loopWindow: pickPositiveInt(raw?.loopWindow, 16),
    partialArgumentsLimit: pickPositiveInt(raw?.partialArgumentsLimit, 64),
    blockEscalationAfter: pickPositiveInt(raw?.blockEscalationAfter, 3),
    blockAutoTripAfter: pickNonNegativeInt(raw?.blockAutoTripAfter, 6),
    ...(typeof raw?.enableGhostToolDetection === "boolean" ? { enableGhostToolDetection: raw.enableGhostToolDetection } : {}),
    ...(typeof raw?.enableSchemaValidation === "boolean" ? { enableSchemaValidation: raw.enableSchemaValidation } : {}),
    ...(typeof raw?.enableLoopDetection === "boolean" ? { enableLoopDetection: raw.enableLoopDetection } : {}),
    ...(typeof raw?.enablePartialArgumentMemory === "boolean" ? { enablePartialArgumentMemory: raw.enablePartialArgumentMemory } : {}),
  });
}

// ── Event-feed safety detector config (single owner) ──
// The workaround / bandaid / step-skip / deviation detectors all consume ONE
// engine-validated `BandaidConfig`. The engine's `resolveBandaidConfig` is
// the only validation: it merges the config file's `safety.eventFeed`
// overrides over the engine defaults and rejects nonsense (bad regexes,
// out-of-range thresholds) with a typed InputError. This accessor deliberately
// does no field-picking and supplies no defaults of its own — a second reader
// that guessed the shape would be a second answer to one config question, and
// a malformed section that degraded to "off" would be a typo silently
// removing a safety detector. The safety-runtime owner turns a throw into a
// VISIBLE disarmed state (published on the run's findings frame), never into
// a silent default.

/**
 * The SINGLE accessor for the event-feed detector config. Resolves
 * `safety.eventFeed` from the config file through the engine's own validated
 * resolver. Throws the resolver's typed InputError on a malformed section —
 * the caller (safety-runtime-bridge) surfaces that as a disarmed runtime with
 * the reason, so the run reports honestly instead of pretending the detectors
 * ran. A POSTURE violation (a section that would disarm a detector) is a
 * different refusal: the runtime re-throws it, so the run that would run
 * unarmed detectors does not start — disarming is not a degraded mode.
 */
export function getEventFeedSafetyConfig(): BandaidConfig {
  // The posture door for the event-feed detectors: a section that disarms a
  // family, turns off the long-comment finding path, or narrows the
  // consequential-tools mode to an empty list is refused HERE too — the
  // per-run resolution and the boot pin both come through this accessor, so
  // hand-edited bytes that never passed the write gate are caught before
  // the detectors are constructed. The resolver stays override-permissive
  // (the engine tests' contract); the floors govern the PERSISTED section.
  const raw = readHarnessConfig().safety?.eventFeed;
  assertSafetyEventFeedPosture(raw);
  return resolveBandaidConfig(raw as BandaidConfigOverrides | undefined);
}

// ── Worker-thread pool config (single owner) ──
// The worker pool (`server/worker-pool.ts`) reads its tunables through these
// accessors. The floors below are the
// ONE owner of the defaults; the config file (`workerThreads`) overrides
// each. Applies to ALL backend `node:worker_threads` workers (repository-
// map, quick-view, awareness) — one timeout + one concurrency cap for the
// whole pool, not per-bridge literals.

/** Per-task worker timeout (ms). A worker that doesn't post a result
 * within this window is terminated + the promise rejects with the
 * caller's typed error. Default 120 000 (2 min). A non-positive config
 * value disables the timeout (returned as 0 so the pool skips the timer)
 * NOT recommended outside tests. */
export function getWorkerTimeoutMs(): number {
  const cfg = readHarnessConfig();
  const v = cfg.workerThreads?.timeoutMs;
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? Math.floor(v) : 0;
  return 120_000;
}

/** Max concurrent worker threads. When at capacity, a NEW spawn (a dedup
 * hit already shares the in-flight worker) rejects with the caller's
 * typed error. Default 8 — bounds resource use on a multi-project server. */
export function getWorkerMaxConcurrent(): number {
  const cfg = readHarnessConfig();
  const v = cfg.workerThreads?.maxConcurrent;
  return pickPositiveInt(v, 8);
}

/**
 * The operator's self-protection settings, resolved by the harness's OWN
 * resolver.
 *
 * This accessor deliberately does no field-picking and supplies no defaults.
 * `selfProtection.enabled` is the one switch that decides whether the model's
 * shell commands are confined, and a second reader that guessed at the shape
 * — or quietly substituted `false` for a malformed section — would be a
 * second answer to a security question. So the raw value goes straight to
 * `resolveSelfProtectionConfig`, which validates it against the schema that
 * also gates every config WRITE. The two therefore cannot disagree.
 *
 * A section that fails validation THROWS rather than degrading to "off".
 * Degrading would mean a typo in the config silently removes the sandbox,
 * which is the failure this whole module exists to prevent; the caller
 * (`server/landlock-runner.ts`) turns the throw into a refusal that names the
 * problem, so a run stops instead of running unconfined.
 */
export function getSelfProtectionConfig(): SelfProtectionConfig {
  return resolveSelfProtectionConfig(readHarnessConfig());
}

// ── EXP474 codebase-file retrieval config ──
// Phrase n-gram + slot allocation + package/directory co-occurrence ranking.
// This accessor returns ONLY what the operator set; the defaults belong to
// the retrieval module itself and are applied when the bridge resolves them.
// It read as the owner of nineteen numbers it merely restated, and a value
// with two owners has two answers the moment either is edited. The imports
// are type-only, so the intelligence subsystem stays reachable solely through
// the bridge.
import type { Exp474RetrievalOverrides } from "../../engine/src/intelligence/retrieval.ts";

/**
 * The retrieval ranking knobs the operator actually set.
 *
 * This function used to restate all nineteen defaults as literals, which made
 * it a second owner of every one of them: the harness had the type, this file
 * had the numbers, and nothing connected the two. It now forwards only what
 * was set and leaves the defaults to the module those knobs belong to — the
 * same division `getHybridSearchOverrides` below already uses for the other
 * family of knobs in the same map.
 *
 * An unset knob is OMITTED rather than returned as `undefined`: those are
 * different statements, and the resolver refuses a knob name it does not know
 * rather than interpreting it.
 */
export function getExp474RetrievalConfig(): Exp474RetrievalOverrides {
  const cfg = readHarnessConfig().codeIntelligence?.retrieval;
  if (cfg === undefined) return {};
  const set: [string, number][] = [];
  for (const [key, value] of Object.entries(cfg)) {
    if (typeof value === "number" && Number.isFinite(value)) set.push([key, value]);
  }
  return Object.fromEntries(set) as Exp474RetrievalOverrides;
}

// ── Hybrid symbol-search ranking knobs ──
// Read from the same `codeIntelligence.retrieval` knob map as the accessor
// above, because this is the same concept (how search ranks results) and a
// second config section would be a second place to look for one answer.
//
// This returns ONLY what the operator actually set. It deliberately declares
// no floors: an omitted knob comes back `undefined` and the harness-side
// config owner supplies the default when it resolves. So each number exists
// in exactly one place, and this file cannot drift from the module that
// consumes it — which is also why the import below is type-only, keeping the
// intelligence subsystem reachable solely through the bridge.
import type { HybridSearchOptions } from "../../engine/src/intelligence/symbol-search.ts";

/** Which knobs exist, and what counts as a usable value for each. */
const HYBRID_SEARCH_KNOBS: ReadonlyArray<readonly [keyof HybridSearchOptions, "number" | "positiveInt"]> = [
  ["bm25K1", "number"],
  ["bm25B", "number"],
  ["hybridBm25Weight", "number"],
  ["hybridSpecificBm25WeightFloor", "number"],
  ["hybridVagueBm25WeightCeiling", "number"],
  ["searchBiasDirectoryThreshold", "number"],
  ["searchBiasMinResults", "positiveInt"],
  ["searchSealRatio", "number"],
  ["searchSealMinScore", "number"],
];

/**
 * The ranking knobs the operator actually set.
 *
 * An unset knob is OMITTED rather than returned as `undefined`, because those
 * are different statements: omitted means "the harness default applies", while
 * an explicit `undefined` would be a value the resolver has to interpret. The
 * compiler enforces the distinction here (`exactOptionalPropertyTypes`), so
 * the filter below is load-bearing rather than tidiness.
 */
export function getHybridSearchOverrides(): HybridSearchOptions {
  const cfg = readHarnessConfig().codeIntelligence?.retrieval;
  const set: [string, number][] = [];
  for (const [key, kind] of HYBRID_SEARCH_KNOBS) {
    const v = cfg?.[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (kind === "positiveInt" && (!Number.isInteger(v) || v <= 0)) continue;
    set.push([key, v]);
  }
  return Object.fromEntries(set) as HybridSearchOptions;
}

/**
 * Max bytes for an interactive artifact's HTML/JS content. The
 * server-side `create_artifact` tool rejects content above this bound so a
 * runaway/abusive artifact cannot bloat the DB or the chat. Safe floor
 * applied only when the section is absent.
 */
export function getArtifactMaxBytes(): number {
  const cfg = readHarnessConfig();
  const v = cfg.artifacts?.maxBytes;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 524_288;
}

/**
 * The `sandbox` attribute token the frontend applies to the artifact
 * iframe (security: ). Defaults to `allow-scripts` (scripts run,
 * but NO same-origin access — the artifact cannot touch the parent page
 * or its cookies/storage). MUST NOT include `allow-same-origin` (that
 * would let untrusted artifact JS read the parent's DOM/secrets).
 */
export function getArtifactIframeSandbox(): string {
  const cfg = readHarnessConfig();
  const v = cfg.artifacts?.iframeSandbox;
  return typeof v === "string" && v.length > 0 ? v : DEFAULT_ARTIFACT_SANDBOX;
}

/**
 * Number of hex characters used to derive the `artifactId` from the SHA-256
 * of the artifact content (the stable identifier stored in the tool-call
 * input + shown to the user). Was a hardcoded `slice(0, 16)` in
 * tool-executor.ts. Configurable via `artifacts.idLength`. The floor (16)
 * matches the prior hardcoded value (64 bits of entropy — collision-safe for
 * any realistic artifact count).
 */
const DEFAULT_ARTIFACT_ID_LENGTH = 16;

export function getArtifactIdLength(): number {
  const cfg = readHarnessConfig();
  const v = cfg.artifacts?.idLength;
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 64 ? v : DEFAULT_ARTIFACT_ID_LENGTH;
}

/**
 * How many distinct tool_calls argument payloads the redaction owner
 * memoises (`redactToolCallArguments`, server/redaction.ts). Loops, retries
 * and parallel batches replay identical argument JSON, and each replay used
 * to pay the full parse → redact → re-stringify cost; the memo makes a
 * replay a Map lookup. Bounded at this many entries with LRU eviction so
 * the memo cannot grow with the run — a missing/invalid value falls back to
 * the contract's declared default, which matches the shipped
 * `redaction.toolCallArgumentsCacheEntries`.
 */
export function getToolCallArgumentsCacheEntries(): number {
  const cfg = readHarnessConfig();
  const v = cfg.redaction?.toolCallArgumentsCacheEntries;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES;
}

// ── The privacy policy's config door ──
//
// THE MASKER'S POLICY, RESOLVED FROM THE CONFIG SECTION. The document's
// `privacy` section is turned into a `PrivacyPolicy` ONCE per config read
// and cached beside it: egress operations acquire a current policy once
// for their recursive walk, so the policy must be cheap to consult — the resolver
// runs only when the document's bytes actually changed (the content-cached
// parse returns the same frozen object until then, so the reference
// compare below is the whole invalidation).
//
// DEFAULT-PRESERVING: an absent section resolves to the defaults-only
// policy — the same values every masker path ran on before this wiring, so
// a config that does not mention `privacy` changes nothing. A section that
// would WEAKEN redaction (a narrowed category or classification list)
// throws here, typed, naming the refused values — the write gate refused
// it on the way in; this is the second door for bytes that never passed
// the gate (a hand-edited file). Fail closed, never clamped: silently
// honoring the weakening is the leak, and silently clamping it is a write
// that claims an effect nothing delivers.
let cachedPrivacySection: unknown;
let cachedPrivacyPolicy: PrivacyPolicy | undefined;

export function getPrivacyPolicy(): PrivacyPolicy {
  const section = readHarnessConfig().privacy;
  // The reference compare IS the invalidation, for the absent-section state
  // too: a document that gains or loses the section changes the reference,
  // and `undefined === undefined` keeps the defaults-only policy cached so
  // the egress hot path never rebuilds a policy it just built.
  if (cachedPrivacyPolicy !== undefined && cachedPrivacySection === section) {
    return cachedPrivacyPolicy;
  }
  const policy = createPrivacyPolicy(resolvePrivacyPolicyOptions(section));
  cachedPrivacySection = section;
  cachedPrivacyPolicy = policy;
  return policy;
}

// ── The debug bootstrap's config door ──
//
// THE ONE RESOLVER for the debug section. Before this door, the section was
// declared, write-gated, shipped in the file and consumed by NOTHING — the
// web server's bootstrap read one env var (`HARNESS_WEB_DEBUG=1`) and
// configured the debug system from the code defaults alone, so every config
// leaf was inert. This function composes the two sources ONE time, at boot:
//
//   PRECEDENCE (designed, not accidental): the document's `debug` section is
//   the SSOT for the system's SHAPE — level, categories, audit,
//   errorHandling, sinks, redaction all resolve from the file, and an absent
//   section leaves the caller's own defaults in charge (byte-identical to
//   the pre-wiring bootstrap). The env var is the process-level override for
//   exactly one leaf, the master `enabled` switch: `HARNESS_WEB_DEBUG=1` ORs
//   it on for THIS process — a dev/deployment turning debug on without
//   editing the shared file every process reads (node-config's named-env
//   precedent: a mapped variable overrides the file for the value it names;
//   anything but the positive "1" is absence and has no effect). The env
//   cannot turn OFF what the file turns on: no "0" semantics exist today,
//   and inventing one would let a deployment silently disable what the SSOT
//   declares — the override widens only.
//
//   THE STARTUP PIN: `resolveDebugConfigSection` enforces the section's
//   safety floor HERE, so a hand-edited file carrying
//   `debug.redaction.enabled: false` is a typed BOOT refusal (fail-closed,
//   naming the leaf) rather than a debug system that runs with its redactor
//   off — the same stance the masker's policy door takes for the privacy
//   section. The write gate already refuses such a section on the way in;
//   this is the second door for bytes that never passed it. The pin fires
//   whether or not debug is enabled: a weakened section is refused even
//   while the master switch is off, because the operator can flip the env
//   switch later without re-editing the file.

/** The resolved debug bootstrap: the base config the debug system is
 * configured from, and whether the boot may attach its console sink (the
 * section's own `sinks.enabledSinks` allow-list governs which destinations
 * may install — an operator who emptied the list gets a configured system
 * with no destinations, honoring "empty array = no sink may be installed at
 * all" rather than refusing a sink the operator explicitly did not name). */
export interface WebDebugBootstrap {
  readonly base: Partial<DebugConfig>;
  readonly consoleSinkAllowed: boolean;
}

export function resolveWebDebugBootstrap(): WebDebugBootstrap {
  const section = resolveDebugConfigSection(readHarnessConfig().debug);
  if (section === undefined) {
    // No section: the env gate alone decides, and the bridge's own defaults
    // shape the system — the exact bootstrap the env var drove before the
    // section was wired.
    return { base: { enabled: debugEnabled() }, consoleSinkAllowed: true };
  }
  return {
    base: { ...section, enabled: section.enabled || debugEnabled() },
    consoleSinkAllowed: section.sinks.enabledSinks.includes("console"),
  };
}

// ── Web-UI tunables (dependency-graph force layout + metrics polling) ──
// Single server-side owner of the `webUi.graph` + `webUi.metrics` config
// sections.
//
// The DEFAULTS and the readers themselves live in
// `shared/web-ui-defaults.ts` — ONE declaration compiled by both sides.
// This file used to carry its own 30-key `DEFAULT_GRAPH_CONFIG` table, its
// own `DEFAULT_METRICS_CONFIG` and its own copy of the whole key-by-key
// coercion body, byte-identical to the copy in `src/state/web-ui-config.ts`.
// Two copies of one table is a single-source-of-truth violation: a drift
// test could only report the divergence after it happened. Now the server
// projects the live config file through the SAME pure reader the client
// applies to the redacted snapshot — one canonical source, two projections,
// and no way for the two to disagree.

/** The full `webUi.graph` section with defaults applied for any missing key. */
export function getGraphConfig(): GraphConfig {
  return readGraphConfig(readHarnessConfig() as Readonly<Record<string, unknown>>);
}

/** The full `webUi.metrics` section with defaults applied for any missing key. */
export function getMetricsConfig(): MetricsConfig {
  return readMetricsConfig(readHarnessConfig() as Readonly<Record<string, unknown>>);
}

// ── Web-UI performance budget (the regression test's gate) ──
// The single server-side owner of the `webUi.performance` section. The
// regression test (`tests/performance/regression.test.ts`) imports this
// accessor and fails if any measured metric in the Playwright profile
// report exceeds its budget. Defaults are intentionally generous-but-real:
// the app lives on the same machine as the browser (no network latency), so
// page load is sub-second and interactions are sub-frame. The budget is the
// ceiling a metric may regress to before the gate trips — not a target.
//
// `clsMax` is 0.12 because the CLS metric's ambient noise band measured
// 0.087–0.1096 on an UNCHANGED tree, filed three times across rounds
// 12/14/15 (calm re-mints 0.087, first post-restart mints under load
// 0.109–0.1096): a budget set inside that band is a coin flip every
// mint, and "re-mint until calm" became an undocumented round step — a
// gate that needs a re-run ritual to pass teaches agents to re-run
// gates. 0.12 sits ~10% above the highest observed noise reading, so
// every value the band can produce passes and a real regression (a
// layout shift class worse than the ambient one) still reds; the old
// 0.1's only extra power was reding noise.
// `typingMeanMaxMs` is 60 because the measurement is SETTLE-INCLUSIVE: the
// probe brackets each keystroke from the input event to the frame AFTER the
// reactive render (the second of two chained rAFs), so the number contains
// one rendered-frame period by construction — the bracket cannot read
// below the page's own frame clock, and a budget of 16 (the old value)
// could never be met by an instantaneous app and was calibrated against a
// dispatch-only number (1.4ms) that measured playwright, not the user.
// The honest reading on the standing dev box measured 26.5ms mean (live
// 3-key sample, 2026-09-02; frame period 10.7–16.9ms) — the budget sits at
// ~2.3× that, above the render work the arm exists to catch (a keystroke
// whose reactive render blocks the frame past the settle window) while
// every healthy reading passes. The gate separately refuses a reading
// below the page's own measured frame period (a reverted dispatch-only
// bracket), so the floor and the ceiling are both owned.
// ONE SOURCE, NO SUBSTITUTE (UR-17): the
// config document is the only place a performance budget lives. A section or
// a field it does not declare, or declares invalid, is REFUSED by name —
// never quietly replaced by a number from code, which would let the gate
// judge against a value nobody configured.
// The budgets' names and kinds: the root policy's one list (`webPerformanceBudgets.kinds`), the schema's too.
const PERFORMANCE_BUDGET_KINDS: Readonly<Record<keyof PerformanceBudgetConfig, "positive" | "non-negative" | "positive-int">> = ROOT_POLICY.workflow.webPerformanceBudgets.kinds;

/** The full `webUi.performance` section, as the config document declares it — refused when it does not (no default). The single owner the regression test reads. */
export function getPerformanceBudgetConfig(): PerformanceBudgetConfig {
  const section = readHarnessConfig().webUi?.performance as Readonly<Record<string, unknown>> | undefined;
  if (section === undefined) throw new ConfigError("webUi.performance is not declared in bridlewise.config.json: the performance budgets live only there (no default in code)", "missing_performance_budget");
  const budget: Record<string, number> = {};
  for (const [field, kind] of Object.entries(PERFORMANCE_BUDGET_KINDS)) {
    const value = section[field];
    const valid = typeof value === "number" && Number.isFinite(value) &&
      (kind === "non-negative" ? value >= 0 : value > 0) && (kind !== "positive-int" || Number.isInteger(value));
    if (!valid) throw new ConfigError(`webUi.performance.${field} is ${value === undefined ? "not declared" : `invalid (${JSON.stringify(value)})`} in bridlewise.config.json: every performance budget is declared there, ${kind === "positive-int" ? "a positive integer" : kind === "non-negative" ? "a non-negative number" : "a positive number"}`, value === undefined ? "missing_performance_budget" : "invalid_performance_budget");
    budget[field] = value as number;
  }
  return Object.freeze(budget) as unknown as PerformanceBudgetConfig;
}

// ── Self-improving analyzer thresholds ──
// The single server-side owner of the `webUi.selfImproving` section.
// The analyzer (server/self-improving.ts) reads these thresholds so the
// suggestion logic has no inline magic numbers. Defaults match the values
// in bridlewise.config.json so a missing/partial section behaves
// identically to the documented defaults.

export type SelfImprovingConfig = Readonly<{
  minSampleCount: number;
  errorRateThreshold: number;
  slowToolMsThreshold: number;
  slowLlmMsThreshold: number;
  maxSuggestions: number;
}>;

const DEFAULT_SELF_IMPROVING_CONFIG: SelfImprovingConfig = {
  minSampleCount: 5,
  errorRateThreshold: 0.25,
  slowToolMsThreshold: 5000,
  slowLlmMsThreshold: 30000,
  maxSuggestions: 10,
};

/** A probability in [0,1] or the fallback when the config value is invalid. */
function asProbability(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

/** The full `webUi.selfImproving` section with defaults applied. */
export function getSelfImprovingConfig(): SelfImprovingConfig {
  const cfg = readHarnessConfig();
  const s = cfg.webUi?.selfImproving;
  if (s === undefined) return DEFAULT_SELF_IMPROVING_CONFIG;
  return {
    minSampleCount: asPositiveInt(s.minSampleCount, DEFAULT_SELF_IMPROVING_CONFIG.minSampleCount),
    errorRateThreshold: asProbability(s.errorRateThreshold, DEFAULT_SELF_IMPROVING_CONFIG.errorRateThreshold),
    slowToolMsThreshold: asPositiveNumber(s.slowToolMsThreshold, DEFAULT_SELF_IMPROVING_CONFIG.slowToolMsThreshold),
    slowLlmMsThreshold: asPositiveNumber(s.slowLlmMsThreshold, DEFAULT_SELF_IMPROVING_CONFIG.slowLlmMsThreshold),
    maxSuggestions: asPositiveInt(s.maxSuggestions, DEFAULT_SELF_IMPROVING_CONFIG.maxSuggestions),
  };
}

/** Convenience: the max nodes the dependency-graph route returns (capped by degree). */
export function getGraphMaxNodes(): number {
  return getGraphConfig().maxNodes;
}

// ── Quality scoring weights (single owner of the scoring model) ──
// The awareness-derived quality score starts at `scoreMax` and subtracts
// bounded penalties for each signal. Every weight below is the ONE owner of
// its default; the quality bridge reads them through `getQualityConfig`
// A weight of 0 is a
// VALID value (it disables that penalty), so these use a non-negative helper
// (not the > 0 `asPositiveNumber` — that would silently re-enable a
// disabled penalty by falling back to the default).

export type QualityConfig = Readonly<{
  scoreMax: number;
  scoreMin: number;
  penaltyCapIssuesPerKloc: number;
  penaltyCapHotspots: number;
  penaltyCapClones: number;
  penaltyCapUntyped: number;
  penaltyCapIssueDensity: number;
  penaltyWeightIssuesPerKloc: number;
  penaltyWeightHotspots: number;
  penaltyWeightClones: number;
  penaltyWeightUntyped: number;
  penaltyWeightIssueDensity: number;
  /** Number of top issue categories the quality recommendations list. 
   *  Was a hardcoded `slice(0, 3)` in quality-bridge.ts. */
  topCategoriesCount: number;
  lintGate: LintGateConfig;
}>;

const DEFAULT_QUALITY_CONFIG: Omit<QualityConfig, "lintGate"> = {
  scoreMax: 100,
  scoreMin: 0,
  penaltyCapIssuesPerKloc: 30,
  penaltyCapHotspots: 20,
  penaltyCapClones: 15,
  penaltyCapUntyped: 15,
  penaltyCapIssueDensity: 20,
  penaltyWeightIssuesPerKloc: 5,
  penaltyWeightHotspots: 2,
  penaltyWeightClones: 30,
  penaltyWeightUntyped: 20,
  penaltyWeightIssueDensity: 100,
  topCategoriesCount: 3,
};

/** A finite number >= 0 or the fallback (allows 0 to disable a penalty). */
function asNonNegativeNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** The full `webUi.quality` section with defaults applied. */
export function getQualityConfig(): QualityConfig {
  const cfg = readHarnessConfig();
  const q = cfg.webUi?.quality;
  if (q === undefined) return { ...DEFAULT_QUALITY_CONFIG, lintGate: resolveLintGateConfig(undefined) };
  return {
    scoreMax: asNonNegativeNumber(q.scoreMax, DEFAULT_QUALITY_CONFIG.scoreMax),
    scoreMin: asNonNegativeNumber(q.scoreMin, DEFAULT_QUALITY_CONFIG.scoreMin),
    penaltyCapIssuesPerKloc: asNonNegativeNumber(q.penaltyCapIssuesPerKloc, DEFAULT_QUALITY_CONFIG.penaltyCapIssuesPerKloc),
    penaltyCapHotspots: asNonNegativeNumber(q.penaltyCapHotspots, DEFAULT_QUALITY_CONFIG.penaltyCapHotspots),
    penaltyCapClones: asNonNegativeNumber(q.penaltyCapClones, DEFAULT_QUALITY_CONFIG.penaltyCapClones),
    penaltyCapUntyped: asNonNegativeNumber(q.penaltyCapUntyped, DEFAULT_QUALITY_CONFIG.penaltyCapUntyped),
    penaltyCapIssueDensity: asNonNegativeNumber(q.penaltyCapIssueDensity, DEFAULT_QUALITY_CONFIG.penaltyCapIssueDensity),
    penaltyWeightIssuesPerKloc: asNonNegativeNumber(q.penaltyWeightIssuesPerKloc, DEFAULT_QUALITY_CONFIG.penaltyWeightIssuesPerKloc),
    penaltyWeightHotspots: asNonNegativeNumber(q.penaltyWeightHotspots, DEFAULT_QUALITY_CONFIG.penaltyWeightHotspots),
    penaltyWeightClones: asNonNegativeNumber(q.penaltyWeightClones, DEFAULT_QUALITY_CONFIG.penaltyWeightClones),
    penaltyWeightUntyped: asNonNegativeNumber(q.penaltyWeightUntyped, DEFAULT_QUALITY_CONFIG.penaltyWeightUntyped),
    penaltyWeightIssueDensity: asNonNegativeNumber(q.penaltyWeightIssueDensity, DEFAULT_QUALITY_CONFIG.penaltyWeightIssueDensity),
    topCategoriesCount: asNonNegativeNumber(q.topCategoriesCount, DEFAULT_QUALITY_CONFIG.topCategoriesCount),
    // The section accessor must return EXACTLY what the section declares
    // (the drift guard walks the file's keys against this return). lintGate
    // keeps its single validating owner below and uses the same document
    // as the other quality fields, without a second filesystem read.
    lintGate: resolveLintGateConfig(q.lintGate),
  };
}

// ── Lint-gate thresholds (single owner of the lint verdict's contract) ──
// The lint auto-check verdicts against these DECLARED thresholds over the
// MEASURED sub-metrics — never against the composite score (a configured
// index, informational only). The schema contract (`webUi.quality.lintGate`
// in the harness config schema) declares the same shape + the same
// defaults; the quality bridge's recommendations read the SAME accessor so
// the recommendation thresholds and the gate thresholds cannot drift.

export type LintGateConfig = Readonly<{
  /** Issues per 1000 lines at/below which the codebase passes. */
  maxIssuesPerKloc: number;
  /** Complexity hotspots at/below which the codebase passes. */
  maxComplexityHotspots: number;
  /** Clone-coverage ratio (0–1) at/below which the codebase passes. */
  maxCloneRatio: number;
  /** Typed-file fraction (0–1) at/above which the codebase passes. */
  minTypedFileFraction: number;
}>;

/** Defaults match the shipped schema contract (`webUi.quality.lintGate`). */
const DEFAULT_LINT_GATE_CONFIG: LintGateConfig = {
  maxIssuesPerKloc: 10,
  maxComplexityHotspots: 5,
  maxCloneRatio: 0.15,
  minTypedFileFraction: 0.5,
};

/** A non-negative integer or the fallback (0 is valid — strictest gate). */
function asNonNegativeInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** A fraction in [0,1] or the fallback (mirrors the schema's min/max). */
function asFraction(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

/** The full `webUi.quality.lintGate` section with defaults applied. */
export function getLintGateConfig(): LintGateConfig {
  const cfg = readHarnessConfig();
  return resolveLintGateConfig(cfg.webUi?.quality?.lintGate);
}

// Both section getters resolve through this body. Passing the already-read
// section keeps one acquisition per public call without duplicating defaults.
function resolveLintGateConfig(g: NonNullable<NonNullable<HarnessConfigShape["webUi"]>["quality"]>["lintGate"]): LintGateConfig {
  if (g === undefined) return DEFAULT_LINT_GATE_CONFIG;
  return {
    maxIssuesPerKloc: asNonNegativeNumber(g.maxIssuesPerKloc, DEFAULT_LINT_GATE_CONFIG.maxIssuesPerKloc),
    maxComplexityHotspots: asNonNegativeInt(g.maxComplexityHotspots, DEFAULT_LINT_GATE_CONFIG.maxComplexityHotspots),
    maxCloneRatio: asFraction(g.maxCloneRatio, DEFAULT_LINT_GATE_CONFIG.maxCloneRatio),
    minTypedFileFraction: asFraction(g.minTypedFileFraction, DEFAULT_LINT_GATE_CONFIG.minTypedFileFraction),
  };
}

// ── Tool execution bounds (proactive: previously hardcoded in tool-executor.ts) ──

const DEFAULT_TOOL_BOUNDS = { timeoutMs: 30_000, maxOutputBytes: 524_288, maxFileBytes: 524_288 } as const;
const DEFAULT_SEARCH_LIMITS = { maxDepth: 5, maxResults: 50 } as const;
/**
 * Max bytes of stdout/stderr the auto-check runner (typecheck) captures per
 * subprocess (previously the inline literal `256 * 1024` in
 * auto-check-runner.ts). Configurable via
 * `tools.autoCheck.maxCaptureBytes`. The floor (262 144 = 256 KiB) matches
 * the prior hardcoded value so a missing/partial section behaves identically.
 */
const DEFAULT_AUTO_CHECK_MAX_CAPTURE_BYTES = 262_144;

/** The `tools.autoCheck.maxCaptureBytes` value (auto-check subprocess capture
 * cap) with the safe floor applied. */
export function getAutoCheckMaxCaptureBytes(): number {
  const cfg = readHarnessConfig();
  const v = cfg.tools?.autoCheck?.maxCaptureBytes;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_AUTO_CHECK_MAX_CAPTURE_BYTES;
}

/**
 * The tool bounds. `maxFileBytes` (the `read_file` and content-search cap) is
 * the DECLARED read leaf `tools.limits.maxReadBytes` — the one the engine's
 * own `read_file` reads — never the OUTPUT cap: it used to be derived from
 * `tools.defaultBounds.maxOutputBytes`, so raising the output limit silently
 * raised what a file read may load (CFG-0 B3; same value today, 1 MiB, so no
 * behaviour change). CFG-10 merges it with `serverConfig.maxFileReadBytes`.
 */
export function getToolBounds(fallback: { timeoutMs: number; maxOutputBytes: number; maxFileBytes: number } = DEFAULT_TOOL_BOUNDS): { timeoutMs: number; maxOutputBytes: number; maxFileBytes: number } {
  const cfg = readHarnessConfig();
  const bounds = cfg.tools?.defaultBounds;
  const readBytes = cfg.tools?.limits?.maxReadBytes;
  return {
    timeoutMs: typeof bounds?.timeoutMs === "number" && bounds.timeoutMs > 0 ? bounds.timeoutMs : fallback.timeoutMs,
    maxOutputBytes: typeof bounds?.maxOutputBytes === "number" && bounds.maxOutputBytes > 0 ? bounds.maxOutputBytes : fallback.maxOutputBytes,
    maxFileBytes: typeof readBytes === "number" && readBytes > 0 ? readBytes : fallback.maxFileBytes,
  };
}

export function getSearchLimits(fallback: { maxDepth: number; maxResults: number } = DEFAULT_SEARCH_LIMITS): { maxDepth: number; maxResults: number } {
  const cfg = readHarnessConfig();
  const tools = cfg.tools;
  return {
    maxDepth: typeof tools?.searchMaxDepth === "number" && Number.isInteger(tools.searchMaxDepth) && tools.searchMaxDepth > 0 ? tools.searchMaxDepth : fallback.maxDepth,
    maxResults: typeof tools?.searchMaxResults === "number" && Number.isInteger(tools.searchMaxResults) && tools.searchMaxResults > 0 ? tools.searchMaxResults : fallback.maxResults,
  };
}

/**
 * Max characters of a matching line the `search_code` tool includes in
 * each result (the `path:line: <preview>` the LLM reads). was a
 * hardcoded `lines[i].trim().slice(0, 200)` in tool-executor.ts (a
 * hardcoded configurable). Configurable via
 * `tools.searchLinePreviewMaxChars`. The floor (200) matches the prior
 * hardcoded value.
 */
const DEFAULT_SEARCH_LINE_PREVIEW_MAX_CHARS = 200;

export function getSearchLinePreviewMaxChars(): number {
  const cfg = readHarnessConfig();
  const v = cfg.tools?.searchLinePreviewMaxChars;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_SEARCH_LINE_PREVIEW_MAX_CHARS;
}

/**
 * How many matches `search_code` keeps COUNTING after it has already collected
 * everything it will show.
 *
 * The display cap and the scan cap used to be one number, and that is what made
 * a truncated search indistinguishable from a complete one: the walk stopped
 * the moment it had filled its quota, so the result could report "50 matches"
 * whether 50 or 50 000 existed. Counting past the display cap is what buys the
 * honest total. It stays bounded, because a pattern that matches every line of
 * a large tree must not turn the count into the expensive part.
 */
const DEFAULT_SEARCH_MAX_SCANNED_MATCHES = 5_000;

export function getSearchMaxScannedMatches(): number {
  const cfg = readHarnessConfig();
  const v = cfg.tools?.searchMaxScannedMatches;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_SEARCH_MAX_SCANNED_MATCHES;
}

/**
 * How long a single `search_code` may run before its worker thread is killed.
 *
 * This is a safety deadline, not a performance tuning knob. The search applies
 * a model-supplied regular expression to every line of the project, and a
 * pattern with nested quantifiers backtracks exponentially in the length of the
 * line it is matching — measured here, `(a+)+$` against one 35-character line
 * occupied a thread for 64.6 seconds inside a single uninterruptible call, and
 * two more characters multiplied that by seven. No
 * deadline checked between lines can end that, so the deadline is enforced by
 * the worker pool terminating the thread, and this is the number it uses.
 */
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

export function getSearchTimeoutMs(): number {
  const cfg = readHarnessConfig();
  const v = cfg.tools?.searchTimeoutMs;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_SEARCH_TIMEOUT_MS;
}

/**
 * Max dependency cycles the `get_dependency_graph` LLM tool includes in its
 * JSON output (the tool result the LLM reads — NOT the UI's
 * `webUi.graph.maxCyclesDisplayed` which caps the rendered chart). 
 * Was a hardcoded `cycles.cycles.slice(0, 10)` in tool-executor.ts (a
 * hardcoded configurable; the LLM tool output limit must be
 * tunable separately from the UI display limit). Configurable via
 * `tools.dependencyGraphMaxCycles`. The floor (10) matches the prior
 * hardcoded value.
 */
const DEFAULT_TOOL_DEPENDENCY_GRAPH_MAX_CYCLES = 10;

export function getToolDependencyGraphMaxCycles(): number {
  const cfg = readHarnessConfig();
  const v = cfg.tools?.dependencyGraphMaxCycles;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_TOOL_DEPENDENCY_GRAPH_MAX_CYCLES;
}

/**
 * Number of modules the `get_repository_map` LLM tool includes in its JSON
 * `moduleSample` (the preview the LLM reads — the full counts are separate).
 * Was a hardcoded `slice(0, 20)` in tool-executor.ts. Configurable via
 * `tools.repositoryMapSampleCount`. The floor (20) matches the prior
 * hardcoded value.
 */
const DEFAULT_REPOSITORY_MAP_SAMPLE_COUNT = 20;

export function getRepositoryMapSampleCount(): number {
  const cfg = readHarnessConfig();
  const v = cfg.tools?.repositoryMapSampleCount;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_REPOSITORY_MAP_SAMPLE_COUNT;
}

// ── Tool kind mapping (configurable tool categories) ──

/**
 * The default adapterId → ToolKind mapping. Each adapterId maps to a
 * granular category the Tools panel uses for filtering and sorting. This
 * is the built-in default; the config's `tools.kinds` section can override
 * any entry (configurable, not hardcoded). The keys here are
 * the adapterIds assigned in tools-bridge.ts; the values are the ToolKind
 * enum from shared/types.ts.
 *
 * Single source of truth: this map is the only place adapterId→kind is
 * defined. tools-bridge.ts consults getToolKind() (which reads this + the
 * config override) and never hardcodes a kind.
 */
const DEFAULT_TOOL_KIND_MAP: Readonly<Record<string, ToolKind>> = Object.freeze({
  "web-ui-filesystem": "filesystem",
  "web-ui-editor": "editor",
  "web-ui-intelligence": "intelligence",
  "web-ui-memory": "memory",
  "web-ui-quality": "quality",
  "web-ui-git": "git",
  "web-ui-git-governance": "git",
  "web-ui-artifact": "artifact",
  "builtin-execute-command": "system",
  "builtin-search-web": "network",
  "builtin-fetch-page": "network",
  "builtin-read-docs": "network",
  "builtin-repo-question": "network",
  "web-ui-control": "system",
  "web-ui-extension": "extension",
  "web-ui-agents": "system",
});

// The eleven members used to be written out again here, inside the type
// argument. That is a claim the compiler cannot check — a set holding fewer
// members is assignable to `Set<ToolKind>` — so a twelfth kind added to the
// owner and forgotten here typechecked in both programs while a config naming
// it failed this test and fell through to the default below. It is now the
// owner's own vocabulary, held in a closure nothing can name or mutate.
const isToolKind = memberOf(TOOL_KINDS);

/**
 * Resolve the ToolKind for an adapterId. Checks the config's `tools.kinds`
 * override first (so the user can remap), then falls back to the built-in
 * DEFAULT_TOOL_KIND_MAP. MCP adapterIds (prefix `mcp-`) always resolve to
 * "mcp" (they're server-level entries, not individually-categorized tools).
 * Unknown adapterIds default to "extension" (a safe catch-all for future
 * adapters).
 */
export function getToolKind(adapterId: string): ToolKind {
  // MCP server entries are always "mcp" (prefix match).
  if (adapterId.startsWith("mcp-")) return "mcp";
  const cfg = readHarnessConfig();
  const override = cfg.tools?.kinds?.[adapterId];
  if (isToolKind(override)) return override;
  return DEFAULT_TOOL_KIND_MAP[adapterId] ?? "extension";
}

/**
 * THE configured `runtime.responses` transport, RESOLVED (an absent section is
 * its schema's declared defaults) — the one server door for the limits every
 * Responses egress, observation and summary uses (a2-design M5: a caller that
 * got `undefined` fell back to code defaults behind the configured document).
 */
export function getResponsesTransportSettings(): ResponsesTransportConfig {
  return resolveResponsesTransportConfig(readHarnessConfig().runtime?.responses ?? {});
}
