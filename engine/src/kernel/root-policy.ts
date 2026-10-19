import { DATA_CLASSIFICATION, FORENSIC_CLASSIFICATIONS } from "../privacy/classification-catalog.ts";
import { LEXICAL_REUSE_LIMITS } from "./lexical-policy.ts";
import { WEB_PERFORMANCE_BUDGET_KINDS, WEB_PERFORMANCE_GATE_PREFIX, WEB_PERFORMANCE_LEDGER_FIELD } from "./web-performance-budgets.ts";
import { canonicalHash, deepFreeze, type CanonicalValue } from "./integrity.ts";
import {
  CONFIG_FILE_BASENAME,
  PRODUCT_NAME,
  cryptoDomain,
  schemaId,
  STATE_DIRECTORY_NAME,
  statePath,
  statePathPrefix,
} from "./product-identity.ts";
import { LANDLOCK_ACCESS_FS_FLAG_NAMES } from "../filesystem/self-protection/self-protection-contracts.ts";
import {
  AUDIT_MATRIX_ANGLES,
  AUDIT_MATRIX_STAGES,
  REQUIREMENTS_REGISTRY_FILE_SHA256,
  REQUIREMENTS_REGISTRY_IDENTITY_HASH,
  REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
  REQUIREMENTS_REGISTRY_SCHEMA_HASH,
  REQUIREMENTS_REGISTRY_SOURCE_PATH,
} from "./requirements.ts";

/**
 * Non-configurable S1 safety floor. Each literal is a root-of-trust or protocol
 * invariant, not an operational default. A later release may strengthen this
 * policy only through the out-of-band evolution workflow.
 */
const ROOT_POLICY_VALUE = {
  id: schemaId("root-policy", 1),
  sourcePath: "src/kernel/root-policy.ts",
  version: 1,
  requirements: {
    registrySchemaVersion: REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
    registryFile: "traceability/requirements.json",
    registryFileSha256: REQUIREMENTS_REGISTRY_FILE_SHA256,
    registrySchemaHash: REQUIREMENTS_REGISTRY_SCHEMA_HASH,
    registryIdentityHash: REQUIREMENTS_REGISTRY_IDENTITY_HASH,
    sourceArtifact: REQUIREMENTS_REGISTRY_SOURCE_PATH,
    applicableIds: [
      "REQ-001",
      "REQ-002",
      "REQ-003",
      "REQ-004",
      "REQ-005",
      "REQ-006",
      "REQ-008",
      "REQ-009",
      "REQ-010",
      "REQ-011",
      "REQ-013",
      "REQ-014",
      "REQ-015",
      "REQ-016",
      "REQ-017",
      "REQ-018",
      "REQ-019",
      "REQ-020",
      "REQ-021",
      "REQ-023",
      "REQ-024",
      "REQ-025",
      "REQ-026",
      "REQ-027",
      "REQ-028",
      "REQ-029",
      "REQ-032",
      "REQ-033",
      "REQ-034",
      "REQ-035",
      "DER-001",
      "DER-003",
      "DER-004",
      "DER-005",
      "DER-006",
      "DER-007",
      "DER-008",
      "DER-009",
      "DER-010",
      "DER-011",
      "DER-016",
      "DER-017",
      "DER-018",
      "DER-021",
      "DER-022",
      "DER-023",
      "DER-024",
      "DER-025",
      "DER-026",
      "DER-027",
      "DER-028",
      "DER-029",
      "DER-030",
      "DER-031",
      "DER-032",
      "DER-033",
      "DER-034",
      "DER-035",
      "DER-036",
      "DER-037",
      "DER-038",
      "DER-039",
      "DER-040",
      "DER-041",
      "DER-042",
      "DER-043",
    ],
  },
  configuration: {
    documentSchemaVersion: 3 as number,
    contract: {
      sourcePath: "src/kernel/config-contracts.ts",
      sourceSha256: "b5faf98c8c89443ce417cdaacdecc2d1704d1b8368c22d3001c629af3a72f80c",
      generatedSchemaPath: "traceability/config-document-schema.json",
      validatorRevision: "config-document-validator/v3",
      schemaArtifactVersion: schemaId("config-document-schema", 2),
      compilerLimits: {
        maximumPolicyStringCharacters: 512,
        maximumProtocolIdentifiers: 128,
      },
    },
    maximumBytes: 65_536,
    maximumProjectIdCharacters: 128,
    basename: CONFIG_FILE_BASENAME,
    projectRootLiteral: ".",
    repositoryScanExclusions: [
      ".git",
      STATE_DIRECTORY_NAME,
      "node_modules",
      "coverage",
      ".artifacts",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      "runs",
      "large-codebases",
      "babel-work",
      "_experiments",
      "experiments",
    ],
    repositoryScanFileExclusions: [".DS_Store", "Thumbs.db"],
    repositoryScanFileSuffixExclusions: [".pyc", ".pyo"],
    // Experiment source directories — physically relocated to `_experiments/`
    // at the workspace root (see exp477). These patterns still guard the scan
    // roots `src/` and `test/` (and `_experiments/` — see `EXPERIMENT_SCAN_ROOTS`
    // in `src/shared/source-scan.ts`): they exclude any experiment code that
    // remains under `src/` or `test/` (e.g. the `test/exp420/`, `test/exp464/`,
    // `test/llm-beyond-max/` test dirs) and would re-apply if experiment code is
    // merged back into `src/`. Only the segment directly below a scan root is
    // matched (glob-style, `*` does not cross `/`), so `unified` excludes
    // `src/unified/` but never the production `src/memory/unified/`. The whole
    // `_experiments/` tree is also excluded by `repositoryScanExclusions` above
    // (defense-in-depth for the safe-repository-reader). Opt back in with the
    // HARNESS_INCLUDE_EXPERIMENTS=1 environment variable or the
    // `--include-experiments` harness flag. See `src/shared/source-scan.ts`.
    experimentSourceExclusions: ["exp*", "auto-learning", "llm-beyond-max", "unified"],
    rejectUnknownKeys: true,
    rejectDuplicateKeys: true,
    rejectAlternateDocumentsRecursively: true,
    bindDescriptorAndParentDirectory: true,
    rejectHardlinks: true,
    rejectSymlinks: true,
    requiredConfigFileMode: "0600",
  },
  contracts: {
    implementation: "s2.3-offline-contracts/v1",
    schemaDialect: "https://json-schema.org/draft/2020-12/schema",
    protocolIds: ["openai-responses", "openai-chat-completions", "mcp-2025-11-25"],
    modelProtocolIds: ["openai-responses", "openai-chat-completions"],
    mcpProtocolVersion: "2025-11-25",
    chatStreamDoneSentinel: "[DONE]",
    unknownMetadataClassification: DATA_CLASSIFICATION.regulatedRestricted,
    unknownMetadataForwarding: "forbidden",
    limits: {
      maximumIdentifierCharacters: 512,
      maximumTextCharacters: 1_048_576,
      maximumTools: 128,
      maximumMessages: 4_096,
      maximumEvents: 100_000,
      maximumToolSchemaDepth: 32,
      maximumToolSchemaProperties: 4_096,
      maximumLosses: 256,
    },
  },
  runtime: {
    implementation: "openai-compatible-provider-adapter/v1",
    limits: {
      maximumProviders: 16,
      maximumModelsPerProvider: 64,
      /**
       * The outbound door's pinned connection pools kept at once (one per
       * checked address set, per proxy): the least recently used one is
       * closed (gracefully) past this bound, so a resolver rotating its
       * answers cannot grow the pool set without limit.
       */
      maximumPinnedDispatchers: 64,
      maximumRetries: 10,
      maximumTimeoutMs: 600_000,
      maximumInitialBackoffMs: 10_000,
      maximumBackoffMs: 60_000,
      maximumBackoffMultiplier: 10,
      maximumMaxTokens: 1_048_576,
      maximumTemperature: 2,
      maximumSystemPromptBytes: 8_192,
      maximumModelIdCharacters: 256,
      maximumBaseUrlCharacters: 2_048,
      maximumProviderIdCharacters: 128,
      maximumApiKeyEnvVarCharacters: 256,
      maximumAgents: 5,
      maximumAgentNameCharacters: 128,
      maximumAgentMaxTurns: 100,
      maximumAgentTimeoutMs: 600_000,
      maximumToolTimeoutMs: 600_000,
      maximumToolOutputBytes: 1_048_576,
      maximumToolMemoryBytes: 268_435_456,
      maximumEnabledTools: 64,
      maximumMcpServers: 16,
      maximumMcpServerIdCharacters: 128,
      maximumToolNameCharacters: 128,
      maximumToolDescriptionCharacters: 4_096,
      maximumToolIterations: 100,
      maximumSseEventBytes: 16_777_216,
      maximumSseLineBytes: 1_048_576,
      maximumGitOutputBytes: 67_108_864,
      maximumGitErrorBytes: 16_777_216,
      maximumGitInputBytes: 16_777_216,
      maximumRetryableStatusCodes: 64,
    },
  },
  tools: {
    implementation: "governed-tool-manifest/v1",
    limits: {
      maximumToolTimeoutMs: 600_000,
      maximumToolOutputBytes: 1_048_576,
      maximumToolMemoryBytes: 268_435_456,
      maximumEnabledTools: 64,
      maximumMcpServers: 16,
      maximumMcpServerIdCharacters: 128,
      maximumToolNameCharacters: 128,
      maximumToolDescriptionCharacters: 4_096,
      maximumReadBytes: 16_777_216,
      maximumListEntries: 1_000_000,
      defaultToolTimeoutMs: 30_000,
      // Safety floor: a heartbeat faster than this keeps the Node event loop
      // alive after the task completes, preventing natural exit (the bug the
      // long-task runner was designed to fix). Non-configurable.
      minimumLongTaskHeartbeatMs: 1000,
    },
  },
  editor: {
    limits: {
      maxFileBytes: 1_073_741_824,
      maxPatchBytes: 67_108_864,
      maxInsertTextBytes: 67_108_864,
    },
  },
  timeline: {
    limits: {
      maxDocumentBytes: 67_108_864,
      maxDocuments: 10_000_000,
      maxEdges: 100_000_000,
      maxDbFilenameCharacters: 256,
      maxSqliteCacheSizeAbsolute: 1_073_741_824,
      maxSqliteBusyTimeoutMs: 300_000,
    },
  },
  resourceLock: {
    limits: {
      maxTimeoutMs: 600_000,
      maxPollIntervalMs: 60_000,
      maxStaleMs: 600_000,
    },
  },
  evaluation: {
    limits: {
      maxIdentityAttestationTimeoutMs: 600_000,
    },
  },
  migrationAuthority: {
    limits: {
      maxLeaseTtlMs: 600_000,
      maxHeartbeatIntervalMs: 30_000,
      maxRenewalCeilingMs: 600_000,
      maxOrphanGraceMs: 300_000,
      maxReconciliationTimeoutMs: 600_000,
      maxResourcesPerLease: 4096,
      maxWaiters: 64,
      maxBusyTimeoutMs: 300_000,
      maxJournalEntriesPerLease: 100_000,
      maxCheckpointCadenceMs: 10_000,
      maxFencingGeneration: "9223372036854775807",
    },
    backend: {
      candidate: "node:sqlite",
      requiredJournalMode: "delete",
      requiredSynchronous: "extra",
      requiredForeignKeys: true,
      requiredDefensive: true,
      walAllowed: false,
    },
    recovery: {
      directionPreferenceDefault: "next",
      blockedUnknownEffectPolicy: "preserve-journal-and-evidence",
    },
  },
  forensics: {
    implementation: "s3.1-offline-forensic-primitives/v2",
    schemaDialect: "https://json-schema.org/draft/2020-12/schema",
    canonicalization: "RFC8785-with-verified-erratum-7920",
    algorithms: {
      contentDigest: "SHA-256",
      chainMac: "HMAC-SHA-256",
      encryption: "AES-256-GCM",
      keyBytes: 32,
      nonceBytes: 12,
      authenticationTagBytes: 16,
      digestBytes: 32,
    },
    domains: {
      ledgerEntry: `${cryptoDomain("ledger-entry", 1)}\u0000`,
      ledgerMac: `${cryptoDomain("ledger-mac", 1)}\u0000`,
      sealedPayload: `${cryptoDomain("sealed-payload", 1)}\u0000`,
      blindIndex: `${cryptoDomain("blind-index", 1)}\u0000`,
      ledgerMacKeyDerivation: `${cryptoDomain("key-derivation/ledger-mac", 1)}\u0000`,
      blindIndexKeyDerivation: `${cryptoDomain("key-derivation/blind-index", 1)}\u0000`,
      keyCheckDerivation: `${cryptoDomain("key-derivation/key-check", 1)}\u0000`,
    },
    limits: {
      maximumInputBytes: 1_048_576,
      maximumCanonicalBytes: 1_048_576,
      maximumDepth: 64,
      maximumNodes: 100_000,
      maximumSequenceDecimal: "9223372036854775807",
      maximumMonotonicNanosecondsDecimal: "9223372036854775807",
      maximumIdentifierCharacters: 512,
      maximumTextBytes: 1_048_576,
      maximumHeaders: 256,
      maximumHeaderNameBytes: 256,
      maximumHeaderValueBytes: 16_384,
      maximumCaptures: 128,
      maximumErrorCauses: 16,
      maximumProjectionBytes: 65_536,
    },
    actorKinds: ["harness", "operator", "provider", "model", "agent", "tool", "recovery"],
    eventKinds: [
      "ingress.received",
      "ingress.validated",
      "forward.queued",
      "forward.started",
      "forward.completed",
      "forward.failed",
      "provider.headers_received",
      "provider.frame_received",
      "provider.error_received",
      "model.event_normalized",
      "mcp.result_normalized",
      "turn.recorded",
      "agent.recorded",
      "tool.recorded",
      "usage.recorded",
      "error.recorded",
      "replay.requested",
      "replay.completed",
      "replay.failed",
      "recovery.started",
      "recovery.completed",
      "recovery.failed",
      "checkpoint.recorded",
      "segment.opened",
      "segment.closed",
      "key.rotated",
      "retention.applied",
      "retention.failed",
      "export.requested",
      "export.completed",
      "export.failed",
      "migration.started",
      "migration.completed",
      "migration.failed",
      "policy.changed",
    ],
    outcomes: ["pending", "succeeded", "failed", "denied", "cancelled"],
    classifications: FORENSIC_CLASSIFICATIONS,
    safeErrorCodes: [
      "input_error",
      "policy_error",
      "protocol_error",
      "provider_error",
      "model_error",
      "tool_error",
      "process_error",
      "storage_error",
      "integrity_error",
      "internal_error",
    ],
    outboxStates: ["received", "prepared", "committed", "forwardable", "receipted", "failed"],
  },
  productBoundary: {
    architecture: "standalone-provider-model-agnostic-replacement",
    externalCodingApplicationRole: "isolated-read-only-historical-research-source-only",
    externalRuntimeDependency: false,
    pluginMode: false,
    wrapperMode: false,
    companionMode: false,
    extensionMode: false,
    childProcessMode: false,
    coRunningMode: false,
    historicalResearchEvidenceAllowlist: [
      "traceability/canonical/harness-requirements.md",
      "traceability/requirements.json",
      "docs/architecture/",
      "docs/research/",
      "traceability/artifacts/manifest.json",
      "verification/benchmarks/",
    ],
    historicalResearchAccessControl: {
      scope: "exact-manifest-bound-admitted-root-and-bounded-query-plan-only",
      launcher: "deny-by-default-path-scoped-wrapper-required-before-tool-launch",
      broadDiscoveryAllowed: false,
      implicitCurrentDirectoryAllowed: false,
      parentSiblingScratchPacketQuarantineTraversalAllowed: false,
      delegatedScopeExpansionAllowed: false,
      transcriptAdmission: "bounded-classified-and-fail-closed-on-scope-disagreement",
      currentFinding: "SEC-001-runbook-search-scope-exposure",
      currentRunDisposition: "confidentiality-tainted-no-readiness-or-no-access-claim",
      realHistoryAccessAvailable: false,
    },
  },
  governedInteractionArchitecture: {
    implementationStage: "target-invariant-only-shared-interaction-ports-and-job-dispatch-unavailable",
    authority: "universal-policy-operation-envelope-over-canonical-tool-command-registry",
    historicalResearchRubric: {
      sourceWindowAuthority: "existing-frozen-requirement-and-admitted-manifest-only",
      balance: "symmetric-source-linked-strength-preservation-and-weakness-friction-analysis",
      sourceAccessExpansionGranted: false,
      windowOrInclusionPredicateChangeAllowed: false,
      unknownEvidencePolicy: "remain-typed-unknown-never-infer",
    },
    clientProjection: {
      firstClient: "command-line",
      futureClient: "web",
      sharedPorts: ["typed-event", "presentation", "control"],
      clientOwnedPolicyOrchestrationStorageJobStateOrCommandConstructionAllowed: false,
      parity: "same-versioned-input-output-progress-cancellation-status-error-approval-task-and-event-contracts",
    },
    jobs: {
      execution: "durable-observable-cancellable-recoverable-background-job",
      identity: "stable-job-task-focus-attempt-and-causal-event-lineage",
      lifecycle: ["accepted", "queued", "running", "cancellation-requested", "cancelled", "succeeded", "failed", "recovery-required"],
      receipts: "persist-before-forward-progress-output-error-cancellation-and-terminal-events",
      conversationLoopBlockingAllowed: false,
      validContinuations: ["steering", "cancellation", "status", "investigation", "authorized-task-continuation"],
      continuity: "ordered-revalidated-and-never-silently-replaced-or-abandoned",
    },
    retrievalProposalBoundary: {
      permittedOutput: "source-linked-registered-typed-tool-or-command-identity-plus-structured-arguments-and-provenance",
      similarityOrRetrievedContentGrantsAuthority: false,
      ambientPathAliasShellOrRepositoryTextGrantsAuthority: false,
      ambientShellConstructionOrEvaluationAllowed: false,
    },
    deterministicDispatch: {
      requiredInputs: [
        "registered-command-tool-and-schema-version",
        "authenticated-principal-and-purpose",
        "project-task-candidate-and-config-identities",
        "classification-policy-and-authorization-decision",
        "live-lease-write-set-and-fencing-token",
        "sandbox-root-network-and-egress-constraints",
        "qualified-executable-identity",
        "canonical-argv-and-scoped-environment",
      ],
      unknownAmbiguousStaleMismatchedShadowedWidenedOrUnqualified: "fail-closed-before-process-creation",
      modelRetrievalOrClientMaySelfAuthorize: false,
    },
    qualification: {
      protocolFirst: "freeze-typed-protocol-invariants-failure-model-independent-oracle-and-evidence-contract-before-selection",
      minimumRepetitions: 3,
      minimumMateriallyDistinctScenarios: 3,
      realBoundaryRequired: true,
      mocksPapersOrOneAdapterSufficient: false,
      requiredFamilies: ["client-port-parity", "responsiveness", "cancellation-and-recovery", "proposal-injection-and-confusion", "path-environment-and-identity-tamper", "authority-bypass-and-observability"],
    },
    runtimeEnforcementAvailable: false,
  },
  modelRepositoryInspectionArchitecture: {
    implementationStage: "target-invariant-only-model-facing-file-inspection-and-redaction-gateway-unavailable",
    authority: "canonical-model-tool-contract-through-safe-repository-reader-and-data-policy-gateway",
    operations: ["exact-whole-text", "exact-chunk-span", "cursor-pagination", "bounded-literal-search", "bounded-approved-regex-search", "optional-qualified-semantic-region-proposal"],
    competingDirectoryInventoryReaderSanitizerLoggerCacheIndexReceiptOrSemanticAuthorityAllowed: false,
    identityAndReceipt: [
      "project-repository-worktree-candidate-base-and-config",
      "canonical-root-file-path-and-stable-file-identity",
      "read-snapshot-content-hash-principal-agent-purpose-task-and-attempt",
      "operation-query-requested-returned-spans-page-cursor-order-and-omissions",
      "detector-policy-config-schema-redaction-map-and-result-identities",
      "truncation-or-content-free-block-reason-and-durable-receipt",
    ],
    snapshot: "descriptor-held-authorized-safe-read-with-same-identity-revalidation-before-page-forward-and-exact-reread",
    snapshotDrift: "invalidate-cursor-and-result-never-mix-versions",
    rawByteIsolation: {
      boundary: "trusted-read-and-redaction-gateway-only",
      unredactedModelToolLogCacheIndexMemoryErrorTelemetryOrEmbeddingExposureAllowed: false,
      rawBytesInReceiptMetadataDiagnosticCursorCacheKeyOrRejectedPreviewAllowed: false,
    },
    authorizedTextRedaction: {
      credentialPresenceAloneRejectsWholeAuthorizedText: false,
      replacement: "minimum-detected-credential-value-or-irreducibly-sensitive-segment-before-egress",
      preserve: ["safe-variable-constant-and-property-names", "delimiters-indentation-and-syntax-structure", "line-count-and-source-identity", "useful-bounded-surrounding-context", "non-recoverable-original-to-redacted-line-and-span-map"],
      sensitiveNameContainingCredentialMaterial: "redact-minimum-sensitive-segment",
      ordinaryCredentialVariableIdentifierVisible: true,
    },
    truthfulBlocking: [
      "redaction-uncertainty",
      "unsupported-binary-or-undecodable-content",
      "unsafe-path-type-link-mount-or-file-identity",
      "unauthorized-scope",
      "stale-snapshot-or-concurrent-drift",
      "oversize-mandatory-view",
      "unbounded-query-or-unsafe-regex",
      "detector-failure-or-span-mapping-ambiguity",
    ],
    patternSearch: {
      boundedInputs: ["pattern-bytes", "file-count-and-bytes", "match-count", "span-and-context", "duration", "cancellation"],
      regexEngine: "qualified-non-backtracking-or-equivalently-bounded-approved-feature-subset",
      denialCases: ["catastrophic-backtracking", "empty-match-explosion", "huge-alternation-or-repetition", "unicode-or-encoding-expansion", "cancellation-race"],
      stableOrderedSnapshotSpansRequired: true,
    },
    semanticDiscovery: {
      enabledBeforeQualification: false,
      recommendationBeforeMeasurementsAllowed: false,
      output: "scored-source-linked-candidate-regions-and-omissions-only-no-bytes-or-authority",
      exposureDecision: "current-snapshot-reauthorize-exact-reread-redact-budget-and-receipt",
      scoreMayWidenScopeSuppressExactResultsSelectStalePageOrCertifySafety: false,
    },
    centralConfigControls: [
      "operation-enablement",
      "whole-chunk-page-query-context-token-byte-file-match-and-time-budgets",
      "pagination-defaults",
      "safe-regex-engine-and-feature-profile",
      "detector-pack-selection-and-versions",
      "qualified-semantic-candidate-configuration",
      "output-context-policy",
    ],
    configurableSafetyFloor: false,
    qualification: {
      protocolFirst: "freeze-request-result-progress-error-cursor-redaction-map-receipt-invariants-failure-model-and-independent-byte-oracle",
      minimumRepetitions: 3,
      minimumMateriallyDistinctScenarios: 3,
      realProjectsRequired: true,
      requiredMeasures: ["fidelity-and-reconstruction", "full-pattern-and-semantic-usefulness", "precision-recall-and-safe-name-preservation", "false-redaction-and-zero-secret-leakage", "encoding-split-multiline-generated-and-high-entropy-carriers", "redos-cancellation-toctou-concurrency-and-stale-page-recovery", "log-cache-index-error-and-telemetry-safety"],
    },
    historicalExternalApplicationRole: "DER-040-historical-evidence-only-never-product-dependency-or-inspection-adapter",
    runtimeEnforcementAvailable: false,
  },
  storageArchitecture: {
    implementationStage: "target-invariant-only-physical-storage-unavailable-until-s3.2",
    ownership: "harness-owned-provider-model-neutral-versioned-schema",
    sourceOfTruth: "canonical-append-only-event-ledger",
    encryptedRawVault: "derived-rebuildable-projection",
    redactedSearch: "derived-rebuildable-projection",
    metrics: "derived-rebuildable-projection",
    operationalDomainTables: "derived-rebuildable-projection",
    migrations: "explicit-versioned-compatibility-policy-required",
    constraints: "database-constraints-and-reconciliation-required",
    historicalSourceSchemaRole: "isolated-read-only-study-adapter-evidence-only",
    physicalStorageAvailable: false,
  },
  evidenceGraphArchitecture: {
    implementationStage: "target-invariant-only-query-and-physical-storage-unavailable-until-s3.2-plus",
    authority: "storageArchitecture.sourceOfTruth",
    competingSourceOfTruthAllowed: false,
    observationCoverage: "everything-observed-persist-before-derived-use",
    eventEnvelope: {
      ordering: ["global-sequence", "utc-wall-clock", "monotonic-time", "duration-or-explicit-not-applicable"],
      tracing: ["trace", "span", "parent"],
      typedIdentities: [
        "run",
        "session",
        "turn",
        "feature",
        "task",
        "subtask",
        "attempt",
        "agent",
        "provider",
        "model",
        "request",
        "response",
        "tool",
        "context",
        "memory",
        "research",
        "repository",
        "edit",
        "test",
        "commit",
        "tag",
        "checkpoint",
        "rollback",
        "deployment",
      ],
    },
    edgeTypes: [
      "causal",
      "part-of",
      "performed-by",
      "used-context",
      "produced",
      "validated-by",
      "supersedes",
      "rolled-back-by",
    ],
    traversal: "bidirectional-from-every-recorded-endpoint",
    commitEvidence: [
      "immutable-git-commit-id",
      "git-parents",
      "git-tree",
      "content-addressed-diff-artifact",
      "initiating-task-features-agents",
      "exact-context-and-memory-revisions",
      "validation-evidence",
    ],
    projections: {
      timeline: "derived-rebuildable",
      search: "derived-rebuildable",
      edges: "derived-rebuildable",
      metrics: "derived-rebuildable",
      domain: "derived-rebuildable",
      rebuildValidation: "equivalent-query-results-required",
    },
    referentialPolicy: "validate-sequence-time-causality-cardinality-direction-and-orphans",
    unavailableLinkPolicy: "typed-reason-and-evidence-state-required-never-fabricate",
    externalChangePolicy: "record-as-unattributed-event-never-invent-actor-or-context",
    lifecycleLinkage: "append-only-tag-checkpoint-rollback-and-deployment-links",
    sharedMemory: {
      items: "versioned-with-evidence-confidence-status-supersedes-and-contradicts",
      reads: "bind-exact-snapshot-revision",
      writes: "compare-and-swap-or-equivalent-conflict-aware",
    },
    attempts: {
      record: "hypothesis-action-fingerprint-context-memory-actors-tools-inputs-results-errors-tests-state-outcome-rationale",
      beforeRetry: "lookup-and-block-materially-identical-repeat-unless-evidence-backed-rationale-changed",
      continuity: "preserve-learning-path-across-compaction-and-session-restart",
    },
    querySurface: {
      transport: "neutral-service-boundary",
      firstClient: "command-line",
      laterClient: "web-ready",
      filters: [
        "time",
        "commit",
        "file",
        "feature",
        "task",
        "agent",
        "turn",
        "tool",
        "provider",
        "model",
        "error",
        "trace",
      ],
      available: false,
    },
  },
  artifactGovernance: {
    implementationStage: "builder-admission-enforced-runtime-project-enforcement-unavailable",
    canonicalInventory: "traceability/artifacts/manifest.json",
    governedRoots: ["docs/", "traceability/", "verification/"],
    researchPlacement: {
      documentation: "docs/research/<topic>/{proposals,sources,qualification,reports}-only-when-needed",
      executableRunnersAndFixtures: "verification/benchmarks/<topic>",
      topLevelResearchDirectoryAllowed: false,
      duplicateShimOrFallbackAllowed: false,
    },
    importantTypes: [
      "requirement-source",
      "architecture-and-decision",
      "proposal-and-plan",
      "research-and-source-summary",
      "benchmark-design-and-script",
      "sanitized-benchmark-result",
      "finding-and-audit",
      "test-and-reproducibility-strategy",
    ],
    requiredMetadata: [
      "stable-id-and-path",
      "owner-and-artifact-type",
      "canonical-or-derived-status",
      "origin-time-tool-model-version-and-config",
      "license-and-provenance",
      "byte-length-and-sha256",
      "source-dependency-and-supersession-links",
      "data-and-secret-classification-plus-scan",
      "admission-review-and-candidate-inventory",
      "retention-and-rebuild-policy",
    ],
    scratchSpaceRole: "disposable-execution-only-never-authoritative-or-sole-important-copy",
    durableAbsoluteLocatorsAllowed: false,
    duplicateCanonicalAuthoritiesAllowed: false,
    orphanImportantArtifactsAllowed: false,
    binaryArchives: {
      validEvidenceAdmission: "suspended-until-shared-gzip-tar-validator-is-qualified",
      retainedContentFormat: "rejected-binary-fixture",
      retainedSuffix: ".tar.gz",
      requiredSidecarSuffix: ".archive.json",
      requiredMagicHex: "1f8b",
      requiredSidecarSchema: schemaId("rejected-binary-fixture", 1),
      validArchiveMayEstablishEvidence: false,
      retainedFixtures: [
        {
          path: "verification/benchmarks/storage/s3-sqlite-adapter-benchmark/superseded/v1-7ee3f532-7a58ace4/historical-evidence.tar.gz",
          byteLength: 74_046,
          sha256: "ccb12dd679f3be9a07f132fd34ad6e357e8df22428c87f09c1529ebf3fde0ea7",
          reasonCode: "normalization-bytewise-order-claim-failed",
        },
        {
          path: "verification/benchmarks/storage/s3-sqlite-adapter-benchmark/superseded/v1-7ee3f532-7a58ace4/runner-source-snapshot.tar.gz",
          byteLength: 21_079,
          sha256: "4bfab87b0ba4fa865d96791ec42159386cefce7810679116e7d34e79c287427f",
          reasonCode: "valid-archive-admission-suspended-unqualified-format",
        },
      ],
    },
    contentAddressedEvidence: {
      implementationStage: "protocol-and-synthetic-fixtures-only-production-activation-blocked",
      schemaVersion: schemaId("content-addressed-evidence", 1),
      hashAlgorithm: "sha256",
      pack: {
        magic: "CHCASP1\\0",
        version: 1,
        maximumBytes: 16_777_216,
        blobChunkingAllowed: false,
        ordering: "ascending-raw-sha256-bytes",
        publication: "immutable-digest-filename-multi-pack-append-only-no-rewrite",
      },
      tree: {
        pathEncoding: "base64url-posix-segment-bytes",
        symlinkTargetEncoding: "base64url-posix-bytes",
        maximumDepth: 32,
        maximumEntries: 100_000,
        maximumBlobBytes: 16_777_124,
        maximumLogicalBytes: 1_099_511_627_776,
        metadataIncluded: ["kind", "mode", "size", "sha256"],
        metadataExcluded: [
          "acl",
          "atime",
          "birthtime",
          "ctime",
          "gid",
          "hardlink-topology",
          "mtime",
          "ownership",
          "sparse-layout",
          "uid",
          "xattrs",
        ],
        hardlinkDisposition: "reject-before-pack",
        specialEntryDisposition: "reject-before-pack",
        symlinkDisposition: "relative-confined-existing-nonsymlink-target-only",
      },
      admission: {
        classificationAuthority: "src/classification-catalog.ts#DATA_CLASSIFICATION",
        artifactExclusionAuthority: "ROOT_POLICY.artifactGovernance.exclude",
        permittedClassifications: [DATA_CLASSIFICATION.public, DATA_CLASSIFICATION.projectPrivate],
        exactBlobReceiptCoverageRequired: true,
        exactLicenseTextNoticeAndExternalLeaseClosureRequired: true,
        scannerExceptionOrAdHocAllowlistAllowed: false,
      },
      privateState: {
        relativeRoot: statePath("state", "artifact-admission", "content-addressed-evidence-v1"),
        journalPath: "journal-<transaction-id>-<ordinal>-<phase>.json",
        objectPath: "<kind>-<sha256>.<extension>",
        stagingPattern: "none-flat-append-only-v1",
        activeRegistryPath: "active.json",
        activeRegistryPresent: false,
        durableAbsoluteLocatorAllowed: false,
      },
      syntheticQualification: {
        rootOwnership: "caller-owned-transient-outside-publication-state",
        writeAuthority: "separate-exact-create-directory-lease",
        residueDisposition: "caller-owned-no-delete-cleanup-authority",
        reconstructAndRescanRequiredBeforePrepared: true,
      },
      transactionIdentity: {
        contentPlanIdentity: "deterministic-registry-layout-and-publication-order",
        attemptIdentity: "caller-supplied-canonical-lowercase-uuidv4-synthetic-unadmitted",
        transactionIdentity: "domain-hash-of-plan-and-attempt",
        uniquenessRandomnessOrChronologyClaim: false,
        futureTimelineEvidenceAllowed: false,
      },
      modularStructure: {
        lineCountDisposition: "diagnostic-only-no-pass-fail-threshold",
        admissionOracle: "responsibility-import-export-cycle-and-duplicate-authority-contracts",
        responsibilityAndImportBoundaryChecksRequired: true,
        orchestrationFacadeFiles: [
          "verification/core/artifact-governance/content-store/application.ts",
          "verification/core/artifact-governance/content-store/node-adapter/transaction.ts",
        ],
      },
      activation: {
        productionAllowed: false,
        preconditions: "stage-scan-reconstruct-rescan-exact-license-leases-and-fresh-independent-admission",
        registryBinding: "schema-algorithm-registry-digest-size-and-prior-active-identity",
        mutableFileSet: ["active.json"],
        sensitiveOriginalDisposition: "separately-qualified-encrypted-private-vault-and-key-boundary-only",
        improvisedEncryptionOrPublicSanitizationAllowed: false,
      },
      writeBoundary: {
        authorityStage: "pre-effect-plan-validation-only",
        pathEncoding: "nfc-repository-relative-forward-slash-closed-logical-subset",
        rootAuthority: "nonserializable-module-private-observation-capability",
        rawRootPathFileUrlBasenameHomeFragmentOrUnkeyedPathCommitmentAllowed: false,
        durableRootReferenceAuthority: "required-absent-protected-path-keyed-blind-index",
        descriptorAndRootObservationRequiredSeparately: true,
        mechanismLimits: "ancestor-and-same-uid-transient-races-remain-unexcluded",
        brokerLeaseFencingOrUniversalEnforcementClaim: false,
        publicErrorProjection: ["name", "message", "code", "retryable", "safeDetails"],
        rawStackOrCauseInPublicErrorProjectionAllowed: false,
        fullPiiLogSanitizationAvailable: false,
      },
      independentOracle: {
        productionOrCoreImportsAllowed: false,
        packAndTreeParsingImplementationSharedWithCore: false,
      },
      deterministicSyntheticProfiles: ["duplicate-heavy", "binary-path-boundary", "confined-symlink"],
      authorityClaims: {
        providerWinner: false,
        knipClean: false,
        runtimeQualification: false,
        securityQualification: false,
        crossPlatformReadiness: false,
        productReadiness: false,
      },
    },
    independentReview: {
      governedPrefix: "docs/research/extensions/",
      reviewedArtifact: "docs/research/extensions/qualification/extension-lifecycle.md",
      reviewedInputs: [
        "docs/architecture/architecture-v1.md",
        "docs/research/extensions/qualification/extension-lifecycle.md",
      ],
      requiredReports: [
        "docs/research/extensions/reports/independent-review.md",
        "docs/research/extensions/reports/independent-review-remediation-addendum.md",
        "docs/research/extensions/reports/independent-review-remediation-addendum-2.md",
        "docs/research/extensions/reports/independent-review-remediation-addendum-3.md",
        "docs/research/extensions/reports/independent-review-remediation-addendum-4.md",
      ],
    },
    admission: "classify-deduplicate-scan-review-hash-import-or-record-explicit-rejection",
    preserve: "designs-scripts-manifests-sanitized-results-reports-findings-rationale-and-reproducibility",
    exclude: [
      "credentials",
      "raw-personal-conversation-data",
      "caches",
      "dependency-directories",
      "rebuildable-binaries",
      "transient-databases",
    ],
    runtimeProjectPolicy: "same-important-artifact-admission-and-release-blocking-semantics",
    builderEnforcementAvailable: true,
    runtimeEnforcementAvailable: false,
  },
  projectLayoutArchitecture: {
    implementationStage: "target-invariant-only-config-compiled-layout-admission-unavailable",
    authority: "central-config-root-role-contract-over-architecture-and-artifact-registries",
    architectureAuthority: "src/architecture-manifest.ts",
    artifactAuthority: "traceability/artifacts/manifest.json",
    competingRootRoleOwnerOrLayoutAuthorityAllowed: false,
    documentation: {
      canonicalRoot: "docs/",
      configurableRootAllowed: false,
      allowedRoles: [
        "human-facing-architecture-and-decisions",
        "plans-and-proposals",
        "research-source-summaries-and-reports",
        "operator-and-contributor-documentation",
      ],
      executableOrOperationalSourceAllowed: false,
      forbiddenSourceRoles: [
        "product",
        "test-or-fixture-runner",
        "validator",
        "benchmark",
        "migration",
        "generated-runtime",
        "operational-script",
      ],
    },
    centrallyConfiguredRootRoles: [
      "product-source",
      "verification-source",
      "tests-and-fixtures",
      "schemas",
      "research-documentation",
      "evidence-and-receipts",
      "generated-projections",
      "protected-runtime-state",
    ],
    configurableFields: [
      "logical-role-to-root-mapping",
      "allowed-artifact-classes-and-entrypoints",
      "generated-output-and-exclusion-rules",
      "language-and-project-specific-detection",
      "review-signal-thresholds",
      "explicit-scoped-exceptions",
    ],
    admissionDenials: [
      "unknown-unregistered-or-conflicting-root-role",
      "duplicate-semantic-structure-or-owner",
      "executable-or-operational-source-under-docs",
      "architecture-import-effect-or-public-api-escape",
      "generated-evidence-state-or-source-role-confusion",
    ],
    moduleDecisionEvidence: [
      "single-responsibility-and-owner",
      "cohesion-coupling-and-dependency-direction",
      "public-api-and-effect-boundary",
      "change-locality-and-test-ownership",
      "duplication-and-discoverability",
      "measured-maintainability-and-complexity-signals",
    ],
    multiLevelFoldersAllowedWhenEvidenceBacked: true,
    arbitraryLineFileCountOrDepthThresholdAsDesignOracleAllowed: false,
    migration: "fenced-lease-candidate-bound-plan-transactional-move-validation-and-rollback",
    builderEnforcementAvailable: false,
    runtimeEnforcementAvailable: false,
  },
  workspaceGitArchitecture: {
    implementationStage: "target-invariant-only-workspace-and-git-effects-unavailable",
    configurationNamespace: "workspaceGit",
    configurationRule: "user-options-and-project-additions-exposed-root-denials-immutable",
    ports: [
      "workspace-onboarding",
      "git-repository-inspection",
      "git-transport",
      "git-authentication",
      "git-never-push-policy",
    ],
    workspaceStates: [
      "empty",
      "nonempty-unversioned",
      "repository",
      "linked-worktree",
      "bare",
      "nested",
      "corrupt-or-ambiguous",
    ],
    plans: ["init-empty", "clone", "import-and-init", "attach", "reconcile", "fork"],
    remoteModel: "fetch-upstream-and-push-origin-fork-urls-branches-refspecs-are-independent",
    integration: "fetch-and-graph-analysis-then-explicit-fast-forward-only-rebase-or-merge-never-opaque-pull",
    destructiveDefaultsAllowed: false,
    forcePushDefaultAllowed: false,
    transaction: [
      "inspect-and-freeze-identities",
      "compile-policy-exclusions-and-plan",
      "durable-intent-and-checkpoint",
      "minimum-effects",
      "verify-graph-remotes-refs-index-tree-worktree-and-pushed-objects",
      "commit-or-compensate",
    ],
    authentication: {
      methods: ["credential-helper", "ssh-agent", "oauth-device-flow", "opaque-fd-secret-handle"],
      persistedCredentialAllowed: false,
      credentialInRemoteUrlAllowed: false,
      secretRedactionRequired: true,
    },
    neverPush: {
      composition: "immutable-root-minimum-plus-additive-project-configuration",
      enforcement: ["managed-gitignore-section", "index-and-tree-scan", "pre-push-object-and-diff-policy"],
      exactRootPaths: [statePathPrefix()],
      rootMinimum: [
        "credentials-and-secret-like-content",
        "raw-personal-conversations",
        "harness-private-state",
        "caches-and-dependency-trees",
        "generated-or-transient-databases",
        "disallowed-large-files",
        "unsafe-symlinks-and-case-or-rename-aliases",
      ],
      requiredPreservation: ["lockfiles", "artifact-manifests", "reproducibility-evidence"],
      configurableNegationOfRootMinimumAllowed: false,
      overwriteUserIgnoreRulesAllowed: false,
    },
    hostileStates: [
      "dirty-unborn-detached-diverged-unrelated",
      "shallow-partial-submodule-lfs",
      "locks-conflicts-protected-branch",
      "auth-network-and-interruption",
      "concurrent-agent-mutation",
      "already-tracked-negative-pattern-history-reachability",
    ],
    logging: "all-redacted-plans-decisions-snapshots-operations-transitions-errors-compensation-verification",
    runtimeEnforcementAvailable: false,
  },
  incidentLearningArchitecture: {
    implementationStage: "target-invariant-only-automatic-finding-and-regression-loop-unavailable",
    trigger: "every-material-incident-near-miss-conflict-bypass-false-green-or-unexpected-interaction",
    deduplication: "causal-fingerprint-plus-related-attempt-and-finding-links",
    requiredCapture: [
      "source-and-timeline",
      "actors-agents-tools-inputs-outputs",
      "resources-leases-config-and-base-revisions",
      "expected-observed-impact-and-classification",
    ],
    lifecycle: [
      "finding",
      "owned-root-cause",
      "permanent-design-or-control-correction",
      "deterministic-fixture-mutant-regression-or-explicit-non-reproduction-evidence",
      "repair",
      "independent-recheck",
      "supersession-or-closure-with-recurrence-monitoring",
    ],
    userSuggestedFixRole: "hypothesis-to-analyze-iterate-and-qualify-never-unexamined-command",
    reusableModulePromotion: "cross-project-evidence-required-retain-project-context-and-rejected-hypotheses",
    authorOnlyClosureAllowed: false,
    workaroundClosureAllowed: false,
    recurrenceAfterClosureAllowed: false,
    currentFinding: "COORD-001-concurrent-research-layout-move",
    runtimeEnforcementAvailable: false,
  },
  workspaceConcurrencyArchitecture: {
    implementationStage: "target-invariant-only-resource-broker-and-effect-fencing-unavailable",
    authority: "single-policy-controlled-hierarchical-lexical-and-semantic-resource-broker",
    declaration: "conservative-read-write-sets-required-before-effects-undeclared-discovery-forces-replan",
    physicalResources: [
      "repository-and-worktree-roots-descendants",
      "files-directories-renames-case-aliases-symlinks-hardlinks-canonical-identities",
      "git-refs-index-tree-and-object-graph",
      "generated-artifacts-config-and-deployment-paths",
    ],
    semanticResources: [
      "module-and-capability-contracts",
      "configuration-authorities",
      "database-schema-and-migration-identities",
      "tools-services-deployments-and-shared-lifecycle-state",
    ],
    conflictPolicy: "deny-or-serialize-overlapping-write-and-write-read-hazards-permit-only-proven-disjoint-parallelism",
    leaseBinding: [
      "task-agent-attempt-and-operation",
      "plan-hash-and-config-revision",
      "base-content-tree-index-ref-schema-or-semantic-revision",
      "bounded-ttl-heartbeat-and-monotonic-fencing-token",
    ],
    liveness: "deterministic-acquisition-order-deadlock-detection-cancellation-crash-and-orphan-recovery",
    effectBoundary: "live-fenced-lease-plus-compare-and-swap-required-for-every-effect",
    drift: "out-of-band-or-capability-lifecycle-change-invalidates-plan-and-requires-reinspection",
    worktrees: "isolated-worktrees-and-staging-narrow-scope-but-never-bypass-shared-resource-conflicts",
    builderProvingGround: "migration-write-authority/v1",
    toolBypassAllowed: false,
    transitionLogging: "request-grant-renew-deny-release-expiry-fence-deadlock-cancel-recovery-and-cas-result",
    runtimeEnforcementAvailable: false,
  },
  automaticMemoryArchitecture: {
    implementationStage: "target-invariant-only-deterministic-capture-injection-and-query-unavailable",
    canonicalHistory: "one-immutable-complete-source-linked-event-and-memory-history",
    projections: {
      present: "rebuildable-current-working-state-view",
      shortHorizon: "rebuildable-task-and-session-horizon-view",
      longTerm: "rebuildable-durable-decision-fact-attempt-finding-and-evidence-view",
      separateLossyHistoriesAllowed: false,
      requiredMetadata: "derivation-validity-confidence-contradiction-supersession-retention-sensitivity-access-and-snapshot-revision",
    },
    decisionCompilerInputs: [
      "typed-task-agent-tool-and-ledger-events",
      "dependency-and-active-work-state",
      "central-policy-and-config",
      "context-budget-relevance-recency-confidence-and-sensitivity",
      "prior-injection-and-measured-utility",
      "mandatory-context-constraints",
    ],
    actions: ["capture", "retrieve", "summarize", "inject", "refresh", "omit"],
    injection: "source-linked-deduplicated-bounded-least-privilege-task-scoped-order-stable-redacted-logged-and-replayable",
    mandatoryContextUnavailable: "fail-closed-with-explicit-reason",
    retrievalScoreAsTruthAllowed: false,
    queryPort: "read-only-scoped-memory-and-evidence-query-capability",
    optionalMemoryAgent: {
      profile: "declarative-replaceable-and-task-scoped",
      questionDomains: ["conversations", "requirements", "git", "files", "agents", "actions", "attempts", "tools", "findings", "evidence"],
      directEquivalentQueryAllowed: true,
      separateHistoryAllowed: false,
      mutationAuthorityAllowed: false,
      ambientAccessAllowed: false,
      hiddenChannelAllowed: false,
      privilegedInferenceAllowed: false,
    },
    qualification: "compare-direct-agent-hybrid-routing-with-x3-hostile-correctness-privacy-cost-provenance-conflict-and-recovery-cases",
    runtimeEnforcementAvailable: false,
  },
  conversationBootstrapArchitecture: {
    implementationStage: "target-invariant-only-candidate-bound-conversation-bootstrap-unavailable",
    authority: "derived-projection-over-existing-canonical-authorities-not-a-fact-store",
    schemaVersion: schemaId("conversation-bootstrap", 1),
    competingProjectTaskAgentToolMemoryConfigArchitectureCodeMapOrAuditAuthorityAllowed: false,
    sourceAuthorities: [
      "repository-worktree-base-and-candidate-snapshot",
      "central-config-and-config-contract",
      "architecture-manifest-and-authority-graph",
      "requirements-directives-and-universal-policy",
      "repository-inventory-code-map-index-and-qualified-code-intelligence",
      "tool-mcp-capability-and-health-registry",
      "agent-profile-live-task-lease-and-write-set-registry",
      "focus-alignment-memory-context-and-evidence-ledger-cursors",
    ],
    mandatorySections: [
      "bootstrap-identity-and-provenance",
      "repository-base-candidate-and-config",
      "active-objective-task-focus-and-alignment",
      "effective-policy-tools-capabilities-agents-and-ownership",
      "project-structure-code-map-coverage-omissions-and-query-handles",
    ],
    authoredBasicIntentOverlay: {
      allowedContent: "bounded-source-linked-stable-purpose-terminology-and-onboarding-intent-only",
      generatedOperationalFactAuthorityAllowed: false,
      generatedFactOverrideAllowed: false,
      agentsReadmeModelOrSummaryFactTrustAllowed: false,
      conflictResolution: "generated-canonical-facts-remain-authoritative-and-publication-blocks-until-overlay-correction",
      conflictStaleLocatorOrOverrideAttempt: "fail-closed-with-typed-reason",
    },
    centralConfigControls: [
      "enabled-optional-sections",
      "deterministic-section-order",
      "per-section-and-total-token-and-byte-budgets",
      "retrieval-budgets",
      "refresh-cadence-and-additional-refresh-triggers",
    ],
    configurableMandatoryIdentityProvenanceSanitationOrInvalidationFloor: false,
    receiptInputs: [
      "exact-source-authority-identities-and-freshness",
      "compiler-revision-generated-at-event-and-projection-hash",
      "section-coverage-inclusions-omissions-redactions-and-query-handles",
      "base-snapshot-and-gap-free-ordered-delta-range",
    ],
    publication: "quiesced-fenced-snapshot-compare-and-swap-persist-before-forward-transaction-after-accepted-change",
    delivery: "same-authorized-base-snapshot-identity-plus-gap-free-ordered-deltas-for-every-agent-and-prompt",
    invalidation: "any-bound-authority-identity-change-before-next-prompt-or-effect",
    invalidState: "stale-missing-wrong-repository-partial-concurrent-contradictory-delta-gap-or-recovery-uncertain-fails-closed",
    omissions: "stable-least-privilege-query-handle-authority-identity-classification-reason-and-retrieval-precondition-never-fabricate",
    exposure: "sanitized-classified-authorized-minimized-no-credentials-hidden-reasoning-unauthorized-paths-or-capabilities",
    progressiveContextAndCompaction: "mandatory-facts-and-authored-intent-preserved-optional-material-retrievable-no-forked-agent-views",
    acknowledgement: "exact-current-snapshot-and-delta-identities-required-before-agent-effect",
    logging: "canonical-timeline-only-input-decision-redaction-delivery-acknowledgement-invalidation-regeneration-recovery-latency-token-and-byte-events",
    qualification: "independent-x3-repeated-by-x3-materially-distinct-normal-hostile-and-recovery-across-builder-and-runtime",
    runtimeEnforcementAvailable: false,
  },
  steeringContinuityArchitecture: {
    implementationStage: "target-invariant-only-focus-stack-and-continuity-supervisor-unavailable",
    authority: "canonical-event-ledger-plus-shared-task-memory-and-capability-projections",
    competingMonitorStateAuthorityAllowed: false,
    steeringClassifications: [
      "replace",
      "augment",
      "reprioritize",
      "correct",
      "question",
      "pause",
      "cancel",
      "resume",
    ],
    focusRecord: [
      "stable-task-subtask-attempt-identities",
      "priority-plan-config-base-and-resource-identities",
      "progress-next-action-blockers-and-suspension-cause",
      "validity-and-explicit-complete-superseded-cancelled-or-abandoned-disposition",
    ],
    transitionPath: "durable-classify-suspend-handle-complete-revalidate-resume-supersede-cancel-or-alert",
    newestMessageReplacesUnfinishedWorkByDefault: false,
    handoffResultBinding:
      "bind-assigned-task-subtask-attempt-and-explicit-disposition-intervening-prompts-may-augment-suspend-or-reprioritize-but-never-substitute-the-handoff",
    automaticResume: "highest-priority-valid-suspended-focus-after-policy-capability-lease-base-dependency-and-intent-revalidation",
    invalidOrAmbiguousWork: "remain-visible-and-blocked-with-user-question-or-abandonment-staleness-alert",
    continuity: "preserve-order-and-disposition-across-compaction-restart-handoff-provider-model-and-observer-failure",
    observers: {
      profiles: "zero-or-more-declarative-replaceable-smaller-model-or-deterministic-observers",
      inputs: "sanitized-typed-user-agent-task-subtask-and-bounded-tool-summary-events",
      proposals: ["steering-classification", "continuation", "abandonment-or-staleness-alert"],
      chainOfThoughtAccessAllowed: false,
      rawCredentialOrUnrestrictedTranscriptAccessAllowed: false,
      effectOrMutationAuthorityAllowed: false,
      privateMemoryOrDirectPeerChannelAllowed: false,
      deterministicPolicyValidationRequired: true,
    },
    qualification: "compare-deterministic-smaller-model-and-hybrid-x3-hostile-continuity-privacy-correctness-cost-and-recovery",
    runtimeEnforcementAvailable: false,
  },
  runtimeLanguageArchitecture: {
    implementationStage: "target-invariant-only-language-boundary-enforcement-unavailable",
    productCoreLanguage: "typescript",
    productCoreRuntime: "node",
    productionAndCanonicalRunner: "node-only",
    nodeLtsMajor: 24,
    nodePatchPolicy: "latest-stable-patch-within-node-24-lts-no-unnecessary-patch-pin",
    pinnedProcessExecution: {
      timeoutKillSignal: "SIGKILL",
      timeoutScope: "direct-child-only-no-descendant-supervision-claim",
    },
    pinnedNodeExecution: {
      implementation: "linux-proc-fd-component-pinned-executable-callback",
      procFileDescriptorRoot: "/proc/self/fd",
      fixedChildExecutableDescriptor: 4,
      maximumExecutableBytes: 268_435_456,
      maximumPathBytes: 4_096,
      maximumPathComponents: 64,
      hashReadChunkBytes: 65_536,
      requireRegularExecutableFile: true,
      callbackLifetime: "held-through-synchronous-return-or-asynchronous-settlement",
      postCallbackRevalidation:
        "descriptor-restat-rehash-proc-identity-and-complete-component-chain-lexical-recheck-before-close",
      lexicalMismatchDisposition: "reject-never-switch-execution-to-replacement",
      unsupportedPlatformDisposition: "unavailable-no-fallback",
    },
    capabilityDetection: {
      states: ["absent", "incompatible", "installed-not-activated", "qualified"],
      ambientPathOnlyAbsenceAllowed: false,
      discovery: "bounded-exact-central-configured-runtime-manager-and-path-candidates-only",
      activation: "verified-explicit-child-process-scoped-executable-identity-and-effective-path",
      engineComparison: "observed-version-must-satisfy-root-node-major-and-package-engine-range",
      arbitraryMachineCrawlOrShellStartupEvaluationAllowed: false,
      unqualifiedFallbackAllowed: false,
      currentFinding: "CAP-001-runtime-capability-false-absence",
      runtimeEnforcementAvailable: false,
    },
    pythonProductCoreDependencyAllowed: false,
    undeclaredSecondaryRuntimeAllowed: false,
    coreMayImportSpawnOrSilentlyRequirePython: false,
    externalLanguageBoundary: {
      allowedRoles: ["qualified-external-mcp", "independent-benchmark-or-oracle"],
      transport: "typed-provider-neutral-process-mcp-or-oracle-port",
      requiredDeclaration: "manifest-central-config-rationale-interpreter-range-dependencies-permissions-provenance-license-secrets-resources-io-errors-logging-cancellation-fixtures-install-checks-and-rollback",
      duplicatePolicyLoggingMemoryTaskOrCapabilityLogicAllowed: false,
      missingCapability: "block-only-applicable-optional-capability-with-truthful-instructions",
    },
    pythonIndependentOracle: {
      role: "explicit-exception-not-production-or-duplicate-authority",
      executionBoundary: "read-only-test-only",
      implementation: "independent-of-production-predicate",
      mayImportCallOrShareProductionPredicate: false,
      disagreement: "fail-closed",
    },
    qualification: "x3-clean-machine-static-package-process-path-environment-deployment-sbom-license-redaction-replay-and-removal",
    runtimeEnforcementAvailable: false,
  },
  selfEvolutionArchitecture: {
    implementationStage: "target-invariant-only-extension-tools-and-update-broker-unavailable",
    authority: "single-versioned-extension-manifest-family-and-registry",
    extensionTypes: [
      "provider-adapter",
      "model-profile",
      "mcp-tool-or-adapter",
      "agent-profile",
      "quality-pack",
      "editor-repository-or-search-capability",
      "cohesive-product-module",
    ],
    manifestBaseFields: [
      "stable-identity-version-and-extension-type",
      "harness-api-and-compatibility-range",
      "capabilities-operations-and-required-provided-ports",
      "config-schema-fragment-and-scoped-view",
      "allowed-tools-data-classifications-and-effects",
      "dependencies-licenses-provenance-digests-and-signatures",
      "migrations-lifecycle-hooks-and-tests",
      "rollback-deprecation-removal-and-tombstone-policy",
    ],
    llmFacingTools: ["inspect", "list", "validate", "plan", "add", "edit", "deprecate", "delete", "rollback"],
    generalInstalledFileWriteToolAllowed: false,
    generalProcessToolForMutationAllowed: false,
    proposalFlow: [
      "whole-codebase-and-existing-extension-reuse-search",
      "dependency-conflict-compatibility-public-api-and-policy-validation",
      "content-addressed-plan-and-isolated-staging",
      "static-contract-integration-recovery-migration-hostile-tests",
      "independent-review-and-exact-authenticated-user-approval",
      "privileged-broker-atomic-activation-post-check-or-compensation",
    ],
    installedRuntime: {
      agentAndRuntimeAccess: "read-execute-only",
      mutationPrincipal: "separately-authenticated-privileged-installer-update-broker",
      osEnforcement: "ownership-acl-and-read-only-mount-or-equivalent-required",
      rootOrOsOwnerControlClaimed: false,
      applicationSelfCheckSufficient: false,
    },
    lifecycle: ["add", "edit", "deprecate", "delete", "upgrade", "downgrade", "enable", "disable", "rollback"],
    deletion: "reverse-dependency-and-active-state-analysis-migrate-or-block-retain-tombstone-and-replay",
    atomicActivation: "immutable-versioned-staging-verified-activation-and-prior-version-compensation",
    instructions: "versioned-manifest-bound-artifacts-no-ambient-prompts-or-hidden-side-channels",
    moduleCapabilities: {
      contractOwnership: "consumer-owned-versioned-typed-port-schema-invariants-and-contract-tests",
      providerRole: "advertise-compatible-implementation-operations-effects-health-and-evidence",
      registry: "single-policy-controlled-versioned-capability-publication-and-resolution-registry",
      resolution: "deterministic-task-scoped-config-bound-logged-and-fail-closed",
      invocation: "typed-port-through-canonical-operation-envelope-only",
      exposure: "many-narrow-discoverable-least-privilege-capabilities",
      ambientAuthorityAllowed: false,
      deepImportsSharedMutableStatePrivateConfigOrDatabaseAllowed: false,
      lifecycle: "lease-drain-cancel-block-new-bindings-impact-test-atomic-rebind-or-rollback",
    },
    runtimeEnforcementAvailable: false,
  },
  /**
   * Non-configurable self-protection (Landlock guardian) safety floor. The
   * guardian binary restricts itself and execs the payload (Pattern A); the
   * restriction is irrevocable and inherited across fork/exec/clone. The
   * operator can only ADD to this floor (additional allow-rules, additional
   * protected subtrees, additional handled flags) via the `selfProtection`
   * config section, never remove floor entries. `enabled: true` here means
   * the binary MUST be applied when available; the operator config's
   * `selfProtection` section is confined when ABSENT (one owner,
   * `resolveSelfProtectionConfig`), and only a written `enabled: false` is dev
   * mode. When the binary is unavailable, every confined spawn is REFUSED —
   * the runtime never silently runs unprotected.
   */
  selfProtection: {
    enforcementKind: "landlock-or-equivalent",
    enabled: true,
    mayNotBeDisabled: true,
    blockRead: true,
    blockWrite: true,
    specSchemaVersion: schemaId("self-protection-spec", 1),
    binaryRelativePath: "guardian/build/harness-landlock-guardian",
    binarySha256: "28ee831d1359c87d339f36899de33d5de9c246d1294f556430c3b6d1a30fb9c1",
    bundleRelativePath: "dist/bundle.js",
    bundleSha256: "78383d93afb98d76d86f1ac81b3269cbe3c4913009c26b6d71c46bfb67634b50",
    specSchemaArtifactPath: "traceability/self-protection/guardian-spec-schema.json",
    specSchemaArtifactSha256: "689cf67a9a516786b6fedae6716c94c07c818d97b144393e1eb8d26b89668d70",
    /**
     * RELATIVE TO THE HARNESS ROOT — the tree that holds `dist/bundle.js` and
     * `guardian/build/…` above, never the repository root.
     * `buildProtectedSubtrees` joins each name onto the `harnessRoot`
     * argument, so `"src"` here is `<harnessRoot>/src`, which in this
     * repository is `engine/src`.
     *
     * WHY THAT SENTENCE IS WORTH WRITING NOW. Before the monorepo assembly
     * (2026-07-30) the harness root was its own checkout and the bare name
     * `src` could only mean one directory. It is now `engine/` INSIDE a tree
     * that has a `src/` of its own — the web UI's — and the web side declares
     * a protected subtree called `src` too (`WEB_HARNESS_PROTECTED_SUBTREE_
     * NAMES` in `server/landlock-runner.ts`, resolved against the REPOSITORY
     * root). Two declarations, one word, two real directories a level apart.
     * Both are correct; nothing said which was which.
     *
     * THE COLLISION IS NOT MERELY DOCUMENTED, IT FAILS CLOSED. If a wrong
     * `harnessRoot` were ever handed in — a `HARNESS_CONFIG_PATH` pointed at
     * the repository root, say — this name would silently land on the web's
     * `src/` and stop protecting the harness's, because both exist and the
     * subtree set is a `Set` that would simply de-duplicate. It cannot ship
     * that way: `binaryRelativePath` and `bundleRelativePath` are resolved
     * against the SAME root and pinned by sha256 here, so a root that is not
     * the harness produces `binary_missing` and self-protection refuses to
     * run rather than running over the wrong tree. The pins are what make the
     * root unambiguous; this comment says so, and
     * `tests/prevention/subprocess-confinement-owner.test.ts` drives it.
     */
    minimumProtectedSubtrees: ["src"],
    // How many times the guardian re-locates a keep-out entry that changed
    // while it was located (ESTALE) before it keeps it by its folder and its
    // name (the guardian spec's `keep_out_retries`; GUARD-F5).
    keepOutRetries: 3,
    minimumAllowSet: [
      { path: "/usr", access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
      { path: "/lib", access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
      { path: "/etc", access: ["READ_FILE", "READ_DIR"] },
      { path: "/dev", access: ["READ_FILE", "WRITE_FILE", "READ_DIR"] },
      { path: "/proc", access: ["READ_FILE", "READ_DIR"] },
    ],
    /**
     * FILES THE FLOOR ALREADY MEANS TO GRANT, WHICH A HOST MAY KEEP BEHIND A
     * LINK THAT LEAVES THE FLOOR'S DIRECTORIES. Landlock authorises at
     * `open()` on the RESOLVED path, so `/etc` read access does not reach
     * `/etc/resolv.conf` when it is a link to `/mnt/wsl/resolv.conf` (WSL) or
     * `/run/systemd/resolve/stub-resolv.conf` (systemd-resolved) — and a
     * confined child then has no DNS at all (measured on WSL: EAI_AGAIN for
     * `execute_command` and for a confined MCP server alike). The compiler
     * grants READ_FILE on each file's RESOLVED target, when the file exists;
     * the target is derived by resolution on the running host, never listed.
     */
    minimumLinkedReadFiles: ["/etc/resolv.conf"],
    /**
     * THE HOME-RELATIVE HALF OF THE ONE KEEP-OUT LIST (the harness-relative
     * half is `minimumProtectedSubtrees`; the host's facts — its databases and
     * their copies, the key home and every harness store registered there, the
     * config document — and the operator's `selfProtection.additionalProtectedSubtrees`
     * complete it; `self-protection/keep-out.ts` assembles them). No allow-rule
     * may equal, contain or sit inside one of these, for EVERY confined consumer
     * (the model's commands and stdio MCP servers), and no project folder or
     * file the server opens for a user may either — compared by identity
     * (device + inode of the location and every ancestor), so a bind-mount
     * alias such as WSL's `/mnt/wslg/distro` names the same place. Every path
     * that exists is also emitted into the guardian spec as a protected
     * subtree, so the C guardian refuses it physically.
     *
     * `~/` is EVERY home the host has: the harness user's, and on WSL each
     * Windows profile (`windowsProfiles` below), whose names compare
     * case-insensitively. A final segment ending in `*` names every entry of
     * that folder with that prefix (the harness's own installation excepted:
     * `~/.local/state/<product>-*` holds other checkouts, candidates and
     * backups of the harness). The credential, key, browser-profile and
     * shell-history stores of the host and of the AI tools that run beside
     * the harness. NOT removable: the operator only ADDS.
     */
    minimumRefusedPaths: [
      "~/.ssh", "~/.gnupg", "~/.pki", "~/.aws", "~/.azure", "~/.config/gcloud", "~/.kube", "~/.docker",
      "~/.config/containers/auth.json", "~/.config/gh", "~/.config/github-copilot", "~/.git-credentials",
      "~/.gitconfig", "~/.netrc", "~/.npmrc", "~/.pypirc", "~/.cargo/credentials", "~/.cargo/credentials.toml",
      "~/.m2/settings.xml", "~/.terraform.d", "~/.vault-token", "~/.pgpass", "~/.my.cnf", "~/.s3cfg",
      "~/.config/rclone", "~/.password-store", "~/.local/share/keyrings",
      "~/.claude", "~/.claude.json", "~/.codex", "~/.cursor", "~/.gemini", "~/.config/code-harness",
      "~/.mozilla", "~/.config/chromium", "~/.config/google-chrome", "~/.config/BraveSoftware",
      "~/.config/microsoft-edge",
      "~/.bash_history", "~/.zsh_history", "~/.node_repl_history", "~/.python_history", "~/.psql_history",
      "~/.mysql_history", "~/.sqlite_history", "~/.local/share/fish",
      `~/.local/state/${PRODUCT_NAME}-*`,
      "~/AppData/Local/Google/Chrome/User Data", "~/AppData/Local/Microsoft/Edge/User Data",
      "~/AppData/Local/BraveSoftware", "~/AppData/Roaming/Mozilla", "~/AppData/Local/Microsoft/Credentials",
      "~/AppData/Roaming/Microsoft/Credentials", "~/AppData/Roaming/Microsoft/Protect",
    ],
    /**
     * SYSTEM FOLDERS THAT ARE NEVER A PROJECT (the project door and the folder
     * picker, by identity: a link to `/etc` is `/etc`). The confinement floor
     * still grants what it grants inside them (`minimumAllowSet`); this is
     * only "a person may not pick one as their project".
     */
    systemFolders: ["/etc", "/proc", "/sys", "/dev", "/boot", "/run", "/var/run", "/var/log", "/root"],
    /**
     * WHERE THE STORE NAMES ABOVE ARE A HOME'S, FOUND BY NAME: another
     * account's home, a copied or mounted one (`/srv/backup/home/u/.ssh`) —
     * a folder whose parent is named one of `homeParents`, or one of
     * `homeFolders` — where no home of this host could be measured. A store
     * name counts only as the first names below such a folder: the same name
     * INSIDE a project (`.claude/`, `.npmrc`, `.docker/`, `.kube/` committed
     * with the code) is project content, served with its secret values
     * redacted (`privacy/secret-files.ts`), never refused.
     */
    homeParents: ["home", "Users"],
    homeFolders: ["/root"],
    /**
     * AN INSTALL STILL KEEPING ITS KEY BESIDE ITS DATABASE (the layout before
     * the key home), refused WITHOUT any registration (`database-files.ts`
     * `legacyInstallIn`): a key-sized `db-key` beside a SQLite database. Every
     * place inside such a folder is kept out at any depth; a folder a grant or
     * a project would CONTAIN is looked for below it down to
     * `containedSearchDepth` folders (at most `containedSearchFolders` of
     * them, `skippedFolders` never entered) — deeper installs are kept out by
     * registration (`npm run db-key -- scan`, which registers and never moves;
     * one scan walks at most `scanFolderBudget` folders, off the server's
     * event loop, and says when it stopped there).
     */
    legacyInstalls: {
      maximumSiblingsRead: 64,
      containedSearchDepth: 3,
      containedSearchFolders: 4096,
      scanFolderBudget: 200_000,
      skippedFolders: ["node_modules", ".git"],
    },
    /**
     * THE WINDOWS PROFILES OF A WSL HOST: every `<drive>/<usersDirectory>/<name>`
     * folder on a mounted Windows drive (DrvFs) is a home the home-relative
     * list above applies to — the same stores (`.ssh`, `.aws`, `.codex`,
     * browser profiles) live there — except the shared profiles that are no
     * user's.
     */
    windowsProfiles: {
      usersDirectory: "Users",
      sharedProfiles: ["Public", "Default", "Default User", "All Users"],
      /**
       * Machine-wide Windows credential stores, per mounted Windows drive
       * (not in any profile): the OpenSSH server's host keys and config.
       * `All Users` is a link to `ProgramData`, so a grant of either reaches it.
       */
      machineStores: ["ProgramData/ssh"],
    },
    /**
     * WHERE EVERY HARNESS KEY LIVES: one per-user folder (0700) OUTSIDE every
     * checkout, state folder, project and grant — so no confined process, no
     * project and no file door can reach a key, of this checkout or any other,
     * and the whole folder is one keep-out entry. `environmentVariable`
     * relocates it (read once, at boot); otherwise `$XDG_CONFIG_HOME/<relative>`,
     * else `~/.config/<relative>`. It also holds the registry of harness stores
     * (`storesDirectory`): every database a harness process opened, so the
     * keep-out list refuses them by identity wherever they are.
     */
    keyHome: {
      environmentVariable: "HARNESS_KEY_HOME",
      baseVariable: "XDG_CONFIG_HOME",
      defaultBase: "~/.config",
      relative: `${PRODUCT_NAME}/keys`,
      /** A test run's private key homes: under the user's cache folder
       * (`filesystemInfrastructure.userCacheHome`; off tmpfs, where the default
       * confined temp folder would contain them), one per run, removed with it. */
      testRelative: `${PRODUCT_NAME}/test-key-homes`,
      storesDirectory: "stores",
      keySuffix: ".key",
      saltSuffix: ".salt",
      /**
       * The record that a key has sealed BOUND fields (migration 20 or a
       * database created bound): kept beside the key, outside the database,
       * where no confined process and no database edit can reach it. Under a
       * key so recorded, migration 20 never re-seals an unbound value — one
       * that appears there was planted (a pre-v20 copy's ciphertext moved into
       * another user's row), whatever the database says about itself.
       */
      boundSuffix: ".bound",
    },
    handledAccessFs: LANDLOCK_ACCESS_FS_FLAG_NAMES,
    runtimeEnforcementAvailable: false,
  },
  universalPolicyArchitecture: {
    implementationStage: "target-invariant-only-policy-fabric-and-effect-gateway-unavailable",
    authority: "single-versioned-capability-operation-policy-registry-compiler",
    operationEnvelope: "canonical-operation-envelope",
    layerOrder: ["root", "harness", "project", "task"],
    layerRule: "lower-layers-may-only-tighten",
    lifecycle: [
      "intent",
      "policy-plan",
      "durable-intent",
      "authorize",
      "effect",
      "durable-result",
      "validate",
      "commit-or-rollback",
      "learn",
    ],
    generatedPlanes: ["static", "runtime", "storage", "conformance"],
    policyFamilies: [
      "authorization",
      "unavoidable-logging",
      "secret-handling",
      "configuration",
      "budgets",
      "current-research-and-whole-codebase-reuse",
      "attempt-before-retry",
      "error-normalization",
      "edit-validation-and-rollback",
      "tests",
      "shared-memory-and-coordination",
      "timeouts-cancellation-and-recovery",
      "missing-capability-and-equivalence",
      "adaptive-context-management",
      "candidate-bound-conversation-bootstrap",
      "steering-continuity-and-observer-proposals",
      "recurring-alignment-checkpoint-and-agent-acknowledgement",
      "runtime-language-and-independent-oracle-boundary",
      "governed-important-artifact-admission",
      "workspace-git-onboarding-and-never-push",
      "manifest-extension-lifecycle-and-privileged-update-broker",
    ],
    extensions: {
      manifest: "declare-capabilities-and-operations",
      inheritance: "automatic-compiled-policy-chain-no-copied-guards",
      bootPolicy: "fail-on-uncovered-conflicting-or-cyclic-policy",
    },
    bypassPolicy: {
      unregisteredOrDirectLowLevelEntrypointsAllowed: false,
      parallelPolicyDefinitionsAllowed: false,
      localBypassesAllowed: false,
    },
    waivers: "central-scoped-justified-tested-logged-expiring-and-policy-hash-bound",
    trustedLoggerRoot: "minimal-non-recursive-and-unavoidable",
    timelineBinding: "policy-version-hash-and-decision-plan-before-effect",
    replay: "offline-effect-free-policy-backtest",
    metrics: ["overhead", "false-positive", "false-negative", "coverage", "conflict-and-cycle"],
    moduleArchitecture: {
      manifest: "src/architecture-manifest.ts",
      graph: "exact-registered-edges-no-cycles-and-inward-layer-direction",
      publicApi: "exact-declared-export-name-hash",
      effects: "registered-owner-and-execution-boundary-only",
      compositionRoots: "per-realm-versioned-arrays-owned-by-src/architecture-manifest.ts",
      primaryAnalyzer: "babel-typed-pure-architecture-analysis",
      independentOracle: "separate-lexical-scanner-plus-typescript-no-emit-pipeline",
      analyzerDisagreement: "fail-closed",
      runtimeEnforcementAvailable: false,
    },
    dualSurfaceAssessment: {
      surfaces: ["builder", "runtime"],
      applicability: ["applicable", "not-applicable"],
      outcomes: ["pass", "fail", "n/a", "unassessed"],
      evidenceBinding: "subject-realm-and-execution-boundary-required",
      oneSurfaceMaySatisfyOther: false,
      unavailableMustRemainUnassessed: true,
    },
    preventableDefectGateway: {
      implementationStage: "target-invariant-only-common-preventable-defect-gateway-unavailable",
      authority: "universal-policy-operation-envelope-boundary-not-a-parallel-monitor-or-gate",
      operationEnvelopeBoundaries: ["pre-apply", "pre-completion"],
      deterministicAnalyzerRole: "primary-authoritative-machine-check-and-rejection",
      llmInstructionRole: "non-authoritative-guidance-never-substitute-for-deterministic-enforcement",
      requiredToolPolicy: "use-exact-required-tool-or-provide-verified-install-guidance-and-block",
      subparFallbackAllowed: false,
      packComposition: "central-registered-language-packs-plus-project-specific-packs-through-shared-owners",
      findingPreventionDisposition: {
        scope: "every-new-and-historical-finding",
        requiredEvidence: [
          "prevention-disposition",
          "shared-owner-reuse-analysis",
          "hostile-regression-or-explicit-infeasibility-and-research-evidence",
        ],
        duplicateLocalImplementationAllowed: false,
      },
      acceptanceInvalidationAndReplay: {
        triggers: [
          "test-rule-guardrail-policy-schema-detector-or-validator-change",
          "authority-architecture-edge-or-applicability-change",
        ],
        affectedPriorAcceptanceRemainsValidWithoutReplay: false,
        exactCandidateReplay: [
          "new-focused-regression",
          "complete-previously-governed-test-surface",
          "affected-language-and-project-quality-packs",
          "prevention-requirements-config-authority-architecture-inventory-and-artifact-checks",
          "applicable-hostile-recovery-concurrency-and-independent-families",
          "full-promotion-gate",
        ],
        targetedX3AndTypecheckRole: "development-evidence-only-never-final-replay-substitute",
        unavailableOrStaleCompleteReplay: "explicit-blocker-and-builder-runtime-unassessed",
        priorGreenResultCarryForwardAllowed: false,
      },
      findingSelfClosureAllowed: false,
      available: false,
    },
    authorityOwnershipGraph: {
      implementationStage: "target-invariant-only-central-authority-ownership-graph-unavailable",
      authority: "universal-policy-registry-compiler",
      registration: "every-owned-identifier-schema-shape-config-path-and-policy-surface-declares-one-owner",
      derivationEdges: "consumers-reference-or-generate-from-owner-never-hand-copy-semantic-authority",
      allowedRepetitionClasses: [
        "canonical-generated-artifact",
        "explicit-historical-parser",
        "hostile-mutant-or-fixture",
      ],
      unclassifiedSemanticRepetitionAllowed: false,
      duplicateSemanticAuthorityAllowed: false,
      enforcementOwner: "preventableDefectGateway",
      available: false,
    },
    auditMatrix: {
      angles: AUDIT_MATRIX_ANGLES,
      outcomes: ["pass", "fail", "n/a-with-reason", "unassessed"],
      stages: AUDIT_MATRIX_STAGES,
      findingLifecycle: ["finding", "root-cause", "permanent-regression", "repair", "recheck"],
      timelineBinding: "every-cell-stage-finding-and-recheck-bound-to-evidence-timeline",
      selfHosting: "required-future-dogfood",
      independentAudit: "mandatory-non-self-hosted-and-never-satisfied-by-dogfood",
      evidenceAdmission: {
        available: false,
        draftSatisfactionAllowed: false,
        futureAuthority: "dedicated-evidence-admission-authority-not-yet-implemented",
        validatedIndexOwnership: "same-dedicated-evidence-admission-authority-only",
      },
      alignmentCheckpoint: {
        implementationStage: "target-invariant-only-recurring-checkpoint-and-agent-acknowledgement-unavailable",
        authority: "derived-projection-over-existing-requirements-task-continuity-evidence-and-audit-authorities",
        competingGoalTaskAuditFindingOrMonitorStoreAllowed: false,
        inputAuthorities: [
          "user-objective-source-intent-requirement-acceptance-and-test-method-revisions",
          "task-focus-plan-progress-blocker-and-next-action-projections",
          "repository-candidate-config-policy-base-and-resource-identities",
          "audit-matrix-findings-attempt-results-evidence-and-remaining-gates",
          "agent-profile-task-state-acknowledgement-lease-and-write-set-identities",
        ],
        mandatoryTriggers: [
          "task-start-or-resume",
          "steering-reconciliation-complete",
          "replan",
          "agent-spawn-handoff-or-bounded-progress-boundary",
          "context-compaction-or-recovery",
          "failure-or-test-result",
          "before-edit",
          "before-feature-or-git-checkpoint-or-commit",
          "before-release-or-completion-claim",
        ],
        configurableAdditionalCadence: [
          "maximum-events-between-checkpoints",
          "maximum-actions-between-checkpoints",
          "maximum-provider-input-tokens-between-checkpoints",
          "maximum-wall-clock-seconds-between-safe-boundary-checks",
        ],
        mandatoryTriggerFloorConfigurable: false,
        configurationLimits: {
          maximumEventsBetweenCheckpoints: 10_000,
          maximumActionsBetweenCheckpoints: 1_000,
          maximumProviderInputTokensBetweenCheckpoints: 1_000_000,
          maximumWallClockSecondsBetweenSafeBoundaryChecks: 86_400,
          maximumProjectionBytes: 1_048_576,
          maximumObserverInputTokens: 131_072,
          selectableObserverProfiles: ["deterministic-only", "hybrid-advisory"],
        },
        output: "immutable-source-linked-expected-observed-divergence-uncertainty-acknowledgement-blocker-next-action-and-input-output-identity-projection",
        sameImmutableInputCoalescingAllowed: true,
        requiredPreEffectOrCompletionCoalescingAllowed: false,
        recursiveSelfTriggerAllowed: false,
        selfValidationOrFindingClosureAllowed: false,
        agentAcknowledgement: {
          requiredBeforeNextEffect: true,
          scope: "task-objective-plan-base-resource-policy-config-acceptance-and-relevant-finding-identities",
          invalidation: "any-bound-identity-change-or-contradiction",
          missingStaleOrContradictory: "block-agent-effect-and-route-through-shared-finding-and-continuity-reconciliation",
          mayRewriteSharedGoalOrPlan: false,
        },
        deterministicOwnership: "identity-trace-staleness-gate-acknowledgement-lease-test-consistency-and-completion-blocking",
        optionalObserver: "sanitized-read-only-alignment-concern-proposals-only-no-goal-plan-task-audit-finding-effect-or-completion-authority",
        qualification: "x3-repeated-plus-x3-materially-distinct-long-multiturn-multiagent-hostile-alignment-functionality-methodology-continuity-privacy-overhead-and-recovery",
        available: false,
      },
    },
    missingCapabilityPolicy: {
      unavailableAction: "stop-affected-path-and-report-exact-missing-capability-and-why",
      installGuidance: "verified-install-and-post-install-check-required",
      evidence: "log-missing-capability-user-decision-and-equivalence-evaluation",
      fallback: "forbidden-unless-prequalified-equivalent-for-exact-task-with-evidence",
      silentSubstitutionAllowed: false,
      equivalenceRegistryAvailable: false,
    },
    adaptiveContextManagement: {
      sourceHistory: "immutable-complete-and-addressable",
      summariesAndViews: "versioned-derived-rebuildable-lineage-bound-with-declared-omissions",
      pinnedContinuity: ["decisions", "requirements", "current-task", "failed-attempts"],
      silentLossAllowed: false,
      strategy: "progressive-budget-and-task-aware-retrieval-with-conflict-and-uncertainty",
      pressurePlan: {
        authority: "candidate-model-capability-token-composition-and-central-config-bound-derived-plan",
        fiftyPercentUsedContextRole: "unqualified-preregistered-candidate-cell-only-never-operational-default",
        exactCrossModelPressureConstantAllowed: false,
        tokenAccounting: "provider-reported-plus-qualified-local-counter-disagreement-fails-closed",
        reservedHeadroom: [
          "model-output-and-reasoning",
          "tool-definitions-calls-and-results",
          "provider-protocol-and-accounting-overhead",
          "retry-errors-cancellation-and-recovery",
          "emergency-continuity",
        ],
        progressiveReductionOrder: "central-configured-optional-derived-views-only-under-non-weakenable-protected-context-floor",
        representationRehydration: "reversible-from-immutable-source-history-through-stable-least-privilege-query-handles",
        omissionReceipt: "source-ids-lineage-reason-classification-budget-and-query-handles",
        fullCompaction: "observable-critical-fail-safe-only-after-no-qualified-lower-loss-plan-fits",
        destructiveSourceHistoryTrimmingAllowed: false,
        summaryAsSourceAuthorityAllowed: false,
      },
      candidates: [
        "recency-only",
        "rolling-summary",
        "hierarchical-tiered",
        "lexical",
        "local-offline-dense-embeddings",
        "hybrid-lexical-dense-causal-graph",
        "reranking",
        "task-aware",
      ],
      vectorStatus: "hypothesis-never-assumed-best",
      benchmark: "model-provider-context-task-profile-long-multi-turn-tool-heavy-many-agent-compaction-recovery-x3-or-more-select-by-downstream-task-and-code-quality",
      retrievalMcpQualification: {
        mandatoryAdapters: ["kagi", "deepwiki", "scrapling", "context7"],
        exclusionAllowed: false,
        additionalCandidates: "benchmark-many-provider-neutral-memory-code-semantic-graph-and-research-mcps",
        paperAndLeaderboardRole: "hypothesis-only-never-acceptance-without-reproduction",
        repetitions: "three-or-more-materially-distinct-real-and-adversarial-runs",
        measures: [
          "source-accuracy-freshness-completeness-and-contradictions",
          "downstream-code-and-task-quality",
          "tool-call-and-schema-errors",
          "latency-cost-tokens-and-resources",
          "source-overlap",
          "authentication-rate-limits-and-privacy",
          "offline-cache-staleness-and-poisoned-results",
        ],
        gateway: "provider-neutral-mcp-port-through-universal-logged-policy-tool-path",
        missingMandatoryCapability: "fail-closed-with-verified-install-config-and-check-guidance",
        available: false,
      },
      available: false,
    },
    agentOrchestraArchitecture: {
      authority: "single-versioned-declarative-agent-profile-registry",
      profileFields: [
        "identity-and-version",
        "role-capabilities-and-task-eligibility",
        "provider-and-model-constraints",
        "allowed-tools-data-and-classifications",
        "input-output-evidence-and-expected-result-schemas",
        "interaction-and-handoff-protocols",
        "shared-memory-visibility",
        "concurrency-write-set-and-lease-rules",
        "timeouts-retries-and-cancellation",
        "inherited-policies-and-lifecycle",
        "required-conformance-and-recovery-tests",
      ],
      topology: "central-config-zero-through-five-without-orchestration-engine-edits",
      authorityModel: "task-scoped-capabilities-no-ambient-privilege",
      interactionPath: "typed-provider-neutral-task-message-event-ledger-and-live-awareness",
      hiddenSideChannelsAllowed: false,
      expectedOutput: "schema-and-expected-result-validation-before-merge-or-use",
      benchmark: "zero-through-five-heterogeneous-conflict-crash-malformed-output-x3-or-more",
      available: false,
    },
    orchestratorContextDiscipline: {
      rootResponsibilities: [
        "orchestration-and-cross-agent-synthesis",
        "authorization-and-conflict-resolution",
        "acceptance-and-user-communication",
      ],
      delegatedBroadWork: [
        "repository-wide-reading-and-discovery",
        "current-primary-source-research",
        "complete-regression-and-promotion-replay",
        "independent-review",
      ],
      accessOrder: "scoped-agent-through-qualified-mcp-capability-before-root-direct-access",
      delegationEnvelope: "effective-policy-task-evidence-query-handles-lease-write-set-and-alignment-checkpoint",
      directRootAccess: "necessary-bounded-and-receipted-exception-never-model-facing-read-bypass",
      taskScopedAgentAlignmentBeforeHandoff: true,
      rootContextConvenienceMayReduceEvidenceTestingOrIsolation: false,
      enforcementAvailable: false,
    },
    deterministicModelScaffolding: {
      implementationStage: "target-invariant-only-model-tier-ablation-and-parity-evaluation-unavailable",
      providerNeutralInvariantScaffold: [
        "repository-discovery-reuse-and-query-handles",
        "typed-plans-tools-and-operation-envelopes",
        "pre-apply-syntax-type-static-and-edit-validation",
        "quality-tests-policy-and-promotion-gates",
        "memory-context-coordination-and-recovery",
      ],
      registeredCapabilityAdaptationAllowed: true,
      modelTierSpecificHiddenPolicyOrOracleAllowed: false,
      smallModelParityStatus: "falsifiable-preregistered-benchmark-hypothesis-only-never-promise",
      comparisonControls: [
        "same-frozen-tasks-repositories-candidates-and-acceptance-oracles",
        "same-tools-evidence-budgets-and-randomized-order-except-registered-capability-delta",
        "multiple-capability-tiers-and-provider-families",
        "component-and-interaction-ablations",
        "worst-case-uncertainty-failure-and-overhead-reporting",
      ],
      primaryOutcome: "independent-final-task-code-requirement-and-architecture-quality",
      passRateModelSizeOrScaffoldSelfReportSufficient: false,
      available: false,
    },
    provisionalFindingPolicy: {
      statuses: ["open-blocking", "verified-removed"],
      openFindingAction: "block-every-affected-surface-capability-checkpoint-and-release",
      requiredFields: [
        "owner",
        "rationale",
        "evidence-links",
        "removal-condition",
        "deadline",
        "affected-surfaces",
        "blocked-capabilities",
        "permanent-regression",
        "independent-removal-verification",
      ],
      placeholderEvidenceAllowed: false,
      notApplicableWithoutReasonAndEvidenceAllowed: false,
      silentExpiryAllowed: false,
      workaroundCompletionAllowed: false,
      temporaryFallbackMayPass: false,
      authorTestsCountAsIndependentVerification: false,
      removal: "requires-condition-proof-permanent-regression-and-independent-recheck",
      currentRegistry: "src/architecture-manifest.ts#findings",
      builderEnforcementAvailable: true,
      runtimeEnforcementAvailable: false,
    },
    effectGatewayAvailable: false,
  },
  filesystemInfrastructure: {
    implementationStage:
      "shared-effect-adapter-configured-internal-runtime-admission-pending-external-verification",
    // Where the kernel publishes process facts (src/process/process-facts.ts,
    // the one reader).
    procfsRoot: "/proc",
    // This user's cache folder (src/filesystem/user-folders.ts, the one rule):
    // the instrument lock, the test key homes, the V8 compile cache.
    userCacheHome: { baseVariable: "XDG_CACHE_HOME", defaultBase: "~/.cache" },
    // The longest file name (one path segment) a Linux filesystem holds, in
    // bytes (NAME_MAX): an owned sibling temporary longer than this is named
    // by a digest of its target instead (src/filesystem/private-state.ts).
    fileNameLimitBytes: 255,
    // The suites write temporaries to the system temp root; a nearly full one
    // (bytes OR inodes — /tmp is a tmpfs here and ran out of inodes first)
    // fails tests for no reason in the code. Both runners check it before a
    // run (src/filesystem/temporary-root.ts) and warn below this free share.
    temporaryRootMinimumFreeFraction: 0.1,
    // The gates' full output logs live OUTSIDE every checkout, under the run's
    // temp root (D-19): a log written inside a checkout is a write no generator
    // declares (a promotion's converge refuses it), and the checkout is not a
    // store. One folder per checkout below this one (src/workflow/checkout-setup.ts).
    gateLogFolder: `${PRODUCT_NAME}-gate-logs`,
    // How many hex characters of the checkout's real-path digest name its gate-log folder.
    gateLogCheckoutDigestHexDigits: 16,
    // A gate's output is redacted a whole logical line at a time (never split inside a key and its value); a line
    // that grows past this many characters with no end is WITHHELD whole (said in its place), so memory stays bounded.
    gateLogLineMaximumCharacters: 65_536,
    // The one cross-process file lock (src/filesystem/file-lock.ts): how long a
    // contender waits for a live holder, how often it looks, and how old an
    // UNREADABLE lock file (one no harness process wrote) must be before it is
    // broken. A live holder is never broken, whatever its age; a dead holder's
    // lock is broken at once. A locked cycle is a read-modify-write of one
    // small file, so waits are milliseconds (a caller that holds longer, the
    // resource locks, passes its own configured wait).
    fileLock: {
      timeoutMs: 10_000 as number,
      pollIntervalMs: 20 as number,
      staleMs: 120_000 as number,
      // A lock record is one short JSON line: a larger file is never read (it is judged unreadable).
      maximumRecordBytes: 65_536,
      // A holder label as shown and recorded: a person reads it, nothing parses it.
      maximumHolderCharacters: 200,
    },
    privateState: {
      directoryMode: 0o700,
      fileMode: 0o600,
      maximumFileBytes: 16_777_216,
      maximumDirectoryEntries: 100_000,
      temporaryRandomBytes: 16,
      procFileDescriptorRoot: "/proc/self/fd",
      segmentContract: {
        maximumUtf8Bytes: 255,
        normalization: "NFC",
        patternSource: "^[A-Za-z0-9._-]+$",
      },
      directoryWorker: {
        schemaVersion: schemaId("private-directory-create-worker", 1),
        sourcePath: "src/filesystem/private-directory-create-worker.mjs",
        sourceSha256: "7f3d86d032a98d0571d2595b01a60baef0cba5fb1868ca64d1dfa3f6136812e5",
        maximumSourceBytes: 16_384,
        maximumInputBytes: 20_480,
        parentDescriptor: 3,
        parentBindingId: "parent-directory",
        executableTargetDescriptor: 4,
        workingDirectory: "/",
        allowedStatuses: [0],
        allowedSignals: [],
        maximumOutputBytes: 4_096,
        maximumErrorBytes: 4_096,
        timeoutMilliseconds: 5_000,
        nodeArguments: ["--input-type=module", "-"],
        environment: {},
      },
      publication:
        "exclusive-temp-0600-fsync-no-replace-link-target-recheck-directory-fsync-temp-unlink-directory-fsync",
      replacementOrRenameAvailable: false,
      deleteOrPhysicalQuarantineAvailable: false,
    },
    runtimeLaunch: {
      requiredAuthority: "central-configured-admitted-node-runtime-and-modeled-principal-write-isolation",
      callerSuppliedAdmissionAllowed: false,
      currentProductionState: "configured-internal-admission-pending-external-verification",
      internalMechanismTestCapabilityMayAdmitProductionOrReceipts: false,
      configuredInternalAdmission: {
        admissionClass: "configured-internal-pending-external-verification",
        principal: {
          identity: "configured-internal-node-runtime-principal",
          capabilities: [
            "durable-filesystem-mutation",
            "receipt-creation",
            "evidence-publication",
          ],
          sourceAuthority: "root-policy-runtimeLaunch",
        },
        runtimeExecutable: {
          source: "process-exec-path",
          maximumBytes: 268_435_456,
          mechanismTestOnly: false,
        },
        externalBootstrap: {
          status: "not-started",
          blockers: [
            "no-authenticated-bootstrap-installer-principal-distinct-from-modeled-runtime-principal",
            "no-central-modeled-runtime-principal-groups-acls-capabilities-namespaces-tool-policy",
            "no-core-admission-authority-independently-pinning-record-locator-and-digest",
            "shell-tls-openpgp-hash-archive-bootstrap-toolchain-byte-locked-but-unadmitted",
          ],
          qualifiedNodeRuntimeIdentity: {
            releaseArchiveSha256:
              "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
            memberSha256:
              "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c",
            signerFingerprint: "C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C",
          },
        },
      },
    },
  },
  filesystem: {
    rawFileModes: {
      source: 0o644,
      test: 0o644,
      traceability: 0o644,
      config: 0o600,
      evidence: 0o644,
    },
    fileModeClassification: {
      sourceSuffixes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      testSuffixes: [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".spec.ts", ".spec.tsx"],
      traceabilityPrefix: "traceability/",
      configSuffixes: [".config.json", ".config.jsonc"],
      evidenceSuffixes: [".receipt.json", ".evidence.json"],
    },
  },
  authentication: {
    method: "local-os-effective-user",
    requireConfigAndProjectOwnerMatch: true,
  },
  protocol: {
    preflightCommand: "preflight",
    qualityCommand: "quality",
    harnessCommand: "harness",
  },
  receipts: {
    preflightSchemaVersion: 1,
    immutableExecution: {
      schemaVersion: schemaId("immutable-execution-evidence", 2),
      authorityStage: "durable-local-creation-unadmitted",
      configuredStatePath: "state.root-plus-state.receipts.executionEvidence",
      authorityStrategy: {
        port: "receipt-authority",
        currentBuilderStrategy: "configured-repository-local-private-state-durable-unadmitted",
        futureCanonicalStrategy: "qualified-outside-worktree-git-common-dir-or-canonical-ledger-store",
        sharedWriterRequired: true,
        worktreeStateMayBecomeCanonicalLedger: false,
      },
      evidenceRootMode: 0o700,
      directoryModeEnforcement:
        "isolated-empty-environment-child-umask-zero-mkdir-0700-then-linux-o-path-pinned-proc-fd-exact-mode-recheck",
      linuxPathOnlyOpenFlag: 0o10000000,
      directoryFaultStages: [
        "after-directory-mkdir",
        "after-directory-mode-enforcement",
        "after-directory-durable-open",
        "after-directory-fsync",
      ],
      pathPolicy: "canonical-relative-beneath-configured-repository-local-private-state",
      writeProtocol: "descriptor-held-o-nofollow-temp-fsync-exclusive-link-target-recheck-double-directory-fsync",
      destinationModes: ["exclusive-path", "content-addressed", "unique-attempt"],
      collisionPolicy: "exclusive-and-unique-fail-content-addressed-verifies-identical-or-fails",
      fileMode: 0o600,
      fileModeEnforcement: "descriptor-fchmod-before-publication-and-exact-mode-recheck",
      metadataRemediationSchemaVersion: schemaId("immutable-evidence-mode-remediation", 1),
      metadataRemediationAuthorityStage:
        "current-filesystem-metadata-remediation-unadmitted-not-clone-portable",
      maximumBytes: 16_777_216,
      maximumPathBytes: 4_096,
      maximumDirectoryEntries: 100_000,
      contentAddressedVerificationAttempts: 128,
      contentAddressedVerificationWaitMilliseconds: 1,
      contentFormat: "canonical-json-plus-exactly-one-lf",
      streamEncoding: "utf8",
      procFileDescriptorRoot: "/proc/self/fd",
      faultStages: [
        "after-temporary-open",
        "after-write",
        "after-file-fsync",
        "after-publish",
        "after-target-verification",
        "after-first-directory-fsync",
        "after-temporary-unlink",
        "after-second-directory-fsync",
      ],
    },
    testExecution: {
      implementationStage: "builder-test-evidence-only-not-canonical-ledger-admitted",
      startSchemaVersion: schemaId("execution-start", 2),
      terminalSchemaVersion: schemaId("execution-terminal", 3),
      resultSchemaVersion: schemaId("test-result-receipt", 4),
      testReceiptSchemaVersion: schemaId("s1-test-receipt", 5),
      checkResultSchemaVersion: schemaId("check-result", 2),
      streamBlobFormat: "parent-observed-exact-bytes-with-length-sha256-media-type-encoding-and-completeness",
      runIdentity: "random-uuid-attempt-namespace-plus-unique-content-bound-start-and-terminal-events",
      terminalRequirement: "terminal-event-references-start-content-addressed-result-parent-observed-stream-blobs-and-observed-native-completion",
      incompleteRunDisposition: "scanner-validates-complete-incomplete-unsafe-and-ambiguous-never-infers-success",
      operationSpecs: [
        {
          id: "core-test",
          workerMode: "test",
          resultKind: "test-result-receipt",
        },
        {
          id: "core-s1-check",
          workerMode: "check",
          resultKind: "check-result-receipt",
        },
      ],
      canonicalLedgerAdmitted: false,
      repositoryArtifactAdmitted: false,
      releaseReadinessEvidenceAllowed: false,
      findingRemovalEvidenceAllowed: false,
    },
  },
  verification: {
    // Hard ceilings on process-local immutable scanner retention. These bound
    // source characters, span records and entry metadata independently; they
    // are not a byte-accurate heap budget or an operator performance default.
    // Eviction changes only recomputation, never the scanner's answer.
    lexicalReuse: LEXICAL_REUSE_LIMITS,
    /**
     * THE SHRINK-ONLY RATCHET BASELINES (`scripts/verification/ratchet.ts`),
     * by id, repository-relative: generated outputs of a regenerate pass,
     * which prunes each one against its guard's scan
     * (`scripts/verification/ratchet-baselines.ts` attaches the scan to each
     * id and refuses an id without one) — never hand-edited, never grown.
     */
    ratchetBaselines: {
      "inline-literal-defaults": "engine/test/prevention/inline-literal-defaults-baseline.json",
      "web-unhandled-catch": "tests/prevention/unhandled-catch-baseline.json",
      // A whole-repository scan: its baseline lives outside the engine, so an
      // engine-only working copy (the generators' copies) does not carry it and
      // is converged by its absence, like the web baseline above.
      "dead-markdown-links": "tests/prevention/markdown-links-baseline.json",
    },
    /**
     * THE FROZEN-RECORD ROOTS (repository-relative folder prefixes): closed
     * rounds' records and byte-exact imports, their content pinned by
     * `frozenRecordManifest` (any change is a reviewed manifest change). One
     * declaration for every guard that walks records: the frozen-record
     * guard (nothing live consumes a file inside one) and the dead-link scan
     * (a frozen document's links are history and are not judged — exempted by
     * the root, wholesale, never one link at a time). Links INTO a frozen
     * root from a live document are judged like any other. Adding a root is a
     * sensitive change.
     */
    // THE FROZEN ROOTS' PINNED CONTENT (repository-relative): every file under
    // a frozen root with its content digest, generated by `harness sync` and
    // verified by `harness check` (src/workflow/record-links.ts
    // `syncFrozenRecords`).
    frozenRecordManifest: "docs/frozen-records.json",
    frozenRecordRoots: [
      "docs/history/",
      "engine/docs/history/",
      "docs/findings/recovery/originals/",
      "docs/findings/recovery/records/",
      "docs/findings/recovery/research/",
      "docs/design/recovery/originals/",
      "docs/design/recovery/records/",
    ],
    // How often a test runner's supervision looks: at the stall clock (the web
    // runner) and at its launcher (both runners stop a run whose launcher —
    // the `npm test` wrapper — exited; scripts/tooling/launcher-watch.ts
    // `watchLauncher`).
    testRunSupervision: {
      watchIntervalMs: 1_000 as number,
    },
    commandEffectInventory: {
      pythonExecutable: "/usr/bin/python3",
      shellExtensions: [".sh"],
      vendorPathSegments: ["node_modules", "third-party", "third_party", "vendor"],
    },
    testFixtures: {
      repositoryLocalTemporaryRoot: statePath("test-fixtures"),
      lifecycle: "excluded-from-candidate-and-cleaned-after-each-test",
      repositoryRootCapability: {
        schemaVersion: schemaId("repository-root-capability", 1),
        adapter: "linux-proc-self-fd-pathname-assisted-test-only",
        platform: "linux",
        acquisitionModes: ["raw-path", "qualified-capability"],
        capabilityIssuer: "repository-local-test-fixture-authority",
        capabilityScopes: ["qualified-test-repository-root", "repository-local-test-root"],
        capabilityPurposes: ["repository-local-test-root-creation", "safe-repository-read"],
        capabilityAcquisitions: ["module-relative-qualified-root", "exclusive-create-beneath-qualified-root"],
        publicLifecycle: "exclusive-live-owner",
        terminationDispositions: ["expired", "revoked", "closed"],
        exactPrivateIdentityFields: ["device", "inode", "type", "mode", "ownerUid", "ownerGid"],
        repositoryLocalRootPermissionMode: "0700",
        nonceBytes: 32,
        budget: {
          schemaVersion: schemaId("repository-root-capability-budget", 1),
          limitCeilings: {
            maximumConcurrentBorrowsPerCapability: 1,
            maximumOperationsPerBorrow: 64,
            maximumBorrowOperationsPerCapability: 8192,
            maximumBorrowOperationsPerTask: 16_384,
            maximumCapabilityRotationsPerTask: 4,
            maximumBorrowedPathBytes: 4096,
            maximumBorrowedPathSegments: 128,
          },
        },
        openat2Equivalent: false,
        renameRaceClosure: false,
      },
    },
    testInventorySchema: "bridlewise-test-inventory/v4",
    testInventoryHash: "ab56144fed98236862a7286e21c8b478997790d20d77e2f820bf3c215e003c67",
    testSurfaceDispositionBinding: {
      fileSha256: "2c7e6c7d76439b6e9554b437fc712bb682c3b7cd7d1d67b4b0fdf87fd126419d",
      identityHash: "dacdcd1a91a491d0505bb026da617564190dfbac9e42344968a7a7f7faa561ab",
    },
    testDiscovery: {
      inventoryScope: {
        recognizableSurfaceDispositionCoverageComplete: true,
        canonicalNodeInventorySourceSetComplete: true,
        fullRepositoryTestQualificationComplete: false,
        historicalSchemaDisposition: "v1-v2-and-v3-parse-only-never-reinterpret-as-v4",
      },
      qualifiedSourcePatterns: [
        "test/**/*.test.ts",
        "verification/benchmarks/opencode-history/review/independent-scope-review.test.ts",
        "verification/benchmarks/opencode-history/scope-guard.test.ts",
      ],
      recognizableSourcePatterns: {
        javaScriptTypeScript: "^.+\\.(?:test|spec)\\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$",
        python: "^(?:.*/)?(?:test(?:_[^/]*)?|[^/]+_test(?:_[^/]*)?)\\.py$",
      },
      dispositionRegistry: {
        manifestPath: "traceability/test-surface-dispositions.json",
        schemaVersion: schemaId("test-surface-dispositions", 1),
        allowedDispositions: [
          "canonical-node-test",
          "qualified-external-oracle",
          "pending-external-qualification",
          "non-test-fixture",
          "unsupported-blocking",
        ],
        everyRecognizableSourceRequiresExactEntry: true,
        benchmarkLocationImpliesDisposition: false,
        pythonImplicitExecutionAllowed: false,
        unqualifiedDisposition: "block-and-report-exact-source-and-disposition",
        qualificationGuidance: "install-or-qualify-exact-loader-compiler-and-runner-before-central-pattern-or-external-oracle-admission",
      },
      /**
       * THE CONSERVATION IDENTITY — how many tests must run, derived from an
       * instrument this policy cannot influence.
       *
       * ── THE FAILURE THIS EXISTS TO REFUSE, PERFORMED AND MEASURED ────────
       *
       * Rename `test/` to `tests/`, run `harness regenerate` (exit 0, "pass"),
       * run `npm test`: exit 0, status "passed", and **78 of 8,562 tests ran**
       * — the reading taken on the tree of the day this was performed, kept as
       * the record of a measurement rather than as a claim about today's
       * counts. Every number stayed green because every number was derived
       * from the same place the damage happened. `qualifiedSourcePatterns[0]`
       * stopped matching, the auto-heal re-registered every canonical file as
       * `pending-external-qualification`, and the canonical set became the two
       * hand-written literals in `qualifiedSourcePatterns` below.
       *
       * ── WHY A FLOOR ON A COUNT CANNOT WORK ──────────────────────────────
       *
       * The population is supplied BY THE CALLER, so an empty universe passes
       * every check computed from it. And a floor on the git-tracked count is
       * blind too, because `git mv` keeps a file tracked: the tracked count is
       * INVARIANT under exactly the operation that causes the collapse.
       * Restoring a denominator does not restore a population.
       *
       * ── SO: AN IDENTITY BETWEEN THREE INDEPENDENTLY-SOURCED QUANTITIES ──
       *
       *     git-tracked recognizable  −  pinned excluded  −  pinned
       *     non-canonical  =  canonical
       *
       * Only the two middle terms are pinned, and they are DATA a few lines
       * below rather than prose here — `excludedSourceSet.count` and
       * `nonCanonicalSourceSet.count`, each beside the hash of the set it
       * counts. Both outer terms are MEASURED, from different instruments:
       * the left from the git index (written by `git`, unreachable from this
       * file), the right from the disposition manifest. So the identity is
       * not a tautology — it is two instruments being asked to agree, with
       * the pins fixing the gap between them.
       *
       * THE WORKED EXAMPLE USED TO BE SPELLED OUT HERE, AND IT WENT STALE.
       * It read `433 − 21 − 15 = 397` while the tree had moved on, so the
       * only English in this file that a reader could check against reality
       * was the part that disagreed with it. The four measured quantities are
       * computed on every run and returned as a receipt
       * (`TestSurfaceConservationReceipt`: git-recognizable, excluded,
       * non-canonical, canonical), and the refusal prints all four with the
       * arithmetic. A count restated in a comment is a second source of truth
       * for a number the code already produces.
       *
       * Driven against the performed catastrophes, and the shape is what
       * matters rather than the day's totals:
       *   today                        expected = actual                pass
       *   rename, no widening          actual collapses to the two
       *                                hand-written literals             REFUSE
       *   rename, complete widening    actual exceeds expected           REFUSE
       *   empty universe               actual 0, expected positive       REFUSE
       *
       * Adding a canonical test file moves BOTH measured terms by one and the
       * identity still balances, so ordinary work never touches these pins.
       *
       * ── THE RE-PIN COST, MEASURED, BECAUSE AN UNSTATED ONE GETS DISABLED ─
       *
       * Across all 79 commits of this repository, counting distinct sorted-set
       * hashes per bucket:
       *
       *   excluded set ......  8 distinct  -> re-pin about 1 commit in 10
       *   non-canonical set .  3 distinct  -> re-pin about 1 commit in 26
       *   canonical set ..... 18 distinct  -> would re-pin EVERY manifest commit
       *
       * That last line is why the canonical set is measured rather than
       * pinned. A pin that must be restated every commit is a pin someone
       * deletes, and then the identity is gone.
       *
       * These two are NEVER auto-repaired. A pin a generator can rewrite
       * refuses nothing — that is the same auto-heal that turned the rename
       * into a green run.
       */
      surfaceConservation: {
        /**
         * Recognizable test sources git tracks that the disposition manifest
         * deliberately does NOT cover — the experiment exclusions. Pinned as a
         * SET (hash + size), never as the prefix roots that produce it:
         * widening a root silently admits files, and a pinned set does not
         * move when a root does.
         */
        excludedSourceSet: {
          // RESTATED BY HAND WITH THE test/exp473 RECLASSIFICATION
          // (2026-08-03), 16 -> 9: four recognizable test sources left the
          // index with the retired experiment tests (exp420/exp438/exp450/
          // exp464), and the three under test/exp473 moved OUT of the
          // excluded set into the covered canonical set — they are product
          // regression tests of src/ modules, renamed to test/regression/.
          // This pin is deliberately not auto-repaired: a pin a generator
          // can rewrite refuses nothing.
          count: 9,
          sha256: "6bf74a72fd94587c0fcb69d6a6f1813f1cb3608aea2d05ddc4a9ecb92372463d",
        },
        /**
         * Manifest entries that are NOT `canonical-node-test` — everything the
         * suite is allowed to know about and not run.
         */
        nonCanonicalSourceSet: {
          // RESTATED BY HAND AT THE MONOREPO ASSEMBLY (2026-07-30), 15 -> 14.
          // `scripts/merge-round.test.mjs` left the surface with the file it
          // tested: both were dead copies importing `../integration/...`, a
          // path this repository does not have, while the live pair lives at
          // `scripts/harness-root/merge-round{,.test}.mjs` — so the coverage
          // did not move, the duplicate did. This pin is deliberately not
          // auto-repaired: a pin a generator can rewrite refuses nothing.
          // RESTATED BY HAND FOR LIVE-SUITE (2026-10-07), 14 -> 15: the ONE
          // live suite `live/mcp-servers.test.ts` (qualified-external-oracle,
          // `npm run test:live`) joined the surface; its tests left the
          // hermetic `test/mcp/real-servers.test.ts`, so they moved, none vanished.
          // RESTATED BY HAND FOR THE HERMETIC GUARD BY SHAPE (2026-10-09, round
          // 12 E19), 15 -> 16: `live/provider-smoke.test.ts` joined the live
          // suite; the environment-declared provider completion left the
          // hermetic `test/runtime/makora-smoke.test.ts`, whose refusals stay.
          count: 16,
          sha256: "9aea26ca84622f3aa32bb029e722c7df81efe6729f55bc38926478cb71a2b48b",
        },
      },
      maximumDepth: 32,
      maximumEntries: 100_000,
      maximumAstNodes: 100_000,
      maximumAstDepth: 512,
      maximumStaticEvaluationDepth: 32,
      maximumSourceBytes: 16_777_216,
      maximumInventoryBytes: 16_777_216,
      traversal: "deterministic-recursive-descriptor-held-no-follow-snapshot",
      executionInput: "inventory-derived-explicit-file-list-only",
    },
    // THE CHECKOUT WRITE DOOR (src/filesystem/checkout-write-door.ts): how a
    // process learns that it runs under test, and what it may still write.
    // Our test runners ARM the checkout they test: the marker variable (a
    // JSON list of checkout roots, inherited by every descendant that keeps
    // its env) and the marker file, which each armed process holds OPEN so a
    // descendant with a scrubbed env finds it among its ancestors' descriptors
    // (procfs, through src/process/process-facts.ts). No ancestor's
    // environment is ever read.
    checkoutWriteDoor: {
      markerEnvironmentVariable: "HARNESS_CHECKOUT_UNDER_TEST",
      markerFile: statePath("checkout-under-test"),
      // A node process RUNS tests when node's own options hold this flag, its
      // script is a test file (`recognizableSourcePatterns`), or an option
      // (a preload, a loader, eval code) names one.
      nodeTestRunnerFlag: "--test",
      // The node options whose VALUE is code node runs (a preload, a loader,
      // eval text, a test reporter or global-setup module): only these can
      // name a test file. Any other valued option (`--watch-path
      // test/x.test.ts`) names a value node does not run.
      nodeCodeOptions: ["--import", "--require", "-r", "--loader", "--experimental-loader", "--eval", "-e", "--print", "-p", "--test-reporter", "--test-global-setup"],
      // EVERY OTHER node option that takes a SEPARATE value (`--title x`,
      // `--env-file x`): read from an ancestor's procfs command line, that
      // value is the option's, never the script (`node --title plain.mjs
      // test/y.test.mjs` runs the test file: WF-1b3b verify M4). The list is
      // node's own: every `--opt=...` line of the running node's `--help`
      // must be classified here or in the code options (the drift arm in
      // engine/test/prevention/no-destructive-test-writes.test.ts).
      nodeValuedOptions: [
        "--allow-fs-read", "--allow-fs-write", "--build-snapshot-config", "-C", "--conditions", "--cpu-prof-dir", "--cpu-prof-interval",
        "--cpu-prof-name", "--diagnostic-dir", "--disable-proto", "--disable-warning", "--dns-result-order", "--env-file", "--env-file-if-exists",
        "--experimental-config-file", "--experimental-package-map", "--experimental-sea-config", "--experimental-test-tag-filter",
        "--heap-prof-dir", "--heap-prof-interval", "--heap-prof-name", "--heapsnapshot-near-heap-limit", "--heapsnapshot-signal", "--icu-data-dir",
        "--input-type", "--inspect-publish-uid", "--localstorage-file", "--max-http-header-size", "--max-old-space-size-percentage",
        "--network-family-autoselection-attempt-timeout", "--openssl-config", "--redirect-warnings", "--report-directory", "--report-dir",
        "--report-filename", "--report-signal", "--run", "--secure-heap", "--secure-heap-min", "--snapshot-blob", "--test-concurrency",
        "--test-coverage-branches", "--test-coverage-exclude", "--test-coverage-functions", "--test-coverage-include", "--test-coverage-lines",
        "--experimental-test-isolation", "--test-isolation", "--test-name-pattern", "--test-random-seed", "--test-reporter-destination",
        "--test-rerun-failures", "--test-shard", "--test-skip-pattern", "--test-timeout", "--title", "--tls-cipher-list", "--tls-keylog",
        "--trace-event-categories", "--trace-event-file-pattern", "--trace-require-module", "--unhandled-rejections", "--use-largepages",
        "--v8-pool-size", "--watch-kill-signal", "--watch-path",
      ],
      // The executables whose command lines are read as node's (ancestors only).
      nodeExecutableNames: ["node", "nodejs"],
      // The only directories of a checkout under test a test may write: a
      // state root at the checkout's top, or at the top of one of its
      // packages (a folder holding its own package.json, e.g. the engine) —
      // never a same-named folder planted deeper (`src/.bridlewise/x.ts`).
      writableDirectoryNames: [STATE_DIRECTORY_NAME],
    },
    // A PROCESS UNDER TEST DIALS NOTHING BUT THIS MACHINE: the outbound door
    // refuses a remote destination (src/shared/outbound-http.ts), and every
    // process that runs tests is held to this machine at the socket
    // (scripts/tooling/network-under-test.ts).
    // THE ONE DECLARED OPT-IN for a deliberate live interop or conformance
    // suite: the operator sets `liveConsentVariable` to "1" in the run's
    // environment, and exactly `liveHosts` (exact names) become reachable,
    // the consent audited (src/process/live-network.ts).
    networkUnderTest: {
      liveConsentVariable: "HARNESS_LIVE_NETWORK_TESTS",
      liveHosts: ["mcp.context7.com", "mcp.deepwiki.com", "inference.coralbricks.ai"],
    },
    // The one namespace of working-tree snapshot refs
    // (src/git/working-copy.ts snapshotWorkingTree): a snapshot is named, never
    // written to a caller-spelled ref, and never the commit of record.
    workingTreeSnapshot: {
      refNamespace: "refs/bridlewise/snapshots",
    },
    // The live index's recorded baseline (src/git/index-baseline.ts): every
    // candidate command and `harness check` compare the index against it.
    // The protected blobs are pinned by a ref in `pinRefNamespace` (one per
    // checkout), so `git gc` never prunes a blob only the index held.
    liveIndexBaseline: {
      path: statePath("state", "index-baseline.json"),
      pinRefNamespace: "refs/bridlewise/index-baselines",
    },
    safeRepositoryRead: {
      implementation: "linux-proc-self-fd-component-descriptor-walk",
      procFileDescriptorRoot: "/proc/self/fd",
      requireCanonicalAbsoluteRoot: true,
      rejectSymlinkHardlinkSpecialCrossDeviceAndMountpoint: true,
      keepAncestorDescriptorsOpenThroughReadAndRecheck: true,
      // Production floor: hardlinked repository files (nlink > 1) are rejected
      // because a second path to the same inode can bypass write isolation and
      // TOCTOU rechecks. The operator opts out for dev mode (e.g. a tree seeded
      // with `cp -rl`, which produces nlink=2) by setting
      // `selfProtection.enabled: false` in the config; the CLI propagates that
      // to the `HARNESS_REJECT_HARDLINKS` env var consumed by
      // `shouldRejectHardlinks` in `src/shared/source-scan.ts`. Inside the
      // Landlock guardian (production) the env var is `1` and the floor is
      // enforced. See `scripts/verification/safe-repository-reader.ts`.
      rejectHardlinks: true,
      rejectSymlinks: true,
    },
    candidateFormat: {
      revision: "candidate-format/v1",
      inventoryOwner: "scripts/candidate-manifest.ts#buildCandidateManifest",
      scope: "all-git-tracked-and-nonignored-untracked-candidate-files",
      /**
       * Engine-relative trees that hold FROZEN RECORDS, not candidates: their
       * bytes are history (kept as measured, never re-formatted), read by no
       * program. The evidence archive was subtracted as a floor byte until the
       * floor model retired (PROMO-4); it stays out of the population by this
       * declaration (the promotion profile excludes it too).
       */
      recordRoots: ["traceability/evidence/"],
      maximumInspectedFileBytes: 16_777_216,
      path: {
        form: "nonempty-portable-repository-relative-forward-slash-path",
        forbidden: ["absolute", "empty-segment", "dot-segment", "backslash", "control-character"],
      },
      text: {
        encoding: "strict-utf8-without-bom-or-nul",
        lineEnding: "lf-only",
        finalNewline: "empty-file-or-exactly-one-terminal-lf",
        trailingWhitespace: "space-or-tab-forbidden-on-every-line",
        markdownHardBreak: "explicit-markup-required-no-two-space-exemption",
        generatedText: "same-policy-no-generated-file-exemption",
      },
      binary: {
        disposition: "exempt-only-by-declared-extension-and-exact-magic-prefix",
        formats: [
          { extension: ".gz", magicHex: "1f8b" },
          { extension: ".png", magicHex: "89504e470d0a1a0a" },
        ],
      },
      rejectedWithoutContentRead: {
        basenames: [".env", ".netrc", ".npmrc", ".pypirc", "credentials.json", "secrets.json"],
        basenamePrefixes: [".env."],
        suffixes: [".key", ".p12", ".pfx", ".pem"],
        pathSegments: [".secrets", "credentials", "raw-personal-conversations", "secrets"],
      },
      immutableTextSourceExceptions: {
        authorityManifests: ["traceability/sources/s2/manifest.json"],
        authorityRole: "exact-committed-official-source-fragment-manifest",
        allowedViolationKinds: ["excess-final-newline", "trailing-whitespace"],
        changedAuthorityOrFragmentDigestAllowed: false,
        copiedOrUnmanifestedPathAllowed: false,
      },
      gitIdentity: {
        executablePath: "/usr/bin/git",
        maximumOutputBytes: 67_108_864,
        configurationOverrides: [
          "core.attributesFile=/dev/null",
          "core.excludesFile=/dev/null",
          "core.fsmonitor=false",
          "core.hooksPath=/dev/null",
          "core.pager=cat",
          "core.untrackedCache=false",
          "diff.external=",
          "diff.trustExitCode=false",
          "filter.lfs.clean=",
          "filter.lfs.process=",
          "filter.lfs.required=false",
          "filter.lfs.smudge=",
          "interactive.diffFilter=",
          "pager.status=false",
        ],
        processEnvironment: {
          GIT_ASKPASS: "/bin/false",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_EXTERNAL_DIFF: "",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          HOME: "/nonexistent/bridlewise-verification-home",
          LANG: "C",
          LC_ALL: "C",
          PAGER: "cat",
          PATH: "/usr/bin:/bin",
          TZ: "UTC",
        },
        stderrPolicy: "any-byte-fails-closed-with-digest-and-byte-count-only",
        repositoryControlledCodeExecutionAllowed: false,
        untrackedIgnoreAuthorities: ["candidate-.gitignore-files-only"],
        semanticTree: "path-type-normalized-mode-byte-length-and-sha256-only",
        workspaceState: "head-index-worktree-identities-and-derived-state",
        publication: "external-canonical-output-sha-and-post-commit-tag-or-ledger-receipt-only",
        publicationManifestBytes: "canonical-json-plus-exactly-one-lf",
        publicationHashStoredInsideCandidateManifest: false,
        checkpointPrerequisiteExcludes: [
          "candidate-manifest-canonical-output-sha256",
          "post-commit-tree-id",
          "annotated-tag",
          "append-only-ledger-receipt",
        ],
        requireIndexWorktreeEqualityForPublication: true,
        rejectUnqualifiedAttributesOrFilters: true,
        rejectSparseCheckout: true,
        rejectIntentToAddUnmergedSkipWorktreeAssumeUnchangedSubmoduleLfsAndSymlink: true,
        rejectPortableCaseOrUnicodeNormalizationCollision: true,
        snapshotRecheckRequired: true,
      },
    },
  },
  workflow: {
    /**
     * THE RECORDED REPRODUCTIONS a `Flake-cause:` declaration needs
     * (src/shared/flake-reproduction.ts; written by `harness flake
     * reproduce`): one canonical JSON record per (test, fix), engine-relative.
     */
    // How many frames of a failing test's own file a failure's location keeps (src/shared/run-history.ts `failureLocation`).
    failureLocationFrames: 3,
    flakeReproductions: {
      directory: "traceability/flake-reproductions",
      // Every attempt of the door, recorded or refused: one file each, named by the sha256 of its bytes (src/shared/flake-reproduction.ts).
      attemptDirectory: "attempts",
      // The most runs per side the door's arithmetic considers (a failure rate needing more is "too rare to show").
      maximumRunsPerSide: 10_000,
    },
    /**
     * THE FLAKY MEMORY'S SHRINK-ONLY BURN-DOWN LISTS (src/workflow/flaky-burn-down.ts):
     * one per suite, engine-relative; each entry a red suspect and the open
     * task row that owns it (UR-19, the guard catalog's moving-forward rule).
     */
    flakyBurnDown: { directory: "traceability/flaky-burn-down" },
    /**
     * WHO OWNS A FAILURE THE TARGET ALREADY HAS (src/workflow/failure-owners.ts):
     * the tracker whose OPEN task rows (`- [ ] **<ID>**`) name the failing
     * test's repository path. The workspace's ledger judge accepts a failure
     * that persists from the target's recorded run only when such a row owns
     * it; a new or changed failure, or an unowned one, fails the gate.
     */
    failureOwners: {
      tracker: "docs/trackers/TASKS.md",
      /**
       * THE BUDGETS JUDGED IN THE SAME JUDGEMENT (UR-24): a budget gate of a
       * ledger whose breach persists from the target passes only while an
       * open task row names the budget (its config key) and this change's
       * SLOTTED value is no higher than the target's LOWEST recorded value
       * (the row field named here). A new breach, a worse one, an unowned or
       * an unslotted one fails. Any other budget gate fails outright.
       */
      budgets: {
        engine: { "cpu-per-test-file": { budget: "testExecution.integrationSuiteCpuBudget", field: "cpuMsPerTestFile" } },
        web: {
          "cpu-per-test-file": { budget: "testExecution.webUiSuiteCpuBudget", field: "cpuMsPerTestFile" },
          // Each perf budget: its value is the profile report's measurement, recorded in the row (`field` is a dotted path).
          ...Object.fromEntries(Object.keys(WEB_PERFORMANCE_BUDGET_KINDS).map((name) => [
            `${WEB_PERFORMANCE_GATE_PREFIX}${name}`,
            { budget: `webUi.performance.${name}`, field: `${WEB_PERFORMANCE_LEDGER_FIELD}.${name}` },
          ])) as Readonly<Record<`${typeof WEB_PERFORMANCE_GATE_PREFIX}${keyof typeof WEB_PERFORMANCE_BUDGET_KINDS}`, Readonly<{ budget: string; field: string }>>>,
        },
      },
    },
    /** The web-UI performance budgets (see {@link WEB_PERFORMANCE_BUDGET_KINDS}): their kinds, the row field and the gate prefix. */
    webPerformanceBudgets: {
      kinds: WEB_PERFORMANCE_BUDGET_KINDS,
      ledgerField: WEB_PERFORMANCE_LEDGER_FIELD,
      gatePrefix: WEB_PERFORMANCE_GATE_PREFIX,
    },
    // THE ONE COMMAND RUNNER's errored class (src/workflow/checkout-setup.ts):
    // a failed command whose output REPORTS one of these system error codes
    // (npm's `code`/`errno` line, an uncaught `Error: <code>`) ran out of a
    // machine resource (space, the npm cache, the network), not into a
    // defect of the change — it is retried, never blamed. A line that merely
    // mentions a code (a test named after it) reports nothing.
    commandRunner: {
      environmentalErrorCodes: ["ENOSPC", "ENOTCACHED", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"],
    },
    // The promotion primitive (src/workflow/promotion/): its refs live under
    // one namespace (`<namespace>/<profile>/…`: `pending`, `receipts/<commit>`),
    // and a promotion commit names the source commit it carries, the profile
    // blob it was projected by and the target edits it was told to overwrite
    // in these trailers — the durable state a rerun derives from. A promotion
    // run by an engine other than the source commit's own re-executes the
    // source's (its promoter home); the variable names the engine root that
    // is already the source's, so the child does not re-execute again. A
    // rollback commit names the promotion it restores (`restores`). The
    // promoter's own fetches and pushes carry the run variable, so the
    // repository's trigger hook (`.githooks/reference-transaction`) never
    // starts a promotion from a promotion. A commit id is shortened to
    // `shortIdLength` characters in a promotion commit's message and in its
    // folders' names, and the message lists at most `messageSourceLines`
    // source commits: both shape the commit, so they live beside its trailers.
    promotion: {
      refNamespace: `refs/${PRODUCT_NAME}/promotion`,
      trailers: {
        promotedFrom: "Promoted-From",
        profile: "Promotion-Profile",
        acceptedTargetEdits: "Promotion-Accepted-Target-Edits",
        restores: "Promotion-Restores",
      },
      promoterHomeEnvironmentVariable: "HARNESS_PROMOTER_HOME",
      runEnvironmentVariable: "HARNESS_PROMOTION_RUN",
      logEnvironmentVariable: "HARNESS_PROMOTION_LOG",
      shortIdLength: 8,
      messageSourceLines: 50,
    },
    /**
     * THE EVIDENCE STORE (src/workflow/evidence-store.ts): raw evidence kept
     * OUT of git, by content, in one per-user private home (the private-home
     * owner, src/filesystem/private-home.ts): the operator's
     * `environmentVariable` (an absolute folder), else `$<baseVariable>/<relative>`,
     * else `<defaultBase>/<relative>` — outside the keep-out floor's
     * `~/.local/state/<product>-*` wildcard, and kept out of every confined
     * process wherever it is (keep-out.ts). Its objects are the immutable
     * owner's content-addressed files (src/filesystem/immutable-receipt.ts):
     * `<objects.root>/<objects.namespace>/sha256/<digest><objects.extension>`,
     * 0600 in 0700 folders, never replaced. A committed manifest
     * (`manifestName`, found wherever git tracks one) records each file's
     * path, sha256, size and mode; every recorded path lies in the manifest's
     * own evidence folder (`<the manifest's folder>/<folderName>/`), which git
     * ignores through a GENERATED rule (harness sync). A Markdown record links
     * a stored file as `<linkScheme><recorded path>`.
     */
    evidenceStore: {
      environmentVariable: "HARNESS_EVIDENCE_HOME",
      baseVariable: "XDG_DATA_HOME",
      defaultBase: "~/.local/share",
      relative: `${PRODUCT_NAME}/evidence`,
      objects: { root: "cas", namespace: "blob", extension: ".bin" },
      manifestName: "evidence-manifest.json",
      folderName: "evidence",
      /** Folder names no recorded path may hold (any case): git's own folder and the shipped hooks' (a hook is code that runs on the next commit). */
      forbiddenSegments: [".git", ".githooks"],
      /** The generated block of the root ignore file: one rule per tracked manifest's evidence folder. */
      ignoreBlock: {
        file: ".gitignore",
        begin: "# BEGIN GENERATED: the evidence folders git ignores, one per tracked evidence manifest (harness sync; engine/src/workflow/evidence-store.ts)",
        end: "# END GENERATED: the evidence folders",
      },
      linkScheme: "evidence:",
    },
  },
  paths: {
    rejectAbsoluteRequestedPath: true,
    rejectTraversal: true,
    rejectSymlinks: true,
    rejectHardlinks: true,
    rejectMountpointsAndCrossDevicePaths: true,
    bindDeviceInodeOwnerModeAndPrincipal: true,
    descriptorVerifiedDecisionsAreProvisional: true,
    effectsRequireFutureKernelEnforcement: true,
    allowedOperations: ["inspect"],
    migrationAuthorityRoot: {
      childName: "bridlewise-migration-authority",
      placement: "descriptor-validated-0700-private-child-of-exact-git-common-directory",
      outsideTrackedCandidateAndGitOwnedNamespaces: true,
      outOfBandMutationDetectedNotPrevented: true,
    },
  },
  data: {
    minimumProjectClassification: DATA_CLASSIFICATION.projectPrivate,
    unknownClassification: DATA_CLASSIFICATION.regulatedRestricted,
    externalEgress: "deny",
    secretEgress: "deny",
  },
  capabilities: {
    preflight: true,
    mutableState: false,
    modelInvocation: false,
    modelTools: false,
    retryDispatch: false,
    repositoryMutation: false,
    processExecution: false,
    networkEgress: false,
    sensitiveInput: false,
    durableAudit: false,
  },
} as const satisfies CanonicalValue;

export type RootPolicy = typeof ROOT_POLICY_VALUE;

export const ROOT_POLICY: RootPolicy = deepFreeze(ROOT_POLICY_VALUE);
export const EXECUTION_OPERATION_SPECS = ROOT_POLICY.receipts.testExecution.operationSpecs;
export const EXECUTION_OPERATION_IDS = deepFreeze(
  EXECUTION_OPERATION_SPECS.map((spec) => spec.id),
);
export type ExecutionOperationId = typeof EXECUTION_OPERATION_IDS[number];
export const ROOT_POLICY_HASH = canonicalHash(ROOT_POLICY);
