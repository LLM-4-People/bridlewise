import { deepFreeze } from "../kernel/integrity.ts";

/**
 * CHEP-1.0 evaluation domain types.
 *
 * Provider-neutral types for the coding-harness evaluation matrix, scenario
 * runner, and budget calculator. The matrix document follows the CHEP-1.0
 * JSON schema at `verification/benchmarks/evaluation/harness-eval-matrix.schema.json`.
 */

export const CHEP_PROTOCOL_ID = "CHEP-1.0" as const;
export const CHEP_SCHEMA_VERSION = "1.0.0" as const;
export const CHEP_GENERATOR_VERSION = "CHEP-GEN-1.0" as const;
export const CHEP_MASTER_SEED_HEX =
  "4825f13e3c194ca6dc53f8127d9000ed5658a202abe188058750c325f952da3d" as const;

/**
 * EXEMPT FROM THE NO-VENDOR-DEFAULTS RULE, AND HERE IS WHY. The rule this
 * would otherwise break ("no provider or model ships in the repository")
 * exists because a shipped default silently answers a runtime question —
 * which endpoint, whose credential, which model serves the request. This
 * pair answers none of those: it is a PROTOCOL FIXTURE. CHEP-1.0's
 * preregistered design requires exactly two model IDENTIFIERS to generate
 * its two-model cross-product matrix (`complete_two_model_cross_for_every_
 * test`), and the matrix is a document — generating it never picks an
 * endpoint, never resolves a credential and never sends a request. The
 * moment a scenario RUNS, the provider comes from the user's own runtime
 * configuration through `resolveProvider`/`resolveModel`, which refuse when
 * none is declared; these two strings are the canonical qualification
 * pair's NAMES (REQ-030/USR-030), overridable per invocation via the eval
 * CLI's `--models`, and changing them changes which preregistered matrix is
 * generated — not where anything is sent.
 */
export const CHEP_MODELS = deepFreeze([
  "google/gemma-4-26B-A4B",
  "zai-org/GLM-5.2-NVFP4",
] as const);

/**
 * A model identifier is an opaque string. The CHEP-1.0 protocol requires
 * exactly two models for the complete cross-product (see
 * `complete_two_model_cross_for_every_test`), but the specific pair is
 * configurable so the eval CLI is model-agnostic. `CHEP_MODELS` is the
 * default pair for the canonical Makora qualification (REQ-030/USR-030).
 */
export type ChepModelId = string;

export const CHEP_REPETITIONS = 3;
export const CHEP_TARGET_SCORED_SCENARIOS = 1024;

/**
 * THE VOCABULARIES IN THIS FILE ARE OWNED BY THEIR ARRAYS, AND THE UNIONS ARE
 * DERIVED FROM THEM.
 *
 * Each of these used to be written twice — a union, then a `readonly Union[]`
 * listing the same strings — and the compiler could not hold the two
 * together, because an array of FEWER members is assignable to `readonly
 * Union[]`. Adding a fifth phase or a ninth arm to the union and forgetting
 * the array typechecked with zero errors, and the generator, which walks the
 * ARRAY, would have produced a matrix missing that phase or arm while every
 * per-member `Record<…>` in `matrix-generator.ts` compiled cleanly. A
 * preregistered factorial design that silently drops a factor is worse than
 * one that fails to build.
 *
 * `typeof ARRAY[number]` leaves one declaration, so the omission is not
 * merely discouraged — there is no second place to add a member to.
 */
export const CHEP_PHASE_NAMES = deepFreeze([
  "P0-shakedown",
  "P1-baseline",
  "P2-development",
  "P3-holdout",
] as const);

export type ChepPhaseName = typeof CHEP_PHASE_NAMES[number];

export const CHEP_CANONICAL_PHASE_COUNTS = deepFreeze({
  "P0-shakedown": 64,
  "P1-baseline": 512,
  "P2-development": 256,
  "P3-holdout": 256,
} as const);

export const DIFFICULTY_BANDS = deepFreeze([
  "tiny",
  "small",
  "medium",
  "large",
  "highly_complex",
] as const);

export type DifficultyBand = typeof DIFFICULTY_BANDS[number];

export const TASK_FAMILIES = deepFreeze([
  "bug-fix",
  "feature-api",
  "refactor-preservation",
  "performance-memory",
  "security",
  "concurrency-distributed",
  "dependency-language-framework-migration",
  "build-packaging-ci-deployment-config",
  "database-data-pipeline",
  "frontend-ui-accessibility",
  "systems-embedded-os",
  "tests-flake-repair",
  "documentation-executable-spec",
  "repository-scale-design-change",
] as const);

export type TaskFamily = typeof TASK_FAMILIES[number];

// The array owns it: a union beside a list of its members is one vocabulary
// in two declarations, and a list holding fewer members is assignable to
// `readonly T[]`, so a kind added to the union and forgotten in a list is
// silently dropped from a preregistered factorial design.
const PROMPT_KINDS = deepFreeze([
  "original",
  "normalized",
  "paraphrase",
  "contextual",
  "noisy",
  "clarification",
] as const);

export type PromptKind = typeof PROMPT_KINDS[number];

export const CONDITION_ARMS = deepFreeze([
  "D0-direct",
  "R1-reference",
  "N1-noop",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
] as const);

export type ConditionArm = typeof CONDITION_ARMS[number];

export type CommunicationGraph =
  | "none"
  | "solo"
  | "pipeline"
  | "star"
  | "parallel-review";

export type WorkspaceMode =
  | "no-tools-context-pack"
  | "single-workspace"
  | "immutable-snapshots-artifact-handoff"
  | "shared-workspace-separate-condition";

export const AGENT_SPECIALTIES = deepFreeze([
  "generalist-implementer-verifier",
  "implementer",
  "tester-reviewer",
  "triage-planner",
  "verifier-integrator",
  "repository-navigator",
  "test-reproduction-engineer",
  "reviewer-integrator",
  "domain-specialist",
  "adversarial-test-engineer",
  "threat-analyst",
  "profiler",
  "benchmark-verifier",
  "ui-accessibility-reviewer",
] as const);

export type AgentSpecialty = typeof AGENT_SPECIALTIES[number];

export type ArtifactAccessClass = "public" | "restricted" | "sealed-holdout";

export type ChepArtifact = Readonly<{
  uri: string;
  sha256: string;
  media_type: string;
  size_bytes: number;
  access_class: ArtifactAccessClass;
}>;

export type AgentRoleRecord = Readonly<{
  role_id: string;
  specialty: AgentSpecialty;
  role_prompt_sha256: string;
  can_mutate_candidate_workspace: boolean;
}>;

export type TopologyRecord = Readonly<{
  agent_count: number;
  roles: readonly AgentRoleRecord[];
  communication_graph: CommunicationGraph;
  workspace_mode: WorkspaceMode;
  deterministic_orchestrator: true;
  model_backed_orchestrator: false;
}>;

export type ConditionRecord = Readonly<{
  condition_id: string;
  arm: ConditionArm;
  harness_version: "reference-1.0" | "candidate-v0" | "candidate-v1";
  topology: TopologyRecord;
  budget_policy_id: string;
  fault_profile_id: string;
  tool_schema_sha256: string;
  system_prompt_sha256: string;
  harness_artifact: ChepArtifact;
  adapter_artifact: ChepArtifact;
  trace_capture: "exhaustive";
  model_specific_branching: false;
  adaptive_assignment: false;
  retry_policy_artifact: ChepArtifact;
  noop_conformance_artifact?: ChepArtifact;
  content_hash: string;
}>;

export type BudgetPolicyRecord = Readonly<{
  budget_policy_id: string;
  mode: "resource-equalized-primary" | "native-scale-secondary";
  total_model_tokens: number;
  wall_time_seconds: number;
  max_model_calls: number;
  max_tool_calls: number;
  cpu_count: number;
  memory_bytes: number;
  disk_bytes: number;
  tool_output_bytes_per_call: number;
  network_policy: "deny-except-fixture-local";
  verifier_time_seconds: number;
  oracle_safety_margin_recorded: true;
  per_agent_token_allocation?: readonly number[];
  content_hash: string;
}>;

export type FaultEventRecord = Readonly<{
  fault_type: string;
  trigger_specification: ChepArtifact;
  severity: "low" | "medium" | "high" | "critical";
  identical_across_paired_arms: true;
}>;

export type FaultProfileRecord = Readonly<{
  fault_profile_id: string;
  profile_kind:
    | "natural-no-injection"
    | "provider-harness-injection"
    | "repository-adversarial"
    | "scoring-adversarial";
  events: readonly FaultEventRecord[];
  timing_seeded: true;
  outcome_adaptive: false;
  content_hash: string;
}>;

export type ScenarioSeed = Readonly<{
  scenarioId: string;
  difficulty: DifficultyBand;
  taskFamily: TaskFamily;
  secondaryTaskFamilies: readonly string[];
  languageFamily: string;
  ecosystem: string;
  projectRef: string;
  displayName: string;
  promptVariants: Readonly<Record<PromptKind, string>>;
  expectedOutputs: string;
  agentFields: readonly string[];
  hiddenOracles: readonly HiddenOracle[];
  repositorySizeLoc: number;
  repositoryFileCount: number;
  estimatedComponentsTouched: number;
  multiService: boolean;
  polyglot: boolean;
}>;

export type HiddenOracle = Readonly<{
  name: string;
  kind: "regex-match" | "contains" | "not-contains" | "json-valid" | "line-count";
  pattern: string;
  expected: boolean;
}>;

export type ContaminationRisk = "known-clean" | "unknown" | "known-contaminated";

export type EvalProject = Readonly<{
  projectId: string;
  displayName: string;
  canonicalRepositoryUrl: string;
  ownerAtCollection: string;
  licenseDeclared: string;
  licenseConcluded: string;
  licenseBasis: "OSI-approved" | "explicit-written-permission" | "OSI-approved-and-explicit-permission";
  primaryLanguageFamily: string;
  organizationGroup: string;
  contentHash: string;
  failureProne?: boolean;
}>;

export type PhaseConfig = Readonly<{
  "P0-shakedown": number;
  "P1-baseline": number;
  "P2-development": number;
  "P3-holdout": number;
}>;

export const CHEP_CANONICAL_PHASE_CONFIG: PhaseConfig = CHEP_CANONICAL_PHASE_COUNTS;

export type MatrixGeneratorConfig = Readonly<{
  phaseCounts: PhaseConfig;
  seedScenarios: readonly ScenarioSeed[];
  projects: readonly EvalProject[];
  createdAt: string;
  maxOutputTokens: number;
  models: readonly ChepModelId[];
  runtimeTarget?: string;
}>;

export type SnapshotRecord = Readonly<{
  git_commit: string;
  git_tree_sha256: string;
  source_archive: ChepArtifact;
  task_image_digest: string;
  verifier_image_digest: string;
  platform_os: "linux" | "windows";
  platform_arch: "amd64" | "arm64";
  dependency_lock_artifacts: readonly ChepArtifact[];
  sbom: ChepArtifact;
  network_default: "deny";
}>;

export type TaskRecord = Readonly<{
  source_stream: "fresh-public" | "embargoed-maintainer" | "commissioned-real-project" | "established-public-diagnostic";
  source_created_at: string;
  task_text_source: ChepArtifact;
  oracle_solution: ChepArtifact;
  oracle_author_independent: true;
  real_project_work: true;
  post_resolution_leakage_removed: true;
}>;

export type TaxonomyRecord = Readonly<{
  primary_task_family: TaskFamily;
  secondary_task_families: readonly string[];
  language_family: string;
  ecosystem: string;
  repository_size_loc: number;
  repository_file_count: number;
  estimated_components_touched: number;
  multi_service: boolean;
  polyglot: boolean;
}>;

export type HumanBaseline = Readonly<{
  baseliner_id: string;
  qualified: true;
  completed: boolean;
  duration_seconds: number | null;
  evidence_artifact: ChepArtifact;
}>;

export type DifficultyRecord = Readonly<{
  band: DifficultyBand;
  method: "geometric-mean-of-at-least-two-successes" | "expert-estimate-fewer-than-two-successes";
  geometric_mean_success_seconds: number | null;
  expert_estimate_seconds?: number;
  human_baselines: readonly HumanBaseline[];
}>;

export type ControlCheck = Readonly<{
  control_id: string;
  kind: "base-fail-to-pass" | "base-pass-to-pass" | "oracle-all-pass" | "integrity-anti-gaming" | "resource-margin" | "determinism";
  command_artifact: ChepArtifact;
  expected_outcome: "pass" | "fail";
  clean_repetitions: number;
  unexplained_variance_allowed: false;
}>;

export type VerifierRecord = Readonly<{
  verifier_artifact: ChepArtifact;
  hidden_tests_artifact: ChepArtifact;
  scorer_artifact: ChepArtifact;
  functional_execution: true;
  keyword_matching_primary: false;
  separate_inaccessible_verifier: true;
  network_required: false;
  controls: readonly ControlCheck[];
  alternate_solutions_reviewed: true;
  mutation_and_anti_gaming_checks: true;
}>;

export type ReviewLabel = Readonly<{
  reviewer_id: string;
  prompt_sufficiency_severity: number;
  oracle_fairness_severity: number;
  environment_severity: number;
  license_severity: number;
  approved: boolean;
  review_artifact: ChepArtifact;
}>;

export type HoldoutRecord = Readonly<{
  is_holdout: boolean;
  access_class: "development" | "sealed-holdout" | "retired-shakedown";
  tuning_access_prohibited: boolean;
  near_duplicate_check_artifact: ChepArtifact;
  retire_after_unseal: true;
}>;

export type ScenarioRecord = Readonly<{
  scenario_id: string;
  phase: ChepPhaseName;
  scored: boolean;
  project_id: string;
  snapshot: SnapshotRecord;
  task: TaskRecord;
  taxonomy: TaxonomyRecord;
  difficulty: DifficultyRecord;
  verifier: VerifierRecord;
  reviews: readonly [ReviewLabel, ReviewLabel, ReviewLabel];
  holdout: HoldoutRecord;
  eligible_prompt_kinds: readonly PromptKind[];
  hidden_oracles: readonly HiddenOracle[];
  contamination_risk: ContaminationRisk;
  content_hash: string;
}>;

export type PromptVariantRecord = Readonly<{
  prompt_variant_id: string;
  scenario_id: string;
  kind: PromptKind;
  content_artifact: ChepArtifact;
  provenance_diff_artifact: ChepArtifact;
  semantic_equivalence_reviews: readonly [ReviewLabel, ReviewLabel, ReviewLabel];
  model_under_test_used_in_creation: false;
  adaptive_dialogue: false;
  content_hash: string;
}>;

export type TestRecord = Readonly<{
  test_id: string;
  scenario_id: string;
  phase: ChepPhaseName;
  prompt_variant_id: string;
  condition_id: string;
  budget_policy_id: string;
  fault_profile_id: string;
  allocation_stratum_id: string;
  topology_panel: boolean;
  prompt_panel: boolean;
  fault_panel: boolean;
  temperature: 0;
  content_hash: string;
}>;

export type RunRecord = Readonly<{
  run_id: string;
  replicate: 1 | 2 | 3;
  runtime_block_id: string;
  schedule_key: string;
  fresh_execution: Readonly<{
    fresh_request: true;
    fresh_model_conversation: true;
    fresh_task_environment: true;
    fresh_harness_memory: true;
    fresh_agent_state: true;
    response_cache_disabled: true;
    no_output_reuse: true;
    clean_state_verified: true;
  }>;
  retained_result_slot: true;
  status: "planned" | "scheduled" | "executing" | "complete";
}>;

export type CellRecord = Readonly<{
  cell_id: string;
  test_id: string;
  model_id: ChepModelId;
  temperature: 0;
  api_seed_support: "supported-cell-fixed" | "unsupported-omitted";
  api_seed?: number;
  runs: readonly [RunRecord, RunRecord, RunRecord];
  content_hash: string;
}>;

export type SemanticInvariants = Readonly<{
  exact_models_only: true;
  numeric_temperature_zero_everywhere: true;
  exactly_three_runs_per_model_test_cell: true;
  complete_two_model_cross_for_every_test: true;
  unique_ids_and_referential_integrity: true;
  all_content_ids_recompute: true;
  phase_counts_match: true;
  unique_scored_scenario_count: number;
  no_holdout_identity_in_earlier_phases: true;
  holdout_near_duplicate_firewall_passed: true;
  no_model_specific_harness_branching: true;
  no_adaptive_treatment_assignment: true;
  allocation_matches_normative_generator: true;
  topology_role_count_matches_agent_count: true;
  project_and_organization_caps_passed: true;
  at_least_eight_language_families: true;
  prompt_references_match_scenarios: true;
  condition_budget_fault_references_resolve: true;
  run_ids_and_schedule_keys_recompute: true;
  same_cell_api_seed_across_three_runs: true;
  no_selective_retained_fourth_run: true;
  trace_completeness_for_complete_runs: true;
  validator_report: ChepArtifact;
}>;

export type PreregistrationRecord = Readonly<{
  uri: string;
  sha256: string;
  registered_at: string;
  amendments: readonly never[];
}>;

export type GeneratorRecord = Readonly<{
  generator_version: typeof CHEP_GENERATOR_VERSION;
  algorithm: "CHEP-1.0 section 19 normative deterministic allocation";
  master_seed_hex: typeof CHEP_MASTER_SEED_HEX;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "SHA-256";
  unicode_normalization: "NFC";
  line_endings: "LF";
  implementation_artifact: ChepArtifact;
  semantic_validator_artifact: ChepArtifact;
}>;

export type EndpointProfile = Readonly<{
  provider_neutral_core: true;
  adapter_protocol: "openai-compatible-v1";
  base_url_binding: "late-bound";
  runtime_target: string;
  credentials_in_matrix: false;
  authorization_log_policy: "omit-and-record-typed-redaction";
  exact_model_string_required: true;
  model_fallback_allowed: false;
  capability_probe_required: true;
  capture_returned_model: true;
  capture_backend_fingerprint: true;
}>;

export type SamplingRecord = Readonly<{
  temperature: 0;
  seed_policy: "one-cell-seed-shared-by-three-runs-if-supported";
  top_p_policy: "exactly-1-if-supported" | "omit-for-all-arms";
  adaptive_reasoning_policy: "disabled-or-omitted-uniformly";
  max_output_tokens: number;
  request_cache: false;
}>;

export type PhaseRecord = Readonly<{
  phase: ChepPhaseName;
  unique_scenario_count: number;
  counted_toward_target: boolean;
  outcome_use: "retired-infrastructure-only" | "baseline-characterization" | "development-tuning" | "sealed-confirmatory";
  holdout: boolean;
  tuning_allowed: boolean;
}>;

export type ProjectRecord = Readonly<{
  project_id: string;
  display_name: string;
  canonical_repository_url: string;
  owner_at_collection: string;
  license: Readonly<{
    declared_spdx_expression: string;
    concluded_spdx_expression: string;
    license_artifacts: readonly ChepArtifact[];
    basis: "OSI-approved" | "explicit-written-permission" | "OSI-approved-and-explicit-permission";
    redistribution_reviewed: true;
  }>;
  primary_language_family: string;
  organization_group: string;
  contamination_risk: ContaminationRisk;
  failure_prone: boolean;
  content_hash: string;
}>;

export type MatrixDocument = Readonly<{
  schema_version: typeof CHEP_SCHEMA_VERSION;
  protocol_id: typeof CHEP_PROTOCOL_ID;
  matrix_id: string;
  created_at: string;
  matrix_state: "preregistered" | "frozen" | "executing" | "complete";
  preregistration: PreregistrationRecord;
  generator: GeneratorRecord;
  endpoint_profile: EndpointProfile;
  models: readonly ChepModelId[];
  sampling: SamplingRecord;
  repetitions_per_model_test_cell: 3;
  target_unique_scored_scenarios: 1024;
  phases: readonly [PhaseRecord, PhaseRecord, PhaseRecord, PhaseRecord];
  projects: readonly ProjectRecord[];
  scenarios: readonly ScenarioRecord[];
  prompt_variants: readonly PromptVariantRecord[];
  budget_policies: readonly BudgetPolicyRecord[];
  fault_profiles: readonly FaultProfileRecord[];
  conditions: readonly ConditionRecord[];
  tests: readonly TestRecord[];
  cells: readonly CellRecord[];
  semantic_invariants: SemanticInvariants;
  matrix_payload_sha256: string;
}>;

export type CellExecutionRequest = Readonly<{
  matrix: MatrixDocument;
  cellId: string;
  scenarioPrompt: string;
  providerConfig: Readonly<{
    id: string;
    baseUrl: string;
    apiKeyEnvVar: string;
    timeoutMs: number;
    retries: Readonly<{
      maxRetries: number;
      initialBackoffMs: number;
      maxBackoffMs: number;
      backoffMultiplier: number;
      retryableStatusCodes?: readonly number[];
    }>;
    chatCompletionsPath?: string;
    /** The configured `runtime.responses` transport section, when the document declares one. */
    responses?: import("../shared/llm/config.ts").ResponsesTransportConfigInput | undefined;
  }>;
  apiKey: string;
  signal?: AbortSignal;
  runReferenceTransport?: boolean;
  maxTokens?: number;
}>;

export type CapabilityProbe = Readonly<{
  content: string;
  usage: Readonly<{ promptTokens: number; completionTokens: number; totalTokens: number }> | undefined;
  headers: Readonly<Record<string, string>>;
  finishReason: string;
  model?: string;
}>;

export type CellTopologyMeta = Readonly<{
  agentCount: number;
  communicationGraph: string;
  workspaceMode: string;
  roles: readonly Readonly<{ roleId: string; specialty: string }>[];
}>;

export type CellRunResult = Readonly<{
  runId: string;
  replicate: number;
  content: string;
  usage: Readonly<{ promptTokens: number; completionTokens: number; totalTokens: number }> | undefined;
  finishReason: string;
  durationMs: number;
  temperature: 0;
  error: string | null;
  modelRevision: Readonly<{
    requestedModelId: string;
    returnedModelId: string | null;
    mappingStatus: "exact" | "exact-body" | "preregistered-provider-alias" | "mismatch-blocked" | "not-returned";
    providerRequestId: string | null;
    providerDate: string | null;
  }>;
  isReference: boolean;
  oracleResults: readonly OracleCheckResult[];
  capabilityProbe?: CapabilityProbe;
  topology?: CellTopologyMeta;
}>;

export type OracleCheckResult = Readonly<{
  name: string;
  passed: boolean;
  expected: boolean;
  actual: boolean;
}>;

export type CellResult = Readonly<{
  cellId: string;
  modelId: ChepModelId;
  runs: readonly CellRunResult[];
  allOraclesPassed: boolean;
  identityAttested: boolean;
  error: string | null;
}>;

export type RateLimitProfile = Readonly<{
  limitRequests: number | null;
  remainingRequests: number | null;
  limitTokens: number | null;
  remainingTokens: number | null;
}>;

export type BudgetEstimate = Readonly<{
  totalCells: number;
  totalRuns: number;
  totalTests: number;
  totalScenarios: number;
  scoredScenarios: number;
  estimatedTokensPerCall: Readonly<{ min: number; expected: number; max: number }>;
  estimatedWallTimeSeconds: Readonly<{ min: number; expected: number; max: number }>;
  totalTokensExpected: number;
  totalTokensWorst: number;
  totalWallTimeSecondsExpected: number;
  totalWallTimeSecondsWorst: number;
  estimatedStorageBytes: number;
  estimatedTimelineRecords: number;
  maxConcurrency: number;
  models: readonly ChepModelId[];
  conditions: number;
  repetitions: number;
  estimatedCostUsd: number;
  estimatedIndexingBytes: number;
  rateLimitProfile: RateLimitProfile | null;
  estimatedHumanReviewLoad: number;
}>;

export type SemanticValidatorFinding = Readonly<{
  invariant: string;
  passed: boolean;
  detail: string;
}>;

export type SemanticValidatorReport = Readonly<{
  findings: readonly SemanticValidatorFinding[];
  allPassed: boolean;
  timestamp: string;
}>;
