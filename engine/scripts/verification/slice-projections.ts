import { GENERATED_CONTRACT_SCHEMAS } from "../../src/kernel/contracts.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { GENERATED_FORENSIC_SCHEMAS } from "../../src/forensics/forensic-contracts.ts";
import {
  GENERATED_GUARDIAN_SPEC_SCHEMAS,
  GUARDIAN_SPEC_SCHEMA_HASH,
  GUARDIAN_SPEC_SCHEMA_VERSION,
} from "../../src/filesystem/self-protection/self-protection-contracts.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256, type DeepReadonly } from "../../src/kernel/integrity.ts";
import { createS2OfflineContractIdentity } from "../../src/forensics/offline-contracts.ts";
import { createS3OfflineForensicIdentity } from "../../src/forensics/offline-forensics.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { sameOrderedValues } from "../../src/kernel/ordered.ts";
import {
  AUDIT_MATRIX_ANGLES,
  AUDIT_MATRIX_SCHEMA,
  AUDIT_MATRIX_SCHEMA_VERSION,
  AUDIT_MATRIX_STAGES,
  requirementApplicabilityProjection,
  type RequirementsRegistry,
} from "../../src/kernel/requirements.ts";
import type { TestInventoryEntry } from "../test-inventory.ts";
import {
  normalizeSliceProjectionInput,
  type SliceProjectionInput,
} from "./slice-projection-captured-values.ts";
export {
  createSliceProjectionCapturedValues,
  SLICE_PROJECTION_CAPTURED_VALUES_SCHEMA_VERSION,
  type SliceProjectionCapturedFile,
  type SliceProjectionCapturedValues,
  type SliceProjectionInput,
} from "./slice-projection-captured-values.ts";
import {
  currentSliceRootPolicyView,
  resolveSliceProjectionInputs,
  type RequirementsProjection,
  type SliceRootPolicyView,
} from "./slice-projection-inputs.ts";
export {
  deriveSliceProjectionInputPaths,
  SLICE_PROJECTION_STATIC_INPUT_PATHS,
  type SliceRootPolicyView,
} from "./slice-projection-inputs.ts";
type JsonObject = Readonly<Record<string, unknown>>;
type JsonSchemaMap = Readonly<Record<string, JsonObject>>;

export type ProjectionArtifact = DeepReadonly<{
  path: string;
  value: unknown;
  bytes: string;
  sha256: string;
  identityHash: string;
}>;

export type SliceProjectionBuild = DeepReadonly<{
  artifactsByPath: Readonly<Record<string, ProjectionArtifact>>;
  artifactIdentitiesByPath: Readonly<Record<string, string>>;
  inputIdentity: string;
  auditMatrixIdentity: string;
}>;

export type SliceProjectionCheck = DeepReadonly<{
  ok: boolean;
  violations: readonly string[];
  paths: readonly Readonly<{
    path: string;
    disposition: "exact" | "missing" | "duplicate" | "drift";
    expectedSha256: string;
    observedSha256?: string;
  }>[];
}>;

export type SliceProjectionPlan = DeepReadonly<{
  build: SliceProjectionBuild;
  check: SliceProjectionCheck;
  changes: readonly Readonly<{
    path: string;
    expectedSha256: string;
    expectedByteLength: number;
    disposition: "missing" | "duplicate" | "drift";
  }>[];
}>;

function buildRequirementsSchemaArtifact(requirements: RequirementsProjection): ProjectionArtifact {
  return artifact(requirements.schemaArtifactPath, {
    schemaVersion: requirements.schemaArtifactVersion,
    registryFileSha256: requirements.registryFileSha256,
    schemaHash: requirements.schemaHash,
    schema: requirements.generatedSchema,
  }, "canonical");
}

function buildContractSchemaArtifact(
  rootPolicy: SliceRootPolicyView,
  schemas: JsonSchemaMap,
): ProjectionArtifact {
  assertSchemaDialect(schemas, rootPolicy.contracts.schemaDialect, "contract");
  const contractBundleHash = canonicalHash(schemas);
  return artifact(rootPolicy.contracts.schemaArtifactPath, {
    schemaVersion: rootPolicy.contracts.schemaArtifactVersion,
    contractBundleHash,
    schemas,
  }, "canonical");
}

function buildForensicSchemaArtifact(
  rootPolicy: SliceRootPolicyView,
  schemas: JsonSchemaMap,
): ProjectionArtifact {
  assertSchemaDialect(schemas, rootPolicy.forensics.schemaDialect, "forensic");
  const schemaBundleHash = canonicalHash(schemas);
  return artifact(rootPolicy.forensics.schemaArtifactPath, {
    schemaVersion: rootPolicy.forensics.schemaArtifactVersion,
    schemaBundleHash,
    schemas,
  }, "canonical");
}

/**
 * Build the published Landlock guardian ruleset-spec schema artifact. The
 * Zod schema `GUARDIAN_SPEC_SCHEMA` in
 * `src/filesystem/self-protection/self-protection-contracts.ts` is the ONE
 * authority; this projection is published to
 * `traceability/self-protection/guardian-spec-schema.json` (path owned by
 * `ROOT_POLICY.selfProtection.specSchemaArtifactPath`). The artifact is
 * written by `scripts/build-bundle.ts` (the self-protection build step) and
 * hash-bound to `ROOT_POLICY.selfProtection.specSchemaArtifactSha256` so
 * `harness check` detects drift between the contracts module and the
 * published artifact. Standalone (does not depend on the slice-declaration
 * projection input machinery) so it can run independently of the s2/s24/s31
 * trace build.
 */
export function buildGuardianSpecSchemaArtifact(): ProjectionArtifact {
  const schemas = GENERATED_GUARDIAN_SPEC_SCHEMAS as unknown as JsonSchemaMap;
  return artifact(ROOT_POLICY.selfProtection.specSchemaArtifactPath, {
    schemaVersion: GUARDIAN_SPEC_SCHEMA_VERSION,
    schemaBundleHash: GUARDIAN_SPEC_SCHEMA_HASH,
    schemas,
  }, "canonical");
}

export function buildUnassessedAuditMatrix() {
  const policy = currentSliceRootPolicyView().audit;
  if (policy.evidenceAdmissionAvailable || policy.draftSatisfactionAllowed ||
    !sameOrderedValues(policy.angles, AUDIT_MATRIX_ANGLES) ||
    !sameOrderedValues(policy.stages, AUDIT_MATRIX_STAGES)) {
    throw new InputError("Unassessed audit policy is not fail closed", "slice_audit_policy_invalid");
  }
  const assessment = (realm: "builder" | "runtime") => ({
    subjectRealm: realm,
    executionBoundary: realm === "builder" ? "repository-build-and-maintenance" as const :
      "governed-project-execution" as const,
    applicability: "applicable" as const,
    outcome: "unassessed" as const,
    reason: `This slice has not completed independent ${realm} acceptance for this audit cell.`,
    evidenceLinks: [] as string[],
  });
  const cell = (id: string) => ({
    id,
    surfaceAssessments: { builder: assessment("builder"), runtime: assessment("runtime") },
  });
  const matrix = {
    schemaVersion: AUDIT_MATRIX_SCHEMA_VERSION,
    angles: policy.angles.map(cell),
    stages: policy.stages.map(cell),
    findingLifecycle: {
      requiredSequence: ["finding", "root-cause", "permanent-regression", "repair", "recheck"] as const,
      findings: [] as readonly never[],
    },
    independentAudit: {
      required: true as const,
      selfHostedSufficient: false as const,
      outcome: "unassessed" as const,
      reason: "The mandatory non-self-hosted independent audit has not yet completed for this slice.",
      evidenceLinks: [] as string[],
    },
  };
  return deepFreeze(AUDIT_MATRIX_SCHEMA.parse(matrix));
}

export function buildSliceProjection(input: SliceProjectionInput): SliceProjectionBuild {
  const captured = normalizeSliceProjectionInput(input).captured;
  const resolved = resolveSliceProjectionInputs(captured);
  const {
    declarations,
    requirements,
    sourceInputs,
    sourceIdentities: sources,
    rootPolicy,
    testBindings,
    fixtures,
  } = resolved;
  const requirementsArtifact = buildRequirementsSchemaArtifact(requirements);
  const contractArtifact = buildContractSchemaArtifact(rootPolicy, GENERATED_CONTRACT_SCHEMAS);
  const forensicArtifact = buildForensicSchemaArtifact(rootPolicy, GENERATED_FORENSIC_SCHEMAS);
  const auditMatrix = buildUnassessedAuditMatrix();
  const applicability = Object.fromEntries(declarations.slices.map((slice) => [
    slice.slice,
    buildSliceApplicability(requirements.registry, slice.applicability),
  ])) as Record<string, ReturnType<typeof buildSliceApplicability>>;
  const contractBundleHash = canonicalHash(GENERATED_CONTRACT_SCHEMAS);
  const forensicBundleHash = canonicalHash(GENERATED_FORENSIC_SCHEMAS);
  const contractPolicy = rootPolicy.contracts;
  const forensicPolicy = rootPolicy.forensics;
  const s2Identity = createS2OfflineContractIdentity({
    implementation: contractPolicy.implementation,
    modules: contractPolicy.modules,
    schemaBundleHash: contractBundleHash,
    requirementsRegistryIdentityHash: requirements.identityHash,
  });
  const s31Identity = createS3OfflineForensicIdentity({
    implementation: forensicPolicy.implementation,
    policyHash: forensicPolicy.policyHash,
    modules: forensicPolicy.modules,
    schemaBundleHash: forensicBundleHash,
    requirementsRegistryIdentityHash: requirements.identityHash,
  });
  const requirementsReference = {
    path: requirements.registryPath,
    schemaVersion: requirements.schemaVersion,
    fileSha256: requirements.registryFileSha256,
    identityHash: requirements.identityHash,
  };
  const s2 = declarations.slices[0]!;
  const s24 = declarations.slices[1]!;
  const s31 = declarations.slices[2]!;
  const s2Trace = {
    schemaVersion: s2.outputSchemaVersion,
    slice: s2.slice,
    name: s2.name,
    requirementsRegistry: requirementsReference,
    requirements: applicability[s2.slice]!.requirementIds,
    derivedControls: applicability[s2.slice]!.derivedControlIds,
    supersedes: s2.supersedes,
    scope: disabledScope(["network", "modelInvocation", "toolExecution", "transportExecution"]),
    research: {
      accessedOn: sourceInputs.s2Research.manifest.accessedOn,
      sources: sourceInputs.s2Research.manifest.sources,
      officialFragments: {
        path: sourceInputs.s2Official.path,
        sha256: sources.s2OfficialManifestSha256,
      },
    },
    contracts: {
      schemaDialect: rootPolicy.contracts.schemaDialect,
      contractBundleHash,
      offlineContractHash: canonicalHash(s2Identity),
      artifact: { path: contractArtifact.path, sha256: contractArtifact.sha256 },
      protocols: rootPolicy.contracts.protocolIds,
    },
    behaviors: s2.behaviors.map((behavior) => ({
      id: behavior.id,
      name: behavior.name,
      testName: testBindings[behavior.id]!.name,
      fixtures: fixtures[behavior.id],
    })),
    acceptance: s2.acceptance,
    auditMatrix,
  };
  const s24Trace = {
    schemaVersion: s24.outputSchemaVersion,
    slice: s24.slice,
    name: s24.name,
    supersedes: s24.supersedes,
    scope: disabledScope(["network", "modelInvocation", "toolExecution", "transportExecution", "mutableState", "durableAudit"]),
    requirementsRegistry: {
      path: requirements.registryPath,
      schemaVersion: requirements.schemaVersion,
      fileSha256: requirements.registryFileSha256,
      sourceArtifactSha256: requirements.sourceArtifactSha256,
      schemaHash: requirements.schemaHash,
      identityHash: requirements.identityHash,
      schemaArtifact: { path: requirementsArtifact.path, sha256: requirementsArtifact.sha256 },
    },
    requirements: applicability[s24.slice]!.requirementIds,
    derivedControls: applicability[s24.slice]!.derivedControlIds,
    behaviors: plannedBehaviors(s24.behaviors, testBindings),
    acceptance: s24.acceptance,
    auditMatrix,
  };
  const s31Trace = {
    schemaVersion: s31.outputSchemaVersion,
    slice: s31.slice,
    name: s31.name,
    requirementsRegistry: requirementsReference,
    supersedes: s31.supersedes,
    scope: disabledScope([
      "network", "modelInvocation", "toolExecution", "processExecution", "repositoryMutation", "storage",
      "durableAudit", "forwarding",
    ]),
    requirements: applicability[s31.slice]!.requirementIds,
    derivedControls: applicability[s31.slice]!.derivedControlIds,
    research: {
      accessedOn: sourceInputs.s31.manifest.accessedOn,
      manifest: { path: sourceInputs.s31.path, sha256: sources.s31ManifestSha256 },
      primarySources: sourceInputs.s31.manifest.sources.length,
      licensedReferenceFragments: sourceInputs.s31.manifest.sources[9].fragments.length,
    },
    contracts: {
      schemaDialect: rootPolicy.forensics.schemaDialect,
      canonicalization: rootPolicy.forensics.canonicalization,
      schemaBundleHash: forensicBundleHash,
      offlineForensicHash: canonicalHash(s31Identity),
      artifact: { path: forensicArtifact.path, sha256: forensicArtifact.sha256 },
    },
    behaviors: plannedBehaviors(s31.behaviors, testBindings),
    acceptance: s31.acceptance,
    auditMatrix,
  };
  const traceArtifacts = [
    artifact(s2.outputPath, s2Trace, "pretty"),
    artifact(s24.outputPath, s24Trace, "pretty"),
    artifact(s31.outputPath, s31Trace, "pretty"),
  ];
  const all = [requirementsArtifact, contractArtifact, forensicArtifact, ...traceArtifacts];
  const artifactsByPath = Object.fromEntries(all.map((entry) => [entry.path, entry]));
  const artifactIdentitiesByPath = Object.fromEntries(all.map((entry) => [entry.path, entry.identityHash]));
  const inputIdentity = canonicalHash({
    capturedFiles: resolved.capturedFileIdentities,
    declarationsIdentity: canonicalHash(declarations),
    requirementsIdentity: requirements.identityHash,
    configurationIdentity: resolved.configurationIdentityHash,
    rootPolicyIdentity: canonicalHash(rootPolicy),
    sourceIdentities: sources,
    contractBundleHash,
    forensicBundleHash,
    assessmentProjection: "unavailable-unassessed-non-authoritative",
  });
  return deepFreeze({
    artifactsByPath,
    artifactIdentitiesByPath,
    inputIdentity,
    auditMatrixIdentity: canonicalHash(auditMatrix),
  });
}

export function projectSliceProjection(input: SliceProjectionInput): SliceProjectionBuild {
  return buildSliceProjection(input);
}

export function planSliceProjection(
  input: SliceProjectionInput,
  destinations: readonly Readonly<{ path: string; bytes: string }>[],
): SliceProjectionPlan {
  const build = projectSliceProjection(input);
  const check = checkSliceProjection(build, destinations);
  const changes = check.paths.flatMap((entry) => entry.disposition === "exact" ? [] : [{
      path: entry.path,
      expectedSha256: entry.expectedSha256,
      expectedByteLength: Buffer.byteLength(build.artifactsByPath[entry.path]!.bytes),
      disposition: entry.disposition,
    }]);
  return deepFreeze({ build, check, changes });
}

export function checkSliceProjection(
  build: SliceProjectionBuild,
  destinations: readonly Readonly<{ path: string; bytes: string }>[],
): SliceProjectionCheck {
  const byPath = new Map<string, string[]>();
  for (const destination of destinations) {
    const values = byPath.get(destination.path) ?? [];
    values.push(destination.bytes);
    byPath.set(destination.path, values);
  }
  const paths = Object.values(build.artifactsByPath).map((expected) => {
    const observed = byPath.get(expected.path) ?? [];
    if (observed.length === 0) return {
      path: expected.path, disposition: "missing" as const, expectedSha256: expected.sha256,
    };
    const observedSha256 = sha256(observed[0]!);
    if (observed.length !== 1) return {
      path: expected.path, disposition: "duplicate" as const, expectedSha256: expected.sha256, observedSha256,
    };
    return {
      path: expected.path,
      disposition: observed[0] === expected.bytes ? "exact" as const : "drift" as const,
      expectedSha256: expected.sha256,
      observedSha256,
    };
  });
  const unexpected = [...byPath.keys()].filter((path) => !(path in build.artifactsByPath)).toSorted();
  const violations = [
    ...paths.filter((entry) => entry.disposition !== "exact")
      .map((entry) => `slice_projection_${entry.disposition}:${entry.path}`),
    ...unexpected.map((path) => `slice_projection_unexpected:${path}`),
  ];
  return deepFreeze({ ok: violations.length === 0, violations, paths });
}

function buildSliceApplicability(registry: RequirementsRegistry, references: readonly string[]) {
  assertUnique(references, "slice_applicability_duplicate");
  const projection = requirementApplicabilityProjection(registry, references);
  if (projection.orderedIds.length !== references.length) {
    throw new InputError("Slice applicability is incomplete", "slice_applicability_incomplete");
  }
  return projection;
}

function plannedBehaviors(
  behaviors: readonly Readonly<{
    id: string;
    name: string;
    testName: string;
    scenarioSuffixes: readonly string[];
  }>[],
  bindings: Readonly<Record<string, TestInventoryEntry>>,
) {
  return behaviors.map((behavior) => ({
    id: behavior.id,
    name: behavior.name,
    testName: bindings[behavior.id]!.name,
    scenarios: behavior.scenarioSuffixes.map((suffix) => `${behavior.id}-${suffix}`),
  }));
}

function disabledScope(fields: readonly string[]) {
  return Object.fromEntries([
    ...fields.map((field) => [field, "disabled"] as const),
    ["cli", "exact-preflight-only"],
    ["harnessReady", false],
  ]);
}

function artifact(path: string, value: unknown, format: "canonical" | "pretty"): ProjectionArtifact {
  const bytes = format === "canonical" ? `${canonicalJson(value)}\n` : `${JSON.stringify(value, null, 2)}\n`;
  return deepFreeze({ path, value, bytes, sha256: sha256(bytes), identityHash: canonicalHash(value) });
}

function assertSchemaDialect(schemas: JsonSchemaMap, dialect: string, family: string): void {
  if (Object.keys(schemas).length === 0 || Object.values(schemas).some((schema) => schema.$schema !== dialect)) {
    throw new InputError("Generated schema dialect is inconsistent", `slice_${family}_schema_dialect_invalid`);
  }
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new InputError("Values must be unique", code);
}
