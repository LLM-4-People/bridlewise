import { deepFreeze } from "./kernel/integrity.ts";

export type ArchitectureRealm = "builder" | "runtime" | "shared" | "safety";
export type ArchitectureLayer =
  | "trusted-kernel"
  | "domain"
  | "ports"
  | "application"
  | "infrastructure"
  | "interface"
  | "verification";
export type ArchitectureExecutionBoundary =
  | "pure"
  | "read-adapter"
  | "effect-adapter"
  | "interface"
  | "composition-root"
  | "verification";
export type ArchitectureEffect =
  | "child-process"
  | "cryptography"
  | "environment-access"
  | "filesystem-read"
  | "filesystem-write"
  | "git"
  | "network"
  | "process-control"
  | "process-status";
export type ArchitectureAuthorityFamily =
  | "configuration"
  | "data-classification"
  | "errors"
  | "events";

/*
 * THE EXECUTABLE SOURCE EXTENSIONS ARE NOT PART OF THIS MANIFEST, BY DESIGN.
 * They are declared in and exported from `src/shared/source-extensions.ts`,
 * and this module neither imports nor republishes them. A re-export was the
 * obvious hazard and was never written; the less obvious one was a
 * `sourceExtensions` FIELD on the manifest, which is a re-export wearing a
 * different shape — a consumer reads the field, gets the value, and drags this
 * generated 5,000-line data module in for eight strings, with no import cycle
 * to refuse it. The field is gone from the type and from the value, so that
 * read no longer compiles. Ask `src/shared/source-extensions.ts` instead.
 */

export type ArchitectureModule = Readonly<{
  id: string;
  path: string;
  realm: ArchitectureRealm;
  layer: ArchitectureLayer;
  owner: string;
  executionBoundary: ArchitectureExecutionBoundary;
  compositionRoot: boolean;
  dependencies: readonly string[];
  allowedDependencyLayers: readonly ArchitectureLayer[];
  publicApi: Readonly<{ exportCount: number; namesSha256: string }>;
  ports: Readonly<{ requires: readonly string[]; provides: readonly string[] }>;
  effects: readonly ArchitectureEffect[];
  configPaths: readonly string[];
  stateOwners: readonly string[];
  projectionOwners: readonly string[];
  authorityFamilies: readonly ArchitectureAuthorityFamily[];
  authorityIdentifiers: readonly string[];
  responsibilities: readonly string[];
}>;

export type ArchitectureExternalCommand = Readonly<{
  disposition: "blocked-unqualified";
  effects: readonly ArchitectureEffect[];
  exposure: "research-only-non-model-facing" | "verification-internal";
  id: string;
  language: "python" | "shell";
  owner: string;
  path: string;
  sourceSha256: string;
}>;

export type ArchitectureFinding = Readonly<{
  id: string;
  status: "open-blocking" | "verified-removed";
  owner: string;
  rationale: string;
  evidenceLinks: readonly string[];
  removalCondition: string;
  deadline: string;
  affectedSurfaces: readonly ("builder" | "runtime")[];
  blockedCapabilities: readonly string[];
  regression: string;
  removalVerification: string;
  note?: string;
}>;

export type ArchitectureManifest = Readonly<{
  schemaVersion: "bridlewise-architecture-manifest/v3";
  sourceRoots: readonly ["scripts/", "src/", "verification/"];
  graphPolicy: "exact-registered-edges-no-cycles";
  publicApiPolicy: "exact-declared-export-name-hash";
  analysisLimits: Readonly<{ maximumSourceBytes: number; maximumAstNodes: number }>;
  responsibilityPolicy: "one-registered-cohesive-owner-per-responsibility";
  physicalLayoutStatus: "open-blocking-architecture-v1-migration-required";
  compositionRoots: Readonly<Record<ArchitectureRealm, readonly string[]>>;
  externalCommands: readonly ArchitectureExternalCommand[];
  modules: readonly ArchitectureModule[];
  findings: readonly ArchitectureFinding[];
}>;

/**
 * Empty composition roots for every realm — the typed "no composition roots"
 * fixture. Typed as `Readonly<Record<ArchitectureRealm, readonly string[]>>`
 * so adding a new realm to {@link ArchitectureRealm} FORCES this constant to
 * be updated (a typecheck error, not a silent miss). Test fixtures that need
 * a manifest with no composition roots reuse this instead of hand-writing
 * `{ builder: [], runtime: [], shared: [] }` (which silently dropped the
 * `safety` realm — R45). Single owner.
 */
export const EMPTY_COMPOSITION_ROOTS: Readonly<Record<ArchitectureRealm, readonly string[]>> = deepFreeze({
  builder: [],
  runtime: [],
  shared: [],
  safety: [],
});

const LAYERS: Readonly<Record<ArchitectureLayer, readonly ArchitectureLayer[]>> = deepFreeze({
  "trusted-kernel": ["trusted-kernel"],
  domain: ["trusted-kernel", "domain", "ports"],
  ports: ["trusted-kernel", "domain", "ports"],
  application: ["trusted-kernel", "domain", "ports", "infrastructure", "application"],
  infrastructure: ["trusted-kernel", "domain", "ports", "infrastructure"],
  interface: ["trusted-kernel", "domain", "ports", "application", "infrastructure", "interface"],
  verification: [
    "trusted-kernel", "domain", "ports", "application", "infrastructure", "interface", "verification",
  ],
});

type ModuleInput = Omit<ArchitectureModule, "allowedDependencyLayers" | "compositionRoot" | "configPaths" |
  "effects" | "executionBoundary" | "ports" | "projectionOwners" | "stateOwners" |
  "authorityFamilies" | "authorityIdentifiers" | "responsibilities"> &
  Partial<Pick<ArchitectureModule, "compositionRoot" | "configPaths" | "effects" | "executionBoundary" |
  "ports" | "projectionOwners" | "stateOwners" | "authorityFamilies" | "authorityIdentifiers" |
  "responsibilities">>;

function moduleContract(input: ModuleInput): ArchitectureModule {
  return {
    ...input,
    allowedDependencyLayers: LAYERS[input.layer],
    compositionRoot: input.compositionRoot ?? false,
    executionBoundary: input.executionBoundary ?? "pure",
    ports: input.ports ?? { requires: [], provides: [] },
    effects: input.effects ?? [],
    configPaths: input.configPaths ?? [],
    stateOwners: input.stateOwners ?? [],
    projectionOwners: input.projectionOwners ?? [],
    authorityFamilies: input.authorityFamilies ?? [],
    authorityIdentifiers: input.authorityIdentifiers ?? [],
    responsibilities: input.responsibilities ?? [input.id],
  };
}

type ExternalCommandInput = Omit<ArchitectureExternalCommand, "disposition" | "exposure" | "language">;

function blockedPythonCommand(input: ExternalCommandInput): ArchitectureExternalCommand {
  return {
    ...input,
    disposition: "blocked-unqualified",
    exposure: "verification-internal",
    language: "python",
  };
}

function blockedResearchShellCommand(input: ExternalCommandInput): ArchitectureExternalCommand {
  return {
    ...input,
    disposition: "blocked-unqualified",
    exposure: "research-only-non-model-facing",
    language: "shell",
  };
}

export const ARCHITECTURE_MANIFEST: ArchitectureManifest = deepFreeze({
  schemaVersion: "bridlewise-architecture-manifest/v3",
  sourceRoots: ["scripts/", "src/", "verification/"],
  graphPolicy: "exact-registered-edges-no-cycles",
  publicApiPolicy: "exact-declared-export-name-hash",
  analysisLimits: { maximumSourceBytes: 1_048_576, maximumAstNodes: 100_000 },
  responsibilityPolicy: "one-registered-cohesive-owner-per-responsibility",
  physicalLayoutStatus: "open-blocking-architecture-v1-migration-required",
  compositionRoots: {
    builder: [
      "scripts/bootstrap-hooks.ts",
      "scripts/build-bundle.ts",
      "scripts/commit-guard.ts",
      "scripts/generation/repository-path-unicode.ts",
      "scripts/pin-authority-regeneration.ts",
      "scripts/post-commit.ts",
      "scripts/regenerate-handoff-manifest.ts",
      "scripts/test-inventory.ts",
      "scripts/verification/ratchet-baselines.ts",
      "src/index.ts",
    ],
    runtime: [
      "src/cli.mjs",
      "src/cli.ts",
      "src/evaluation/cli.ts",
      "src/intelligence/farm-child.ts",
      "src/tools/concurrent/long-task-wrapper.mjs",
      "src/workflow/harness-commands.ts",
      "src/workflow/workspace-cli.ts",
    ],
    shared: [
      "src/shared/workflow/e2e-runner.mjs",
    ],
    safety: [],
  },
  externalCommands: [
    blockedPythonCommand({
      id: "code-intelligence-inspect-existing-baseline",
      path: "verification/benchmarks/code-intelligence/inspect_existing_baseline.py",
      owner: "code-intelligence-qualification", effects: ["filesystem-read", "process-status"],
      sourceSha256: "82a0b875512947c3f53c500749724f703dc144bd52e59c79be94de7660e3bb4f",
    }),
    blockedPythonCommand({
      id: "code-intelligence-mcp-probe", path: "verification/benchmarks/code-intelligence/mcp_probe.py",
      owner: "code-intelligence-qualification",
      effects: ["child-process", "filesystem-read", "filesystem-write", "git", "process-status"],
      sourceSha256: "d7c7f19210e049904cf24a089acfd5b1a2044a2c71bb42424a316d875a6cefa7",
    }),
    blockedPythonCommand({
      id: "code-intelligence-policy-schemas", path: "verification/benchmarks/code-intelligence/policy_schemas.py",
      owner: "code-intelligence-qualification",
      effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
      sourceSha256: "6ecba33199fb695b20855ec43f0a0ac895b2817cfa894368d339182499228552",
    }),
    blockedPythonCommand({
      id: "code-intelligence-qualification", path: "verification/benchmarks/code-intelligence/qualification.py",
      owner: "code-intelligence-qualification",
      effects: [
        "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
        "process-status",
      ],
      sourceSha256: "7a1a6a82af9e38a4723b5258a45a41d7b567d207eedd8511da2156a2ce8a4560",
    }),
    blockedPythonCommand({
      id: "code-intelligence-qualification-tests",
      path: "verification/benchmarks/code-intelligence/tests/test_qualification.py",
      owner: "code-intelligence-qualification",
      effects: ["child-process", "cryptography", "filesystem-read", "filesystem-write", "git"],
      sourceSha256: "e810455a8eb4daf70049883e429dd848eb8ed7d554171994991f23193d02ab36",
    }),
    blockedPythonCommand({
      id: "context-generate-scenarios", path: "verification/benchmarks/context/generate-scenarios.py",
      owner: "context-qualification",
      effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
      sourceSha256: "e8e87c399c065268b041a5fbfef97a725fea44bbb891bec3b11a712d37399cae",
    }),
    blockedPythonCommand({
      id: "context-validate-suite", path: "verification/benchmarks/context/validate-suite.py",
      owner: "context-qualification", effects: ["cryptography", "filesystem-read", "process-status"],
      sourceSha256: "80989cd3e8dc19213c824bd2873061cd889352dabda1802feeb25ccbe4a14c56",
    }),
    blockedPythonCommand({
      id: "git-fault-transport", path: "verification/benchmarks/git/fault_transport.py",
      owner: "git-qualification",
      effects: ["child-process", "filesystem-read", "filesystem-write", "git", "process-status"],
      sourceSha256: "22346a118033f8e36cf68e4f9185b95fa347f53272a5538034d1e5f5de17a8b9",
    }),
    blockedPythonCommand({
      id: "git-qualification", path: "verification/benchmarks/git/qualification.py",
      owner: "git-qualification",
      effects: [
        "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
        "process-status",
      ],
      sourceSha256: "a6ada0ea61477b9fe6e579aa0bcfd758ec234cce10d2b639cbbb0bd04140d350",
    }),
    blockedPythonCommand({
      id: "git-qualification-tests", path: "verification/benchmarks/git/tests/test_qualification.py",
      owner: "git-qualification",
      effects: ["child-process", "filesystem-read", "filesystem-write", "git"],
      sourceSha256: "be99b25c1455cb26c377e8b5b6e17676fd4a4519257894a155b39e29d6123cf5",
    }),
    blockedPythonCommand({
      id: "historical-conversation-build-manifest",
      path: "verification/benchmarks/historical-opencode/conversation-study/build_manifest.py",
      owner: "historical-conversation-study",
      effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
      sourceSha256: "230daf654a973ab310f07aeb5d7475b2b9b509dd7395329d0b4789f80ba69fba",
    }),
    blockedPythonCommand({
      id: "historical-conversation-build-work-units",
      path: "verification/benchmarks/historical-opencode/conversation-study/build_work_units.py",
      owner: "historical-conversation-study",
      effects: ["filesystem-read", "filesystem-write", "process-status"],
      sourceSha256: "056410719cf1772a89db678c21d0f73eb6e2fe0dd840f527d293f5d2d29f529d",
    }),
    blockedPythonCommand({
      id: "historical-conversation-review-digest",
      path: "verification/benchmarks/historical-opencode/conversation-study/review_digest.py",
      owner: "historical-conversation-study", effects: ["child-process", "process-status"],
      sourceSha256: "105d6881872d6b8a9b950549f58f2bdb4d43a587009daae2b79af01a40c71e92",
    }),
    blockedPythonCommand({
      id: "historical-conversation-validate-failures-agent-b",
      path: "verification/benchmarks/historical-opencode/conversation-study/validate_failures_agent_b.py",
      owner: "historical-conversation-study", effects: ["cryptography", "filesystem-read", "process-status"],
      sourceSha256: "b4543886622b27c1d5f5028e160d6e3e83dcb0d0b97b9651b58dd903d19a8d7d",
    }),
    blockedPythonCommand({
      id: "historical-editor-analyze-history",
      path: "verification/benchmarks/historical-opencode/editor-benchmark/analyze_history.py",
      owner: "historical-editor-benchmark",
      effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
      sourceSha256: "2efadd06b1c494aa6ca1f2761818526ba69ce2a6d966efe748b0f3f721f23ea4",
    }),
    blockedPythonCommand({
      id: "historical-editor-validate-artifacts",
      path: "verification/benchmarks/historical-opencode/editor-benchmark/validate_artifacts.py",
      owner: "historical-editor-benchmark", effects: ["filesystem-read", "process-status"],
      sourceSha256: "9f1fc90b0cdb4af4a6e5ea3a190531bb65b797e4f0d36f8380f42d47f6e5b4b0",
    }),
    blockedPythonCommand({
      id: "historical-production-integration-test-manifest",
      path: "verification/benchmarks/historical-opencode/production-methodology/v4.7.0/integration_test_manifest.py",
      owner: "historical-production-methodology", effects: ["filesystem-read", "process-status"],
      sourceSha256: "6463488a834820fbc2b3dbdbce9ae4920f7abf6632b10ec04f36d36ac8306fd1",
    }),
    blockedPythonCommand({
      id: "historical-read-only-generate-fixtures",
      path: "verification/benchmarks/historical-opencode/read-only-adapter/fixtures/generate_fixtures.py",
      owner: "historical-read-only-adapter",
      effects: ["filesystem-read", "filesystem-write", "process-status"],
      sourceSha256: "3534832ceade313ab7ac561d0e0ce893d06ecca07ea120ba37d1d4fecc0b1001",
    }),
    blockedPythonCommand({
      id: "historical-read-only-adapter-tests",
      path: "verification/benchmarks/historical-opencode/read-only-adapter/tests/test_adapter.py",
      owner: "historical-read-only-adapter", effects: ["cryptography", "filesystem-read", "filesystem-write"],
      sourceSha256: "5680c81960c3f34a09e8850996c042e11685884233c7e0132770eaea7cf832d5",
    }),
    blockedPythonCommand({
      id: "historical-sanitizer-analysis",
      path: "verification/benchmarks/historical-opencode/sanitizer/opencode_analysis.py",
      owner: "historical-sanitizer",
      effects: ["child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "process-status"],
      sourceSha256: "c6ce9bebf5ef52bc647b1e74ca7d6140224d47a626b07a4d58cbd6b3b105c33c",
    }),
    blockedPythonCommand({
      id: "historical-sanitizer-tests",
      path: "verification/benchmarks/historical-opencode/sanitizer/test_v46.py",
      owner: "historical-sanitizer",
      effects: ["cryptography", "filesystem-read", "filesystem-write", "network"],
      sourceSha256: "7d1c789c0b7e794fd0d5f65216aeeaf7ad682d0b2f5e69744303654be40e7a19",
    }),
    blockedPythonCommand({
      id: "historical-sanitizer-acceptance-tests",
      path: "verification/benchmarks/historical-opencode/sanitizer/test_v46_acceptance.py",
      owner: "historical-sanitizer",
      effects: [
        "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
      ],
      sourceSha256: "61b8176f182ae3de95ca259307132ae747e2c4ca88de5dc01922a55c38cafdd4",
    }),
    blockedPythonCommand({
      id: "historical-sanitizer-lineage-tests",
      path: "verification/benchmarks/historical-opencode/sanitizer/test_v46_lineage_v467.py",
      owner: "historical-sanitizer", effects: [],
      sourceSha256: "96483c0a8569543cca3b4e64228a58a7569ef872f5b6cb157c0e515fd41a18b0",
    }),
    blockedPythonCommand({
      id: "historical-sanitizer-property-tests",
      path: "verification/benchmarks/historical-opencode/sanitizer/test_v46_properties.py",
      owner: "historical-sanitizer", effects: [],
      sourceSha256: "4dec25d344e81323c083c968ab42dbeb9db83d65c7a080906a3f8960bf1ec92a",
    }),
    blockedPythonCommand({
      id: "historical-sanitizer-public-verify",
      path: "verification/benchmarks/historical-opencode/sanitizer/v46_public_verify.py",
      owner: "historical-sanitizer",
      effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
      sourceSha256: "f1ed4ffbc0c088bdb005fbccb9194e8ddef901fe8a70313c2603882f70e4354b",
    }),
    blockedPythonCommand({
      id: "historical-sanitizer-test-manifest",
      path: "verification/benchmarks/historical-opencode/sanitizer/v46_test_manifest.py",
      owner: "historical-sanitizer", effects: ["filesystem-read", "process-status"],
      sourceSha256: "2d6970558c9b294c56da4bc91dc92d81db1efbad4906136bde4cc6a6d9609af0",
    }),
    blockedResearchShellCommand({
      id: "node-v24-linux-x64-runtime-provenance-verifier",
      path: "verification/benchmarks/runtime/verify-node-v24.18.0-linux-x64.sh",
      owner: "runtime-capability-qualification",
      effects: [
        "child-process", "cryptography", "filesystem-read", "filesystem-write", "network", "process-status",
      ],
      sourceSha256: "11864f28909be4d8b9f91fe035ad43e2350e89b95eb9031b930b3fb4044dc06d",
    }),
  ],
  findings: [{
    id: "ARCH-001-flat-physical-layout",
    status: "open-blocking",
    owner: "architecture",
    rationale: "Flat product and test paths do not enforce the bounded-context architecture required before effectful growth.",
    evidenceLinks: ["docs/architecture/architecture-v1.md#physical-target-tree"],
    removalCondition: "Complete the behavior-preserving manifest-enforced physical migration and independent rollback rehearsal.",
    deadline: "before-s3.2-storage-agents-mcp-editing-or-interactive-interface-integration",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["storage", "agents", "mcp", "editing", "interactive-cli", "web"],
    regression: "architecture-layout-manifest-and-import-fitness-mutation-suite",
    removalVerification: "independent-graph-layout-public-api-test-and-rollback-recheck",
    note: "The blocked capabilities (storage, agents, mcp, editing, interactive-cli, web) are implemented in the development branch but not admitted through the governance gate. They exist as unadmitted development code; this finding remains open-blocking until the physical migration and independent rollback rehearsal pass, at which point harnessReady may become true.",
  }, {
    id: "SEC-001-runbook-search-scope-exposure",
    status: "open-blocking",
    owner: "historical-research-safety",
    rationale: "A broad read-only subagent search escaped its authorized scope and emitted excluded packet content into a tool transcript; the affected run is confidentiality-tainted.",
    evidenceLinks: ["traceability/findings/SEC-001-runbook-search-scope-exposure.md"],
    removalCondition: "Install a manifest-bound deny-by-default launcher/search boundary and pass synthetic scope/transcript negative tests independently before any fresh real-history run.",
    deadline: "before-any-real-history-access-or-conversation-study-readiness-claim",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["real-history-access", "conversation-study-readiness", "no-access-or-clean-room-claims"],
    regression: "historical-research-path-scope-and-transcript-containment-x3",
    removalVerification: "independent-synthetic-launcher-search-negative-suite-and-fresh-clean-run",
  }, {
    id: "COORD-001-concurrent-research-layout-move",
    status: "open-blocking",
    owner: "multi-agent-coordination",
    rationale: "A bulk research-layout move crossed an active Git-qualification owner because the safe signal was not protected by a descendant write-set lease.",
    evidenceLinks: ["traceability/findings/COORD-001-concurrent-research-layout-move.md"],
    removalCondition: "The owning agent must reconcile exact bytes and final paths, close its lease, and an independent inventory/link/lease replay must pass.",
    deadline: "before-artifact-inventory-freeze-or-research-layout-acceptance",
    affectedSurfaces: ["builder"],
    blockedCapabilities: ["artifact-inventory-freeze", "research-layout-acceptance"],
    regression: "agent-write-set-descendant-lease-and-stale-signal-mutation-x3",
    removalVerification: "independent-byte-inventory-link-and-lease-replay",
  }, {
    id: "CAP-001-runtime-capability-false-absence",
    status: "open-blocking",
    owner: "runtime-capability-qualification",
    rationale: "Two ambient-PATH-only probes falsely reported Node absent even though the exact required Node and npm were installed under an allowed runtime manager but not activated; exact Unicode/ICU metadata reads are now centralized, but the four-state resolver and launch authority remain unavailable.",
    evidenceLinks: ["traceability/findings/CAP-001-runtime-capability-false-absence.md"],
    removalCondition: "Implement the central typed bounded resolver and scoped activation boundary, pass the hostile state matrix x3, and obtain independent acceptance.",
    deadline: "before-runtime-absence-clean-machine-external-process-or-final-candidate-qualification",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["runtime-absence-reporting", "clean-machine-runtime-qualification", "external-process-qualification", "final-candidate-freeze"],
    regression: "runtime-capability-state-and-bounded-activation-matrix-x3",
    removalVerification: "independent-frozen-state-discovery-activation-engine-and-toc-tou-mutation-recheck",
  }, {
    id: "FOUNDATION-001-missing-test-inventory-generator",
    status: "verified-removed",
    owner: "verification-foundation",
    rationale: "The former missing rebuild path is removed by one architecture-bound deterministic generator with transactional recovery, hostile tests, and independent x3 replay.",
    evidenceLinks: ["traceability/findings/FOUNDATION-001-missing-test-inventory-generator.md"],
    removalCondition: "Land one canonical generator, prove byte-identical double generation and hostile drift rejection, regenerate every dependent inventory, and complete independent recheck.",
    deadline: "before-next-semantic-checkpoint-or-candidate-receipt",
    affectedSurfaces: ["builder"],
    blockedCapabilities: ["test-inventory-freeze", "candidate-receipt", "artifact-inventory-freeze"],
    regression: "test-inventory-generator-round-trip-and-hostile-drift-x3",
    removalVerification: "independent-double-generation-loader-and-no-second-generator-recheck",
  }, {
    id: "FOUNDATION-002-candidate-format-verifier-blind-spot",
    status: "verified-removed",
    owner: "verification-foundation",
    rationale: "The blind spot is removed on frozen subject 9cd2bc38391b by the single fail-closed candidate inventory and format boundary, hostile x3 replay, and independent removal verification; residual platform and publication limits remain explicit.",
    evidenceLinks: [
      "traceability/findings/FOUNDATION-002-candidate-format-verifier-blind-spot.md",
      "traceability/evidence/verification/candidate-format/frozen-subject-9cd2bc38391b.json",
      "traceability/evidence/verification/candidate-format/post-subject-evidence.json",
      "traceability/evidence/verification/candidate-format/independent-review.json",
    ],
    removalCondition: "Land the single candidate-inventory format rule, normalize authored violations through their governed cascades, pass hostile tests x3, and complete independent replay.",
    deadline: "before-next-candidate-receipt-or-semantic-checkpoint",
    affectedSurfaces: ["builder"],
    blockedCapabilities: ["candidate-receipt", "artifact-inventory-freeze", "semantic-checkpoint", "release-readiness"],
    regression: "candidate-wide-format-path-and-source-preservation-matrix-x3",
    removalVerification: "independent-clean-and-mutated-candidate-replay-plus-canonical-cascade-audit",
  }, {
    id: "FOUNDATION-003-candidate-identity-conflated-content-and-git-state",
    status: "open-blocking",
    owner: "verification-foundation",
    rationale: "The v1 candidateSetHash changed when identical untracked bytes were staged and could not separately represent semantic content, workspace provenance, and final publication.",
    evidenceLinks: ["traceability/findings/FOUNDATION-003-candidate-identity-conflated-content-and-git-state.md"],
    removalCondition: "Qualify the separated semantic, format, workspace, and external publication identities, then implement and independently replay the authorized index-tree-to-commit-to-tag-or-ledger checkpoint.",
    deadline: "before-git-checkpoint-publication-or-candidate-receipt-readiness",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["git-checkpoint-publication", "candidate-receipt-readiness", "semantic-checkpoint", "release-readiness"],
    regression: "candidate-semantic-workspace-publication-identity-matrix-x3",
    removalVerification: "independent-stage-unstage-split-commit-and-non-self-reference-replay",
  }, {
    id: "FOUNDATION-004-execution-receipt-overwrite-and-race-gap",
    status: "open-blocking",
    owner: "verification-foundation",
    rationale: "The core test/S1 path now has durable local three-mode publication, parent-observed pipes and recovery scanning; command effects are centrally inventoried and qualified secret/MWA commands are read-only by default, but blocked producer qualification, repository-artifact admission and canonical-ledger admission remain unavailable.",
    evidenceLinks: [
      "traceability/findings/FOUNDATION-004-execution-receipt-overwrite-and-race-gap.md",
      "docs/research/verification/receipt-producer-inventory.md",
    ],
    removalCondition: "Qualify the immutable start/result/stream/terminal protocol and recovery scanner under crash and concurrency schedules, capture parent-observed streams, qualify or remediate blocked effects, admit through the canonical ledger, migrate in-scope producers, and complete independent replay.",
    deadline: "before-canonical-test-execution-receipts-or-readiness-evidence",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["canonical-test-execution-receipt", "test-evidence-ledger-admission", "receipt-based-finding-removal", "receipt-based-release-readiness"],
    regression: "immutable-start-result-stream-terminal-and-recovery-matrix-x3",
    removalVerification: "independent-crash-concurrency-parent-capture-and-ledger-admission-replay",
  }, {
    id: "FOUNDATION-005-configuration-contract-duplicate-authority",
    status: "open-blocking",
    owner: "configuration-architecture",
    rationale: "Configuration shape, version, ceilings, runtime validation, generated projections, fixtures and downstream consumers are not yet all compiled from one declarative ConfigContractSpec.",
    evidenceLinks: ["traceability/findings/FOUNDATION-005-configuration-contract-duplicate-authority.md"],
    removalCondition: "Compile every configuration consumer and migration decision from one versioned ConfigContractSpec and pass hostile differential and independent replay.",
    deadline: "before-final-configuration-or-release-readiness-claim",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["final-configuration-contract", "configuration-migration-readiness", "release-readiness"],
    regression: "configuration-spec-generated-consumer-and-version-transition-matrix-x3",
    removalVerification: "independent-generated-runtime-schema-cli-web-extension-fixture-and-migration-differential-replay",
  }, {
    id: "FOUNDATION-006-universal-authority-graph-unavailable",
    status: "open-blocking",
    owner: "authority-and-policy",
    rationale: "The TypeScript-first authority analyzer is narrow and the universal cross-language registry, applicability lock, compiler, read port and transactional pre-apply gate remain unavailable.",
    evidenceLinks: ["traceability/findings/FOUNDATION-006-universal-authority-graph-unavailable.md"],
    removalCondition: "Implement and qualify the cross-language authority registry/compiler, complete applicability matrix, domain-separated lock, read port and transactional pre-apply/pre-completion enforcement without unclassified repetition.",
    deadline: "before-universal-authority-enforcement-or-release-readiness-claim",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: ["universal-authority-enforcement", "cross-language-authority-coverage", "authority-gated-release-readiness"],
    regression: "cross-language-authority-registry-applicability-lock-and-transaction-gate-hostile-matrix-x3",
    removalVerification: "independent-cross-language-owner-consumer-mutation-role-and-unclassified-repetition-replay",
  }, {
    id: "FOUNDATION-008-content-addressed-evidence-production-admission-unavailable",
    status: "open-blocking",
    owner: "artifact-governance",
    rationale: "The deterministic pack/tree/registry, closed provider-evidence seam and append-only first-activation transaction are qualified only on synthetic fixtures; classification, license, provider, root, runtime, security and independent production activation authority remain unavailable.",
    evidenceLinks: [
      "traceability/findings/FOUNDATION-008-content-addressed-evidence-production-admission-unavailable.md",
      "docs/research/verification/content-addressed-evidence-store.md",
      "traceability/evidence/verification/content-addressed-evidence/pre-ingestion-assessment.json",
    ],
    removalCondition: "Admit one exact provider bundle, close classification/license/notice/external-lease evidence, qualify protected root/runtime/security authority, replay real-candidate recovery, and obtain independent exact first-activation authorization.",
    deadline: "before-any-production-content-store-active-registry-or-evidence-readiness-claim",
    affectedSurfaces: ["builder", "runtime"],
    blockedCapabilities: [
      "production-content-store-activation", "provider-readiness", "content-store-security-readiness",
      "content-store-product-readiness",
    ],
    regression: "content-store-provider-admission-root-authority-and-activation-hostile-matrix-x3",
    removalVerification: "independent-real-candidate-provider-runtime-security-and-first-activation-replay",
  }, {
    id: "COORD-002-implicit-default-root-write-effect",
    status: "open-blocking",
    owner: "multi-agent-coordination",
    rationale: "A bare apply-patch target intended for an external temporary root created a new repository worktree file before exact detection and cleanup because the tool call lacked explicit root identity and a pre-effect exact write set.",
    evidenceLinks: [
      "traceability/findings/COORD-002-implicit-default-root-write-effect.md",
      "traceability/evidence/verification/content-addressed-evidence/write-boundary-incident.json",
    ],
    removalCondition: "Install and independently replay one universal tool boundary binding explicit root identity, canonical logical paths, active hierarchical write-set leases and fencing before every repository mutation.",
    deadline: "before-universal-safe-write-effect-or-coordination-readiness-claim",
    affectedSurfaces: ["builder"],
    blockedCapabilities: ["universal-safe-write-effect", "write-coordination-readiness"],
    regression: "explicit-root-exact-write-set-and-default-cwd-confusion-matrix-x3",
    removalVerification: "independent-universal-tool-root-fencing-and-incident-replay",
  }],
  modules: [
    moduleContract({
      id: "architecture-manifest", path: "src/architecture-manifest.ts", realm: "shared",
      layer: "trusted-kernel", owner: "architecture", publicApi: { exportCount: 11, namesSha256: "05dfae06b49721a6599c8e2d25050c26eae9f0eb62ce20cba9116ea68192ad0c" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "cli", path: "src/cli.ts", realm: "runtime", layer: "interface", owner: "interfaces",
      publicApi: { exportCount: 1, namesSha256: "1525fd45588fee6a6ee12bc3b4ebc0b20e524d0142ae3f8481434d9fa3a9210a" },
      dependencies: ["node:fs","node:path","node:url","src/filesystem/self-protection/self-protection-config.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/preflight.ts","src/kernel/root-policy.ts","src/quality-packs/cli.ts","src/runtime/cli-debug.ts","src/runtime/harness-bootstrap.ts","src/shared/source-scan.ts","src/timeline/ledger-primitives.ts","src/timeline/recording-context.ts","src/workflow/harness-commands.ts"],
      executionBoundary: "composition-root", compositionRoot: true, effects: ["process-status"],
      ports: { requires: ["preflight", "quality-cli", "harness-commands"], provides: ["interactive-cli"] },
    }),
    moduleContract({
      id: "timeline-types", path: "src/timeline/timeline-types.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 71, namesSha256: "8b54564475e898ac2d9e96c91c62335704c0cefa43927b5475f999ed2492f09d" },
      dependencies: ["../shared/constants.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/shared/type-guards.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["timeline-types"] },
      authorityFamilies: ["events"],
      authorityIdentifiers: ["TIMELINE_SCHEMA_VERSION", "TIMELINE_REVISION", "TIMELINE_DOMAIN"],
      responsibilities: ["timeline-event-type-vocabulary-and-record-kind-registry"],
    }),
    moduleContract({
      id: "timeline-schema", path: "src/timeline/timeline-schema.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 8, namesSha256: "d51a6f6f74cdcbcdac3ee558457cec4d9353aac2402eb8089e58355cb817837d" },
      dependencies: ["src/kernel/errors.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["timeline-schema"] },
      responsibilities: ["s4-aligned-sql-migration-source-tables-and-projections"],
    }),
    moduleContract({
      id: "timeline-store", path: "src/timeline/timeline-store.ts", realm: "runtime", layer: "infrastructure",
      owner: "evidence-ledger", publicApi: { exportCount: 5, namesSha256: "2980b99f43aee20c301ec322c5fb780400c4751070cccd529bcc76376166c038" },
      dependencies: ["../shared/constants.ts","node:fs","node:sqlite","src/filesystem/database-provenance.ts","src/filesystem/persisted-key.ts","src/filesystem/sqlite-wal.ts","src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/privacy/operational-redaction.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts","src/privacy/secret-files.ts","src/process/fault-policy.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts","src/timeline/ledger-primitives.ts","src/timeline/timeline-config.ts","src/timeline/timeline-schema.ts","src/timeline/timeline-sealing.ts","src/timeline/timeline-types.ts"],
      executionBoundary: "effect-adapter",
      effects: ["filesystem-read", "filesystem-write"],
      ports: { requires: ["timeline-types", "timeline-schema"], provides: ["event-ledger-storage-port"] },
      stateOwners: ["sqlite-database-connection-and-prepared-statement-cache"],
      responsibilities: [
        "durable-append-only-sqlite-event-ledger-behind-typed-port",
        "wal-synchronous-full-chain-verification-and-crash-recovery",
      ],
    }),
    moduleContract({
      id: "timeline-query", path: "src/timeline/timeline-query.ts", realm: "runtime", layer: "application",
      owner: "evidence-ledger", publicApi: { exportCount: 4, namesSha256: "4979003e0ef7089f0fb24de2bdbf5c6274914fb8ba73319e29634f52837754be" },
      dependencies: ["src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/timeline/ledger-primitives.ts"],
      executionBoundary: "pure",
      ports: { requires: ["event-ledger-storage-port"], provides: ["timeline-query"] },
      responsibilities: ["typed-query-by-run-turn-agent-task-time-type-and-edge-traversal"],
    }),
    moduleContract({
      id: "timeline-rollback", path: "src/timeline/rollback.ts", realm: "runtime", layer: "application",
      owner: "evidence-ledger", publicApi: { exportCount: 7, namesSha256: "32c4b9add09aa0f54e7b79037e974c54a9ed05331193fa4af2c81a5c680414bb" },
      dependencies: ["src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/timeline/timeline-types.ts"],
      executionBoundary: "pure",
      ports: { requires: ["event-ledger-storage-port"], provides: ["rollback-controller"] },
      responsibilities: [
        "append-only-rollback-with-inverse-effect-restoration-and-evidence-preservation",
        "irreversible-effect-classification-and-typed-skip-reason",
      ],
    }),
    moduleContract({
      id: "timeline-recorder", path: "src/timeline/timeline-recorder.ts", realm: "runtime", layer: "application",
      owner: "evidence-ledger", publicApi: { exportCount: 19, namesSha256: "9ad364ac7deb9b3182a359c49dd5f8afc415338795ad215f32e5798ae9606935" },
      dependencies: ["../shared/constants.ts","node:util","src/kernel/errors.ts","src/kernel/execution-closure.ts","src/kernel/integrity.ts","src/timeline/ledger-primitives.ts","src/timeline/recording-context.ts","src/timeline/rollback.ts","src/timeline/timeline-query.ts","src/timeline/timeline-types.ts"],
      executionBoundary: "pure",
      ports: { requires: ["event-ledger-storage-port", "execution-closure", "timeline-query", "rollback-controller"], provides: ["timeline-recorder"] },
      responsibilities: [
        "unified-runtime-api-wrapping-closure-and-durable-store",
        "standalone-event-recording-for-lifecycle-token-resource-and-effect-types",
      ],
    }),
    moduleContract({
      id: "timeline-ledger-dig", path: "src/timeline/ledger-dig.ts", realm: "runtime", layer: "infrastructure",
      owner: "evidence-ledger", publicApi: { exportCount: 37, namesSha256: "3364890231483ab3d6d9c6bd885126f1ec9a84e9357ee593edad1c29221ed280" },
      dependencies: ["../shared/constants.ts","node:fs","node:path","node:sqlite","src/kernel/errors.ts","src/timeline/timeline-types.ts"],
      executionBoundary: "effect-adapter",
      effects: ["filesystem-read"],
      ports: { requires: [], provides: ["timeline-ledger-dig"] },
      responsibilities: [
        "read-only-ledger-dig-behind-the-trace-cli-own-connection-selects-only",
      ],
    }),
    moduleContract({
      id: "ledger-primitives", path: "src/timeline/ledger-primitives.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 21, namesSha256: "3220d8059b31e453faa9a985ba473d77c95266b99eda8acb643d5418320409e0" },
      dependencies: ["node:util","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ledger-canonical.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts"],
    }),
    moduleContract({
      id: "effect-boundary-write-lease", path: "src/modules/effect-boundary/domain/write-lease.ts",
      realm: "shared", layer: "domain", owner: "effect-boundary",
      publicApi: { exportCount: 11, namesSha256: "a544fbed8c8485c571e56872297adc223a3fef944a7e8781aa7b66f3f1b98b11" },
      dependencies: ["src/filesystem/path-boundary.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/safe-structural.ts"],
      ports: { requires: [], provides: ["exact-logical-write-lease"] },
      responsibilities: ["nonserializable-root-bound-exact-pre-effect-write-lease-authority"],
    }),
    moduleContract({
      id: "effect-boundary-index", path: "src/modules/effect-boundary/index.ts",
      realm: "shared", layer: "domain", owner: "effect-boundary",
      publicApi: { exportCount: 11, namesSha256: "a544fbed8c8485c571e56872297adc223a3fef944a7e8781aa7b66f3f1b98b11" },
      dependencies: ["src/modules/effect-boundary/domain/write-lease.ts"],
      responsibilities: ["exact-write-lease-public-api-projection"],
    }),
    moduleContract({
      id: "durable-filesystem-contracts", path: "src/filesystem/durable-filesystem-contracts.ts",
      realm: "shared", layer: "domain", owner: "filesystem-infrastructure",
      publicApi: { exportCount: 6, namesSha256: "7635199869fa7904d8b5fbdca916f488e53b2a876e5faa09dac3a2d9afd113f1" },
      dependencies: [],
      responsibilities: ["opaque-durable-filesystem-capability-and-result-contracts"],
    }),
    moduleContract({
      id: "durable-filesystem", path: "src/filesystem/durable-filesystem.ts", realm: "shared",
      layer: "infrastructure", owner: "filesystem-infrastructure",
      publicApi: { exportCount: 11, namesSha256: "740aa44bde97aa97ed8d063059216d1bc885a4921230bf81b06bce22f33f9ac2" },
      dependencies: ["src/filesystem/durable-filesystem-internal.ts"],
      executionBoundary: "effect-adapter",
      effects: ["child-process", "cryptography", "filesystem-read", "filesystem-write", "process-status"],
      ports: { requires: ["admitted-node-runtime"], provides: ["durable-filesystem"] },
      responsibilities: ["sole-public-opaque-capability-bound-durable-filesystem-facade"],
    }),
    moduleContract({
      id: "durable-filesystem-internal", path: "src/filesystem/durable-filesystem-internal.ts",
      realm: "shared", layer: "infrastructure", owner: "filesystem-infrastructure",
      publicApi: { exportCount: 8, namesSha256: "5832a799295dfb7c11ec16233242d0e23f8f32543c31581597e52282c5800211" },
      dependencies: ["node:async_hooks","node:fs","node:path","node:url","src/filesystem/link-containment.ts","src/filesystem/pinned-path-internal.ts","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/process/pinned-process-internal.ts","src/runtime/admitted-node-runtime.ts","src/shared/type-guards.ts"],
      executionBoundary: "effect-adapter",
      effects: ["child-process", "cryptography", "filesystem-read", "filesystem-write", "process-status"],
      ports: { requires: ["admitted-node-runtime"], provides: ["durable-filesystem-internal"] },
      configPaths: ["filesystemInfrastructure"],
      stateOwners: ["callback-scoped-held-directory-capabilities"],
      responsibilities: [
        "private-terminal-explicit-intent-runtime-gated-file-mutation",
        "private-descriptor-worker-composition-and-capability-lifetime",
        "non-admitting-internal-filesystem-mechanism-test-scope",
      ],
    }),
    moduleContract({
      id: "pinned-path-internal", path: "src/filesystem/pinned-path-internal.ts", realm: "shared",
      layer: "infrastructure", owner: "filesystem-infrastructure",
      publicApi: { exportCount: 17, namesSha256: "555a5610c7d596233bf728e7dcb5a204111ffe01207baab625ecfa0b9a2e0c92" },
      dependencies: ["node:fs","node:path","src/filesystem/linux-path.ts","src/filesystem/path-boundary.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts"],
      executionBoundary: "read-adapter", effects: ["filesystem-read"],
      ports: { requires: ["linux-mount-inspection"], provides: ["pinned-path-traversal-internal"] },
      configPaths: ["verification.safeRepositoryRead.procFileDescriptorRoot"],
      responsibilities: ["shared-linux-descriptor-held-path-traversal-and-identity-recheck"],
    }),
    moduleContract({
      id: "private-directory-create-worker", path: "src/filesystem/private-directory-create-worker.mjs",
      realm: "shared", layer: "infrastructure", owner: "filesystem-infrastructure",
      publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      dependencies: ["node:fs", "node:process"], executionBoundary: "effect-adapter",
      effects: ["filesystem-read", "filesystem-write", "process-status"],
      ports: { requires: ["durable-filesystem-internal"], provides: [] },
      configPaths: ["filesystemInfrastructure.privateState.directoryWorker"],
      responsibilities: ["non-facing-empty-environment-exact-0700-private-directory-worker"],
    }),
    moduleContract({
      id: "pinned-process-internal", path: "src/process/pinned-process-internal.ts", realm: "shared",
      layer: "infrastructure", owner: "process-infrastructure",
      publicApi: { exportCount: 8, namesSha256: "78880c0530510075d3d40c519bce21c5850cb4ad13f2f7b48c5e98bee7e5e2c2" },
      dependencies: ["node:child_process","node:fs","src/filesystem/pinned-path-internal.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts"],
      executionBoundary: "effect-adapter",
      effects: ["child-process","filesystem-read"],
      ports: { requires: ["pinned-path-traversal-internal"], provides: ["pinned-process-internal"] },
      stateOwners: ["callback-scoped-pinned-process-capabilities"],
      responsibilities: [
        "sole-pinned-process-profile-identity-compiler-and-verifier",
        "sole-internal-descriptor-mapped-closed-environment-bounded-pinned-process-execution",
      ],
    }),
    moduleContract({
      id: "repository-path-contracts", path: "src/repository-path/contracts.ts", realm: "shared", layer: "domain",
      owner: "repository-path-foundation",
      publicApi: { exportCount: 25, namesSha256: "90172539956e3c7f557b3c97a8ea0e34f9f26f2966f4addb5281aadcad690696" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/product-identity.ts"],
      responsibilities: ["repository-path-contract-authority-not-filesystem-or-runtime-portability-admission"],
    }),
    moduleContract({
      id: "repository-path-index", path: "src/repository-path/index.ts", realm: "shared", layer: "domain",
      owner: "repository-path-foundation",
      publicApi: { exportCount: 27, namesSha256: "e1f064ec76cf6ecd88a2d3e14989423fe04ba7f40224784a01102c0e5799e506" },
      dependencies: ["src/repository-path/contracts.ts", "src/repository-path/logical.ts", "src/repository-path/set.ts"],
      responsibilities: ["repository-path-public-api-projection-not-filesystem-or-runtime-portability-admission"],
    }),
    moduleContract({
      id: "repository-path-logical", path: "src/repository-path/logical.ts", realm: "shared", layer: "domain",
      owner: "repository-path-foundation",
      publicApi: { exportCount: 8, namesSha256: "eef90c4d1ffa621bff9e970de6bc392617455836a1767cbbfd3d2fef5d293bae" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/safe-structural.ts","src/repository-path/contracts.ts","src/repository-path/unicode-case-fold.generated.ts","src/runtime/runtime-capabilities.ts"],
      executionBoundary: "read-adapter", stateOwners: ["repository-path-runtime-capability-check"],
      responsibilities: ["logical-repository-path-normalization-not-filesystem-or-runtime-portability-admission"],
    }),
    moduleContract({
      id: "repository-path-set", path: "src/repository-path/set.ts", realm: "shared", layer: "domain",
      owner: "repository-path-foundation",
      publicApi: { exportCount: 2, namesSha256: "56408cba0a538aba3676db964df300a24e1d25f1aef2ae015d7f21d2cba0aa74" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ordered.ts","src/kernel/safe-structural.ts","src/repository-path/contracts.ts","src/repository-path/logical.ts"],
      responsibilities: ["repository-path-set-relation-authority-not-filesystem-or-runtime-portability-admission"],
    }),
    moduleContract({
      id: "repository-path-unicode-case-fold-generated", path: "src/repository-path/unicode-case-fold.generated.ts",
      realm: "shared", layer: "trusted-kernel", owner: "repository-path-foundation",
      publicApi: { exportCount: 9, namesSha256: "68723fab573996f0eb0ebc2183246f4b880488076521237376cfd1efcc2e5970" },
      dependencies: ["src/kernel/integrity.ts"],
      responsibilities: ["generated-pinned-unicode-case-fold-authority-not-runtime-capability-admission"],
    }),
    moduleContract({
      id: "workflow-test-result-collector", path: "src/workflow/test-result-collector.ts",
      realm: "runtime", layer: "infrastructure", owner: "verification-workflow",
      publicApi: { exportCount: 48, namesSha256: "e58fbdd41a3f43e7e85d13d71626a5d360892037aaebbfada3695ee099cf5509" },
      dependencies: ["node:fs","node:os","node:path","node:test","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/privacy/redaction-engine.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts","src/workflow/test-inventory-binding.ts","src/workflow/workflow-config.ts","zod"],
      executionBoundary: "effect-adapter", effects: ["filesystem-read", "filesystem-write", "process-status"],
      ports: { requires: [], provides: ["test-result-collection"] },
      responsibilities: ["structured-test-result-collection-replacing-grep-and-restart"],
    }),
    moduleContract({
      id: "workflow-test-inventory-binding", path: "src/workflow/test-inventory-binding.ts",
      realm: "runtime", layer: "infrastructure", owner: "verification-workflow",
      publicApi: { exportCount: 7, namesSha256: "ed12a71e1e826aa61912e5262bf8139704da3b894c8dafe355b701c0b5604cbc" },
      dependencies: ["node:fs","node:path","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/verification-paths.ts","src/workflow/workflow-config.ts"],
      executionBoundary: "effect-adapter", effects: ["filesystem-read"],
      ports: { requires: [], provides: ["test-inventory-binding"] },
      responsibilities: ["src-side-consumer-of-the-generated-test-inventory-binding-test-runs-to-pinned-identities"],
    }),
    moduleContract({
      id: "workflow-module-registrar", path: "src/workflow/module-registrar.ts",
      realm: "shared", layer: "domain", owner: "verification-workflow",
      publicApi: { exportCount: 11, namesSha256: "7b1ca182019040a2e0eb607770d70a64ba3515258c7cca34b36240c62f49148c" },
      dependencies: ["node:fs","node:path","scripts/verification/architecture.ts","scripts/verification/static-source.ts","src/architecture-manifest.ts","src/filesystem/atomic-write.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/shared/path-utils.ts","src/shared/source-extensions.ts","src/shared/source-scan.ts","src/workflow/command-result.ts","src/workflow/module-contract-blocks.ts"],
      executionBoundary: "effect-adapter", effects: ["filesystem-read", "filesystem-write"],
      ports: { requires: ["architecture-analysis"], provides: ["module-registration"] },
      responsibilities: ["deterministic-module-registration-replacing-manual-manifest-maintenance"],
    }),
    moduleContract({
      id: "workflow-auto-generator", path: "src/workflow/auto-generator.ts",
      realm: "shared", layer: "domain", owner: "verification-workflow",
      publicApi: { exportCount: 13, namesSha256: "e2c2569c19177c3914bbee350ec56003b766731fa8c69586c78c42452da67036" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/kernel/verification-paths.ts","src/shared/debug/debug-system.ts","src/workflow/command-result.ts","src/workflow/hash-binding-registry.ts"],
      executionBoundary: "effect-adapter", effects: ["filesystem-read", "filesystem-write"],
      ports: { requires: [], provides: ["auto-generation"] },
      responsibilities: ["automated-binding-and-schema-regeneration-replacing-manual-checks"],
    }),
    moduleContract({
      id: "workflow-harness-commands", path: "src/workflow/harness-commands.ts",
      realm: "runtime", layer: "interface", owner: "verification-workflow",
      publicApi: { exportCount: 52, namesSha256: "53136b5e90a206afeee6297257e67b4253e9782b0dbad4debb7e092051678c67" },
      dependencies: ["node:child_process","node:fs","node:path","node:sqlite","src/evaluation/cli.ts","src/extensions/extension-manifest.ts","src/filesystem/atomic-write.ts","src/filesystem/journaled-commit.ts","src/git/declared-deletions.ts","src/git/index-baseline.ts","src/git/repository-ownership.ts","src/git/tree-reader.ts","src/git/worktree-port.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/test-surface-manifest.ts","src/kernel/verification-paths.ts","src/performance/benchmark-cli.ts","src/performance/configured-performance.ts","src/performance/diagnostic-cli.ts","src/performance/metrics-collector.ts","src/runtime/cli-debug.ts","src/runtime/harness-bootstrap.ts","src/shared/source-scan.ts","src/timeline/recording-context.ts","src/timeline/rollback.ts","src/timeline/timeline-store.ts","src/workflow/auto-generator.ts","src/workflow/checkout-setup.ts","src/workflow/command-result.ts","src/workflow/evidence-store.ts","src/workflow/flake-cli.ts","src/workflow/format-command.ts","src/workflow/hash-binding-registry.ts","src/workflow/module-registrar.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/profile.ts","src/workflow/promotion/promote-cli.ts","src/workflow/record-links.ts","src/workflow/repository-registry.ts","src/workflow/resource-lock.ts","src/workflow/slot-cli.ts","src/workflow/test-result-collector.ts","src/workflow/workflow-config.ts","src/workflow/workspace-cli.ts"],
      executionBoundary: "composition-root", compositionRoot: true,
      effects: ["child-process", "filesystem-read", "filesystem-write", "git", "process-status"],
      ports: { requires: ["test-result-collection", "module-registration", "auto-generation", "resource-locking"], provides: ["harness-commands"] },
      responsibilities: ["built-in-harness-workflow-commands-replacing-multi-step-scripts"],
    }),
    moduleContract({
      id: "workflow-resource-lock", path: "src/workflow/resource-lock.ts",
      realm: "runtime", layer: "domain", owner: "verification-workflow",
      publicApi: { exportCount: 12, namesSha256: "f9972be2371bf3e411e63e6502e50281042e3642a3452544556592bfe51c86e4" },
      dependencies: ["node:fs","node:path","src/filesystem/file-lock.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/workflow/workflow-config.ts"],
      executionBoundary: "effect-adapter", effects: ["filesystem-read", "filesystem-write", "process-status"],
      ports: { requires: [], provides: ["resource-locking"] },
      responsibilities: ["file-based-resource-locking-serializing-shared-resource-access"],
    }),
    moduleContract({
      id: "workflow-workspace-contracts", path: "src/workflow/workspace-contracts.ts",
      realm: "shared", layer: "domain", owner: "verification-workflow",
      publicApi: { exportCount: 38, namesSha256: "223de89ca100349cbe300d82d5e53e76fc9f6587c4b8a281a5b089baa3e2cf05" },
      dependencies: ["src/filesystem/path-boundary.ts","src/git/git-port.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/workflow/hash-binding-registry.ts","zod"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["workspace-contracts"] },
      responsibilities: ["closed-schema-versioned-workspace-lease-record-validation-conflict-and-merge-receipt-contracts-with-state-machine-never-leasable-policy-and-write-set-arithmetic"],
    }),
    moduleContract({
      id: "workflow-timeline-shard", path: "src/workflow/timeline-shard.ts",
      realm: "runtime", layer: "infrastructure", owner: "verification-workflow",
      publicApi: { exportCount: 8, namesSha256: "eca4c9673a0a5e02684053bc291881275134f9d443258884f6c6e164b2579539" },
      dependencies: ["node:path","src/filesystem/private-state.ts","src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ledger-canonical.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts","src/timeline/ledger-primitives.ts","src/timeline/timeline-store.ts","src/timeline/timeline-types.ts"],
      executionBoundary: "effect-adapter", effects: ["filesystem-read", "filesystem-write"],
      ports: { requires: ["event-ledger-storage-port"], provides: ["workspace-timeline-shard"] },
      responsibilities: ["per-workspace-sqlite-timeline-shard-with-idempotent-event-identity-canonical-import-on-merge"],
    }),
    moduleContract({
      id: "workflow-workspace-manager", path: "src/workflow/workspace-manager.ts",
      realm: "runtime", layer: "application", owner: "verification-workflow",
      publicApi: { exportCount: 16, namesSha256: "1d49236671cd880fc0f8366a77fb3c321e9245f8942380706d0c920adecf0169" },
      dependencies: ["node:fs","node:path","src/agents/agent-config.ts","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/git/ignored-copies.ts","src/git/repository-ownership.ts","src/git/working-copy.ts","src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/modules/effect-boundary/domain/write-lease.ts","src/shared/budget-verdict.ts","src/shared/debug/debug-system.ts","src/shared/run-history.ts","src/timeline/timeline-store.ts","src/workflow/checkout-setup.ts","src/workflow/failure-owners.ts","src/workflow/hash-binding-registry.ts","src/workflow/record-links.ts","src/workflow/repository-registry.ts","src/workflow/resource-lock.ts","src/workflow/timeline-shard.ts","src/workflow/tree-landing.ts","src/workflow/workflow-config.ts","src/workflow/workspace-contracts.ts","src/workflow/workspace-registry.ts"],
      executionBoundary: "effect-adapter",
      effects: ["child-process", "filesystem-read", "filesystem-write", "git", "process-status"],
      ports: { requires: ["worktree-port", "resource-locking", "workspace-contracts", "workspace-timeline-shard", "agent-config"], provides: ["workspace-manager"] },
      configPaths: ["workspaceIsolation"],
      stateOwners: ["workspace-record-store"],
      responsibilities: ["isolated-agent-workspace-lifecycle-admit-create-validate-serialized-canonical-merge-abort-quarantine-rollback-and-ttl-sweep"],
    }),
    moduleContract({
      id: "workflow-workspace-cli", path: "src/workflow/workspace-cli.ts",
      realm: "runtime", layer: "interface", owner: "verification-workflow",
      publicApi: { exportCount: 2, namesSha256: "fbeef4ea90ca3cd912e85b4caf6a2ab313fd557e96e6f8ee67072a4fe80aedc5" },
      dependencies: ["guardian/build.ts","node:url","src/git/repository-ownership.ts","src/git/worktree-port.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/process/instrument-lock.ts","src/workflow/checkout-setup.ts","src/workflow/command-result.ts","src/workflow/repository-registry.ts","src/workflow/test-result-collector.ts","src/workflow/workflow-config.ts","src/workflow/workspace-manager.ts"],
      executionBoundary: "composition-root", compositionRoot: true,
      ports: { requires: ["workspace-manager", "worktree-port", "harness-commands"], provides: ["workspace-cli"] },
      responsibilities: ["harness-workspace-subcommand-composition-root-for-create-validate-merge-abort-list-and-status"],
    }),
    moduleContract({
      id: "admitted-node-runtime", path: "src/runtime/admitted-node-runtime.ts",
      realm: "shared", layer: "infrastructure", owner: "runtime-infrastructure",
      publicApi: { exportCount: 11, namesSha256: "83cb3a38d4498b28750c7f3d068944fd816083b98bb8dc2f78613129f8944d0b" },
      dependencies: ["node:async_hooks","node:process","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/process/pinned-process-internal.ts","src/shared/type-guards.ts"],
      executionBoundary: "effect-adapter",
      effects: ["child-process", "cryptography", "filesystem-read", "process-status"],
      ports: { requires: ["pinned-process-internal"], provides: ["admitted-node-runtime"] },
      configPaths: ["filesystemInfrastructure.runtimeLaunch"],
      stateOwners: ["callback-scoped-admitted-node-runtime-capability"],
      responsibilities: [
        "central-configured-admitted-node-runtime-port-provider-not-caller-supplied",
        "modeled-principal-write-isolation-binding-and-capability-enforcement",
        "honest-configured-internal-admission-pending-external-verification",
      ],
    }),
    moduleContract({
      id: "runtime-sse-parser", path: "src/runtime/sse-parser.ts",
      realm: "runtime", layer: "domain", owner: "providers-and-protocol",
      publicApi: { exportCount: 10, namesSha256: "67841d4e410bcdc949246817da245ad1292f8a218c9668757dd196e24744088e" },
      dependencies: ["src/kernel/errors.ts","src/kernel/root-policy.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["sse-parser"] },
    }),
    moduleContract({
      id: "runtime-provider-adapter", path: "src/runtime/provider-adapter.ts",
      realm: "runtime", layer: "infrastructure", owner: "providers-and-protocol",
      publicApi: { exportCount: 16, namesSha256: "7785257af6aba894cd41b77df1d0d7c1e6a6a5f7183c4ce604f9320088944ffb" },
      dependencies: ["src/kernel/integrity.ts","src/runtime/response-turn.ts","src/runtime/runtime-config.ts","src/shared/abort-signals.ts","src/shared/llm/index.ts","src/shared/llm/response-transcript.ts","src/shared/llm/responses.ts","src/shared/outbound-policy.ts"],
      executionBoundary: "effect-adapter",
      effects: ["network", "process-control"],
      ports: { requires: ["sse-parser"], provides: ["provider-adapter"] },
    }),
    moduleContract({
      id: "runtime-tool-registry", path: "src/runtime/tool-registry.ts",
      realm: "runtime", layer: "infrastructure", owner: "providers-and-protocol",
      publicApi: { exportCount: 8, namesSha256: "b59ebe28c36b6da64ebe30a51b5ca39b58c0d21897b5971d9133ec1017e8cb68" },
      dependencies: ["node:fs","node:path","src/filesystem/path-boundary.ts","src/intelligence/file-slice.ts","src/intelligence/quick-view.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/privacy/file-viewer.ts","src/privacy/privacy-policy.ts"],
      executionBoundary: "effect-adapter",
      effects: ["filesystem-read"],
      ports: { requires: ["provider-adapter"], provides: ["tool-registry"] },
    }),
    moduleContract({
      id: "runtime-tool-args", path: "src/runtime/tool-args.ts",
      realm: "runtime", layer: "infrastructure", owner: "providers-and-protocol",
      publicApi: { exportCount: 6, namesSha256: "a2891ff1b21130516351a63b58ecfa53805422063f60f33e639a498250f29216" },
      dependencies: ["src/kernel/errors.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["tool-args"] },
    }),
    moduleContract({
      id: "safety-tool-call-gate", path: "src/safety/tool-call-gate.ts",
      realm: "safety", layer: "application", owner: "providers-and-protocol",
      publicApi: { exportCount: 11, namesSha256: "39ea4dbfe5fb32981851336db7d9d53221ce40bb8edca283cc9b48f46044694f" },
      dependencies: ["src/kernel/integrity.ts","src/shared/type-guards.ts"],
      executionBoundary: "pure",
      effects: ["cryptography"],
      ports: { requires: ["provider-adapter"], provides: ["tool-call-gate"] },
    }),
    moduleContract({
      id: "runtime-interactive-session", path: "src/runtime/interactive-session.ts",
      realm: "runtime", layer: "application", owner: "providers-and-protocol",
      publicApi: { exportCount: 7, namesSha256: "ce104c5f609e9c289aefead66b6442b8a31b3143c6b22bd91e49be3d48d7a1c1" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/runtime/governed-tool-dispatch.ts","src/runtime/response-turn.ts","src/runtime/runtime-config.ts","src/safety/tool-call-gate.ts","src/shared/debug/debug-system.ts","src/shared/llm/errors.ts","src/shared/llm/response-transcript.ts","src/shared/llm/responses-disposition.ts","src/shared/llm/responses.ts"],
      executionBoundary: "pure",
      effects: ["cryptography"],
      ports: { requires: ["provider-adapter", "tool-registry"], provides: ["interactive-session"] },
    }),
    moduleContract({
      id: "runtime-config", path: "src/runtime/runtime-config.ts",
      realm: "runtime", layer: "domain", owner: "configuration",
      publicApi: { exportCount: 22, namesSha256: "1268591ed9a231eecfb4a32c7a7c0adc838f5f86dfa9b6c067d13abfa1e57ce7" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["configuration-contract"], provides: ["runtime-config"] },
    }),
    moduleContract({
      id: "runtime-intelligence-tools", path: "src/runtime/intelligence-tools.ts",
      realm: "runtime", layer: "application", owner: "code-intelligence",
      publicApi: { exportCount: 2, namesSha256: "ef0b8cd3cb5a86a736a1a35a2646493c66a74935cdbee1f0805074271f6e935e" },
      dependencies: ["src/intelligence/dependency-graph.ts","src/intelligence/intelligence-types.ts","src/intelligence/repository-map.ts","src/intelligence/repository-stat-scan.ts","src/intelligence/reuse-discovery.ts","src/intelligence/symbol-search.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/runtime/runtime-config.ts","src/runtime/tool-args.ts"],
      executionBoundary: "read-adapter",
      effects: ["filesystem-read"],
      ports: { requires: ["repository-map","symbol-search","reuse-discovery","dependency-graph"], provides: ["intelligence-tools"] },
    }),
    moduleContract({
      id: "runtime-quality-tools", path: "src/runtime/quality-tools.ts",
      realm: "runtime", layer: "application", owner: "quality-packs",
      publicApi: { exportCount: 4, namesSha256: "4c54cc7438dab3a857338bbb9e9eb2d43d9477c242d8c10c6aa3d1b044de473a" },
      dependencies: ["node:fs","node:path","src/filesystem/path-boundary.ts","src/intelligence/repository-map.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/quality-packs/quality-pack.ts","src/quality-packs/typescript-pack.ts","src/runtime/runtime-config.ts","src/shared/debug/debug-system.ts"],
      executionBoundary: "read-adapter",
      effects: ["filesystem-read"],
      ports: { requires: ["quality-pack","typescript-quality-pack","repository-map"], provides: ["quality-tools"] },
    }),
    moduleContract({
      id: "runtime-git-tools", path: "src/runtime/git-tools.ts",
      realm: "runtime", layer: "application", owner: "workspace-git",
      publicApi: { exportCount: 2, namesSha256: "6e9e52c49c78bdf4c4c1f866dbe4e9f8d01e22ca74cf6a8909fad12956201eee" },
      dependencies: ["node:path","src/git/git-adapter.ts","src/git/git-config.ts","src/git/git-port.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/privacy/redaction-engine.ts","src/runtime/runtime-config.ts","src/runtime/tool-args.ts","src/tools/tool-manifest.ts"],
      executionBoundary: "effect-adapter",
      effects: ["child-process","git"],
      configPaths: ["workspaceGit"],
      ports: { requires: ["git-adapter"], provides: ["git-tools"] },
    }),
    moduleContract({
      id: "runtime-agent-tools", path: "src/runtime/agent-tools.ts",
      realm: "runtime", layer: "application", owner: "agents",
      publicApi: { exportCount: 2, namesSha256: "435c16822a773be5d94d4cad791dd2f36477575ec0a8d287dc29ad07baf86730" },
      dependencies: ["src/agents/agent-config.ts","src/agents/agent-runtime.ts","src/agents/agent-state.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/runtime/runtime-config.ts","src/runtime/tool-args.ts","src/shared/best-effort.ts"],
      ports: { requires: ["agent-config","agent-runtime","agent-state"], provides: ["agent-tools"] },
    }),
    moduleContract({
      id: "runtime-orchestrator-tools", path: "src/runtime/orchestrator-tools.ts",
      realm: "runtime", layer: "application", owner: "agents",
      publicApi: { exportCount: 2, namesSha256: "2825e1df8d5014ed3af4f291f6771175d1430a4f3b313ac9f209ea3039ee495c" },
      dependencies: ["src/agents/agent-runtime.ts","src/agents/orchestrator.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/runtime/runtime-config.ts","src/runtime/tool-args.ts","src/shared/best-effort.ts"],
      ports: { requires: ["agent-config","orchestrator"], provides: ["orchestrator-tools"] },
    }),
    moduleContract({
      id: "runtime-extension-tools", path: "src/runtime/extension-tools.ts",
      realm: "runtime", layer: "application", owner: "extensions",
      publicApi: { exportCount: 2, namesSha256: "6c2b38b04e56aadc01e6ea9b52d2fc9e78f0aebe18d7d8589f21ea28c422b8aa" },
      dependencies: ["src/extensions/extension-manifest.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["extension-manifest"], provides: ["extension-tools"] },
    }),
    moduleContract({
      id: "tools-tool-manifest", path: "src/tools/tool-manifest.ts", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 13, namesSha256: "7815484de658753d0617550168eb3ed9d44fca9de713dd66c972651f2ef805cc" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["tool-manifest"] },
    }),
    moduleContract({
      id: "tools-tool-adapter", path: "src/tools/tool-adapter.ts", realm: "runtime", layer: "infrastructure",
      owner: "tools", publicApi: { exportCount: 11, namesSha256: "e0303eacb21c80d274066d7fdc93f691cec8f4370d2efad5ac2c1a01e765c73b" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/abort-signals.ts","src/shared/best-effort.ts","src/tools/tool-manifest.ts"],
      executionBoundary: "effect-adapter",
      effects: ["process-control"],
      ports: { requires: ["tool-manifest"], provides: ["tool-adapter"] },
    }),
    moduleContract({
      id: "tools-built-in-tools", path: "src/tools/built-in-tools.ts", realm: "runtime", layer: "infrastructure",
      owner: "tools", publicApi: { exportCount: 25, namesSha256: "2a2add1a338c318876e726ff75a8cd578620a248ba319163c2dbf14437db7ce9" },
      dependencies: ["node:child_process","node:path","src/kernel/errors.ts","src/kernel/integrity.ts","src/process/environment-projection.ts","src/process/fault-policy.ts","src/runtime/tool-args.ts","src/shared/best-effort.ts","src/tools/built-in-tool-manifest.ts"],
      executionBoundary: "effect-adapter",
      effects: ["child-process", "cryptography", "environment-access", "git", "network", "process-control"],
      ports: { requires: ["tool-manifest", "tool-adapter"], provides: ["built-in-tools"] },
    }),
    moduleContract({
      id: "intelligence-types", path: "src/intelligence/intelligence-types.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 29, namesSha256: "80797881915223b3f1cc18f40a35d2181b7abc981a10b01e0816cdf73b1f53aa" },
      dependencies: ["src/intelligence/intelligence-config.ts","src/intelligence/language-registry.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/shared/type-guards.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["intelligence-types"] },
    }),
    moduleContract({
      id: "intelligence-symbol-extractor", path: "src/intelligence/symbol-extractor.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 2, namesSha256: "bd5f66e7d8b19e9d7e939cd42955525341f55b5857ed2f1e23372262a6b307c2" },
      dependencies: ["src/intelligence/intelligence-config.ts","src/intelligence/intelligence-types.ts","src/intelligence/js-tokenizer.ts","src/intelligence/language-registry.ts","src/intelligence/tree-sitter-extractor.ts","src/kernel/errors.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["intelligence-types"], provides: ["symbol-extractor"] },
    }),
    moduleContract({
      id: "intelligence-symbol-search", path: "src/intelligence/symbol-search.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 19, namesSha256: "122105b15735fd1721ef9f481099d53d2ed73d60499523945934f465aa249c62" },
      dependencies: ["src/intelligence/action-affinity.ts","src/intelligence/intelligence-config.ts","src/kernel/errors.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["intelligence-types"], provides: ["symbol-search"] },
    }),
    moduleContract({
      id: "intelligence-dependency-graph", path: "src/intelligence/dependency-graph.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 9, namesSha256: "a21b7ace9627aa5b0c5eed2f3b5ba8e48a167f8e9edc7af6a6f3cee4ffe7f65a" },
      dependencies: ["src/intelligence/intelligence-config.ts","src/intelligence/language-registry.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["intelligence-types"], provides: ["dependency-graph"] },
    }),
    moduleContract({
      id: "intelligence-data-flow", path: "src/intelligence/data-flow.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 7, namesSha256: "3d9840bc3d4764eee5c75706ce87f6c01aa62b0ddb7ffeea504ceff8eca33817" },
      dependencies: ["src/intelligence/intelligence-config.ts","src/intelligence/js-tokenizer.ts","src/intelligence/symbol-search.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["intelligence-types", "symbol-extractor", "symbol-search"], provides: ["data-flow"] },
    }),
    moduleContract({
      id: "intelligence-reuse-discovery", path: "src/intelligence/reuse-discovery.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 6, namesSha256: "3bc43e606136c3890d5e88b2aac10b84323194fff4708a8e34bf430cf26ab74a" },
      dependencies: ["src/intelligence/symbol-search.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["intelligence-types", "symbol-search"], provides: ["reuse-discovery"] },
    }),
    moduleContract({
      id: "intelligence-repository-map", path: "src/intelligence/repository-map.ts", realm: "runtime", layer: "infrastructure",
      owner: "code-intelligence", publicApi: { exportCount: 10, namesSha256: "a4c012983a1c1bb7f0661fb26df4ddf7a0b3e2b331c1bf294c05f17f4f70585d" },
      dependencies: ["node:fs","node:path","src/filesystem/link-containment.ts","src/filesystem/path-boundary.ts","src/intelligence/intelligence-config.ts","src/intelligence/intelligence-types.ts","src/intelligence/language-registry.ts","src/intelligence/process-farm.ts","src/intelligence/repository-stat-scan.ts","src/intelligence/symbol-extractor.ts","src/intelligence/tree-sitter-backend.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/debug/debug-system.ts"],
      executionBoundary: "effect-adapter",
      effects: ["filesystem-read"],
      ports: { requires: ["intelligence-types", "symbol-extractor"], provides: ["repository-map"] },
    }),
    moduleContract({
      id: "candidate-format-verification", path: "scripts/verification/candidate-format.ts", realm: "builder",
      layer: "verification", owner: "verification-foundation",
      publicApi: { exportCount: 11, namesSha256: "629cb50e252c268492b9533a6a60826c9a052fc53d4fb02965cc1268cf4c73f3" },
      dependencies: ["node:path","node:util","src/filesystem/path-boundary.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts"],
      executionBoundary: "verification", ports: { requires: [], provides: ["candidate-format-analysis"] },
      configPaths: ["verification.candidateFormat"],
      responsibilities: ["canonical-candidate-path-text-binary-and-exact-source-format-policy"],
    }),
    moduleContract({
      id: "official-fragment-manifest-verification", path: "scripts/verification/official-fragment-manifest.ts",
      realm: "builder", layer: "verification", owner: "traceability",
      publicApi: { exportCount: 3, namesSha256: "0f0eaa9b9addde3f091d19800bed96532c5335bbf3717165180f885772e9c06a" },
      dependencies: ["src/kernel/json-integrity.ts","src/kernel/product-identity.ts","zod"], executionBoundary: "verification",
      ports: { requires: [], provides: ["official-fragment-manifest-contract"] },
      responsibilities: ["official-fragment-manifest-schema-and-duplicate-key-safe-parsing"],
    }),
    moduleContract({
      id: "repository-path-unicode-generation", path: "scripts/generation/repository-path-unicode.ts",
      realm: "builder", layer: "verification", owner: "repository-path-foundation",
      publicApi: { exportCount: 14, namesSha256: "c2b7d2b9f4803f5223229cca85e0e1375f79a44e745df80eff965fe20ca1de3e" },
      dependencies: ["node:fs","node:path","node:url","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/runtime/cli-debug.ts","zod"],
      executionBoundary: "composition-root", compositionRoot: true, effects: ["filesystem-read"],
      responsibilities: ["repository-path-unicode-authority-derivation-command"],
    }),
    moduleContract({
      id: "test-inventory", path: "scripts/test-inventory.ts", realm: "builder", layer: "verification",
      owner: "verification", publicApi: { exportCount: 22, namesSha256: "c8a47a2bc269ca6e98c733c10cb28f37494920883b7276b01a50f7b673b0e625" },
      dependencies: ["@babel/parser","node:child_process","node:fs","node:path","node:url","scripts/verification/safe-repository-reader.ts","scripts/verification/test-surface.ts","src/filesystem/journaled-commit.ts","src/filesystem/path-boundary.ts","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/kernel/ordered.ts","src/kernel/root-policy.ts","src/kernel/verification-paths.ts","src/quality-packs/prevention/ast-helpers.ts","src/runtime/cli-debug.ts","src/shared/source-scan.ts","zod"],
      executionBoundary: "composition-root", compositionRoot: true,
      effects: ["filesystem-read", "filesystem-write"],
      ports: { requires: [], provides: ["canonical-test-inventory-generation-and-validation"] },
      responsibilities: ["canonical-test-inventory-generation-validation-and-transaction-recovery"],
    }),
    moduleContract({
      id: "architecture-verification", path: "scripts/verification/architecture.ts", realm: "builder",
      layer: "verification", owner: "verification", publicApi: { exportCount: 7, namesSha256: "43bbf739173ca2de42b22f81bd2817c9b76e098e492c6399837643694b0acdb2" },
      dependencies: ["node:path","scripts/verification/effect-surface.ts","scripts/verification/filesystem-cache.ts","scripts/verification/static-source.ts","src/architecture-manifest.ts","src/kernel/integrity.ts","src/kernel/ordered.ts","src/quality-packs/prevention/ast-helpers.ts","src/shared/source-scan.ts","src/shared/type-guards.ts","src/workflow/workflow-config.ts"],
      executionBoundary: "verification", ports: { requires: [], provides: ["architecture-analysis"] },
      responsibilities: ["module-graph-and-ownership-analysis"],
    }),
    moduleContract({
      id: "effect-surface-verification", path: "scripts/verification/effect-surface.ts",
      realm: "builder", layer: "verification", owner: "verification",
      publicApi: { exportCount: 21, namesSha256: "25b421651c3ae6687ff877f5e25f8958fd730c9fa63dddf0b38d7f8cff898ef6" },
      dependencies: ["src/architecture-manifest.ts","src/shared/source-extensions.ts"], executionBoundary: "verification",
      responsibilities: ["shared-static-effect-surface-classification"],
    }),
    moduleContract({
      id: "src-filesystem-immutable-receipt", path: "src/filesystem/immutable-receipt.ts", realm: "shared",
      layer: "infrastructure", owner: "filesystem-infrastructure",
      publicApi: { exportCount: 24, namesSha256: "8b05eac9eb65f595c6a1281e0e106ae12c1342645ef1e9cb91d5a93ea5d65945" },
      dependencies: ["node:fs","node:path","src/filesystem/durable-filesystem-internal.ts","src/filesystem/link-containment.ts","src/filesystem/linux-path.ts","src/filesystem/path-boundary.ts","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/kernel/root-policy.ts"],
      executionBoundary: "effect-adapter", effects: ["child-process", "cryptography", "filesystem-read", "filesystem-write"],
      ports: { requires: [], provides: ["immutable-evidence-files"] },
      configPaths: ["receipts.immutableExecution"],
      responsibilities: [
        "descriptor-held-exclusive-content-addressed-and-unique-attempt-durable-unadmitted-evidence-authority",
        "exact-0600-runtime-publication-inspection-and-explicit-byte-preserving-current-filesystem-mode-remediation",
      ],
    }),
    moduleContract({
      id: "safe-repository-reader-verification", path: "scripts/verification/safe-repository-reader.ts",
      realm: "builder", layer: "verification", owner: "verification-foundation",
      publicApi: { exportCount: 15, namesSha256: "063dce63403b2bd955f090377d9da7408056ffff4425c0348db108a9f3b395cd" },
      dependencies: ["node:fs","node:path","src/filesystem/link-containment.ts","src/filesystem/path-boundary.ts","src/filesystem/pinned-path-internal.ts","src/filesystem/repository-root-capability-internal.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/shared/source-scan.ts"],
      executionBoundary: "verification", effects: ["filesystem-read"],
      ports: { requires: ["linux-mount-inspection"], provides: ["safe-repository-read"] },
      configPaths: ["verification.safeRepositoryRead"],
      responsibilities: ["linux-descriptor-held-ancestor-safe-repository-file-reading-and-recheck"],
    }),
    moduleContract({
      id: "hash-binding-registry", path: "src/workflow/hash-binding-registry.ts", realm: "shared",
      layer: "domain", owner: "verification-workflow",
      publicApi: { exportCount: 26, namesSha256: "21addbecf2fdf6e273387ecb3a86a95e83985461691a9028ffee46b65ffd62e1" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/forensics/forensic-contracts.ts","src/forensics/offline-forensics.ts","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/requirements.ts","src/kernel/root-policy.ts","src/kernel/verification-paths.ts"],
      executionBoundary: "effect-adapter",
      effects: ["filesystem-read", "filesystem-write"],
      ports: { requires: [], provides: ["hash-binding-registry"] },
      responsibilities: ["central-hash-binding-verification-and-repair"],
    }),
    moduleContract({
      id: "static-source-verification", path: "scripts/verification/static-source.ts", realm: "builder",
      layer: "verification", owner: "verification", publicApi: { exportCount: 8, namesSha256: "cc62415c357c7d74a811f23a074f7e26936f62334f6645b6d8e84df9280ccc0e" },
      dependencies: ["scripts/verification/filesystem-cache.ts","src/kernel/integrity.ts","src/shared/source-extensions.ts","src/shared/type-guards.ts","src/workflow/workflow-config.ts"], executionBoundary: "verification",
      ports: { requires: [], provides: ["lexical-source-oracle"] },
      responsibilities: ["independent-lexical-source-analysis"],
    }),
    moduleContract({
      id: "test-surface-verification", path: "scripts/verification/test-surface.ts", realm: "builder",
      layer: "verification", owner: "verification",
      publicApi: { exportCount: 14, namesSha256: "c3a71f3da2f3cb62ade7fd693adf40bd1cf93cd74608a87ca36393f3c033bcb8" },
      dependencies: ["scripts/verification/pattern-liveness.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ordered.ts","src/kernel/root-policy.ts","src/kernel/test-surface-manifest.ts","zod"],
      executionBoundary: "verification",
      responsibilities: ["canonical-qualified-test-surface-scope-and-disposition"],
    }),
    moduleContract({ id: "slice-declarations", path: "scripts/verification/slice-declarations.ts", realm: "builder", layer: "verification", owner: "slice-projection", publicApi: { exportCount: 3, namesSha256: "9e7d13feb2ed6d6dfa4a5a85f019f7285ba7929d4d6df3eb40fc6e94640a57e9" }, dependencies: ["scripts/verification/slice-projection-paths.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","zod"], executionBoundary: "pure" }),
    moduleContract({ id: "slice-projection-captured-values", path: "scripts/verification/slice-projection-captured-values.ts", realm: "builder", layer: "verification", owner: "slice-projection", publicApi: { exportCount: 7, namesSha256: "e9210d06d6b01d9b66080f09244fc7fcb4ce82ddfd10c1f1f81f727090dd14b1" }, dependencies: ["scripts/verification/slice-projection-paths.ts","src/filesystem/path-boundary.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ordered.ts","src/kernel/safe-structural.ts","zod"], executionBoundary: "pure" }),
    moduleContract({ id: "slice-projection-inputs", path: "scripts/verification/slice-projection-inputs.ts", realm: "builder", layer: "verification", owner: "slice-projection", publicApi: { exportCount: 8, namesSha256: "f1aeb04af1da940f35e80b7ec602bfb8828c38c6f8a4d1c9e889c41c640bcb39" }, dependencies: ["scripts/test-inventory.ts","scripts/verification/candidate-format.ts","scripts/verification/official-fragment-manifest.ts","scripts/verification/slice-declarations.ts","scripts/verification/slice-projection-captured-values.ts","scripts/verification/slice-projection-paths.ts","scripts/verification/slice-source-contracts.ts","src/forensics/forensic-contracts.ts","src/forensics/forensic-crypto.ts","src/forensics/forensic-normalization.ts","src/forensics/forensic-projection.ts","src/forensics/forensic-state.ts","src/kernel/config-contracts.ts","src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/kernel/ledger-canonical.ts","src/kernel/ordered.ts","src/kernel/protocol-projections.ts","src/kernel/requirements.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/kernel/schema-subset.ts","src/runtime/capability-negotiation.ts","src/runtime/event-state.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "slice-projection-paths", path: "scripts/verification/slice-projection-paths.ts", realm: "builder", layer: "verification", owner: "slice-projection", publicApi: { exportCount: 2, namesSha256: "0ded1760d3af1e393495bbc07c8b6deaab7935b424843292d85b7359880e42f8" }, dependencies: ["src/kernel/verification-paths.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "slice-projections", path: "scripts/verification/slice-projections.ts", realm: "builder", layer: "verification", owner: "slice-projection", publicApi: { exportCount: 18, namesSha256: "77fe42619cf96b8290331bf1cc0bd0e2f868d8f1de5ade0fdd20de594054164a" }, dependencies: ["scripts/verification/slice-projection-captured-values.ts","scripts/verification/slice-projection-inputs.ts","src/filesystem/self-protection/self-protection-contracts.ts","src/forensics/forensic-contracts.ts","src/forensics/offline-contracts.ts","src/forensics/offline-forensics.ts","src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ordered.ts","src/kernel/requirements.ts","src/kernel/root-policy.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "slice-source-contracts", path: "scripts/verification/slice-source-contracts.ts", realm: "builder", layer: "verification", owner: "slice-projection", publicApi: { exportCount: 10, namesSha256: "7debcc9c6325622359a0056ad8c6d1b83d37c09c082a7bf1fa0177f7ace40b9e" }, dependencies: ["scripts/verification/slice-projection-paths.ts","src/kernel/json-integrity.ts","zod"], executionBoundary: "pure" }),
    moduleContract({ id: "repository-root-capability-contracts", path: "src/filesystem/repository-root-capability-contracts.ts", realm: "runtime", layer: "infrastructure", owner: "filesystem", publicApi: { exportCount: 23, namesSha256: "eb1ccc727b8748704ecd85ce4c1a3d96dc5c8b7a7862d65eee88227be42417be" }, dependencies: ["src/filesystem/path-boundary.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/shared/type-guards.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "repository-root-capability-internal", path: "src/filesystem/repository-root-capability-internal.ts", realm: "runtime", layer: "infrastructure", owner: "filesystem", publicApi: { exportCount: 18, namesSha256: "d65448921faeac64451822ef121cfe90de092ab989e0df0e1d5b6fd5e2679865" }, dependencies: ["node:fs","node:path","node:url","src/filesystem/path-boundary.ts","src/filesystem/pinned-path-internal.ts","src/filesystem/repository-root-capability-contracts.ts","src/filesystem/repository-root-capability-linux-adapter-internal.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/shared/type-guards.ts"], effects: ["cryptography","filesystem-read"], executionBoundary: "read-adapter" }),
    moduleContract({ id: "repository-root-capability-linux-adapter-internal", path: "src/filesystem/repository-root-capability-linux-adapter-internal.ts", realm: "runtime", layer: "infrastructure", owner: "filesystem", publicApi: { exportCount: 1, namesSha256: "a925927dfe9194387ab4eea9d0c98bcf78b3af9cd972f38aa825e4e54ea577b8" }, dependencies: ["node:fs","src/filesystem/repository-root-capability-contracts.ts","src/kernel/errors.ts","src/kernel/root-policy.ts"], effects: ["filesystem-read"], executionBoundary: "read-adapter" }),
    moduleContract({ id: "admit-handoff", path: "src/modules/tasks-agents/application/admit-handoff.ts", realm: "shared", layer: "application", owner: "tasks-agents", publicApi: { exportCount: 2, namesSha256: "e3ba951b6fde0d69964f4984f63ed79f3b0da99f99979bdf225b6c07033ea57e" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ordered.ts","src/modules/tasks-agents/application/compile-assignment-contract.ts","src/modules/tasks-agents/domain/handoff-contracts.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "compile-assignment-contract", path: "src/modules/tasks-agents/application/compile-assignment-contract.ts", realm: "shared", layer: "application", owner: "tasks-agents", publicApi: { exportCount: 4, namesSha256: "2d10cc435499d4d3ae18813e708867557c021a562da16fa369e40730e6d6a5df" }, dependencies: ["src/kernel/integrity.ts","src/modules/tasks-agents/domain/handoff-contracts.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "handoff-contracts", path: "src/modules/tasks-agents/domain/handoff-contracts.ts", realm: "shared", layer: "domain", owner: "tasks-agents", publicApi: { exportCount: 24, namesSha256: "53535e919140299117b8430648f3f83df32d19328bc9367a0686334626a230c5" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ordered.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/modules/tasks-agents/domain/handoff-protocol-authority.ts","zod"], executionBoundary: "pure" }),
    moduleContract({ id: "handoff-protocol-authority", path: "src/modules/tasks-agents/domain/handoff-protocol-authority.ts", realm: "shared", layer: "domain", owner: "tasks-agents", publicApi: { exportCount: 3, namesSha256: "73e3efedc8a2f5c29f467d5f3d0e9484d556a48d69dae4eb5ba12557b58646d3" }, dependencies: ["node:fs","node:path","src/kernel/integrity.ts","src/kernel/product-identity.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "index", path: "src/modules/tasks-agents/index.ts", realm: "shared", layer: "interface", owner: "tasks-agents", publicApi: { exportCount: 31, namesSha256: "8b8c1ff239bba176137cb7b510516bc332ef9bd71453332ca8af11454d85ac8e" }, dependencies: ["src/modules/tasks-agents/application/admit-handoff.ts","src/modules/tasks-agents/application/compile-assignment-contract.ts","src/modules/tasks-agents/domain/handoff-contracts.ts","src/modules/tasks-agents/domain/handoff-protocol-authority.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "utf8-offsets", path: "src/text/utf8-offsets.ts", realm: "shared", layer: "domain", owner: "text-processing", publicApi: { exportCount: 10, namesSha256: "78d75e97e273513151c352080649b606f0d5de0cbea8a07cb24d038d9bfa195c" }, dependencies: ["src/kernel/errors.ts"], executionBoundary: "pure" }),
    moduleContract({ id: "privacy-policy", path: "src/privacy/privacy-policy.ts", realm: "shared", layer: "domain", owner: "privacy-and-redaction", publicApi: { exportCount: 16, namesSha256: "74f274e72a2359433784480598b73b9c073ee7b39cefb24992f343cb59283e02" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/privacy/classification-catalog.ts","src/privacy/privacy-config.ts","src/privacy/secret-intelligence.ts","src/privacy/secret-signals.ts"], executionBoundary: "pure", authorityFamilies: ["data-classification"], authorityIdentifiers: ["PRIVACY_POLICY_SCHEMA_VERSION","DEFAULT_PRIVACY_POLICY"], responsibilities: ["canonical-privacy-policy-pii-categories-redaction-rules-retention-and-evidence-exposure"] }),
    moduleContract({ id: "redaction-engine", path: "src/privacy/redaction-engine.ts", realm: "shared", layer: "domain", owner: "privacy-and-redaction", publicApi: { exportCount: 20, namesSha256: "0f24dcea015e97f6a593085e93412137773f7f9bed0b7c41c57ab9b568c6cc33" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/privacy/credential-lexicon.ts","src/privacy/identity-grammars.ts","src/privacy/pii-registry.ts","src/privacy/privacy-policy.ts","src/privacy/secret-intelligence.ts","src/privacy/secret-signals.ts","src/privacy/text-normalize.ts","src/privacy/value-intrinsic.ts","src/shared/best-effort.ts","src/text/utf8-offsets.ts"], executionBoundary: "pure", responsibilities: ["central-secret-and-pii-span-detection-and-in-place-redaction-with-byte-accurate-spans"] }),
    moduleContract({ id: "evidence-handler", path: "src/privacy/evidence-handler.ts", realm: "shared", layer: "domain", owner: "privacy-and-redaction", publicApi: { exportCount: 13, namesSha256: "33b954c93ea05f64d6e490f806d99e5121171478dea7ef71c5c5377e196fb2e5" }, dependencies: ["src/kernel/integrity.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts"], executionBoundary: "pure", responsibilities: ["redact-evidence-before-persistence-display-and-log-with-unparseable-blocking"] }),
    moduleContract({ id: "file-viewer", path: "src/privacy/file-viewer.ts", realm: "shared", layer: "domain", owner: "privacy-and-redaction", publicApi: { exportCount: 9, namesSha256: "affd3dd91b81b915281a7067f709a4fb750779820e80b3e2c544538c1a3d13a3" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts","src/privacy/secret-files.ts"], executionBoundary: "pure", responsibilities: ["full-regex-semantic-file-viewing-with-in-place-redaction-and-unparseable-blocking"] }),
    moduleContract({ id: "git-port", path: "src/git/git-port.ts", realm: "shared", layer: "ports", owner: "workspace-git", publicApi: { exportCount: 88, namesSha256: "4d820c6a78e320367492b3ed3703269bf66e60f46d596ee81de472d6a937f971" }, dependencies: ["src/kernel/integrity.ts","src/kernel/product-identity.ts"], executionBoundary: "pure", ports: { requires: [], provides: ["git-port"] }, responsibilities: ["typed-git-operation-port-for-init-clone-pull-push-commit-branch-tag-checkout-merge-rebase-status-diff-log-and-lifecycle"] }),
    moduleContract({ id: "git-adapter", path: "src/git/git-adapter.ts", realm: "runtime", layer: "infrastructure", owner: "workspace-git", publicApi: { exportCount: 9, namesSha256: "07c44c8fea1c593fcec2d9f31dd72440fa4a489362b46945e154ce2f10e8467b" }, dependencies: ["node:child_process","node:fs","node:path","src/git/git-config.ts","src/git/git-port.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/process/pinned-process-internal.ts"], executionBoundary: "effect-adapter", ports: { requires: ["git-port"], provides: ["git-adapter"] }, effects: ["child-process","filesystem-read","git","process-status"], responsibilities: ["concrete-git-implementation-via-pinned-process-internal-with-git-optional-locks-zero-and-never-push-enforcement"] }),
    moduleContract({ id: "workspace-lifecycle", path: "src/git/workspace-lifecycle.ts", realm: "runtime", layer: "application", owner: "workspace-git", publicApi: { exportCount: 19, namesSha256: "6471d9c47df6786cddc71959229360653388036794c24c64c315d7b2131f879f" }, dependencies: ["node:fs","node:path","src/git/git-port.ts","src/kernel/errors.ts","src/kernel/integrity.ts"], executionBoundary: "effect-adapter", ports: { requires: ["git-port"], provides: ["workspace-lifecycle"] }, effects: ["filesystem-read","git"], responsibilities: ["workspace-onboarding-remote-management-sync-conflict-detection-branch-tag-checkpoint-promotion-and-rollback"] }),
    moduleContract({ id: "worktree-port", path: "src/git/worktree-port.ts", realm: "runtime", layer: "infrastructure", owner: "workspace-git", publicApi: { exportCount: 37, namesSha256: "6a20461d215a2d651245c8bde58ef545718f5bc6b38c9c64a98a71091a3dc46c" }, dependencies: ["node:fs","node:path","src/git/git-adapter.ts","src/git/git-config.ts","src/git/git-port.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/process/environment-projection.ts","src/process/pinned-process-internal.ts","src/workflow/workflow-config.ts"], executionBoundary: "effect-adapter", ports: { requires: ["git-adapter"], provides: ["worktree-port"] }, effects: ["filesystem-read"], responsibilities: ["typed-git-worktree-port-for-isolated-agent-workspaces-with-pinned-execution-per-call-timeouts-agent-namespace-enforcement-and-merge-tree-dry-run-parsing"] }),
    moduleContract({ id: "agents-agent-config", path: "src/agents/agent-config.ts", realm: "runtime", layer: "domain", owner: "agents", publicApi: { exportCount: 17, namesSha256: "8aac9999eac1ac0d02b13ed59afc6a57e8dc4f892ae8ff02c14e14fbe13afd1d" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"], ports: { requires: [], provides: ["agent-config"] } }),
    moduleContract({ id: "agents-agent-runtime", path: "src/agents/agent-runtime.ts", realm: "runtime", layer: "domain", owner: "agents", publicApi: { exportCount: 8, namesSha256: "36e72b3af9bb470a1c58f715ea0a191b904a8d78016526d7168f58cae1288943" }, dependencies: ["src/agents/agents-config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/process/fault-policy.ts","src/runtime/governed-tool-dispatch.ts","src/runtime/response-turn.ts","src/shared/abort-signals.ts","src/shared/best-effort.ts","src/shared/llm/errors.ts","src/shared/llm/responses-disposition.ts","src/shared/llm/responses.ts"], executionBoundary: "effect-adapter", effects: ["cryptography","process-control"], ports: { requires: [], provides: ["agent-runtime"] } }),
    moduleContract({ id: "agents-agent-state", path: "src/agents/agent-state.ts", realm: "runtime", layer: "domain", owner: "agents", publicApi: { exportCount: 16, namesSha256: "93289d9cca9d02f295abeaf3dbcd010de4cc1d337a6432490a106f5f5cf6183d" }, dependencies: ["src/agents/agents-config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/best-effort.ts"], effects: ["cryptography"], ports: { requires: [], provides: ["agent-state"] } }),
    moduleContract({ id: "agents-agent-type-background", path: "src/agents/agent-type-background.ts", realm: "runtime", layer: "domain", owner: "agents", publicApi: { exportCount: 4, namesSha256: "1e23dfe638825ac0e354eb4c9fd4c6d58dee9a8b7bddfd3cb8eb3413bfd840a6" }, dependencies: ["src/agents/agent-runtime.ts","src/agents/agents-config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/process/fault-policy.ts"], executionBoundary: "effect-adapter", effects: ["process-control"], ports: { requires: ["agent-runtime"], provides: ["background-agent-type"] } }),
    moduleContract({ id: "agents-agent-type-call-return", path: "src/agents/agent-type-call-return.ts", realm: "runtime", layer: "domain", owner: "agents", publicApi: { exportCount: 1, namesSha256: "87b79e7a4b4364d0cece86f976eb02f0ea1d75555ea564ab3b06c77d15879de6" }, dependencies: ["src/agents/agent-runtime.ts"], ports: { requires: ["agent-runtime"], provides: ["call-return-agent-type"] } }),
    moduleContract({ id: "agents-agent-type-registry", path: "src/agents/agent-type-registry.ts", realm: "runtime", layer: "domain", owner: "agents", publicApi: { exportCount: 8, namesSha256: "3b8bae81ed7c960e56ca105165b26761aa09f5ea01a9a15c1be2bbc8ea2bdae4" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"], ports: { requires: [], provides: ["agent-type-registry"] } }),
    moduleContract({ id: "agents-index", path: "src/agents/index.ts", realm: "runtime", layer: "application", owner: "agents", publicApi: { exportCount: 62, namesSha256: "216cc616da939fc5842da967c82fb70b87e36b7e894f64547b71a30f1c63b325" }, dependencies: ["src/agents/agent-config.ts","src/agents/agent-runtime.ts","src/agents/agent-state.ts","src/agents/agent-type-background.ts","src/agents/agent-type-call-return.ts","src/agents/agent-type-registry.ts","src/agents/orchestrator.ts","src/agents/workspace-peek.ts"], ports: { requires: ["agent-config","agent-runtime","agent-state","agent-type-registry","background-agent-type","call-return-agent-type","orchestrator","workspace-peek"], provides: ["agents-api"] } }),
    moduleContract({ id: "agents-orchestrator", path: "src/agents/orchestrator.ts", realm: "runtime", layer: "application", owner: "agents", publicApi: { exportCount: 11, namesSha256: "bf446107e166ab9c74be0fd0eb5e600ca017f2192f18edb075362ab67409c04f" }, dependencies: ["src/agents/agent-config.ts","src/agents/agent-runtime.ts","src/agents/agent-state.ts","src/agents/agent-type-background.ts","src/agents/agent-type-call-return.ts","src/agents/agent-type-registry.ts","src/agents/agents-config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/process/fault-policy.ts","src/timeline/timeline-recorder.ts"], effects: ["cryptography"], ports: { requires: ["agent-config","agent-runtime","agent-state","agent-type-registry","background-agent-type","call-return-agent-type"], provides: ["orchestrator"] } }),
    moduleContract({ id: "agents-workspace-peek", path: "src/agents/workspace-peek.ts", realm: "runtime", layer: "domain", owner: "agents", publicApi: { exportCount: 3, namesSha256: "387401bb84abbf5ce317598efb14978339b21fc03c0b1bb6eb1725e09f515598" }, dependencies: ["src/agents/agents-config.ts","src/kernel/integrity.ts"], ports: { requires: [], provides: ["workspace-peek"] } }),
    moduleContract({ id: "editor-edit-feedback", path: "src/editor/edit-feedback.ts", realm: "runtime", layer: "domain", owner: "editor", publicApi: { exportCount: 17, namesSha256: "5cb4c0929268cb7e923721a4f23cf240592f8953b3628cad198b300ca6a5539d" }, dependencies: ["src/kernel/integrity.ts"], ports: { requires: [], provides: ["edit-feedback"] } }),
    moduleContract({ id: "editor-edit-operations", path: "src/editor/edit-operations.ts", realm: "runtime", layer: "domain", owner: "editor", publicApi: { exportCount: 17, namesSha256: "f4f2c14ac56b36df48d5439db9ed4e45289e554b37baaa01dda5e7b8d1b95948" }, dependencies: ["src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/type-guards.ts","src/text/utf8-offsets.ts"], ports: { requires: [], provides: ["edit-operations"] } }),
    moduleContract({ id: "editor-edit-tools", path: "src/editor/edit-tools.ts", realm: "runtime", layer: "infrastructure", owner: "editor", publicApi: { exportCount: 6, namesSha256: "e45b8258eba9e56e308c6a9cc5fe9d5e47e75d6eec7331984a0f48da5d8ed24c" }, dependencies: ["node:fs","src/editor/edit-resolve.ts","src/editor/syntax-validator.ts","src/editor/transactional-editor.ts","src/kernel/integrity.ts","src/shared/exposure/registrations/editor.ts"], ports: { requires: ["transactional-editor"], provides: ["editor-tools"] } }),
    moduleContract({ id: "editor-syntax-validator", path: "src/editor/syntax-validator.ts", realm: "runtime", layer: "domain", owner: "editor", publicApi: { exportCount: 11, namesSha256: "2401ca870635eeb6d00fe2e6a9a5c5e346489c39bbfe78d699f44a589ac1a64f" }, dependencies: ["@babel/parser","src/intelligence/language-registry.ts","src/intelligence/tree-sitter-backend.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/language-extensions.ts","src/shared/path-utils.ts"], ports: { requires: [], provides: ["syntax-validator"] } }),
    moduleContract({ id: "editor-transactional-editor", path: "src/editor/transactional-editor.ts", realm: "runtime", layer: "infrastructure", owner: "editor", publicApi: { exportCount: 9, namesSha256: "947991f8fe1d3a296eb5612cef0fbaed4f4ce63b02a8adbec5c480c1bdb69dca" }, dependencies: ["node:fs","node:path","src/editor/edit-feedback.ts","src/editor/edit-operations.ts","src/editor/syntax-validator.ts","src/filesystem/atomic-write.ts","src/filesystem/path-boundary.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/best-effort.ts"], executionBoundary: "effect-adapter", effects: ["filesystem-read","filesystem-write"], ports: { requires: ["edit-feedback","edit-operations","syntax-validator"], provides: ["transactional-editor"] } }),
    moduleContract({ id: "evaluation-types", path: "src/evaluation/types.ts", realm: "shared", layer: "domain", owner: "evaluation", publicApi: { exportCount: 69, namesSha256: "24a51fc04b851a7c20f92c96457efb184ff633a62bdd6e7584ac669c42502dc3" }, dependencies: ["src/kernel/integrity.ts"], ports: { requires: [], provides: ["evaluation-types"] } }),
    moduleContract({ id: "evaluation-scenarios", path: "src/evaluation/scenarios.ts", realm: "shared", layer: "domain", owner: "evaluation", publicApi: { exportCount: 5, namesSha256: "4030a030a0a7ee3de26577e75cba57b2c824a945e301ea292dee08460b59fd73" }, dependencies: ["node:fs","node:path","node:url","src/intelligence/intelligence-types.ts","src/kernel/errors.ts","src/kernel/integrity.ts"], executionBoundary: "read-adapter", effects: ["filesystem-read"], ports: { requires: ["evaluation-types"], provides: ["evaluation-scenarios"] } }),
    moduleContract({ id: "evaluation-matrix-generator", path: "src/evaluation/matrix-generator.ts", realm: "shared", layer: "domain", owner: "evaluation", publicApi: { exportCount: 7, namesSha256: "f18c24f09368835ef03366b1c21e66406675c306df3a23ba6121267275df5499" }, dependencies: ["node:fs","node:path","node:url","src/evaluation/scenarios.ts","src/evaluation/types.ts","src/kernel/config-contracts.ts","src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts"], executionBoundary: "read-adapter", effects: ["filesystem-read"], ports: { requires: ["evaluation-types"], provides: ["matrix-generator"] } }),
    moduleContract({ id: "evaluation-budget-calculator", path: "src/evaluation/budget-calculator.ts", realm: "shared", layer: "domain", owner: "evaluation", publicApi: { exportCount: 5, namesSha256: "05784a411aeead7de3e1e9cc4f168deca4656a38bf4c82123e314efcb23dc8c0" }, dependencies: ["src/evaluation/evaluation-config.ts","src/kernel/integrity.ts"], ports: { requires: ["evaluation-types"], provides: ["budget-calculator"] } }),
    moduleContract({ id: "evaluation-semantic-validators", path: "src/evaluation/semantic-validators.ts", realm: "shared", layer: "domain", owner: "evaluation", publicApi: { exportCount: 2, namesSha256: "9036e67480a6d9b05219654a9995f6c2aff74275efd922834f333e2bd44ef546" }, dependencies: ["src/kernel/integrity.ts"], ports: { requires: ["evaluation-types"], provides: ["semantic-validators"] } }),
    moduleContract({ id: "evaluation-scenario-runner", path: "src/evaluation/scenario-runner.ts", realm: "runtime", layer: "application", owner: "evaluation", publicApi: { exportCount: 5, namesSha256: "a0fa4f60bdcd59a2ed0b52214681e3e696b11962d93fd3c7c09160c45851ee15" }, dependencies: ["src/evaluation/evaluation-config.ts","src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/runtime/provider-adapter.ts","src/shared/abort-signals.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts","src/shared/llm/client.ts","src/shared/llm/config.ts","src/shared/llm/provider-http.ts","src/shared/outbound-http.ts","src/shared/outbound-policy.ts"], ports: { requires: ["evaluation-types","provider-adapter"], provides: ["scenario-runner"] } }),
    moduleContract({ id: "evaluation-index", path: "src/evaluation/index.ts", realm: "shared", layer: "domain", owner: "evaluation", publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" }, dependencies: ["src/evaluation/budget-calculator.ts","src/evaluation/matrix-generator.ts","src/evaluation/scenario-runner.ts","src/evaluation/scenarios.ts","src/evaluation/semantic-validators.ts","src/evaluation/types.ts"] }),
    moduleContract({ id: "evaluation-results-writer", path: "src/evaluation/results-writer.ts", realm: "runtime", layer: "infrastructure", owner: "evaluation", publicApi: { exportCount: 17, namesSha256: "f97fcdac7e81a62bfcd5f724302a0326bbb5e5aad3652172d45fd5f9f28b210b" }, dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/kernel/errors.ts","src/kernel/integrity.ts"], executionBoundary: "effect-adapter", effects: ["filesystem-write"], ports: { requires: ["evaluation-types"], provides: ["evaluation-results-writer"] }, responsibilities: ["progressive-atomic-on-disk-evaluation-results-and-resume-checkpoint-owner"] }),
    moduleContract({ id: "evaluation-matrix-executor", path: "src/evaluation/matrix-executor.ts", realm: "runtime", layer: "application", owner: "evaluation", publicApi: { exportCount: 7, namesSha256: "318203ab219380ed5e89e8bad1e61a3d6cbeed38991c58eb91f44ad38ecd5bc0" }, dependencies: ["src/evaluation/evaluation-config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/stats.ts"], ports: { requires: ["scenario-runner","evaluation-results-writer","timeline-recorder"], provides: ["matrix-executor"] }, responsibilities: ["deterministic-concurrent-budget-enforced-resumable-full-matrix-execution"] }),
    moduleContract({ id: "evaluation-cli", path: "src/evaluation/cli.ts", realm: "runtime", layer: "interface", owner: "evaluation", publicApi: { exportCount: 6, namesSha256: "2414d4989e944ba1a8b31e984ace6bc29fcfb91e3fb8ff23a4de7cdb3cc4d4f5" }, dependencies: ["node:fs","node:path","src/evaluation/budget-calculator.ts","src/evaluation/matrix-executor.ts","src/evaluation/matrix-generator.ts","src/evaluation/results-writer.ts","src/evaluation/scenario-runner.ts","src/evaluation/scenarios.ts","src/evaluation/semantic-validators.ts","src/evaluation/types.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/runtime/provider-adapter.ts","src/runtime/runtime-config.ts","src/timeline/timeline-recorder.ts","src/timeline/timeline-store.ts","src/workflow/command-result.ts"], executionBoundary: "composition-root", compositionRoot: true, effects: ["filesystem-read","filesystem-write","network","environment-access"], ports: { requires: ["matrix-executor","scenario-runner","provider-adapter","runtime-config"], provides: ["evaluation-cli"] }, responsibilities: ["harness-eval-cli-command-full-matrix-execution-against-makora"] }),
    moduleContract({ id: "memory-attempt-history", path: "src/memory/attempt-history.ts", realm: "runtime", layer: "domain", owner: "memory", publicApi: { exportCount: 7, namesSha256: "9e451a421c28717ffcb71319f1f7c4f2123cb895a1978f5fb551e77f5db69457" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/memory/memory-config.ts","src/memory/memory-search.ts","src/memory/memory-types.ts","src/shared/debug/debug-system.ts"], effects: ["cryptography"], ports: { requires: ["memory-search","memory-types"], provides: ["attempt-history"] } }),
    moduleContract({ id: "memory-memory-search", path: "src/memory/memory-search.ts", realm: "runtime", layer: "domain", owner: "memory", publicApi: { exportCount: 8, namesSha256: "62f45627b344ae0d4bac785ed1ee2a324489a046775503284ccf6496f24e121c" }, dependencies: ["src/kernel/integrity.ts","src/shared/memory/retrieval/inverted-index.ts","src/shared/memory/retrieval/text-utils.ts"], ports: { requires: [], provides: ["memory-search"] } }),
    moduleContract({ id: "memory-memory-store", path: "src/memory/memory-store.ts", realm: "runtime", layer: "domain", owner: "memory", publicApi: { exportCount: 6, namesSha256: "28861cde50489f93e0b610873e3473accdba6c29f3716eaffe84d1fed218a684" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/memory/memory-search.ts","src/memory/memory-types.ts","src/shared/debug/debug-system.ts","src/shared/type-guards.ts"], effects: ["cryptography"], ports: { requires: ["memory-search","memory-types"], provides: ["memory-store"] } }),
    moduleContract({ id: "memory-memory-types", path: "src/memory/memory-types.ts", realm: "runtime", layer: "domain", owner: "memory", publicApi: { exportCount: 28, namesSha256: "d38584ad1d943932c46f2955a74c6622bcbaefc052c2e361ddfaa27773aa4925" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/shared/type-guards.ts"], ports: { requires: [], provides: ["memory-types"] } }),
    moduleContract({ id: "quality-packs-bug-zoo", path: "src/quality-packs/bug-zoo.ts", realm: "runtime", layer: "domain", owner: "quality-packs", publicApi: { exportCount: 16, namesSha256: "c89f9515f5ce8fefaead2d306fc306dfb5a739133234c7ba0b60becf22e67c34" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts"], ports: { requires: [], provides: ["bug-zoo"] } }),
    moduleContract({ id: "quality-packs-cli", path: "src/quality-packs/cli.ts", realm: "runtime", layer: "infrastructure", owner: "quality-packs", publicApi: { exportCount: 6, namesSha256: "705de2df904dc7d690ba60d4156ff3e01c5ef6b8311d9d95e843f36a25f5b7b8" }, dependencies: ["node:fs","node:path","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/quality-packs/quality-pack.ts","src/quality-packs/tiers.ts","src/quality-packs/typescript-pack.ts","src/shared/debug/debug-system.ts","src/shared/path-utils.ts"], executionBoundary: "read-adapter", effects: ["filesystem-read"], ports: { requires: ["quality-pack","quality-tiers","typescript-quality-pack"], provides: ["quality-cli"] } }),
    moduleContract({ id: "quality-packs-quality-pack", path: "src/quality-packs/quality-pack.ts", realm: "runtime", layer: "domain", owner: "quality-packs", publicApi: { exportCount: 21, namesSha256: "aea337a964b47d3d396921a454fdf8779fe22851ee408798ffc3d11df96bc0c4" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts"], ports: { requires: [], provides: ["quality-pack"] } }),
    moduleContract({ id: "quality-packs-tiers", path: "src/quality-packs/tiers.ts", realm: "runtime", layer: "domain", owner: "quality-packs", publicApi: { exportCount: 12, namesSha256: "a33e3670638822dcf2f5b2f8c8e67e1f32abbb6d81fc18e31ef7b9f7d3fc347d" }, dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/quality-packs/quality-pack.ts"], ports: { requires: ["quality-pack"], provides: ["quality-tiers"] } }),
    moduleContract({ id: "quality-packs-typescript-pack", path: "src/quality-packs/typescript-pack.ts", realm: "runtime", layer: "domain", owner: "quality-packs", publicApi: { exportCount: 14, namesSha256: "0e180310ac151a3bef645b6918d25a1aa16364c9b7993d354b896c72a2321a0c" }, dependencies: ["src/editor/syntax-validator.ts","src/intelligence/js-tokenizer.ts","src/intelligence/symbol-extractor.ts","src/intelligence/tree-sitter-backend.ts","src/kernel/integrity.ts","src/kernel/language-extensions.ts","src/quality-packs/prevention/index.ts","src/quality-packs/quality-pack.ts","src/shared/numeric-helpers.ts","src/shared/path-utils.ts"], ports: { requires: ["syntax-validator","quality-pack"], provides: ["typescript-quality-pack"] } }),
    moduleContract({
      id: "quality-packs-prevention-ast-helpers",
      path: "src/quality-packs/prevention/ast-helpers.ts",
      realm: "shared", layer: "domain", owner: "quality-packs",
      publicApi: { exportCount: 11, namesSha256: "dbe69c4dcf7a6f3c573bb91f0281f2c412ea7684b782b665d12079fde072f844" },
      dependencies: ["@babel/parser","src/kernel/errors.ts","src/shared/similarity.ts","src/shared/source-extensions.ts"],
      executionBoundary: "pure",
      responsibilities: ["shared-ast-walker-helpers-for-prevention-detectors"],
    }),
    moduleContract({
      id: "quality-packs-prevention-duplicate-body-detector",
      path: "src/quality-packs/prevention/duplicate-body-detector.ts",
      realm: "shared", layer: "domain", owner: "quality-packs",
      publicApi: { exportCount: 14, namesSha256: "bfd3f78da8775f8395551cc8d41228a6d4b1fd34d941d42b235639038ab117df" },
      dependencies: ["@babel/parser","src/kernel/integrity.ts","src/quality-packs/prevention/ast-helpers.ts","src/quality-packs/prevention/async-effect-normalizer.ts","src/quality-packs/prevention/duplicate-body-types.ts","src/quality-packs/prevention/embedding-provider.ts","src/shared/best-effort.ts","src/shared/similarity.ts"],
      executionBoundary: "pure",
      responsibilities: ["drY-duplicate-function-body-detector-3-pass-with-quorum"],
    }),
    moduleContract({
      id: "quality-packs-prevention-async-effect-normalizer",
      path: "src/quality-packs/prevention/async-effect-normalizer.ts",
      realm: "shared", layer: "domain", owner: "quality-packs",
      publicApi: { exportCount: 4, namesSha256: "10eeb2956be5783b5585ebee42a133e4ee5c0ea3db4fc451eb1d1a9d0419cf21" },
      dependencies: ["src/quality-packs/prevention/ast-helpers.ts","src/shared/similarity.ts"],
      executionBoundary: "pure",
      responsibilities: ["async-sync-n2-algebraic-effect-normalizer-async-iter-form-extraction"],
    }),
    moduleContract({
      id: "quality-packs-prevention-esm-cjs-detector",
      path: "src/quality-packs/prevention/esm-cjs-detector.ts",
      realm: "shared", layer: "domain", owner: "quality-packs",
      publicApi: { exportCount: 4, namesSha256: "ea990e73ba91f30908056ea3e90ba01504754506ffa267fad90df7319f13d3e5" },
      dependencies: ["@babel/parser","node:path","src/quality-packs/prevention/ast-helpers.ts","src/shared/debug/debug-system.ts"],
      executionBoundary: "pure",
      responsibilities: ["esm-cjs-mismatch-detector-with-create-require-alias-tracking"],
    }),
    moduleContract({
      id: "quality-packs-prevention-duplicated-literals-detector",
      path: "src/quality-packs/prevention/duplicated-literals-detector.ts",
      realm: "shared", layer: "domain", owner: "quality-packs",
      publicApi: { exportCount: 6, namesSha256: "b310b6c8040257deb964f7409484d527b0c492548236e79293a302aefe3110b2" },
      dependencies: ["@babel/parser","src/quality-packs/prevention/ast-helpers.ts"],
      executionBoundary: "pure",
      responsibilities: ["duplicated-string-and-numeric-literal-detector"],
    }),
    moduleContract({
      id: "quality-packs-prevention-index",
      path: "src/quality-packs/prevention/index.ts",
      realm: "shared", layer: "interface", owner: "quality-packs",
      publicApi: { exportCount: 31, namesSha256: "3172f092f1aca4502f88e09ce05f02686ff20599255506248454982bb7678bf7" },
      dependencies: ["src/quality-packs/prevention/ast-helpers.ts","src/quality-packs/prevention/duplicate-body-detector.ts","src/quality-packs/prevention/duplicated-literals-detector.ts","src/quality-packs/prevention/embedding-provider.ts","src/quality-packs/prevention/esm-cjs-detector.ts"],
      executionBoundary: "pure",
      responsibilities: ["prevention-detectors-public-barrel-explicit-named-re-exports"],
    }),
    moduleContract({
      id: "quality-packs-prevention-novel-principles-config",
      path: "src/quality-packs/prevention/novel-principles-config.ts",
      realm: "shared", layer: "domain", owner: "quality-packs",
      publicApi: { exportCount: 4, namesSha256: "4a5440905e67f962985e62624a424af478596bbc212ed507c2febe229c22316c" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "extensions-semver", path: "src/extensions/semver.ts", realm: "runtime", layer: "domain",
      owner: "self-evolution", publicApi: { exportCount: 15, namesSha256: "985e3111ed7dd2f56419ac8ea04f0640cd3e0c44f24265dd142c6facf74eef9e" },
      dependencies: ["src/kernel/errors.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["extension-semver-versioning"] },
      responsibilities: ["one-canonical-owner-for-extension-version-parsing-comparison-and-range-satisfaction"],
    }),
    moduleContract({
      id: "extensions-config", path: "src/extensions/extensions-config.ts", realm: "runtime", layer: "domain",
      owner: "self-evolution", publicApi: { exportCount: 5, namesSha256: "919f78d3b3fa1910d37043d5079855bdb77365f5c5ffd88a910142aa56944407" },
      dependencies: [],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["extension-manifest-limits"] },
      responsibilities: ["extension-manifest-validation-limits-owner"],
    }),
    moduleContract({
      id: "extensions-manifest", path: "src/extensions/extension-manifest.ts", realm: "runtime", layer: "domain",
      owner: "self-evolution", publicApi: { exportCount: 19, namesSha256: "146de11fa4886ee9931c42a9ffd6df492236c614a07a849efeba37e01020c429" },
      dependencies: ["src/extensions/extension-validation.ts","src/extensions/extensions-config.ts","src/extensions/semver.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/shared/type-guards.ts"],
      executionBoundary: "pure",
      ports: { requires: ["extension-semver-versioning"], provides: ["extension-manifest-registry"] },
      responsibilities: ["one-canonical-versioned-extension-manifest-family-and-registry"],
    }),
    moduleContract({
      id: "extensions-compatibility-checker", path: "src/extensions/compatibility-checker.ts", realm: "runtime", layer: "domain",
      owner: "self-evolution", publicApi: { exportCount: 14, namesSha256: "c166b1c732f77e35549e75a638d1a99bb3e273f0b76fc204ff8102510039d323" },
      dependencies: ["src/extensions/extension-manifest.ts","src/extensions/semver.ts","src/kernel/errors.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["extension-manifest-registry", "extension-semver-versioning"], provides: ["extension-compatibility-checker"] },
      responsibilities: ["version-capability-dependency-and-conflict-compatibility-checking-and-backward-compatibility"],
    }),
    moduleContract({
      id: "extensions-lifecycle", path: "src/extensions/extension-lifecycle.ts", realm: "runtime", layer: "domain",
      owner: "self-evolution", publicApi: { exportCount: 30, namesSha256: "152619d70ed8a61bad70e87f824e7efb53564ada56839dae8fd3433ed4184ce3" },
      dependencies: ["src/extensions/compatibility-checker.ts","src/extensions/extension-manifest.ts","src/extensions/extension-validation.ts","src/extensions/semver.ts","src/kernel/errors.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["extension-manifest-registry", "extension-compatibility-checker"], provides: ["extension-lifecycle-state-machine"] },
      responsibilities: ["registered-lifecycle-transitions-for-add-edit-deprecate-delete-upgrade-downgrade-enable-disable-rollback"],
    }),
    moduleContract({
      id: "extensions-validation", path: "src/extensions/extension-validation.ts", realm: "runtime", layer: "domain",
      owner: "self-evolution", publicApi: { exportCount: 2, namesSha256: "2a608df55d6f5ac789104bc600737c09904fa9eb921d068b7041a383ce97d189" },
      dependencies: ["src/kernel/errors.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["extension-validation-utilities"] },
      responsibilities: ["shared-extension-validation-utilities-iso-timestamp-pattern-and-assert-timestamp-canonical-owner"],
    }),
    moduleContract({
      id: "extensions-approval-workflow", path: "src/extensions/approval-workflow.ts", realm: "runtime", layer: "application",
      owner: "self-evolution", publicApi: { exportCount: 25, namesSha256: "f11ff9b508c3cbe93da171bd536c00783d4b759b563f192c06e8f2a15cad24db" },
      dependencies: ["src/extensions/compatibility-checker.ts","src/extensions/extension-manifest.ts","src/extensions/extension-validation.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/best-effort.ts"],
      executionBoundary: "pure",
      ports: { requires: ["extension-lifecycle-state-machine", "extension-compatibility-checker"], provides: ["approval-workflow"] },
      responsibilities: ["propose-approve-apply-review-activate-rollback-workflow-with-anti-replay-and-explicit-user-approval"],
    }),
    moduleContract({
      id: "extensions-self-modification-tools", path: "src/extensions/self-modification-tools.ts", realm: "runtime", layer: "application",
      owner: "self-evolution", publicApi: { exportCount: 35, namesSha256: "f11bf04776a7efe4b54790fd349846b36c3e04e24a182eb74e547144346a7d3e" },
      dependencies: ["src/extensions/approval-workflow.ts","src/extensions/compatibility-checker.ts","src/extensions/extension-lifecycle.ts","src/extensions/extension-manifest.ts","src/kernel/errors.ts","src/kernel/integrity.ts"],
      executionBoundary: "pure",
      ports: { requires: ["approval-workflow", "extension-lifecycle-state-machine"], provides: ["self-modification-tools"] },
      responsibilities: ["the-only-entry-points-for-harness-self-modification-through-typed-proposals"],
    }),
    moduleContract({
      id: "extensions-index", path: "src/extensions/index.ts", realm: "runtime", layer: "application",
      owner: "self-evolution", publicApi: { exportCount: 115, namesSha256: "2dfb2bbc25b5921fc2c2709e014cb7ef0873731c251287d0e1072f84db7678a6" },
      dependencies: ["src/extensions/approval-workflow.ts", "src/extensions/compatibility-checker.ts", "src/extensions/extension-lifecycle.ts", "src/extensions/extension-manifest.ts", "src/extensions/self-modification-tools.ts", "src/extensions/semver.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["extensions-module-index"] },
      responsibilities: ["controlled-self-evolution-and-extension-lifecycle-barrel-re-export"],
    }),
    moduleContract({
      id: "performance-config", path: "src/performance/performance-config.ts", realm: "shared",
      layer: "domain", owner: "performance-observability",
      publicApi: { exportCount: 25, namesSha256: "e93b40220585fb87954aded491b83e6cca45c2b4922e0a9232b0de72206f9fb9" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/product-identity.ts","src/privacy/secret-signals.ts","zod"],
      ports: { requires: [], provides: ["performance-config"] },
      configPaths: ["performance-observability"],
      authorityFamilies: ["configuration"],
      authorityIdentifiers: ["PERFORMANCE_CONFIG_SCHEMA", "PerformanceConfig"],
      responsibilities: ["central-performance-and-resource-observability-configuration"],
    }),
    moduleContract({
      id: "performance-metrics-collector", path: "src/performance/metrics-collector.ts", realm: "shared",
      layer: "domain", owner: "performance-observability",
      publicApi: { exportCount: 12, namesSha256: "79c90e6911dbe877d14b88c7dd8410978450d7b8ae421d7de847b0756322a3f0" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/performance/performance-config.ts","src/shared/best-effort.ts"],
      ports: { requires: ["performance-config"], provides: ["metrics-collector"] },
      responsibilities: [
        "low-overhead-always-on-call-error-cancellation-and-duration-aggregation",
        "fixed-bucket-duration-histograms-with-p50-p95-p99-quantile-estimation",
        "configurable-sampled-call-traces",
      ],
    }),
    moduleContract({
      id: "performance-diagnostic-modes", path: "src/performance/diagnostic-modes.ts", realm: "runtime",
      layer: "infrastructure", owner: "performance-observability",
      publicApi: { exportCount: 13, namesSha256: "d85e4eee6d38441718e14cc7b1863252c9b2cb705b58029d11b79b51dadc7cdb" },
      dependencies: ["../shared/constants.ts","node:fs","node:os","node:perf_hooks","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/performance/performance-config.ts","src/process/process-facts.ts","src/shared/debug/debug-system.ts"],
      executionBoundary: "effect-adapter", effects: ["filesystem-read", "process-status"],
      ports: { requires: ["performance-config"], provides: ["diagnostic-modes"] },
      responsibilities: [
        "isolated-diagnostic-modes-for-cpu-memory-io-event-loop-process-and-cgroup",
        "honest-attribution-exact-only-for-isolated-scopes-shared-or-estimated-under-concurrency",
      ],
    }),
    moduleContract({
      id: "performance-function-manifest", path: "src/performance/function-manifest.ts", realm: "shared",
      layer: "domain", owner: "performance-observability",
      publicApi: { exportCount: 9, namesSha256: "e7d9a881cd0a8d32f313cc7f6b5e62f9d62cbbdc25f8bfb15f89b6695f92b89c" },
      dependencies: ["src/architecture-manifest.ts","src/intelligence/symbol-extractor.ts","src/intelligence/tree-sitter-backend.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts"],
      ports: { requires: ["performance-config", "architecture-manifest"], provides: ["function-manifest"] },
      responsibilities: [
        "generated-function-manifest-from-architecture-manifest-with-reviewed-exclusions",
        "content-hashed-reproducible-manifest-with-staleness-blocking",
      ],
    }),
    moduleContract({
      id: "performance-benchmark-runner", path: "src/performance/benchmark-runner.ts", realm: "runtime",
      layer: "infrastructure", owner: "performance-observability",
      publicApi: { exportCount: 12, namesSha256: "587cbdcc4abaac43bb69a862d54cff47e4c75f2cd208392268f28f26a29aa76a" },
      dependencies: ["node:os","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts","src/shared/numeric-helpers.ts"],
      ports: { requires: ["performance-config"], provides: ["benchmark-runner"] },
      responsibilities: [
        "repeated-cold-and-warm-benchmarks-with-hardware-and-runtime-fingerprints",
        "p50-p95-p99-comparisons-regression-budgets-and-instrumentation-overhead-budgets",
      ],
    }),
    moduleContract({
      id: "performance-index", path: "src/performance/index.ts", realm: "shared", layer: "domain",
      owner: "performance-observability",
      publicApi: { exportCount: 65, namesSha256: "d9a4768f80a5085406ac75775b64272fbcf565c435e47b42c3ea701327827bb6" },
      dependencies: ["src/performance/benchmark-runner.ts","src/performance/diagnostic-modes.ts","src/performance/function-manifest.ts","src/performance/metrics-collector.ts","src/performance/performance-config.ts"],
      executionBoundary: "pure",
      ports: { requires: [], provides: ["performance-module-index"] },
      responsibilities: ["performance-and-resource-observability-barrel-re-export"],
    }),
    moduleContract({
      id: "performance-benchmark-cli", path: "src/performance/benchmark-cli.ts", realm: "runtime",
      layer: "infrastructure", owner: "performance-observability",
      publicApi: { exportCount: 4, namesSha256: "7ae57e092e8d0746673b1f420046a2a79997da2a12f540a1df717e57336efbbb" },
      dependencies: ["src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/performance/benchmark-runner.ts","src/performance/configured-performance.ts","src/performance/performance-config.ts","src/privacy/privacy-config-section.ts","src/privacy/privacy-policy.ts","src/workflow/command-result.ts"],
      effects: ["cryptography"],
      ports: { requires: ["performance-config"], provides: ["benchmark-cli"] },
      responsibilities: ["harness-benchmark-cli-subcommand"],
    }),
    moduleContract({
      id: "performance-diagnostic-cli", path: "src/performance/diagnostic-cli.ts", realm: "runtime",
      layer: "infrastructure", owner: "performance-observability",
      publicApi: { exportCount: 4, namesSha256: "74144bf4fa9f88174c342749b8cc6e22138e557b5fdc4a8c3827eeef45161eed" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/performance/configured-performance.ts","src/performance/diagnostic-modes.ts","src/performance/performance-config.ts","src/workflow/command-result.ts"],
      ports: { requires: ["performance-config"], provides: ["diagnostic-cli"] },
      responsibilities: ["harness-diagnostic-cli-subcommand"],
    }),
    moduleContract({
      id: "public-api", path: "src/index.ts",
      realm: "builder", layer: "interface", owner: "public-api",
      publicApi: { exportCount: 61, namesSha256: "e22c8ae575412efaf20ed1e4a9095e022691521aa378615d6f3579d67fb871af" },
      dependencies: ["src/agents/orchestrator.ts","src/cli.ts","src/editor/transactional-editor.ts","src/kernel/config.ts","src/memory/memory-store.ts","src/memory/unified/unified-context-manager.ts","src/performance/metrics-collector.ts","src/runtime/interactive-session.ts","src/runtime/provider-adapter.ts","src/runtime/tool-args.ts","src/runtime/tool-registry.ts","src/timeline/timeline-recorder.ts","src/timeline/timeline-store.ts"],
      executionBoundary: "composition-root",
      compositionRoot: true,
      responsibilities: ["public-programmatic-api-barrel"],
    }),
    moduleContract({
      id: "self-protection-contracts", path: "src/filesystem/self-protection/self-protection-contracts.ts",
      realm: "shared", layer: "trusted-kernel", owner: "self-protection",
      publicApi: { exportCount: 26, namesSha256: "b82d0098a4e9642cecec03c36dda20778e99898016eaf65af2e8530bbcf4ff73" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/product-identity.ts","zod"],
      authorityFamilies: ["configuration"],
      authorityIdentifiers: ["GUARDIAN_SPEC_SCHEMA", "LANDLOCK_ACCESS_FS_FLAG_NAMES"],
      responsibilities: [
        "landlock-access-fs-flag-vocabulary-and-metadata",
        "guardian-ruleset-spec-zod-schema",
        "guardian-binary-error-codes-and-typed-result",
      ],
    }),
    moduleContract({
      id: "self-protection-config", path: "src/filesystem/self-protection/self-protection-config.ts",
      realm: "shared", layer: "domain", owner: "self-protection",
      publicApi: { exportCount: 9, namesSha256: "e112d89813dce5a2b576c8357645a4a4eec4da41adceb734a5afe946101a3f7c" },
      dependencies: ["node:path","src/filesystem/self-protection/self-protection-contracts.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","zod"],
      configPaths: ["self-protection"],
      authorityFamilies: ["configuration"],
      authorityIdentifiers: ["SELF_PROTECTION_CONFIG_SCHEMA", "SelfProtectionConfig"],
      responsibilities: ["operator-facing-self-protection-configuration-schema-and-defaults"],
    }),
    moduleContract({
      id: "self-protection-guardian-binary", path: "src/filesystem/self-protection/guardian-binary.ts",
      realm: "runtime", layer: "infrastructure", owner: "self-protection",
      publicApi: { exportCount: 9, namesSha256: "0b678d7e75e5e799425a5fcb8d73e53b13a07782d7bae2aaa89057934e4eae9e" },
      dependencies: ["node:child_process","node:fs","node:os","node:path","src/filesystem/link-containment.ts","src/filesystem/path-identity.ts","src/filesystem/private-state.ts","src/filesystem/self-protection/keep-out.ts","src/filesystem/self-protection/self-protection-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/best-effort.ts"],
      effects: ["child-process","filesystem-read","process-control","process-status"],
      executionBoundary: "effect-adapter",
      ports: { requires: ["self-protection-config", "root-policy-self-protection-floor"], provides: ["guardian-binary-wrapper"] },
      responsibilities: [
        "guardian-binary-path-resolution-and-sha256-verification",
        "landlock-availability-and-abi-probing",
        "compile-high-level-config-to-guardian-spec",
        "spawn-guardian-and-classify-typed-result",
      ],
    }),
    moduleContract({
      id: "self-protection-index", path: "src/filesystem/self-protection/index.ts",
      realm: "shared", layer: "interface", owner: "self-protection",
      publicApi: { exportCount: 76, namesSha256: "cd6046fd90bb92749589e5bd3c2e09025d079bfb6ded26df47be5b8465cd461e" },
      dependencies: ["src/filesystem/link-containment.ts","src/filesystem/path-identity.ts","src/filesystem/self-protection/guardian-binary.ts","src/filesystem/self-protection/keep-out.ts","src/filesystem/self-protection/key-home.ts","src/filesystem/self-protection/self-protection-config.ts","src/filesystem/self-protection/self-protection-contracts.ts"],
      responsibilities: ["self-protection-public-barrel-explicit-named-re-exports"],
    }),
    moduleContract({
      id: "build-bundle", path: "scripts/build-bundle.ts",
      realm: "builder", layer: "verification", owner: "self-protection",
      publicApi: { exportCount: 2, namesSha256: "00bd0afcda3ef46a6180f4d6492f22858bd19b792433b3f50c8242e7a0dc159b" },
      dependencies: ["esbuild","node:fs","node:path","node:url","scripts/verification/slice-projections.ts","src/filesystem/atomic-write.ts","src/kernel/root-policy.ts","src/runtime/cli-debug.ts","src/workflow/hash-binding-registry.ts"],
      effects: ["filesystem-write"],
      executionBoundary: "composition-root",
      compositionRoot: true,
      responsibilities: [
        "esbuild-bundle-src-cli-into-dist-bundle-js-single-file",
        "write-bundle-sha256-sidecar-and-guardian-spec-schema-artifact",
      ],
    }),
    moduleContract({
      id: "shared-abort-signals", path: "src/shared/abort-signals.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 6, namesSha256: "58420e7e0205abe10fa6aaec299a908f30e3c8f7a8d1c493b3360625af0c1fa8" },
      dependencies: ["src/process/fault-policy.ts"],
    }),
    moduleContract({
      id: "shared-dedup-compression-compression", path: "src/shared/dedup-compression/compression.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 5, namesSha256: "b04ab5386dac7733856715d5cf53f189f005c7c17d4e352a568d6160a5bd1cd6" },
      dependencies: ["node:zlib","src/shared/debug/debug-system.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "shared-dedup-compression-config", path: "src/shared/dedup-compression/config.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 8, namesSha256: "67d740a86c903b26f140b463c61039ee7d229413718a045df057241c709b88a8" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-dedup-compression-decompression", path: "src/shared/dedup-compression/decompression.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 2, namesSha256: "f77388d327524b93a0557cefe68d294b45ad725bc61538a2eb4b1779dbb4e40d" },
      dependencies: ["node:zlib","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "shared-dedup-compression-dedup", path: "src/shared/dedup-compression/dedup.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 5, namesSha256: "09531a06c6e2a271195a113a48773d71e0000a9da4df853c37ef88c79b1a06e0" },
      dependencies: ["@babel/parser","src/shared/dedup-compression/dynamic-keywords.ts","src/shared/dedup-compression/shared-helpers.ts","src/shared/numeric-helpers.ts","src/shared/similarity.ts"],
    }),
    moduleContract({
      id: "shared-dedup-compression-dynamic-keywords", path: "src/shared/dedup-compression/dynamic-keywords.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 10, namesSha256: "7254afdf2b43e4cf5436a1ae340b19f1f97c538cd3d47a6bf29139811817011c" },
      dependencies: ["@babel/parser","node:path","src/shared/dedup-compression/shared-helpers.ts","web-tree-sitter"],
    }),
    moduleContract({
      id: "shared-dedup-compression-exposure", path: "src/shared/dedup-compression/exposure.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 3, namesSha256: "3115e517b15e87fe792e2d0ea24173770c1185e71536232fb2cea362afe314db" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "shared-dedup-compression-index", path: "src/shared/dedup-compression/index.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 48, namesSha256: "0275da1b3c6fe48a0f35dc7746fd6720e78087d7dbfed9194b337c301aec7849" },
      dependencies: ["src/shared/dedup-compression/compression.ts","src/shared/dedup-compression/config.ts","src/shared/dedup-compression/decompression.ts","src/shared/dedup-compression/dedup.ts","src/shared/dedup-compression/dynamic-keywords.ts","src/shared/dedup-compression/exposure.ts","src/shared/dedup-compression/lower-layer.ts","src/shared/dedup-compression/module-integration.ts"],
    }),
    moduleContract({
      id: "shared-dedup-compression-lower-layer", path: "src/shared/dedup-compression/lower-layer.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 4, namesSha256: "1ba6bd807f56b75c50261fe29365f0a0cca5670a43faa754c2c1b13f6d2da025" },
      dependencies: ["src/shared/dedup-compression/compression.ts","src/shared/dedup-compression/config.ts","src/shared/dedup-compression/decompression.ts","src/shared/dedup-compression/dedup.ts","src/shared/dedup-compression/shared-helpers.ts"],
    }),
    moduleContract({
      id: "shared-dedup-compression-module-integration", path: "src/shared/dedup-compression/module-integration.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 13, namesSha256: "7509a240565e6d5baf7bcfb1163e5e146a3b44771dd5b9a55b2ba8b0c734fea8" },
      dependencies: ["src/kernel/errors.ts","src/shared/dedup-compression/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-action", path: "src/shared/exposure/action.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 13, namesSha256: "8cb56bdc179a3f8fd224ed1f5752737b881cdbb05a630e9662a0dc0126830e0e" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/exposure/catalog.ts","src/shared/exposure/contract.ts","src/timeline/recorded-effect.ts"],
    }),
    moduleContract({
      id: "shared-exposure-customization", path: "src/shared/exposure/customization.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 27, namesSha256: "a9427343d38946dbddd6bcc107cd697b90069e2f8da67ccaaa5e31ba0229f8e9" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/exposure/catalog.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/contract.ts","src/shared/exposure/language.ts","src/shared/exposure/signal.ts","zod"],
    }),
    moduleContract({
      id: "shared-exposure-module", path: "src/shared/exposure/module.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 12, namesSha256: "eda55500a6ca46262d2f912267e2b30458944387af00761cb4502697abb573ca" },
      dependencies: ["src/kernel/errors.ts","src/shared/exposure/language.ts"],
    }),
    moduleContract({
      id: "shared-exposure-language", path: "src/shared/exposure/language.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 13, namesSha256: "ddb1e12bf46d6e68373c95acb45aa62a1dd4e0e9c0d14af8767f88179e69ff96" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "shared-exposure-index", path: "src/shared/exposure/index.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 140, namesSha256: "47ad5c86ce98e5fc8b9c3d4ca16cc22e61338be75ce84219a9b4b58a65f9aa26" },
      dependencies: ["src/safety/safety-config-section.ts","src/shared/exposure/action.ts","src/shared/exposure/catalog.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/contract.ts","src/shared/exposure/customization.ts","src/shared/exposure/language.ts","src/shared/exposure/module-config-sections.ts","src/shared/exposure/module.ts","src/shared/exposure/registry.ts","src/shared/exposure/reporter.ts","src/shared/exposure/signal.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-awareness", path: "src/shared/exposure/registrations/awareness.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "e18c5c90421ba9816dbecb5ba7d9d5a8d2e234c75b9925d909929dc91ab21ac9" },
      dependencies: ["src/process/fault-policy.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-bias", path: "src/shared/exposure/registrations/bias.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "694a12a05b5e725bfc8788ab42012f6a43b29e3f35ed03447a05ec889b71c21b" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-context", path: "src/shared/exposure/registrations/context.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "af18dc84a0dc869963a1483a4c71fe0ad3361ca149994dbf4f4ca5e041d3b78d" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-editor", path: "src/shared/exposure/registrations/editor.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "9fb9941daac2278ba9020ab947694429f0d0adcfcca0b2546e499a727d5e9d7a" },
      dependencies: ["node:fs","node:path","src/editor/transactional-editor.ts","src/kernel/integrity.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-hallucination", path: "src/shared/exposure/registrations/hallucination.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 4, namesSha256: "13b94308c712c314215e47beb7d11dfd2fa8d3eaaaf2df166a99268cfb6f2ed5" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-index", path: "src/shared/exposure/registrations/index.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 77, namesSha256: "93d4df99a5d597e026fd1b0ffc45d0b7b302c5bba58630dd98b411ceba719ff1" },
      dependencies: ["src/kernel/errors.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts","src/shared/exposure/registrations/agents.ts","src/shared/exposure/registrations/artifacts.ts","src/shared/exposure/registrations/awareness.ts","src/shared/exposure/registrations/bias.ts","src/shared/exposure/registrations/context.ts","src/shared/exposure/registrations/database.ts","src/shared/exposure/registrations/dedup.ts","src/shared/exposure/registrations/editor.ts","src/shared/exposure/registrations/graph.ts","src/shared/exposure/registrations/hallucination.ts","src/shared/exposure/registrations/harness-commands.ts","src/shared/exposure/registrations/intelligence.ts","src/shared/exposure/registrations/learning.ts","src/shared/exposure/registrations/mcp.ts","src/shared/exposure/registrations/memory.ts","src/shared/exposure/registrations/network.ts","src/shared/exposure/registrations/performance.ts","src/shared/exposure/registrations/privacy.ts","src/shared/exposure/registrations/process.ts","src/shared/exposure/registrations/promotion.ts","src/shared/exposure/registrations/quality.ts","src/shared/exposure/registrations/redaction.ts","src/shared/exposure/registrations/safety.ts","src/shared/exposure/registrations/search.ts","src/shared/exposure/registrations/settings.ts","src/shared/exposure/registrations/test-execution.ts","src/shared/exposure/registrations/timeline.ts","src/shared/exposure/registrations/tools.ts","src/shared/exposure/registrations/web-performance.ts","src/shared/exposure/registrations/workspace-git.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-learning", path: "src/shared/exposure/registrations/learning.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "907ed21b363dff02f78b7a27eea5c7aa0fbb7708e25dd8752e73ee455eb4e786" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-memory", path: "src/shared/exposure/registrations/memory.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "c5b684fe2c58de9c5558c525c9160efbf84fed2ac214b8149373df7a360363b2" },
      dependencies: ["src/kernel/config-contracts.ts","src/memory/memory-types.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-quality", path: "src/shared/exposure/registrations/quality.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "aa978b829f52109492f83b83360fb2272822dc5554cec15e0bab77b8c7ac3db4" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-safety", path: "src/shared/exposure/registrations/safety.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 10, namesSha256: "2bc593e8e40b49cb43e4f8d2c95b6628a71a065b8d11c9453e03e3ed5ee2d31d" },
      dependencies: ["src/kernel/root-policy.ts","src/safety/bandaid-config.ts","src/safety/tool-call-gate.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-search", path: "src/shared/exposure/registrations/search.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "e9453dbfd969c7a4d24760cb4d19abb49578a7bc1565fa017978b0adb1029992" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registrations-tools", path: "src/shared/exposure/registrations/tools.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "a6554e90e1f03b56708cf4b57c90d7618e4fdeeda3ed1454468729638c86b883" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "shared-exposure-registry", path: "src/shared/exposure/registry.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 13, namesSha256: "58cf8dd28de72acb054e6606fc6d3fec8cb29b0f046647777c9dc7e56b520ccd" },
      dependencies: ["src/shared/exposure/action.ts","src/shared/exposure/customization.ts","src/shared/exposure/module.ts","src/shared/exposure/signal.ts"],
    }),
    moduleContract({
      id: "shared-exposure-reporter", path: "src/shared/exposure/reporter.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 6, namesSha256: "3265d416a9eed565a8bcc43c42e8017b3bf5d0b3e5c393fc196d352440924109" },
      dependencies: ["src/shared/exposure/action.ts","src/shared/exposure/contract.ts","src/shared/exposure/customization.ts","src/shared/exposure/signal.ts"],
    }),
    moduleContract({
      id: "shared-exposure-signal", path: "src/shared/exposure/signal.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 20, namesSha256: "8f2799c2e2c10e1134a49a1114972f277af4768c3e4697bd9744652b1f6efc03" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/exposure/catalog.ts","src/shared/exposure/contract.ts"],
    }),
    moduleContract({
      id: "shared-identity", path: "src/shared/identity.ts", realm: "shared", layer: "domain",
      owner: "shared-identity", publicApi: { exportCount: 1, namesSha256: "90c58bbf147b58ea555583aab7316894516a60220d8dcc40c7bf0fe8a4b3097d" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-json-pointer", path: "src/shared/json-pointer.ts", realm: "shared", layer: "domain",
      owner: "shared-json-pointer", publicApi: { exportCount: 1, namesSha256: "589f5bae5147493cb3cd527f2c32e857a9d91e896abeb3b56f4ba29f65da0b06" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-llm-adaptive", path: "src/shared/llm/adaptive.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 4, namesSha256: "f79c8c09a039ce512595254f3162bcd27611de6e9aa932f20af4ec1985a5e488" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-llm-circuit-breaker", path: "src/shared/llm/circuit-breaker.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 3, namesSha256: "e8685d2cc6ffac8dbb9baa72d682b264850fc80c3dfacccbf95fc46cd936a89e" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-shared-llm-responses", path: "src/shared/llm/responses.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 27, namesSha256: "18c66d528dc7f84331ca1ab53d6ada64371d392fda338dbe6682e720b36d80c8" },
      dependencies: ["src/kernel/integrity.ts","src/shared/llm/errors.ts","src/shared/type-guards.ts","zod"],
    }),
    moduleContract({
      id: "src-shared-llm-responses-endpoints", path: "src/shared/llm/responses-endpoints.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 11, namesSha256: "a46aa1f665ba779180c0843a2a0d5a7d238189969f2a774a2eed43517b28726d" },
      dependencies: ["src/shared/llm/responses.ts","zod"],
    }),
    moduleContract({
      id: "src-shared-llm-responses-preparation", path: "src/shared/llm/responses-preparation.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 5, namesSha256: "fbe939284de14426285bb8e17ec35f035fb35197738477e888ad427a0c39dade" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/privacy/pii-registry.ts","src/privacy/privacy-policy.ts","src/privacy/redacted-messages.ts","src/shared/llm/responses-endpoints.ts"],
    }),
    moduleContract({
      id: "src-shared-llm-responses-tracking", path: "src/shared/llm/responses-tracking.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 1, namesSha256: "9582ec02b132fa23c80725318aff44411258b12b89605734ec8be4083c6db6ea" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-privacy-responses-redaction", path: "src/privacy/responses-redaction.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 5, namesSha256: "8855cde0feb6c33e3372528ab20f16067b8ed3c6b22efde0de2ebf75b3620a29" },
      dependencies: ["src/kernel/errors.ts","src/kernel/safe-structural.ts","src/privacy/held-set.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts","src/privacy/secret-intelligence.ts","src/privacy/secret-parts.ts","src/shared/string-values.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-shared-llm-provider-http", path: "src/shared/llm/provider-http.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 8, namesSha256: "816abdb423d50a7a08c7149a1dcc47997cd7af95b66362d22ab74ae481133f86" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/json-integrity.ts","src/privacy/responses-observation.ts","src/process/fault-policy.ts","src/shared/abort-signals.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts","src/shared/llm/errors.ts","src/shared/llm/provider-failure.ts","src/shared/llm/provider-observation.ts","src/shared/outbound-http.ts","src/timeline/recording-context.ts"],
    }),
    moduleContract({
      id: "shared-llm-client", path: "src/shared/llm/client.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 33, namesSha256: "3dcc1d586e9cf63ed487311d65639c08c32de8b30d89ab83f4227ab54afc70de" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/privacy/held-set.ts","src/privacy/privacy-policy.ts","src/privacy/redacted-messages.ts","src/privacy/responses-observation.ts","src/process/fault-policy.ts","src/runtime/sse-parser.ts","src/shared/abort-signals.ts","src/shared/backoff.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts","src/shared/llm/adaptive.ts","src/shared/llm/circuit-breaker.ts","src/shared/llm/config.ts","src/shared/llm/errors.ts","src/shared/llm/exposure.ts","src/shared/llm/failover.ts","src/shared/llm/provider-endpoint.ts","src/shared/llm/provider-failure.ts","src/shared/llm/provider-http.ts","src/shared/llm/provider-observation.ts","src/shared/llm/queue.ts","src/shared/llm/responses-endpoints.ts","src/shared/llm/responses-preparation.ts","src/shared/llm/responses-stream.ts","src/shared/llm/responses-tracking.ts","src/shared/llm/responses.ts","src/shared/llm/stats.ts","src/shared/outbound-http.ts","src/timeline/recording-context.ts"],
    }),
    moduleContract({
      id: "shared-llm-config", path: "src/shared/llm/config.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 35, namesSha256: "c0b85e0b2821306b011c6442c5fbcca272e3646487a556ccd41cad9d00b84549" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/shared/llm/errors.ts","src/shared/llm/provider-endpoint.ts","src/shared/llm/responses.ts","zod"],
    }),
    moduleContract({
      id: "shared-llm-errors", path: "src/shared/llm/errors.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 26, namesSha256: "907771b5a50151631c369df1e38fd49f50a5425749f32f00eba9025194b308af" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-llm-exposure", path: "src/shared/llm/exposure.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 3, namesSha256: "2f0dab75a36af67841baf1cfa3313b6dbbe0c6cb2dc6901fa78d60087dc86a53" },
      dependencies: ["src/kernel/errors.ts","src/shared/exposure/index.ts","src/shared/llm/config.ts"],
    }),
    moduleContract({
      id: "shared-llm-failover", path: "src/shared/llm/failover.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 10, namesSha256: "caa957d3b730a37a029a6af0574b3f268bc2385b71d336dfe994812a1dcc3ed9" },
      dependencies: ["src/shared/llm/errors.ts","src/shared/llm/provider-observation.ts"],
    }),
    moduleContract({
      id: "shared-llm-index", path: "src/shared/llm/index.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 90, namesSha256: "b3976db5c52b437c5176ae7ede31f2a3d0ba92f4ea632c725feeb2979df85afc" },
      dependencies: ["src/shared/llm/adaptive.ts","src/shared/llm/circuit-breaker.ts","src/shared/llm/client.ts","src/shared/llm/config.ts","src/shared/llm/errors.ts","src/shared/llm/exposure.ts","src/shared/llm/failover.ts","src/shared/llm/provider-failure.ts","src/shared/llm/queue.ts","src/shared/llm/response-transcript.ts","src/shared/llm/responses-disposition.ts","src/shared/llm/responses-endpoints.ts","src/shared/llm/responses-stream.ts","src/shared/llm/responses.ts","src/shared/llm/stats.ts"],
    }),
    moduleContract({
      id: "shared-llm-queue", path: "src/shared/llm/queue.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 5, namesSha256: "35d6523b380a6c3c35e028df84fe58a945387b83d0c035fd7adc61099d02f1c9" },
      dependencies: ["src/kernel/errors.ts","src/privacy/held-set.ts","src/process/fault-policy.ts","src/shared/llm/config.ts","src/shared/llm/errors.ts","src/shared/llm/provider-observation.ts"],
    }),
    moduleContract({
      id: "shared-llm-stats", path: "src/shared/llm/stats.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 3, namesSha256: "90332b29c2038f4b6d421e1d0878fb4f2c78614fbe2d5a04bc97b39c2fa2c77d" },
      dependencies: ["src/shared/llm/provider-observation.ts"],
    }),
    moduleContract({
      id: "shared-memory-ebbinghaus", path: "src/shared/memory/ebbinghaus.ts", realm: "shared", layer: "domain",
      owner: "shared-memory", publicApi: { exportCount: 3, namesSha256: "fbd6af32f2e07c17e576c7800b22ba21dab0177bf698ff458d58354c5c1bc01e" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-memory-index", path: "src/shared/memory/index.ts", realm: "shared", layer: "domain",
      owner: "shared-memory", publicApi: { exportCount: 93, namesSha256: "047995a2834857b049a3ac7900d1cc6c8ac02f4c6109f03fde2d3a2f38c0cd4a" },
      dependencies: ["src/shared/memory/ebbinghaus.ts","src/shared/memory/memory-config.ts","src/shared/memory/memory-entry.ts","src/shared/memory/memory-exposure.ts","src/shared/memory/memory-tree.ts","src/shared/memory/retrieval/cosine.ts","src/shared/memory/retrieval/embeddings.ts","src/shared/memory/retrieval/hnsw.ts","src/shared/memory/retrieval/inverted-index.ts","src/shared/memory/retrieval/retriever.ts","src/shared/memory/retrieval/rrf.ts","src/shared/memory/retrieval/text-utils.ts","src/shared/memory/retrieval/tfidf.ts","src/shared/memory/shared-memory-store.ts","src/shared/memory/storage/backend.ts","src/shared/memory/storage/msgpack-backend.ts","src/shared/memory/storage/serde.ts","src/shared/memory/token-cap.ts"],
    }),
    moduleContract({
      id: "shared-memory-memory-config", path: "src/shared/memory/memory-config.ts", realm: "shared", layer: "domain",
      owner: "shared-memory", publicApi: { exportCount: 29, namesSha256: "5543ba8ee1d1b81fe2f6083d36b0552ddf92fc4b90c2d65b2c09ab1d9a181f82" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts"],
    }),
    moduleContract({
      id: "shared-memory-memory-entry", path: "src/shared/memory/memory-entry.ts", realm: "shared", layer: "domain",
      owner: "shared-memory", publicApi: { exportCount: 8, namesSha256: "1393124dd8f95b94cb584f214b1b5efd87428acbb41f53a478d8be73734a8dd4" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/memory/memory-config.ts"],
    }),
    moduleContract({
      id: "shared-memory-memory-exposure", path: "src/shared/memory/memory-exposure.ts", realm: "shared", layer: "domain",
      owner: "shared-memory", publicApi: { exportCount: 2, namesSha256: "7e139abdfd1f52f3d105895c86317d67b463e99e37046feebaed86c14d9dc0a4" },
      dependencies: ["src/shared/exposure/index.ts","src/shared/memory/memory-config.ts"],
    }),
    moduleContract({
      id: "shared-memory-memory-tree", path: "src/shared/memory/memory-tree.ts", realm: "shared", layer: "domain",
      owner: "shared-memory", publicApi: { exportCount: 3, namesSha256: "73d271f8e87e540043b82d81205566aa76ca206ecfa0fdf0a38c494b75124e20" },
      dependencies: ["src/shared/memory/memory-config.ts"],
    }),
    moduleContract({
      id: "shared-memory-retrieval-cosine", path: "src/shared/memory/retrieval/cosine.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 4, namesSha256: "e6993cd17dcdee4e0d744fd64df01384005db35d829b2591bde74cb6f94976be" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "shared-memory-retrieval-embeddings", path: "src/shared/memory/retrieval/embeddings.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 5, namesSha256: "e9fd0d58ddf875c29a4ddaa3561f8aa27d7035551a52a134b7a6efd8332d1775" },
      dependencies: ["src/kernel/errors.ts","src/shared/debug/debug-system.ts","src/shared/memory/memory-config.ts"],
    }),
    moduleContract({
      id: "shared-memory-retrieval-hnsw", path: "src/shared/memory/retrieval/hnsw.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 4, namesSha256: "9627a8fb04a0799d4ca60f1c93519ff288b054a8276122c2efe8e53f253693ac" },
      dependencies: ["src/shared/memory/retrieval/cosine.ts"],
    }),
    moduleContract({
      id: "shared-memory-retrieval-inverted-index", path: "src/shared/memory/retrieval/inverted-index.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 4, namesSha256: "4c1503e05392335f88e57d1c1f6899e7d92d2d76efe5c433007202b1281d25c7" },
      dependencies: ["src/shared/memory/retrieval/text-utils.ts"],
    }),
    moduleContract({
      id: "shared-memory-retrieval-retriever", path: "src/shared/memory/retrieval/retriever.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 5, namesSha256: "acd065dbec3fed6968fd4d18988c466f026ba4af647dd877b73705ad9a889955" },
      dependencies: ["src/kernel/integrity.ts","src/shared/debug/debug-system.ts","src/shared/memory/retrieval/cosine.ts","src/shared/memory/retrieval/embeddings.ts","src/shared/memory/retrieval/hnsw.ts","src/shared/memory/retrieval/inverted-index.ts","src/shared/memory/retrieval/rrf.ts","src/shared/memory/retrieval/tfidf.ts"],
    }),
    moduleContract({
      id: "shared-memory-retrieval-rrf", path: "src/shared/memory/retrieval/rrf.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 1, namesSha256: "9edddd7bb16a827b0f0441e4a69649914b945abae50a29a5f2d265b8fee44f63" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "shared-memory-retrieval-text-utils", path: "src/shared/memory/retrieval/text-utils.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 5, namesSha256: "654658b6a3cca7a4f27d9cc5557d4f893344883df25f28f68a1c2b4c4aa562f3" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-memory-retrieval-tfidf", path: "src/shared/memory/retrieval/tfidf.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 7, namesSha256: "a421473d16b85eba855fd935e63b3e86f16a736f7f5574cf84cb9a1fa685b682" },
      dependencies: ["src/kernel/integrity.ts","src/shared/memory/retrieval/cosine.ts","src/shared/memory/retrieval/text-utils.ts"],
    }),
    moduleContract({
      id: "shared-memory-retrieval-types", path: "src/shared/memory/retrieval/types.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-retrieval", publicApi: { exportCount: 2, namesSha256: "d9d4c3f34b8f87946549a6390f86357fe9404242ab9602cf521225ae8b7d9a16" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-memory-shared-memory-store", path: "src/shared/memory/shared-memory-store.ts", realm: "shared", layer: "domain",
      owner: "shared-memory", publicApi: { exportCount: 6, namesSha256: "2833e683118187fb5f1b605d7971a68149f25c7ba434558d54e669d1aa6bfc83" },
      dependencies: ["node:fs","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/debug/debug-system.ts","src/shared/memory/ebbinghaus.ts","src/shared/memory/memory-config.ts","src/shared/memory/memory-entry.ts","src/shared/memory/memory-tree.ts","src/shared/memory/retrieval/embeddings.ts","src/shared/memory/retrieval/retriever.ts","src/shared/memory/retrieval/text-utils.ts","src/shared/memory/storage/backend.ts","src/shared/memory/token-cap.ts"],
    }),
    moduleContract({
      id: "shared-memory-storage-append-log-backend", path: "src/shared/memory/storage/append-log-backend.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-storage", publicApi: { exportCount: 1, namesSha256: "63eda8625696b8392810ae2243002cd554550dd645f3eec3b988d4bbe868143f" },
      dependencies: ["node:fs","src/shared/debug/debug-system.ts","src/shared/memory/storage/serde.ts"], effects: ["filesystem-read","filesystem-write"], executionBoundary: "effect-adapter",
    }),
    moduleContract({
      id: "shared-memory-storage-backend", path: "src/shared/memory/storage/backend.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-storage", publicApi: { exportCount: 4, namesSha256: "6fa740dba38b46b572bf8913561f9f12d21838039358ccd2602b38be11c886ba" },
      dependencies: ["node:os","node:path","src/filesystem/private-state.ts","src/kernel/errors.ts","src/shared/memory/storage/append-log-backend.ts","src/shared/memory/storage/json-backend.ts","src/shared/memory/storage/msgpack-backend.ts","src/shared/memory/storage/sqlite-backend.ts"],
    }),
    moduleContract({
      id: "shared-memory-storage-json-backend", path: "src/shared/memory/storage/json-backend.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-storage", publicApi: { exportCount: 2, namesSha256: "d021523fc63019f0a320a3a6da482b58ad42e44a27ab673082b6e1f959abb0d4" },
      dependencies: ["node:fs","src/shared/memory/storage/serde.ts"], effects: ["filesystem-read","filesystem-write"], executionBoundary: "effect-adapter",
    }),
    moduleContract({
      id: "shared-memory-storage-msgpack-backend", path: "src/shared/memory/storage/msgpack-backend.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-storage", publicApi: { exportCount: 4, namesSha256: "847022843082c51457569461d2dd86d2ebf8a0c2cd219e1dadcd435c2cf980df" },
      dependencies: ["node:fs","src/kernel/errors.ts","src/shared/memory/storage/serde.ts"], effects: ["filesystem-read","filesystem-write"], executionBoundary: "effect-adapter",
    }),
    moduleContract({
      id: "shared-memory-storage-serde", path: "src/shared/memory/storage/serde.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-storage", publicApi: { exportCount: 6, namesSha256: "e7bdcd7bdec2be9387e2bccc6d7ba81c32d157c62b31fb484b3a4693a49be5dd" },
      dependencies: ["src/shared/debug/debug-system.ts","src/shared/memory/memory-entry.ts"],
    }),
    moduleContract({
      id: "shared-memory-storage-sqlite-backend", path: "src/shared/memory/storage/sqlite-backend.ts", realm: "shared", layer: "domain",
      owner: "shared-memory-storage", publicApi: { exportCount: 1, namesSha256: "b549e4bbb7862d6ca041bebb28a81966013647e9d91335514bac255b265346a3" },
      dependencies: ["node:module","node:sqlite","src/kernel/errors.ts","src/shared/memory/storage/serde.ts"], effects: ["filesystem-read","filesystem-write","environment-access"], executionBoundary: "effect-adapter",
    }),
    moduleContract({
      id: "shared-memory-token-cap", path: "src/shared/memory/token-cap.ts", realm: "shared", layer: "domain",
      owner: "shared-memory", publicApi: { exportCount: 3, namesSha256: "a08dea4bba853e5a099e6c549e7ff5b691beb6b5401b0c0babc8a871bf3b487e" },
      dependencies: ["src/shared/memory/ebbinghaus.ts"],
    }),
    moduleContract({
      id: "shared-path-utils", path: "src/shared/path-utils.ts", realm: "shared", layer: "domain",
      owner: "shared-path-utils", publicApi: { exportCount: 2, namesSha256: "e835950a7e5d95a5df32c042c890fdf3dafbb0c7390e59d04876573d4048d633" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-similarity", path: "src/shared/similarity.ts", realm: "shared", layer: "domain",
      owner: "shared-similarity", publicApi: { exportCount: 5, namesSha256: "f00c40241e233faf2e84e49c9512604b0f34359e1508960c9638b0fbbbd9fe3b" },
      dependencies: [],
    }),
    moduleContract({
      id: "shared-type-guards", path: "src/shared/type-guards.ts", realm: "shared", layer: "domain",
      owner: "shared-type-guards", publicApi: { exportCount: 7, namesSha256: "0984e5abdd7852b093ba026a6ef194062797cca9a59f4ff6c4b205a8bedd8ed6" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "shared-workflow-e2e-runner", path: "src/shared/workflow/e2e-runner.mjs", realm: "shared", layer: "domain",
      owner: "shared-workflow", publicApi: { exportCount: 3, namesSha256: "ae9d80a66eb30d7dab9d796243f1ad282677aa8dc9f9ff939e483aa413219c81" },
      dependencies: ["node:child_process","node:fs","node:path","node:url"], effects: ["filesystem-read","filesystem-write","child-process"], executionBoundary: "composition-root", compositionRoot: true,
    }),
    moduleContract({
      id: "shared-workflow-manifest-schema", path: "src/shared/workflow/manifest-schema.mjs", realm: "shared", layer: "domain",
      owner: "shared-workflow", publicApi: { exportCount: 7, namesSha256: "650cbb263ff553ff702e582d3adb76bfb330cf05ef3a55c45b82841ee4f497a6" },
      dependencies: ["node:fs"], effects: ["filesystem-read","filesystem-write"], executionBoundary: "effect-adapter",
    }),
    moduleContract({
      id: "shared-workflow-module-owners", path: "src/shared/workflow/module-owners.mjs", realm: "shared", layer: "domain",
      owner: "shared-workflow", publicApi: { exportCount: 5, namesSha256: "c529ead4bff5d5d1e843415338d189c50fc7049947a09a768fdf487e3f036795" },
      dependencies: ["node:fs"], effects: ["filesystem-read","filesystem-write"], executionBoundary: "effect-adapter",
    }),
    moduleContract({
      id: "shared-git-churn", path: "src/shared/git-churn.ts", realm: "shared", layer: "domain",
      owner: "shared-git-churn", publicApi: { exportCount: 9, namesSha256: "970674bc0974e6d6eee7747b5bac3874a0d4835117ab0ce6afbf6cfada9d0893" },
      dependencies: ["node:child_process","src/kernel/errors.ts","src/shared/git-churn-config.ts","src/shared/stats.ts"], effects: ["child-process"], executionBoundary: "effect-adapter",
    }),
    moduleContract({
      id: "shared-git-churn-config", path: "src/shared/git-churn-config.ts", realm: "shared", layer: "domain",
      owner: "shared-git-churn", publicApi: { exportCount: 2, namesSha256: "e58f9077bd8606c6cf21b926fd0aa0d3ddd99c34c1a7347e418cd78a7dd2f930" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "shared-stats", path: "src/shared/stats.ts", realm: "shared", layer: "domain",
      owner: "shared-stats", publicApi: { exportCount: 5, namesSha256: "32435c5c72439f738de65558e77358ea0dafc4d5b25d3d2ec50584690e20480c" },
      dependencies: [],
    }),
    moduleContract({
      id: "duplicate-body-types", path: "src/quality-packs/prevention/duplicate-body-types.ts", realm: "shared", layer: "domain",
      owner: "quality-packs", publicApi: { exportCount: 13, namesSha256: "ee9acee353b72ee6220281d510c9c95587b822db511c35a19a771029cf62d6bd" },
      dependencies: ["src/quality-packs/quality-config.ts"],
    }),
    moduleContract({
      id: "src-agents-stigmergy-coordination", path: "src/agents/stigmergy-coordination.ts", realm: "runtime", layer: "domain",
      owner: "agents", publicApi: { exportCount: 7, namesSha256: "0f52266ad98be04a8df377ceff66aac5cfbdd6b499189a151bbd4f3a0a241f61" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-aux-index", path: "src/aux/index.ts", realm: "runtime", layer: "domain",
      owner: "aux", publicApi: { exportCount: 38, namesSha256: "26901883ad1cbf962afa8c398de0fc1367879b284a30a3c46e067ad324a6e176" },
      dependencies: ["src/awareness/config.ts","src/quality/index.ts","src/shared/exposure/action.ts","src/shared/exposure/customization.ts","src/shared/exposure/signal.ts"],
    }),
    moduleContract({
      id: "src-awareness-compact", path: "src/awareness/compact.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "77555b0bd236a4e630e3877261386ddf96b564e120552050652526f00addee6f" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-config", path: "src/awareness/config.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 9, namesSha256: "b7e518acde4d953ea4d03b5f167c08bdfbb749493308f5afb6472202f24a78a9" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-awareness-delta", path: "src/awareness/delta.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 3, namesSha256: "8d803487ab996fe713eae464e97a63b8d42e6af8545157aa75e9f28c8da8cc5f" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-engine", path: "src/awareness/engine.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 2, namesSha256: "4c9eea3465262f41b719302eb512b85bee3cc503a6c42e1e99feff0a4d2dd0bb" },
      dependencies: ["node:fs","node:path","src/awareness/compact.ts","src/awareness/config.ts","src/awareness/languages/generic.ts","src/awareness/languages/index.ts","src/awareness/signals/ag-spectrum.ts","src/awareness/signals/architecture.ts","src/awareness/signals/banach-contraction.ts","src/awareness/signals/bell-clones.ts","src/awareness/signals/benford.ts","src/awareness/signals/chromatic-number.ts","src/awareness/signals/clones.ts","src/awareness/signals/code-metrics.ts","src/awareness/signals/combinatorics.ts","src/awareness/signals/complexity.ts","src/awareness/signals/debt.ts","src/awareness/signals/dependencies.ts","src/awareness/signals/diversity.ts","src/awareness/signals/drift.ts","src/awareness/signals/edit-predictability.ts","src/awareness/signals/entropy.ts","src/awareness/signals/ergodic-drift.ts","src/awareness/signals/fiber-bundle.ts","src/awareness/signals/fiedler-bisection.ts","src/awareness/signals/fitness.ts","src/awareness/signals/free-probability.ts","src/awareness/signals/function-classification.ts","src/awareness/signals/function-stats.ts","src/awareness/signals/health.ts","src/awareness/signals/homology.ts","src/awareness/signals/hotspots.ts","src/awareness/signals/hub-stress.ts","src/awareness/signals/info-theory.ts","src/awareness/signals/linguistic-typology.ts","src/awareness/signals/martingale-debt.ts","src/awareness/signals/maxwell-demon.ts","src/awareness/signals/mechanism-design.ts","src/awareness/signals/module-roles.ts","src/awareness/signals/network.ts","src/awareness/signals/persistence-landscapes.ts","src/awareness/signals/physics.ts","src/awareness/signals/qec-distance.ts","src/awareness/signals/quality.ts","src/awareness/signals/quantum-stability.ts","src/awareness/signals/recursion-hierarchy.ts","src/awareness/signals/ricci-curvature.ts","src/awareness/signals/risk.ts","src/awareness/signals/shape-dna.ts","src/awareness/signals/sheaf-cohomology.ts","src/awareness/signals/test-coverage.ts","src/awareness/signals/thermodynamics.ts","src/awareness/signals/topos.ts","src/awareness/signals/trending.ts","src/awareness/signals/turing-treadmills.ts","src/awareness/signals/type-level.ts","src/awareness/signals/wavelet-clones.ts","src/awareness/types.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-awareness-fisher-ranking", path: "src/awareness/fisher-ranking.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 4, namesSha256: "6bb414068b6559ba159150cdc332f9df0c2d95ade3a33650a03657851245897d" },
      dependencies: ["src/shared/numeric-helpers.ts","src/shared/stats.ts"],
    }),
    moduleContract({
      id: "src-awareness-languages-generic", path: "src/awareness/languages/generic.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 2, namesSha256: "fc1261e17b2cb797d6b32d43117bd1b05c6e4537124ff5b0523a41220c9a0dc2" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-languages-go-tree-sitter", path: "src/awareness/languages/go-tree-sitter.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "4a595673f6756b2e29bcc00fd0d88d994bb936bde0b63b2f31206692d9c54072" },
      dependencies: ["src/awareness/language-helpers.ts","src/awareness/languages/go.ts","src/awareness/languages/tree-sitter-base.ts"],
    }),
    moduleContract({
      id: "src-awareness-languages-go", path: "src/awareness/languages/go.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "4a595673f6756b2e29bcc00fd0d88d994bb936bde0b63b2f31206692d9c54072" },
      dependencies: ["src/awareness/language-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-languages-index", path: "src/awareness/languages/index.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 6, namesSha256: "51256e9f6e8ec3518e9a41e082d2d52459744b0655b59c3a48d19c6efe90fd58" },
      dependencies: ["src/awareness/languages/generic.ts","src/awareness/languages/go-tree-sitter.ts","src/awareness/languages/python-tree-sitter.ts","src/awareness/languages/rust-tree-sitter.ts","src/awareness/languages/typescript.ts"],
    }),
    moduleContract({
      id: "src-awareness-languages-python-tree-sitter", path: "src/awareness/languages/python-tree-sitter.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "92d6e643d7f7f6295918cff1336b70364f56fa218998ae86618a7c9558b95a37" },
      dependencies: ["src/awareness/language-helpers.ts","src/awareness/languages/python.ts","src/awareness/languages/tree-sitter-base.ts"],
    }),
    moduleContract({
      id: "src-awareness-languages-python", path: "src/awareness/languages/python.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "92d6e643d7f7f6295918cff1336b70364f56fa218998ae86618a7c9558b95a37" },
      dependencies: ["src/awareness/language-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-languages-rust-tree-sitter", path: "src/awareness/languages/rust-tree-sitter.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "d739b80a7e7ab22e2694002ba70409c92dbee570d56f224fc972c5c7fd183430" },
      dependencies: ["src/awareness/language-helpers.ts","src/awareness/languages/rust.ts","src/awareness/languages/tree-sitter-base.ts"],
    }),
    moduleContract({
      id: "src-awareness-languages-rust", path: "src/awareness/languages/rust.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "d739b80a7e7ab22e2694002ba70409c92dbee570d56f224fc972c5c7fd183430" },
      dependencies: ["src/awareness/language-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-languages-tree-sitter-base", path: "src/awareness/languages/tree-sitter-base.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 11, namesSha256: "69bb12b72512cb92636cd85dfb556c08776e34975b2d4da1cb956b25a2dfa155" },
      dependencies: ["node:module","src/kernel/errors.ts","src/shared/debug/debug-system.ts","tree-sitter"],
    }),
    moduleContract({
      id: "src-awareness-languages-typescript", path: "src/awareness/languages/typescript.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "e1e246cc3a68dc6f1f3b32518c2072ae73b62e0230dfc30ebba68b5fd52a0e57" },
      dependencies: ["@babel/parser","src/awareness/language-helpers.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-awareness-multi-turn", path: "src/awareness/multi-turn.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 2, namesSha256: "89b0ea2e536edeadd1068798db2439aecbd508231a104adee6e59f32a8ccb988" },
      dependencies: ["src/awareness/delta.ts","src/awareness/engine.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-ag-spectrum", path: "src/awareness/signals/ag-spectrum.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "82a8e375b38a4ccad53a33c2d0f273cd89f5c71e92a957aa3c2e1c3f5ed10ef3" },
      dependencies: ["src/awareness/signals/clone-graph.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-architecture", path: "src/awareness/signals/architecture.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "85499a25d591ddb9abe303aef336e32794c828159b0797f34a9e426ca87c2708" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-banach-contraction", path: "src/awareness/signals/banach-contraction.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "623964ec6d98d9ee62530a5d906918896a0943bcbb7ca0042975c66fbdcef043" },
      dependencies: ["src/awareness/signals/clone-graph.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-bell-clones", path: "src/awareness/signals/bell-clones.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "c2a083ebe3ea28f27fc74d10dc4065693f4a5ffb8ebbadfc574f39d6b9b4c68f" },
      dependencies: ["src/awareness/signals/clone-graph.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-benford", path: "src/awareness/signals/benford.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "cfc55aa72dcf93da5466ced9b06e42dbad0b45a1dd7c65384530efa4a01f218f" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-chromatic-number", path: "src/awareness/signals/chromatic-number.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "7e86bbd673afec87f33848179209d5d16b19dee5c069877cb9055a3e42452095" },
      dependencies: ["src/awareness/signals/clone-graph.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-clone-graph", path: "src/awareness/signals/clone-graph.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 6, namesSha256: "cf6ae82590905d60f84d2e6403335b1e56fbc1382f5a0b50c90d415d263773e5" },
      dependencies: ["src/awareness/clone-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-clones", path: "src/awareness/signals/clones.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 2, namesSha256: "bdfb1b02b28f2a0be1d3536bf3df86a4fbeb26a74b1927852dcc68d4c263124f" },
      dependencies: ["src/awareness/clone-helpers.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-complexity", path: "src/awareness/signals/complexity.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "7bb721c4d689f65b836bafe55f423777ba3d8c4f21f52d9809f152af2ae09174" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-debt", path: "src/awareness/signals/debt.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "25ca08d7a15f4ecd65813a666579e44fb2d9a0e0b7133d1ff6e776b8aab92cf5" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-dependencies", path: "src/awareness/signals/dependencies.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "99ce67dc1fa8444170974c5c6c3578e7156565a8c3472970fa23769ac77f85cb" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-drift", path: "src/awareness/signals/drift.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "29a1c609d59ba3201ab679d18477aac1a2126462055e7f81c55139e1f6643205" },
      dependencies: ["src/shared/best-effort.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-edit-predictability", path: "src/awareness/signals/edit-predictability.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "1fbab93b7724710f21a2039fb7a716bb702f4f451a651799939b041e0a6a3757" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-entropy", path: "src/awareness/signals/entropy.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "5bc4e746b404d10a2707d9bdee8fd83daf7f6eb33353b56f62c974cff4858bbb" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-ergodic-drift", path: "src/awareness/signals/ergodic-drift.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "bf216257b3e0faf1c0811735343c8d7e2e8e7bc464bbd86f408b806d6509f7b6" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-fiber-bundle", path: "src/awareness/signals/fiber-bundle.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "e7c5f16c4fce6d90a4ce538e579de33a29b75e042dd18128d6072fdefbdad178" },
      dependencies: ["src/awareness/module-helpers.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-fiedler-bisection", path: "src/awareness/signals/fiedler-bisection.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 2, namesSha256: "d6a324a2630615e0113332d04f20f7bba62ab5cd83b8ea0db6a6ccd4009e6067" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-free-probability", path: "src/awareness/signals/free-probability.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "0b0b8679c2136e7fb70e30e025cd79818c4d0cfe9978c31933bed3b088daae66" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-function-classification", path: "src/awareness/signals/function-classification.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "120d378f295d5d49e8d6e9712167832d928bf174982063597ef9f2e416734937" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-function-stats", path: "src/awareness/signals/function-stats.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "4fc941471e010b44f677aeffaea246375b25a11c095a7a8278d3ffd20b33afa4" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-health", path: "src/awareness/signals/health.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "4c6dc64a5cc9bfd860318bf6498fe2dcd6b75f5438a0e39f2f66449f5022fc6a" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-signals-homology", path: "src/awareness/signals/homology.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 2, namesSha256: "b3f8cb6d4965535e4074878817ddfb17a5e44b4f0de03a078517f7735255dc5a" },
      dependencies: ["src/awareness/signals/clone-graph.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-hotspots", path: "src/awareness/signals/hotspots.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "630755258196505d3ae05b0fac59cc78175ed564719813c4bbd642f1f5096e19" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-signals-hub-stress", path: "src/awareness/signals/hub-stress.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "9c188d6f68880f40d2dd3eb46f4e04c7c0c9e9b435e0300c3ef6426a35d8f38f" },
      dependencies: ["src/awareness/signals/architecture.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-linguistic-typology", path: "src/awareness/signals/linguistic-typology.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "ca261e9d114636b6f0f406dd58c35a9279e951ba90a69681d3d6f5bfc3dfe829" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-martingale-debt", path: "src/awareness/signals/martingale-debt.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "0a25d5a0b237bf8de8eb48db7bc40b8cc27da59c43451979f988aa7993284639" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-maxwell-demon", path: "src/awareness/signals/maxwell-demon.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "c7f2857acb90e9ac1252d721a0444f48d045a44cd1b8ea2558acb95efb7488af" },
      dependencies: ["src/awareness/module-helpers.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-mechanism-design", path: "src/awareness/signals/mechanism-design.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "d532ac1cc7f70daa939933cae17bb5076e6759b3b1812529f407ea60ea160c17" },
      dependencies: ["src/awareness/signals/clone-graph.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-module-roles", path: "src/awareness/signals/module-roles.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "2dbdad12950be9374e4473490b9f98a3a8789fc07bb1e8a4b51846edf2097899" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-signals-persistence-landscapes", path: "src/awareness/signals/persistence-landscapes.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "7f3058fac16fd022e0b680916b52d5154970efbadf8d92325e5e3184fefacf07" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-qec-distance", path: "src/awareness/signals/qec-distance.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "5c31ea558652d45699ff2436e2fcb2e356cb330dee932ce1816bd94e4892edc6" },
      dependencies: ["src/awareness/signals/clone-graph.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-quality", path: "src/awareness/signals/quality.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "e6937bacecfb889ef443d7a2d4934ea2b64ab1feaab85f84054739d6d82ff801" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-quantum-stability", path: "src/awareness/signals/quantum-stability.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "015e7ff7063254f171ee09a0cca40273c16821016c4c5fb9b37b8673abdd52de" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-recursion-hierarchy", path: "src/awareness/signals/recursion-hierarchy.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "d77c4ff7416bd2f2afb1e23b727873d29b716c28abdf6a720940049b8a8c54bd" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-ricci-curvature", path: "src/awareness/signals/ricci-curvature.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 2, namesSha256: "266d3a971833dd88c3cc783b39fb142c6710e874b17a164431919a7663e071d8" },
      dependencies: ["src/awareness/signals/architecture.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-risk", path: "src/awareness/signals/risk.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "3ce6f1cdb03c9aae30cd8567a7e66fe79f26424977885e39986f0c438210749b" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-signals-shape-dna", path: "src/awareness/signals/shape-dna.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "0e0c07fa7069697e185d5d26ef6c9d81b5893eb6e43002b9f4b974cd9ac47114" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-sheaf-cohomology", path: "src/awareness/signals/sheaf-cohomology.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "49f55de61921381036c9109971102e04950d95696d5adb1dd10a0429ebd3f305" },
      dependencies: ["src/awareness/module-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-test-coverage", path: "src/awareness/signals/test-coverage.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "b7296d96448487421e49984b071d38dd068f54639fd457e1d013f4585256dcee" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-thermodynamics", path: "src/awareness/signals/thermodynamics.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "db10bf83172a3a4f45127815639ae098956d423db792748d12caad89a271230b" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-topos", path: "src/awareness/signals/topos.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "8211a8a4e855a94197de3058ceca01cfcf13900da113ee0fa7831e4b310a54f9" },
      dependencies: ["src/awareness/module-helpers.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-trending", path: "src/awareness/signals/trending.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "26fffec02a581b48cee6f5949d6c6f501c7a5fe6c879a3f9a7de286f27b63114" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-signals-turing-treadmills", path: "src/awareness/signals/turing-treadmills.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "702dc47bf736f7e9e7653004719eff59a1158cd908ae388ffca922e171605420" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-signals-type-level", path: "src/awareness/signals/type-level.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "110c3d8e71b754e3252c9ab8c6601088b92e25247aa3c6b631df0754c2ec143f" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-wavelet-clones", path: "src/awareness/signals/wavelet-clones.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "eef7ec84d8b01e2e85e2443d995d6bca184efb4ba31b1235a4b3032fbe2058a5" },
      dependencies: ["src/awareness/clone-helpers.ts","src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-temperature", path: "src/awareness/temperature.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 9, namesSha256: "97cc30222779d622fb01a1f13e7e3b442d36341980138302dcbd6a83f886b273" },
      dependencies: ["src/awareness/config.ts","src/kernel/integrity.ts","src/shared/git-churn.ts"],
    }),
    moduleContract({
      id: "src-awareness-types", path: "src/awareness/types.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 11, namesSha256: "1b5d10b8a6cfade0b3069589f0e3b3cc39516a71445fc41e8375257462f2125e" },
      dependencies: ["src/kernel/product-identity.ts"],
    }),
    moduleContract({
      id: "src-cli", path: "src/cli.mjs", realm: "runtime", layer: "domain",
      owner: "cli", publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      dependencies: ["node:fs","node:path","src/tools/concurrent/long-task-runner.ts"], executionBoundary: "composition-root", compositionRoot: true, effects: ["child-process","filesystem-read","filesystem-write","process-status"],
    }),
    moduleContract({
      id: "src-editor-monotone-complexity-guard", path: "src/editor/monotone-complexity-guard.ts", realm: "runtime", layer: "domain",
      owner: "editor", publicApi: { exportCount: 4, namesSha256: "8b41b3f9ee9866373927db3933ed18a9ba1d8f558330784507a6a9ac88775c2c" },
      dependencies: ["src/editor/monotone-complexity-guard-config.ts","src/kernel/integrity.ts","src/quality-packs/prevention/duplicate-body-detector.ts"],
    }),
    moduleContract({
      id: "src-editor-monotone-complexity-guard-config", path: "src/editor/monotone-complexity-guard-config.ts", realm: "runtime", layer: "domain",
      owner: "editor", publicApi: { exportCount: 2, namesSha256: "e0826fa1256c170752ba6c47188daa40f5e9ec6c8ce15bb6b67286a617d48626" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-intelligence-action-affinity", path: "src/intelligence/action-affinity.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 6, namesSha256: "6fb1041ff9b12cb0f65d1399446c9edac59458ac4fa3bcca7043bfb6d2a0a075" },
      dependencies: ["src/intelligence/action-affinity-config.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-intelligence-action-affinity-config", path: "src/intelligence/action-affinity-config.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 2, namesSha256: "9a0a9796e9fcc846d886422807d3cbe6d008fe91a8f20d8bd9cec6eb8dadbe0d" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-intelligence-multi-import-extractor", path: "src/intelligence/multi-import-extractor.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 2, namesSha256: "ccc667ece9c55d16a1c84ec12de2e34d5a41dd1cff4e5903940fbabb9a4d83e2" },
      dependencies: ["src/intelligence/language-registry.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-intelligence-file-slice", path: "src/intelligence/file-slice.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 5, namesSha256: "691529bb784c8a17b274fbed671b055c504397706f7b678ec2443a1234550173" },
      dependencies: ["@babel/parser","node:fs","node:path","src/intelligence/intelligence-config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/quality-packs/prevention/ast-helpers.ts","src/shared/debug/debug-system.ts","src/shared/source-extensions.ts"],
    }),
    moduleContract({
      id: "src-intelligence-language-registry", path: "src/intelligence/language-registry.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 9, namesSha256: "1aaee59f20b0ab1c9b4c942f17650f38aa2cc133ce4bbe53bc296d866ac3fbf1" },
      dependencies: ["src/kernel/integrity.ts","src/shared/path-utils.ts"],
    }),
    moduleContract({
      id: "src-intelligence-next-edit-prefetch", path: "src/intelligence/next-edit-prefetch.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 4, namesSha256: "11ce1f65d16416e0ec94a186f948156f1d307ab69ee6d19ce1ce3d689e4b415e" },
      dependencies: ["src/intelligence/intelligence-config.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-intelligence-quick-view", path: "src/intelligence/quick-view.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 7, namesSha256: "243001f39d80a5bf6514369d4fd51bf0e9a77269edf57e97632056c44ecd8a52" },
      dependencies: ["@babel/parser","node:fs","node:path","src/intelligence/intelligence-config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/quality-packs/prevention/ast-helpers.ts","src/shared/debug/debug-system.ts","src/shared/source-extensions.ts"],
    }),
    moduleContract({
      id: "src-intelligence-tree-sitter-backend", path: "src/intelligence/tree-sitter-backend.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 9, namesSha256: "88cd9aef37da738b6bbe0864ff8c92996bc04aba7b27668b4eccc9e8cb6ee842" },
      dependencies: ["node:fs","node:fs/promises","node:path","node:url","src/intelligence/language-registry.ts","src/kernel/errors.ts","src/shared/best-effort.ts","web-tree-sitter"],
    }),
    moduleContract({
      id: "src-intelligence-tree-sitter-extractor", path: "src/intelligence/tree-sitter-extractor.ts", realm: "runtime", layer: "domain",
      owner: "intelligence", publicApi: { exportCount: 1, namesSha256: "ed5f81e818c740d604f23fb3fb302d5a28b562d3af690f9f204dfdc91a2d0e50" },
      dependencies: ["src/intelligence/language-registry.ts","src/intelligence/multi-import-extractor.ts","src/intelligence/tree-sitter-backend.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-mcp-auth", path: "src/mcp/auth.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 4, namesSha256: "4b2a118aa403a29658820fdc617076dd74b49b711196a7c3174d8d073e0cc945" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-mcp-config", path: "src/mcp/config.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 10, namesSha256: "a8f5869478f381d6add6236cf7dcef9f8aeb977799524da2f5ea8ce2a74f367e" },
      dependencies: ["src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/mcp/errors.ts","src/mcp/tool-name.ts","src/process/environment-projection.ts"],
    }),
    moduleContract({
      id: "src-mcp-core", path: "src/mcp/core.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 13, namesSha256: "aadc3e842b680f1ab1a59c480e0b2d9d63d18d2639a86415a5e2645440bf3e57" },
      dependencies: ["src/kernel/errors.ts","src/kernel/root-policy.ts","src/mcp/errors.ts","src/mcp/transport/types.ts","src/process/fault-policy.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts","zod"],
    }),
    moduleContract({
      id: "src-mcp-errors", path: "src/mcp/errors.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 1, namesSha256: "940b06a8cd7ee4a3b137ee3dbe7edae10b84a4770ac1e2557df43afd9ad94162" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-mcp-exposure", path: "src/mcp/exposure.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 6, namesSha256: "2bb888d5fc52cd5f3fb598308ea0c8df31223e37de91c761f8ab5fdc0d161ae7" },
      dependencies: ["src/kernel/integrity.ts","src/mcp/auth.ts","src/mcp/headers.ts"],
    }),
    moduleContract({
      id: "src-mcp-factory", path: "src/mcp/factory.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 5, namesSha256: "a52a500608d2c77316e01e01bbc12583356b88ffe8156a5213bb7d6f788e0e3b" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/mcp/auth.ts","src/mcp/config.ts","src/mcp/core.ts","src/mcp/errors.ts","src/mcp/headers.ts","src/mcp/transport/stdio.ts","src/mcp/transport/streamable-http.ts","src/mcp/transport/websocket.ts"],
    }),
    moduleContract({
      id: "src-mcp-headers", path: "src/mcp/headers.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 3, namesSha256: "7fa0640456dd3106f01f1e6418ac6b321c73cada80e45859bb68b89a5a56fa38" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-mcp-index", path: "src/mcp/index.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 73, namesSha256: "31bea5c08dbbebbbdf536ff0df1017a3dce6b6f6b113083d2d5d947447ca9995" },
      dependencies: ["src/mcp/auth.ts","src/mcp/config.ts","src/mcp/core.ts","src/mcp/errors.ts","src/mcp/exposure.ts","src/mcp/factory.ts","src/mcp/headers.ts","src/mcp/registry.ts","src/mcp/retry.ts","src/mcp/tool-adapter.ts","src/mcp/tool-name.ts","src/mcp/transport/stdio.ts","src/mcp/transport/streamable-http.ts","src/mcp/transport/websocket.ts"],
    }),
    moduleContract({
      id: "src-mcp-registry", path: "src/mcp/registry.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 10, namesSha256: "fb9a09c6385d62f0c8de0c52902a4e102c246c680d850827ac8b2c4a4df7e764" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/mcp/config.ts","src/mcp/errors.ts","src/mcp/factory.ts","src/mcp/retry.ts","src/mcp/tool-adapter.ts","src/mcp/tool-name.ts","src/shared/best-effort.ts"],
    }),
    moduleContract({
      id: "src-mcp-retry", path: "src/mcp/retry.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 8, namesSha256: "2722d6a1ceca1f8ce41daa70cb99ed97c7daeeaff0142b7b044c89d7b83b71fe" },
      dependencies: ["src/kernel/errors.ts","src/mcp/errors.ts","src/shared/abort-signals.ts","src/shared/backoff.ts"],
    }),
    moduleContract({
      id: "src-mcp-tool-adapter", path: "src/mcp/tool-adapter.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 4, namesSha256: "3cd5afbcd0e0fa1530ef5dbf67ec4af8a196879143a41488cc40d5fdb48398d5" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/tools/tool-adapter.ts","src/tools/tool-manifest.ts"],
    }),
    moduleContract({
      id: "src-mcp-transport-stdio", path: "src/mcp/transport/stdio.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 2, namesSha256: "d4cfe059496cddcd72a1bb53d99e56e72a5657b0d2b48340073be0c4dad5e941" },
      dependencies: ["src/kernel/errors.ts","src/mcp/errors.ts","src/mcp/transport/helpers.ts","src/process/fault-policy.ts"],
    }),
    moduleContract({
      id: "src-mcp-transport-types", path: "src/mcp/transport/types.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 6, namesSha256: "387178d7c2b13ce2586eddb438bc355efffd7527e0e3bac877ee9ca4e3d4d119" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-mcp-transport-websocket", path: "src/mcp/transport/websocket.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 2, namesSha256: "25fcc13b53f9b518e44d7f52a5088bf3d99fb4a5af685ae77ada0446d7ffc143" },
      dependencies: ["src/mcp/errors.ts","src/mcp/transport/types.ts","src/process/fault-policy.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts","src/shared/outbound-http.ts","src/shared/outbound-policy.ts"],
    }),
    moduleContract({
      id: "src-memory-scale-memory-store-1b", path: "src/memory/scale/memory-store-1b.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 7, namesSha256: "7b09d5522f05a6df901cd3931c51e0ae82af0b9cab62fdab2ff4acc5a54bef26" },
      dependencies: ["node:fs","node:module","node:os","node:path","node:sqlite","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/memory/memory-types.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-memory-scale-scale-config", path: "src/memory/scale/scale-config.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 2, namesSha256: "8390f9310849db28cba014dc9cb5c608e646c56af1deedf98d967dc54a04ea79" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-memory-tool-result-exposure", path: "src/memory/tool-result-exposure.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 1, namesSha256: "e4d344bd93095d5ba720a73a8af171a7bc4a367eb12f6927d580bb8b3cc9120d" },
      dependencies: ["src/shared/exposure/registry.ts"],
    }),
    moduleContract({
      id: "src-memory-tool-result-retrieval", path: "src/memory/tool-result-retrieval.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 18, namesSha256: "f4848509729c0ce4a3f2bed0a7ff44a7464f61e7ceaa12fd5b465e22f83ce73e" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/memory/retrieval/cosine.ts","src/shared/memory/retrieval/text-utils.ts","src/shared/memory/retrieval/tfidf.ts"],
    }),
    moduleContract({
      id: "src-memory-tool-result-store", path: "src/memory/tool-result-store.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 15, namesSha256: "b74d4f81912c30d10396d384938bf53fc5c03ad67aca368d74401a8207a9d6c0" },
      dependencies: ["src/kernel/integrity.ts","src/memory/memory-types.ts","src/memory/tool-result-retrieval.ts","src/memory/tool-result-summary.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-memory-tool-result-summary", path: "src/memory/tool-result-summary.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 11, namesSha256: "610fca795870689617ed3f9e296e8ee75ce917c409f8dad951facd598395728d" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-cache", path: "src/memory/unified/cache.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 1, namesSha256: "9ffdefc03cb1ea89b74efc0e4a7acf7832c94c342505bfac67d660303b3e2d67" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-content-store", path: "src/memory/unified/content-store.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 1, namesSha256: "4fef77f86b49370a0d944b8f28bf94782c4f7138912404ed7ec2a147b6da8096" },
      dependencies: ["node:fs","src/kernel/errors.ts","src/shared/best-effort.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-conversation-summary", path: "src/memory/unified/conversation-summary.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 3, namesSha256: "3ca8db7e525e2d85fb3ce71f6bef51ab7c4da93e1eb2a69c7794648e3b1a7ddd" },
      dependencies: ["src/kernel/errors.ts","src/memory/unified/tokenizer.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-drift-detector", path: "src/memory/unified/drift-detector.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 5, namesSha256: "74de98e617b20d7a19a7e85162db987df9360170bdb5e366bc68ff4d6acd6f0e" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/memory/unified/tokenizer.ts","src/shared/abort-signals.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts","src/shared/llm/config.ts","src/shared/llm/provider-http.ts","src/shared/outbound-http.ts","src/shared/outbound-policy.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-ebbinghaus", path: "src/memory/unified/ebbinghaus.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 6, namesSha256: "b48a0bb682f4d27d74c76b239e1172c76ff223ea3cd4306d8c5772506ca4e957" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-unified-embeddings", path: "src/memory/unified/unified-embeddings.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 7, namesSha256: "6101df4507f21e7a3f7bde02e3e05cf4968fef16ed2050450c6d899da779a67c" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-index", path: "src/memory/unified/index.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      dependencies: ["src/memory/unified/cache.ts","src/memory/unified/content-store.ts","src/memory/unified/conversation-summary.ts","src/memory/unified/drift-detector.ts","src/memory/unified/ebbinghaus.ts","src/memory/unified/unified-embeddings.ts","src/memory/unified/unified-inverted-index.ts","src/memory/unified/proactive-injector.ts","src/memory/unified/tokenizer.ts","src/memory/unified/unified-tool-result-store.ts","src/memory/unified/trust-enforcer.ts","src/memory/unified/unified-config.ts","src/memory/unified/unified-context-manager.ts","src/memory/unified/unified-memory-store.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-unified-inverted-index", path: "src/memory/unified/unified-inverted-index.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 2, namesSha256: "a0f14d4d80c65f0bdcb28657455ea3ef74091fc3868a0a8875301f84b18d0ee1" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-proactive-injector", path: "src/memory/unified/proactive-injector.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 6, namesSha256: "189e25a7d228e3b6916f6137733f2d14a0717c3bffa768361a3b52f71c052059" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-tokenizer", path: "src/memory/unified/tokenizer.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 6, namesSha256: "827572ac8ae027a0bfa0fdb3b9b95f018e5db2fea2be69cf6f856099af5be104" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-unified-tool-result-store", path: "src/memory/unified/unified-tool-result-store.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 12, namesSha256: "b508673627a608bfd3fd2a8a5b8fcce3f0b6ea6a01b4559b1a5dea04570bf148" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/memory/memory-config.ts","src/memory/unified/tokenizer.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-trust-enforcer", path: "src/memory/unified/trust-enforcer.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 7, namesSha256: "e757390669c2ddcf3c4a9cf6b1fa00d26f175da67c0beb1379556347c235c533" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/memory/memory-config.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-unified-config", path: "src/memory/unified/unified-config.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 5, namesSha256: "23d5527436c31e7ba2df12511129d410ba7ee5ded3e22b8ca0ca68d35625a67b" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/memory/unified/drift-detector.ts","src/memory/unified/ebbinghaus.ts","src/memory/unified/proactive-injector.ts","src/memory/unified/tokenizer.ts","src/memory/unified/trust-enforcer.ts","src/memory/unified/unified-embeddings.ts","src/memory/unified/unified-tool-result-store.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-unified-context-manager", path: "src/memory/unified/unified-context-manager.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 14, namesSha256: "75a58b4426c7450107e7110630b4344ec9efebc21d49bc533bfeb1df9e9d092e" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/memory/context-helpers.ts","src/memory/unified/conversation-summary.ts","src/memory/unified/tokenizer.ts","src/memory/unified/unified-tool-result-store.ts","src/shared/dependency-spans.ts","src/shared/llm/response-transcript.ts"],
    }),
    moduleContract({
      id: "src-memory-unified-unified-memory-store", path: "src/memory/unified/unified-memory-store.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 8, namesSha256: "8c880a6aae229821640bd5275c4826095caf34f4163110221c7cf0cf0ae60f89" },
      dependencies: ["node:os","node:path","src/filesystem/private-state.ts","src/kernel/integrity.ts","src/memory/unified/cache.ts","src/memory/unified/content-store.ts","src/memory/unified/ebbinghaus.ts","src/memory/unified/tokenizer.ts","src/memory/unified/unified-embeddings.ts","src/memory/unified/unified-inverted-index.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-quality-packs-prevention-embedding-provider", path: "src/quality-packs/prevention/embedding-provider.ts", realm: "runtime", layer: "domain",
      owner: "quality-packs", publicApi: { exportCount: 5, namesSha256: "7485ca7f7ff47d6a6fc341bcd9b18599deb3256bcdc2dbabc2cdaf96a653a3ca" },
      dependencies: ["src/shared/memory/retrieval/cosine.ts","src/shared/memory/retrieval/embeddings.ts"],
    }),
    moduleContract({
      id: "src-quality-packs-prevention-le-chatelier-bandaid", path: "src/quality-packs/prevention/le-chatelier-bandaid.ts", realm: "runtime", layer: "domain",
      owner: "quality-packs", publicApi: { exportCount: 6, namesSha256: "94fc8010b42cb19894830883ed420863248725f0408508a1f0d132a8f36f163d" },
      dependencies: ["src/kernel/integrity.ts","src/quality-packs/prevention/novel-principles-config.ts","src/shared/git-churn.ts"],
    }),
    moduleContract({
      id: "src-quality-packs-prevention-tierra-dead-code", path: "src/quality-packs/prevention/tierra-dead-code.ts", realm: "runtime", layer: "domain",
      owner: "quality-packs", publicApi: { exportCount: 6, namesSha256: "1ecf5f2023ef8b50b5ab4742d4655920c261cbe5c3694c1f1bc21beac2b29f74" },
      dependencies: ["src/kernel/integrity.ts","src/quality-packs/prevention/novel-principles-config.ts","src/shared/git-churn.ts"],
    }),
    moduleContract({
      id: "src-quality-packs-prevention-xenova-transformers-d", path: "src/quality-packs/prevention/xenova-transformers.d.ts", realm: "runtime", layer: "domain",
      owner: "quality-packs", publicApi: { exportCount: 4, namesSha256: "f66cc51c566b325be2ac3b358989b9928528daebae607c59b5f56f12f5cd7629" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-aggregator", path: "src/quality/aggregator.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 2, namesSha256: "9f2810b1d5372cb4e60e45dd4d30e9ade2e5e7562f95afb50bd233466a085bb7" },
      dependencies: ["src/quality/checks/circular-deps.ts","src/quality/checks/code-health-aggregate.ts","src/quality/checks/code-health.ts","src/quality/checks/complex-condition.ts","src/quality/checks/complexity.ts","src/quality/checks/dead-code.ts","src/quality/checks/dead-exports.ts","src/quality/checks/duplicate-imports.ts","src/quality/checks/duplicate-strings.ts","src/quality/checks/duplicates.ts","src/quality/checks/empty-function.ts","src/quality/checks/long-line.ts","src/quality/checks/long-params.ts","src/quality/checks/no-cond-assign.ts","src/quality/checks/no-constant-condition.ts","src/quality/checks/no-control-regex.ts","src/quality/checks/no-dupe-args.ts","src/quality/checks/no-dupe-class-members.ts","src/quality/checks/no-dupe-keys.ts","src/quality/checks/no-empty.ts","src/quality/checks/no-eval.ts","src/quality/checks/no-extra-boolean-cast.ts","src/quality/checks/no-extra-semi.ts","src/quality/checks/no-fallthrough.ts","src/quality/checks/no-implied-eval.ts","src/quality/checks/no-inner-declarations.ts","src/quality/checks/no-irregular-whitespace.ts","src/quality/checks/no-loss-of-precision.ts","src/quality/checks/no-throw-literal.ts","src/quality/checks/no-unreachable-code.ts","src/quality/checks/no-unsafe-finally.ts","src/quality/checks/no-unsafe-optional-chaining.ts","src/quality/checks/no-unused-expressions.ts","src/quality/checks/no-unused-labels.ts","src/quality/checks/no-var.ts","src/quality/checks/parse-errors.ts","src/quality/checks/performance-anti-pattern.ts","src/quality/checks/prefer-const.ts","src/quality/checks/race-condition.ts","src/quality/checks/security-hotspot.ts","src/quality/checks/shadowed-declaration.ts","src/quality/checks/unnecessary-type-assertion.ts","src/quality/checks/unreachable-catch.ts","src/quality/checks/unused-imports.ts","src/quality/checks/unused-type-parameter.ts","src/quality/languages/index.ts","src/quality/signals.ts"],
    }),
    moduleContract({
      id: "src-quality-base", path: "src/quality/base.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 17, namesSha256: "073d6804a93e4507ec4646f8ba2207a7c99abfa29a265c4096bc0868ecd50d43" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-barrel-detection", path: "src/quality/checks/barrel-detection.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 4, namesSha256: "f9ffe63450f9bed3bc5cd5c7f730917d6009b5a1576e88c6ee5e6973a8440997" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-circular-deps", path: "src/quality/checks/circular-deps.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "2783e0f5d628762465723251bf21b497b0ae390097f8c265f246d02c61bdd397" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-code-health-aggregate", path: "src/quality/checks/code-health-aggregate.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "16bd87bf3fb1b71d0cb73f7f52580237ed9bffaf8e5b44bddffaf56d067f6a8a" },
      dependencies: ["src/quality/checks/code-health.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-code-health", path: "src/quality/checks/code-health.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 5, namesSha256: "8ec21443095d505c8113346f0c6691674ed580c985361b22805e90d81f53e2a2" },
      dependencies: ["src/quality/checks/shared-helpers.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-complex-condition", path: "src/quality/checks/complex-condition.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "d90501cfd535c26f3628cb6c575bb426fb0c2873fb070a552e9d665fc4f4407d" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-complexity", path: "src/quality/checks/complexity.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 3, namesSha256: "c8c4ed3319cfb19dcb74107f0ee73b0cb132c31d2a383b08a4cf64a7a5f7d509" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-dead-code", path: "src/quality/checks/dead-code.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 5, namesSha256: "3b75320c826657d524794db9084ae6de8d58f3256e467b957f9702ead56fbcc6" },
      dependencies: ["src/quality/checks/barrel-detection.ts","src/quality/checks/shared-helpers.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-dead-exports", path: "src/quality/checks/dead-exports.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "5d3c462ca54bbd03510320c6d673f720fc9e91d2768251bdaa2da9a354ff5547" },
      dependencies: ["src/quality/checks/barrel-detection.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-duplicate-imports", path: "src/quality/checks/duplicate-imports.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "838b61591840a28c2ae7194455c03bafe12e3076d0663099ef4ddda179907b98" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-duplicate-strings", path: "src/quality/checks/duplicate-strings.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "05cca17c0973dc819a589f2bcb5c9479c6893950bd7ba42eea4eed5a7d96c5ec" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-duplicates", path: "src/quality/checks/duplicates.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "76146828654beb252d1a558f9bc4fd203f352d39695f6093b654ee0206f9476e" },
      dependencies: ["src/shared/similarity.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-empty-function", path: "src/quality/checks/empty-function.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "321dec73d45cb2291f96e6caa39e27415641076fabb1da43c17c4ba0b5b79f55" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-long-line", path: "src/quality/checks/long-line.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "5f58df69c910abede77574ab27c80b9de8579516dd2df9ec71881c2cc3dc7b35" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-long-params", path: "src/quality/checks/long-params.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "1b210dde792fd7ce2f513d8bf50a50a576518b8426cd83e2a21a1f926fecf972" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-no-cond-assign", path: "src/quality/checks/no-cond-assign.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "b88e5ca04686385e05556471e4ed2ee0304824a1bec2d5c98aa035702c0b9e79" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-constant-condition", path: "src/quality/checks/no-constant-condition.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "13acf4ec1683c635d566049488ddf3a6cb6a6e32162a38795cd6c47d98ab0caf" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-control-regex", path: "src/quality/checks/no-control-regex.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "3f007102fbb618ed3b021a254d1ecb52c70fcbcb053b6d74ae9097e331020f5a" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-dupe-args", path: "src/quality/checks/no-dupe-args.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "2dd597f96b3dbf6cd600cefbac44c4dbbd18f793cdba75947cd036774a15c3c5" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-dupe-class-members", path: "src/quality/checks/no-dupe-class-members.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "50ce2b96533f64215768d7ef3eb2b265c5c415ff0f5a839255ecb22b05ef01ed" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-dupe-keys", path: "src/quality/checks/no-dupe-keys.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "dee4d6b7754e8340e09becd369b1d74b2d3bb72b369c5e61b302ee1361a23a16" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-empty", path: "src/quality/checks/no-empty.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "c604289a66fa205096579d58f4adef5bc6af184e9f085ab2e14084418fe5bb34" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-eval", path: "src/quality/checks/no-eval.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "9f2fef1287fd728eb260d6813a91959979d26aaa471d08722a798a32e781bf9f" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-extra-boolean-cast", path: "src/quality/checks/no-extra-boolean-cast.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "b453354408082a7649ad5e2bd5edb3fc8d02a7185f6b07326b227ec09cdd200c" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-extra-semi", path: "src/quality/checks/no-extra-semi.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "afa8428da973eceab76f8457ec495253dd7f091490dda900d579992d6a604dc8" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-fallthrough", path: "src/quality/checks/no-fallthrough.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "1d25b1aa8be9d008c9b7a0d33cb10a64ba9c1bcf5703eb4900639735facd2138" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-implied-eval", path: "src/quality/checks/no-implied-eval.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "1e3c922b7870e01106dc12b3aefe8c3e8bd853fa8859507cb94748fb0a199297" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-inner-declarations", path: "src/quality/checks/no-inner-declarations.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "c58e9fe3a2ab741cf5dfc81f7e1ec240c06fef3d61cf6618a17c24a7c243c2ae" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-irregular-whitespace", path: "src/quality/checks/no-irregular-whitespace.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "aafbe588a1fcb5551824cc2ae79d9af98645ecd74c603873a7b3fa414d321bd5" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-no-loss-of-precision", path: "src/quality/checks/no-loss-of-precision.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "9db7f184f3f9687dcd29fe6bc5263861dfbeac30a64775a59b1ecc0a7d4de081" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-throw-literal", path: "src/quality/checks/no-throw-literal.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "d4848bae9ebc0e5945319081b6affe7247c0620ac4119316337f83eef001aa4f" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-unreachable-code", path: "src/quality/checks/no-unreachable-code.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "a3351f1ecc216b62f0fd16db94e8591b182fcb826d9c52d1f9b5c1529a490be2" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-unsafe-finally", path: "src/quality/checks/no-unsafe-finally.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "c547702758f8776630ca84c502e1478ef7719a5b086e67fff53dd288ca9ee5e6" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-unsafe-optional-chaining", path: "src/quality/checks/no-unsafe-optional-chaining.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "6a131491eb877e6124fc37106cd77a8227ffbe86f01d9d2fabc54eef23873022" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-unused-expressions", path: "src/quality/checks/no-unused-expressions.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "99367e3e71259ea7a17459221fcde4d55f2f2c4c3c71156dcbb463e8f7e9b415" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-unused-labels", path: "src/quality/checks/no-unused-labels.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "3d1d7cfaee3e1addb7dae89a0b8f9d8502ccea001f1a74700fb2130632a91ac2" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-no-var", path: "src/quality/checks/no-var.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "d62d3363691219eec0eeec643bc0e18c551feb12e017a22e7b4fc783913fd661" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-parse-errors", path: "src/quality/checks/parse-errors.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "762aba375b7cf9863af33bb25234795373d8293e77a6611d67131bd0aacee6d1" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-performance-anti-pattern", path: "src/quality/checks/performance-anti-pattern.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "a349672be7e42a080d7bf2b6a427857c9e073a7d7cc891a6abc0b3da37d1fda0" },
      dependencies: ["src/quality/checks/shared-helpers.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-prefer-const", path: "src/quality/checks/prefer-const.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "04768cb18c0064170654ed7a882df610cdcce29665d09b863ca84412774cc66c" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-race-condition", path: "src/quality/checks/race-condition.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "d2d994617145c20a72a2fc98eb68d65f9e4e4fbddecd3fcf2bc0f5a805009909" },
      dependencies: ["src/quality/checks/shared-helpers.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-security-hotspot", path: "src/quality/checks/security-hotspot.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "2d7bdd8fec13d264b427b5fd2e9ca50d63c03b97b1093d39209e96685db4f23b" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-shadowed-declaration", path: "src/quality/checks/shadowed-declaration.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "2d6fe2976e359833726d6391b0907ea567c5b9a7fc8f30251e77336de5f8577f" },
      dependencies: ["src/quality/checks/shared-helpers.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-shared", path: "src/quality/checks/shared.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 4, namesSha256: "21b237db4ece198f14d6e7ffdb0f257085c939d47b57eab66a7f444a4aad3789" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-unnecessary-type-assertion", path: "src/quality/checks/unnecessary-type-assertion.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "fcd067eeb5aba7d64de5ffe5521ceeba2bb84a8b6f938cf5e6f920a2fe64f07c" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-unreachable-catch", path: "src/quality/checks/unreachable-catch.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "6162cac867078d159e4e34319f4786ab2b2188a1c9ffcb0303743e89071df419" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-unused-imports", path: "src/quality/checks/unused-imports.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 2, namesSha256: "9017daa043860bca62f3d49f9e957d6ff769ddfaadf4c4395379b9fdf2ab724d" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-checks-unused-type-parameter", path: "src/quality/checks/unused-type-parameter.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "e77f107fec4258f751c728cfad5e15c7573901f6ea8950211c4a2a7d1dc5b585" },
      dependencies: ["src/quality/checks/shared.ts"],
    }),
    moduleContract({
      id: "src-quality-config", path: "src/quality/config.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 4, namesSha256: "1a6aa5916ccf72a951cbc7a82a191d3c83573d9f80dd7f2a8bdf0c479a08c6c2" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-index", path: "src/quality/index.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 12, namesSha256: "b66364f8c28f188c7dab3050a94410553e887ccdcb44ee025f87080365aba0c4" },
      dependencies: ["src/quality/aggregator.ts","src/quality/base.ts","src/quality/config.ts","src/quality/languages/index.ts","src/quality/monitoring.ts","src/quality/scoring.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-c-cpp-parser", path: "src/quality/languages/c-cpp/parser.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "40e0303d6ca9958da58e05688fede790499137792fc1cec84f5fb6fb7cb32cf5" },
      dependencies: ["src/quality/languages/shared/tree-sitter-loader.ts","src/quality/languages/shared/tree-sitter-walker.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-go-parser", path: "src/quality/languages/go/parser.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "9cd760312a35ec213611bc1c7e0b26fac6f338bf5d5c46a1291a063089482370" },
      dependencies: ["src/quality/languages/shared-helpers.ts","src/quality/languages/shared/tree-sitter-loader.ts","src/quality/languages/shared/tree-sitter-walker.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-index", path: "src/quality/languages/index.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 2, namesSha256: "0e02127c6146e84762e5b06ad56c4092c07fd4965e1fedf43ae33c55c83d9494" },
      dependencies: ["src/quality/config.ts","src/quality/languages/c-cpp/parser.ts","src/quality/languages/go/parser.ts","src/quality/languages/java/parser.ts","src/quality/languages/js-ts/parser.ts","src/quality/languages/python/parser.ts","src/quality/languages/rust/parser.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-java-parser", path: "src/quality/languages/java/parser.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "9a32f176685b20ff8c85746a8e3c65dd6bcaec8ba795ec9eb8ca7052902654cb" },
      dependencies: ["src/quality/languages/shared-helpers.ts","src/quality/languages/shared/tree-sitter-loader.ts","src/quality/languages/shared/tree-sitter-walker.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-js-ts-parser", path: "src/quality/languages/js-ts/parser.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "46ee490839c2f94a05ed5a290a4c5fdbd7019d39b4c92e2be4257eded21ba9c5" },
      dependencies: ["@babel/parser","src/quality-packs/prevention/ast-helpers.ts","src/quality/languages/shared/tree-sitter-walker.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-python-parser", path: "src/quality/languages/python/parser.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "3d91763e33028cff40dc66793a7d3df0691b74096f827e5858beddbb0943acb2" },
      dependencies: ["src/quality/languages/shared/tree-sitter-loader.ts","src/quality/languages/shared/tree-sitter-walker.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-rust-parser", path: "src/quality/languages/rust/parser.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 1, namesSha256: "0b35fbf4277a6f6944a0215f5ef4e41e7edf472d4fa1ee5cde419c0337413da8" },
      dependencies: ["src/quality/languages/shared-helpers.ts","src/quality/languages/shared/tree-sitter-loader.ts","src/quality/languages/shared/tree-sitter-walker.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-shared-tree-sitter-loader", path: "src/quality/languages/shared/tree-sitter-loader.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 6, namesSha256: "d5e4132f627818dc584085b6adaac344ea782ac70f51bf20da6e92a266a35fd6" },
      dependencies: ["node:fs","node:module","node:path","src/kernel/errors.ts","src/shared/best-effort.ts","web-tree-sitter"],
    }),
    moduleContract({
      id: "src-quality-languages-shared-tree-sitter-walker", path: "src/quality/languages/shared/tree-sitter-walker.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 20, namesSha256: "53badb93540afecbdfe64014072e05c6fe2d107089f973fd0d3ae939656ae07b" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-monitoring", path: "src/quality/monitoring.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 4, namesSha256: "932231656a3f6932747a25ce5bb2cd4523240ee69e1ba11fafa54fa0be3f9ab9" },
      dependencies: ["src/quality/scoring.ts"],
    }),
    moduleContract({
      id: "src-quality-scoring", path: "src/quality/scoring.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 4, namesSha256: "65b8ee4fba04148fffcff94f10d064ecfc4d9aac4d5d5e3f0e05cd1a3c1cfd9a" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-signals", path: "src/quality/signals.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 8, namesSha256: "9267d959f5f6d011901cd9d0dcda86db32ec151f66491545fdc85851f5ea1c5c" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-safety-bandaid-ast-detector", path: "src/safety/bandaid-ast-detector.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 4, namesSha256: "ee8c1f3d5cd0465ecbb2ae8c9989e82854c641d41632be3e7d90e9897a1c4b04" },
      dependencies: ["@babel/parser","src/quality-packs/prevention/ast-helpers.ts","src/safety/bandaid-config.ts","src/safety/shared-helpers.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-safety-bandaid-config", path: "src/safety/bandaid-config.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 14, namesSha256: "472e2c3400d0f9802d659cf74d0ff4bdcd6e593563371aa112916a662a08326a" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-safety-bandaid-detector", path: "src/safety/bandaid-detector.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 6, namesSha256: "3e149dd526789dc7a72c5047fe57238794788890d138c94f7b19760acf695c26" },
      dependencies: ["src/safety/bandaid-ast-detector.ts","src/safety/bandaid-config.ts"],
    }),
    moduleContract({
      id: "src-safety-bandaid-exposure", path: "src/safety/bandaid-exposure.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 3, namesSha256: "abf8a4a17314027d64fe6e709b5d8e742594b6b1c457deb679690ce8e1139eb6" },
      dependencies: ["src/kernel/errors.ts","src/safety/bandaid-config.ts","src/safety/bandaid-pattern-learner.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-safety-bandaid-pattern-learner", path: "src/safety/bandaid-pattern-learner.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 5, namesSha256: "aee9406578265df7894c8bc4388f74b962f46385482f7469cd7099f822e2af55" },
      dependencies: ["@babel/parser","src/quality-packs/prevention/ast-helpers.ts","src/safety/shared-helpers.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-safety-bias-config", path: "src/safety/bias-config.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 7, namesSha256: "11041cb77913d09c18d7f87a300bdb585a0b19a5e44276c6c777b72a2c711445" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-safety-bias-detector", path: "src/safety/bias-detector.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 17, namesSha256: "32d4947e8c1f58d5cd068682220511e4486c15674b4c256b93c79218055cddbc" },
      dependencies: ["src/safety/bias-config.ts","src/shared/similarity.ts"],
    }),
    moduleContract({
      id: "src-safety-bias-preventer", path: "src/safety/bias-preventer.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 29, namesSha256: "1a1fdcc74020ee0fe4592c2356c07a9c2510f24db6dd2f57e456deef457a3912" },
      dependencies: ["src/safety/bias-config.ts","src/safety/bias-detector.ts"],
    }),
    moduleContract({
      id: "src-safety-deviation-detector", path: "src/safety/deviation-detector.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 6, namesSha256: "7f8887f3c12b6a9dd51825cd07b2706ddd2c86826a715e0450a29fd4c606c329" },
      dependencies: ["src/safety/bandaid-config.ts"],
    }),
    moduleContract({
      id: "src-safety-hallucination-config", path: "src/safety/hallucination-config.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 7, namesSha256: "c3a271edaa7b4397ed352f471f7a3469a74ad8c4a2ec809aac592adf5be89ac3" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-safety-hallucination-detector", path: "src/safety/hallucination-detector.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 27, namesSha256: "bd5f44770f0ed8e1a47947ee37d5856b8d639e4f79139fa78e7a3a64cb690290" },
      dependencies: ["@babel/parser","src/quality-packs/prevention/ast-helpers.ts","src/safety/hallucination-config.ts","src/safety/hallucination-semantic.ts"],
    }),
    moduleContract({
      id: "src-safety-hallucination-semantic", path: "src/safety/hallucination-semantic.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 13, namesSha256: "af91d5b19e0b305553376af2a07220c8019047fb1fbd4e785cf9d03475081aa1" },
      dependencies: ["@babel/parser","src/quality-packs/prevention/ast-helpers.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-safety-investigation", path: "src/safety/investigation.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 10, namesSha256: "a94836f5e2464007ac351e32c05459331c70bfb320d14d84a5ceae6619e41335" },
      dependencies: ["src/mcp/unavailability.ts","src/safety/bandaid-config.ts","src/safety/bandaid-detector.ts","src/safety/deviation-detector.ts","src/safety/step-skip-detector.ts","src/safety/workaround-detector.ts"],
    }),
    moduleContract({
      id: "src-safety-pause-ask", path: "src/safety/pause-ask.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 9, namesSha256: "920207c4aec8149bbfff011b89b824b0fd5d54f05b4f9818aff096ef3e79db06" },
      dependencies: ["src/safety/bandaid-config.ts","src/safety/investigation.ts"],
    }),
    moduleContract({
      id: "src-safety-step-skip-detector", path: "src/safety/step-skip-detector.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 9, namesSha256: "2c28c98528cac756a5d244025092efa0155c0b6b8c88f1943994b1953614ed1b" },
      dependencies: ["src/safety/bandaid-config.ts"],
    }),
    moduleContract({
      id: "src-safety-workaround-detector", path: "src/safety/workaround-detector.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 7, namesSha256: "d4a5264bb80d1796485928c18e7b22521a124a0d87a96e7984de2252b836a47b" },
      dependencies: ["src/safety/bandaid-config.ts"],
    }),
    moduleContract({
      id: "src-self-improving-command-log", path: "src/self-improving/command-log.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 7, namesSha256: "522430fd7841475d559f28528312264f8f84277741f2f24efcb23a733127e320" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/self-improving/config.ts","zod"],
    }),
    moduleContract({
      id: "src-self-improving-config", path: "src/self-improving/config.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 22, namesSha256: "26583ad92f5a30b3cd419ba1eca780a1f83ad9c51e6cf035b99a1dc35acc1af6" },
      dependencies: ["src/kernel/errors.ts","src/kernel/product-identity.ts","src/shared/debug/debug-system.ts","zod"],
    }),
    moduleContract({
      id: "src-self-improving-generation-evolver", path: "src/self-improving/generation-evolver.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 5, namesSha256: "e320d9dbd27c6aac5952936ae7b4d4f4e8d44cdf9aae7a8d88310b792c56097c" },
      dependencies: ["src/self-improving/config.ts"],
    }),
    moduleContract({
      id: "src-self-improving-index", path: "src/self-improving/index.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 13, namesSha256: "0146ca81b420f7c00790724407acea0ca1c22007a911ef9a498734eaaf6b3f9d" },
      dependencies: ["src/self-improving/command-log.ts","src/self-improving/config.ts","src/self-improving/learner.ts","src/self-improving/llm-boundary.ts","src/self-improving/mistake-detector.ts","src/self-improving/workflow-improver.ts"],
    }),
    moduleContract({
      id: "src-self-improving-learner", path: "src/self-improving/learner.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 14, namesSha256: "d140cf40af0d91de3e34e757f30f3029804183b83d152fc45cfa897f4dd69a7f" },
      dependencies: ["src/kernel/integrity.ts","src/self-improving/command-log.ts","src/self-improving/config.ts","src/self-improving/mistake-detector.ts","src/self-improving/success-detector.ts"],
    }),
    moduleContract({
      id: "src-self-improving-llm-boundary", path: "src/self-improving/llm-boundary.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 8, namesSha256: "cd8a96af8ad6f005d6c1edba8e169c48b1d4b2c0f03b66c9a7e8d3d2e90b1dbb" },
      dependencies: ["src/kernel/errors.ts","src/self-improving/config.ts","zod"],
    }),
    moduleContract({
      id: "src-self-improving-mistake-detector", path: "src/self-improving/mistake-detector.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 5, namesSha256: "904762046603ae721cff2c2a961738cf2cdef346b2a961ad38c8fa54645510ba" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/self-improving/command-log.ts","src/self-improving/config.ts"],
    }),
    moduleContract({
      id: "src-self-improving-success-detector", path: "src/self-improving/success-detector.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 3, namesSha256: "31ed71c9cb849b18eb97cb0e3fa8ec3b826a3ab8657bfa34ae51f4081d61bb7e" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/self-improving/command-log.ts","src/self-improving/config.ts","zod"],
    }),
    moduleContract({
      id: "src-self-improving-workflow-improver", path: "src/self-improving/workflow-improver.ts", realm: "runtime", layer: "domain",
      owner: "self-improving", publicApi: { exportCount: 5, namesSha256: "db0adf68608f03c03dee60de6335be25a8c6cff7863bdd79813f6fc1fecc5918" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/self-improving/command-log.ts","src/self-improving/config.ts"],
    }),
    moduleContract({
      id: "src-tools-concurrent-dependency-graph", path: "src/tools/concurrent/dependency-graph.ts", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 8, namesSha256: "e2fbc4695d631ff4c59ede9e13bc1eb81b15d084d1b0bd0dd3d1357e199a3785" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-tools-concurrent-dispatcher", path: "src/tools/concurrent/dispatcher.ts", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 10, namesSha256: "22fd55ab78a553087525a6c90981d9b113111f07aa10631527f350d658ac8dd6" },
      dependencies: ["node:perf_hooks","src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/process/fault-policy.ts","src/shared/best-effort.ts","src/tools/concurrent/dependency-graph.ts","src/tools/concurrent/worker-pool.ts"],
    }),
    moduleContract({
      id: "src-tools-concurrent-index", path: "src/tools/concurrent/index.ts", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 31, namesSha256: "eab31aa12c3249342e9638eae339825925ef76c2beb9a34ab26456a7c3ec10c8" },
      dependencies: ["src/tools/concurrent/dependency-graph.ts","src/tools/concurrent/dispatcher.ts","src/tools/concurrent/long-task-runner.ts","src/tools/concurrent/worker-pool.ts"],
    }),
    moduleContract({
      id: "src-tools-concurrent-long-task-runner", path: "src/tools/concurrent/long-task-runner.ts", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 8, namesSha256: "d07e0d2f61c9071eb151d412a6bec21199ed35174b938e97082db32b5657b5fb" },
      dependencies: ["node:child_process","node:fs","node:path","src/filesystem/private-state.ts","src/kernel/config-contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/process/environment-projection.ts","src/shared/debug/debug-system.ts","src/shared/long-task-timing.ts"],
    }),
    moduleContract({
      id: "src-tools-concurrent-long-task-wrapper", path: "src/tools/concurrent/long-task-wrapper.mjs", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      dependencies: ["node:child_process","node:fs","node:path","src/process/fault-policy.ts","src/runtime/cli-debug.ts"], executionBoundary: "composition-root", compositionRoot: true, effects: ["child-process","filesystem-read","filesystem-write","git","process-status"],
    }),
    moduleContract({
      id: "src-tools-concurrent-worker-pool", path: "src/tools/concurrent/worker-pool.ts", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 8, namesSha256: "162612fcad2477cb4fac6e0702b8697e7fb460c9496f1b3a8294850e2d7b6c83" },
      dependencies: ["node:fs","node:path","node:perf_hooks","node:url","node:worker_threads","src/kernel/errors.ts","src/process/fault-policy.ts","src/process/worker-bootstrap.ts","src/shared/best-effort.ts","src/tools/tools-config.ts"],
    }),
    moduleContract({
      id: "src-shared-source-scan", path: "src/shared/source-scan.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 12, namesSha256: "ce7d2cdf7e0e4d9556ca54c9fcee3330107f9fb6a39299c516799c2f826a3885" },
      dependencies: ["src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-safety-index", path: "src/safety/index.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 3, namesSha256: "9b1c7be11785030de3f4aa63a2a414cb665c033cc21e655c67838169bd74cc48" },
      dependencies: ["src/safety/bandaid-detector.ts","src/safety/bias-detector.ts","src/safety/hallucination-detector.ts","src/shared/exposure/action.ts","src/shared/exposure/customization.ts","src/shared/exposure/signal.ts"],
    }),
    moduleContract({
      id: "src-awareness-clone-helpers", path: "src/awareness/clone-helpers.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 6, namesSha256: "15e0163a5bc770f59141a304287800aa1791565637d4f9276fbf76c1791d9a86" },
      dependencies: ["src/shared/similarity.ts"],
    }),
    moduleContract({
      id: "src-awareness-language-helpers", path: "src/awareness/language-helpers.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 4, namesSha256: "b0d3cf0865a41109dda015e0822680b4b968a014ab0781d1b0471477927a6993" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-awareness-module-helpers", path: "src/awareness/module-helpers.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 2, namesSha256: "a7209d2253110f5ae7f261662c7cd3b7186375074135efb572a996789d300362" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-mcp-transport-helpers", path: "src/mcp/transport/helpers.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 1, namesSha256: "05071a3d6328051bd8487ecee35594d8a5b4a23a31cc0c8a9f206fbf6a5206f1" },
      dependencies: ["src/process/fault-policy.ts"],
    }),
    moduleContract({
      id: "src-memory-context-helpers", path: "src/memory/context-helpers.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 6, namesSha256: "2f33a5b4e22a530f3829bc51ebd0cf769e6e5dd1e4d99420aa76472d381a814f" },
      dependencies: ["src/memory/memory-config.ts"],
    }),
    moduleContract({
      id: "src-quality-checks-shared-helpers", path: "src/quality/checks/shared-helpers.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 3, namesSha256: "cd7eb96d71815975573e4e775fbe98b160292029ad2f326dbb16960884bd2767" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-quality-languages-shared-helpers", path: "src/quality/languages/shared-helpers.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 2, namesSha256: "002895c465c5ea064f7922c1b0ef2526890280fb2387399f3c62d373514a6e4c" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-safety-shared-helpers", path: "src/safety/shared-helpers.ts", realm: "runtime", layer: "domain",
      owner: "safety", publicApi: { exportCount: 3, namesSha256: "ee2e174172ce59eae78c9292d8fd6a72a12cf6d3484d27a6ddd8b8c52968acd5" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-shared-dedup-compression-shared-helpers", path: "src/shared/dedup-compression/shared-helpers.ts", realm: "shared", layer: "domain",
      owner: "shared-dedup-compression", publicApi: { exportCount: 2, namesSha256: "7085f8903c06103d9b607395046e167de996d0f3b63bc35d22e1611308d06c8c" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-shared-numeric-helpers", path: "src/shared/numeric-helpers.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 4, namesSha256: "38936a27b0eb54dc2c7baec4878b7538591e0d66fb3f5499f16fd4287565e466" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-shared-best-effort", path: "src/shared/best-effort.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 4, namesSha256: "3e3b3a6bb7da3116a8054ca7c22bf16f6bf425d63a30892f348325f29e1cef02" },
      dependencies: ["node:util","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-shared-dev-mode-env", path: "src/shared/dev-mode-env.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 4, namesSha256: "e82e1d4bc87230de5763878bdfa178460659210352227c579bc840c0bfbb589f" },
      dependencies: ["src/filesystem/self-protection/self-protection-config.ts","src/kernel/config.ts","src/kernel/integrity.ts","src/shared/source-scan.ts"],
    }),
    moduleContract({
      id: "src-workflow-format-command", path: "src/workflow/format-command.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 5, namesSha256: "aae5e41ef2571da6ae4da745b8e4b256d91be1b996608dd662fb46a4b7be66fd" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/source-scan.ts"],
    }),
    moduleContract({
      id: "src-bundle-entry", path: "src/bundle-entry.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 2, namesSha256: "06c820ab87d520e7022f5b6bf1b99bf30d3a974ef85c3cab63b906f561f02917" },
      dependencies: ["src/cli.ts","src/kernel/config.ts"],
    }),
    moduleContract({
      id: "src-shared-long-task-timing", path: "src/shared/long-task-timing.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 2, namesSha256: "5ae5a4534e9aeabdcad09fa6fb6417789b0d2e865705591547d69f4cdd9060f7" },
      dependencies: ["node:fs","src/shared/best-effort.ts"],
    }),
    moduleContract({
      id: "src-agents-agents-config", path: "src/agents/agents-config.ts", realm: "runtime", layer: "domain",
      owner: "agents", publicApi: { exportCount: 6, namesSha256: "df12059648584ddc29af2369cdf1f2814c869c6d19c49cef9843408b8166ca84" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-evaluation-evaluation-config", path: "src/evaluation/evaluation-config.ts", realm: "shared", layer: "domain",
      owner: "evaluation", publicApi: { exportCount: 7, namesSha256: "5c940d18db1fac7b024d31a9ce8e660d075901abaa0e07722930f48f691d3974" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-git-git-config", path: "src/git/git-config.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 5, namesSha256: "9bf41dab7c5d86d026685d0800c3773cf24ef4dd7c088f9047029b00abb4e09b" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-intelligence-intelligence-config", path: "src/intelligence/intelligence-config.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 38, namesSha256: "88f84226b158df2b639cc0b8036cf0badf0cb387d520bcb51a46686077fe5eb2" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-memory-memory-config", path: "src/memory/memory-config.ts", realm: "runtime", layer: "domain",
      owner: "memory", publicApi: { exportCount: 5, namesSha256: "b380ddaea166e5219f381fda4f3afc4373a9ecd1bf891eed6ac8bbfd06ad5514" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-privacy-privacy-config", path: "src/privacy/privacy-config.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 10, namesSha256: "403a9f65159c49342e5c494c285d9ec0036b870fb5c2d34e10ca7521bffacdb9" },
      dependencies: ["src/privacy/classification-catalog.ts"],
    }),
    moduleContract({
      id: "src-quality-packs-quality-config", path: "src/quality-packs/quality-config.ts", realm: "runtime", layer: "domain",
      owner: "quality-packs", publicApi: { exportCount: 4, namesSha256: "b60e9f1e2c68ebee53f45f5229ac9619784d3c28ff8e285eac71027e875fa52a" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-shared-debug-debug-config", path: "src/shared/debug/debug-config.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 13, namesSha256: "975f69b0805fc71fccf9de9cecfefa834c9f01402e3d90ef60490b1218fb6b96" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","zod"],
    }),
    moduleContract({
      id: "src-shared-debug-debug-system", path: "src/shared/debug/debug-system.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 26, namesSha256: "4fe990a481cdb00dc4bbf9eefe73d289fdf68d3a871ca050236c8fd580fc62c0" },
      dependencies: ["src/kernel/errors.ts","src/privacy/secret-signals.ts","src/shared/debug/debug-config.ts"],
    }),
    moduleContract({
      id: "src-timeline-timeline-config", path: "src/timeline/timeline-config.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 9, namesSha256: "62624373ea28d94d964829d76e0969173363a55c2f5d64a3da3564e23e33e846" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-tools-tools-config", path: "src/tools/tools-config.ts", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 1, namesSha256: "0a01288e19db125b0aa95e958078519e2bb9c16c9eeb37a33699a98f8e40b4e2" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-workflow-workflow-config", path: "src/workflow/workflow-config.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 44, namesSha256: "17d74fc14e1ebb4c1ce5aae9e5252fde3c1e22f212c0d9ae2c89696331b0033e" },
      dependencies: ["src/kernel/errors.ts","src/kernel/product-identity.ts"],
    }),
    moduleContract({
      id: "scripts-verification-filesystem-cache", path: "scripts/verification/filesystem-cache.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 4, namesSha256: "48f161095101aca54c06d289f41a6f8d0f0f45b192c82d5db4984bb3a4ce04a6" },
      dependencies: ["node:fs","node:os","node:path","node:url","src/filesystem/atomic-write.ts","src/kernel/integrity.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-catalog", path: "src/shared/exposure/catalog.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 4, namesSha256: "b2ec0bffa812a29343e0ced9ca968bf221c2c2e5a3b0a7c1c03f53beb8457237" },
      dependencies: ["src/kernel/errors.ts","src/shared/exposure/contract.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-contract", path: "src/shared/exposure/contract.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 12, namesSha256: "9afb5368d2b6c3249770843db75ffc067ce56606e2f3e3bd0b425528be5dd29d" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-timeline-effect-documents", path: "src/timeline/effect-documents.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 1, namesSha256: "618940a1b8ad4a6ef3ff1e6d6dccac6798591d6a8bf8578da78358a6608b6104" },
      dependencies: ["../shared/constants.ts","node:util","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/timeline/ledger-primitives.ts","src/timeline/timeline-config.ts"],
    }),
    moduleContract({
      id: "src-timeline-effect-sink", path: "src/timeline/effect-sink.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 1, namesSha256: "014520958a01356bdc8a340f9b7456432e18e125ae8d8a4b998d3abaa04d3e7d" },
      dependencies: ["node:util","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/timeline/effect-documents.ts","src/timeline/ledger-primitives.ts","src/timeline/recorded-effect.ts","src/timeline/recording-context.ts","src/timeline/timeline-types.ts"],
    }),
    moduleContract({
      id: "src-timeline-provider-recording", path: "src/timeline/provider-recording.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 3, namesSha256: "9419b6e2634a3a2e4dd4ca8b4507a797fe824cd2a7929c33ecb6c9ea7e0f6dd0" },
      dependencies: ["src/kernel/errors.ts","src/timeline/recorded-effect.ts","src/timeline/recording-context.ts"],
    }),
    moduleContract({
      id: "src-timeline-recorded-effect", path: "src/timeline/recorded-effect.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 19, namesSha256: "e6f7ad19193a5b8067182eae656cfdaa4ab18c741ff5a452e164779738f99e81" },
      dependencies: ["node:util","src/kernel/errors.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/performance/metrics-collector.ts","src/shared/best-effort.ts","src/timeline/ledger-primitives.ts","src/timeline/recording-context.ts"],
    }),
    moduleContract({
      id: "src-timeline-recording-context", path: "src/timeline/recording-context.ts", realm: "runtime", layer: "domain",
      owner: "evidence-ledger", publicApi: { exportCount: 9, namesSha256: "fe7b2418be50998b30c45d1311ff7d91c59953bec5e56b441bcd82b9dda3da96" },
      dependencies: ["node:async_hooks"],
    }),
    moduleContract({
      id: "src-runtime-harness-bootstrap", path: "src/runtime/harness-bootstrap.ts", realm: "shared", layer: "infrastructure",
      owner: "runtime-infrastructure", publicApi: { exportCount: 5, namesSha256: "ffb0cc3ff6424bf6aae16c4d028f7aa2c8c6cb55d0a3acd48a48719b24223b9f" },
      dependencies: ["node:path","node:url","src/filesystem/journaled-commit.ts","src/filesystem/private-state.ts","src/git/declared-deletions.ts","src/git/index-baseline.ts","src/git/repository-ownership.ts","src/git/worktree-port.ts","src/kernel/config.ts","src/kernel/integrity.ts","src/performance/performance-config.ts","src/shared/exposure/index.ts","src/shared/exposure/registrations/index.ts","src/timeline/effect-sink.ts","src/timeline/recorded-effect.ts","src/timeline/recording-context.ts","src/timeline/timeline-config.ts","src/timeline/timeline-recorder.ts","src/timeline/timeline-store.ts","src/workflow/evidence-store.ts","src/workflow/promotion/context.ts","src/workflow/repository-registry.ts","src/workflow/workflow-config.ts","src/workflow/workspace-cli.ts","src/workflow/workspace-registry.ts"],
    }),
    moduleContract({
      id: "src-privacy-benign-grammars", path: "src/privacy/benign-grammars.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 8, namesSha256: "57622e2a2f9a90d4b2af1db79063674b922c2ce5e418bfc0429ec9596fbdb1f2" },
      dependencies: ["src/kernel/integrity.ts","src/privacy/credential-lexicon.ts"],
    }),
    moduleContract({
      id: "src-privacy-credential-lexicon", path: "src/privacy/credential-lexicon.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 19, namesSha256: "8947040cf152747d6b350684c12f94ef2cb9102554ce84ec2bb9ac8435ecc019" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-privacy-detection-span", path: "src/privacy/detection-span.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 4, namesSha256: "9cdf22a8c46da3932af757cd17feb3643cff1c85fb83b967985f39b9aa9565b3" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-privacy-identity-grammars", path: "src/privacy/identity-grammars.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 6, namesSha256: "b2c9b40c9869af7d012149179b54fdc985eb0d7867ccaded1dd8b7bf0237f0d4" },
      dependencies: ["src/kernel/integrity.ts","src/privacy/detection-span.ts"],
    }),
    moduleContract({
      id: "src-privacy-pii-registry", path: "src/privacy/pii-registry.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 24, namesSha256: "b14f48be84ca2be3924fff8856e62cfea266569cbe590c2d341b3bdf8aa6bffb" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/privacy/identity-grammars.ts","src/privacy/privacy-config.ts"],
    }),
    moduleContract({
      id: "src-privacy-secret-intelligence", path: "src/privacy/secret-intelligence.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 26, namesSha256: "ad37776c3b4061057f890953e2f2bc36ebda753002c8bcaa4074d4a682643182" },
      dependencies: ["src/kernel/integrity.ts","src/privacy/benign-grammars.ts","src/privacy/credential-lexicon.ts","src/privacy/detection-span.ts","src/privacy/text-normalize.ts","src/privacy/value-intrinsic.ts","src/shared/best-effort.ts"],
    }),
    moduleContract({
      id: "src-privacy-text-normalize", path: "src/privacy/text-normalize.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 3, namesSha256: "0a8dbef2cc7e96be33d1192140a43752e011614d70bc1fbee29c9d719956fb3a" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-privacy-value-intrinsic", path: "src/privacy/value-intrinsic.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 13, namesSha256: "d1961ac9d0360e68b32626e39e1554d59ddb6a29745a576385e0218439511d37" },
      dependencies: ["src/kernel/integrity.ts","src/privacy/benign-grammars.ts","src/privacy/detection-span.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-privacy", path: "src/shared/exposure/registrations/privacy.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 4, namesSha256: "4f9d4546d8e880154c4be9a7382c74535baaf996f176aad820ab02238246efa5" },
      dependencies: ["src/privacy/credential-lexicon.ts","src/privacy/pii-registry.ts","src/privacy/privacy-config.ts","src/privacy/secret-intelligence.ts","src/privacy/value-intrinsic.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-awareness-git-command-runner", path: "src/awareness/git-command-runner.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 1, namesSha256: "824e8368a579e16939985dbec6d6308ea5a692e767c8fe85322b55d4a9c516ef" },
      dependencies: ["node:child_process","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-tools-built-in-tool-manifest", path: "src/tools/built-in-tool-manifest.ts", realm: "runtime", layer: "domain",
      owner: "tools", publicApi: { exportCount: 8, namesSha256: "acd38dfb4c1dd6c9730e2d1da884aa1daa6acfe60303313e0f71d3e0d9fe3ab3" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/tools/tool-manifest.ts"],
    }),
    moduleContract({
      id: "src-filesystem-link-containment", path: "src/filesystem/link-containment.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 4, namesSha256: "0f7f9de052d260c953032e8116ff5e32fe11f4f460cada99c1677089bbcf7a29" },
      dependencies: ["node:fs","src/shared/source-scan.ts"],
    }),
    moduleContract({
      id: "src-shared-source-structure", path: "src/shared/source-structure.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 30, namesSha256: "1edc2e589b25ca0d90a3ebe6c2b825d9fc4e3a781abbb3c60e8ada740d41b0aa" },
      dependencies: ["@babel/parser","src/kernel/errors.ts","src/quality-packs/prevention/ast-helpers.ts"],
    }),
    moduleContract({
      id: "scripts-verification-pattern-liveness", path: "scripts/verification/pattern-liveness.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 5, namesSha256: "8726f3aac5637b5266bc693b3d524dd842887aa559b0317f3f3cd7ba4774480f" },
      dependencies: ["node:fs"],
    }),
    moduleContract({
      id: "scripts-verification-gitignore-anchoring", path: "scripts/verification/gitignore-anchoring.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 27, namesSha256: "0d94e29a25c1f507cf5ab89aef65ddc86da844c05c4e8d62bda3b6210ac44dee" },
      dependencies: ["node:fs","node:path"],
    }),
    moduleContract({
      id: "scripts-bootstrap-hooks", path: "scripts/bootstrap-hooks.ts", realm: "builder", layer: "verification",
      owner: "verification", publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      dependencies: ["node:child_process","node:fs","node:path","scripts/verification/gitignore-anchoring.ts","scripts/verification/staged-move-loss.ts","src/workflow/promotion/trigger-hook.ts"],
      executionBoundary: "composition-root", compositionRoot: true,
    }),
    moduleContract({
      id: "scripts-commit-guard", path: "scripts/commit-guard.ts", realm: "builder", layer: "verification",
      owner: "verification", publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      dependencies: ["node:child_process","node:fs","node:path","node:url","scripts/verification/lesson-trailers.ts","scripts/verification/ratchet.ts","scripts/verification/staged-move-loss.ts","src/filesystem/private-state.ts","src/git/flake-cause-fixes.ts","src/git/index-baseline.ts","src/git/repository-ownership.ts","src/git/working-copy.ts","src/git/worktree-port.ts","src/kernel/config.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/runtime/cli-debug.ts","src/shared/run-history.ts","src/workflow/checkout-setup.ts","src/workflow/command-result.ts","src/workflow/hash-binding-registry.ts","src/workflow/record-links.ts"],
      executionBoundary: "composition-root", compositionRoot: true,
    }),
    moduleContract({
      id: "scripts-verification-staged-move-loss", path: "scripts/verification/staged-move-loss.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 23, namesSha256: "43d59b2b7f4abe5c50ce7146a197df7d322203d35edb7c98ad9b4268458716be" },
      dependencies: ["node:child_process","node:fs","node:url","src/git/declared-deletions.ts","src/git/ignored-copies.ts","src/git/repository-ownership.ts","src/kernel/verification-paths.ts","src/shared/debug/debug-system.ts","src/workflow/promotion/trigger-hook.ts"],
    }),
    moduleContract({
      id: "scripts-verification-source-view", path: "scripts/verification/source-view.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 13, namesSha256: "8286e367a802e2857b2bb51afc107f957c782ed5e29b5d7fe066f267e4175dcc" },
      dependencies: ["node:fs","src/kernel/lexical-policy.ts"],
    }),
    moduleContract({
      id: "src-shared-source-extensions", path: "src/shared/source-extensions.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 1, namesSha256: "23b93152f73e8e166b0ac2cb142c1f2b4516cd29f4a3cf6014b95fbaf711a1c9" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-shared-budget-verdict", path: "src/shared/budget-verdict.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 34, namesSha256: "e636272b6aaf7f91d74313bed2d8c194f1342ee1c60dc8f7dd22c171a9756d35" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-shared-run-cpu", path: "src/shared/run-cpu.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 2, namesSha256: "4346de8d3994cb79310b70b0795c412d8adac2268b155e8847846278c5aa3501" },
      dependencies: ["src/process/process-facts.ts"],
    }),
    moduleContract({
      id: "src-shared-run-history", path: "src/shared/run-history.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 57, namesSha256: "e628ff52e8a1d9e9444ad27219e47ec24cf4ea4fcab6f51587ace5f1159c6a25" },
      dependencies: ["node:fs","node:os","node:path","src/filesystem/atomic-write.ts","src/filesystem/file-lock.ts","src/filesystem/private-state.ts","src/git/git-port.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/shared/best-effort.ts","src/shared/budget-verdict.ts","src/shared/debug/debug-system.ts","src/shared/flake-reproduction.ts"],
    }),
    moduleContract({
      id: "src-privacy-redacted-messages", path: "src/privacy/redacted-messages.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 12, namesSha256: "14ae1e46747e297e86057fcdcfea15d2f71ac9bcaab981ba4dc78dc6205796ef" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/safe-structural.ts","src/privacy/privacy-policy.ts","src/privacy/responses-redaction.ts","src/shared/llm/config.ts","src/shared/llm/responses-endpoints.ts"],
    }),
    moduleContract({
      id: "src-shared-tree-identity", path: "src/shared/tree-identity.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 8, namesSha256: "727706538386a35fb9c9784b8de192d26a48b84a0c3c42a70662f19b7fde6dcf" },
      dependencies: ["node:child_process","node:fs","node:path","src/git/working-copy.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts","src/shared/run-history.ts","src/workflow/hash-binding-registry.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-dedup", path: "src/shared/exposure/registrations/dedup.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "bc36f3f5da505c83171099d4e9442ad969686680b400f522ce8c2edcfe8c16c1" },
      dependencies: ["src/shared/dedup-compression/index.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-config-binding", path: "src/shared/exposure/config-binding.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 15, namesSha256: "a5cf0743e7f39be5509983916e786719475f363f989cc41d7a55d64e918fbc6b" },
      dependencies: ["src/filesystem/atomic-write.ts","src/kernel/config-contracts.ts","src/kernel/config-write-lock.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-module-config-sections", path: "src/shared/exposure/module-config-sections.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure", publicApi: { exportCount: 8, namesSha256: "5d04dbd4bd3f05b38f7fc16040ddd670b79832994771e10413dd0ade3e0f2af5" },
      dependencies: ["src/process/environment-projection.ts","zod"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-mcp", path: "src/shared/exposure/registrations/mcp.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "6e9fd236386d0e871a6b0049971a05c0f9d805666ea37d72630e1781f7a10bb5" },
      dependencies: ["src/mcp/config.ts","src/shared/exposure/index.ts","src/shared/exposure/module-config-sections.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-intelligence", path: "src/shared/exposure/registrations/intelligence.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 8, namesSha256: "cf38a4aa66671382fa011e837a65f7ef8663c0202a31bf195828d3310b3bee33" },
      dependencies: ["src/intelligence/language-registry.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-graph", path: "src/shared/exposure/registrations/graph.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "020c2ea251a1f3da857ce328c3608d0bf74e03a5e0021df7a8ad1dbcf027c505" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-artifacts", path: "src/shared/exposure/registrations/artifacts.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "aa5767838413f471d25ad525cb4760348ea4f77aba8a50072b1b025ebde01b81" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-mcp-unavailability", path: "src/mcp/unavailability.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 4, namesSha256: "ead9e62166c44737d70f42ef73fec5304ebbc5e4f09a31bbd18c72435380103c" },
      dependencies: ["src/mcp/errors.ts"],
    }),
    moduleContract({
      id: "src-filesystem-atomic-write", path: "src/filesystem/atomic-write.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 6, namesSha256: "cf86f1b5dbbe57c114312577a8470a6f06f30fbbdcb0e454e9fc402e15a3293e" },
      dependencies: ["node:fs","node:path","src/filesystem/checkout-write-door.ts","src/filesystem/path-identity.ts","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/root-policy.ts","src/shared/best-effort.ts"],
    }),
    moduleContract({
      id: "src-filesystem-linux-path", path: "src/filesystem/linux-path.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 4, namesSha256: "616976dac03f762440d0df6dbf61156cb43133fb1b6c251fffdf0f10860f1e5c" },
      dependencies: ["src/kernel/errors.ts","src/process/process-facts.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-filesystem-path-boundary", path: "src/filesystem/path-boundary.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 4, namesSha256: "ad940d1030e7d4ca2fe1a67bdbfbd434396d16738bb71c276dbd388f11593772" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-forensics-forensic-contracts", path: "src/forensics/forensic-contracts.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 43, namesSha256: "5bca4c71843862f130a78b799f9c6472271a9ce576f71af1f6eb175839680def" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","zod"],
      authorityFamilies: ["events"], authorityIdentifiers: ["FORENSIC_EVENT_SCHEMA", "ForensicEvent"],
    }),
    moduleContract({
      id: "src-forensics-forensic-crypto", path: "src/forensics/forensic-crypto.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 20, namesSha256: "e4f328266f2be01f3f807d915c6b8e28d2c0c1ee6191fa53bf0a33d91c167fd2" },
      dependencies: ["node:crypto","node:util","src/forensics/forensic-contracts.ts","src/forensics/forensic-structural.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ledger-canonical.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts"],
    }),
    moduleContract({
      id: "src-forensics-forensic-normalization", path: "src/forensics/forensic-normalization.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 8, namesSha256: "def532116ed83f9956446734b9e0823ec2985b5f04ca05c966593252128be018" },
      dependencies: ["node:util","src/forensics/forensic-contracts.ts","src/forensics/forensic-structural.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ledger-canonical.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-forensics-forensic-projection", path: "src/forensics/forensic-projection.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 3, namesSha256: "3187cc77cb3e254e2ea4497e3afc2b4ad1e242a485cf1d5b709e4d8cca8c9e55" },
      dependencies: ["src/forensics/forensic-contracts.ts","src/forensics/forensic-crypto.ts","src/forensics/forensic-structural.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/ledger-canonical.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-forensics-forensic-state", path: "src/forensics/forensic-state.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 4, namesSha256: "1944ecd16dd4b2be5d2abc9a22bc7112a66d6e1a169098ce0bc03ada14e5855b" },
      dependencies: ["src/forensics/forensic-contracts.ts","src/forensics/forensic-structural.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/safe-structural.ts"],
    }),
    moduleContract({
      id: "src-forensics-forensic-structural", path: "src/forensics/forensic-structural.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 1, namesSha256: "c0c2b45d61bd8a706f8d39fb2a5a395a09225a1af9e03616cabdc1f6ad3b5a2c" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-forensics-offline-contracts", path: "src/forensics/offline-contracts.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 4, namesSha256: "424b2a02d619d98e315fbff0ef6ea7e1855f3cd80b257aa3039dc3c84516ca2b" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/integrity.ts","src/kernel/protocol-projections.ts","src/kernel/requirements.ts","src/kernel/root-policy.ts","src/kernel/schema-subset.ts","src/runtime/capability-negotiation.ts","src/runtime/event-state.ts"],
    }),
    moduleContract({
      id: "src-forensics-offline-forensics", path: "src/forensics/offline-forensics.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 4, namesSha256: "241238c2f2562bf79b73cdf91506defdc32e305e527f6531d372fdacca47c512" },
      dependencies: ["src/forensics/forensic-contracts.ts","src/forensics/forensic-crypto.ts","src/forensics/forensic-normalization.ts","src/forensics/forensic-projection.ts","src/forensics/forensic-state.ts","src/kernel/integrity.ts","src/kernel/ledger-canonical.ts","src/kernel/requirements.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts"],
    }),
    moduleContract({
      id: "src-kernel-contracts", path: "src/kernel/contracts.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 35, namesSha256: "265a9f904190c6d11b38b432cfaa75f0574f8136eb4aaf6986ed9d5d2034fa60" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","zod"],
      authorityFamilies: ["events"], authorityIdentifiers: ["MODEL_EVENT_SCHEMA", "ModelEvent"],
    }),
    moduleContract({
      id: "src-kernel-errors", path: "src/kernel/errors.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 18, namesSha256: "f4dc3539d1338d3f3e5082b1e6381e9d4cf685904bb6b69233c984b794cc9de6" },
      dependencies: ["node:os","node:url","src/shared/debug/debug-system.ts"],
      authorityFamilies: ["errors"], authorityIdentifiers: ["HarnessError", "InputError", "SecurityError"],
    }),
    moduleContract({
      id: "src-kernel-execution-closure", path: "src/kernel/execution-closure.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 44, namesSha256: "69113686e2b95d0c2dd1997c9dad7c94781d477a38681aff8fe5659d33f41c80" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/safe-structural.ts","src/shared/best-effort.ts","src/timeline/ledger-primitives.ts"],
      authorityFamilies: ["events"], authorityIdentifiers: ["EXECUTION_CLOSURE_SCHEMA_VERSION", "EXECUTION_CLOSURE_REVISION"],
    }),
    moduleContract({
      id: "src-kernel-integrity", path: "src/kernel/integrity.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 18, namesSha256: "1af1c8766ab9bd3338d38c9302e8a1116629ea54d194a78202e9a16d51cf4bc4" },
      dependencies: ["node:crypto","src/kernel/errors.ts","src/kernel/product-identity.ts","zod"],
    }),
    moduleContract({
      id: "src-kernel-json-integrity", path: "src/kernel/json-integrity.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 4, namesSha256: "89c93a430c8d879464b68129d2d300cd18b42271578f36f3f009a3ea039cf39a" },
      dependencies: ["src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-kernel-language-extensions", path: "src/kernel/language-extensions.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 2, namesSha256: "fb269c4e6b51b9cf1a20f01cdea47ad3365b15ca97df076149503af032fcf0f3" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-kernel-ledger-canonical", path: "src/kernel/ledger-canonical.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 8, namesSha256: "09a0e3fb8f35ea03ab855f61727e388859d5a80ffe0b4b62d0e74e0de793a540" },
      dependencies: ["src/kernel/errors.ts","src/kernel/root-policy.ts","src/kernel/safe-structural.ts"],
    }),
    moduleContract({
      id: "src-kernel-ordered", path: "src/kernel/ordered.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 2, namesSha256: "d031ec6e49d1c8e57e4f94678baa166e51486bd6d24a1c405fd4793e61659cab" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-kernel-preflight", path: "src/kernel/preflight.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 8, namesSha256: "a0113e2ef0bf1a93df4c12d5d048b8caad1dffaf12fd78da7ba53c4b81fc541d" },
      dependencies: ["node:fs","node:path","src/filesystem/link-containment.ts","src/filesystem/linux-path.ts","src/filesystem/path-boundary.ts","src/forensics/offline-contracts.ts","src/forensics/offline-forensics.ts","src/kernel/config-contracts.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/privacy/data-policy.ts","src/shared/identity.ts"],
    }),
    moduleContract({
      id: "src-kernel-protocol-projections", path: "src/kernel/protocol-projections.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 14, namesSha256: "5d4838b1c3b9cdf1da0ba0e02184ec8fcf06f3dfc5e6ef5e5b697dc7a1fc5a70" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/schema-subset.ts","src/shared/json-pointer.ts","src/shared/type-guards.ts","zod"],
    }),
    moduleContract({
      id: "src-kernel-requirements", path: "src/kernel/requirements.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 26, namesSha256: "56568b4e557f2b408c8dc112c3a0cf4fb1026f2e3bce5085bacd21956c24e937" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/kernel/product-identity.ts","src/privacy/secret-signals.ts","zod"],
    }),
    moduleContract({
      id: "src-kernel-root-policy", path: "src/kernel/root-policy.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 6, namesSha256: "b8fc78e1a81c6cf2bd0db1a6b5401dfdca4cb408b63fefbd50823a124830aa42" },
      dependencies: ["src/filesystem/self-protection/self-protection-contracts.ts","src/kernel/integrity.ts","src/kernel/lexical-policy.ts","src/kernel/product-identity.ts","src/kernel/requirements.ts","src/kernel/web-performance-budgets.ts","src/privacy/classification-catalog.ts"],
    }),
    moduleContract({
      id: "src-kernel-safe-structural", path: "src/kernel/safe-structural.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 14, namesSha256: "f97c4f5c68d0730de323d1f72ff85e58eafb5c24ea173db0e5382624fc4ff33c" },
      dependencies: ["node:util","src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-kernel-schema-subset", path: "src/kernel/schema-subset.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 6, namesSha256: "ac036fedd78ad53aaf092fe88cc5d555d8b904d8a46f024e9b9be1f025e531fb" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts","src/shared/json-pointer.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-kernel-test-surface-manifest", path: "src/kernel/test-surface-manifest.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 13, namesSha256: "c857f79f2daa6696570a820f72adad7d7903e890786a1f823e03a785d71a65ef" },
      dependencies: ["src/filesystem/path-boundary.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/kernel/ordered.ts","src/kernel/root-policy.ts","src/shared/source-scan.ts","zod"],
    }),
    moduleContract({
      id: "src-kernel-verification-paths", path: "src/kernel/verification-paths.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 9, namesSha256: "4d457a28749e00ad083ccfef9f34db9bd33ffecf3d1ef89e8c912f9a1a4e5e00" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-privacy-classification-catalog", path: "src/privacy/classification-catalog.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 9, namesSha256: "dfdcff7185fbf10cf9cf5026dd70ff3d1cb46a20254680ed02f5263ed467ec33" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"],
      authorityFamilies: ["data-classification"], authorityIdentifiers: ["CLASSIFICATION_CATALOG"],
    }),
    moduleContract({
      id: "src-privacy-data-policy", path: "src/privacy/data-policy.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 7, namesSha256: "3c16aa28b4c53599c055abee382abf266a04967422007536fa752e249334e69c" },
      dependencies: ["src/kernel/integrity.ts","src/kernel/root-policy.ts","src/privacy/classification-catalog.ts","src/privacy/secret-signals.ts","src/shared/best-effort.ts"],
    }),
    moduleContract({
      id: "src-privacy-secret-signals", path: "src/privacy/secret-signals.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 9, namesSha256: "a7b30711dc617a2edc07384e96b0a8c486feb447ef84e8dc87dbcbe02288bf84" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-runtime-capability-negotiation", path: "src/runtime/capability-negotiation.ts", realm: "shared", layer: "infrastructure",
      owner: "runtime-infrastructure", publicApi: { exportCount: 3, namesSha256: "917d18949b89a946133d24884eaf95668d8291c97b26058765d9a479992e14ee" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-runtime-event-state", path: "src/runtime/event-state.ts", realm: "shared", layer: "infrastructure",
      owner: "runtime-infrastructure", publicApi: { exportCount: 5, namesSha256: "6c39fc02ae21923b7c3a0f435380b0852607a23a25d62939aa0e32cf062598c7" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/kernel/protocol-projections.ts","src/kernel/root-policy.ts","src/runtime/sse-parser.ts","src/shared/json-pointer.ts","src/shared/llm/errors.ts","src/shared/llm/responses-stream.ts","src/shared/type-guards.ts"],
      authorityFamilies: ["events"], authorityIdentifiers: ["ChatCompletionEventState", "EVENT_STATE_REVISION", "ResponsesEventState"],
    }),
    moduleContract({
      id: "src-runtime-runtime-capabilities", path: "src/runtime/runtime-capabilities.ts", realm: "shared", layer: "infrastructure",
      owner: "runtime-infrastructure", publicApi: { exportCount: 3, namesSha256: "3ac9de502b1cde51fb1c7b048b075d4c3daa584e217e048346c4d540a067c425" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-kernel-config-contracts", path: "src/kernel/config-contracts.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 56, namesSha256: "98bada951993bb901a84a9b34192f6e85270ac1eaee09f823c8a0e74ce8bca2f" },
      dependencies: ["src/agents/agent-type-registry.ts","src/filesystem/path-boundary.ts","src/filesystem/self-protection/self-protection-config.ts","src/git/git-port.ts","src/intelligence/intelligence-config.ts","src/intelligence/retrieval.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/mcp/tool-name.ts","src/memory/memory-types.ts","src/performance/performance-config.ts","src/privacy/classification-catalog.ts","src/privacy/privacy-config-section.ts","src/repository-path/contracts.ts","src/safety/safety-config-section.ts","src/shared/debug/debug-config.ts","src/shared/exposure/module-config-sections.ts","src/shared/llm/config.ts","src/shared/llm/provider-endpoint.ts","src/shared/llm/responses.ts","src/shared/outbound-policy.ts","src/shared/run-history.ts","zod"],
      authorityFamilies: ["configuration"], authorityIdentifiers: ["getConfigDocumentSchema", "ConfigDocument"],
    }),
    moduleContract({
      id: "src-kernel-config", path: "src/kernel/config.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 20, namesSha256: "950943b9d01ddff1faad2ed6f3cdecd5baf5b4c5fc06d37fb4a59ad25d306a4f" },
      dependencies: ["node:fs","node:path","src/filesystem/link-containment.ts","src/filesystem/linux-path.ts","src/kernel/config-contracts.ts","src/kernel/engine-root.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/kernel/root-policy.ts","src/shared/identity.ts","src/shared/source-scan.ts"],
    }),
    moduleContract({
      id: "src-shared-module-location", path: "src/shared/module-location.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 8, namesSha256: "60e741d43b1c4c801c139ba174bf517ff0f217eb42f9cf8f09f6123fe4c9366a" },
      dependencies: ["node:fs","node:path","node:url","src/shared/best-effort.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-code-metrics", path: "src/awareness/signals/code-metrics.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 5, namesSha256: "75eb0f58ac9e2759e8294b8472cfdcdcfa1190a016310c162d355177c3e29911" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-combinatorics", path: "src/awareness/signals/combinatorics.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 4, namesSha256: "38887b4f8895c460773b8ee51939238089b9b248b02cc1374602c62ed12cc88f" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-diversity", path: "src/awareness/signals/diversity.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 5, namesSha256: "a743a0c3d0f26d8b04c51f8838f80ea479219d6935ee07421749715ed3d43f7b" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-fitness", path: "src/awareness/signals/fitness.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 5, namesSha256: "f109752b2c4d0e83e38081401e77e97f5e1d0d5a7653d507b67f7e0ad7fc0464" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-info-theory", path: "src/awareness/signals/info-theory.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 8, namesSha256: "db0eea821ec9da0840451d15f8807846eec5cb4496920687ff6f8489ac14ffa1" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-network", path: "src/awareness/signals/network.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 13, namesSha256: "1422a84361f2fd89a2bc7df2a7ae618d7bac6e23dcb7410ecfec3df3b500b0df" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-awareness-signals-physics", path: "src/awareness/signals/physics.ts", realm: "runtime", layer: "domain",
      owner: "awareness", publicApi: { exportCount: 4, namesSha256: "a2c00986af60e5919a6512c8aa96a85b6ea83b5e49179a1768439a0ba106f106" },
      dependencies: ["src/shared/numeric-helpers.ts"],
    }),
    moduleContract({
      id: "src-intelligence-retrieval", path: "src/intelligence/retrieval.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 8, namesSha256: "0e243f2ab8328bcda548bef139d6790634e7a02ef82ce6909045cf08e9f03ce6" },
      dependencies: ["src/intelligence/dependency-graph.ts","src/intelligence/intelligence-config.ts","src/intelligence/symbol-search.ts","src/kernel/errors.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-kernel-product-identity", path: "src/kernel/product-identity.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 7, namesSha256: "d8792dd67fb2cc7b74d02c3e1e85b94a10d82610d4cdec40ec59a2b18801a7e5" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-editor-edit-resolve", path: "src/editor/edit-resolve.ts", realm: "runtime", layer: "domain",
      owner: "editor", publicApi: { exportCount: 10, namesSha256: "dcaa2d30df49d4e97b86aee22079f9c5631cbc1ad59fe5f45931f815d8a3cebd" },
      dependencies: ["src/editor/edit-operations.ts","src/kernel/errors.ts","src/safety/hallucination-detector.ts"],
    }),
    moduleContract({
      id: "src-text-json-repair", path: "src/text/json-repair.ts", realm: "shared", layer: "domain",
      owner: "text-processing", publicApi: { exportCount: 3, namesSha256: "046eb198453b329c4a04a77d2ea548b678498546cce860b559fb115a0568b704" },
      dependencies: ["src/kernel/json-integrity.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-intelligence-farm-child", path: "src/intelligence/farm-child.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      dependencies: ["node:fs","src/intelligence/intelligence-config.ts","src/intelligence/language-registry.ts","src/intelligence/symbol-extractor.ts","src/intelligence/tree-sitter-backend.ts","src/kernel/errors.ts","src/process/fault-policy.ts","src/runtime/cli-debug.ts","src/shared/debug/debug-system.ts"], executionBoundary: "composition-root", compositionRoot: true,
    }),
    moduleContract({
      id: "src-intelligence-process-farm", path: "src/intelligence/process-farm.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 4, namesSha256: "0c43f578b08e3c0cc6af8f84798d14f77330eecc8a1544213943bd7384a641d3" },
      dependencies: ["node:child_process","node:os","node:path","node:url","src/intelligence/intelligence-config.ts","src/process/fault-policy.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "scripts-pin-authority-regeneration", path: "scripts/pin-authority-regeneration.ts", realm: "builder", layer: "verification",
      owner: "verification", publicApi: { exportCount: 6, namesSha256: "945e05f2aed67919185b38cf87dc8b15b9b859a94fea53dbeb384c48f1c002fe" },
      dependencies: ["@babel/parser","node:fs","node:path","node:url","scripts/regenerate-handoff-manifest.ts","src/filesystem/atomic-write.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/verification-paths.ts","src/runtime/cli-debug.ts"],
      executionBoundary: "composition-root", compositionRoot: true,
    }),
    moduleContract({
      id: "scripts-regenerate-handoff-manifest", path: "scripts/regenerate-handoff-manifest.ts", realm: "builder", layer: "verification",
      owner: "verification", publicApi: { exportCount: 3, namesSha256: "789f0df8cc466c8f2044295c731b879f9029f1046ac9b5a6855b5bf9d095fb53" },
      dependencies: ["node:fs","node:path","node:url","src/filesystem/atomic-write.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/modules/tasks-agents/domain/handoff-contracts.ts","src/modules/tasks-agents/domain/handoff-protocol-authority.ts","src/runtime/cli-debug.ts"],
      executionBoundary: "composition-root", compositionRoot: true,
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-performance", path: "src/shared/exposure/registrations/performance.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 6, namesSha256: "615e9974bf36cbf75dcc6e7bf79b32e9b5d393cb3f17d270b8e45dd096712c70" },
      dependencies: ["src/performance/performance-config.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-timeline", path: "src/shared/exposure/registrations/timeline.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 4, namesSha256: "eb6797401d93a73b3e29d08f71764da388bcdb7b3f941b34ce60d85641f5f3b2" },
      dependencies: ["src/kernel/config-contracts.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "performance-engine-instrumentation", path: "src/performance/engine-instrumentation.ts", realm: "shared", layer: "domain",
      owner: "performance-observability", publicApi: { exportCount: 6, namesSha256: "bafcfdf6a2c7ee48397c63754da267ecc3164bdf418829b3ed18ea045f35b1f0" },
      dependencies: ["src/kernel/integrity.ts","src/shared/type-guards.ts","src/timeline/recorded-effect.ts","src/timeline/recording-context.ts"],
      ports: { requires: ["recorded-effect", "recording-context"], provides: ["engine-instrumentation"] },
      responsibilities: ["engine-auto-instrumentation-decoration-owner"],
    }),
    moduleContract({
      id: "src-intelligence-repository-stat-scan", path: "src/intelligence/repository-stat-scan.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 13, namesSha256: "31d254cb4ba718624025b19a59c8dc95d4503332a505ada214094d11f7e17c29" },
      dependencies: ["node:fs","node:path","src/filesystem/link-containment.ts","src/filesystem/path-boundary.ts","src/intelligence/intelligence-config.ts","src/intelligence/intelligence-types.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-redaction", path: "src/shared/exposure/registrations/redaction.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 6, namesSha256: "f2b11fdc6ebd47bf1c4136566056de4018c8e93dec9398ad3275d6d52b00ffe2" },
      dependencies: ["src/kernel/config-contracts.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-workspace-git", path: "src/shared/exposure/registrations/workspace-git.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 4, namesSha256: "2993cdfd2338906a7f2a078ddfee7b225082a967e41fd6af84426e83b09c5d86" },
      dependencies: ["src/git/git-config.ts","src/kernel/config-contracts.ts","src/kernel/errors.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-privacy-privacy-config-section", path: "src/privacy/privacy-config-section.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 6, namesSha256: "4662e6893993b3baa953ef6e97d88aac5bbad98d881f66996690c61adf64e1a2" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/privacy/classification-catalog.ts","src/privacy/privacy-config.ts","src/privacy/privacy-policy.ts","src/privacy/secret-intelligence.ts","zod"],
    }),
    moduleContract({
      id: "src-kernel-config-write-lock", path: "src/kernel/config-write-lock.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 2, namesSha256: "50137fb78785fb6ea143c891662bbd5f3a9fba248f4397066191d86015e58898" },
      dependencies: ["node:path","src/filesystem/file-lock.ts","src/kernel/errors.ts","src/kernel/product-identity.ts"],
    }),
    moduleContract({
      id: "src-safety-safety-config-section", path: "src/safety/safety-config-section.ts", realm: "safety", layer: "application",
      owner: "providers-and-protocol", publicApi: { exportCount: 8, namesSha256: "d4828d77316e52821e4b7d8d413d7d686fca66d8a6946279ecbfc1b31ffe99c4" },
      dependencies: ["src/kernel/errors.ts","src/safety/bandaid-config.ts","src/safety/tool-call-gate.ts","zod"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-web-performance", path: "src/shared/exposure/registrations/web-performance.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "05226065149d6faa8151ba995f84da85882a3c7eeb3c1eff647b1148ae891564" },
      dependencies: ["src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-agents", path: "src/shared/exposure/registrations/agents.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "fd999ddd08420d509789741251841a729310f7437c89973ba37e49851815dba3" },
      dependencies: ["src/agents/agent-config.ts","src/agents/agents-config.ts","src/kernel/root-policy.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-harness-commands", path: "src/shared/exposure/registrations/harness-commands.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "3662662b6bf27587a59adb67d8f981c7fdb8b7d68159821ba2ac086b3f3fd357" },
      dependencies: ["src/evaluation/evaluation-config.ts","src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-test-execution", path: "src/shared/exposure/registrations/test-execution.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "a33b63a51213307f9e3286391f47663053d09323f705660d74ca938b3a1f5c33" },
      dependencies: ["src/shared/exposure/config-binding.ts","src/shared/exposure/index.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-kernel-lexical-policy", path: "src/kernel/lexical-policy.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 1, namesSha256: "ff0eab590d9d8de4d0aa9e2013c2cf5f42e3bb43a10a1dd60e92a3fa50bc23b1" },
      dependencies: [],
    }),
    moduleContract({
      id: "persisted-key",
      realm: "shared",
      layer: "infrastructure",
      owner: "filesystem-infrastructure",
      executionBoundary: "effect-adapter",
      effects: ["cryptography","filesystem-read","filesystem-write"],
      ports: {"requires":[],"provides":["persisted-root-key"]},
      stateOwners: ["private-persisted-root-key-publication"],
      responsibilities: ["admit-existing-key-or-publish-complete-private-no-overwrite-key"],
      path: "src/filesystem/persisted-key.ts",
      publicApi: { exportCount: 10, namesSha256: "72d3f395a2ed746f0c1a5a64e67bd703dd8bdea6a8650d68ba9d7fdcf22a2600" },
      dependencies: ["node:crypto","node:fs","node:path","src/filesystem/atomic-write.ts","src/filesystem/database-files.ts","src/filesystem/path-identity.ts","src/filesystem/private-state.ts","src/filesystem/self-protection/key-home.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "encrypted-field",
      realm: "shared",
      layer: "infrastructure",
      owner: "privacy-and-redaction",
      executionBoundary: "effect-adapter",
      effects: ["cryptography"],
      ports: {"requires":[],"provides":["authenticated-encrypted-field-codec"]},
      responsibilities: ["single-existing-field-wire-codec-and-key-authenticated-opacity"],
      path: "src/privacy/encrypted-field.ts",
      publicApi: { exportCount: 11, namesSha256: "cebb412803858d48644e4c019e2a23a8be0e1d78d87c1a6a7fed9206c2f36a30" },
      dependencies: ["node:crypto","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "operational-redaction",
      realm: "shared",
      layer: "infrastructure",
      owner: "privacy-and-redaction",
      executionBoundary: "effect-adapter",
      effects: ["cryptography"],
      ports: {"requires":[],"provides":["authenticated-operational-projection"]},
      responsibilities: ["key-authenticated-ciphertext-opacity-before-domain-overlap-resolution"],
      path: "src/privacy/operational-redaction.ts",
      publicApi: { exportCount: 1, namesSha256: "215e71d52d017b7135d5dadc32f7119c42c93ffc625f3351eea34fa266db24af" },
      dependencies: ["src/kernel/json-integrity.ts","src/privacy/encrypted-field.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts"],
    }),
    moduleContract({
      id: "src-privacy-responses-observation", path: "src/privacy/responses-observation.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 6, namesSha256: "e149a0766b1709f7a0a0231040afe3f54b3917bd6445d93ba1d73fb399eb07b9" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/safe-structural.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts","src/privacy/responses-redaction.ts","src/privacy/secret-intelligence.ts","src/privacy/secret-signals.ts","src/shared/llm/config.ts","src/shared/llm/responses.ts","src/shared/string-values.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-runtime-governed-tool-dispatch", path: "src/runtime/governed-tool-dispatch.ts", realm: "shared", layer: "infrastructure",
      owner: "runtime-infrastructure", publicApi: { exportCount: 4, namesSha256: "b155c97ffa0ec73d6fec0f85e44fc1eea0b48022da74d2c944e91acb207c2e90" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/safety/tool-call-gate.ts"],
    }),
    moduleContract({
      id: "src-runtime-response-turn", path: "src/runtime/response-turn.ts", realm: "shared", layer: "infrastructure",
      owner: "runtime-infrastructure", publicApi: { exportCount: 6, namesSha256: "28cdd25a2409cd2de2d7bd399473a4520a962042ed84528d86af7023dd5f8f86" },
      dependencies: ["src/kernel/integrity.ts","src/shared/abort-signals.ts","src/shared/llm/errors.ts","src/shared/llm/responses.ts"],
    }),
    moduleContract({
      id: "src-shared-dependency-spans", path: "src/shared/dependency-spans.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 1, namesSha256: "dc5887c999900601219ed724e72c2f2700ca0f5dd078d6031e07f91a07157078" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-shared-llm-provider-endpoint", path: "src/shared/llm/provider-endpoint.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 2, namesSha256: "c1ac1888c6726bd4278eb9b641c08a84b02ac1b922603c758a0d331875d5ab5e" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-shared-llm-provider-failure", path: "src/shared/llm/provider-failure.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 2, namesSha256: "57ee4a23d83c8d259c387ab060c10a20ef30d870b752fb7b03aad9c5365e89fe" },
      dependencies: ["src/privacy/held-set.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts","src/shared/llm/errors.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-shared-llm-provider-observation", path: "src/shared/llm/provider-observation.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 8, namesSha256: "c7e70e7383697e82c68e18f246df94e7ed7b214a99b1cdaba2824e08d18da8c9" },
      dependencies: ["src/kernel/errors.ts","src/privacy/held-set.ts","src/privacy/privacy-policy.ts","src/privacy/redaction-engine.ts","src/privacy/responses-redaction.ts","src/privacy/secret-signals.ts","src/shared/string-values.ts"],
    }),
    moduleContract({
      id: "src-shared-llm-response-transcript", path: "src/shared/llm/response-transcript.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 8, namesSha256: "b662ee7c532f4394488571905a4d1e2b0c5661e977ae087440456a7960520a81" },
      dependencies: ["src/kernel/integrity.ts","src/shared/dependency-spans.ts","src/shared/llm/responses.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-shared-llm-responses-disposition", path: "src/shared/llm/responses-disposition.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 6, namesSha256: "d6fde33d2c5e13df0c9162636198d5ec157a1f5280330c4d5afdc914974afe61" },
      dependencies: ["src/kernel/integrity.ts","src/shared/llm/errors.ts","src/shared/llm/responses.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-shared-llm-responses-stream", path: "src/shared/llm/responses-stream.ts", realm: "shared", layer: "domain",
      owner: "shared-llm", publicApi: { exportCount: 4, namesSha256: "0c98351b11075e3ca3bdeef97b6ef76f9a155bb3c898ddbcb85636ff7f11fa23" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/llm/errors.ts","src/shared/llm/provider-failure.ts","src/shared/llm/responses.ts","src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "src-shared-string-values", path: "src/shared/string-values.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 3, namesSha256: "0117e7439a5b09ce577144d06fb85c080d90de171a376640b629fdfd333677e6" },
      dependencies: ["src/shared/type-guards.ts"],
    }),
    moduleContract({
      id: "scripts-verification-catch-blocks", path: "scripts/verification/catch-blocks.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 5, namesSha256: "bb5d471a81d994ae40c2e8ac20dbe0522b271fd00bfcc8f208354088c9e8eae5" },
      dependencies: [],
    }),
    moduleContract({
      id: "scripts-verification-source-walk", path: "scripts/verification/source-walk.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 8, namesSha256: "fdab4f42dedb52cdd6a807bac4b187e6ba8d7e85d25e9d569f341d5efcef7dc4" },
      dependencies: ["node:fs","node:path","src/git/repository-ownership.ts","src/shared/source-scan.ts"],
    }),
    moduleContract({
      id: "src-filesystem-private-state", path: "src/filesystem/private-state.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 14, namesSha256: "8aa973d5ad8d6fbd25fdfd5b5d80e62d6cb06f3efaae6a0e00bc1257aee6f301" },
      dependencies: ["node:fs","node:path","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/process/fault-policy.ts","src/process/process-facts.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-git-repository-ownership", path: "src/git/repository-ownership.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 32, namesSha256: "be543d6d3c889da843aeecba676f31cefaac5412c83e29641ab936f714d63dbe" },
      dependencies: ["node:child_process","node:fs","node:path","src/kernel/errors.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-git-working-copy", path: "src/git/working-copy.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 11, namesSha256: "1c52ed4c566fda5c5238f30a9f1a81866bc656f1314338a27837310ad6bccaa4" },
      dependencies: ["node:child_process","node:fs","node:path","src/filesystem/private-state.ts","src/git/index-entries.ts","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-performance-configured-performance", path: "src/performance/configured-performance.ts", realm: "shared", layer: "domain",
      owner: "performance-observability", publicApi: { exportCount: 2, namesSha256: "f7e012224374c311fba90585798b758c93b8c3c9060d557e0671197b27471f36" },
      dependencies: ["src/kernel/config.ts","src/performance/performance-config.ts"],
    }),
    moduleContract({
      id: "src-workflow-checkout-setup", path: "src/workflow/checkout-setup.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 31, namesSha256: "24c36c6961c8ed7518a8b84f2c8998996e38c49d41b414a1ce8c4e44ae3ae15a" },
      dependencies: ["node:fs","node:os","node:path","node:string_decoder","node:url","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/git/repository-ownership.ts","src/git/working-copy.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/privacy/evidence-handler.ts","src/process/instrument-lock.ts","src/process/supervised-run.ts","src/shared/debug/debug-system.ts","src/shared/run-history.ts","src/workflow/test-result-collector.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-mcp-tool-name", path: "src/mcp/tool-name.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 7, namesSha256: "6499807c0ca93e1d6b3212a6c081f1d7cd85cc5ee76e027bed83b101920e176d" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/llm/responses.ts"],
    }),
    moduleContract({
      id: "src-mcp-transport-streamable-http", path: "src/mcp/transport/streamable-http.ts", realm: "runtime", layer: "domain",
      owner: "mcp", publicApi: { exportCount: 2, namesSha256: "352e5124fa21a072bda1d4dedfd3b63f1101c45bd256f90d8d7968390e66e337" },
      dependencies: ["src/kernel/contracts.ts","src/kernel/root-policy.ts","src/mcp/errors.ts","src/mcp/transport/types.ts","src/process/fault-policy.ts","src/runtime/sse-parser.ts","src/shared/abort-signals.ts","src/shared/best-effort.ts","src/shared/outbound-http.ts","src/shared/outbound-policy.ts"],
    }),
    moduleContract({
      id: "src-filesystem-checkout-write-door", path: "src/filesystem/checkout-write-door.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 9, namesSha256: "316741a0918f9f2d0857dc4f8be3a971ad721e42535d36df49e70278ad899841" },
      dependencies: ["node:fs","node:path","node:url","src/filesystem/path-identity.ts","src/kernel/errors.ts","src/kernel/root-policy.ts","src/process/process-facts.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-shared-outbound-http", path: "src/shared/outbound-http.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 27, namesSha256: "a921cc0ac3e879a7b37dd980757a3c84fad4ba7fb178d7447c84142493eac987" },
      dependencies: ["node:dns/promises","node:module","node:net","node:perf_hooks","src/filesystem/checkout-write-door.ts","src/kernel/errors.ts","src/kernel/root-policy.ts","src/process/environment-projection.ts","src/process/fault-policy.ts","src/process/live-network.ts","src/shared/abort-signals.ts","src/shared/debug/debug-system.ts","src/shared/outbound-policy.ts","undici","undici/lib/core/symbols"],
    }),
    moduleContract({
      id: "src-filesystem-journaled-commit", path: "src/filesystem/journaled-commit.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 8, namesSha256: "26e15d60790c5e61ab656a51dfd048572092eca1be6afc29dd5543f070de0286" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/filesystem/checkout-write-door.ts","src/filesystem/file-lock.ts","src/filesystem/path-identity.ts","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/process/process-facts.ts","src/shared/debug/debug-system.ts","zod"],
    }),
    moduleContract({
      id: "src-process-process-facts", path: "src/process/process-facts.ts", realm: "shared", layer: "infrastructure",
      owner: "process-infrastructure", publicApi: { exportCount: 42, namesSha256: "43dc2f6bb89192d45abb16c6a378cfa933b31809adea11415280cf989ef22fe2" },
      dependencies: ["node:fs","node:path","src/kernel/errors.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-process-environment-projection", path: "src/process/environment-projection.ts", realm: "shared", layer: "infrastructure",
      owner: "process-infrastructure", publicApi: { exportCount: 10, namesSha256: "4df363fbad92f910309b41aac38ddbf676651cbcae6736adca36521e0cf2fc93" },
      dependencies: ["src/kernel/errors.ts","zod"],
    }),
    moduleContract({
      id: "src-shared-backoff", path: "src/shared/backoff.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 2, namesSha256: "7e7755cd8ebdc6d86fd9729c8925661d6803a3f43dc694d31c660528c1708887" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-network", path: "src/shared/exposure/registrations/network.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "937b56021d793ccf3e9b1176ce14cf793c00a58dfe7cd279cf28cce50a9c9d65" },
      dependencies: ["src/shared/exposure/index.ts","src/shared/outbound-policy.ts"],
    }),
    moduleContract({
      id: "src-git-index-baseline", path: "src/git/index-baseline.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 10, namesSha256: "e55ba2a48a884af629d0b437b53fc1d3c0563592d5e6df2d8d30e859565689c3" },
      dependencies: ["node:child_process","node:fs","node:path","src/filesystem/private-state.ts","src/git/checkout-state-record.ts","src/git/git-port.ts","src/git/index-entries.ts","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","zod"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-settings", path: "src/shared/exposure/registrations/settings.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 3, namesSha256: "b2fdb376fdaa1fb13432b35ca63b6821c3229caac111970f350cc54361dfb111" },
      dependencies: ["src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-filesystem-database-files", path: "src/filesystem/database-files.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 18, namesSha256: "fa0cdbbf116208ce817ba3a16a1119d90f31cf4d076924f89437864f99f9bbd0" },
      dependencies: ["node:fs","node:path","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-filesystem-path-identity", path: "src/filesystem/path-identity.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 15, namesSha256: "365e84cba71031bf5ed2fc93f2ecd3462f63ad37d943870782824df5ab4a1cc0" },
      dependencies: ["node:fs","node:path","src/filesystem/linux-path.ts","src/kernel/errors.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-filesystem-self-protection-keep-out", path: "src/filesystem/self-protection/keep-out.ts", realm: "shared", layer: "trusted-kernel",
      owner: "self-protection", publicApi: { exportCount: 16, namesSha256: "ce5c94e6dab28132389ae695b1bbf119de690d3deeb349f2f2b080496f166cdc" },
      dependencies: ["node:fs","node:os","node:path","src/filesystem/database-files.ts","src/filesystem/linux-path.ts","src/filesystem/path-identity.ts","src/filesystem/private-home.ts","src/filesystem/user-folders.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-filesystem-self-protection-key-home", path: "src/filesystem/self-protection/key-home.ts", realm: "shared", layer: "trusted-kernel",
      owner: "self-protection", publicApi: { exportCount: 14, namesSha256: "28678b75e5426b93a40fe2755969be0e25c21c9a11bd519e9adffbfa089b5d88" },
      dependencies: ["node:fs","node:os","node:path","src/filesystem/atomic-write.ts","src/filesystem/database-files.ts","src/filesystem/path-identity.ts","src/filesystem/private-home.ts","src/filesystem/private-state.ts","src/filesystem/self-protection/self-protection-config.ts","src/kernel/engine-root.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts","zod"],
    }),
    moduleContract({
      id: "src-privacy-held-set", path: "src/privacy/held-set.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 7, namesSha256: "897dce834498ce1395f002b8bbc6ae64d1f8022811a2296241760b046ba3373e" },
      dependencies: ["src/privacy/pii-registry.ts","src/privacy/secret-intelligence.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-privacy-secret-files", path: "src/privacy/secret-files.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 2, namesSha256: "4a979b519d0565bfdd9012f3c54faba6995bec9e653b228485fb039f7c6756a5" },
      dependencies: ["src/kernel/root-policy.ts","src/privacy/privacy-policy.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-database", path: "src/shared/exposure/registrations/database.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 10, namesSha256: "84723abd46e6e1bf507df200dcce97ac4c8f0ee463cc35a598681c5c06f0b14a" },
      dependencies: ["src/kernel/errors.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-git-index-entries", path: "src/git/index-entries.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 4, namesSha256: "b0d53c4104a03800676d6664fb7afc6febd5c7be8bd3c45446f283cee0936436" },
      dependencies: ["src/git/git-port.ts","src/git/repository-ownership.ts","src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-runtime-cli-debug", path: "src/runtime/cli-debug.ts", realm: "shared", layer: "infrastructure",
      owner: "runtime-infrastructure", publicApi: { exportCount: 2, namesSha256: "6b1b821df91b456cd9795e868d79c73b3f9abc4486cadfeb22dadd71daf8b9c5" },
      dependencies: ["node:fs","node:path","node:url","src/kernel/config.ts","src/process/fault-policy.ts","src/shared/debug/debug-config.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-filesystem-temporary-root", path: "src/filesystem/temporary-root.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 5, namesSha256: "edd0260b0dbe72044b876aa4d90b20db08e3841f748ab75d2a7d5595de21243f" },
      dependencies: ["node:fs","node:os","node:path","src/filesystem/private-state.ts","src/filesystem/self-protection/keep-out.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-kernel-engine-root", path: "src/kernel/engine-root.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 1, namesSha256: "aae08ab0a0fc72399f8880ca2cc57aafabd193a3b3bd13fe1ff1c54930ba8010" },
      dependencies: ["node:path","node:url","src/kernel/errors.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-privacy-secret-parts", path: "src/privacy/secret-parts.ts", realm: "shared", layer: "domain",
      owner: "privacy-and-redaction", publicApi: { exportCount: 10, namesSha256: "9c2129438e23b02c59aea96af4ef442ee20aaf26c2b7b691c1d361ad5dbcddb1" },
      dependencies: ["src/kernel/ordered.ts","src/privacy/data-policy.ts","src/privacy/secret-signals.ts"],
    }),
    moduleContract({
      id: "src-shared-outbound-policy", path: "src/shared/outbound-policy.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 14, namesSha256: "f5c528cb11e954965eb8a7f34328104d711233d2f8ab56cfa3e0327220b42da9" },
      dependencies: ["zod"],
    }),
    moduleContract({
      id: "scripts-verification-ratchet", path: "scripts/verification/ratchet.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 12, namesSha256: "ec3634849ee7cff9091d64b024d922855200aef961c62bff83a685c2260d5a4b" },
      dependencies: ["node:child_process","src/kernel/errors.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-filesystem-sqlite-wal", path: "src/filesystem/sqlite-wal.ts", realm: "shared", layer: "infrastructure",
      owner: "filesystem-infrastructure", executionBoundary: "effect-adapter", effects: ["filesystem-read","filesystem-write"],
      ports: {"requires":[],"provides":["sqlite-wal-journal","sqlite-checkpoint-progress"]},
      responsibilities: ["enter-wal-past-concurrent-first-openers-and-interpret-checkpoint-progress"],
      publicApi: { exportCount: 3, namesSha256: "36b563fac399d753c1bd03c239021c624e0dba3d9dd7256d5e0e35fc41e8822d" },
      dependencies: ["src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-timeline-timeline-sealing", path: "src/timeline/timeline-sealing.ts", realm: "runtime", layer: "infrastructure",
      owner: "evidence-ledger", executionBoundary: "effect-adapter", effects: ["cryptography","filesystem-read","filesystem-write"],
      ports: {"requires":[],"provides":["timeline-sealed-originals"]}, stateOwners: ["timeline-sealed-document-originals"],
      responsibilities: ["seal-and-open-the-originals-the-operational-projection-masked"],
      publicApi: { exportCount: 3, namesSha256: "7363dbd44f0510593d5624c592970b07b83a8f95a04e861d4531cfab61a6e699" },
      dependencies: ["src/forensics/forensic-crypto.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-workflow-module-contract-blocks", path: "src/workflow/module-contract-blocks.ts", realm: "shared", layer: "domain",
      owner: "verification-workflow", publicApi: { exportCount: 2, namesSha256: "fe4320aadafbaa5790dd4a180bcc3deb981576a769d45805844030566e178299" },
      dependencies: ["@babel/parser","src/quality-packs/prevention/ast-helpers.ts"],
      executionBoundary: "pure",
      responsibilities: ["read-architecture-manifest-module-blocks-as-data-without-loading-the-manifest"],
    }),
    moduleContract({
      id: "scripts-verification-ratchet-baselines", path: "scripts/verification/ratchet-baselines.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 8, namesSha256: "bee36b630680e6ae693095b2338bb3f4fb8118f88b22c10e47680a8d2db901a5" },
      dependencies: ["node:fs","node:path","node:url","node:util","scripts/verification/catch-blocks.ts","scripts/verification/ratchet.ts","scripts/verification/source-view.ts","scripts/verification/source-walk.ts","src/filesystem/atomic-write.ts","src/kernel/errors.ts","src/kernel/root-policy.ts","src/runtime/cli-debug.ts","src/workflow/record-links.ts"],
      executionBoundary: "composition-root", compositionRoot: true,
    }),
    moduleContract({
      id: "scripts-post-commit", path: "scripts/post-commit.ts", realm: "builder", layer: "verification",
      owner: "verification", publicApi: { exportCount: 0, namesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      dependencies: ["scripts/verification/lesson-trailers.ts","src/git/declared-deletions.ts","src/runtime/cli-debug.ts"],
      executionBoundary: "composition-root", compositionRoot: true,
    }),
    moduleContract({
      id: "src-git-declared-deletions", path: "src/git/declared-deletions.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 19, namesSha256: "aa38bda5d22ced575e63ba24053693265f9778fc4965ca90af729088896d88c1" },
      dependencies: ["node:fs","node:path","src/filesystem/file-lock.ts","src/git/checkout-state-record.ts","src/git/git-port.ts","src/git/ignored-copies.ts","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/product-identity.ts","src/shared/debug/debug-system.ts","zod"],
    }),
    moduleContract({
      id: "src-filesystem-file-lock", path: "src/filesystem/file-lock.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 13, namesSha256: "ad1485893754f5c131c3e8e4ef4a2ffc8e0bd50996b4211b62c208127faa04a6" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/process/fault-policy.ts","src/process/process-facts.ts","src/shared/best-effort.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "src-git-checkout-state-record", path: "src/git/checkout-state-record.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 3, namesSha256: "7796c6a6ad41e28e3ae0febbd1d8803cc6ac4dfccbedfe89570a06ac971d8173" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-git-ignored-copies", path: "src/git/ignored-copies.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 7, namesSha256: "34581766ab0351ca3968c07f8b6bb12258a2976008c2ea1c14627654b4c3149a" },
      dependencies: ["node:child_process","node:fs","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-process-live-network", path: "src/process/live-network.ts", realm: "shared", layer: "infrastructure",
      owner: "process-infrastructure", publicApi: { exportCount: 2, namesSha256: "c98d30a139bbcb85b12bdf43b89bd16096256460a951f7f1ba66f0fff0b84ca7" },
      dependencies: ["src/kernel/root-policy.ts","src/shared/debug/debug-system.ts"],
    }),
    moduleContract({
      id: "scripts-verification-lesson-trailers", path: "scripts/verification/lesson-trailers.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 7, namesSha256: "59766ac80855c081992637826394c0532e86afda6e42a64a1e12bb6bffa45864" },
      dependencies: ["node:child_process","node:path","scripts/verification/tracker-entries.ts","src/git/repository-ownership.ts"],
    }),
    moduleContract({
      id: "scripts-verification-tracker-entries", path: "scripts/verification/tracker-entries.ts", realm: "builder", layer: "verification",
      owner: "verification-foundation", publicApi: { exportCount: 21, namesSha256: "1483b81f3f2e345abf054fa1a535b43f54e831876dec512a46fdd2e94c6e5303" },
      dependencies: ["node:fs","node:path","src/kernel/verification-paths.ts"],
    }),
    moduleContract({
      id: "src-process-supervised-run", path: "src/process/supervised-run.ts", realm: "shared", layer: "infrastructure",
      owner: "process-infrastructure", publicApi: { exportCount: 8, namesSha256: "00dc2158183703dc4b65bfd6f2e55e808160beffeecec56ea2955ae1a705b8cb" },
      dependencies: ["node:child_process","node:os","src/kernel/errors.ts","src/kernel/root-policy.ts","src/process/fault-policy.ts","src/process/instrument-lock-adoption.ts","src/process/process-facts.ts"],
    }),
    moduleContract({
      id: "src-filesystem-move-path", path: "src/filesystem/move-path.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 1, namesSha256: "168bb287eb74cdf31deccb1a08dcd4d6d636a387c03550ab0bbaee068775cc78" },
      dependencies: ["node:fs","src/filesystem/checkout-write-door.ts","src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-workflow-workspace-registry", path: "src/workflow/workspace-registry.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 3, namesSha256: "2557f9fb4e72b16f5573102ef412e9c41b72d4d998e5274a5f53487e1f9aaac8" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/filesystem/file-lock.ts","src/filesystem/private-state.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/workflow/repository-registry.ts","src/workflow/workspace-contracts.ts"],
    }),
    moduleContract({
      id: "src-git-tree-reader", path: "src/git/tree-reader.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 11, namesSha256: "374e6d57eae1c77286d2046a9052d53d690ffcee51df61b73ab9a1d0e8702399" },
      dependencies: ["node:child_process","node:fs","node:path","src/filesystem/private-state.ts","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-codes", path: "src/workflow/promotion/codes.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 10, namesSha256: "401e07107e408ad8fe0426e5f8ebbd266cbca3a4e49ea0301f82a6376ef6a010" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-profile", path: "src/workflow/promotion/profile.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 10, namesSha256: "3a9c3a70ed3ceab85a4a74adf2c57bce7dd0e9f31a795d9a8e90934e6022c8e2" },
      dependencies: ["src/git/repository-ownership.ts","src/kernel/config-contracts.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/kernel/product-identity.ts","src/workflow/promotion/codes.ts","zod"],
    }),
    moduleContract({
      id: "src-workflow-promotion-projection", path: "src/workflow/promotion/projection.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 13, namesSha256: "b5c2942de5f953b0cb067171faa98e156fb891e162c960434afda54c05d71345" },
      dependencies: ["node:fs","node:path","node:url","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/git/tree-reader.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/workflow/checkout-setup.ts","src/workflow/hash-binding-registry.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/profile.ts","src/workflow/promotion/trailers.ts","src/workflow/promotion/transforms.ts","src/workflow/reachability.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-promote-cli", path: "src/workflow/promotion/promote-cli.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 2, namesSha256: "6248b05790c1ac5125fbac03a7d02b8ced5dcb0464d0bad4f486ba580c28ed3e" },
      dependencies: ["src/kernel/integrity.ts","src/workflow/command-result.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/context.ts","src/workflow/promotion/promote-arguments.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-transforms", path: "src/workflow/promotion/transforms.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 6, namesSha256: "729db1d31606aad1d4dd619155855c4588c728f7f553e7010263dc47a310ba53" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/kernel/integrity.ts","src/kernel/json-integrity.ts","src/workflow/checkout-setup.ts","src/workflow/promotion/codes.ts","src/workflow/reachability.ts"],
    }),
    moduleContract({
      id: "src-workflow-reachability", path: "src/workflow/reachability.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 16, namesSha256: "2f02fe28da8b068e1ffb653c04b5baa74891c4ec413856c43ea7e17e5b176319" },
      dependencies: ["node:module","src/intelligence/js-tokenizer.ts","src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-workflow-repository-registry", path: "src/workflow/repository-registry.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 8, namesSha256: "8e59d3b575f86686ee73a3b12aab97c5cae8226fc5ec7c2885cbf8ff22a44fba" },
      dependencies: ["node:fs","node:path","src/kernel/integrity.ts","src/kernel/product-identity.ts"],
    }),
    moduleContract({
      id: "src-intelligence-js-tokenizer", path: "src/intelligence/js-tokenizer.ts", realm: "runtime", layer: "domain",
      owner: "code-intelligence", publicApi: { exportCount: 2, namesSha256: "f36f25d3404d8b796cc8ee091feb8529666bdec277d3d8d2178760959c2c9ed4" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-promotion", path: "src/shared/exposure/registrations/promotion.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 5, namesSha256: "d4eb2f04ef3d2373602a6c67fa9667c7ee3c1487b83283c53efee3b46f1d3535" },
      dependencies: ["src/kernel/errors.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-context", path: "src/workflow/promotion/context.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 7, namesSha256: "8a6365a1a33b40b891596acd87aa0b6e6de3b2dfaa1e937ad08cf1bf1115beba" },
      dependencies: ["guardian/build.ts","node:child_process","node:fs","node:path","src/filesystem/private-state.ts","src/git/tree-reader.ts","src/git/worktree-port.ts","src/kernel/config.ts","src/kernel/integrity.ts","src/process/environment-projection.ts","src/shared/debug/debug-system.ts","src/shared/run-history.ts","src/workflow/checkout-setup.ts","src/workflow/hash-binding-registry.ts","src/workflow/promotion/apply.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/last-run.ts","src/workflow/promotion/profile.ts","src/workflow/promotion/projection.ts","src/workflow/promotion/promoter-home.ts","src/workflow/promotion/promotion-run.ts","src/workflow/promotion/publication.ts","src/workflow/promotion/rollback.ts","src/workflow/promotion/trailers.ts","src/workflow/promotion/trigger.ts","src/workflow/repository-registry.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-apply", path: "src/workflow/promotion/apply.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 5, namesSha256: "82593eaab07b895bc63d7c8babc4883345bcff03dbbc7d8d768b17e2f0d987f2" },
      dependencies: ["node:fs","node:path","src/git/tree-reader.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts","src/workflow/checkout-setup.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/last-run.ts","src/workflow/promotion/profile.ts","src/workflow/promotion/promotion-run.ts","src/workflow/promotion/publication.ts","src/workflow/promotion/trailers.ts","src/workflow/resource-lock.ts","src/workflow/tree-landing.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-promoter-home", path: "src/workflow/promotion/promoter-home.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 8, namesSha256: "42156510b5df4b917054dd56bdb9cde1bd476f2001d029aa739e7d62c6c6b008" },
      dependencies: ["node:fs","node:path","node:url","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/git/tree-reader.ts","src/git/worktree-port.ts","src/kernel/engine-root.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/process/supervised-run.ts","src/shared/debug/debug-system.ts","src/workflow/checkout-setup.ts","src/workflow/hash-binding-registry.ts","src/workflow/promotion/apply.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/promote-arguments.ts","src/workflow/promotion/promotion-run.ts","src/workflow/tree-landing.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-workflow-tree-landing", path: "src/workflow/tree-landing.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 21, namesSha256: "fa3be7b355fc792d6ba2f3d356c1a788f45c9982428ae74a0d85cb7532e0698b" },
      dependencies: ["node:fs","node:path","src/git/worktree-port.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/shared/debug/debug-system.ts","src/workflow/checkout-setup.ts"],
    }),
    moduleContract({
      id: "src-workflow-command-result", path: "src/workflow/command-result.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 12, namesSha256: "4de9be42c6dd165be585e533cba066913f5148f3c25eb9fc5b97c463c310b2d7" },
      dependencies: ["src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-promote-arguments", path: "src/workflow/promotion/promote-arguments.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 4, namesSha256: "029646844564bea2e5f9f821ca06e9dc043857a63f7643f9f5b466c010849e3f" },
      dependencies: ["src/kernel/integrity.ts","src/workflow/promotion/codes.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-last-run", path: "src/workflow/promotion/last-run.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 8, namesSha256: "eeb9806c61f33d96b2f3b76218357c566d763444d26432bbdc4186b0c17bfa6a" },
      dependencies: ["node:fs","node:path","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/process/process-facts.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-promotion-run", path: "src/workflow/promotion/promotion-run.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 15, namesSha256: "50c829a83a626f2366deee70eec32a7ddfae63015e859adea8e8c951b4b58ad6" },
      dependencies: ["node:fs","node:path","src/git/tree-reader.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts","src/workflow/checkout-setup.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/profile.ts","src/workflow/repository-registry.ts","src/workflow/resource-lock.ts","src/workflow/tree-landing.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-publication", path: "src/workflow/promotion/publication.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 12, namesSha256: "334f9ea577b2935c6ab1281e4ca34835c69d5a5c7ff6e68d505175ab49c543c1" },
      dependencies: ["node:fs","node:os","node:path","src/filesystem/journaled-commit.ts","src/git/index-baseline.ts","src/git/tree-reader.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/shared/debug/debug-system.ts","src/workflow/checkout-setup.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/profile.ts","src/workflow/promotion/promoter-home.ts","src/workflow/promotion/promotion-run.ts","src/workflow/tree-landing.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-rollback", path: "src/workflow/promotion/rollback.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 3, namesSha256: "0132c68fd10c2344109d47c0e2c8c76fd665ca20a47292ce3655d68621bd2886" },
      dependencies: ["src/git/tree-reader.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts","src/workflow/promotion/apply.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/last-run.ts","src/workflow/promotion/profile.ts","src/workflow/promotion/promotion-run.ts","src/workflow/promotion/publication.ts","src/workflow/promotion/trailers.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-trailers", path: "src/workflow/promotion/trailers.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 6, namesSha256: "ba593be9f76b0ef7d52a342e6e36fa998c74eeccc64791c713e8b927c15ae30a" },
      dependencies: ["src/git/tree-reader.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-trigger-hook", path: "src/workflow/promotion/trigger-hook.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 4, namesSha256: "c4bddae919d500ef1e79613537add0481bbd398b8144e032c939a351d9eba9ff" },
      dependencies: ["src/kernel/root-policy.ts","src/kernel/verification-paths.ts"],
    }),
    moduleContract({
      id: "src-workflow-promotion-trigger", path: "src/workflow/promotion/trigger.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 5, namesSha256: "1661a1f614b21eeeb9856dd3542986ff15aef930f26ae7cf38db58f94fd08a5a" },
      dependencies: ["node:fs","src/git/tree-reader.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/process/supervised-run.ts","src/shared/debug/debug-system.ts","src/workflow/promotion/codes.ts","src/workflow/promotion/last-run.ts","src/workflow/promotion/profile.ts","src/workflow/promotion/promote-arguments.ts","src/workflow/promotion/promoter-home.ts","src/workflow/promotion/promotion-run.ts","src/workflow/promotion/trailers.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-filesystem-database-provenance", path: "src/filesystem/database-provenance.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 6, namesSha256: "bdbabbcc6b391f46ea1768051f7f01bd1e57e2d53b763edf8b7d319bd20f3f1e" },
      dependencies: ["node:fs","node:os","node:path","src/filesystem/checkout-write-door.ts","src/kernel/errors.ts"],
    }),
    moduleContract({
      id: "src-process-fault-policy", path: "src/process/fault-policy.ts", realm: "shared", layer: "infrastructure",
      owner: "process-infrastructure", publicApi: { exportCount: 10, namesSha256: "2220ae24d9b16e6a4f520df7bbe2302befdc3a16cdfdbfe5fe21bad9ae50ea1e" },
      dependencies: ["node:util","src/shared/debug/debug-system.ts","src/shared/fault-description.ts"],
    }),
    moduleContract({
      id: "src-shared-exposure-registrations-process", path: "src/shared/exposure/registrations/process.ts", realm: "shared", layer: "domain",
      owner: "shared-exposure-registrations", publicApi: { exportCount: 2, namesSha256: "9b5540349ea0d2a4c53c07f348cfdce2cd8265f297616dbd6dfa42dbf8210b27" },
      dependencies: ["src/process/fault-policy.ts","src/shared/exposure/index.ts"],
    }),
    moduleContract({
      id: "src-shared-fault-description", path: "src/shared/fault-description.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 4, namesSha256: "0a333d8ae883d842845322c0589e20c9ca52f7cccb0366cadc80e7a3b79d773c" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-process-worker-bootstrap", path: "src/process/worker-bootstrap.ts", realm: "shared", layer: "infrastructure",
      owner: "process-infrastructure", publicApi: { exportCount: 3, namesSha256: "10525ff0bf40b13119b47ae462f0eccf1617ff9aaee482da5bbe84d7a881da9a" },
      dependencies: ["node:worker_threads","src/kernel/errors.ts","src/process/fault-policy.ts","src/shared/debug/debug-system.ts","src/shared/fault-description.ts"],
    }),
    moduleContract({
      id: "src-workflow-evidence-store", path: "src/workflow/evidence-store.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 26, namesSha256: "3ea224d8e025c385fe2983a24b5baefc7ebb8b25eeeb664ef742f97ea7b746a1" },
      dependencies: ["node:fs","node:os","node:path","src/filesystem/atomic-write.ts","src/filesystem/file-lock.ts","src/filesystem/immutable-receipt.ts","src/filesystem/path-boundary.ts","src/filesystem/path-identity.ts","src/filesystem/private-home.ts","src/git/repository-ownership.ts","src/git/tree-reader.ts","src/git/worktree-port.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/runtime/admitted-node-runtime.ts","src/shared/debug/debug-system.ts","zod"],
    }),
    moduleContract({
      id: "src-workflow-record-links", path: "src/workflow/record-links.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 10, namesSha256: "acbd3870beb28caeaea9aa066b95ab3f345ad50f25e02cf13af52f31f07a3397" },
      dependencies: ["../shared/markdown.ts","node:fs","node:path","src/filesystem/atomic-write.ts","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/privacy/data-policy.ts","src/workflow/evidence-store.ts","zod"],
    }),
    moduleContract({
      id: "src-filesystem-private-home", path: "src/filesystem/private-home.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 9, namesSha256: "265b5dad944ab26b213de145aec9bf11f80eb45ea8920bc62309ec1042ef0b6f" },
      dependencies: ["node:fs","node:path","src/filesystem/checkout-write-door.ts","src/filesystem/path-identity.ts","src/filesystem/private-state.ts","src/filesystem/user-folders.ts","src/kernel/errors.ts","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-workflow-failure-owners", path: "src/workflow/failure-owners.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 6, namesSha256: "4044e8f291850ee789a6cb542764d3b4d0c4677e0b225ddee39872c92eb1ac57" },
      dependencies: ["src/kernel/integrity.ts"],
    }),
    moduleContract({
      id: "src-git-flake-cause-fixes", path: "src/git/flake-cause-fixes.ts", realm: "shared", layer: "ports",
      owner: "workspace-git", publicApi: { exportCount: 10, namesSha256: "9cedfe843e40c4f09161feb443188192b7fa1facbc5224c56667eaefc238cfb4" },
      dependencies: ["src/git/tree-reader.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/quality/languages/semantic-form.ts","src/shared/flake-reproduction.ts","src/shared/run-history.ts"],
    }),
    moduleContract({
      id: "src-workflow-slot-cli", path: "src/workflow/slot-cli.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 4, namesSha256: "e5d11f41be3349fc06d7bf8d087959098239d68ac1485686f86f222a9da0d5da" },
      dependencies: ["guardian/build.ts","node:os","node:path","node:url","src/kernel/errors.ts","src/kernel/integrity.ts","src/process/instrument-lock.ts","src/process/supervised-run.ts","src/workflow/command-result.ts","src/workflow/test-result-collector.ts"],
    }),
    moduleContract({
      id: "src-process-instrument-lock-adoption", path: "src/process/instrument-lock-adoption.ts", realm: "shared", layer: "infrastructure",
      owner: "process-infrastructure", publicApi: { exportCount: 3, namesSha256: "fbb9ded126b3b1adc9a9ef562d7a22306d3d7f3738881f77aeb4d911e3e8059b" },
      dependencies: [],
    }),
    moduleContract({
      id: "src-process-instrument-lock", path: "src/process/instrument-lock.ts", realm: "shared", layer: "infrastructure",
      owner: "process-infrastructure", publicApi: { exportCount: 12, namesSha256: "ffbba75670bca31ca420d825e003cf06226d6799e951d71b80477d01c2f58689" },
      dependencies: ["node:path","src/filesystem/file-lock.ts","src/filesystem/path-identity.ts","src/filesystem/self-protection/keep-out.ts","src/filesystem/user-folders.ts","src/git/repository-ownership.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/process/fault-policy.ts","src/process/instrument-lock-adoption.ts","src/process/process-facts.ts"],
    }),
    moduleContract({
      id: "src-filesystem-user-folders", path: "src/filesystem/user-folders.ts", realm: "shared", layer: "domain",
      owner: "filesystem-infrastructure", publicApi: { exportCount: 6, namesSha256: "0c7dfb0f6a92164d983f7122134f384fe627850788e9fe9dc4ead7e4ea2a524a" },
      dependencies: ["node:os","node:path","src/kernel/root-policy.ts"],
    }),
    moduleContract({
      id: "src-shared-flake-reproduction", path: "src/shared/flake-reproduction.ts", realm: "shared", layer: "domain",
      owner: "shared-abort-signals", publicApi: { exportCount: 28, namesSha256: "6556e14f9baefc27a39059dd9051a293a3c3564fb57b35072e5159dbe76be83a" },
      dependencies: ["node:fs","node:path","src/filesystem/user-folders.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","zod"],
    }),
    moduleContract({
      id: "src-workflow-flake-cli", path: "src/workflow/flake-cli.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 21, namesSha256: "61aac73364be11e46eccf7372676c846c42432b692b0c41b4c3f9df0b8315d4c" },
      dependencies: ["guardian/build.ts","node:fs","node:os","node:path","node:url","src/filesystem/atomic-write.ts","src/filesystem/private-state.ts","src/filesystem/temporary-root.ts","src/git/flake-cause-fixes.ts","src/git/repository-ownership.ts","src/git/tree-reader.ts","src/git/worktree-port.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/root-policy.ts","src/kernel/verification-paths.ts","src/privacy/evidence-handler.ts","src/privacy/secret-signals.ts","src/process/instrument-lock.ts","src/process/supervised-run.ts","src/shared/flake-reproduction.ts","src/shared/run-history.ts","src/workflow/checkout-setup.ts","src/workflow/command-result.ts","src/workflow/evidence-store.ts","src/workflow/repository-registry.ts","src/workflow/test-result-collector.ts","src/workflow/workflow-config.ts"],
    }),
    moduleContract({
      id: "src-quality-languages-semantic-form", path: "src/quality/languages/semantic-form.ts", realm: "runtime", layer: "domain",
      owner: "quality", publicApi: { exportCount: 2, namesSha256: "87806ee5791a1b3489bf14596ff9d3376030c2400b6e54dc75bf0bc73f569d76" },
      dependencies: ["node:path","src/kernel/errors.ts","src/kernel/integrity.ts","src/quality-packs/prevention/ast-helpers.ts","src/quality/languages/shared/tree-sitter-loader.ts","src/shared/source-extensions.ts"],
    }),
    moduleContract({
      id: "src-workflow-flaky-burn-down", path: "src/workflow/flaky-burn-down.ts", realm: "runtime", layer: "infrastructure",
      owner: "verification-workflow", publicApi: { exportCount: 11, namesSha256: "8eb2a88dd3ab759ce3d90648abfad9d9ecc98cc6da768b2ea00b4bab5484d641" },
      dependencies: ["node:fs","node:path","src/git/flake-cause-fixes.ts","src/git/tree-reader.ts","src/git/worktree-port.ts","src/kernel/config.ts","src/kernel/errors.ts","src/kernel/integrity.ts","src/kernel/product-identity.ts","src/kernel/root-policy.ts","src/shared/debug/debug-system.ts","src/shared/run-history.ts","src/workflow/failure-owners.ts"],
    }),
    moduleContract({
      id: "src-kernel-web-performance-budgets", path: "src/kernel/web-performance-budgets.ts", realm: "shared", layer: "trusted-kernel",
      owner: "architecture", publicApi: { exportCount: 3, namesSha256: "420b51dd6d29bbc97c77a370994d411c602a2b702125936e76854baa4057ff19" },
      dependencies: [],
    }),
  ],
});
