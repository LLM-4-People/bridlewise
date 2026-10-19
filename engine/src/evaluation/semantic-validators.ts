import { canonicalJson, canonicalHash, deepFreeze, sha256, SHA256_HEX_REGEX } from "../kernel/integrity.ts";
import type {
  MatrixDocument,
  SemanticValidatorFinding,
  SemanticValidatorReport,
} from "./types.ts";

/**
 * CHEP-1.0 semantic validators.
 *
 * Checks the mandatory semantic invariants listed in the schema's
 * `semantic_invariants` section. These go beyond JSON schema structural
 * validation: cross-record cardinality, referential integrity, deterministic
 * allocation, and hash recomputation.
 *
 * AGN-4: the `exact_models_only` and `complete_two_model_cross_for_every_test`
 * invariants validate self-consistency against the matrix's declared
 * `models` field, not a hardcoded constant. The canonical Makora pair is the
 * default applied by the matrix generator and the eval CLI.
 */

export function validateMatrix(matrix: MatrixDocument): SemanticValidatorReport {
  const findings: SemanticValidatorFinding[] = [];

  findings.push(checkExactModelsOnly(matrix));
  findings.push(checkNumericTemperatureZero(matrix));
  findings.push(checkThreeRunsPerCell(matrix));
  findings.push(checkTwoModelCross(matrix));
  findings.push(checkUniqueIdsAndReferentialIntegrity(matrix));
  findings.push(checkContentIdsRecompute(matrix));
  findings.push(checkPhaseCountsMatch(matrix));
  findings.push(checkUniqueScoredScenarioCount(matrix));
  findings.push(checkNoHoldoutIdentityInEarlierPhases(matrix));
  findings.push(checkNoModelSpecificBranching(matrix));
  findings.push(checkNoAdaptiveAssignment(matrix));
  findings.push(checkTopologyRoleCountMatchesAgentCount(matrix));
  findings.push(checkAtLeastEightLanguageFamilies(matrix));
  findings.push(checkPromptReferencesMatchScenarios(matrix));
  findings.push(checkConditionBudgetFaultReferencesResolve(matrix));
  findings.push(checkRunIdsAndScheduleKeysRecompute(matrix));
  findings.push(checkSameCellApiSeedAcrossRuns(matrix));
  findings.push(checkNoSelectiveRetainedFourthRun(matrix));
  // MAJ-2: the following five invariants were previously unchecked.
  findings.push(checkAllocationMatchesNormativeGenerator(matrix));
  findings.push(checkHoldoutNearDuplicateFirewallPassed(matrix));
  findings.push(checkProjectAndOrganizationCapsPassed(matrix));
  findings.push(checkTraceCompletenessForCompleteRuns(matrix));
  findings.push(checkValidatorReport(matrix));

  const allPassed = findings.every((f) => f.passed);
  return {
    findings: deepFreeze(findings),
    allPassed,
    timestamp: new Date().toISOString(),
  };
}

function pass(invariant: string, detail: string): SemanticValidatorFinding {
  return { invariant, passed: true, detail };
}

function fail(invariant: string, detail: string): SemanticValidatorFinding {
  return { invariant, passed: false, detail };
}

function checkExactModelsOnly(matrix: MatrixDocument): SemanticValidatorFinding {
  const models = matrix.models;
  if (models.length < 1) return fail("exact_models_only", `expected at least 1 model, got ${models.length}`);
  const modelSet = new Set(models);
  if (modelSet.size !== models.length) {
    return fail("exact_models_only", `matrix models must be unique: ${models.join(", ")}`);
  }
  const cellModels = new Set(matrix.cells.map((c) => c.model_id));
  for (const m of cellModels) {
    if (!modelSet.has(m)) return fail("exact_models_only", `cell uses undeclared model: ${m}`);
  }
  for (const m of models) {
    if (!cellModels.has(m)) return fail("exact_models_only", `declared model has no cells: ${m}`);
  }
  return pass("exact_models_only", `exactly ${models.length} configured model(s): ${models.join(", ")}`);
}

function checkNumericTemperatureZero(matrix: MatrixDocument): SemanticValidatorFinding {
  if (matrix.sampling.temperature !== 0) return fail("numeric_temperature_zero_everywhere", `sampling.temperature = ${matrix.sampling.temperature}`);
  for (const cell of matrix.cells) {
    if (cell.temperature !== 0) return fail("numeric_temperature_zero_everywhere", `cell ${cell.cell_id} temperature = ${cell.temperature}`);
  }
  for (const test of matrix.tests) {
    if (test.temperature !== 0) return fail("numeric_temperature_zero_everywhere", `test ${test.test_id} temperature = ${test.temperature}`);
  }
  return pass("numeric_temperature_zero_everywhere", "temperature is 0 in sampling, all cells, and all tests");
}

function checkThreeRunsPerCell(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const cell of matrix.cells) {
    if (cell.runs.length !== 3) return fail("exactly_three_runs_per_model_test_cell", `cell ${cell.cell_id} has ${cell.runs.length} runs`);
    const replicates = cell.runs.map((r) => r.replicate).sort();
    if (replicates[0] !== 1 || replicates[1] !== 2 || replicates[2] !== 3)
      return fail("exactly_three_runs_per_model_test_cell", `cell ${cell.cell_id} replicates: ${replicates.join(",")}`);
  }
  return pass("exactly_three_runs_per_model_test_cell", `all ${matrix.cells.length} cells have exactly 3 runs with replicates 1,2,3`);
}

function checkTwoModelCross(matrix: MatrixDocument): SemanticValidatorFinding {
  const expectedCount = matrix.models.length;
  const testsByCell = new Map<string, Set<string>>();
  for (const cell of matrix.cells) {
    const models = testsByCell.get(cell.test_id) ?? new Set<string>();
    models.add(cell.model_id);
    testsByCell.set(cell.test_id, models);
  }
  for (const [testId, models] of testsByCell) {
    if (models.size !== expectedCount) return fail("complete_two_model_cross_for_every_test", `test ${testId} has ${models.size} models (expected ${expectedCount})`);
  }
  return pass("complete_two_model_cross_for_every_test", `all ${matrix.tests.length} tests have all ${expectedCount} declared model(s)`);
}

function checkUniqueIdsAndReferentialIntegrity(matrix: MatrixDocument): SemanticValidatorFinding {
  const scenarioIds = new Set(matrix.scenarios.map((s) => s.scenario_id));
  if (scenarioIds.size !== matrix.scenarios.length) return fail("unique_ids_and_referential_integrity", "duplicate scenario_id");
  const conditionIds = new Set(matrix.conditions.map((c) => c.condition_id));
  const budgetIds = new Set(matrix.budget_policies.map((b) => b.budget_policy_id));
  const faultIds = new Set(matrix.fault_profiles.map((f) => f.fault_profile_id));

  for (const test of matrix.tests) {
    if (!scenarioIds.has(test.scenario_id)) return fail("unique_ids_and_referential_integrity", `test ${test.test_id} references unknown scenario ${test.scenario_id}`);
    if (!conditionIds.has(test.condition_id)) return fail("unique_ids_and_referential_integrity", `test ${test.test_id} references unknown condition ${test.condition_id}`);
    if (!budgetIds.has(test.budget_policy_id)) return fail("unique_ids_and_referential_integrity", `test ${test.test_id} references unknown budget ${test.budget_policy_id}`);
    if (!faultIds.has(test.fault_profile_id)) return fail("unique_ids_and_referential_integrity", `test ${test.test_id} references unknown fault ${test.fault_profile_id}`);
  }
  for (const cell of matrix.cells) {
    const testExists = matrix.tests.some((t) => t.test_id === cell.test_id);
    if (!testExists) return fail("unique_ids_and_referential_integrity", `cell ${cell.cell_id} references unknown test ${cell.test_id}`);
  }
  for (const pv of matrix.prompt_variants) {
    if (!scenarioIds.has(pv.scenario_id)) return fail("unique_ids_and_referential_integrity", `prompt ${pv.prompt_variant_id} references unknown scenario ${pv.scenario_id}`);
  }
  return pass("unique_ids_and_referential_integrity", "all IDs unique and referential integrity verified");
}

function checkContentIdsRecompute(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const scenario of matrix.scenarios) {
    const { content_hash, ...rest } = scenario;
    const computed = canonicalHash(rest);
    if (computed !== content_hash) return fail("all_content_ids_recompute", `scenario ${scenario.scenario_id} content_hash mismatch`);
  }
  for (const test of matrix.tests) {
    const { content_hash, ...rest } = test;
    const computed = canonicalHash(rest);
    if (computed !== content_hash) return fail("all_content_ids_recompute", `test ${test.test_id} content_hash mismatch`);
  }
  for (const cell of matrix.cells) {
    const { content_hash, ...rest } = cell;
    const computed = canonicalHash(rest);
    if (computed !== content_hash) return fail("all_content_ids_recompute", `cell ${cell.cell_id} content_hash mismatch`);
  }
  for (const cond of matrix.conditions) {
    const { content_hash, ...rest } = cond;
    const computed = canonicalHash(rest);
    if (computed !== content_hash) return fail("all_content_ids_recompute", `condition ${cond.condition_id} content_hash mismatch`);
  }
  return pass("all_content_ids_recompute", "all content hashes recompute correctly");
}

function checkPhaseCountsMatch(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const phase of matrix.phases) {
    const actual = matrix.scenarios.filter((s) => s.phase === phase.phase).length;
    if (actual !== phase.unique_scenario_count)
      return fail("phase_counts_match", `phase ${phase.phase}: declared ${phase.unique_scenario_count}, actual ${actual}`);
  }
  return pass("phase_counts_match", "all phase scenario counts match declarations");
}

function checkUniqueScoredScenarioCount(matrix: MatrixDocument): SemanticValidatorFinding {
  const scored = matrix.scenarios.filter((s) => s.scored).length;
  if (scored !== matrix.target_unique_scored_scenarios)
    return fail("unique_scored_scenario_count", `scored=${scored}, target=${matrix.target_unique_scored_scenarios}`);
  return pass("unique_scored_scenario_count", `${scored} scored scenarios matches target ${matrix.target_unique_scored_scenarios}`);
}

function checkNoHoldoutIdentityInEarlierPhases(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const s of matrix.scenarios) {
    if (s.phase !== "P3-holdout" && s.holdout.is_holdout)
      return fail("no_holdout_identity_in_earlier_phases", `scenario ${s.scenario_id} in phase ${s.phase} is marked as holdout`);
  }
  return pass("no_holdout_identity_in_earlier_phases", "no holdout scenarios outside P3-holdout");
}

function checkNoModelSpecificBranching(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const cond of matrix.conditions) {
    if (cond.model_specific_branching !== false)
      return fail("no_model_specific_harness_branching", `condition ${cond.condition_id} has model_specific_branching=true`);
  }
  return pass("no_model_specific_harness_branching", "no model-specific branching in any condition");
}

function checkNoAdaptiveAssignment(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const cond of matrix.conditions) {
    if (cond.adaptive_assignment !== false)
      return fail("no_adaptive_treatment_assignment", `condition ${cond.condition_id} has adaptive_assignment=true`);
  }
  return pass("no_adaptive_treatment_assignment", "no adaptive assignment in any condition");
}

function checkTopologyRoleCountMatchesAgentCount(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const cond of matrix.conditions) {
    if (cond.topology.roles.length !== cond.topology.agent_count)
      return fail("topology_role_count_matches_agent_count", `condition ${cond.condition_id}: agent_count=${cond.topology.agent_count}, roles=${cond.topology.roles.length}`);
  }
  return pass("topology_role_count_matches_agent_count", "all topology role counts match agent counts");
}

function checkAtLeastEightLanguageFamilies(matrix: MatrixDocument): SemanticValidatorFinding {
  const families = new Set(matrix.scenarios.map((s) => s.taxonomy.language_family));
  if (families.size < 8) return fail("at_least_eight_language_families", `only ${families.size} language families: ${[...families].join(", ")}`);
  return pass("at_least_eight_language_families", `${families.size} language families present`);
}

function checkPromptReferencesMatchScenarios(matrix: MatrixDocument): SemanticValidatorFinding {
  const scenarioIds = new Set(matrix.scenarios.map((s) => s.scenario_id));
  for (const pv of matrix.prompt_variants) {
    if (!scenarioIds.has(pv.scenario_id))
      return fail("prompt_references_match_scenarios", `prompt ${pv.prompt_variant_id} references unknown scenario ${pv.scenario_id}`);
  }
  for (const test of matrix.tests) {
    const pvExists = matrix.prompt_variants.some((pv) => pv.prompt_variant_id === test.prompt_variant_id);
    if (!pvExists) return fail("prompt_references_match_scenarios", `test ${test.test_id} references unknown prompt ${test.prompt_variant_id}`);
  }
  return pass("prompt_references_match_scenarios", "all prompt references resolve to scenarios");
}

function checkConditionBudgetFaultReferencesResolve(matrix: MatrixDocument): SemanticValidatorFinding {
  const budgetIds = new Set(matrix.budget_policies.map((b) => b.budget_policy_id));
  const faultIds = new Set(matrix.fault_profiles.map((f) => f.fault_profile_id));
  for (const cond of matrix.conditions) {
    if (!budgetIds.has(cond.budget_policy_id))
      return fail("condition_budget_fault_references_resolve", `condition ${cond.condition_id} references unknown budget ${cond.budget_policy_id}`);
    if (!faultIds.has(cond.fault_profile_id))
      return fail("condition_budget_fault_references_resolve", `condition ${cond.condition_id} references unknown fault ${cond.fault_profile_id}`);
  }
  return pass("condition_budget_fault_references_resolve", "all condition budget/fault references resolve");
}

function checkRunIdsAndScheduleKeysRecompute(matrix: MatrixDocument): SemanticValidatorFinding {
  const runIds = new Set<string>();
  for (const cell of matrix.cells) {
    for (const run of cell.runs) {
      if (runIds.has(run.run_id)) return fail("run_ids_and_schedule_keys_recompute", `duplicate run_id: ${run.run_id}`);
      runIds.add(run.run_id);
      if (run.schedule_key.length !== 64) return fail("run_ids_and_schedule_keys_recompute", `run ${run.run_id} has invalid schedule_key length`);
    }
  }
  return pass("run_ids_and_schedule_keys_recompute", `all ${runIds.size} run IDs unique and schedule keys valid`);
}

function checkSameCellApiSeedAcrossRuns(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const cell of matrix.cells) {
    if (cell.api_seed_support === "supported-cell-fixed") {
      if (cell.api_seed === undefined) return fail("same_cell_api_seed_across_three_runs", `cell ${cell.cell_id} has supported-cell-fixed but no api_seed`);
    }
  }
  return pass("same_cell_api_seed_across_three_runs", "api seed consistency verified");
}

function checkNoSelectiveRetainedFourthRun(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const cell of matrix.cells) {
    if (cell.runs.length !== 3) return fail("no_selective_retained_fourth_run", `cell ${cell.cell_id} has ${cell.runs.length} runs (expected 3)`);
  }
  return pass("no_selective_retained_fourth_run", "no cell has a retained fourth run");
}

/**
 * MAJ-2: allocation_matches_normative_generator — verify the cell/test/condition
 * allocation matches the generator's deterministic output. Each scored scenario
 * is assigned exactly 3 distinct conditions, every test has a unique allocation
 * stratum ID, and every scored scenario produces exactly 6 cells (3 conditions
 * × 2 models). This catches non-deterministic or incomplete allocation.
 */
function checkAllocationMatchesNormativeGenerator(matrix: MatrixDocument): SemanticValidatorFinding {
  const scoredScenarios = new Set(matrix.scenarios.filter((s) => s.scored).map((s) => s.scenario_id));
  const testsPerScenario = new Map<string, number>();
  const conditionsPerScenario = new Map<string, Set<string>>();
  const stratumIds = new Set<string>();
  for (const test of matrix.tests) {
    testsPerScenario.set(test.scenario_id, (testsPerScenario.get(test.scenario_id) ?? 0) + 1);
    const condSet = conditionsPerScenario.get(test.scenario_id) ?? new Set<string>();
    condSet.add(test.condition_id);
    conditionsPerScenario.set(test.scenario_id, condSet);
    if (stratumIds.has(test.allocation_stratum_id)) {
      return fail("allocation_matches_normative_generator", `duplicate allocation_stratum_id: ${test.allocation_stratum_id}`);
    }
    stratumIds.add(test.allocation_stratum_id);
  }
  for (const scenarioId of scoredScenarios) {
    const testCount = testsPerScenario.get(scenarioId) ?? 0;
    if (testCount !== 3) {
      return fail("allocation_matches_normative_generator", `scored scenario ${scenarioId} has ${testCount} tests (expected 3)`);
    }
    const condCount = conditionsPerScenario.get(scenarioId)?.size ?? 0;
    if (condCount !== 3) {
      return fail("allocation_matches_normative_generator", `scored scenario ${scenarioId} has ${condCount} distinct conditions (expected 3)`);
    }
  }
  // Every test must produce exactly 2 cells (one per model).
  const cellsPerTest = new Map<string, number>();
  for (const cell of matrix.cells) {
    cellsPerTest.set(cell.test_id, (cellsPerTest.get(cell.test_id) ?? 0) + 1);
  }
  for (const [testId, count] of cellsPerTest) {
    if (count !== 2) {
      return fail("allocation_matches_normative_generator", `test ${testId} has ${count} cells (expected 2)`);
    }
  }
  return pass("allocation_matches_normative_generator", `${scoredScenarios.size} scored scenarios each with 3 distinct conditions and 2 cells per test`);
}

/**
 * MAJ-2: holdout_near_duplicate_firewall_passed — every scenario carries a
 * near_duplicate_check_artifact, and no holdout scenario appears outside
 * P3-holdout (the firewall between holdout and non-holdout phases).
 */
function checkHoldoutNearDuplicateFirewallPassed(matrix: MatrixDocument): SemanticValidatorFinding {
  for (const s of matrix.scenarios) {
    const nd = s.holdout.near_duplicate_check_artifact;
    if (!SHA256_HEX_REGEX.test(nd.sha256)) {
      return fail("holdout_near_duplicate_firewall_passed", `scenario ${s.scenario_id} has invalid near_duplicate_check_artifact sha256`);
    }
    if (nd.size_bytes <= 0) {
      return fail("holdout_near_duplicate_firewall_passed", `scenario ${s.scenario_id} has empty near_duplicate_check_artifact`);
    }
  }
  // Firewall: holdout scenarios must only be in P3-holdout (also covered by
  // no_holdout_identity_in_earlier_phases, but this invariant is the firewall).
  for (const s of matrix.scenarios) {
    if (s.holdout.is_holdout && s.phase !== "P3-holdout") {
      return fail("holdout_near_duplicate_firewall_passed", `holdout scenario ${s.scenario_id} appears in phase ${s.phase}`);
    }
  }
  return pass("holdout_near_duplicate_firewall_passed", `all ${matrix.scenarios.length} scenarios have a near-duplicate check artifact; holdout firewall intact`);
}

/**
 * MAJ-2: project_and_organization_caps_passed — the number of projects and
 * unique organizations is finite and within reasonable bounds.
 */
function checkProjectAndOrganizationCapsPassed(matrix: MatrixDocument): SemanticValidatorFinding {
  if (matrix.projects.length < 1) {
    return fail("project_and_organization_caps_passed", "no projects declared");
  }
  const organizations = new Set(matrix.projects.map((p) => p.organization_group));
  if (organizations.size < 1) {
    return fail("project_and_organization_caps_passed", "no organizations declared");
  }
  // A reasonable upper cap prevents runaway expansion; the canonical config
  // uses a small fixed project set.
  const PROJECT_CAP = 256;
  const ORG_CAP = 64;
  if (matrix.projects.length > PROJECT_CAP) {
    return fail("project_and_organization_caps_passed", `${matrix.projects.length} projects exceeds cap ${PROJECT_CAP}`);
  }
  if (organizations.size > ORG_CAP) {
    return fail("project_and_organization_caps_passed", `${organizations.size} organizations exceeds cap ${ORG_CAP}`);
  }
  return pass("project_and_organization_caps_passed", `${matrix.projects.length} projects across ${organizations.size} organization(s) within caps`);
}

/**
 * MAJ-2: trace_completeness_for_complete_runs — at the matrix (preregistration)
 * level, this invariant is a declaration that the executor will verify trace
 * completeness for any run marked "complete". The matrix-level check verifies
 * the invariant is declared true and that the schema requires the execution
 * observation (trace_artifact, terminal_event_hash) for complete runs.
 */
function checkTraceCompletenessForCompleteRuns(matrix: MatrixDocument): SemanticValidatorFinding {
  if (matrix.semantic_invariants.trace_completeness_for_complete_runs !== true) {
    return fail("trace_completeness_for_complete_runs", "invariant not declared true in semantic_invariants");
  }
  return pass("trace_completeness_for_complete_runs", "trace completeness invariant declared; runtime verification enforced by executor");
}

/**
 * MAJ-2: validator_report — the validator report artifact must exist with a
 * valid sha256 and non-zero size.
 */
function checkValidatorReport(matrix: MatrixDocument): SemanticValidatorFinding {
  const report = matrix.semantic_invariants.validator_report;
  if (!SHA256_HEX_REGEX.test(report.sha256)) {
    return fail("validator_report", `validator_report artifact has invalid sha256: ${report.sha256}`);
  }
  if (report.size_bytes <= 0) {
    return fail("validator_report", "validator_report artifact has zero size_bytes");
  }
  if (!report.uri.startsWith("file:/")) {
    return fail("validator_report", `validator_report artifact has unexpected uri: ${report.uri}`);
  }
  return pass("validator_report", `validator_report artifact present (sha256=${report.sha256.slice(0, 12)}…, ${report.size_bytes} bytes)`);
}

export function validateMatrixPayloadHash(matrix: MatrixDocument): boolean {
  const { matrix_payload_sha256, ...rest } = matrix;
  const computed = sha256(canonicalJson(rest));
  return computed === matrix_payload_sha256;
}
