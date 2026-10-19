import { z } from "zod";
import { RESPONSES_REQUEST_SCHEMA } from "../shared/llm/responses.ts";
import { RESPONSES_TRANSPORT_SCHEMA } from "../shared/llm/config.ts";
import { isProviderBaseUrl, isResponsesPath } from "../shared/llm/provider-endpoint.ts";

import { CONFIGURABLE_DEFAULT_CLASSIFICATIONS } from "../privacy/classification-catalog.ts";
import { canonicalHash, deepFreeze, type DeepReadonly, sha256HexSchema } from "./integrity.ts";
import { statePath } from "./product-identity.ts";
import {
  REPOSITORY_PATH_PROFILE,
  REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS,
  REPOSITORY_PATH_SETTINGS_SCHEMA_VERSION,
} from "../repository-path/contracts.ts";
import {
  PERFORMANCE_CONFIG_SCHEMA,
  performanceConfigRefusalMessage,
  performanceConfigViolations,
} from "../performance/performance-config.ts";
import { SELF_PROTECTION_CONFIG_SCHEMA } from "../filesystem/self-protection/self-protection-config.ts";
import { OUTBOUND_POLICY_SCHEMA } from "../shared/outbound-policy.ts";
import { DEBUG_CONFIG_SCHEMA, debugConfigRefusalMessage, debugConfigViolations } from "../shared/debug/debug-config.ts";
import {
  AWARENESS_CONFIG_SCHEMA,
  BIAS_CONFIG_SCHEMA,
  CONTEXT_CONFIG_SCHEMA,
  HALLUCINATION_CONFIG_SCHEMA,
  LEARNING_CONFIG_SCHEMA,
  MCP_CONFIG_SCHEMA,
  QUALITY_CONFIG_SCHEMA,
  SEARCH_CONFIG_SCHEMA,
} from "../shared/exposure/module-config-sections.ts";
// The safety section's own exported schema + posture floors — the safety
// domain declares its section (the module-exports-its-section idiom), and
// the floors refuse a section that would disarm a gate or a detector before
// a byte reaches disk. Spliced in here so the write gate enforces them with
// no safety-specific knowledge in this file.
import {
  SAFETY_CONFIG_SCHEMA,
  safetyConfigRefusalMessage,
  safetyConfigViolations,
} from "../safety/safety-config-section.ts";
import { ROOT_POLICY } from "./root-policy.ts";
import { MCP_SERVER_ID_MAX_CHARACTERS, MCP_SERVER_ID_PATTERN } from "../mcp/tool-name.ts";
import { relativePathViolationKinds } from "../filesystem/path-boundary.ts";
import { AGENT_TYPE_IDS } from "../agents/agent-type-registry.ts";
import { HISTORY_KEPT, SUITE_LEDGER_NAMES } from "../shared/run-history.ts";
import { MEMORY_SEARCH_ENGINE_KINDS } from "../memory/memory-types.ts";
import { INTELLIGENCE_SETTING_NAMES } from "../intelligence/intelligence-config.ts";
import { EXP474_RETRIEVAL_SETTING_NAMES } from "../intelligence/retrieval.ts";
// The privacy section's own exported schema — the privacy domain declares
// its section (the module-exports-its-section idiom the performance section
// established), including the safety floors that refuse a section which
// would weaken what the masker hides. Spliced in here so the document
// composition and the write gate enforce them with no privacy-specific
// knowledge in this file.
import { PRIVACY_CONFIG_SCHEMA } from "../privacy/privacy-config-section.ts";
import {
  GIT_AUTH_METHODS,
  GIT_CHECKOUT_POLICIES,
  GIT_LFS_MODES,
  GIT_RECONCILIATION_MODES,
  GIT_SUBMODULE_MODES,
  GIT_TRANSPORTS,
} from "../git/git-port.ts";

/**
 * The maximum length of an MCP server's auth token (api-key / bearer /
 * oauth). The bound the config document schema enforces for every auth
 * family, exported so the settings write door declares the same bound from
 * the ONE owner instead of restating the literal.
 */
/** The whole instruments a door can be (`testExecution.instrumentLock.wholeInstruments` declares which are heavy by kind). */
const WHOLE_INSTRUMENT_KINDS = ["playwright", "coverage", "profile", "slot", "flake-reproduction"] as const;
export type WholeInstrumentKind = typeof WHOLE_INSTRUMENT_KINDS[number];

export const MCP_AUTH_TOKEN_MAX = 4096;

const POLICY_STRING = z.string().min(1);
const POSITIVE_SAFE_INTEGER = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const AGENT_CAPABILITIES = deepFreeze(["read", "write", "execute", "delegate"] as const);
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

/**
 * Canonical URL regex (http/https). The single owner for the URL-pattern
 * concept consumed by the runtime/provider config schema and the MCP
 * module config validation (`src/mcp/config.ts`). Consumers import from
 * here so the pattern cannot drift.
 */
export const URL_PATTERN = /^https?:\/\/[^\s]+$/u;

/**
 * Canonical WebSocket URL regex (ws/wss). The single owner for the
 * ws-URL-pattern concept consumed by the MCP module config validation
 * (`src/mcp/config.ts`) for the `websocket` transport. Consumers import
 * from here so the pattern cannot drift.
 */
export const WS_URL_PATTERN = /^wss?:\/\/[^\s]+$/u;

/**
 * Default evaluation `maxOutputTokens` fallback. The canonical owner is the
 * `evaluation.maxOutputTokens` config field (with this default); the named
 * constant is the fallback when config is unavailable or when the matrix
 * generator / scenario runner is invoked without an explicit value
 * (Round 6 Category 26 finding: previously two inline `4096` literals with
 * no config owner).
 */
export const DEFAULT_EVALUATION_MAX_OUTPUT_TOKENS = 4096;
/**
 * R50: the production-grade matrix generator convenience constructor
 * (`createProductionConfig`) uses a larger output-token default than the dev
 * path. Previously a bare `16384` inline literal in matrix-generator.ts that
 * drifted from this owner. Owned here so the production default cannot silently diverge.
 */
export const DEFAULT_EVALUATION_PRODUCTION_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Long-task runner operational defaults. Previously hardcoded inline in
 * `src/tools/concurrent/long-task-runner.ts` (5000/15000/10000/10000/5000).
 * Owned here so the config file, the config schema, and the library
 * fallback all read from one source. The caller sources the resolved
 * config values and passes them via `LongTaskRunnerOptions`; the library
 * uses these as the fallback when the caller omits a value.
 */
export const DEFAULT_LONG_TASK_HEARTBEAT_MS = 10_000;
export const DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_LONG_TASK_SPAWN_TIMEOUT_MS = 15_000;
export const DEFAULT_LONG_TASK_KILL_TIMEOUT_MS = 10_000;
export const DEFAULT_LONG_TASK_LIST_TIMEOUT_MS = 5_000;

/**
 * Concurrent dispatcher truncation defaults. Previously hardcoded inline
 * in `src/tools/concurrent/dispatcher.ts` (100 minimum content cap, 20
 * truncation overhead estimate). Owned here so the config file, the config
 * schema, and the dispatcher all read from one source.
 */
export const DEFAULT_DISPATCHER_MIN_CONTENT_CHARS = 100;
export const DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS = 20;

/**
 * Timeline query default limit. Previously a hardcoded `1000` inline in
 * `src/timeline/timeline-query.ts`. Owned here so the config file, the
 * config schema, and the query accessor all read from one source.
 */
export const DEFAULT_TIMELINE_QUERY_LIMIT = 1000;

/**
 * The largest `workspaceGit.timeouts.commitMs`: a commit runs the
 * repository's hooks (both typecheck legs and `harness check` over the
 * staged tree), so the bound leaves room above a loaded machine's hook. One
 * value for the schema and the setting's exposure row (WF-1b3c-FIX MED-4).
 */
export const GIT_COMMIT_TIMEOUT_MAX_MS = 3_600_000;

/**
 * A repository-relative path: no absolute, backslash, control, empty or dot
 * segment ("." alone names the repository top level). One schema for every
 * declaration that names a path of the repository (the workspace commands and
 * links, a promotion profile's boundary).
 */
export const REPOSITORY_RELATIVE_PATH_SCHEMA = z.string().min(1).max(1024)
  .refine((path) => path === "." || relativePathViolationKinds(path).length === 0, "must be a repository-relative path");

/** The name of a command in the ONE command registry (`workspaceIsolation.commands`), as a phase or a promotion profile names it. */
export const WORKSPACE_COMMAND_NAME_SCHEMA = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

/**
 * Whether provider-interaction payload capture is on when the config file
 * does not say. On: the ledger exists to answer "what did the provider
 * actually send and receive?", the payloads are redacted before write, and
 * their size is bounded by `timeline.maxDocumentBytes`.
 */
export const DEFAULT_CAPTURE_PROVIDER_PAYLOADS = true;

/**
 * The `redaction` section's one bound: how many distinct tool-call argument
 * payloads the web server's redaction owner keeps an already-hidden copy of
 * when the config file does not say. Owned here so the schema, the settings
 * registration, and the server reader (`getToolCallArgumentsCacheEntries`)
 * all read one source — the value is the effective default that reader has
 * always shipped.
 */
export const DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES = 256;


/**
 * The `memory` section's capture-and-search limits: the ceilings and
 * fallbacks the web server's memory consumers apply when the config file
 * does not say. Each was previously a private fallback constant in
 * `server/kernel/harness-config.ts` beside a reader for a path this schema
 * refused to declare — a knob whose docstring said "configurable via
 * memory.…" while no sanctioned door could write it. Owned here so the
 * schema, the settings registration, and the server readers all read one
 * source. The values are the effective defaults those readers have always
 * shipped; declaring the leaves changes nothing until someone sets them.
 */
export const DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS = 2000;
export const DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS = 1000;
export const DEFAULT_MEMORY_PREVIEW_MAX_CHARS = 400;
export const DEFAULT_MEMORY_SEARCH_MAX_LIMIT = 1000;
export const DEFAULT_MEMORY_RETRIEVAL_LIMIT = 5;
export const DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS = 10_000;

/**
 * Default sort direction for the PAGINATED timeline query service
 * (`createTimelineQuery(...).all/byRun/byTurn/...`).
 *
 * Newest-first, because every consumer of a capped page wants the most recent
 * activity. The previous default was ascending, so a UI asking for 200 events
 * out of 26,635 received events 1–200 — the oldest in the ledger, frozen
 * forever, with nothing recent ever visible. The cap was doing the work of a
 * filter and choosing the wrong end of the ledger.
 *
 * This governs the query SERVICE only. The low-level storage port
 * (`EventLedgerStoragePort.query`) keeps its ascending default for the
 * chronological readers built on it (agent state reconstruction, memory
 * replay, workspace peek), which walk a run forward in time.
 */
export const DEFAULT_TIMELINE_QUERY_ASCENDING = false;

const CONFIG_CONTRACT_POLICY_PROJECTION_SCHEMA = z.object({
  configuration: z.object({
    documentSchemaVersion: POSITIVE_SAFE_INTEGER,
    maximumProjectIdCharacters: POSITIVE_SAFE_INTEGER,
    projectRootLiteral: POLICY_STRING,
    contract: z.object({
      sourcePath: POLICY_STRING,
      sourceSha256: sha256HexSchema,
      generatedSchemaPath: POLICY_STRING,
      validatorRevision: POLICY_STRING,
      schemaArtifactVersion: POLICY_STRING,
      compilerLimits: z.object({
        maximumPolicyStringCharacters: POSITIVE_SAFE_INTEGER,
        maximumProtocolIdentifiers: POSITIVE_SAFE_INTEGER,
      }),
    }),
  }),
  contracts: z.object({
    schemaDialect: POLICY_STRING,
    protocolIds: z.array(POLICY_STRING).min(1),
    modelProtocolIds: z.array(POLICY_STRING).min(1),
    mcpProtocolVersion: POLICY_STRING,
    chatStreamDoneSentinel: POLICY_STRING,
    unknownMetadataClassification: POLICY_STRING,
    limits: z.object({
      maximumIdentifierCharacters: POSITIVE_SAFE_INTEGER,
      maximumTextCharacters: POSITIVE_SAFE_INTEGER,
      maximumTools: POSITIVE_SAFE_INTEGER,
      maximumMessages: POSITIVE_SAFE_INTEGER,
      maximumEvents: POSITIVE_SAFE_INTEGER,
      maximumToolSchemaDepth: POSITIVE_SAFE_INTEGER,
      maximumToolSchemaProperties: POSITIVE_SAFE_INTEGER,
      maximumLosses: POSITIVE_SAFE_INTEGER,
    }),
  }),
  verification: z.object({
    testFixtures: z.object({
      repositoryRootCapability: z.object({
        budget: z.object({
          schemaVersion: POLICY_STRING,
          limitCeilings: z.object({
            maximumConcurrentBorrowsPerCapability: POSITIVE_SAFE_INTEGER,
            maximumOperationsPerBorrow: POSITIVE_SAFE_INTEGER,
            maximumBorrowOperationsPerCapability: POSITIVE_SAFE_INTEGER,
            maximumBorrowOperationsPerTask: POSITIVE_SAFE_INTEGER,
            maximumCapabilityRotationsPerTask: POSITIVE_SAFE_INTEGER,
            maximumBorrowedPathBytes: POSITIVE_SAFE_INTEGER,
            maximumBorrowedPathSegments: POSITIVE_SAFE_INTEGER,
          }),
        }),
      }),
    }),
  }),
  universalPolicyArchitecture: z.object({
    auditMatrix: z.object({
      alignmentCheckpoint: z.object({
        configurationLimits: z.object({
          maximumEventsBetweenCheckpoints: POSITIVE_SAFE_INTEGER,
          maximumActionsBetweenCheckpoints: POSITIVE_SAFE_INTEGER,
          maximumProviderInputTokensBetweenCheckpoints: POSITIVE_SAFE_INTEGER,
          maximumWallClockSecondsBetweenSafeBoundaryChecks: POSITIVE_SAFE_INTEGER,
          maximumProjectionBytes: POSITIVE_SAFE_INTEGER,
          maximumObserverInputTokens: POSITIVE_SAFE_INTEGER,
          selectableObserverProfiles: z.array(POLICY_STRING).min(1),
        }),
      }),
    }),
  }),
  runtime: z.object({
    implementation: POLICY_STRING,
    limits: z.object({
      maximumProviders: POSITIVE_SAFE_INTEGER,
      maximumModelsPerProvider: POSITIVE_SAFE_INTEGER,
      maximumRetries: POSITIVE_SAFE_INTEGER,
      maximumTimeoutMs: POSITIVE_SAFE_INTEGER,
      maximumInitialBackoffMs: POSITIVE_SAFE_INTEGER,
      maximumBackoffMs: POSITIVE_SAFE_INTEGER,
      maximumBackoffMultiplier: POSITIVE_SAFE_INTEGER,
      maximumMaxTokens: POSITIVE_SAFE_INTEGER,
      maximumTemperature: POSITIVE_SAFE_INTEGER,
      maximumSystemPromptBytes: POSITIVE_SAFE_INTEGER,
      maximumModelIdCharacters: POSITIVE_SAFE_INTEGER,
      maximumBaseUrlCharacters: POSITIVE_SAFE_INTEGER,
      maximumProviderIdCharacters: POSITIVE_SAFE_INTEGER,
      maximumApiKeyEnvVarCharacters: POSITIVE_SAFE_INTEGER,
      maximumAgents: POSITIVE_SAFE_INTEGER,
      maximumAgentNameCharacters: POSITIVE_SAFE_INTEGER,
      maximumAgentMaxTurns: POSITIVE_SAFE_INTEGER,
      maximumAgentTimeoutMs: POSITIVE_SAFE_INTEGER,
      maximumToolTimeoutMs: POSITIVE_SAFE_INTEGER,
      maximumToolOutputBytes: POSITIVE_SAFE_INTEGER,
      maximumToolMemoryBytes: POSITIVE_SAFE_INTEGER,
      maximumEnabledTools: POSITIVE_SAFE_INTEGER,
      maximumMcpServers: POSITIVE_SAFE_INTEGER,
      maximumMcpServerIdCharacters: POSITIVE_SAFE_INTEGER,
      maximumToolNameCharacters: POSITIVE_SAFE_INTEGER,
      maximumToolDescriptionCharacters: POSITIVE_SAFE_INTEGER,
      maximumToolIterations: POSITIVE_SAFE_INTEGER,
      maximumSseEventBytes: POSITIVE_SAFE_INTEGER,
      maximumSseLineBytes: POSITIVE_SAFE_INTEGER,
      maximumGitOutputBytes: POSITIVE_SAFE_INTEGER,
      maximumGitErrorBytes: POSITIVE_SAFE_INTEGER,
      maximumGitInputBytes: POSITIVE_SAFE_INTEGER,
      maximumRetryableStatusCodes: POSITIVE_SAFE_INTEGER,
    }),
  }),
  tools: z.object({
    implementation: POLICY_STRING,
    limits: z.object({
      maximumToolTimeoutMs: POSITIVE_SAFE_INTEGER,
      maximumToolOutputBytes: POSITIVE_SAFE_INTEGER,
      maximumToolMemoryBytes: POSITIVE_SAFE_INTEGER,
      maximumEnabledTools: POSITIVE_SAFE_INTEGER,
      maximumMcpServers: POSITIVE_SAFE_INTEGER,
      maximumMcpServerIdCharacters: POSITIVE_SAFE_INTEGER,
      maximumToolNameCharacters: POSITIVE_SAFE_INTEGER,
      maximumToolDescriptionCharacters: POSITIVE_SAFE_INTEGER,
      maximumReadBytes: POSITIVE_SAFE_INTEGER,
      maximumListEntries: POSITIVE_SAFE_INTEGER,
      defaultToolTimeoutMs: POSITIVE_SAFE_INTEGER,
      minimumLongTaskHeartbeatMs: POSITIVE_SAFE_INTEGER,
    }),
  }),
  editor: z.object({
    limits: z.object({
      maxFileBytes: POSITIVE_SAFE_INTEGER,
      maxPatchBytes: POSITIVE_SAFE_INTEGER,
      maxInsertTextBytes: POSITIVE_SAFE_INTEGER,
    }),
  }),
  timeline: z.object({
    limits: z.object({
      maxDocumentBytes: POSITIVE_SAFE_INTEGER,
      maxDocuments: POSITIVE_SAFE_INTEGER,
      maxEdges: POSITIVE_SAFE_INTEGER,
      maxDbFilenameCharacters: POSITIVE_SAFE_INTEGER,
      maxSqliteCacheSizeAbsolute: POSITIVE_SAFE_INTEGER,
      maxSqliteBusyTimeoutMs: POSITIVE_SAFE_INTEGER,
    }),
  }),
  resourceLock: z.object({
    limits: z.object({
      maxTimeoutMs: POSITIVE_SAFE_INTEGER,
      maxPollIntervalMs: POSITIVE_SAFE_INTEGER,
      maxStaleMs: POSITIVE_SAFE_INTEGER,
    }),
  }),
  evaluation: z.object({
    limits: z.object({
      maxIdentityAttestationTimeoutMs: POSITIVE_SAFE_INTEGER,
    }),
  }),
  migrationAuthority: z.object({
    limits: z.object({
      maxLeaseTtlMs: POSITIVE_SAFE_INTEGER,
      maxHeartbeatIntervalMs: POSITIVE_SAFE_INTEGER,
      maxRenewalCeilingMs: POSITIVE_SAFE_INTEGER,
      maxOrphanGraceMs: POSITIVE_SAFE_INTEGER,
      maxReconciliationTimeoutMs: POSITIVE_SAFE_INTEGER,
      maxResourcesPerLease: POSITIVE_SAFE_INTEGER,
      maxWaiters: POSITIVE_SAFE_INTEGER,
      maxBusyTimeoutMs: POSITIVE_SAFE_INTEGER,
      maxJournalEntriesPerLease: POSITIVE_SAFE_INTEGER,
      maxCheckpointCadenceMs: POSITIVE_SAFE_INTEGER,
      maxFencingGeneration: z.string().min(1),
    }),
    backend: z.object({
      candidate: z.string().min(1),
      requiredJournalMode: z.string().min(1),
      requiredSynchronous: z.string().min(1),
      requiredForeignKeys: z.boolean(),
      requiredDefensive: z.boolean(),
      walAllowed: z.boolean(),
    }),
    recovery: z.object({
      directionPreferenceDefault: z.enum(["previous", "next"]),
      blockedUnknownEffectPolicy: z.string().min(1),
    }),
  }),
}).superRefine((projection, context) => {
  const compilerLimits = projection.configuration.contract.compilerLimits;
  const policyStrings = [
    projection.configuration.projectRootLiteral,
    projection.configuration.contract.sourcePath,
    projection.configuration.contract.generatedSchemaPath,
    projection.configuration.contract.validatorRevision,
    projection.configuration.contract.schemaArtifactVersion,
    projection.contracts.schemaDialect,
    ...projection.contracts.protocolIds,
    ...projection.contracts.modelProtocolIds,
    projection.contracts.mcpProtocolVersion,
    projection.contracts.unknownMetadataClassification,
    projection.verification.testFixtures.repositoryRootCapability.budget.schemaVersion,
    projection.runtime.implementation,
    projection.tools.implementation,
    ...projection.universalPolicyArchitecture.auditMatrix.alignmentCheckpoint.configurationLimits
      .selectableObserverProfiles,
  ];
  if (policyStrings.some((value) => value.length > compilerLimits.maximumPolicyStringCharacters)) {
    context.addIssue({ code: "custom", message: "config contract policy string exceeds compiler limit" });
  }
  for (const [path, values] of [
    ["contracts.protocolIds", projection.contracts.protocolIds],
    ["contracts.modelProtocolIds", projection.contracts.modelProtocolIds],
    [
      "universalPolicyArchitecture.auditMatrix.alignmentCheckpoint.configurationLimits.selectableObserverProfiles",
      projection.universalPolicyArchitecture.auditMatrix.alignmentCheckpoint.configurationLimits
        .selectableObserverProfiles,
    ],
  ] as const) {
    if (values.length > compilerLimits.maximumProtocolIdentifiers) {
      context.addIssue({ code: "custom", message: `${path} exceeds compiler identifier limit` });
    }
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: `${path} must contain unique values` });
    }
  }
  const protocolIds = new Set(projection.contracts.protocolIds);
  if (projection.contracts.modelProtocolIds.some((value) => !protocolIds.has(value))) {
    context.addIssue({
      code: "custom",
      message: "contracts.modelProtocolIds must be a subset of contracts.protocolIds",
    });
  }
});

export type ConfigContractPolicyProjection = DeepReadonly<
  z.input<typeof CONFIG_CONTRACT_POLICY_PROJECTION_SCHEMA>
>;

type ProtocolSelectionConstraint = Readonly<{
  selectedField: "preferredModelProtocol";
  enabledField: "enabledProtocols";
  allowedSelectedValues: readonly string[];
  requireUniqueEnabledValues: boolean;
}>;

function compileProtocolSelectionConstraint(constraint: ProtocolSelectionConstraint) {
  const enabledArrayJsonSchema = deepFreeze(
    constraint.requireUniqueEnabledValues ? { uniqueItems: true } : {},
  );
  const objectJsonSchema = deepFreeze({
    allOf: constraint.allowedSelectedValues.map((value) => ({
      if: {
        required: [constraint.selectedField],
        properties: { [constraint.selectedField]: { const: value } },
      },
      then: {
        required: [constraint.enabledField],
        properties: {
          [constraint.enabledField]: {
            type: "array",
            contains: { const: value },
            minContains: 1,
          },
        },
      },
    })),
  });
  const refine = (
    contracts: Readonly<Record<string, unknown>>,
    context: z.RefinementCtx,
  ): void => {
    const selected = contracts[constraint.selectedField];
    const enabledValues = contracts[constraint.enabledField];
    if (!Array.isArray(enabledValues)) return;
    const enabled = new Set(enabledValues);
    if (constraint.requireUniqueEnabledValues && enabled.size !== enabledValues.length) {
      context.addIssue({ code: "custom", message: "enabled protocols must be unique" });
    }
    if (!enabled.has(selected)) {
      context.addIssue({ code: "custom", message: "preferred model protocol must be enabled" });
    }
  };
  return Object.freeze({ enabledArrayJsonSchema, objectJsonSchema, refine });
}

/**
 * Pure runtime compiler for the configuration contract. The
 * projection is bounded and validated before any schema is constructed.
 */
function buildRuntimeConfigContract<const Projection extends ConfigContractPolicyProjection>(
  projection: Projection,
) {
  CONFIG_CONTRACT_POLICY_PROJECTION_SCHEMA.parse(projection);
  const policy = projection;
  const alignmentLimits = policy.universalPolicyArchitecture.auditMatrix
    .alignmentCheckpoint.configurationLimits;
  const repositoryRootCapabilityBudget = policy.verification.testFixtures
    .repositoryRootCapability.budget;
  const repositoryRootCapabilityLimitCeilings = repositoryRootCapabilityBudget.limitCeilings;
  const protocolSelection = compileProtocolSelectionConstraint({
    selectedField: "preferredModelProtocol",
    enabledField: "enabledProtocols",
    allowedSelectedValues: policy.contracts.modelProtocolIds,
    requireUniqueEnabledValues: true,
  });
  type NonEmptyPolicyTuple<Value> = readonly [Value, ...Value[]];
  const protocolIds = policy.contracts.protocolIds as NonEmptyPolicyTuple<
    Projection["contracts"]["protocolIds"][number]
  >;
  const modelProtocolIds = policy.contracts.modelProtocolIds as NonEmptyPolicyTuple<
    Projection["contracts"]["modelProtocolIds"][number]
  >;
  const observerProfiles = alignmentLimits.selectableObserverProfiles as NonEmptyPolicyTuple<
    Projection["universalPolicyArchitecture"]["auditMatrix"]["alignmentCheckpoint"][
      "configurationLimits"
    ]["selectableObserverProfiles"][number]
  >;
  const enabledProtocolsSchema = z.array(z.enum(protocolIds))
    .min(1).max(protocolIds.length)
    .meta(protocolSelection.enabledArrayJsonSchema);
  const contractsSchema = z.strictObject({
    preferredModelProtocol: z.enum(modelProtocolIds),
    enabledProtocols: enabledProtocolsSchema,
    schemaDialect: z.literal(policy.contracts.schemaDialect),
    endpoints: z.strictObject({
      chatCompletions: z.literal("/v1/chat/completions"),
      responses: z.literal("/v1/responses"),
    }),
    mcpProtocolVersion: z.literal(policy.contracts.mcpProtocolVersion),
    chatStreamDoneSentinel: z.literal(policy.contracts.chatStreamDoneSentinel),
    responsesStore: z.literal(false),
    unknownMetadataClassification: z.literal(policy.contracts.unknownMetadataClassification),
    limits: z.strictObject({
      maximumIdentifierCharacters: z.number().int().positive()
        .max(policy.contracts.limits.maximumIdentifierCharacters),
      maximumTextCharacters: z.number().int().positive()
        .max(policy.contracts.limits.maximumTextCharacters),
      maximumTools: z.number().int().positive().max(policy.contracts.limits.maximumTools),
      maximumMessages: z.number().int().positive().max(policy.contracts.limits.maximumMessages),
      maximumEvents: z.number().int().positive().max(policy.contracts.limits.maximumEvents),
      maximumToolSchemaDepth: z.number().int().positive()
        .max(policy.contracts.limits.maximumToolSchemaDepth),
      maximumToolSchemaProperties: z.number().int().positive()
        .max(policy.contracts.limits.maximumToolSchemaProperties),
      maximumLosses: z.number().int().positive().max(policy.contracts.limits.maximumLosses),
    }),
  }).superRefine(protocolSelection.refine).meta(protocolSelection.objectJsonSchema);
  const runtimeLimits = policy.runtime.limits;
  const editorLimits = policy.editor.limits;
  const timelineLimits = policy.timeline.limits;
  const resourceLockLimits = policy.resourceLock.limits;
  const evaluationLimits = policy.evaluation.limits;
  const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
  const runtimeBehaviorLimitsSchema = z.strictObject({
    maximumToolIterations: z.number().int().positive().max(runtimeLimits.maximumToolIterations),
    agentTimeoutMs: z.number().int().positive().max(runtimeLimits.maximumAgentTimeoutMs).optional(),
    sseLimits: z.strictObject({
      maxEventBytes: z.number().int().positive().max(runtimeLimits.maximumSseEventBytes),
      maxLineBytes: z.number().int().positive().max(runtimeLimits.maximumSseLineBytes),
    }).optional(),
  });
  const retryConfigSchema = z.strictObject({
    maxRetries: z.number().int().nonnegative().max(runtimeLimits.maximumRetries),
    initialBackoffMs: z.number().int().positive().max(runtimeLimits.maximumInitialBackoffMs),
    maxBackoffMs: z.number().int().positive().max(runtimeLimits.maximumBackoffMs),
    backoffMultiplier: z.number().positive().max(runtimeLimits.maximumBackoffMultiplier),
    retryableStatusCodes: z.array(z.number().int().min(100).max(599))
      .max(runtimeLimits.maximumRetryableStatusCodes)
      .default([429, 500, 502, 503, 504]),
  });
  const modelConfigSchema = z.strictObject({
    id: z.string().min(1).max(runtimeLimits.maximumModelIdCharacters),
    maxTokens: RESPONSES_REQUEST_SCHEMA.shape.max_output_tokens.unwrap().unwrap().max(runtimeLimits.maximumMaxTokens),
    temperature: RESPONSES_REQUEST_SCHEMA.shape.temperature.unwrap().unwrap().max(runtimeLimits.maximumTemperature),
  });
  const providerConfigSchema = z.strictObject({
    id: z.string().min(1).max(runtimeLimits.maximumProviderIdCharacters)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    baseUrl: z.string().min(1).max(runtimeLimits.maximumBaseUrlCharacters)
      .refine(isProviderBaseUrl, "baseUrl must be an HTTP(S) URL without credentials, query or fragment"),
    apiKeyEnvVar: z.string().min(1).max(runtimeLimits.maximumApiKeyEnvVarCharacters)
      .regex(ENV_VAR_PATTERN, "apiKeyEnvVar must be an uppercase env var name"),
    timeoutMs: z.number().int().positive().max(runtimeLimits.maximumTimeoutMs),
    retries: retryConfigSchema,
    responsesPath: z.string().min(1).max(runtimeLimits.maximumBaseUrlCharacters)
      .refine(isResponsesPath, "responsesPath must be an absolute path without query or fragment")
      .default("/responses"),
    models: z.array(modelConfigSchema).min(1).max(runtimeLimits.maximumModelsPerProvider),
  });
  const userPreferencesConfigSchema = z.strictObject({
    tone: z.enum(["concise", "detailed", "friendly"]).optional(),
    emoji: z.boolean().optional(),
    icons: z.boolean().optional(),
    sentenceCase: z.enum(["normal", "title", "upper"]).optional(),
  }).optional();
  // NO PROVIDER EVER LANDS IN THE CHECKED-IN FILE (the provider decision,
  // applied to the engine's runtime section as it was to the web bridge): a
  // vendor endpoint or model shipped in the repository answers a question
  // the user never answered, and it answers it silently for every checkout.
  // So every provider-shaped field here is OPTIONAL — the checked-in file
  // declares none, a user who wants the CLI runtime declares their own, and
  // an unconfigured runtime is a GUIDED refusal at `resolveProvider` /
  // `resolveModel` (typed `runtime_provider_not_found` /
  // `runtime_model_not_found`), never a bundled default. A vendor value
  // smuggled back under a DIFFERENT key is refused by this strictObject —
  // unknown keys do not parse — and the checked-in file's emptiness is
  // pinned by `test/config/config-consistency.test.ts`.
  const runtimeConfigSchema = z.strictObject({
    responses: RESPONSES_TRANSPORT_SCHEMA.optional(),
    defaultProvider: z.string().min(1).max(runtimeLimits.maximumProviderIdCharacters).optional(),
    defaultModel: z.string().min(1).max(runtimeLimits.maximumModelIdCharacters).optional(),
    systemPrompt: z.string().max(runtimeLimits.maximumSystemPromptBytes),
    defaultToolChoice: z.enum(["auto", "none", "required"]).default("auto"),
    providers: z.array(providerConfigSchema).max(runtimeLimits.maximumProviders),
    userPreferences: userPreferencesConfigSchema,
    limits: runtimeBehaviorLimitsSchema.optional(),
  }).superRefine((runtime, ctx) => {
    const providerIds = new Set<string>();
    for (const provider of runtime.providers) {
      if (providerIds.has(provider.id)) {
        ctx.addIssue({ code: "custom", message: "runtime provider ids must be unique", path: ["providers"] });
      }
      providerIds.add(provider.id);
      const modelIds = new Set<string>();
      for (const model of provider.models) {
        if (modelIds.has(model.id)) {
          ctx.addIssue({ code: "custom", message: `runtime model ids must be unique within provider ${provider.id}`, path: ["providers"] });
        }
        modelIds.add(model.id);
      }
      if (provider.retries.maxBackoffMs < provider.retries.initialBackoffMs) {
        ctx.addIssue({ code: "custom", message: "runtime maxBackoffMs must be >= initialBackoffMs", path: ["providers"] });
      }
    }
    // A DANGLING default is a misconfiguration, not a refusal deferred: when
    // a default IS declared it must resolve against the same document.
    if (runtime.defaultProvider !== undefined && !providerIds.has(runtime.defaultProvider)) {
      ctx.addIssue({ code: "custom", message: "runtime defaultProvider must match a provider id", path: ["defaultProvider"] });
    }
    if (runtime.defaultModel !== undefined && runtime.defaultProvider === undefined) {
      ctx.addIssue({ code: "custom", message: "runtime defaultModel requires defaultProvider — a model id alone does not say which provider serves it", path: ["defaultModel"] });
    }
    const defaultProvider = runtime.providers.find((p) => p.id === runtime.defaultProvider);
    if (defaultProvider !== undefined && runtime.defaultModel !== undefined) {
      const modelIds = new Set(defaultProvider.models.map((m) => m.id));
      if (!modelIds.has(runtime.defaultModel)) {
        ctx.addIssue({ code: "custom", message: "runtime defaultModel must match a model id in the default provider", path: ["defaultModel"] });
      }
    }
  });
  const agentProfileSchema = z.strictObject({
    name: z.string().min(1).max(runtimeLimits.maximumAgentNameCharacters)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    type: z.enum(AGENT_TYPE_IDS).default("call-and-return"),
    model: z.string().min(1).max(runtimeLimits.maximumModelIdCharacters),
    provider: z.string().min(1).max(runtimeLimits.maximumProviderIdCharacters),
    systemPrompt: z.string().max(runtimeLimits.maximumSystemPromptBytes),
    tools: z.union([z.literal("all"), z.array(z.string().min(1).max(runtimeLimits.maximumAgentNameCharacters))
      .max(policy.contracts.limits.maximumTools)]),
    capabilities: z.array(z.enum(AGENT_CAPABILITIES))
      .max(policy.contracts.limits.maximumTools),
    writeSet: z.array(z.string().min(1).max(policy.contracts.limits.maximumIdentifierCharacters))
      .max(policy.contracts.limits.maximumTools),
    maxTurns: z.number().int().positive().max(runtimeLimits.maximumAgentMaxTurns),
    backgroundTimeoutMs: z.number().int().positive()
      .max(runtimeLimits.maximumTimeoutMs).optional(),
  }).superRefine((agent, ctx) => {
    if (agent.tools !== "all" && new Set(agent.tools).size !== agent.tools.length) {
      ctx.addIssue({ code: "custom", message: "agent tools must be unique", path: ["tools"] });
    }
    if (new Set(agent.capabilities).size !== agent.capabilities.length) {
      ctx.addIssue({ code: "custom", message: "agent capabilities must be unique", path: ["capabilities"] });
    }
    if (new Set(agent.writeSet).size !== agent.writeSet.length) {
      ctx.addIssue({ code: "custom", message: "agent write set paths must be unique", path: ["writeSet"] });
    }
  });
  const agentsConfigSchema = z.strictObject({
    maximumConcurrentAgents: z.number().int().min(0).max(runtimeLimits.maximumAgents),
    profiles: z.array(agentProfileSchema).max(runtimeLimits.maximumAgents),
    orchestration: z.strictObject({
      alignmentMonitorIntervalMs: z.number().int().positive()
        .max(runtimeLimits.maximumTimeoutMs),
      alignmentDriftThresholdMs: z.number().int().positive()
        .max(runtimeLimits.maximumTimeoutMs).optional(),
      conflictDetectionEnabled: z.boolean(),
    }),
  }).superRefine((config, ctx) => {
    const names = new Set<string>();
    for (const agent of config.profiles) {
      if (names.has(agent.name)) {
        ctx.addIssue({ code: "custom", message: "agent names must be unique", path: ["profiles"] });
      }
      names.add(agent.name);
    }
  });
  const toolsLimits = policy.tools.limits;
  const toolsBoundsSchema = z.strictObject({
    timeoutMs: z.number().int().positive().max(toolsLimits.maximumToolTimeoutMs),
    maxOutputBytes: z.number().int().positive().max(toolsLimits.maximumToolOutputBytes),
    maxMemoryBytes: z.number().int().positive().max(toolsLimits.maximumToolMemoryBytes),
  });
  const toolsLimitsSchema = z.strictObject({
    maxReadBytes: z.number().int().positive().max(toolsLimits.maximumReadBytes),
    maxListEntries: z.number().int().positive().max(toolsLimits.maximumListEntries),
  });
  const mcpServerConfigSchema = z.strictObject({
    id: z.string().min(1).max(MCP_SERVER_ID_MAX_CHARACTERS).regex(MCP_SERVER_ID_PATTERN),
    // `http` is MCP Streamable HTTP. The retired HTTP+SSE transport ("sse")
    // is not a value: an old entry refuses here and is rewritten to `http`
    // with the server's Streamable HTTP endpoint.
    transport: z.enum(["stdio", "http", "websocket"]),
    command: z.string().min(1).max(runtimeLimits.maximumBaseUrlCharacters).optional(),
    args: z.array(z.string().min(1).max(runtimeLimits.maximumBaseUrlCharacters))
      .max(toolsLimits.maximumEnabledTools).optional(),
    // stdio only: absolute paths the CONFINED server may read and execute
    // (its install directory). Never writable.
    readPaths: z.array(z.string().min(1).max(runtimeLimits.maximumBaseUrlCharacters).refine((path) => path.startsWith("/"), "readPaths entries must be absolute"))
      .max(toolsLimits.maximumEnabledTools).optional(),
    env: z.record(z.string().min(1).max(toolsLimits.maximumMcpServerIdCharacters), z.string()).optional(),
    url: z.string().min(1).max(runtimeLimits.maximumBaseUrlCharacters).optional(),
    // Canonical MCP server config fields (no backward-compat facade —
    // the new schema IS the schema, sourced from the shared MCP module):
    headers: z.record(z.string().min(1).max(toolsLimits.maximumMcpServerIdCharacters), z.string()).optional(),
    subprotocol: z.string().min(1).max(toolsLimits.maximumMcpServerIdCharacters).optional(),
    enabled: z.boolean().optional(),
    retry: z.strictObject({
      count: z.number().int().positive().max(20),
      backoffMs: z.number().finite().nonnegative().max(60_000),
    }).optional(),
    auth: z.union([
      z.strictObject({
        type: z.literal("api-key"),
        token: z.string().min(1).max(MCP_AUTH_TOKEN_MAX),
        header: z.string().min(1).max(toolsLimits.maximumMcpServerIdCharacters).optional(),
        envName: z.string().min(1).max(toolsLimits.maximumMcpServerIdCharacters).optional(),
      }),
      z.strictObject({
        type: z.literal("bearer"),
        token: z.string().min(1).max(MCP_AUTH_TOKEN_MAX),
        envName: z.string().min(1).max(toolsLimits.maximumMcpServerIdCharacters).optional(),
      }),
      z.strictObject({
        type: z.literal("oauth"),
        token: z.string().min(1).max(MCP_AUTH_TOKEN_MAX),
      }),
    ]).optional(),
    protocolVersion: z.literal(policy.contracts.mcpProtocolVersion),
    timeoutMs: z.number().int().positive().max(toolsLimits.maximumToolTimeoutMs).optional(),
  }).superRefine((server, ctx) => {
    if (server.transport === "stdio" && server.command === undefined) {
      ctx.addIssue({ code: "custom", message: "stdio transport requires command", path: ["command"] });
    }
    if (server.transport === "http" && server.url === undefined) {
      ctx.addIssue({ code: "custom", message: "http transport requires url", path: ["url"] });
    }
    if (server.transport !== "stdio" && server.readPaths !== undefined) {
      ctx.addIssue({ code: "custom", message: "readPaths applies only to a stdio server", path: ["readPaths"] });
    }
    if (server.transport === "websocket" && server.url === undefined) {
      ctx.addIssue({ code: "custom", message: "websocket transport requires url", path: ["url"] });
    }
    if (server.url !== undefined && server.transport === "http" && !URL_PATTERN.test(server.url)) {
      ctx.addIssue({ code: "custom", message: "http url must be http(s)", path: ["url"] });
    }
    if (server.url !== undefined && server.transport === "websocket" && !WS_URL_PATTERN.test(server.url)) {
      ctx.addIssue({ code: "custom", message: "websocket url must be ws(s)", path: ["url"] });
    }
    if (server.auth !== undefined && server.auth.type === "api-key" && server.transport === "stdio" && server.auth.envName === undefined) {
      ctx.addIssue({ code: "custom", message: "api-key auth on stdio requires auth.envName", path: ["auth", "envName"] });
    }
  });
  const longTaskRunnerConfigSchema = z.strictObject({
    defaultHeartbeatMs: z.number().int().positive().max(toolsLimits.maximumToolTimeoutMs)
      .default(DEFAULT_LONG_TASK_HEARTBEAT_MS),
    probeTimeoutMs: z.number().int().positive().max(toolsLimits.maximumToolTimeoutMs)
      .default(DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS),
    spawnTimeoutMs: z.number().int().positive().max(toolsLimits.maximumToolTimeoutMs)
      .default(DEFAULT_LONG_TASK_SPAWN_TIMEOUT_MS),
    killTimeoutMs: z.number().int().positive().max(toolsLimits.maximumToolTimeoutMs)
      .default(DEFAULT_LONG_TASK_KILL_TIMEOUT_MS),
    listTimeoutMs: z.number().int().positive().max(toolsLimits.maximumToolTimeoutMs)
      .default(DEFAULT_LONG_TASK_LIST_TIMEOUT_MS),
  }).optional();
  const dispatcherConfigSchema = z.strictObject({
    minContentChars: z.number().int().positive()
      .default(DEFAULT_DISPATCHER_MIN_CONTENT_CHARS),
    truncationOverheadChars: z.number().int().nonnegative()
      .default(DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS),
  }).optional();
  const toolsConfigSchema = z.strictObject({
    defaultBounds: toolsBoundsSchema,
    enabled: z.array(z.string().min(1).max(toolsLimits.maximumToolNameCharacters))
      .max(toolsLimits.maximumEnabledTools),
    allowedCommands: z.array(z.string().min(1).max(toolsLimits.maximumToolNameCharacters))
      .max(toolsLimits.maximumEnabledTools).optional(),
    mcpServers: z.array(mcpServerConfigSchema).max(toolsLimits.maximumMcpServers).optional(),
    autoCheck: z.strictObject({
      maxCaptureBytes: z.number().int().positive().max(toolsLimits.maximumToolOutputBytes),
    }).optional(),
    // The bounds the code-search and dependency-graph tools obey. They were
    // read by the web surface with its own inline fallbacks and declared
    // nowhere, so an operator could not discover them and the reader's literal
    // was the only answer to "what is the limit" — the shape this schema
    // exists to make impossible.
    searchMaxDepth: POSITIVE_SAFE_INTEGER.optional(),
    searchMaxResults: POSITIVE_SAFE_INTEGER.optional(),
    /** Matches counted past `searchMaxResults` so a truncated answer can state
     *  its own true total instead of silently returning a prefix. */
    searchMaxScannedMatches: POSITIVE_SAFE_INTEGER.optional(),
    /** Deadline after which a running code search is terminated. A search
     *  applies a caller-supplied regular expression to every line of the
     *  project, and a backtracking pattern can occupy a thread indefinitely
     *  inside a single uninterruptible call. */
    searchTimeoutMs: POSITIVE_SAFE_INTEGER.optional(),
    searchLinePreviewMaxChars: POSITIVE_SAFE_INTEGER.optional(),
    dependencyGraphMaxCycles: POSITIVE_SAFE_INTEGER.optional(),
    repositoryMapSampleCount: POSITIVE_SAFE_INTEGER.optional(),
    limits: toolsLimitsSchema.optional(),
    longTaskRunner: longTaskRunnerConfigSchema,
    dispatcher: dispatcherConfigSchema,
    // Dispatch-behaviour knobs the tools exposure module publishes. Optional:
    // a fresh config omits them and each reads its declared default.
    maxConcurrent: POSITIVE_SAFE_INTEGER.optional(),
    dispatchTimeoutMs: POSITIVE_SAFE_INTEGER.optional(),
    retryLimit: z.number().int().nonnegative().max(20).optional(),
    retryBackoff: z.enum(["fixed", "exponential", "linear"]).optional(),
    failClosed: z.boolean().optional(),
    propagateErrors: z.boolean().optional(),
    recordInputs: z.boolean().optional(),
    recordOutputs: z.boolean().optional(),
    // MCP module-wide defaults (applied to every `mcpServers` entry unless the
    // entry overrides them). The MCP exposure module publishes these as
    // settings; the defaults the module used to hold privately now live here.
    mcp: MCP_CONFIG_SCHEMA.optional(),
  }).superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const server of config.mcpServers ?? []) {
      if (ids.has(server.id)) {
        ctx.addIssue({ code: "custom", message: "mcp server ids must be unique", path: ["mcpServers"] });
      }
      ids.add(server.id);
    }
    const enabled = new Set(config.enabled);
    if (enabled.size !== config.enabled.length) {
      ctx.addIssue({ code: "custom", message: "enabled tools must be unique", path: ["enabled"] });
    }
    if (config.allowedCommands !== undefined) {
      const cmds = new Set(config.allowedCommands);
      if (cmds.size !== config.allowedCommands.length) {
        ctx.addIssue({ code: "custom", message: "allowed commands must be unique", path: ["allowedCommands"] });
      }
    }
  });
  // Quality packs config (delivery-map item 9 / REQ-015): the central
  // `qualityPacks.enabled` list selects which language quality packs the
  // runtime registers. When absent or empty, the runtime defaults to the
  // TypeScript pack (backwards compat). Pack IDs are bounded by the same
  // tool-name character ceiling and tool-count ceiling as tools.enabled.
  // Dynamic pack loading from module paths is deferred to the extension
  // lifecycle (delivery-map item 12); this field lists pack IDs the runtime
  // already knows (currently: "typescript-pack").
  const qualityPacksConfigSchema = z.strictObject({
    enabled: z.array(z.string().min(1).max(toolsLimits.maximumToolNameCharacters))
      .max(toolsLimits.maximumEnabledTools).optional(),
  }).superRefine((config, ctx) => {
    if (config.enabled !== undefined) {
      const ids = new Set(config.enabled);
      if (ids.size !== config.enabled.length) {
        ctx.addIssue({ code: "custom", message: "quality pack ids must be unique", path: ["enabled"] });
      }
    }
  });
  const gitRemoteRoleSchema = z.strictObject({
    name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    urlIdentity: z.string().min(1).max(2048),
    refspecs: z.array(z.string().min(1).max(512)).max(32),
    branch: z.string().min(1).max(256).optional(),
  });
  const gitRemoteRolesSchema = z.strictObject({
    fetch: gitRemoteRoleSchema,
    push: gitRemoteRoleSchema.optional(),
  });
  const gitCloneSchema = z.strictObject({
    depth: z.number().int().positive().max(10000).optional(),
    filter: z.string().max(256).optional(),
    rejectShallow: z.boolean(),
    checkoutPolicy: z.enum(GIT_CHECKOUT_POLICIES),
    submoduleMode: z.enum(GIT_SUBMODULE_MODES),
    lfsMode: z.enum(GIT_LFS_MODES),
  });
  const gitReconciliationSchema = z.strictObject({
    mode: z.enum(GIT_RECONCILIATION_MODES),
    unrelatedHistory: z.enum(["reject", "allow-merge", "allow-rebase"]),
  });
  const gitPushSchema = z.strictObject({
    refspecs: z.array(z.string().min(1).max(512)).max(32),
    atomic: z.boolean(),
    signed: z.boolean(),
    force: z.literal(false),
    protectedRefs: z.array(z.string().min(1).max(512)).max(64),
    leaseCapabilityRef: z.string().max(256).optional(),
  });
  const gitTimeoutsSchema = z.strictObject({
    inspectMs: z.number().int().positive().max(600000),
    fetchMs: z.number().int().positive().max(600000),
    pushMs: z.number().int().positive().max(600000),
    verifyMs: z.number().int().positive().max(600000),
    // Local git operations (worktree add, commit) of the workspace command.
    // Semantically distinct from remote operations (fetch/push) because they
    // operate on the local index/objects and may trigger local hooks.
    addMs: z.number().int().positive().max(600000),
    // A commit runs the repository's hooks, so its bound leaves room above a
    // loaded machine's hook (A5-design L7: the old maximum was the configured
    // value itself).
    commitMs: z.number().int().positive().max(GIT_COMMIT_TIMEOUT_MAX_MS),
  });
  const gitRetriesSchema = z.strictObject({
    inspectAttempts: z.number().int().positive().max(10),
    fetchAttempts: z.number().int().positive().max(10),
    pushAttempts: z.number().int().positive().max(10),
    verifyAttempts: z.number().int().positive().max(10),
  });
  const gitCheckpointSchema = z.strictObject({
    namespace: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    retention: z.number().int().positive().max(10000),
    compensation: z.enum(["tag", "ref", "commit"]),
  });
  const gitCredentialsSchema = z.strictObject({
    providerRefs: z.array(z.string().min(1).max(256)).max(16),
    allowedMethods: z.array(z.enum(GIT_AUTH_METHODS)).min(1).max(8),
  });
  const gitNeverPushAdditiveRuleSchema = z.strictObject({
    // The scan compiles this string and tests it against every tracked path.
    // Accepting a string that does not compile moves the failure from the write
    // — where the operator is present and can fix it — to the next promotion,
    // where a never-push scan throws instead of scanning and the safety check
    // silently stops being a safety check.
    pattern: z.string().min(1).max(512).refine(
      (source) => {
        try {
          new RegExp(source, "u");
          return true;
        } catch {
          return false;
        }
      },
      { message: "never-push pattern is not a valid regular expression" },
    ),
    classification: z.string().min(1).max(128),
    sizeCeilingBytes: z.number().int().positive().max(1073741824).optional(),
    lfsClassification: z.string().max(128).optional(),
    managedIgnore: z.boolean().optional(),
  });
  const gitNeverPushSchema = z.strictObject({
    additiveRules: z.array(gitNeverPushAdditiveRuleSchema).max(128),
  });
  const gitCapabilitiesSchema = z.strictObject({
    objectFormat: z.string().min(1).max(64),
    refStorage: z.string().min(1).max(64),
    credential: z.string().min(1).max(128),
    host: z.string().min(1).max(128),
    submodule: z.string().min(1).max(128),
    lfs: z.string().min(1).max(128),
    signer: z.string().min(1).max(128),
    filesystem: z.string().min(1).max(128),
  });
  const gitInteractionSchema = z.strictObject({
    safeRecommendation: z.boolean(),
    approvalRequired: z.boolean(),
  });
  const gitIoLimitsSchema = z.strictObject({
    maxOutputBytes: z.number().int().positive().max(runtimeLimits.maximumGitOutputBytes),
    maxErrorBytes: z.number().int().positive().max(runtimeLimits.maximumGitErrorBytes),
    maxInputBytes: z.number().int().positive().max(runtimeLimits.maximumGitInputBytes),
  });
  const workspaceGitSchema = z.strictObject({
    remoteRoles: gitRemoteRolesSchema,
    allowedTransports: z.array(z.enum(GIT_TRANSPORTS)).min(1).max(3),
    allowedHosts: z.array(z.string().min(1).max(256)).max(128),
    defaultBranch: z.string().min(1).max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    clone: gitCloneSchema,
    reconciliation: gitReconciliationSchema,
    push: gitPushSchema,
    timeouts: gitTimeoutsSchema,
    retries: gitRetriesSchema,
    checkpoint: gitCheckpointSchema,
    credentials: gitCredentialsSchema,
    neverPush: gitNeverPushSchema,
    capabilities: gitCapabilitiesSchema,
    interaction: gitInteractionSchema,
    gitIoLimits: gitIoLimitsSchema.optional(),
    gitExecutablePath: z.string().min(1).max(1024).optional(),
    pythonExecutable: z.string().min(1).max(1024).optional(),
    gitAskPass: z.string().min(1).max(1024).optional(),
  }).superRefine((git, ctx) => {
    if (git.push.force !== false) {
      ctx.addIssue({ code: "custom", message: "workspaceGit.push.force must be false", path: ["push", "force"] });
    }
    if (git.remoteRoles.push !== undefined && git.remoteRoles.push.name === git.remoteRoles.fetch.name) {
      ctx.addIssue({
        code: "custom",
        message: "workspaceGit.remoteRoles.push.name must differ from fetch.name",
        path: ["remoteRoles", "push", "name"],
      });
    }
  });
  // The privacy section is the privacy domain's own exported schema — the
  // 12 leaves and their narrowing-refusal floors live beside the policy
  // that consumes them (privacy-config-section.ts).
  const privacyConfigSchema = PRIVACY_CONFIG_SCHEMA;
  const memoryConfigSchema = z.strictObject({
    contextTokenLimit: z.number().int().positive().max(1_048_576),
    trimThreshold: z.number().min(0.5).max(0.99),
    recentTurnWindow: z.number().int().positive().max(100_000),
    shortTermTurnLimit: z.number().int().positive().max(1_000_000),
    longTermFactLimit: z.number().int().positive().max(10_000_000),
    searchResultLimit: z.number().int().positive().max(100_000),
    summaryMaxTokens: z.number().int().positive().max(65_536),
    contentMaxCharacters: z.number().int().positive().max(10_485_760),
    maxTagsPerEntry: z.number().int().positive().max(4_096),
    maxTopicCharacters: z.number().int().positive().max(8_192),
    // The engine names come from the memory module's own declaration, so a
    // kind added there is writable here without an edit, and a kind that
    // does not exist is refused at the write gate rather than at first use.
    searchEngine: z.enum(MEMORY_SEARCH_ENGINE_KINDS),
    dedupCompression: z.strictObject({
      enabled: z.boolean().default(false),
      llmInputDedup: z.boolean().default(false),
      dedupMode: z.enum(["none", "line", "block", "semantic"]).default("block"),
    }).optional(),
    // Working-memory window knobs the memory exposure module publishes. All
    // optional: a fresh config omits them and each reads its declared default.
    // `windowTrimThreshold`/`windowTrimStep` govern the PRESENT window's trim;
    // they are distinct from the top-level `trimThreshold`, which governs the
    // whole-context trim the real MemoryStore performs.
    windowSize: z.number().int().positive().max(1_000_000).optional(),
    windowTrimThreshold: z.number().min(0).max(1).optional(),
    windowTrimStep: z.number().min(0).max(1).optional(),
    promoteOnTurnBoundary: z.boolean().optional(),
    defaultTier: z.enum(["present", "short", "long"]).optional(),
    maxCorrupted: z.number().int().nonnegative().max(1000).optional(),
    // The web server's memory capture-and-search limits. Optional like the
    // window knobs above: a fresh config omits them and each server reader
    // applies the declared default from the contract constants (the defaults
    // are recorded at the settings registration, which is the one place a
    // "return to default" write consults). Each leaf has a live consumer in
    // the server — a reader that previously fell back to a private constant
    // because this schema refused the path it read.
    toolResultContentMaxChars: z.number().int().positive().max(10_485_760).optional(),
    toolResultArgsMaxChars: z.number().int().positive().max(1_048_576).optional(),
    previewMaxChars: z.number().int().positive().max(1_048_576).optional(),
    searchMaxLimit: z.number().int().positive().max(100_000).optional(),
    retrievalLimit: z.number().int().positive().max(1_000).optional(),
    interactionContentMaxChars: z.number().int().positive().max(10_485_760).optional(),
  });
  const editorConfigSchema = z.strictObject({
    maxFileBytes: z.number().int().positive().max(editorLimits.maxFileBytes),
    maxPatchBytes: z.number().int().positive().max(editorLimits.maxPatchBytes),
    maxInsertTextBytes: z.number().int().positive().max(editorLimits.maxInsertTextBytes),
    // Edit-behaviour knobs the editor exposure module publishes. Optional: a
    // fresh config omits them and each reads its declared default.
    viewportLines: z.number().int().positive().max(1000).optional(),
    maxRetries: z.number().int().nonnegative().max(20).optional(),
    fuzzyThreshold: z.number().min(0).max(1).optional(),
    syntaxValidationEnabled: z.boolean().optional(),
    atomicWriteEnabled: z.boolean().optional(),
    feedbackLoopEnabled: z.boolean().optional(),
    historyRetention: z.number().int().nonnegative().max(10000).optional(),
    backupOnEdit: z.boolean().optional(),
    // Single-edit-tool pipeline knobs. Optional: a fresh config omits them and
    // each reads its declared default.
    unifiedEditEnabled: z.boolean().optional(),
    healCascadeEnabled: z.boolean().optional(),
    jsonRepairEnabled: z.boolean().optional(),
  });
  const timelineConfigSchema = z.strictObject({
    maxDocumentBytes: z.number().int().positive().max(timelineLimits.maxDocumentBytes),
    maxDocuments: z.number().int().positive().max(timelineLimits.maxDocuments),
    maxEdges: z.number().int().positive().max(timelineLimits.maxEdges),
    dbFilename: z.string().min(1).max(timelineLimits.maxDbFilenameCharacters),
    sqliteCacheSize: z.number().int()
      .min(-timelineLimits.maxSqliteCacheSizeAbsolute)
      .max(timelineLimits.maxSqliteCacheSizeAbsolute),
    sqliteBusyTimeoutMs: z.number().int().positive()
      .max(timelineLimits.maxSqliteBusyTimeoutMs),
    queryDefaultLimit: z.number().int().positive().max(timelineLimits.maxDocuments)
      .default(DEFAULT_TIMELINE_QUERY_LIMIT),
    // Whether the provider-interaction capture (the redacted request messages
    // and the assembled response, as ledger documents on the provider event)
    // is on. On by default: answering "what did the provider actually send
    // and receive?" is the ledger's purpose, and the payloads are redacted
    // before write and bounded by `maxDocumentBytes`. The off switch exists
    // for an operator who wants the ledger to stay metadata-only.
    captureProviderPayloads: z.boolean().default(DEFAULT_CAPTURE_PROVIDER_PAYLOADS),
  });
  const resourceLockConfigSchema = z.strictObject({
    timeoutMs: z.number().int().positive().max(resourceLockLimits.maxTimeoutMs),
    pollIntervalMs: z.number().int().positive().max(resourceLockLimits.maxPollIntervalMs),
    staleMs: z.number().int().positive().max(resourceLockLimits.maxStaleMs),
  });
  // Isolated workspaces (git worktrees + a serialized integrator that lands
  // by fast-forward): `harness workspace` (src/workflow/workspace-manager.ts)
  // and the candidate checkout's setup (src/workflow/checkout-setup.ts). One
  // canonical owner for worktree placement (`workspaceRoot`, relative to the
  // repository home: the directory holding the git common dir), branch
  // namespacing, the staleness budget, failure preservation, quarantine
  // retention, the lease TTL, the two repository locks (admission: create and
  // extend; merge: the integrator), the supervised commands' kill grace, and
  // the commands each phase runs. Optional: workspace commands fail with a
  // typed blocker when the section is absent.
  const repositoryRelativePath = REPOSITORY_RELATIVE_PATH_SCHEMA;
  const workspaceCommandName = WORKSPACE_COMMAND_NAME_SCHEMA;
  // One command, run in the checkout under the native supervisor (its
  // `timeoutMs` is the hard ceiling). `inputs` — declared only on a SETUP
  // command, its one consumer (the setup re-run) — are the
  // repository-relative paths (a file, or a directory covering everything
  // under it) whose change makes a REFRESHED checkout run the command again:
  // a lockfile edit re-installs dependencies, a guardian source edit rebuilds
  // the binaries, so a refreshed candidate never qualifies on stale ones. A
  // setup command without `inputs` never re-runs (the bundle: every sync
  // rebuilds it). `requires` — declared only on a VALIDATE or MERGE gate —
  // names the commands that PRODUCE what the gate judges (the perf profile
  // step makes the report the web suite's regression gate reads): the
  // sequencer runs each first, once per sequence, and a gate whose producer
  // failed is not run (a gate never judges an artifact no step produced). A
  // producer requires nothing itself and is never a judged gate. `ledger` —
  // also only on a VALIDATE or MERGE gate — names the judged-run ledger the command
  // records its run in (repository-relative): such a gate is judged like a
  // qualification, not by its exit status — its run's row against the latest
  // row of the same ledger in the checkout holding the target, passing iff it
  // fails nothing new (a suite whose owned failures persist can still land).
  // A land imports those rows into the landing checkout's ledger. The value
  // names WHICH suite's ledger (`engine` or `web`); the ledger's location is
  // its owner's (`SUITE_LEDGERS`, src/shared/run-history.ts), never a path
  // spelled again here. There is ONE judge (UR-17, no fallbacks): no focused
  // subset gate re-judged by a full suite, and no failure forgiven because
  // its file passed when re-run alone — a flaky test is fixed at its cause.
  const workspaceCommandSchema = z.strictObject({
    cwd: repositoryRelativePath,
    argv: z.array(z.string().min(1).max(4096)).min(1).max(256),
    timeoutMs: z.number().int().positive().max(7_200_000),
    inputs: z.array(repositoryRelativePath).min(1).max(64).optional(),
    ledger: z.enum(SUITE_LEDGER_NAMES).optional(),
    requires: z.array(workspaceCommandName).min(1).max(8).optional(),
    // `holdsInstrumentLock` — declared only on a SETUP command that is a heavy
    // instrument (the web module cache warm-up collects the whole suite): the
    // runner takes the host's one instrument lock before the command starts
    // (the wait counts toward no `timeoutMs`), runs it once per tree, and a
    // READ-ONLY workspace's create does not run it (a verifier runs single
    // files; its first run warms the cache), so a create never fails while a
    // validate holds the lock.
    holdsInstrumentLock: z.literal(true).optional(),
  });
  const workspacePhaseSchema = z.array(workspaceCommandName).max(32);
  const workspaceLockSchema = z.strictObject({
    name: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u),
    timeoutMs: z.number().int().positive().max(3_600_000),
    staleMs: z.number().int().positive().max(3_600_000),
  });
  const workspaceIsolationConfigSchema = z.strictObject({
    workspaceRoot: z.string().min(1).max(1024),
    branchNamespace: z.string().min(1).max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/$/u),
    baseStalenessCommits: z.number().int().positive().max(100_000),
    preserveOnFailure: z.boolean(),
    quarantineTtlMs: z.number().int().positive().max(31_536_000_000),
    leaseTtlMs: z.number().int().positive().max(31_536_000_000),
    admissionLock: workspaceLockSchema,
    mergeLock: workspaceLockSchema,
    // The ONLY branches a workspace may land on (`workspace create` refuses
    // any other target before anything is made, and `merge` checks again). A
    // product branch that changes only through a promotion door is never one
    // of them (UR-12), so no workspace can fast-forward it.
    landTargets: z.array(z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)).min(1).max(64),
    // How long a supervised command told to stop (its ceiling, an operator's
    // Ctrl-C) has before it and every descendant are killed.
    killGraceMs: z.number().int().positive().max(60_000),
    // Ignored paths a workspace or candidate checkout recreates as symlinks to
    // the source checkout's entry (shared corpora too large to copy).
    links: z.array(repositoryRelativePath).max(64),
    commands: z.record(workspaceCommandName, workspaceCommandSchema),
    // Every phase has its consumer: `setup` runs when a checkout is made
    // (checkout-setup.ts), `validate` in `workspace validate`, `regenerate`
    // and `merge` in `workspace validate --full` and `workspace merge`.
    phases: z.strictObject({
      setup: workspacePhaseSchema,
      validate: workspacePhaseSchema,
      regenerate: workspacePhaseSchema,
      merge: workspacePhaseSchema,
    }),
  }).superRefine((isolation, context) => {
    for (const [phase, names] of Object.entries(isolation.phases)) {
      for (const name of names) {
        if (isolation.commands[name] === undefined) {
          context.addIssue({ code: "custom", path: ["phases", phase], message: `phase ${phase} names an undeclared command ${name}` });
        }
      }
    }
    // A command no workspace phase runs may still be run by a promotion
    // profile (a data file on the source branch, which this schema cannot
    // see): "declared but run by nothing" is judged where both are visible —
    // the promotion boundary guard over the source tree
    // (`unconsumedCommands`, src/workflow/checkout-setup.ts).
    const ungated = new Set([...isolation.phases.setup, ...isolation.phases.regenerate]);
    for (const [name, command] of Object.entries(isolation.commands)) {
      if (command.inputs !== undefined && !isolation.phases.setup.includes(name)) {
        context.addIssue({ code: "custom", path: ["commands", name, "inputs"], message: `${name} declares inputs but no setup phase runs it: only the setup re-run reads them` });
      }
      if (command.ledger !== undefined && ungated.has(name)) {
        context.addIssue({ code: "custom", path: ["commands", name, "ledger"], message: `${name} is judged by its ledger, so only the validate and merge phases may run it` });
      }
      if (command.requires !== undefined && ungated.has(name)) {
        context.addIssue({ code: "custom", path: ["commands", name, "requires"], message: `${name} requires producers, so only the validate and merge phases may run it` });
      }
      for (const producer of command.requires ?? []) {
        const required = isolation.commands[producer];
        const why = required === undefined ? "is not declared"
          : producer === name ? "is the gate itself"
          : required.requires !== undefined ? "requires producers itself (one level: a producer runs alone)"
          : required.ledger !== undefined ? "is a judged gate, not a producer"
          // A producer runs only for its gates, once per sequence: a phase naming it too would run it again, and a
          // setup command is the checkout's, never a gate's input (correctness B-L11).
          : Object.values(isolation.phases).some((names) => names.includes(producer)) ? "is named by a phase itself (a producer runs only for the gates that require it)" : null;
        if (why !== null) context.addIssue({ code: "custom", path: ["commands", name, "requires"], message: `${name} requires ${producer}, which ${why}` });
      }
    }
  }).optional();
  const evaluationConfigSchema = z.strictObject({
    identityAttestationTimeoutMs: z.number().int().positive()
      .max(evaluationLimits.maxIdentityAttestationTimeoutMs),
    maxOutputTokens: z.number().int().positive().max(1_048_576)
      .default(DEFAULT_EVALUATION_MAX_OUTPUT_TOKENS),
  });
  const maLimits = policy.migrationAuthority.limits;
  const migrationAuthorityConfigSchema = z.strictObject({
    leaseTtlMs: z.number().int().positive().max(maLimits.maxLeaseTtlMs),
    heartbeatIntervalMs: z.number().int().positive().max(maLimits.maxHeartbeatIntervalMs),
    renewalCeilingMs: z.number().int().positive().max(maLimits.maxRenewalCeilingMs),
    orphanGraceMs: z.number().int().positive().max(maLimits.maxOrphanGraceMs),
    reconciliationTimeoutMs: z.number().int().positive().max(maLimits.maxReconciliationTimeoutMs),
    busyTimeoutMs: z.number().int().positive().max(maLimits.maxBusyTimeoutMs),
    checkpointCadenceMs: z.number().int().positive().max(maLimits.maxCheckpointCadenceMs),
    recoveryDirectionPreference: z.enum(["previous", "next"]),
  }).optional();
  // A test suite's watchdog: killed on a STALL (no progress for
  // `stallTimeoutMs`) or at a HARD CEILING (`hardCeilingMs`, whatever the
  // load); a run told to stop has `killGraceMs` (SIGTERM) before it and every
  // descendant are SIGKILLed (engine/src/process/supervised-run.ts). One shape
  // for both suites; each suite declares its own numbers. A stall bound at or
  // above the ceiling can never fire: the ceiling always ends the run first,
  // so the declared stall clock would be dead config; a grace at or above the
  // stall bound would outlast the silence it answers.
  const suiteWatchdogSchema = z.strictObject({
    stallTimeoutMs: z.number().int().positive().max(3_600_000),
    hardCeilingMs: z.number().int().positive().max(14_400_000),
    killGraceMs: z.number().int().positive().max(60_000),
  }).refine((watchdog) => watchdog.stallTimeoutMs < watchdog.hardCeilingMs, {
    message: "stallTimeoutMs must be below hardCeilingMs (a stall bound the ceiling always pre-empts never fires)",
    path: ["stallTimeoutMs"],
  }).refine((watchdog) => watchdog.killGraceMs < watchdog.stallTimeoutMs, {
    message: "killGraceMs must be below stallTimeoutMs (a stop's grace may not outlast the silence it answers)",
    path: ["killGraceMs"],
  });
  const testExecutionConfigSchema = z.strictObject({
    concurrency: z.union([
      z.literal("auto"),
      z.literal(false),
      z.number().int().positive().max(64),
    ]).default("auto"),
    parallelConcurrency: z.number().int().positive().max(64).optional(),
    fullSuiteParallelConcurrency: z.number().int().positive().max(64).optional(),
    // `runtimeBudgetMs` is a per-test KILL TIMEOUT, not a budget: it is
    // passed to the runner as `timeout`, so a test that never settles FAILS
    // instead of removing the suite. It happens to read 120000 — the same
    // number the deleted wall-clock suite budget (`suiteRuntimeBudgetMs`)
    // carried — and that is a COINCIDENCE of history, not a relationship:
    // the suite budget is a CPU budget now (`integrationSuiteCpuBudget`
    // below) and this timeout is bounded from below by the slowest single
    // test, a different derivation entirely.
    runtimeBudgetMs: z.number().int().positive().max(600000).optional(),
    serialPhaseConcurrency: z.number().int().positive().max(16).optional(),
    fullSuiteSerialPhaseConcurrency: z.number().int().positive().max(16).optional(),
    fullSuiteInProcessSerialPhaseConcurrency: z.number().int().positive().max(16).optional(),
    // What the INTEGRATION suite may cost, per test file, in CPU
    // milliseconds — the sibling of `webUiSuiteCpuBudget` below, judged by
    // the same shared owner (`src/shared/budget-verdict.ts`, `judgeSuiteCpu`)
    // from the runner at end-of-run. It replaces `suiteRuntimeBudgetMs`, a
    // wall-clock cap judged one run late by a test with three silent
    // refusal-scored-as-pass paths and a silent 120 s default; wall clock
    // moves +73% under contention while CPU moves +2.6% on the same tree,
    // so the wall clock is recorded and reported, never judged.
    //
    // TWO PHASES, BOTH DECLARED — because there is no CPU history yet and a
    // cap must not be guessed:
    //
    //   ACCUMULATION (`{ phase: "accumulation", ... }`): no cap is in
    //   force. Every full run's CPU-per-test-file is judged as EVIDENCE
    //   (warmth, population and instrument refusals all apply immediately)
    //   and appended to `.bridlewise/state/test-results/run-history.json`;
    //   the CPU gate prints NOT JUDGED with the run's reading and the
    //   count toward `minimumJudgedRuns`. Once the ledger holds that many
    //   judged runs, the gate prints the derivation itself — the ledger's
    //   median and measured spread — and prescribes the derived shape.
    //
    //   DERIVED: the ROLLING shape the web suite budgets by
    //   (`webUiSuiteCpuBudget` below — floor + window, the cap derived at
    //   read time), the floor the clean median with no headroom (one judged
    //   run over the cap fails, UR-24-BUDGETS; the spread band and the
    //   consecutive-run streak are deleted). Record the derivation — the
    //   ledger numbers it came from — beside the values when making this
    //   edit.
    // BOUNDS ON THE SHARED V8 COMPILE CACHE (`scripts/compile-cache.ts`,
    // which owns enablement and is therefore the choke point every run's
    // cache passes through). The cache is otherwise unbounded and measured
    // growing ~950k entries/day (1.97M entries / 20 GB two days after a full
    // clear), ~11.5k of them per run being never-reusable temp-path compiles.
    // An entry survives a prune iff its mtime is within `maxEntryAgeDays`
    // AND among the newest `maxEntries` of its cache subdirectory; the prune
    // runs opportunistically at suite start BEFORE the run's start-stamp
    // (so the warmth instrument cannot be fabricated by it) and stops at
    // `timeBudgetMs`, trimming a large backlog over several runs rather
    // than stalling one. OPTIONAL WITH NO DEFAULT on purpose: a missing
    // policy object means no pruning plus a printed note naming this key —
    // a bound nobody chose is not a bound.
    compileCachePruning: z.strictObject({
      maxEntryAgeDays: z.number().positive().max(365),
      maxEntries: z.number().int().positive().max(50_000_000),
      timeBudgetMs: z.number().int().positive().max(600_000),
    }).optional(),
    integrationSuiteCpuBudget: z.union([
      z.strictObject({
        phase: z.literal("accumulation"),
        minimumJudgedRuns: z.number().int().min(2).max(50),
        maxPopulationDriftFraction: z.number().positive().lt(1),
      }),
      z.strictObject({
        msPerTestFile: z.number().positive().max(600000),
        derivedAtTestFileCount: z.number().int().positive().max(100000),
        maxPopulationDriftFraction: z.number().positive().lt(1),
        ambientInflationSlopePerCpu: z.number().positive().lt(1),
        ambientInflationCapFraction: z.number().positive().lt(1),
      }),
    ]).optional(),
    // What the web-UI suite may COST, per test file, in CPU milliseconds —
    // DERIVED AT READ TIME from the run-history ledger, never hand-set, and
    // anchored by a recorded floor this object declares.
    //
    // It replaces an absolute wall-clock cap, and the replacement was forced
    // by measurement rather than preference. That cap was derived against a
    // 433-file suite, was still being enforced after the suite reached 451,
    // and had drifted inside the run-to-run noise of a tree nobody had
    // changed. Normalising by the recorded ambient load does not repair it:
    // `loadavg()[0]` is a decaying one-minute average sampled before the run
    // starts, so a genuinely loaded run (8 burners on 12 cores) and an idle
    // run immediately after a previous suite both record ~0.6/cpu while
    // finishing 25 seconds apart. Wall-clock occupancy is no better — it IS
    // wall time and inflated 71% under those burners.
    //
    // CPU does not — under MILD contention: the same unchanged tree measured
    // 377.3 s of CPU idle and 387.2 s under the burners, +2.6%, while its
    // wall clock moved +73%. Contention makes a process wait for a core; it
    // does not make it execute more instructions. But that invariance does
    // not survive saturation — cache thrashing, memory-bandwidth contention
    // and scheduling pressure add real work to the same instructions (a
    // measured +21% on one unchanged tree at 1.33/cpu recorded ambient) —
    // so the budget bounds the WORK the suite asks for, which is the thing
    // a regression actually changes, and every line scales by the
    // ambient-inflation envelope declared below: the measured inflation of
    // sustained ambient load, paid for by the adjustment, never a deferral.
    // Nothing anywhere waits for a quiet box.
    //
    // PER TEST FILE, and the population is declared alongside: a total is
    // what silently stopped meaning anything when the suite grew, and a
    // per-file figure that never states the tree it was measured on would
    // eventually go the same way. A drift past
    // `maxPopulationDriftFraction` refuses until the floor is re-judged
    // and the count re-based. The unnoticed drift was 433 → 451, +4.2%, so
    // a tolerance at or above that would admit the very defect this exists
    // to prevent.
    //
    // THE ROLLING BASELINE — the cap is the declared FLOOR: a judged run
    // feeds the window only when its own CPU outcome passed (at or below the
    // cap in force at its moment), so the window's median never rises above
    // the floor. Growth is NOT absorbed: a grown suite fails the cap until
    // the measuring tool re-derives the floor (`npm run budget:measure`,
    // D-17), the derivation recorded beside this declaration. The window is
    // the stale-floor disclosure's sample (a clean median more than the
    // spread below the floor is said on every run).
    // The derivation, its anti-normalization construction and its
    // disclosure are documented at the owner:
    // `src/shared/budget-verdict.ts`, `deriveRollingBaseline`.
    //
    // THE FLOOR (`baselineFloorMsPerTestFile`) — the one hand-number left,
    // and the anchor for the one direction a rolling window cannot be
    // trusted with: the baseline NEVER DROPS below the floor without an
    // explicit measured re-derivation recorded beside this declaration, so
    // a lucky quiet stretch (a fast box band moving the window's median —
    // measured twice on this box: the whole band moved +6-9% for
    // byte-identical trees, uncorrelated with recorded ambient) cannot
    // silently loosen the gate. Its derivation is recorded here, newest
    // first:
    //
    // 1926 at 521 files (2026-10-10, LAND-OC-FIX round 12, written by the
    // measuring tool `npm run budget:measure -- --write`, D-17): the suite
    // had grown from 485 to 521 files (+7.4%, past the 3% drift), so the
    // population arm demanded the re-derivation. Twelve full web runs in the
    // host lock, in the coordinator's quiet window, each started once the
    // 1-minute load had decayed to <= 1.5 (12:25Z-13:33Z; 5-minute load
    // 0.06-0.43/CPU): raw 1919.2-2003.4 ms/file; the tool's window (each
    // reading ambient-adjusted at its own 5-minute leg, as the verdict still
    // adjusts until AMBIENT-ALLOWANCE-REMOVE) 1891.4-1970.2, median 1925.4,
    // spread max |reading - median| / median 2.32% (the high reading, run 3)
    // — inside the 2.6% `sameTreeSpreadFraction`. Floor 1926 = the window's
    // median at the declaration's granularity. An earlier batch the same
    // morning (back to back, no cooling: each run paid for the last) spread
    // 2.70% and wrote nothing.
    //
    // 1614 (2026-09-04, the STALE-LOOSE re-derivation the baseline line
    // itself demanded on every run — the downward anchor, applied in the
    // rolling design's own recorded remedy): the 1665 floor held the
    // baseline up long after the clean window refilled with
    // post-convergence readings, and the standing line said so on every
    // run ("the floor is STALE-LOOSE: the clean median sits more than the
    // same-tree spread below it … re-derive the floor from the measured
    // clean window"). Re-derived from the LIVE ledger's own 12-run clean
    // window (every reading ambient-adjusted at its own recorded 5-minute
    // leg, exactly as the machinery feeds it): 1587.2, 1591.4, 1565.8,
    // 1612.1, 1613.9, 1600.7, 1564.0, 1554.3, 1590.0, 1595.1, 1577.6,
    // 1586.1 — median 1588.6, observed quiet maximum 1613.9, measured
    // quiet excursion 25.3. Floor 1614 = the ceiling of the observed quiet
    // maximum at the declaration's granularity — the same
    // median-plus-excursion shape as the 1665, 1615 and 1564 derivations
    // below, nothing more, applied DOWNWARD this time: the floor exists to
    // anchor the one direction a rolling window cannot be trusted with (a
    // lucky quiet stretch pulling the baseline down), not to ratchet the
    // tree up, so a floor re-derived at the measured center lets the
    // baseline follow the median down through real improvement while the
    // GROWTH direction stays the median's own (a regression beyond the
    // spread still never feeds, and (since round 12) fails its own run
    // against the unchanged baseline — the anti-normalization construction
    // is untouched).
    // Population 485, the count the window's settled readings were judged
    // against (the window's four oldest rows are 480-file runs inside the
    // declared drift tolerance). The day's excluded tails (the 1735.3
    // streak row) stay excluded by the feed filter — beyond the adjusted
    // allowance of the baseline in force, exactly as designed. The
    // allowance at the new floor: 1614 × 1.026 = 1656.0 — the band (now
    // only the feed filter's boundary) narrows with the floor, the teeth sharpen, they do not weaken; the
    // median sits 1.58% under the new floor, inside the 2.6% spread, so
    // the floor binds WITHOUT the STALE-LOOSE note: the honest anchor
    // state, holding against quiet stretches while the window's own noise
    // band contains the gap.
    //
    // 1665 (2026-09-04, the rolling-baseline round's cold-start re-derivation
    // — the measured step absorption, from the LEDGER's own recorded
    // evidence, no fresh series): the tree's quiet center moved past the
    // 1615 seed in the hours after the round-69 convergence — the rounds
    // 63-69 tranche growth the chain-watch recorded round by round (the
    // margin 113 → 46 → 0.3 → over), arriving on the post-convergence tree
    // as two independent quiet readings of 1661.5 (ambient 0.094/cpu) and
    // 1663.0 (ambient 0.233/cpu). Floor 1665 = the ceiling of the observed
    // quiet maximum (1663.0) at the declaration's granularity — the same
    // median-plus-excursion shape as the 1564 and 1615 derivations below,
    // nothing more. The day's band tail (1736.3-1936.7, a uniform +6-12%
    // phase inflation measured between two runs of one byte-identical
    // tree — import 191.2 → 215.0 s, setup 45.0 → 49.4 s, tests 502.1 →
    // 559.8 s; the occupancy floors at baseline within jitter) is EXCLUDED
    // from the derivation (the box, not the tree) and stays beyond the new
    // allowance (1665 × 1.026 = 1708.0), where it warns and arms exactly as
    // the mechanism prescribes. THE COLD-START LAG, disclosed: the clean
    // window still holds the pre-growth era's readings (median 1537.3), so
    // the floor binds and the STALE-LOOSE note fires on every run until
    // the window refills with readings at the current center — the note's
    // state is true and said, never silent, and its remedy is already
    // paid. From this edit the median owns the number: continuous growth
    // rolls, and only a step beyond the noise band demands this ritual
    // again.
    //
    // 1615 (2026-09-04, the budget-drift investigation — the floor's SEED,
    // kept verbatim as the record of the derivation the rolling world
    // inherited): the suite grew past the 2026-09-03 declaration —
    // 8031 → 8059 tests over the same 480 files, the growth distributed
    // across new arms and per-fork import evaluation (no single mover: no
    // occupancy floor gained beyond run-to-run jitter, the largest move
    // +2.4%; the tests phase +47-75 s and the import phase +11-24 s
    // against the 2026-09-03 aggregates) — and the quiet center followed it
    // past the then-cap. Four fresh same-sha settled-launch quiet judged
    // runs on the settled box read 1593.0, 1608.5, 1611.5, 1614.6 ms/file
    // (recorded ambients 0.056-0.132/cpu, transform cache warm, 0 written
    // in every run), median 1610.0, observed quiet maximum 1614.6. Floor
    // 1615 = the ceiling of the observed quiet maximum = median 1610.0 +
    // the measured quiet excursion 4.6; population declared 480, the count
    // the readings were judged against. Not a raise by fiat and not
    // "today's reading rounded up": the number carries exactly the
    // headroom the quiet tree was measured to need, nothing more. When
    // the floor is provably STALE-HIGH (the clean median sits more than
    // the spread below it), the run's baseline line says so on every run
    // and demands this re-derivation — the never-silent principle, both
    // directions.
    //
    // THE WINDOW (`baselineWindowRuns`) — 12: the same sample size the
    // 2026-09-04 hand derivation used and the measuring tool derives from;
    // the stale-floor disclosure's sample. It never moves the cap.
    //
    // `sameTreeSpreadFraction` — the measured run-to-run spread of an
    // UNCHANGED tree: how far below the floor the clean median may sit
    // before the floor is reported stale, and the measuring tool's outlier
    // line. It never widens a verdict. Derivation (2026-09-04, same investigation): the
    // population's observed maximum is 1655.7 ms/file — the 2026-09-03
    // saturation-era tail, recorded at the quietest ambients of its day
    // and reproduced by eight stacked saturations taking a byte-unchanged
    // tree 1509.1 → 1625.6 (the whole band moving +6-9% uncorrelated with
    // recorded load); the post-2026-09-03 window carries the same
    // mechanism's quieter tail (1646.0). That maximum sits 2.52% over the
    // 1615 center, and the spread must classify it as noise or the
    // unchanged tree's own measured tail is taken for a regression — 0.026 is the
    // smallest three-decimal declaration that does. It has ONE role: the
    // boundary a ledger reading must sit at or under to feed the baseline
    // window and the measuring tool's window (D-17). It never widens a
    // verdict: one judged run over the cap fails.
    //
    // NO STREAK AND NO BAND (UR-24-BUDGETS, 2026-10-08): one judged run over
    // the cap fails that run. The "recorded, not red" band and the
    // three-consecutive-runs streak (`overCapRunsBeforeRed`) were the rerun
    // forgiveness the user deleted on 2026-10-07; both are gone.
    //
    // THE AMBIENT-INFLATION ENVELOPE (`ambientInflationSlopePerCpu` +
    // `ambientInflationCapFraction`) — the mechanism that ended the
    // quiet-ambient dependency: every reading is judged against a baseline
    // scaled by the CPU inflation its OWN recorded 5-minute ambient load
    // explains, so a clean run at a busy ambient judges clean and a
    // regressed run at a busy ambient judges regressed, at ANY ambient,
    // with nothing anywhere waiting for a quiet box (the user's standing
    // directive, 2026-09-04: the box is never idle; the machinery must
    // measure and judge at whatever ambient holds).
    //
    // WHY THE 5-MINUTE LEG IS THE COVARIATE (2026-09-04, the round-70
    // calibration): regressing the web ledger's own 55 recorded rows of
    // cpuMsPerTestFile against the recorded 1-minute leg gives r = 0.172 —
    // the 1-minute decaying average is sampled before launch and measures
    // the minute BEFORE the run (the 04:11-04:15 cohort recorded 1.32-1.94
    // /cpu while reading the quiet centre, 1595-1605 ms/file), and the whole
    // 1736-1936 inflation cohort of the same day sat at recorded-QUIET
    // 1-minute ambients (0.069-0.148/cpu). The 5-minute leg is the one the
    // single-suite ghost cannot inflate (one 80s suite at load ~10 on 12
    // cores leaves it at ~0.2/cpu), so a recorded amb5 is sustained load,
    // not the previous run's echo.
    //
    // THE SLOPE, 0.05/cpu — the envelope through the reliable measured
    // pairs, nothing fitted by taste:
    //   - eight CPU burners on twelve cores, whole run, 2026-09-03:
    //     +2.6% CPU at a 5-minute ambient of ~0.5-0.67/cpu → the allowance
    //     at 0.67 is +3.4%;
    //   - the web ledger's own 2026-09-04 12:18-12:23 cohort, four runs at
    //     amb5 0.557-1.263 against their quiet same-sha neighbour 1661.5:
    //     +2.0% to +5.5% (worst pair +5.5% at amb5 1.092 → the allowance is
    //     +5.5%), mean ≈ +3.9%.
    // The slope covers both anchors with margin and covers nothing the
    // record does not show.
    //
    // THE CAP, 0.12 — the bound on the whole adjustment, so the gate may
    // never loosen by more than 12% for ambient reasons and the teeth hold
    // at every ambient. Anchored on the 2026-09-03 stacked-saturation
    // measurement (eight stacked saturations took a byte-unchanged tree
    // 1509.1 → 1625.6, +7.7%) plus the same-tree spread riding on top:
    // everything the reliable record shows at ANY sustained ambient
    // (7.7% + 2.6% = 10.3%) sits inside the capped line (12% + 2.6% =
    // 14.9%). The 2026-09-01 incident (+21% on an unchanged tree at
    // recorded 1-minute ambients 0.88-1.66/cpu, load average 18 at peak) is
    // deliberately BEYOND the envelope: covering it would require an
    // allowance 4× the reliable cohort's worst realized inflation at the
    // same recorded ambient, emptying the teeth exactly where stacked gates
    // make regressions likely. Such readings warn (run n of k, printed with
    // the capped arithmetic) and a sustained beyond-envelope stretch reds —
    // the gate refusing to loosen itself into blindness is the honest
    // verdict at an ambient its measured envelope cannot speak to.
    webUiSuiteCpuBudget: z.strictObject({
      baselineFloorMsPerTestFile: z.number().positive().max(600000),
      derivedAtTestFileCount: z.number().int().positive().max(100000),
      maxPopulationDriftFraction: z.number().positive().lt(1),
      sameTreeSpreadFraction: z.number().positive().lt(1),
      baselineWindowRuns: z.number().int().min(2).max(HISTORY_KEPT),
      ambientInflationSlopePerCpu: z.number().positive().lt(1),
      ambientInflationCapFraction: z.number().positive().lt(1),
    }).optional(),
    // The largest share of the whole pool's worker time one test FILE may
    // occupy. A SHARE rather than a duration because contention is real and
    // uninteresting: the same tree measured minutes apart moves by tens of
    // seconds, so an absolute per-file ceiling has to be loose enough to
    // survive a busy machine and is then too loose to catch a file eating a
    // measurable fraction of the suite. Numerator and denominator move
    // together, so the ratio does not. Not an integer — it is a fraction of 1.
    webUiTestFileCostShareMax: z.number().positive().lt(1).optional(),
    // (No flaky-test lookback window: both suites' flaky memories judge the
    // WHOLE retained ledger, and a red suspect stays red until it is explained
    // or owned by a burn-down entry — nothing ages out of a window, design
    // NH-E; src/workflow/flaky-burn-down.ts `judgeFlakyMemory`.)
    // THE HOST'S ONE INSTRUMENT LOCK (src/process/instrument-lock.ts): the
    // lock file, relative to the host user's cache folder (`.cache` under the
    // password database's home: $HOME and $XDG_CACHE_HOME never move it; never
    // in a checkout, never in the keep-out floor), and what a
    // heavy run is — this many test files or more; fewer is a light, targeted
    // run that takes nothing — and which WHOLE INSTRUMENTS are heavy by kind,
    // whatever files they name (a browser run, the coverage run, the profile,
    // a slot run, a reproduction: one definition of heavy). REQUIRED:
    // a heavy run with no declared lock does not start. Every instrument door
    // takes it; a second one waits.
    instrumentLock: z.strictObject({
      cacheRelativeLockPath: z.string().min(1),
      minimumTestFiles: z.number().int().min(2),
      wholeInstruments: z.array(z.enum(WHOLE_INSTRUMENT_KINDS)).min(1).refine((kinds) => new Set(kinds).size === kinds.length, "each instrument once"),
      // How often a waiting run looks at the lock again.
      pollIntervalMs: z.number().int().min(10).max(60_000),
    }),
    // THE FLAKY-CAUSE REPRODUCTION DOOR (`harness flake reproduce`,
    // src/workflow/flake-cli.ts; the FLAKE-REPRO decision). A cause that needs
    // load or a race is reproduced STATISTICALLY: each side runs
    // `statisticalRuns` times under the same hog — the parent must fail at
    // least once with the recorded digest, the fix must pass every run — and
    // a statistical record of fewer runs explains nothing. REQUIRED: no N is
    // guessed.
    flakeReproduction: z.strictObject({
      statisticalRuns: z.number().int().min(2).max(1000),
      // α: the most probability a record's counts may leave that a fix which
      // changed NOTHING shows them (one-sided Fisher; design NH-C). The door
      // derives the runs per side the observed failure rate needs from it.
      significance: z.number().positive().max(0.5),
      // The DETERMINISTIC SHIMS: the only preloaded modules (repository
      // paths) whose one run per side is strong — a module that makes the
      // failure happen EVERY time. Any other preload needs the runs an
      // all-failing parent needs at α.
      deterministicShims: z.array(z.string().min(1).refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), "a repository-relative path")),
    }),
    // The WEB suite's supervisor (`scripts/run-tests.ts`, on the native
    // subreaper supervisor). A synchronous spin cannot be interrupted from
    // inside the runtime, so a process outside it ends the run: on PROGRESS
    // (`stallTimeoutMs` of no output at all — a loaded machine is slow, not
    // silent) and at a HARD CEILING (`hardCeilingMs`, whatever the load: a run
    // that keeps printing forever still ends). Either kill takes every
    // descendant, detached ones included. Performance is judged by the CPU
    // budget (`webUiSuiteCpuBudget`), never by this wall clock.
    webSuiteWatchdog: suiteWatchdogSchema.optional(),
    // The ENGINE suite's watchdog (`scripts/tooling/inventory-test-run.ts`,
    // held by the worker that dispatches the test files — never by a file's
    // own process, which is the one that hangs). `runtimeBudgetMs` fails a
    // TEST that never settles, but a file whose cancelled test left a handle
    // open never EXITS, and the runner waits for it forever (measured: two
    // hours on one file's leaked servers). A phase that reports no test event
    // for `stallTimeoutMs` (above `runtimeBudgetMs`, so a cancelled test
    // always reports first), or a run still going at `hardCeilingMs`, is
    // aborted: every file process still running is killed and reported as a
    // failed, aborted file — a killed run is a failed run.
    engineSuiteWatchdog: suiteWatchdogSchema.optional(),
  }).optional();
  // Harness workflow timeouts: subprocess timeouts for harness commands
  // (check). These are local-process timeouts, distinct from
  // provider HTTP timeouts (runtime.providers[].timeoutMs) and from
  // workspaceGit.timeouts (remote git operations). One canonical owner per
  // concept; consumers read these with fallback to named constants.
  // `commandErroredRetries` / `commandRetryBackoffMs`: how often the ONE
  // command runner (src/workflow/checkout-setup.ts) retries a command that
  // ERRORED — ended by its ceiling or a signal, failed to spawn, or printed an
  // environmental marker (no space, an npm cache miss, a network reset) — and
  // how long it waits before the first retry (doubled each time). A command
  // that merely FAILED (any other non-zero exit) is never retried.
  const harnessConfigSchema = z.strictObject({
    typecheckTimeoutMs: z.number().int().positive().max(600000),
    commandErroredRetries: z.number().int().min(0).max(10).optional(),
    commandRetryBackoffMs: z.number().int().min(0).max(3_600_000).optional(),
  }).optional();
  // Promotion (src/workflow/promotion/): `profileDirectory` is the
  // repository-relative directory that holds the promotion profiles on the
  // SOURCE branch (`<directory>/<name>.json`, read from the source commit).
  const promotionConfigSchema = z.strictObject({
    profileDirectory: repositoryRelativePath,
  }).optional();
  // Code-intelligence config (auto-indexing, retrieval ranking, auto-heal).
  // Mirrors the web-UI `codeIntelligence` consumer shape
  // (server/harness-config.ts). All fields optional — the web UI applies
  // documented defaults for any missing field.
  // `retrieval` is a tuning-knob map rather than a fixed object, because a
  // knob added to the intelligence layer should be settable without a schema
  // edit here. It is NOT a free-form map: the key must be a name that layer
  // actually answers to, asked of the layer itself.
  //
  // As an unconstrained `z.record` it accepted anything. A misspelled knob
  // passed the write gate, was then dropped by the reader that forwards only
  // the names it knows, and never reached the resolver that would have
  // refused it — accepted at every step, applied at none. The operator's
  // setting read as saved and did nothing. Constraining the KEY (while
  // leaving the SET of keys derived) is what closes that without turning a
  // growing knob list into a second list to maintain.
  //
  // Two layers answer to names in this one map — the intelligence ranking
  // defaults and the file-retrieval knobs — so the valid set is the union of
  // what each layer says it answers to. Asking both is what keeps this a
  // derivation rather than a third list that can disagree with either.
  const retrievalSettingNames = [
    ...new Set([...INTELLIGENCE_SETTING_NAMES, ...EXP474_RETRIEVAL_SETTING_NAMES]),
  ].sort();
  // A `z.record` has no per-key `.shape`, so `isConfigPathDeclared(
  // "codeIntelligence.retrieval.phraseBoost")` could not resolve a real
  // knob — Settings would refuse to register it. Deriving a strictObject
  // from the same name list keeps unknown keys refused and makes each
  // known name a declared path the exposure gate can bind to.
  const retrievalKnobShape: Record<string, z.ZodOptional<z.ZodNumber>> = {};
  for (const name of retrievalSettingNames) {
    retrievalKnobShape[name] = z.number().optional();
  }
  const retrievalKnobSchema = z.strictObject(retrievalKnobShape);
  const codeIntelligenceConfigSchema = z.strictObject({
    autoIndexOnProjectAdd: z.boolean().optional(),
    watchIndexedProjects: z.boolean().optional(),
    indexWatchDebounceMs: z.number().int().positive().optional(),
    indexPollMs: z.number().int().positive().optional(),
    indexTimeoutMs: z.number().int().positive().optional(),
    mapCacheTtlMs: z.number().int().positive().optional(),
    quickViewCacheTtlMs: z.number().int().positive().optional(),
    searchDefaultLimit: z.number().int().positive().optional(),
    searchMaxLimit: z.number().int().positive().optional(),
    retrieveDefaultLimit: z.number().int().positive().optional(),
    retrieveMaxLimit: z.number().int().positive().optional(),
    repoMapLanguagePreview: z.number().int().positive().optional(),
    farm: z.strictObject({
      perFileTimeoutMs: z.number().int().positive().optional(),
      initTimeoutMs: z.number().int().positive().optional(),
      maxInitFailures: z.number().int().positive().optional(),
    }).optional(),
    retrieval: retrievalKnobSchema.optional(),
    autoHeal: z.strictObject({
      enabled: z.boolean().optional(),
      staleFullCoverageThreshold: z.number().int().positive().optional(),
      staleSampleFloor: z.number().int().positive().optional(),
      staleSampleCeiling: z.number().int().positive().optional(),
    }).optional(),
  }).optional();
  // Interactive chat artifacts: LLM-created apps rendered in a
  // sandboxed iframe. `maxBytes` bounds content; `iframeSandbox` is the
  // sandbox token. Mirrors the web-UI `artifacts` consumer shape.
  const artifactsConfigSchema = z.strictObject({
    maxBytes: z.number().int().positive().optional(),
    iframeSandbox: z.string().min(1).optional(),
    idLength: z.number().int().positive().max(64).optional(),
  }).optional();
  // Redaction-adapter tuning (web server). Mirrors the web-UI `redaction`
  // consumer shape (server/harness-config.ts). The memo bound caps how many
  // distinct tool_calls argument payloads `redactToolCallArguments` keeps
  // memoised (content-addressed, LRU-evicted) — a bound, not a detector.
  const redactionConfigSchema = z.strictObject({
    toolCallArgumentsCacheEntries: z.number().int().positive().optional(),
  }).optional();
  // Web-UI tunables: dependency-graph force layout, metrics polling,
  // self-improving analyzer thresholds, quality scoring weights, and the
  // prompt-generator option catalog. Mirrors the web-UI `webUi` consumer
  // shapes (server/harness-config.ts GraphConfig/MetricsConfig/
  // SelfImprovingConfig/QualityConfig + the frontend promptGenerator
  // catalog). All fields optional — the web UI applies documented defaults.
  const promptGeneratorEntrySchema = z.strictObject({
    id: z.string().min(1),
    label: z.string().min(1),
    instruction: z.string().min(1),
  });
  const webUiConfigSchema = z.strictObject({
    graph: z.strictObject({
      maxNodes: z.number().int().positive().optional(),
      repulsion: z.number().positive().optional(),
      springLength: z.number().positive().optional(),
      springStrength: z.number().positive().optional(),
      centering: z.number().positive().optional(),
      damping: z.number().positive().optional(),
      iterations: z.number().int().positive().optional(),
      maxNodeRadius: z.number().positive().optional(),
      minNodeRadius: z.number().positive().optional(),
      nodeSpacing: z.number().positive().optional(),
      minSeparation: z.number().positive().optional(),
      labelMinNodeScreenPx: z.number().positive().optional(),
      labelTopDegreeCount: z.number().int().positive().optional(),
      labelGapPx: z.number().positive().optional(),
      labelPaddingPx: z.number().positive().optional(),
      minZoom: z.number().positive().optional(),
      maxZoom: z.number().positive().optional(),
      minCanvasPx: z.number().int().positive().optional(),
      maxFitScale: z.number().positive().optional(),
      fitMarginPx: z.number().int().positive().optional(),
      fallbackWidth: z.number().int().positive().optional(),
      fallbackHeight: z.number().int().positive().optional(),
      labelFontPx: z.number().positive().optional(),
      labelShowAllZoom: z.number().positive().optional(),
      hitPaddingPx: z.number().positive().optional(),
      wheelZoomFactor: z.number().positive().optional(),
      buttonZoomIn: z.number().positive().optional(),
      buttonZoomOut: z.number().positive().optional(),
      indexingPollMs: z.number().int().positive().optional(),
      maxCyclesDisplayed: z.number().int().positive().optional(),
    }).optional(),
    metrics: z.strictObject({
      pollMs: z.number().int().positive().optional(),
      historyMax: z.number().int().positive().optional(),
    }).optional(),
    selfImproving: z.strictObject({
      minSampleCount: z.number().int().positive().optional(),
      errorRateThreshold: z.number().min(0).max(1).optional(),
      slowToolMsThreshold: z.number().positive().optional(),
      slowLlmMsThreshold: z.number().positive().optional(),
      maxSuggestions: z.number().int().positive().optional(),
    }).optional(),
    // The scoreMax/scoreMin + penalty caps/weights below define the web
    // UI's quality-score COMPOSITE. That composite is a configured index
    // derived from these declared weights over the measured sub-metrics
    // (issues/KLOC, complexity hotspots, clone ratio, typed-file
    // fraction, issue density) — it is NOT a measurement, and consumers
    // must present it as a configured index (derivation stated) and must
    // never gate a check's pass/fail on it. The lint auto-check gates on
    // `lintGate` instead: explicit declared thresholds over the MEASURED
    // sub-metrics themselves. A sub-metric that could not be measured
    // must fail the gate (deny-by-default), never pass it.
    quality: z.strictObject({
      scoreMax: z.number().int().positive().optional(),
      scoreMin: z.number().int().min(0).optional(),
      penaltyCapIssuesPerKloc: z.number().int().positive().optional(),
      penaltyCapHotspots: z.number().int().positive().optional(),
      penaltyCapClones: z.number().int().positive().optional(),
      penaltyCapUntyped: z.number().int().positive().optional(),
      penaltyCapIssueDensity: z.number().int().positive().optional(),
      penaltyWeightIssuesPerKloc: z.number().min(0).optional(),
      penaltyWeightHotspots: z.number().min(0).optional(),
      penaltyWeightClones: z.number().min(0).optional(),
      penaltyWeightUntyped: z.number().min(0).optional(),
      penaltyWeightIssueDensity: z.number().min(0).optional(),
      topCategoriesCount: z.number().int().positive().optional(),
      lintGate: z.strictObject({
        maxIssuesPerKloc: z.number().min(0).optional(),
        maxComplexityHotspots: z.number().int().min(0).optional(),
        maxCloneRatio: z.number().min(0).max(1).optional(),
        minTypedFileFraction: z.number().min(0).max(1).optional(),
      }).optional(),
    }).optional(),
    promptGenerator: z.strictObject({
      roles: z.array(promptGeneratorEntrySchema).optional(),
      tones: z.array(promptGeneratorEntrySchema).optional(),
      outputFormats: z.array(promptGeneratorEntrySchema).optional(),
      languages: z.array(promptGeneratorEntrySchema).optional(),
      constraints: z.array(promptGeneratorEntrySchema).optional(),
    }).optional(),
    // The budgets' names and kinds are the root policy's one list (`webPerformanceBudgets.kinds`).
    performance: z.strictObject(Object.fromEntries(Object.entries(ROOT_POLICY.workflow.webPerformanceBudgets.kinds).map(([name, kind]) => [name,
      (kind === "positive-int" ? z.number().int().positive() : kind === "non-negative" ? z.number().min(0) : z.number().positive()).optional()])) as Record<keyof typeof ROOT_POLICY.workflow.webPerformanceBudgets.kinds, z.ZodOptional<z.ZodNumber>>).optional(),
  }).optional();
  const runtimeSchema = z.strictObject({
    schemaVersion: z.literal(policy.configuration.documentSchemaVersion),
    project: z.strictObject({
      id: z.string().max(policy.configuration.maximumProjectIdCharacters)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      root: z.literal(policy.configuration.projectRootLiteral),
    }),
    data: z.strictObject({
      defaultClassification: z.enum(CONFIGURABLE_DEFAULT_CLASSIFICATIONS),
    }),
    state: z.strictObject({
      root: z.literal(statePath("state")),
      receipts: z.strictObject({
        executionEvidence: z.literal("evidence/executions"),
      }),
    }),
    alignmentCheckpoint: z.strictObject({
      cadence: z.strictObject({
        maximumEventsBetweenCheckpoints: z.number().int().positive()
          .max(alignmentLimits.maximumEventsBetweenCheckpoints),
        maximumActionsBetweenCheckpoints: z.number().int().positive()
          .max(alignmentLimits.maximumActionsBetweenCheckpoints),
        maximumProviderInputTokensBetweenCheckpoints: z.number().int().positive()
          .max(alignmentLimits.maximumProviderInputTokensBetweenCheckpoints),
        maximumWallClockSecondsBetweenSafeBoundaryChecks: z.number().int().positive()
          .max(alignmentLimits.maximumWallClockSecondsBetweenSafeBoundaryChecks),
      }),
      budgets: z.strictObject({
        maximumProjectionBytes: z.number().int().positive()
          .max(alignmentLimits.maximumProjectionBytes),
        maximumObserverInputTokens: z.number().int().positive()
          .max(alignmentLimits.maximumObserverInputTokens),
      }),
      observerProfile: z.enum(observerProfiles),
    }),
    repositoryPaths: z.strictObject({
      schemaVersion: z.literal(REPOSITORY_PATH_SETTINGS_SCHEMA_VERSION),
      profile: z.literal(REPOSITORY_PATH_PROFILE),
      limits: z.strictObject({
        maximumPathUtf8Bytes: z.number().int().positive()
          .max(REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS.maximumPathUtf8Bytes),
        maximumSegmentUtf8Bytes: z.number().int().positive()
          .max(REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS.maximumSegmentUtf8Bytes),
        maximumSegmentUtf16CodeUnits: z.number().int().positive()
          .max(REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS.maximumSegmentUtf16CodeUnits),
        maximumSegments: z.number().int().positive()
          .max(REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS.maximumSegments),
        maximumPathsPerSet: z.number().int().positive()
          .max(REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS.maximumPathsPerSet),
      }),
    }),
    repositoryRootCapability: z.strictObject({
      schemaVersion: z.literal(repositoryRootCapabilityBudget.schemaVersion),
      maximumConcurrentBorrowsPerCapability: z.number().int().positive()
        .max(repositoryRootCapabilityLimitCeilings.maximumConcurrentBorrowsPerCapability),
      maximumOperationsPerBorrow: z.number().int().positive()
        .max(repositoryRootCapabilityLimitCeilings.maximumOperationsPerBorrow),
      maximumBorrowOperationsPerCapability: z.number().int().positive()
        .max(repositoryRootCapabilityLimitCeilings.maximumBorrowOperationsPerCapability),
      maximumBorrowOperationsPerTask: z.number().int().positive()
        .max(repositoryRootCapabilityLimitCeilings.maximumBorrowOperationsPerTask),
      maximumCapabilityRotationsPerTask: z.number().int().positive()
        .max(repositoryRootCapabilityLimitCeilings.maximumCapabilityRotationsPerTask),
      maximumBorrowedPathBytes: z.number().int().positive()
        .max(repositoryRootCapabilityLimitCeilings.maximumBorrowedPathBytes),
      maximumBorrowedPathSegments: z.number().int().positive()
        .max(repositoryRootCapabilityLimitCeilings.maximumBorrowedPathSegments),
    }),
    contracts: contractsSchema,
    runtime: runtimeConfigSchema.optional(),
    agents: agentsConfigSchema.optional(),
    tools: toolsConfigSchema.optional(),
    qualityPacks: qualityPacksConfigSchema.optional(),
    workspaceGit: workspaceGitSchema.optional(),
    // The performance section carries cross-field invariants the leaf schemas
    // cannot express (the benchmark repetition range, the explicit-bounds
    // pairing, the label-length cap). `performanceConfigViolations` is their
    // ONE owner; splicing it in here puts those invariants in front of every
    // document parse, so the write gate — which validates whole documents
    // through this schema at its single entry point — refuses a section whose
    // own contract calls it invalid, instead of persisting it for the next
    // consumer to trip over. The refinement sits at the DOCUMENT composition,
    // not inside PERFORMANCE_CONFIG_SCHEMA, so the standalone section parser
    // (used by the diagnostic and benchmark CLIs to resolve the section with
    // best-effort fallback) keeps its documented permissive behavior.
    //
    // The issue message is `performanceConfigRefusalMessage(code, section)` —
    // the machine identity AND the rule's plain-words sentence, because this
    // message is what a refused settings save renders in the sheet (the write
    // door passes it through verbatim). A bare code here reached the person
    // who pressed save as machinery; every other section's refinement pushes
    // its sentence inline, and the checker now speaks the same grammar.
    performance: PERFORMANCE_CONFIG_SCHEMA.superRefine((section, ctx) => {
      for (const violation of performanceConfigViolations(section)) {
        ctx.addIssue({
          code: "custom",
          message: performanceConfigRefusalMessage(violation, section),
        });
      }
    }).optional(),
    selfProtection: SELF_PROTECTION_CONFIG_SCHEMA.optional(),
    // The outbound HTTP door's own settings (`shared/outbound-policy.ts`
    // declares the section beside the policy it steers).
    network: OUTBOUND_POLICY_SCHEMA.optional(),
    debug: DEBUG_CONFIG_SCHEMA.superRefine((section, ctx) => {
      for (const violation of debugConfigViolations(section)) {
        ctx.addIssue({
          code: "custom",
          message: debugConfigRefusalMessage(violation),
        });
      }
    }).optional(),
    privacy: privacyConfigSchema.optional(),
    memory: memoryConfigSchema.optional(),
    editor: editorConfigSchema.optional(),
    timeline: timelineConfigSchema.optional(),
    resourceLock: resourceLockConfigSchema.optional(),
    workspaceIsolation: workspaceIsolationConfigSchema,
    promotion: promotionConfigSchema,
    evaluation: evaluationConfigSchema.optional(),
    migrationAuthority: migrationAuthorityConfigSchema,
    testExecution: testExecutionConfigSchema,
    harness: harnessConfigSchema,
    codeIntelligence: codeIntelligenceConfigSchema,
    artifacts: artifactsConfigSchema,
    redaction: redactionConfigSchema,
    webUi: webUiConfigSchema,
    // Exposure-module sections — the operator knobs each shared exposure
    // module publishes as a settings-UI customization. Each is the module's
    // own `z.strictObject` (the module-exports-its-section idiom), spliced in
    // OPTIONAL so a fresh config omits them and every knob reads its default.
    search: SEARCH_CONFIG_SCHEMA.optional(),
    context: CONTEXT_CONFIG_SCHEMA.optional(),
    awareness: AWARENESS_CONFIG_SCHEMA.optional(),
    bias: BIAS_CONFIG_SCHEMA.optional(),
    hallucination: HALLUCINATION_CONFIG_SCHEMA.optional(),
    learning: LEARNING_CONFIG_SCHEMA.optional(),
    quality: QUALITY_CONFIG_SCHEMA.optional(),
    // The safety section carries posture floors the leaf schemas cannot
    // express (a detector may not be disarmed, a gate check may not be
    // turned off, the consequential-tools narrowing may not leave the
    // workaround detector unable to fire). `safetyConfigViolations` is
    // their ONE owner, consulted by the write gate here and by the boot +
    // per-run doors through the config accessors — three doors, one floor
    // owner, so a weakening section is refused on every sanctioned path.
    // The message is the floor's own machine code AND plain-words sentence
    // because it is what a refused settings save renders in the sheet.
    safety: SAFETY_CONFIG_SCHEMA.superRefine((section, ctx) => {
      for (const violation of safetyConfigViolations(section)) {
        ctx.addIssue({
          code: "custom",
          message: safetyConfigRefusalMessage(violation),
        });
      }
    }).optional(),
  });
  return Object.freeze({ runtimeSchema, mcpServerSchema: mcpServerConfigSchema });
}

/** Generate immutable tooling evidence only when a consumer requests it. */
function compileConfigContractArtifact(runtimeSchema: z.ZodType, policy: ConfigContractPolicyProjection) {
  const generatedSchema = deepFreeze(z.toJSONSchema(runtimeSchema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    cycles: "ref",
    reused: "inline",
  }));
  const schemaHash = canonicalHash(generatedSchema);
  const identity = deepFreeze({
    documentSchemaVersion: policy.configuration.documentSchemaVersion,
    validatorRevision: policy.configuration.contract.validatorRevision,
    sourcePath: policy.configuration.contract.sourcePath,
    sourceSha256: policy.configuration.contract.sourceSha256,
    generatedSchemaPath: policy.configuration.contract.generatedSchemaPath,
    schemaHash,
  });
  const identityHash = canonicalHash(identity);
  const artifact = deepFreeze({
    schemaVersion: policy.configuration.contract.schemaArtifactVersion,
    sourceSha256: policy.configuration.contract.sourceSha256,
    schemaHash,
    identity,
    identityHash,
    schema: generatedSchema,
  });
  return artifact;
}

/** The public compiler still validates and emits the complete candidate contract eagerly. */
export function buildConfigContract<const Projection extends ConfigContractPolicyProjection>(projection: Projection) {
  const runtime = buildRuntimeConfigContract(projection);
  const artifact = compileConfigContractArtifact(runtime.runtimeSchema, projection);
  return Object.freeze({
    ...runtime,
    generatedSchema: artifact.schema,
    schemaHash: artifact.schemaHash,
    identity: artifact.identity,
    identityHash: artifact.identityHash,
    artifact,
  });
}

type HostRuntimeContract = ReturnType<typeof buildRuntimeConfigContract<typeof ROOT_POLICY>>;
let hostRuntimeContract: HostRuntimeContract | undefined;

// This cache owns only the schema compiled from the deeply frozen policy.
// Config bytes, credentials, environment and application state never enter it.
function getHostRuntimeContract(): HostRuntimeContract {
  return hostRuntimeContract ??= buildRuntimeConfigContract(ROOT_POLICY);
}

export type ConfigDocument = DeepReadonly<z.infer<HostRuntimeContract["runtimeSchema"]>>;
export type RepositoryRootCapabilityBudgetConfig = ConfigDocument["repositoryRootCapability"];
export type ToolsConfig = NonNullable<ConfigDocument["tools"]>;
export type McpServerConfig = NonNullable<ToolsConfig["mcpServers"]>[number];
export type QualityPacksConfig = NonNullable<ConfigDocument["qualityPacks"]>;
export type WorkspaceGitConfig = NonNullable<ConfigDocument["workspaceGit"]>;
export type EditorConfig = NonNullable<ConfigDocument["editor"]>;
export type TimelineConfig = NonNullable<ConfigDocument["timeline"]>;
export type ResourceLockConfig = NonNullable<ConfigDocument["resourceLock"]>;
export type WorkspaceIsolationConfig = NonNullable<ConfigDocument["workspaceIsolation"]>;
export type EvaluationConfig = NonNullable<ConfigDocument["evaluation"]>;
export type MigrationAuthorityDocumentConfig = NonNullable<ConfigDocument["migrationAuthority"]>;
export type TestExecutionConfig = NonNullable<ConfigDocument["testExecution"]>;
export type HarnessConfig = NonNullable<ConfigDocument["harness"]>;
export type DebugConfigDocument = NonNullable<ConfigDocument["debug"]>;
export type CodeIntelligenceConfig = NonNullable<ConfigDocument["codeIntelligence"]>;
export type ArtifactsConfig = NonNullable<ConfigDocument["artifacts"]>;
export type WebUiConfig = NonNullable<ConfigDocument["webUi"]>;
export type DedupCompressionConfig = NonNullable<NonNullable<ConfigDocument["memory"]>["dedupCompression"]>;
export type UserPreferencesConfig = NonNullable<NonNullable<ConfigDocument["runtime"]>["userPreferences"]>;
export type AutoCheckConfig = NonNullable<NonNullable<ConfigDocument["tools"]>["autoCheck"]>;
export const AGENT_CAPABILITY_CATALOG = AGENT_CAPABILITIES;

/**
 * EDITOR_DEFAULT_LIMITS — the single source of truth for the editor's
 * hard byte limits. Consumed by `editor/edit-operations.ts` and
 * `editor/transactional-editor.ts` so the limit cannot drift between
 * the two implementation files. A test
 * (`test/prevention/editor-defaults-ssot.test.ts`) byte-binds this
 * declaration so accidental removal or duplication fails loudly.
 *
 * Per "one canonical owner per concept": this is the ONLY
 * owner of the editor's max-byte constants. Inline literals in
 * `edit-operations.ts` were removed (replaced by re-exports of this
 * constant) to prevent drift.
 */
export const EDITOR_DEFAULT_LIMITS: Readonly<{
  maxFileBytes: number;
  maxPatchBytes: number;
  maxInsertTextBytes: number;
  /** R49-V8: maximum UTF-8 byte length of a file PATH accepted by the
   * transactional editor. Previously a scattered inline `4096` literal
   * in transactional-editor.ts that bypassed this owner.
   * Deriving it here keeps the editor aligned with the canonical limit
   * owner instead of a parallel hardcoded copy. */
  maxPathBytes: number;
}> = deepFreeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxPatchBytes: 4 * 1024 * 1024,
  maxInsertTextBytes: 4 * 1024 * 1024,
  maxPathBytes: 4096,
});

/** Pure configuration schema. Filesystem acquisition belongs to config.ts. */
export function getConfigDocumentSchema() {
  return getHostRuntimeContract().runtimeSchema;
}

/** The registration and document write doors share the same compiled schema instance. */
export function getMcpServerConfigSchema() {
  return getHostRuntimeContract().mcpServerSchema;
}
let hostArtifact: ReturnType<typeof compileConfigContractArtifact> | undefined;

/** One immutable artifact for the frozen host policy, independent of config file state. */
export function getConfigContractArtifact() {
  return hostArtifact ??= compileConfigContractArtifact(getConfigDocumentSchema(), ROOT_POLICY);
}
