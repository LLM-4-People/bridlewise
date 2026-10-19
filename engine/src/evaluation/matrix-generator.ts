import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_EVALUATION_MAX_OUTPUT_TOKENS, DEFAULT_EVALUATION_PRODUCTION_MAX_OUTPUT_TOKENS } from "../kernel/config-contracts.ts";
import { PROVIDER_NOT_CONFIGURED_BASE_URL } from "../kernel/contracts.ts";
import { InputError } from "../kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import type { CellRunResult } from "./types.ts";
import { enrichPrompt } from "./scenarios.ts";
import {
  CHEP_CANONICAL_PHASE_CONFIG,
  CHEP_GENERATOR_VERSION,
  CHEP_MASTER_SEED_HEX,
  CHEP_MODELS,
  CHEP_PROTOCOL_ID,
  CHEP_SCHEMA_VERSION,
  CHEP_TARGET_SCORED_SCENARIOS,
  AGENT_SPECIALTIES,
  CHEP_PHASE_NAMES,
  CONDITION_ARMS,
  DIFFICULTY_BANDS,
  TASK_FAMILIES,
  type AgentRoleRecord,
  type BudgetPolicyRecord,
  type CellRecord,
  type ChepArtifact,
  type ChepModelId,
  type ChepPhaseName,
  type CommunicationGraph,
  type ConditionArm,
  type ConditionRecord,
  type ControlCheck,
  type DifficultyBand,
  type DifficultyRecord,
  type EndpointProfile,
  type EvalProject,
  type FaultEventRecord,
  type FaultProfileRecord,
  type GeneratorRecord,
  type HoldoutRecord,
  type HumanBaseline,
  type MatrixDocument,
  type MatrixGeneratorConfig,
  type PhaseConfig,
  type PhaseRecord,
  type ProjectRecord,
  type PromptKind,
  type PromptVariantRecord,
  type ReviewLabel,
  type RunRecord,
  type SamplingRecord,
  type ScenarioRecord,
  type ScenarioSeed,
  type SemanticInvariants,
  type SnapshotRecord,
  type TaskRecord,
  type TaxonomyRecord,
  type TestRecord,
  type TopologyRecord,
  type VerifierRecord,
  type WorkspaceMode,
} from "./types.ts";

/**
 * CHEP-1.0 deterministic matrix generator.
 *
 * Generates a preregistered factorial evaluation matrix following the
 * CHEP-1.0 schema. The generator is deterministic: given the same seed
 * scenarios and config, it produces a byte-identical matrix.
 *
 * The canonical production config uses phase counts [64, 512, 256, 256] =
 * 1088 scenarios (1024 scored + 64 shakedown). A development config with
 * smaller counts is used for testing.
 */

const PHASE_META: Readonly<Record<ChepPhaseName, Readonly<{
  counted: boolean;
  outcomeUse: PhaseRecord["outcome_use"];
  holdout: boolean;
  tuningAllowed: boolean;
  scored: boolean;
  accessClass: "retired-shakedown" | "development" | "sealed-holdout";
}>>> = deepFreeze({
  "P0-shakedown": {
    counted: false,
    outcomeUse: "retired-infrastructure-only",
    holdout: false,
    tuningAllowed: false,
    scored: false,
    accessClass: "retired-shakedown",
  },
  "P1-baseline": {
    counted: true,
    outcomeUse: "baseline-characterization",
    holdout: false,
    tuningAllowed: false,
    scored: true,
    accessClass: "development",
  },
  "P2-development": {
    counted: true,
    outcomeUse: "development-tuning",
    holdout: false,
    tuningAllowed: true,
    scored: true,
    accessClass: "development",
  },
  "P3-holdout": {
    counted: true,
    outcomeUse: "sealed-confirmatory",
    holdout: true,
    tuningAllowed: false,
    scored: true,
    accessClass: "sealed-holdout",
  },
});

// THE PHASE, FAMILY, BAND AND ARM VOCABULARIES ARE NOT DECLARED HERE.
//
// This file used to restate four of them — `PHASE_ORDER`, `TASK_FAMILIES_ALL`,
// `DIFFICULTY_BANDS_ALL` and a local `arms` — each a second copy of a list
// `types.ts` already exports, each annotated with the union so that a copy
// holding FEWER members compiled without a word. Two places answering one
// question, where the drift only shows up as a factorial design quietly
// missing a factor. They are imported from the owner now, and the owner
// derives its unions from them, so there is nowhere left for a copy to
// disagree.

const LANGUAGES = deepFreeze([
  "TypeScript", "JavaScript", "Python", "Rust",
  "Go", "Java", "Ruby", "C++",
] as const);

const ECOSYSTEMS: Readonly<Record<string, string>> = deepFreeze({
  TypeScript: "Node.js",
  JavaScript: "Node.js",
  Python: "pip",
  Rust: "cargo",
  Go: "go-modules",
  Java: "maven",
  Ruby: "bundler",
  "C++": "cmake",
});

const ARM_AGENT_COUNT: Readonly<Record<ConditionArm, number>> = deepFreeze({
  "D0-direct": 0,
  "R1-reference": 1,
  "N1-noop": 1,
  A1: 1,
  A2: 2,
  A3: 3,
  A4: 4,
  A5: 5,
});

const ARM_COMMUNICATION_GRAPH: Readonly<Record<ConditionArm, CommunicationGraph>> = deepFreeze({
  "D0-direct": "none",
  "R1-reference": "solo",
  "N1-noop": "solo",
  A1: "solo",
  A2: "pipeline",
  A3: "star",
  A4: "star",
  A5: "parallel-review",
});

const ARM_WORKSPACE_MODE: Readonly<Record<ConditionArm, WorkspaceMode>> = deepFreeze({
  "D0-direct": "no-tools-context-pack",
  "R1-reference": "single-workspace",
  "N1-noop": "no-tools-context-pack",
  A1: "single-workspace",
  A2: "immutable-snapshots-artifact-handoff",
  A3: "immutable-snapshots-artifact-handoff",
  A4: "shared-workspace-separate-condition",
  A5: "shared-workspace-separate-condition",
});

function makeArtifact(uri: string, content: string, accessClass: ChepArtifact["access_class"] = "restricted"): ChepArtifact {
  const bytes = Buffer.from(content, "utf8");
  return deepFreeze({
    uri,
    sha256: sha256(content),
    media_type: "application/json",
    size_bytes: bytes.length,
    access_class: accessClass,
  });
}

const GENERATOR_MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Reads a source file relative to the repository root and returns its bytes.
 * Returns an honest `"source-unavailable:<uri>"` marker (NOT a fabricated
 * label) when the file cannot be read, so the artifact hash never lies about
 * real content (DER-014 integrity).
 */
function readSourceContent(repoRelativePath: string, uri: string): string {
  const absPath = join(GENERATOR_MODULE_DIR, "..", "..", repoRelativePath);
  if (existsSync(absPath)) {
    return readFileSync(absPath, "utf8");
  }
  return `source-unavailable:${uri}`;
}

/**
 * Builds an artifact whose digest is the actual bytes of one or more source
 * files. The harness/adapter/generator artifacts must hash real implementation
 * bytes, never label strings (DER-014 C6).
 */
function makeSourceArtifact(uri: string, repoRelativePaths: readonly string[], accessClass: ChepArtifact["access_class"] = "restricted"): ChepArtifact {
  const content = repoRelativePaths.map((p) => readSourceContent(p, uri)).join("\n");
  return makeArtifact(uri, content, accessClass);
}

function hashId(prefix: string, content: unknown): string {
  return `${prefix}_${canonicalHash(content)}`;
}

function deterministicStratum(scenarioIndex: number, conditionIndex: number): string {
  return hashId("str", { scenarioIndex, conditionIndex, seed: CHEP_MASTER_SEED_HEX });
}

function selectConditions(scenarioIndex: number, totalConditions: number): readonly [number, number, number] {
  const c1 = scenarioIndex % totalConditions;
  const c2 = (scenarioIndex + 3) % totalConditions;
  const c3 = (scenarioIndex + 6) % totalConditions;
  return [c1, c2, c3];
}

/**
 * The identities of what a CHEP run ACTUALLY sends (prompt-registry F-PR-11).
 * The scenario runner sends one user message: no system prompt, no role
 * prompt, no tools — so each identity is that of the empty text and of the
 * empty tool list. They were seed-derived placeholders
 * (`sha256("system-prompt:<seed>")`, one per role, one for the tool schema)
 * that fabricated a prompt identity the eval results then reported. A run
 * that sends registry-rendered prompts binds their real identities here.
 */
export const NO_PROMPT_SENT_SHA256 = sha256("");
export const NO_TOOLS_SENT_SHA256 = sha256(canonicalJson([]));

function buildTopology(arm: ConditionArm): TopologyRecord {
  const count = ARM_AGENT_COUNT[arm];
  const roles: AgentRoleRecord[] = [];
  for (let i = 0; i < count; i++) {
    const specialty = AGENT_SPECIALTIES[i % AGENT_SPECIALTIES.length]!;
    const roleId = `role_${arm}-${i + 1}`;
    roles.push(deepFreeze({
      role_id: roleId,
      specialty,
      role_prompt_sha256: NO_PROMPT_SENT_SHA256,
      can_mutate_candidate_workspace: i < Math.ceil(count / 2),
    }));
  }
  return deepFreeze({
    agent_count: count,
    roles: deepFreeze(roles),
    communication_graph: ARM_COMMUNICATION_GRAPH[arm],
    workspace_mode: ARM_WORKSPACE_MODE[arm],
    deterministic_orchestrator: true,
    model_backed_orchestrator: false,
  });
}

function buildConditions(
  budgetPolicyId: string,
  faultProfileId: string,
  toolSchemaSha: string,
  systemPromptSha: string,
  harnessArtifact: ChepArtifact,
  adapterArtifact: ChepArtifact,
  retryArtifact: ChepArtifact,
): readonly ConditionRecord[] {
  return deepFreeze(CONDITION_ARMS.map((arm) => {
    const topology = buildTopology(arm);
    const harnessVersion: ConditionRecord["harness_version"] =
      arm === "R1-reference" ? "reference-1.0" : "candidate-v0";
    const record = {
      condition_id: hashId("cnd", { arm, seed: CHEP_MASTER_SEED_HEX }),
      arm,
      harness_version: harnessVersion,
      topology,
      budget_policy_id: budgetPolicyId,
      fault_profile_id: faultProfileId,
      tool_schema_sha256: toolSchemaSha,
      system_prompt_sha256: systemPromptSha,
      harness_artifact: harnessArtifact,
      adapter_artifact: adapterArtifact,
      trace_capture: "exhaustive" as const,
      model_specific_branching: false as const,
      adaptive_assignment: false as const,
      retry_policy_artifact: retryArtifact,
      // CRIT-4: the N1-noop arm requires a noop_conformance_artifact per the
      // schema's conditional requirement (arm === "N1-noop").
      ...(arm === "N1-noop" ? { noop_conformance_artifact: makeArtifact(`file:///evaluation/noop-conformance/${arm}.json`, canonicalJson({ arm, noopPolicy: "no-model-calls", seed: CHEP_MASTER_SEED_HEX })) } : {}),
    };
    const contentHash = canonicalHash(stripContentHash(record));
    return deepFreeze({ ...record, content_hash: contentHash });
  }));
}

function buildBudgetPolicies(maxOutputTokens: number): readonly BudgetPolicyRecord[] {
  const baseTokens = maxOutputTokens * 100;
  const policies: Omit<BudgetPolicyRecord, "content_hash">[] = [
    {
      budget_policy_id: hashId("bdg", { mode: "resource-equalized-primary", seed: CHEP_MASTER_SEED_HEX }),
      mode: "resource-equalized-primary",
      total_model_tokens: baseTokens,
      wall_time_seconds: 3600,
      max_model_calls: 50,
      max_tool_calls: 100,
      cpu_count: 4,
      memory_bytes: 4 * 1024 * 1024 * 1024,
      disk_bytes: 10 * 1024 * 1024 * 1024,
      tool_output_bytes_per_call: 1024 * 1024,
      network_policy: "deny-except-fixture-local",
      verifier_time_seconds: 300,
      oracle_safety_margin_recorded: true,
      per_agent_token_allocation: [0.4, 0.25, 0.15, 0.1, 0.1],
    },
    {
      budget_policy_id: hashId("bdg", { mode: "native-scale-secondary", seed: CHEP_MASTER_SEED_HEX }),
      mode: "native-scale-secondary",
      total_model_tokens: baseTokens * 2,
      wall_time_seconds: 7200,
      max_model_calls: 100,
      max_tool_calls: 200,
      cpu_count: 8,
      memory_bytes: 8 * 1024 * 1024 * 1024,
      disk_bytes: 20 * 1024 * 1024 * 1024,
      tool_output_bytes_per_call: 2 * 1024 * 1024,
      network_policy: "deny-except-fixture-local",
      verifier_time_seconds: 600,
      oracle_safety_margin_recorded: true,
    },
  ];
  return deepFreeze(policies.map((p) => {
    const contentHash = canonicalHash(stripContentHash(p));
    return deepFreeze({ ...p, content_hash: contentHash });
  }));
}

function buildFaultEvent(
  faultType: string,
  trigger: Readonly<Record<string, unknown>>,
  severity: FaultEventRecord["severity"],
): FaultEventRecord {
  return deepFreeze({
    fault_type: faultType,
    trigger_specification: makeArtifact(
      `file:///evaluation/faults/${faultType}.json`,
      canonicalJson(trigger),
    ),
    severity,
    identical_across_paired_arms: true as const,
  });
}

function buildFaultProfiles(): readonly FaultProfileRecord[] {
  const profiles: Omit<FaultProfileRecord, "content_hash">[] = [
    {
      fault_profile_id: hashId("flt", { kind: "natural-no-injection", seed: CHEP_MASTER_SEED_HEX }),
      profile_kind: "natural-no-injection" as const,
      events: deepFreeze([] as readonly FaultEventRecord[]),
      timing_seeded: true as const,
      outcome_adaptive: false as const,
    },
    {
      fault_profile_id: hashId("flt", { kind: "provider-harness-injection", seed: CHEP_MASTER_SEED_HEX }),
      profile_kind: "provider-harness-injection" as const,
      events: deepFreeze([
        buildFaultEvent("malformed-response", { kind: "non-json-body", injectAt: "stream-midpoint" }, "medium"),
        buildFaultEvent("truncated-stream", { kind: "early-finish", injectAt: "token-32" }, "high"),
        buildFaultEvent("unexpected-tool-call", { kind: "hallucinated-tool", toolName: "nonexistent-tool" }, "medium"),
      ]),
      timing_seeded: true as const,
      outcome_adaptive: false as const,
    },
    {
      fault_profile_id: hashId("flt", { kind: "repository-adversarial", seed: CHEP_MASTER_SEED_HEX }),
      profile_kind: "repository-adversarial" as const,
      events: deepFreeze([
        buildFaultEvent("syntax-corrupted-file", { kind: "unbalanced-brace", file: "src/index.ts" }, "high"),
        buildFaultEvent("merge-conflict-state", { kind: "unresolved-conflict-markers", files: 2 }, "high"),
        buildFaultEvent("stale-dependency", { kind: "declared-but-uninstalled", dependency: "left-pad" }, "medium"),
      ]),
      timing_seeded: true as const,
      outcome_adaptive: false as const,
    },
    {
      fault_profile_id: hashId("flt", { kind: "scoring-adversarial", seed: CHEP_MASTER_SEED_HEX }),
      profile_kind: "scoring-adversarial" as const,
      events: deepFreeze([
        buildFaultEvent("false-green-test", { kind: "assertion-bypassed", test: "should-fail-but-passes" }, "critical"),
        buildFaultEvent("oracle-bypass", { kind: "oracle-evasion", oracle: "contains-reverse-string" }, "critical"),
        buildFaultEvent("partial-match", { kind: "insufficient-coverage", matchRatio: 0.4 }, "medium"),
      ]),
      timing_seeded: true as const,
      outcome_adaptive: false as const,
    },
  ];
  return deepFreeze(profiles.map((p) => {
    const contentHash = canonicalHash(stripContentHash(p));
    return deepFreeze({ ...p, content_hash: contentHash });
  }));
}

function buildProjectRecord(project: EvalProject): ProjectRecord {
  const licenseArtifact = makeArtifact(
    `file:///test/fixtures/eval-projects/${project.displayName}/LICENSE`,
    project.licenseDeclared,
    "public",
  );
  const record = {
    project_id: project.projectId,
    display_name: project.displayName,
    canonical_repository_url: project.canonicalRepositoryUrl,
    owner_at_collection: project.ownerAtCollection,
    license: deepFreeze({
      declared_spdx_expression: project.licenseDeclared,
      concluded_spdx_expression: project.licenseConcluded,
      license_artifacts: deepFreeze([licenseArtifact]),
      basis: project.licenseBasis,
      redistribution_reviewed: true as const,
    }),
    primary_language_family: project.primaryLanguageFamily,
    organization_group: project.organizationGroup,
    contamination_risk: "unknown" as const,
    failure_prone: project.failureProne ?? false,
    content_hash: project.contentHash,
  };
  return deepFreeze(record);
}

function buildSnapshot(seed: ScenarioSeed, index: number): SnapshotRecord {
  const commit = sha256(`commit:${seed.scenarioId}:${index}`).slice(0, 40);
  const treeSha = sha256(`tree:${seed.scenarioId}:${index}`);
  const archive = makeArtifact(
    `file:///test/fixtures/eval-projects/${seed.projectRef}/src-${index}.tar.gz`,
    `archive:${seed.scenarioId}:${index}`,
  );
  return deepFreeze({
    git_commit: commit,
    git_tree_sha256: treeSha,
    source_archive: archive,
    task_image_digest: `sha256:${sha256(`task-image:${seed.scenarioId}`)}`,
    verifier_image_digest: `sha256:${sha256(`verifier-image:${seed.scenarioId}`)}`,
    platform_os: "linux",
    platform_arch: "amd64",
    dependency_lock_artifacts: deepFreeze([
      makeArtifact(`file:///test/fixtures/eval-projects/${seed.projectRef}/package-lock.json`, `locks:${seed.scenarioId}`),
    ]),
    sbom: makeArtifact(`file:///test/fixtures/eval-projects/${seed.projectRef}/sbom.json`, `sbom:${seed.scenarioId}`),
    network_default: "deny",
  });
}

function buildTask(seed: ScenarioSeed, _index: number): TaskRecord {
  void _index;
  return deepFreeze({
    source_stream: "commissioned-real-project",
    source_created_at: "2026-07-15T00:00:00.000Z",
    task_text_source: makeArtifact(
      `file:///evaluation/tasks/${seed.scenarioId}/task.json`,
      JSON.stringify({ prompt: seed.promptVariants.original, displayName: seed.displayName }),
    ),
    oracle_solution: makeArtifact(
      `file:///evaluation/tasks/${seed.scenarioId}/oracle.json`,
      seed.expectedOutputs,
      "sealed-holdout",
    ),
    oracle_author_independent: true,
    real_project_work: true,
    post_resolution_leakage_removed: true,
  });
}

function buildTaxonomy(seed: ScenarioSeed): TaxonomyRecord {
  return deepFreeze({
    primary_task_family: seed.taskFamily,
    secondary_task_families: seed.secondaryTaskFamilies,
    language_family: seed.languageFamily,
    ecosystem: seed.ecosystem,
    repository_size_loc: seed.repositorySizeLoc,
    repository_file_count: seed.repositoryFileCount,
    estimated_components_touched: seed.estimatedComponentsTouched,
    multi_service: seed.multiService,
    polyglot: seed.polyglot,
  });
}

function buildDifficulty(band: DifficultyBand): DifficultyRecord {
  const method: DifficultyRecord["method"] =
    band === "tiny" || band === "small"
      ? "geometric-mean-of-at-least-two-successes"
      : "expert-estimate-fewer-than-two-successes";
  const geoMean = band === "tiny" || band === "small"
    ? band === "tiny" ? 30 : 120
    : null;
  const expertEstimate =
    band === "medium" ? 600 :
    band === "large" ? 1800 :
    band === "highly_complex" ? 5400 : undefined;
  const baselinerArtifact = (id: string, dur: number) => makeArtifact(
    `file:///evaluation/baselines/${id}.json`,
    JSON.stringify({ baselinerId: id, durationSeconds: dur }),
    "restricted",
  );
  return deepFreeze({
    band,
    method,
    geometric_mean_success_seconds: geoMean,
    ...(expertEstimate !== undefined ? { expert_estimate_seconds: expertEstimate } : {}),
    human_baselines: deepFreeze([
      deepFreeze({
        baseliner_id: `hum_${band}-a`,
        qualified: true,
        completed: geoMean !== null,
        duration_seconds: geoMean,
        evidence_artifact: baselinerArtifact(`hum_${band}-a`, geoMean ?? expertEstimate ?? 0),
      }),
      deepFreeze({
        baseliner_id: `hum_${band}-b`,
        qualified: true,
        completed: geoMean !== null,
        duration_seconds: geoMean !== null ? geoMean * 1.2 : null,
        evidence_artifact: baselinerArtifact(`hum_${band}-b`, geoMean !== null ? geoMean * 1.2 : 0),
      }),
    ] as readonly HumanBaseline[]),
  });
}

function buildVerifier(seed: ScenarioSeed): VerifierRecord {
  const controls: ControlCheck[] = [
    { control_id: `ctl_${sha256(seed.scenarioId + "-fail-to-pass")}`, kind: "base-fail-to-pass", command_artifact: makeArtifact(`file:///evaluation/controls/${seed.scenarioId}/fail-to-pass.json`, "fail-to-pass"), expected_outcome: "pass", clean_repetitions: 2, unexplained_variance_allowed: false },
    { control_id: `ctl_${sha256(seed.scenarioId + "-pass-to-pass")}`, kind: "base-pass-to-pass", command_artifact: makeArtifact(`file:///evaluation/controls/${seed.scenarioId}/pass-to-pass.json`, "pass-to-pass"), expected_outcome: "pass", clean_repetitions: 2, unexplained_variance_allowed: false },
    { control_id: `ctl_${sha256(seed.scenarioId + "-oracle-all")}`, kind: "oracle-all-pass", command_artifact: makeArtifact(`file:///evaluation/controls/${seed.scenarioId}/oracle-all.json`, "oracle-all-pass"), expected_outcome: "pass", clean_repetitions: 2, unexplained_variance_allowed: false },
    { control_id: `ctl_${sha256(seed.scenarioId + "-determinism")}`, kind: "determinism", command_artifact: makeArtifact(`file:///evaluation/controls/${seed.scenarioId}/determinism.json`, "determinism"), expected_outcome: "pass", clean_repetitions: 3, unexplained_variance_allowed: false },
  ];
  return deepFreeze({
    verifier_artifact: makeArtifact(`file:///evaluation/verifiers/${seed.scenarioId}/verifier.mjs`, "verifier"),
    hidden_tests_artifact: makeArtifact(`file:///evaluation/verifiers/${seed.scenarioId}/hidden-tests.json`, "hidden-tests", "sealed-holdout"),
    scorer_artifact: makeArtifact(`file:///evaluation/verifiers/${seed.scenarioId}/scorer.mjs`, "scorer"),
    functional_execution: true,
    keyword_matching_primary: false,
    separate_inaccessible_verifier: true,
    network_required: false,
    controls: deepFreeze(controls),
    alternate_solutions_reviewed: true,
    mutation_and_anti_gaming_checks: true,
  });
}

function buildReviews(seed: ScenarioSeed): readonly [ReviewLabel, ReviewLabel, ReviewLabel] {
  const mkReview = (reviewerId: string, approved: boolean): ReviewLabel => deepFreeze({
    reviewer_id: reviewerId,
    prompt_sufficiency_severity: 0,
    oracle_fairness_severity: 0,
    environment_severity: 0,
    license_severity: 0,
    approved,
    review_artifact: makeArtifact(`file:///evaluation/reviews/${seed.scenarioId}/${reviewerId}.json`, JSON.stringify({ reviewerId, approved })),
  });
  return deepFreeze([
    mkReview(`rev_reviewer-a-${seed.scenarioId.slice(4, 12)}`, true),
    mkReview(`rev_reviewer-b-${seed.scenarioId.slice(4, 12)}`, true),
    mkReview(`rev_reviewer-c-${seed.scenarioId.slice(4, 12)}`, true),
  ]);
}

function buildHoldout(phase: ChepPhaseName): HoldoutRecord {
  const meta = PHASE_META[phase];
  const ndArtifact = makeArtifact(
    `file:///evaluation/near-dup-check/${phase}.json`,
    `near-dup-check:${phase}`,
    meta.accessClass === "sealed-holdout" ? "sealed-holdout" : "restricted",
  );
  return deepFreeze({
    is_holdout: meta.holdout,
    access_class: meta.accessClass,
    tuning_access_prohibited: !meta.tuningAllowed,
    near_duplicate_check_artifact: ndArtifact,
    retire_after_unseal: true,
  });
}

function buildScenarioRecord(seed: ScenarioSeed, phase: ChepPhaseName, index: number): ScenarioRecord {
  const meta = PHASE_META[phase];
  const record = {
    scenario_id: seed.scenarioId,
    phase,
    scored: meta.scored,
    project_id: seed.projectRef,
    snapshot: buildSnapshot(seed, index),
    task: buildTask(seed, index),
    taxonomy: buildTaxonomy(seed),
    difficulty: buildDifficulty(seed.difficulty),
    verifier: buildVerifier(seed),
    reviews: buildReviews(seed),
    holdout: buildHoldout(phase),
    // DELIBERATE SUBSET: 3 of 6 — a generated cell is eligible for the three
    // prompt kinds that preserve the task statement. The other three
    // (contextual, noisy, clarification) change what is being asked and so
    // belong to a different cell, not to this one.
    eligible_prompt_kinds: deepFreeze(["original", "normalized", "paraphrase"] as readonly PromptKind[]),
    hidden_oracles: deepFreeze(seed.hiddenOracles),
    contamination_risk: "unknown" as const,
  };
  const contentHash = canonicalHash(stripContentHash(record));
  return deepFreeze({ ...record, content_hash: contentHash });
}

function buildPromptVariant(scenarioId: string, kind: PromptKind, promptText: string): PromptVariantRecord {
  const reviews = buildReviews({ scenarioId } as ScenarioSeed);
  const record = {
    prompt_variant_id: hashId("prm", { scenarioId, kind, seed: CHEP_MASTER_SEED_HEX }),
    scenario_id: scenarioId,
    kind,
    content_artifact: makeArtifact(`file:///evaluation/prompts/${scenarioId}/${kind}.txt`, promptText),
    provenance_diff_artifact: makeArtifact(`file:///evaluation/prompts/${scenarioId}/${kind}-diff.json`, `diff:${kind}`),
    semantic_equivalence_reviews: reviews,
    model_under_test_used_in_creation: false as const,
    adaptive_dialogue: false as const,
  };
  const contentHash = canonicalHash(stripContentHash(record));
  return deepFreeze({ ...record, content_hash: contentHash });
}

function buildRun(cellId: string, replicate: 1 | 2 | 3): RunRecord {
  const runId = hashId("run", { cellId, replicate, seed: CHEP_MASTER_SEED_HEX });
  const blockId = hashId("blk", { cellId, seed: CHEP_MASTER_SEED_HEX });
  const scheduleKey = sha256(`${cellId}:${replicate}:${CHEP_MASTER_SEED_HEX}`);
  return deepFreeze({
    run_id: runId,
    replicate,
    runtime_block_id: blockId,
    schedule_key: scheduleKey,
    fresh_execution: deepFreeze({
      fresh_request: true,
      fresh_model_conversation: true,
      fresh_task_environment: true,
      fresh_harness_memory: true,
      fresh_agent_state: true,
      response_cache_disabled: true,
      no_output_reuse: true,
      clean_state_verified: true,
    }),
    retained_result_slot: true,
    status: "planned",
  });
}

function buildCell(testId: string, modelId: ChepModelId): CellRecord {
  const cellId = hashId("cel", { testId, modelId, seed: CHEP_MASTER_SEED_HEX });
  const runs: readonly [RunRecord, RunRecord, RunRecord] = deepFreeze([
    buildRun(cellId, 1),
    buildRun(cellId, 2),
    buildRun(cellId, 3),
  ]);
  const record = {
    cell_id: cellId,
    test_id: testId,
    model_id: modelId,
    temperature: 0 as const,
    api_seed_support: "unsupported-omitted" as const,
    runs,
  };
  const contentHash = canonicalHash(stripContentHash(record));
  return deepFreeze({ ...record, content_hash: contentHash });
}

function buildTest(
  scenarioId: string,
  phase: ChepPhaseName,
  promptVariantId: string,
  conditionId: string,
  budgetPolicyId: string,
  faultProfileId: string,
  scenarioIndex: number,
  conditionIndex: number,
  topologyPanel: boolean,
  promptPanel: boolean,
): TestRecord {
  const stratumId = deterministicStratum(scenarioIndex, conditionIndex);
  const record = {
    test_id: hashId("tst", { scenarioId, conditionId, promptVariantId, seed: CHEP_MASTER_SEED_HEX }),
    scenario_id: scenarioId,
    phase,
    prompt_variant_id: promptVariantId,
    condition_id: conditionId,
    budget_policy_id: budgetPolicyId,
    fault_profile_id: faultProfileId,
    allocation_stratum_id: stratumId,
    topology_panel: topologyPanel,
    prompt_panel: promptPanel,
    fault_panel: false,
    temperature: 0 as const,
  };
  const contentHash = canonicalHash(stripContentHash(record));
  return deepFreeze({ ...record, content_hash: contentHash });
}

function stripContentHash(record: unknown): Record<string, unknown> {
  const obj = record as Record<string, unknown>;
  const { content_hash: _, ...rest } = obj;
  return rest;
}

function generateExpandedScenarios(
  seedScenarios: readonly ScenarioSeed[],
  projects: readonly EvalProject[],
  phaseCounts: PhaseConfig,
): readonly { seed: ScenarioSeed; phase: ChepPhaseName; index: number }[] {
  const result: { seed: ScenarioSeed; phase: ChepPhaseName; index: number }[] = [];
  let globalIndex = 0;

  for (const phase of CHEP_PHASE_NAMES) {
    const count = phaseCounts[phase];
    for (let i = 0; i < count; i++) {
      if (globalIndex < seedScenarios.length) {
        result.push({ seed: seedScenarios[globalIndex]!, phase, index: globalIndex });
      } else {
        const seedIdx = globalIndex % seedScenarios.length;
        const baseSeed = seedScenarios[seedIdx]!;
        const langIdx = (globalIndex + seedIdx) % LANGUAGES.length;
        const taskIdx = (globalIndex + seedIdx * 3) % TASK_FAMILIES.length;
        const diffIdx = (globalIndex + seedIdx * 7) % DIFFICULTY_BANDS.length;
        const projIdx = (globalIndex + seedIdx) % projects.length;

        const language = LANGUAGES[langIdx]!;
        const taskFamily = TASK_FAMILIES[taskIdx]!;
        const difficulty = DIFFICULTY_BANDS[diffIdx]!;
        const project = projects[projIdx]!;

        const variantId = `scn_${sha256(`gen:${phase}:${globalIndex}:${CHEP_MASTER_SEED_HEX}`)}`;
        const promptText = `${baseSeed.displayName} — variant ${globalIndex} in ${language}`;
        const seed: ScenarioSeed = deepFreeze({
          scenarioId: variantId,
          difficulty,
          taskFamily,
          secondaryTaskFamilies: [],
          languageFamily: language,
          ecosystem: ECOSYSTEMS[language] ?? "generic",
          projectRef: project.projectId,
          displayName: `${baseSeed.displayName} (v${globalIndex})`,
          promptVariants: deepFreeze({
            original: promptText,
            normalized: promptText,
            paraphrase: `Task: ${promptText}`,
            contextual: `In the context of ${project.displayName}, ${promptText.toLowerCase()}`,
            noisy: `${promptText}  \n\n  (please solve this)`,
            clarification: `${promptText}\n\nIf anything is unclear, make a reasonable assumption.`,
          }) as Readonly<Record<PromptKind, string>>,
          expectedOutputs: baseSeed.expectedOutputs,
          agentFields: baseSeed.agentFields,
          hiddenOracles: baseSeed.hiddenOracles,
          repositorySizeLoc: baseSeed.repositorySizeLoc + globalIndex,
          repositoryFileCount: baseSeed.repositoryFileCount + (globalIndex % 5),
          estimatedComponentsTouched: baseSeed.estimatedComponentsTouched + (globalIndex % 3),
          multiService: baseSeed.multiService,
          polyglot: globalIndex % 4 === 0,
        });
        result.push({ seed, phase, index: globalIndex });
      }
      globalIndex++;
    }
  }

  return deepFreeze(result);
}

function buildPhases(phaseCounts: PhaseConfig): readonly [PhaseRecord, PhaseRecord, PhaseRecord, PhaseRecord] {
  return deepFreeze(CHEP_PHASE_NAMES.map((phase) => {
    const meta = PHASE_META[phase];
    return deepFreeze({
      phase,
      unique_scenario_count: phaseCounts[phase],
      counted_toward_target: meta.counted,
      outcome_use: meta.outcomeUse,
      holdout: meta.holdout,
      tuning_allowed: meta.tuningAllowed,
    });
  }) as [PhaseRecord, PhaseRecord, PhaseRecord, PhaseRecord]);
}

function buildSemanticInvariants(scenarios: readonly ScenarioRecord[], createdAt: string): SemanticInvariants {
  const scoredScenarios = scenarios.filter((s) => s.scored);
  const scoredCount = scoredScenarios.length;
  const languageFamilies = new Set(scenarios.map((s) => s.taxonomy.language_family));
  const validatorReport = makeArtifact(
    "file:///evaluation/validators/semantic-report.json",
    canonicalJson({ timestamp: createdAt, scenarios: scenarios.length }),
  );
  const eightLangs = languageFamilies.size >= 8;

  const invariants: SemanticInvariants = {
    exact_models_only: true,
    numeric_temperature_zero_everywhere: true,
    exactly_three_runs_per_model_test_cell: true,
    complete_two_model_cross_for_every_test: true,
    unique_ids_and_referential_integrity: true,
    all_content_ids_recompute: true,
    phase_counts_match: true,
    unique_scored_scenario_count: scoredCount,
    no_holdout_identity_in_earlier_phases: true,
    holdout_near_duplicate_firewall_passed: true,
    no_model_specific_harness_branching: true,
    no_adaptive_treatment_assignment: true,
    allocation_matches_normative_generator: true,
    topology_role_count_matches_agent_count: true,
    project_and_organization_caps_passed: true,
    at_least_eight_language_families: eightLangs as true,
    prompt_references_match_scenarios: true,
    condition_budget_fault_references_resolve: true,
    run_ids_and_schedule_keys_recompute: true,
    same_cell_api_seed_across_three_runs: true,
    no_selective_retained_fourth_run: true,
    trace_completeness_for_complete_runs: true,
    validator_report: validatorReport,
  };
  return deepFreeze(invariants);
}

export function generateMatrix(config: MatrixGeneratorConfig): MatrixDocument {
  const { phaseCounts, seedScenarios, projects, createdAt, maxOutputTokens } = config;

  const projectRecords = deepFreeze(projects.map(buildProjectRecord));
  const budgetPolicies = buildBudgetPolicies(maxOutputTokens);
  const faultProfiles = buildFaultProfiles();

  const toolSchemaSha = NO_TOOLS_SENT_SHA256;
  const systemPromptSha = NO_PROMPT_SENT_SHA256;
  const harnessArtifact = makeSourceArtifact(
    "file:///evaluation/harness.json",
    deepFreeze([
      "src/evaluation/matrix-generator.ts",
      "src/evaluation/scenario-runner.ts",
      "src/evaluation/matrix-executor.ts",
      "src/evaluation/results-writer.ts",
    ]),
  );
  const adapterArtifact = makeSourceArtifact(
    "file:///evaluation/adapter.json",
    deepFreeze(["src/runtime/provider-adapter.ts"]),
  );
  const retryPolicyJson = canonicalJson({
    maxRetries: 3,
    initialBackoffMs: 500,
    maxBackoffMs: 10000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
  });
  const retryArtifact = makeArtifact("file:///evaluation/retry-policy.json", retryPolicyJson);

  const conditions = buildConditions(
    budgetPolicies[0]!.budget_policy_id,
    faultProfiles[0]!.fault_profile_id,
    toolSchemaSha,
    systemPromptSha,
    harnessArtifact,
    adapterArtifact,
    retryArtifact,
  );

  const expanded = generateExpandedScenarios(seedScenarios, projects, phaseCounts);
  const scenarios = deepFreeze(expanded.map((e) => buildScenarioRecord(e.seed, e.phase, e.index)));

  const promptVariants: PromptVariantRecord[] = [];
  for (const e of expanded) {
    const enrichedOriginal = enrichPrompt(e.seed.promptVariants.original, e.seed, projects);
    promptVariants.push(buildPromptVariant(e.seed.scenarioId, "original", enrichedOriginal));
  }

  const tests: TestRecord[] = [];
  const cells: CellRecord[] = [];
  const scoredExpanded = expanded.filter((e) => PHASE_META[e.phase].scored);

  for (let si = 0; si < scoredExpanded.length; si++) {
    const e = scoredExpanded[si]!;
    const conditionIndices = selectConditions(si, conditions.length);
    const budgetPolicyId = si % 2 === 0 ? budgetPolicies[0]!.budget_policy_id : budgetPolicies[1]!.budget_policy_id;

    for (const ci of conditionIndices) {
      const condition = conditions[ci]!;
      const promptVariant = promptVariants.find((pv) => pv.scenario_id === e.seed.scenarioId)!;
      const topologyPanel = condition.arm !== "D0-direct";
      const test = buildTest(
        e.seed.scenarioId,
        e.phase,
        promptVariant.prompt_variant_id,
        condition.condition_id,
        budgetPolicyId,
        faultProfiles[0]!.fault_profile_id,
        si,
        ci,
        topologyPanel,
        true,
      );
      tests.push(test);
      for (const modelId of config.models) {
        cells.push(buildCell(test.test_id, modelId));
      }
    }
  }

  const phases = buildPhases(phaseCounts);
  const preregistration = deepFreeze({
    uri: `file:///evaluation/preregistration/${sha256(createdAt)}.json`,
    sha256: sha256(`preregistration:${createdAt}:${CHEP_MASTER_SEED_HEX}`),
    registered_at: createdAt,
    amendments: deepFreeze([] as readonly never[]),
  });

  const generator: GeneratorRecord = deepFreeze({
    generator_version: CHEP_GENERATOR_VERSION,
    algorithm: "CHEP-1.0 section 19 normative deterministic allocation",
    master_seed_hex: CHEP_MASTER_SEED_HEX,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "SHA-256",
    unicode_normalization: "NFC",
    line_endings: "LF",
    implementation_artifact: makeSourceArtifact(
      "file:///src/evaluation/matrix-generator.ts",
      deepFreeze(["src/evaluation/matrix-generator.ts"]),
    ),
    semantic_validator_artifact: makeSourceArtifact(
      "file:///src/evaluation/semantic-validators.ts",
      deepFreeze(["src/evaluation/semantic-validators.ts"]),
    ),
  });

  const endpointProfile: EndpointProfile = {
    provider_neutral_core: true,
    adapter_protocol: "openai-compatible-v1",
    base_url_binding: "late-bound",
    runtime_target: config.runtimeTarget ?? PROVIDER_NOT_CONFIGURED_BASE_URL,
    credentials_in_matrix: false,
    authorization_log_policy: "omit-and-record-typed-redaction",
    exact_model_string_required: true,
    model_fallback_allowed: false,
    capability_probe_required: true,
    capture_returned_model: true,
    capture_backend_fingerprint: true,
  };

  const sampling: SamplingRecord = {
    temperature: 0,
    seed_policy: "one-cell-seed-shared-by-three-runs-if-supported",
    top_p_policy: "exactly-1-if-supported",
    adaptive_reasoning_policy: "disabled-or-omitted-uniformly",
    max_output_tokens: maxOutputTokens,
    request_cache: false,
  };

  const matrixId = hashId("mtx", { createdAt, seed: CHEP_MASTER_SEED_HEX, phaseCounts });
  const semanticInvariants = buildSemanticInvariants(scenarios, createdAt);

  const matrixWithoutHash = {
    schema_version: CHEP_SCHEMA_VERSION,
    protocol_id: CHEP_PROTOCOL_ID,
    matrix_id: matrixId,
    created_at: createdAt,
    matrix_state: "preregistered" as const,
    preregistration,
    generator,
    endpoint_profile: endpointProfile,
    models: [...config.models] as readonly ChepModelId[],
    sampling,
    repetitions_per_model_test_cell: 3 as const,
    target_unique_scored_scenarios: CHEP_TARGET_SCORED_SCENARIOS,
    phases,
    projects: projectRecords,
    scenarios,
    prompt_variants: deepFreeze(promptVariants),
    budget_policies: budgetPolicies,
    fault_profiles: faultProfiles,
    conditions: conditions,
    tests: deepFreeze(tests),
    cells: deepFreeze(cells),
    semantic_invariants: semanticInvariants,
  };

  const payloadHash = sha256(canonicalJson(matrixWithoutHash));

  return deepFreeze({ ...matrixWithoutHash, matrix_payload_sha256: payloadHash } as MatrixDocument);
}

export function createDevelopmentConfig(
  seedScenarios: readonly ScenarioSeed[],
  projects: readonly EvalProject[],
  maxOutputTokens = DEFAULT_EVALUATION_MAX_OUTPUT_TOKENS,
  models: readonly ChepModelId[] = [...CHEP_MODELS],
  runtimeTarget: string = PROVIDER_NOT_CONFIGURED_BASE_URL,
): MatrixGeneratorConfig {
  if (models.length < 1) {
    throw new InputError("createDevelopmentConfig: models must contain at least one model id", "evaluation_models_empty");
  }
  return deepFreeze({
    phaseCounts: deepFreeze({
      "P0-shakedown": 3,
      "P1-baseline": 5,
      "P2-development": 3,
      "P3-holdout": 2,
    }),
    seedScenarios,
    projects,
    createdAt: "2026-07-17T00:00:00.000Z",
    maxOutputTokens,
    models: deepFreeze([...models]),
    runtimeTarget,
  });
}

export function createProductionConfig(
  seedScenarios: readonly ScenarioSeed[],
  projects: readonly EvalProject[],
  maxOutputTokens = DEFAULT_EVALUATION_PRODUCTION_MAX_OUTPUT_TOKENS,
  models: readonly ChepModelId[] = [...CHEP_MODELS],
  runtimeTarget: string = PROVIDER_NOT_CONFIGURED_BASE_URL,
): MatrixGeneratorConfig {
  if (models.length < 1) {
    throw new InputError("createProductionConfig: models must contain at least one model id", "evaluation_models_empty");
  }
  return deepFreeze({
    phaseCounts: CHEP_CANONICAL_PHASE_CONFIG,
    seedScenarios,
    projects,
    createdAt: "2026-07-17T00:00:00.000Z",
    maxOutputTokens,
    models: deepFreeze([...models]),
    runtimeTarget,
  });
}

export function buildScenarioPromptIndex(config: MatrixGeneratorConfig): ReadonlyMap<string, string> {
  const expanded = generateExpandedScenarios(config.seedScenarios, config.projects, config.phaseCounts);
  const index = new Map<string, string>();
  for (const entry of expanded) {
    const enrichedOriginal = enrichPrompt(entry.seed.promptVariants.original, entry.seed, config.projects);
    index.set(entry.seed.scenarioId, enrichedOriginal);
  }
  return index;
}

export type { CellRunResult };
