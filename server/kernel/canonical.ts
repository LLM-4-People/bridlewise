/**
 * Canonical re-export hub — the single server-side import point for the
 * canonical harness Zod schemas, validation functions, and ROOT_POLICY
 * values.
 *
 * One owner for the relative path to the canonical source. All server
 * route files import from here (`./canonical.ts` or `../canonical.ts`),
 * never directly from `../../../bridlewise/src/...`.
 *
 * Runtime: Node.js with --experimental-strip-types resolves these relative
 * paths at load time. Type-checking: tsc follows the same chain.
 *
 * ── EVERY VALUE RE-EXPORT IS SPAN-DECORATED ────────────────────────────────
 *
 * Each value re-export below is a destructured binding from
 * `engineSpans(<module namespace>, "<architecture-module-id>")` — the
 * decoration owner that wraps every function-valued export with an
 * "engine" effect span, recorded only inside an ambient recording context.
 * This is the auto-instrumentation choke point: a NEW value re-export flows
 * through the same decoration the day it lands, and a bare
 * `export { … } from "../../engine/src/…"` value statement is refused by
 * tests/prevention/recording-choke-points.test.ts (class G) — deny by
 * default, no per-function opt-in. The reviewed hot-path/machinery
 * exclusions live in the owner's `ENGINE_SPAN_EXCLUSIONS` table; the
 * function manifest cross-check (engine/test/performance/function-manifest.test.ts)
 * validates them. `export type { … } from` statements carry no values and
 * stay bare.
 */

import { engineSpans } from "../../engine/src/performance/engine-instrumentation.ts";
import * as kernelContracts from "../../engine/src/kernel/contracts.ts";
import * as kernelConfig from "../../engine/src/kernel/config.ts";
import * as kernelConfigContracts from "../../engine/src/kernel/config-contracts.ts";
import * as sharedExposureConfigBinding from "../../engine/src/shared/exposure/config-binding.ts";
import * as sharedExposureModuleConfigSections from "../../engine/src/shared/exposure/module-config-sections.ts";
import * as kernelRootPolicy from "../../engine/src/kernel/root-policy.ts";
import * as kernelIntegrity from "../../engine/src/kernel/integrity.ts";
import * as kernelSafeStructural from "../../engine/src/kernel/safe-structural.ts";
import * as sharedBestEffort from "../../engine/src/shared/best-effort.ts";
import * as processFaultPolicy from "../../engine/src/process/fault-policy.ts";
import * as processWorkerBootstrap from "../../engine/src/process/worker-bootstrap.ts";
import * as sharedFaultDescription from "../../engine/src/shared/fault-description.ts";
import * as selfProtectionIndex from "../../engine/src/filesystem/self-protection/index.ts";
import * as toolsToolManifest from "../../engine/src/tools/tool-manifest.ts";
import * as toolsBuiltInToolManifest from "../../engine/src/tools/built-in-tool-manifest.ts";
import * as timelineTypes from "../../engine/src/timeline/timeline-types.ts";
import * as agentsAgentState from "../../engine/src/agents/agent-state.ts";
import * as repositoryPathContracts from "../../engine/src/repository-path/contracts.ts";
import * as privacyClassificationCatalog from "../../engine/src/privacy/classification-catalog.ts";
// The privacy config section's owner: the section schema (spliced into the
// config document the write gate validates) + the config door that turns a
// parsed section into policy options, refusing a section that would weaken
// what the masker hides.
import * as privacyConfigSection from "../../engine/src/privacy/privacy-config-section.ts";
// The debug config section's owner: the section schema (spliced into the
// config document the write gate validates) + the config door that turns a
// parsed section into the debug bootstrap's base config, refusing a section
// that would switch the debug redactor off.
import * as sharedDebugConfig from "../../engine/src/shared/debug/debug-config.ts";
import * as privacyPrivacyPolicy from "../../engine/src/privacy/privacy-policy.ts";
import * as sharedLlmConfig from "../../engine/src/shared/llm/config.ts";
import * as performanceMetricsCollector from "../../engine/src/performance/metrics-collector.ts";
import * as performanceConfig from "../../engine/src/performance/performance-config.ts";
import * as performanceConfiguredPerformance from "../../engine/src/performance/configured-performance.ts";
import * as memoryMemoryStore from "../../engine/src/memory/memory-store.ts";
import * as memoryMemoryTypes from "../../engine/src/memory/memory-types.ts";
import * as sharedTypeGuards from "../../engine/src/shared/type-guards.ts";
import * as timelineStore from "../../engine/src/timeline/timeline-store.ts";
import * as timelineQuery from "../../engine/src/timeline/timeline-query.ts";
import * as timelineRecorder from "../../engine/src/timeline/timeline-recorder.ts";
import * as sharedExposureIndex from "../../engine/src/shared/exposure/index.ts";
import * as timelineEffectSink from "../../engine/src/timeline/effect-sink.ts";
import * as timelineEffectDocuments from "../../engine/src/timeline/effect-documents.ts";
import * as timelineRecordedEffect from "../../engine/src/timeline/recorded-effect.ts";
import * as timelineRecordingContext from "../../engine/src/timeline/recording-context.ts";
import * as ledgerPrimitives from "../../engine/src/timeline/ledger-primitives.ts";
import * as timelineTimelineConfig from "../../engine/src/timeline/timeline-config.ts";
import * as sharedExposureRegistrationsIndex from "../../engine/src/shared/exposure/registrations/index.ts";
import * as filesystemPrivateState from "../../engine/src/filesystem/private-state.ts";
import * as intelligenceTypes from "../../engine/src/intelligence/intelligence-types.ts";
import * as agentsAgentTypeRegistry from "../../engine/src/agents/agent-type-registry.ts";
import * as agentsAgentConfig from "../../engine/src/agents/agent-config.ts";
import * as agentsAgentsConfig from "../../engine/src/agents/agents-config.ts";
import * as runtimeRuntimeConfig from "../../engine/src/runtime/runtime-config.ts";
import * as runtimeAgentTools from "../../engine/src/runtime/agent-tools.ts";
import * as runtimeOrchestratorTools from "../../engine/src/runtime/orchestrator-tools.ts";
import * as runtimeToolRegistry from "../../engine/src/runtime/tool-registry.ts";
import * as runtimeProviderAdapter from "../../engine/src/runtime/provider-adapter.ts";
import * as mcpConfig from "../../engine/src/mcp/config.ts";
import * as mcpRegistry from "../../engine/src/mcp/registry.ts";
import * as mcpFactory from "../../engine/src/mcp/factory.ts";
import * as mcpToolNaming from "../../engine/src/mcp/tool-name.ts";
import * as mcpUnavailability from "../../engine/src/mcp/unavailability.ts";
import * as mcpHeaders from "../../engine/src/mcp/headers.ts";
import * as extensionsIndex from "../../engine/src/extensions/index.ts";
import * as safetyToolCallGate from "../../engine/src/safety/tool-call-gate.ts";
import * as sharedExposureRegistrationsHallucination from "../../engine/src/shared/exposure/registrations/hallucination.ts";
import * as sharedExposureRegistrationsSafety from "../../engine/src/shared/exposure/registrations/safety.ts";
import * as safetyWorkaroundDetector from "../../engine/src/safety/workaround-detector.ts";
import * as safetyBandaidDetector from "../../engine/src/safety/bandaid-detector.ts";
import * as safetyStepSkipDetector from "../../engine/src/safety/step-skip-detector.ts";
import * as safetyDeviationDetector from "../../engine/src/safety/deviation-detector.ts";
import * as safetyBandaidConfig from "../../engine/src/safety/bandaid-config.ts";
import * as safetyConfigSection from "../../engine/src/safety/safety-config-section.ts";
import * as safetyInvestigation from "../../engine/src/safety/investigation.ts";
import * as safetyPauseAsk from "../../engine/src/safety/pause-ask.ts";
import * as performanceEngineInstrumentation from "../../engine/src/performance/engine-instrumentation.ts";

// ── Contracts (Zod schemas) ──
export const { MODEL_EVENT_SCHEMA, USAGE_SCHEMA, TOOL_RESULT_SCHEMA, CONTRACT_ERROR_SCHEMA, MODEL_REQUEST_SCHEMA } =
  engineSpans(kernelContracts, "src-kernel-contracts");

// ── Config (Zod schema + types) ──
// The ONE config read/refusal API (absent → undefined; every other failure a
// typed refusal), shared by the engine and the server's config reader, and
// the one owner of where the config document lives.
export const { decodeConfigDocumentRaw, engineConfigDocumentPath, inspectConfigDocument, inspectConfigDocumentBytes, readConfigDocumentRawIfPresent } = engineSpans(kernelConfig, "src-kernel-config");
export type { SettingsStoreState } from "../../engine/src/kernel/config.ts";

// ── Config document schema + ROOT_POLICY-dependent compiled schema ──
export const { getConfigDocumentSchema } = engineSpans(kernelConfigContracts, "src-kernel-config-contracts");
// The MCP auth-token length bound the config schema enforces — the settings
// write door declares the same bound from this ONE owner.
export const { MCP_AUTH_TOKEN_MAX } = engineSpans(kernelConfigContracts, "src-kernel-config-contracts");
// The declared default for the timeline section's payload-capture switch, so
// the server's raw config reader and the config document schema cannot state
// the default twice.
export const { DEFAULT_CAPTURE_PROVIDER_PAYLOADS } = engineSpans(kernelConfigContracts, "src-kernel-config-contracts");
// The declared defaults for the memory section's capture-and-search limits —
// the one source the server's raw config readers fall back to when the
// document omits a leaf, so no reader can carry a private spelling of the
// same default.
export const {
  DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS,
  DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS,
  DEFAULT_MEMORY_PREVIEW_MAX_CHARS,
  DEFAULT_MEMORY_SEARCH_MAX_LIMIT,
  DEFAULT_MEMORY_RETRIEVAL_LIMIT,
  DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS,
} = engineSpans(kernelConfigContracts, "src-kernel-config-contracts");
// The declared default for the redaction section's memo bound — the one
// source the server's reader falls back to when the document omits the
// leaf, so the reader and the settings row can never state it twice.
export const { DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES } = engineSpans(kernelConfigContracts, "src-kernel-config-contracts");
export const { isConfigPathDeclared } = engineSpans(sharedExposureConfigBinding, "src-shared-exposure-config-binding");
// The `tools.mcp` section schema — the single bounds owner for the section
// (floors AND ceilings), re-validated on the read path so a document that
// bypassed the write gate is refused loudly instead of flowing an
// out-of-range bound into a transport.
export const { MCP_CONFIG_SCHEMA } = engineSpans(sharedExposureModuleConfigSections, "src-shared-exposure-module-config-sections");

// ── ROOT_POLICY (runtime invariants) ──
export const { ROOT_POLICY } = engineSpans(kernelRootPolicy, "src-kernel-root-policy");
export const { assertNotProxy, snapshotJsonValue } = engineSpans(kernelSafeStructural, "src-kernel-safe-structural");

// ── Integrity helpers ──
export const { canonicalHash, canonicalJson } = engineSpans(kernelIntegrity, "src-kernel-integrity");
export const { deepFreeze } = engineSpans(kernelIntegrity, "src-kernel-integrity");
// The canonical identifier generator. Every entity id the server mints (a
// request's trace id among them) carries the self-describing domain prefix
// and routes through this single owner — never a raw randomUUID.
export const { generateId } = engineSpans(kernelIntegrity, "src-kernel-integrity");
// Raw cryptographically-secure UUID for NON-identifier uniqueness (temp file
// names, nonces, the unique tail of a composite id). The owner's own
// contract: entity identifiers use generateId/generateShortId; this wrapper
// exists for the cases where a domain prefix would be nonsensical. Re-exported
// so the server's non-identifier uniqueness also routes through the ONE owner
// instead of importing node:crypto directly.
export const { randomUuid } = engineSpans(kernelIntegrity, "src-kernel-integrity");
// The canonical best-effort helper — run an observer/cleanup operation and
// log (never throw) on failure. The resource sampler's tick runs through it,
// like the effect sink.
export const { bestEffort } = engineSpans(sharedBestEffort, "src-shared-best-effort");
// The event loop's door (every timer, listener and completion callback the
// server registers) is the fault policy's own.
export const { guarded, registerFatalFaultRecorder } = engineSpans(processFaultPolicy, "src-process-fault-policy");
// Every worker thread starts on the fault policy's prelude for its role
// (SCALE-CR1-FIX H2); and the one total description of a thrown value.
export const { bootstrappedWorker } = engineSpans(processWorkerBootstrap, "src-process-worker-bootstrap");
export const { describeFault, describeFaultLine } = engineSpans(sharedFaultDescription, "src-shared-fault-description");

// ── Self-protection (the Landlock guardian) ──
// The harness OWNS every piece of Landlock reasoning: which flags exist, what
// the non-overridable floor allows, how an operator config becomes a spec, and
// whether this kernel can enforce any of it. The web server owns none of it —
// it only decides WHERE to apply the result (see server/landlock-runner.ts).
// Re-exported through this hub, like every other canonical import, so the
// relative path to the backend has exactly one owner.
export const {
  resolveSelfProtectionConfig,
  DEFAULT_SELF_PROTECTION_CONFIG,
  compileSelfProtectionConfigToSpec,
  verifyGuardianBinaryAvailability,
  resolveGuardianBinaryPath,
  classifyGuardianResult,
  guardianNoticeLinePattern,
  GUARDIAN_FAILURE_MARKER,
  PROJECT_ROOT_ACCESS_FLAGS,
  DEFAULT_TEMP_DIR_ACCESS,
  // The harness owns every question about where a path really points. The
  // server derives allow-rules, so it needs the SAME answer the compiler
  // refuses on — asking it here rather than re-deriving it is what keeps the
  // two from disagreeing about whether a rule has left the project.
  resolveLocation,
  identityOverlapIndex,
  createPathLocator,
  staysWithinRegion,
  invalidateProtectedNameCheck,
  // …and the harness owns the OTHER question about where a path really points:
  // whether the bytes behind it are reachable by a second name. Resolving a
  // path answers the symbolic-link half; a hard link has no target to follow,
  // so a gate that only resolves admits it. The repository readers have asked
  // this for a long time and this server did not, which was a live disclosure.
  //
  // THE FACT, NOT THE SELF-PROTECTION POLICY. `pathIsRefusedSecondName` asks
  // the harness's own tamper-resistance policy, which an operator legitimately
  // turns off for a workspace seeded with `cp -rl` — and that is a fact about
  // the HARNESS's tree, not about whether a path inside a user's project also
  // lives outside it. Routing containment through that policy meant one
  // environment variable answered two unrelated invariants, and measured end to
  // end it made this gate ADMIT a hard link pointing outside the project.
  pathHasSecondName,
  // …and the FACT from a link count already in hand, so a test that plants a
  // hard link asserts the plant with the owner's answer rather than writing a
  // second link-count verdict beside the one this whole estate exists to keep
  // singular.
  hasSecondName,
  // THE ONE KEEP-OUT LIST, asked about a folder the server is about to open
  // for a user and about every file its readers serve (cred-audit CRED-F11),
  // the same list every compiled spec is held to.
  keepOutPolicyFor,
  keepOutInForce,
  // The key home: where every harness key lives, admitted ONCE per host (the
  // one admission computes its neighbours), and its registry of harness stores
  // (an explicit dependency of the keep-out list and the key tool).
  admitHarnessKeyHome,
  databaseKeyName,
  databaseKeyFile,
  databaseSaltFile,
  registerHarnessStore,
  forgetHarnessStore,
  openStoreRegistry,
} = engineSpans(selfProtectionIndex, "self-protection-index");
export type {
  AdmittedKeyHome,
  HarnessStoreRegistry,
  KeepOutFacts,
  KeepOutPolicy,
  KeepOutQuestions,
  KeepOutVerdict,
  SelfProtectionConfig,
  GuardianSpec,
  GuardianBinaryAvailability,
  GuardianBinaryResult,
  LandlockAccessFsFlagName,
} from "../../engine/src/filesystem/self-protection/index.ts";

// ── Tool manifest validation ──
export const { validateToolManifestEntry, DEFAULT_TOOL_RESOURCE_BOUNDS } =
  engineSpans(toolsToolManifest, "tools-tool-manifest");

// ── Tool registry / built-in + runtime tool builders (for the tools route) ──
// THE MANIFEST, NOT THE ADAPTERS. This server has its own executor and its own
// sandbox; all it wants from the harness is the tool DESCRIPTIONS. Importing
// them from the adapter module used to drag `createExecuteCommandTool` — an
// unconfined spawn of a model-supplied program name — into this server's
// reachable set, one import away from any future call site. Measured on the
// import graph, which is the only thing that can see a capability arriving
// through a re-export.
export const { createBuiltInToolManifestEntries } = engineSpans(toolsBuiltInToolManifest, "src-tools-built-in-tool-manifest");
// NOTE: `createExtensionTools` (backend `list_extensions` RegisteredTool) is
// intentionally NOT re-exported here. The web UI owns its own `list_extensions`
// manifest entry (tools-bridge.ts) + executor handler (tool-executor.ts)
// that delegate to extensions-bridge — keeping the tool pipeline UNIFIED
// (ONE registry, ONE executor). The backend RegisteredTool has a different
// ToolContext shape and was never imported by the web UI (it was a dead
// re-export — dead exports removed).
export type { ToolDefinition, ChatMessage, ResponsesTransportConfig } from "../../engine/src/shared/llm/config.ts";
// The Responses transport section's resolver (the server's settings accessor).
export const { resolveResponsesTransportConfig } = engineSpans(sharedLlmConfig, "shared-llm-config");

// ── Timeline type guards + registries ──
export const {
  TIMELINE_EVENT_TYPES,
  TIMELINE_RECORD_KINDS,
  TIMELINE_EDGE_TYPES,
  TIMELINE_OUTCOMES,
  TIMELINE_CHECK_STATUS_DOCUMENT,
  isTimelineEventType,
  isTimelineRecordKind,
  isTimelineOutcome,
} = engineSpans(timelineTypes, "timeline-types");
// The effect-kind → ledger-lane mapping and the failure-verdict outcome
// disposition — timeline facts with ONE owner in the engine's vocabulary
// module, re-exported so the server's sinks and readers consume the same
// answers the harness runtime consumes (never a private restatement).
export const {
  EFFECT_KIND_EVENT_TYPES,
  eventTypeForEffectKind,
  TIMELINE_FAILURE_OUTCOME_DISPOSITION,
  TIMELINE_FAILURE_OUTCOME_NAMES,
  decodeTokenUsageDocument,
} = engineSpans(timelineTypes, "timeline-types");

// ── Agent lifecycle states ──
export const { AGENT_LIFECYCLE_STATES } = engineSpans(agentsAgentState, "agents-agent-state");

// ── Repository path constants ──
export const {
  REPOSITORY_PATH_PROFILE,
  REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS,
  REPOSITORY_PATH_SETTINGS_SCHEMA_VERSION,
} = engineSpans(repositoryPathContracts, "repository-path-contracts");

// ── Classification catalog ──
export const { CONFIGURABLE_DEFAULT_CLASSIFICATIONS } = engineSpans(privacyClassificationCatalog, "src-privacy-classification-catalog");

// ── Privacy config section (the policy's config door) ──
// The section schema + the resolver that feeds the masker's policy. One
// owner for "what the config may say about redaction", reached through the
// hub so no server file takes a direct path into the privacy domain for it.
export const {
  PRIVACY_CONFIG_SCHEMA,
  privacyConfigViolations,
  privacyConfigRefusalMessage,
  resolvePrivacyPolicyOptions,
} = engineSpans(privacyConfigSection, "src-privacy-privacy-config-section");
// The policy constructor + the defaults-only policy the resolver feeds when
// the document omits the section, and the policy type the server's masker
// doors pass to the engine.
export const { createPrivacyPolicy, DEFAULT_PRIVACY_POLICY, redactionReplacement } = engineSpans(privacyPrivacyPolicy, "privacy-policy");
// The debug section's config door + its safety-floor owners, for the debug
// bootstrap's one resolver (server/kernel/harness-config.ts). The section
// schema itself is spliced into the config document inside the engine's
// config contract; the values here are the ones a resolving process calls.
// The schema + defaults ride beside the door (the bridge configures the
// system against them), so the debug subtree's engine module is reached
// only through this hub — the hub's derived deny-list enforces that.
export const {
  resolveDebugConfigSection,
  debugConfigViolations,
  debugConfigRefusalMessage,
  DEBUG_CONFIG_SCHEMA,
  DEBUG_CONFIG_DEFAULTS,
} = engineSpans(sharedDebugConfig, "src-shared-debug-debug-config");
export type { DebugConfig } from "../../engine/src/shared/debug/debug-config.ts";
export type { PrivacyPolicy, PrivacyPolicyOptions, RedactionCategory } from "../../engine/src/privacy/privacy-policy.ts";
export type { PrivacyConfigSection } from "../../engine/src/privacy/privacy-config-section.ts";

// ── Type-only re-exports (erased at compile time) ──
export type {
  ModelEvent,
  Usage,
  ToolResult,
  ContractError,
  ModelRequest,
} from "../../engine/src/kernel/contracts.ts";

export type {
  ConfigSnapshot,
  ConfigDocument,
} from "../../engine/src/kernel/config.ts";

export type {
  ToolManifestEntry,
  ToolCapability,
  ToolResourceBounds,
} from "../../engine/src/tools/tool-manifest.ts";

export type {
  TimelineEventRecord,
  TimelineEventType,
  TimelineRecordKind,
  TimelineOutcome,
  TimelineQueryFilter,
  TimelineQueryResult,
  TimelineActor,
  TimelineCorrelation,
  TimelineOccurrenceCounts,
  TimelineRecordingGapCounts,
  TimelineRunActivitySummary,
  TimelineRunTokenUsage,
  TimelineFileEffectFact,
  TimelineFileEffectFacts,
  TimelineFileEffectFactsFilter,
  TimelineCheckStatusFact,
  TimelineCheckStatusFacts,
  TimelineCheckStatusFactsFilter,
  TimelineSpectrum,
  TimelineSpectrumFilter,
} from "../../engine/src/timeline/timeline-types.ts";

export type {
  AgentState,
  AgentLifecycleState,
  AgentTurnRecord,
} from "../../engine/src/agents/agent-state.ts";

export type {
  MetricsSnapshot,
  MetricEntrySnapshot,
  MetricCorrelation,
  DurationHistogramSnapshot,
} from "../../engine/src/performance/metrics-collector.ts";

// ── Agent state store + metrics collector (runtime adapters) ──
export const { createAgentStateStore } = engineSpans(agentsAgentState, "agents-agent-state");
export type { AgentStateStore } from "../../engine/src/agents/agent-state.ts";
export const { createMetricsCollector, quantileFromHistogram } = engineSpans(performanceMetricsCollector, "performance-metrics-collector");
// The performance section's config contract — its declared defaults AND its
// own schema instance AND the diagnostic-mode vocabulary — so the settings
// room's array door validates against the engine's own leaf schema rather
// than a restated enum, and serves the vocabulary the diagnostic command
// itself consumes.
export const {
  DEFAULT_PERFORMANCE_CONFIG,
  DIAGNOSTIC_MODE_IDS,
  PERFORMANCE_CONFIG_SCHEMA,
} = engineSpans(performanceConfig, "performance-config");
// The one resolution of a document's performance section (undeclared = the
// declared default), shared with the engine CLI's reader (CFG-0 B4).
export const { performanceConfigOf } = engineSpans(performanceConfiguredPerformance, "src-performance-configured-performance");
// The declared defaults for the performance section's resource knobs, so the
// server's raw config reader and the config contract cannot state them twice
// (the same pattern as DEFAULT_CAPTURE_PROVIDER_PAYLOADS above).
export const {
  DEFAULT_RESOURCE_DELTAS_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
} = engineSpans(performanceConfig, "performance-config");
// The resource-delta probe — the ONE owner of the "what did this window cost"
// measurement (CPU time + heap growth). The effect wrapper and the metrics
// call sites both measure through it.
export const { startResourceDeltaProbe } = engineSpans(performanceMetricsCollector, "performance-metrics-collector");
export type { ResourceDelta } from "../../engine/src/performance/metrics-collector.ts";
export type { MetricsCollector } from "../../engine/src/performance/metrics-collector.ts";

// ── Memory store (runtime adapter) ──
export const { createMemoryStore } = engineSpans(memoryMemoryStore, "memory-memory-store");
// The memory TIER vocabulary. The harness owns the tier set; the web UI
// derives its zod enums and its query-param guard from it rather than
// restating the three strings (the routes previously mirrored them twice).
// `isMemoryTier` travels WITH the vocabulary on purpose. A consumer that
// imports the list and then builds its own membership set has made a second
// answer to one question, and a `Set` built from the list can still be made to
// disagree with it. The owner's predicate keeps its members in a closure
// nothing can name.
export const { isMemoryTier, MEMORY_TIERS } = engineSpans(memoryMemoryTypes, "memory-memory-types");
// The memory config resolver — pure (config-shape validation + declared
// defaults), reached through the hub like every other canonical import.
// Called with no arguments it is also the one door to the memory defaults
// themselves (the search-result limit the web server's search route falls
// back to and the settings row declares): a default the memory module
// resolves itself is handed out through the resolver, never as a bare
// constant.
export const { resolveMemoryConfig } = engineSpans(memoryMemoryTypes, "memory-memory-types");
// The agnostic way to turn ANY declared vocabulary into a membership test with
// no mutable handle — the shared owner, so a consumer never writes its own.
export const { memberOf, isPlainObject } = engineSpans(sharedTypeGuards, "shared-type-guards");
export type { MemoryStore } from "../../engine/src/memory/memory-store.ts";
export type {
  MemoryEntry,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryTier,
  MemoryConfig,
} from "../../engine/src/memory/memory-types.ts";

// ── Timeline store / query / recorder (runtime adapters) ──
export const { createTimelineStore, pendingTimelineMigrations, migrateTimelineFile } = engineSpans(timelineStore, "timeline-store");
export const { createTimelineQuery } = engineSpans(timelineQuery, "timeline-query");
export const { createTimelineRecorder } = engineSpans(timelineRecorder, "timeline-recorder");
export type {
  TimelineQuery,
  QueryOptions,
  TimelineSummary,
} from "../../engine/src/timeline/timeline-query.ts";
export type {
  TimelineRecorder,
  TimelineLifecycleInput,
  TimelineTokenUsageInput,
  TimelineEventRecordInput,
} from "../../engine/src/timeline/timeline-recorder.ts";
// The durable event-ledger storage contract the orchestrator's
// `OrchestratorToolsOptions.store` requires. `createTimelineStore` (above)
// returns exactly this port — the orchestrator records its run into the SAME
// persistent SQLite ledger the run route writes to, never a parallel store.
export type { EventLedgerStoragePort } from "../../engine/src/timeline/timeline-types.ts";

// ── Shared exposure system (signals, actions, customizations) ──
// The UI schema builder aggregates this metadata to drive the frontend
// dynamically. See server/schema/ui-schema.ts.
// `setCustomizationValue` is the VALIDATING write path (it runs the
// registry's declared type + min/max/enum checks before touching the owning
// module's state).
// `getCustomization` returns the raw entry whose `.set` is UNVALIDATED for
// hand-written registrations — every server write MUST go through
// `setCustomizationValue`, never `entry.set(...)` (enforced mechanically by
// tests/prevention/customization-write-path-owner.test.ts).
export const {
  listSignals,
  listActions,
  listCustomizations,
  readSignal,
  executeAction,
  getAction,
  getCustomization,
  setCustomizationValue,
  // The MODULE declarations — the plain-words category each namespace
  // declares beside its own signals/actions/customizations. The schema
  // builder forwards these so the settings surface groups by DECLARED data
  // rather than by a namespace→name table authored in a component.
  listExposureModules,
  getExposureModule,
  exposureModuleTitle,
  undeclaredModules,
  // Registry membership — the one authority for "this token is an id the
  // exposure registry itself minted". The egress redaction walk consumes it
  // so an identifier this server authored and expects back is never read as
  // a credential on its way to the browser; the answer comes from the live
  // registry (the mint), never from a restated list.
  isRegistered,
} = engineSpans(sharedExposureIndex, "shared-exposure-index");
export type {
  Signal,
  Action,
  Customization,
  ExposureModule,
} from "../../engine/src/shared/exposure/index.ts";
// The shared exposure id grammar + catalog primitives. Re-exported through
// the canonical hub so `server/` never reaches into the harness tree
// directly — one import boundary, not one per consumer.
export const { isValidExposureId, createCatalog } = engineSpans(sharedExposureIndex, "shared-exposure-index");
export const { resolveContract, isContractSpecified } = engineSpans(sharedExposureIndex, "shared-exposure-index");
export type { ExposureContract, ResolvedContract } from "../../engine/src/shared/exposure/index.ts";
// Effect recording — wrapping work so performing it IS recording it.
export const { createTimelineEffectSink } = engineSpans(timelineEffectSink, "src-timeline-effect-sink");
export const { projectEffectDocuments } = engineSpans(timelineEffectDocuments, "src-timeline-effect-documents");
export const { recordEffect, recordEffectAsync, setEffectSink } = engineSpans(timelineRecordedEffect, "src-timeline-recorded-effect");
export type { EffectRecord, EffectOutcome, EffectDocument } from "../../engine/src/timeline/recorded-effect.ts";
// The ambient recording context. Re-exported through the canonical hub so
// `server/` reaches the harness through ONE import boundary.
export const {
  withRecordingContext,
  withSpan,
  currentActor,
  currentRecordingContext,
  amendRecordingContext,
} = engineSpans(timelineRecordingContext, "src-timeline-recording-context");
export type { RecordingActor, RecordingContext } from "../../engine/src/timeline/recording-context.ts";
// The ledger's own field bound. Re-exported so anything writing a ledger
// string sizes it against the LEDGER's limit rather than inventing a second
// number that can drift from the one the store enforces.
export const { MAXIMUM_DESCRIPTION_BYTES } = engineSpans(ledgerPrimitives, "ledger-primitives");
// The ledger-text fitting routine — the ONE truncation that measures against
// the bound the store enforces. Both effect sinks consume this owner; a
// private copy in a sink is a second byte-measuring routine that can accept
// what the store refuses.
export const { truncateForLedger } = engineSpans(ledgerPrimitives, "ledger-primitives");
// The ledger's per-document byte default. The same rationale: a writer that
// bounds documents against anything else is bounding against a number the
// store may not enforce.
export const { DEFAULT_MAXIMUM_DOCUMENT_BYTES, DEFAULT_SQLITE_BUSY_TIMEOUT_MS } = engineSpans(timelineTimelineConfig, "src-timeline-timeline-config");
// The truncation envelope's own overhead seed — a protocol constant of the
// bounded-document format, owned beside the document-format defaults.
export const { TRUNCATION_ENVELOPE_OVERHEAD_BYTES } = engineSpans(timelineTimelineConfig, "src-timeline-timeline-config");
export const { registerAllExposure, resetAllRegistrations, registerNetworkExposure, registerDatabaseExposure } = engineSpans(sharedExposureRegistrationsIndex, "shared-exposure-registrations-index");
// The web performance budget's ONE default table (its owner is the engine
// registration; harness-config's accessor applies it to a missing key).
// Config binding for exposure customizations. The server installs a
// `writeConfigRaw`-backed store so every config-bound customization persists
// through the deny-by-default config write gate. Re-exported through the hub
// so `server/` reaches it via the ONE import boundary.
export const { installCustomizationConfigStore } = engineSpans(sharedExposureIndex, "shared-exposure-index");
export type { CustomizationConfigStore } from "../../engine/src/shared/exposure/index.ts";

// ── Intelligence (repository map, dependency graph, symbol search, reuse) ──
// SPO (Intelligence bridge owner — Deny-by-Default): the VALUE
// forms (`generateRepositoryMap`, `createRepositoryMapCache`) are NOT re-
// exported here. The single owner of intelligence operations is
// `server/intelligence-bridge.ts`; re-exporting the value forms from this
// hub would expose a parallel import path that bypasses the bridge's
// fs-gate (ownership) + worker (non-blocking) choke points. The worker
// (`server/repository-map-worker.ts`) imports the value directly from the
// canonical source module (not through this hub) so it only evaluates the
// intelligence chain. Only the TYPE forms are re-exported (consumed by
// `intelligence-bridge.ts` + `auto-heal.ts` for type-only imports). The
// `INTELLIGENCE_SCHEMA_VERSION` constant is also re-exported (a runtime
// value) so the safety route's synthetic auto-heal test map can construct a
// valid `RepositoryMap` without hardcoding the schema-version string (no hardcoded values — the constant is the single source of truth).
export const { INTELLIGENCE_SCHEMA_VERSION } = engineSpans(intelligenceTypes, "intelligence-types");
export type { RepositoryMap, ModuleInfo, FileInfo, SymbolInfo } from "../../engine/src/intelligence/intelligence-types.ts";
export type { DependencyGraph, DependencyEdge, CycleResult, ImpactResult } from "../../engine/src/intelligence/intelligence-types.ts";

// ── Agent type registry ──
export const { AGENT_TYPE_IDS } = engineSpans(agentsAgentTypeRegistry, "agents-agent-type-registry");
export type { AgentTypeId, AgentTypeDefinition } from "../../engine/src/agents/agent-type-registry.ts";
export type { AgentProfile, AgentCapability, AgentsConfig, ProviderModelResolver, RuntimeProviderModel } from "../../engine/src/agents/agent-config.ts";
export const { resolveAgentsConfig, createProviderModelResolver, getAgentProfile, isPathInWriteSet, ABSENT_SECTION_AGENTS_CONFIG, DEFAULT_ALIGNMENT_MONITOR_INTERVAL_MS } = engineSpans(agentsAgentConfig, "agents-agent-config");
export const { AGENT_CAPABILITY_CATALOG } = engineSpans(kernelConfigContracts, "src-kernel-config-contracts");
// ── Agent delegation runtime (the engine's own agent substrate) ──
// Re-exported through the hub so the server's agent-runtime bridge (the ONE
// owner of web-run delegation, server/agent-runtime-bridge.ts) reaches the
// engine through the same boundary as every other canonical import. These
// are pure state-machine + registry builders: the tool registry executes
// handlers with no I/O of its own, and the agent tools perform no spawn and
// no filesystem access themselves (sub-agent LLM calls go through the
// ProviderAdapter the bridge hands them — the llm-bridge choke point — and
// sub-agent tool calls go through the web executor, which owns confinement).
export const { createAgentTools } = engineSpans(runtimeAgentTools, "runtime-agent-tools");
export type { AgentToolsOptions } from "../../engine/src/runtime/agent-tools.ts";
// The orchestration substrate (multi-agent coordination) rides the SAME
// boundary: the agent-runtime bridge builds its options from the same pieces
// (adapter, narrowed registry, durable ledger store, timeline) the single-
// agent tools already use.
export const { createOrchestratorTools } = engineSpans(runtimeOrchestratorTools, "runtime-orchestrator-tools");
export type { OrchestratorToolsOptions } from "../../engine/src/runtime/orchestrator-tools.ts";
export const { createToolRegistry } = engineSpans(runtimeToolRegistry, "runtime-tool-registry");
export type { ToolRegistry, RegisteredTool, ToolContext } from "../../engine/src/runtime/tool-registry.ts";
export const { createProviderAdapter } = engineSpans(runtimeProviderAdapter, "runtime-provider-adapter");
export type { ProviderAdapter, ProviderConfig, ChatStreamEvent } from "../../engine/src/runtime/provider-adapter.ts";
export const { DEFAULT_AGENT_TIMEOUT_MS } = engineSpans(agentsAgentsConfig, "src-agents-agents-config");
// The config-document resolvers for provider/model names — pure (no I/O),
// like resolveProvider/resolveModel beside them.
export const { resolveRuntimeConfig, resolveProvider, resolveModel } = engineSpans(runtimeRuntimeConfig, "runtime-config");

// ── Awareness engine + Quality (Single-Party-Owner ) ──
// The awareness VALUE forms (`createAwarenessEngine`, `configureAwareness`)
// + the quality VALUE form (`scoreQuality`) are NOT re-exported here. The
// single owners of awareness + quality operations are
// `server/awareness-bridge.ts` + `server/quality-bridge.ts`; re-exporting
// the value forms from this hub would expose a parallel import path that
// bypasses the bridges' fs-gate (ownership) + worker (non-blocking) choke
// points. The awareness worker (`server/awareness-worker.ts`) imports the
// value directly from the canonical source module (not through this hub)
// so it only evaluates the awareness chain — it IS the bridge's off-thread
// delegation. `scoreQuality` (the full aggregator's scoring) has NO web-UI
// consumer — the quality bridge derives its own score from the awareness
// engine's signals (the full aggregator requires tree-sitter WASM, not
// available in the server). Only the TYPE re-exports are kept (consumed by
// the bridge + auto-check-runner for type-only imports).
export type { AwarenessSnapshot } from "../../engine/src/awareness/types.ts";

// ── MCP config + runtime (the shared engine substrate) ──
// The web server hosts MCP clients in-process through the engine's own
// registry/factory — the single owner of connect/list/call/retry/restart.
// Re-exported through this hub so the relative path to the backend has one
// owner, like every other canonical import. The registry is a pure state
// machine around injectable transports (spawn/fetch/websocket are passed in
// by the hosting bridge), so no fs-gate or worker boundary is bypassed.
export const { normalizeMcpModuleConfig, validateMcpServerEntry, validateMcpModuleConfig, resolveMcpServerConfigs, MCP_CREDENTIAL_PLACEHOLDER, unresolvedCredentialPlaceholders, assertCredentialEnvPermitted } = engineSpans(mcpConfig, "src-mcp-config");
// The ONE MCP naming owner: the web host mints nothing and parses nothing —
// it asks for a harness name, and resolves a name back by registry lookup.
export const { mcpToolName, mcpToolNameHead, isMcpToolName, isMcpServerId, MCP_SERVER_ID_PATTERN, MCP_SERVER_ID_MAX_CHARACTERS } = engineSpans(mcpToolNaming, "src-mcp-tool-name");
export type { McpServerEntry, McpModuleConfig } from "../../engine/src/mcp/config.ts";
export const { createMcpRegistry } = engineSpans(mcpRegistry, "src-mcp-registry");
export type {
  McpRegistry,
  RegistryOptions as McpRegistryOptions,
  ServerSignals as McpServerSignals,
  ToolSignals as McpToolSignals,
  GlobalSignals as McpGlobalSignals,
} from "../../engine/src/mcp/registry.ts";
// The per-server registration schema the config document gate splices into
// `tools.mcpServers` — served on its own so a settings write door validates a
// candidate registration against the SAME instance the persisted document is
// held to (the wire contract cannot drift from the config one).
export const { getMcpServerConfigSchema } = engineSpans(kernelConfigContracts, "src-kernel-config-contracts");
// The client factory — one real connect for a single registration (the
// settings room's test verb). Same hub rule as the registry above.
export const { createMcpClientFromConfig } = engineSpans(mcpFactory, "src-mcp-factory");
export type { McpClientFactoryOptions } from "../../engine/src/mcp/factory.ts";
export type { McpToolRegistration } from "../../engine/src/mcp/registry.ts";
export const { mcpUnavailableReason } = engineSpans(mcpUnavailability, "src-mcp-unavailability");
export type { McpUnavailabilityKey } from "../../engine/src/mcp/unavailability.ts";
export type { McpClient } from "../../engine/src/mcp/core.ts";
export type { McpTool } from "../../engine/src/mcp/core.ts";
export const { redactHeaders, canonicalHeaderName } = engineSpans(mcpHeaders, "src-mcp-headers");

// ── Extensions ──
export const { EXTENSION_TYPES, EXTENSION_STATUSES, createExtensionManifest } = engineSpans(extensionsIndex, "extensions-index");
export type { ExtensionType, ExtensionStatus, ExtensionManifestEntry, ExtensionManifestSnapshot, ExtensionManifest } from "../../engine/src/extensions/index.ts";

// ── Pre-dispatch hallucination/safety gate (SPO, ) ──
// The SINGLE canonical owner of the tool-call safety gate is
// `integration/src/safety/tool-call-gate.ts`. The web-UI owner is
// `server/safety-bridge.ts` (a thin adapter — reuse the canonical
// gate, do NOT rebuild). Re-exporting the VALUE forms (`createToolCallGate`,
// `resolveToolCallGateConfig`) + the DEFAULT config here is SAFE because the
// gate is a pure state machine (no I/O, no fs-gate, no worker) — unlike the
// intelligence/awareness bridges whose value forms bypass the fs-gate. The
// gate performs ghost-tool detection, JSON-schema validation, and loop
// detection BEFORE a tool call reaches the executor. `ToolCall` is re-exported
// from `runtime/provider-adapter.ts` (the OpenAI tool-call shape the gate
// validates); `ToolDefinition` is already re-exported above from
// `shared/llm/config.ts` (structurally identical to the gate's expectation).
export const {
  createToolCallGate,
  resolveToolCallGateConfig,
  DEFAULT_TOOL_CALL_GATE_CONFIG,
} = engineSpans(safetyToolCallGate, "safety-tool-call-gate");
export type {
  ToolCallGate,
  ToolCallGateConfig,
  ToolCallGateOptions,
  BlockedToolCall,
  GateBlockReason,
  GateResult,
} from "../../engine/src/safety/tool-call-gate.ts";
export type { ToolCall } from "../../engine/src/runtime/provider-adapter.ts";

// ── Hallucination/safety gate-block counter owners (SPO) ──
// A gate block IS a caught hallucination; the exposure modules own their
// counters and expose these single write paths so the gate's choke point
// records a catch WITHOUT reaching into the modules' state directly. Pure
// in-process state writers (no I/O, no fs-gate) — safe to re-export like the
// gate's own value forms. The web-UI gate owner (`server/safety-bridge.ts`)
// calls these; no other module may.
export const { recordHallucinationGateBlock } = engineSpans(sharedExposureRegistrationsHallucination, "shared-exposure-registrations-hallucination");
export const { recordSafetyHallucinationGateBlock } = engineSpans(sharedExposureRegistrationsSafety, "shared-exposure-registrations-safety");

// ── Event-feed safety detectors (SPO) ──
// The engine's fully-built deterministic event-stream safety detectors
// (workaround, bandaid, step-skip, goal-deviation). The SINGLE web-UI owner
// that composes them per run is `server/safety-runtime-bridge.ts`; like the
// gate, the detectors are pure state machines (no I/O, no fs-gate, no
// worker), so the VALUE forms are safe to re-export through this hub — the
// one import boundary `server/` reaches the engine through. `resolveBandaidConfig`
// is the canonical validated resolver for the shared `BandaidConfig` all four
// detectors consume; the server config owner (`getEventFeedSafetyConfig` in
// harness-config.ts) hands the config file's `safety.eventFeed` overrides to
// it so the engine's validation is the only validation.
export const { createWorkaroundDetector } = engineSpans(safetyWorkaroundDetector, "src-safety-workaround-detector");
export type { ToolCallEvent, WorkaroundDetector, WorkaroundFinding, WorkaroundDetectionReport } from "../../engine/src/safety/workaround-detector.ts";
export const { createBandaidDetector } = engineSpans(safetyBandaidDetector, "src-safety-bandaid-detector");
export type { EditEvent, BandaidDetector, BandaidFinding, BandaidDetectionReport } from "../../engine/src/safety/bandaid-detector.ts";
export const { createStepSkipDetector } = engineSpans(safetyStepSkipDetector, "src-safety-step-skip-detector");
export type { StepSkipDetector, StepSkipFinding, StepSkipDetectionReport } from "../../engine/src/safety/step-skip-detector.ts";
export const { createDeviationDetector } = engineSpans(safetyDeviationDetector, "src-safety-deviation-detector");
export type { DeviationDetector, DeviationFinding, DeviationDetectionReport } from "../../engine/src/safety/deviation-detector.ts";
export const { resolveBandaidConfig } = engineSpans(safetyBandaidConfig, "src-safety-bandaid-config");
export type {
  BandaidConfig,
  BandaidConfigOverrides,
  BandaidSeverity,
  BandaidFamily,
} from "../../engine/src/safety/bandaid-config.ts";
// The safety section's posture floors — the ONE owner the write gate, the
// boot pin, and the per-run accessors all consult.
export const {
  safetyConfigViolations,
  safetyConfigRefusalMessage,
  assertSafetyGatePosture,
  assertSafetyEventFeedPosture,
  isSafetyPostureViolation,
  SAFETY_POSTURE_VIOLATION_CODES,
} = engineSpans(safetyConfigSection, "src-safety-safety-config-section");
export type { SafetyPostureFinding } from "../../engine/src/safety/safety-config-section.ts";
export const { createInvestigator, anyNeedsUserAction } = engineSpans(safetyInvestigation, "src-safety-investigation");
export type { Investigator, InvestigationResult, InvestigationContext, AnyFinding } from "../../engine/src/safety/investigation.ts";
export const { createPauseAskBuilder } = engineSpans(safetyPauseAsk, "src-safety-pause-ask");
export type { PauseAsk, PauseAskBuilder } from "../../engine/src/safety/pause-ask.ts";

// ── Live event-feed state source for the exposure signals ──
// The engine's safety registration owns the `safety.workaroundFindings` (etc.)
// signals; their values read through an installable source. The web safety-
// runtime owner installs one at boot that aggregates its per-run detectors, so
// the instruments show real verdicts. Re-exported through the hub like every
// other canonical import.
export const {
  installSafetyEventFeedStateSource,
  clearSafetyEventFeedStateSource,
  installIntelligenceMapCacheSource,
  installIntelligenceMapCacheInvalidate,
  clearIntelligenceMapCacheSource,
} = engineSpans(sharedExposureRegistrationsIndex, "shared-exposure-registrations-index");
export type { SafetyEventFeedState, SafetyEventFeedStateSource } from "../../engine/src/shared/exposure/registrations/index.ts";
export type { IntelligenceMapCacheState, IntelligenceMapCacheStateSource, IntelligenceMapCacheInvalidate } from "../../engine/src/shared/exposure/registrations/index.ts";

// ── Live performance metrics source for the exposure signals ──
// The engine's performance registration owns the `performance.*` signals;
// their values read through an installable source. The web metrics-bridge
// owner installs one at boot that reads the SAME bridge `/api/metrics`
// serves (the collector's snapshot + token throughput + the self-improving
// analyzer + the resource sampler's last tick) — one measurement owner,
// no second fetch path.
export const { installPerformanceMetricsSource, clearPerformanceMetricsSource } =
  engineSpans(sharedExposureRegistrationsIndex, "shared-exposure-registrations-index");
export type { PerformanceMetricsState, PerformanceMetricsStateSource } from "../../engine/src/shared/exposure/registrations/index.ts";

// ── Live re-hiding store source for the redaction exposure signal ──
// The engine's redaction registration owns the `redaction.*` signal; its
// value reads through an installable source. The web redaction owner
// (server/llm/redaction.ts) installs one at module scope that reads the
// SAME memo counters the observability reader serves — one measurement
// owner, no second fetch path.
export const { installRedactionMemoSource, clearRedactionMemoSource } =
  engineSpans(sharedExposureRegistrationsIndex, "shared-exposure-registrations-index");
export type { RedactionMemoState, RedactionMemoStateSource } from "../../engine/src/shared/exposure/registrations/index.ts";

// ── Live settings-store state source for the settings signals ──
// The engine's settings registration owns `settings.storeState`; the web
// config owner (server/kernel/harness-config.ts) is the process's one
// resolver of the store, so its snapshot's state is what the signal serves.
export const { installSettingsStoreStateSource } =
  engineSpans(sharedExposureRegistrationsIndex, "shared-exposure-registrations-index");

// ── The egress doors' fallback counts, for the `privacy.lastResortResponses`
// and `privacy.framesWithheld` signals (server/router/egress-failures.ts) ──
export const { installEgressFailureSource } =
  engineSpans(sharedExposureRegistrationsIndex, "shared-exposure-registrations-index");

// ── The one owned-temporary rule (a private per-run directory whose name
// carries its owner; what dead owners left is swept) ──
export const { createOwnedTemporaryDirectory, removeOwnedTemporaryDirectory, ensurePrivateStateDirectory } = engineSpans(filesystemPrivateState, "src-filesystem-private-state");

// ── The keep-out list in force, for the `safety.keepOut` signal ──
// The server's confinement owner computes it over its own facts.
export const { installKeepOutSource } =
  engineSpans(sharedExposureRegistrationsIndex, "shared-exposure-registrations-index");

// ── The web database's upgrade copies, for the `database.*` signals ──
export const { installDatabaseFactsSource, installDatabaseThreadsSource, installTimelineReadinessSource, installDatabaseKeyTool, installDatabaseShellOperations } =
  engineSpans(sharedExposureRegistrationsIndex, "shared-exposure-registrations-index");

// ── Engine-span re-entrancy suppression (the sink's own guard) ──
// The web effect sink writes ledger events through hub-imported helpers; an
// engine span emitted from inside that write would call the sink again. The
// sink wraps its body in this primitive, so the recording machinery can never
// observe itself. Re-exported through the hub like every other canonical
// value (and excluded from decoration by the owner's own reviewed table).
export const { withoutEngineSpans } = engineSpans(performanceEngineInstrumentation, "performance-engine-instrumentation");

import * as filesystemPersistedKey from "../../engine/src/filesystem/persisted-key.ts";
export const { resolvePersistedKey, persistedKeyDisposition, publishKeyMaterial, recordFieldsBound, registerCiphertextProbe, PERSISTED_KEY_BYTES, ADOPTED_FIXED_SALT_BYTES } = engineSpans(filesystemPersistedKey, "persisted-key");

// The on-disk files of one harness database (names only; the copy writers stay in server/db/db-files.ts).
import * as filesystemDatabaseFiles from "../../engine/src/filesystem/database-files.ts";
export const { findLegacyInstalls, legacyInstallIn, preMigrationBackupPath, preMigrationBackups, preRekeyCopyPath, preArchiveCopyPath, databaseArchiveFolder, stagingCopyPath, LEGACY_KEY_BASENAME, LEGACY_SALT_SUFFIX, NEXT_SUFFIX } = engineSpans(filesystemDatabaseFiles, "src-filesystem-database-files");
export type { LegacyInstall, LegacyInstallSearch } from "../../engine/src/filesystem/database-files.ts";
export type { PersistedKey, PersistedKeyOptions } from "../../engine/src/filesystem/persisted-key.ts";

// The WAL journal owner: entering WAL mode past a fresh file's concurrent first openers, and truthful checkpoints.
import * as filesystemSqliteWal from "../../engine/src/filesystem/sqlite-wal.ts";
export const { checkpointSqlite, establishWalJournal } = engineSpans(filesystemSqliteWal, "src-filesystem-sqlite-wal");

import * as encryptedField from "../../engine/src/privacy/encrypted-field.ts";
export const { createEncryptedFieldCodec, ENCRYPTED_FIELD_PREFIX, ENCRYPTED_FIELD_IV_BYTES, ENCRYPTED_FIELD_TAG_BYTES, UNBOUND_FIELD, fieldAad, ownerSealAad, OWNER_SEAL_METADATA_KEY } = engineSpans(encryptedField, "encrypted-field");
