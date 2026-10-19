/**
 * Exposure-module config sections — the config-schema owner for the knobs the
 * shared exposure modules publish as customizations.
 *
 * WHY THIS EXISTS
 *
 * Every exposure module (search, memory, awareness, …) publishes its operator
 * knobs as customizations that the settings UI renders automatically. Each of
 * those knobs declares a `configPath` so its value is backed by
 * `bridlewise.config.json` (the single source of truth for values) instead
 * of a per-process stub. For that binding to be deny-by-default — a knob the
 * config vocabulary does not declare refuses to register — the schema must
 * declare every bound path. This file is where those declarations live.
 *
 * THE IDIOM (the same one `performance`, `selfProtection` and `debug` already
 * follow): a module exports its section as a `z.strictObject`, and the central
 * contract (`config-contracts.ts`) splices it into the runtime schema as an
 * OPTIONAL top-level section. A module that wants to publish a NEW persistent
 * configurable adds its field to its section schema here (or exports its own
 * section schema from its module folder for a larger subsystem) and adds the
 * matching default to `bridlewise.config.json` — the settings UI then
 * surfaces it with no further wiring.
 *
 * Every field is OPTIONAL-with-no-default at the schema layer: the VALUE's
 * default lives in the config file and in the module's registration (the two
 * are kept in step by the config-binding seed), so the schema only bounds the
 * shape. This keeps a missing section indistinguishable from "all defaults",
 * which is what lets a fresh config omit every one of these sections.
 */

import { z } from "zod";

import { ENVIRONMENT_ALLOWLIST_ENTRY } from "../../process/environment-projection.ts";

const FINITE = z.number().finite();
const NONNEGATIVE_INT = z.number().int().nonnegative();
const POSITIVE_INT = z.number().int().positive();

/** Code search (`search` module). */
export const SEARCH_CONFIG_SCHEMA = z.strictObject({
  /** Minimum BM25 match score a result must reach to be kept. */
  threshold: FINITE.min(0).max(1).optional(),
  /** Most results a single search returns. */
  maxResults: POSITIVE_INT.optional(),
  /** How close an inexact term must be to count as a match. */
  fuzzyThreshold: FINITE.min(0).max(1).optional(),
  /** Seconds before the index counts as out of date and is rebuilt. */
  indexFreshnessSeconds: POSITIVE_INT.optional(),
  /** Milliseconds a single search may take before it is abandoned. */
  queryTimeoutMs: POSITIVE_INT.optional(),
  /** Result ordering. */
  sortBy: z.enum(["relevance", "recency", "score"]).optional(),
  /** Restrict searches to one programming language (empty = all). */
  languageFilter: z.string().optional(),
  /** Whether capitalisation separates two search terms. */
  caseSensitive: z.boolean().optional(),
});

/**
 * MCP (`mcp` module) — module-wide defaults applied to every configured MCP
 * server unless that server overrides them. Bound to the `tools.mcp` config
 * section (declared in `config-contracts.ts`, beside `tools.mcpServers`). The
 * per-server entries stay in `tools.mcpServers`; these are the shared defaults
 * an operator tunes once.
 */
export const MCP_CONFIG_SCHEMA = z.strictObject({
  /** Retries a failed MCP server connection/tool call gets. */
  retryCount: POSITIVE_INT.max(20).optional(),
  /** Milliseconds to wait before retrying an MCP call. */
  retryBackoffMs: FINITE.nonnegative().max(60_000).optional(),
  /** Milliseconds an MCP call may take before it times out. */
  timeoutMs: POSITIVE_INT.optional(),
  /** Milliseconds closing a server may take: a stdio server's polite-stop grace, a remote session's closing request. */
  closeGraceMs: POSITIVE_INT.max(60_000).optional(),
  /** Milliseconds before an interrupted server stream is resumed when the server named no delay (and the floor under one it named). */
  sseReconnectMs: POSITIVE_INT.max(60_000).optional(),
  /** The ceiling on a resume delay a server names. */
  sseRetryMaxMs: POSITIVE_INT.max(600_000).optional(),
  /** Resumes of one request's stream before it fails. */
  resumeAttempts: POSITIVE_INT.max(100).optional(),
  /** Server-sent requests waiting for an answer at once, per server. */
  serverRequestBacklog: POSITIVE_INT.max(1_000).optional(),
  /** Bytes of a local server's latest error output kept to explain why it stopped. */
  stderrTailBytes: POSITIVE_INT.max(1_048_576).optional(),
  /** Error-output lines per second, per local server, that reach the central log. */
  stderrLinesPerSecond: POSITIVE_INT.max(100_000).optional(),
  /**
   * The only variables of the harness's environment a local server inherits:
   * exact names or `PREFIX*` (a bare `*` and the harness's own `HARNESS_*`
   * namespace are refused — the one entry rule of the environment projection).
   */
  stdioInheritedEnv: z.array(ENVIRONMENT_ALLOWLIST_ENTRY).max(64).optional(),
  /**
   * The only environment variables `${VAR}` placeholders in a server entry
   * may read: exact names or `PREFIX*` — never a bare `*`, never the
   * harness's own `HARNESS_*` namespace (nor a prefix that would match it).
   */
  credentialEnv: z.array(ENVIRONMENT_ALLOWLIST_ENTRY).max(64).optional(),
});

// NOTE: the `memory`, `editor` and `tools` modules already own a top-level
// config section (`memory`, `editor`, `tools`), so their exposure knobs are
// declared THERE (in `config-contracts.ts`), not here — one section per
// module, no parallel home for the same namespace.

/** Context (`context` module) — the conversation-window knobs. */
export const CONTEXT_CONFIG_SCHEMA = z.strictObject({
  /** Most conversation held in the window at once, in tokens. */
  maxContext: POSITIVE_INT.optional(),
  /** Fraction full at which older parts start being trimmed. */
  trimThreshold: FINITE.min(0).max(1).optional(),
  /** Fraction of the conversation one trim pass drops. */
  trimStep: FINITE.min(0).max(1).optional(),
  /** Whether the standing instructions survive every trim. */
  preserveSystem: z.boolean().optional(),
  /** Whether the newest message survives every trim. */
  preserveLast: z.boolean().optional(),
  /** What a trim does with the dropped tokens. */
  compactStrategy: z.enum(["oldest", "summary", "vector"]).optional(),
  /** Memories injected per retrieval pass. */
  retrievalTopK: POSITIVE_INT.optional(),
  /** Relevance score a memory must reach to be recalled. */
  retrievalMinScore: FINITE.min(0).max(1).optional(),
});

/** Awareness (`awareness` module) — the self-monitoring knobs. */
export const AWARENESS_CONFIG_SCHEMA = z.strictObject({
  /** Token cap on the condensed self-monitoring view. */
  compactMaxTokens: POSITIVE_INT.optional(),
  /** Milliseconds between self-monitoring refreshes. */
  refreshIntervalMs: POSITIVE_INT.optional(),
  /** Whether the system watches itself in the background. */
  backgroundMonitor: z.boolean().optional(),
  /** Updates-per-second rate above which an alert is raised. */
  alertThreshold: FINITE.nonnegative().optional(),
  /** Which kind of information the monitoring view covers. */
  metric: z.enum(["all", "signals", "actions", "customizations"]).optional(),
  /** Comma-separated reading names to watch (empty = none). */
  enabledSignals: z.string().optional(),
  /** Comma-separated feature names to watch (empty = none). */
  monitoredModules: z.string().optional(),
  /** Whether reports include one row per watched reading. */
  detailedReport: z.boolean().optional(),
});

/** Bias (`bias` module). */
export const BIAS_CONFIG_SCHEMA = z.strictObject({
  /** Score a finding must reach to be flagged. */
  threshold: FINITE.min(0).max(1).optional(),
  /** What happens to a flagged finding. */
  preventionMode: z.enum(["off", "warn", "block"]).optional(),
  /** How much of each audited detection is recorded. */
  auditMode: z.enum(["off", "summary", "detailed"]).optional(),
  /** Comma-separated bias kinds under surveillance. */
  biasTypes: z.string().optional(),
  /** Whether audited inputs are recorded. */
  recordInputs: z.boolean().optional(),
  /** Whether findings are escalated to the operator. */
  escalateToOperator: z.boolean().optional(),
  /** Cap on the audit log's rows. */
  maxAuditRows: NONNEGATIVE_INT.optional(),
});

/** Hallucination (`hallucination` module). */
export const HALLUCINATION_CONFIG_SCHEMA = z.strictObject({
  /** Score a trap must reach to be caught. */
  threshold: FINITE.min(0).max(1).optional(),
  /** Grounding score evidence must reach. */
  groundingThreshold: FINITE.min(0).max(1).optional(),
  /** Whether a caught trap is corrected by default. */
  autoCorrect: z.boolean().optional(),
  /** Whether a missed trap is escalated. */
  escalateOnMiss: z.boolean().optional(),
  /** Comma-separated trap layers under watch. */
  layers: z.string().optional(),
  /** Which trap layers fire. */
  layerMode: z.enum(["all", "factual", "logical"]).optional(),
  /** Evidence items considered per claim. */
  evidenceTopK: POSITIVE_INT.optional(),
  /** Whether a correction triggers a re-prompt. */
  correctivePrompt: z.boolean().optional(),
});

/** Learning (`learning` module). */
export const LEARNING_CONFIG_SCHEMA = z.strictObject({
  /** Most learned rules kept. */
  maxRules: NONNEGATIVE_INT.optional(),
  /** Confidence a rule must hold to be kept. */
  minConfidence: FINITE.min(0).max(1).optional(),
  /** Improvement fraction below which learning counts as stalled. */
  plateauThreshold: FINITE.min(0).max(1).optional(),
  /** Observed errors between automatic re-learn passes. */
  relearnInterval: POSITIVE_INT.optional(),
  /** Whether a corrective rule is learned from each error. */
  autoLearnEnabled: z.boolean().optional(),
  /** Match score a rule must reach to be applied. */
  recallThreshold: FINITE.min(0).max(1).optional(),
});

/** Quality (`quality` module). */
export const QUALITY_CONFIG_SCHEMA = z.strictObject({
  /** Score below which a finding counts as Critical. */
  thresholdCritical: FINITE.min(0).max(1).optional(),
  /** Score below which a finding counts as High. */
  thresholdHigh: FINITE.min(0).max(1).optional(),
  /** Score below which a finding counts as Medium. */
  thresholdMedium: FINITE.min(0).max(1).optional(),
  /** Score below which a finding counts as Low. */
  thresholdLow: FINITE.min(0).max(1).optional(),
  /** Whether one Critical finding fails the check. */
  failOnCritical: z.boolean().optional(),
  /** Whether one High finding fails the check. */
  failOnHigh: z.boolean().optional(),
  /** Whether one Medium finding fails the check. */
  failOnMedium: z.boolean().optional(),
  /** Whether one Low finding fails the check. */
  failOnLow: z.boolean().optional(),
  /** Comma-separated check names to run (empty = none). */
  enabledChecks: z.string().optional(),
});

/**
 * Pre-dispatch tool-call gate, event-feed detector overrides, and the whole
 * `safety` section: MOVED to the safety domain's own section owner
 * (`engine/src/safety/safety-config-section.ts`) — the section outgrew this
 * file when it gained the gate and the detector families, and its posture
 * floors belong beside the detectors they arm. Nothing else moved.
 */
