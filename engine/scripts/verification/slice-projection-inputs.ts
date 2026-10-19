import { CAPABILITY_NEGOTIATION_REVISION } from "../../src/runtime/capability-negotiation.ts";
import { getConfigContractArtifact } from "../../src/kernel/config-contracts.ts";
import { CONTRACT_SCHEMA_ARTIFACT_VERSION } from "../../src/kernel/contracts.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { EVENT_STATE_REVISION } from "../../src/runtime/event-state.ts";
import { FORENSIC_CONTRACTS_REVISION, FORENSIC_SCHEMA_ARTIFACT_VERSION } from "../../src/forensics/forensic-contracts.ts";
import { FORENSIC_CRYPTO_REVISION } from "../../src/forensics/forensic-crypto.ts";
import { FORENSIC_NORMALIZATION_REVISION } from "../../src/forensics/forensic-normalization.ts";
import { FORENSIC_PROJECTION_REVISION } from "../../src/forensics/forensic-projection.ts";
import { FORENSIC_STATE_REVISION } from "../../src/forensics/forensic-state.ts";
import { canonicalHash, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../src/kernel/json-integrity.ts";
import { LEDGER_CANONICAL_REVISION } from "../../src/kernel/ledger-canonical.ts";
import { sameOrderedValues } from "../../src/kernel/ordered.ts";
import { PROTOCOL_PROJECTION_REVISION } from "../../src/kernel/protocol-projections.ts";
import {
  GENERATED_REQUIREMENTS_REGISTRY_SCHEMA,
  parseRequirementsRegistryText,
  REQUIREMENTS_REGISTRY_FILE_SHA256,
  REQUIREMENTS_REGISTRY_IDENTITY_HASH,
  REQUIREMENTS_REGISTRY_SCHEMA_HASH,
  REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
  REQUIREMENTS_REGISTRY_SOURCE_PATH,
  REQUIREMENTS_REGISTRY_SOURCE_SHA256,
  REQUIREMENTS_REGISTRY_VALIDATOR_REVISION,
  REQUIREMENTS_SCHEMA_ARTIFACT_VERSION,
  type RequirementsRegistry,
} from "../../src/kernel/requirements.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { SAFE_STRUCTURAL_REVISION } from "../../src/kernel/safe-structural.ts";
import { SCHEMA_SUBSET_REVISION } from "../../src/kernel/schema-subset.ts";
import { createTestInventoryEntry, discoverTestNames, type TestInventoryEntry } from "../test-inventory.ts";
import { strictUtf8Text } from "./candidate-format.ts";
import {
  compareSliceProjectionPaths,
  type SliceProjectionCapturedValues,
} from "./slice-projection-captured-values.ts";
import { parseSliceDeclarationsText, type SliceDeclarations } from "./slice-declarations.ts";
import { parseS2OfficialFragmentManifestText, type S2OfficialFragmentManifest } from "./official-fragment-manifest.ts";
import { SLICE_PROJECTION_PATHS } from "./slice-projection-paths.ts";
import {
  parseS2ResearchManifestText,
  parseS31SourceManifestText,
  S2_RESEARCH_MANIFEST_PATH,
  type S2ResearchManifest,
  type S31SourceManifest,
} from "./slice-source-contracts.ts";

type JsonObject = Readonly<Record<string, unknown>>;

export type RequirementsProjection = Readonly<{
  registry: RequirementsRegistry;
  registryCanonicalHash: string;
  registryPath: typeof SLICE_PROJECTION_PATHS.requirementsRegistry;
  registryFileSha256: string;
  sourceArtifactSha256: string;
  schemaVersion: string;
  generatedSchema: JsonObject;
  schemaHash: string;
  identity: JsonObject;
  identityHash: string;
  schemaArtifactPath: typeof SLICE_PROJECTION_PATHS.requirementsSchemaArtifact;
  schemaArtifactVersion: string;
}>;

export type SliceRootPolicyView = Readonly<{
  configurationDocumentSchemaVersion: number;
  preflightReceiptSchemaVersion: number;
  capabilities: Readonly<Record<string, boolean>>;
  contracts: {
    implementation: string;
    modules: Readonly<{
      capabilityNegotiation: string;
      eventState: string;
      protocolProjection: string;
      schemaSubset: string;
    }>;
    schemaDialect: string;
    protocolIds: readonly [string, string, string];
    schemaArtifactPath: typeof SLICE_PROJECTION_PATHS.contractSchemaArtifact;
    schemaArtifactVersion: string;
  };
  forensics: {
    implementation: string;
    policyHash: string;
    modules: Readonly<{
      canonicalization: string;
      contracts: string;
      crypto: string;
      normalization: string;
      projection: string;
      safeStructural: string;
      state: string;
    }>;
    schemaDialect: string;
    canonicalization: string;
    schemaArtifactPath: typeof SLICE_PROJECTION_PATHS.forensicSchemaArtifact;
    schemaArtifactVersion: string;
  };
  audit: {
    angles: readonly string[];
    stages: readonly string[];
    evidenceAdmissionAvailable: boolean;
    draftSatisfactionAllowed: boolean;
  };
}>;

export type SliceProjectionSourceInputs = Readonly<{
  s2Research: Readonly<{
    path: typeof S2_RESEARCH_MANIFEST_PATH;
    manifest: S2ResearchManifest;
  }>;
  s2Official: Readonly<{
    path: typeof SLICE_PROJECTION_PATHS.s2OfficialManifest;
    manifest: S2OfficialFragmentManifest;
  }>;
  s31: Readonly<{
    path: typeof SLICE_PROJECTION_PATHS.s31SourceManifest;
    manifest: S31SourceManifest;
  }>;
}>;

type MaterializedFile = Readonly<{
  path: string;
  contentBase64: string;
  bytes: Buffer;
  byteLength: number;
  sha256: string;
}>;

export type ResolvedSliceProjectionInputs = Readonly<{
  capturedFileIdentities: readonly Readonly<{ path: string; byteLength: number; sha256: string }>[];
  declarations: SliceDeclarations;
  requirements: RequirementsProjection;
  sourceInputs: SliceProjectionSourceInputs;
  sourceIdentities: Readonly<{
    s2ResearchIdentity: string;
    s2OfficialManifestSha256: string;
    s31ManifestSha256: string;
  }>;
  rootPolicy: SliceRootPolicyView;
  configurationIdentityHash: string;
  testBindings: Readonly<Record<string, TestInventoryEntry>>;
  fixtures: Readonly<Record<string, readonly Readonly<{ path: string; sha256: string }>[]>>;
}>;

export const SLICE_PROJECTION_STATIC_INPUT_PATHS = deepFreeze([
  SLICE_PROJECTION_PATHS.declarations,
  SLICE_PROJECTION_PATHS.requirementsRegistry,
  REQUIREMENTS_REGISTRY_SOURCE_PATH,
  ROOT_POLICY.sourcePath,
  ROOT_POLICY.configuration.contract.sourcePath,
  S2_RESEARCH_MANIFEST_PATH,
  SLICE_PROJECTION_PATHS.s2OfficialManifest,
  SLICE_PROJECTION_PATHS.s31SourceManifest,
].toSorted(compareSliceProjectionPaths));

export function deriveSliceProjectionInputPaths(input: Readonly<{
  declarations: SliceDeclarations;
  sources: SliceProjectionSourceInputs;
  fixturePaths: readonly string[];
}>): readonly string[] {
  assertUnique(input.fixturePaths, "slice_fixture_path_duplicate");
  const paths = new Set<string>([
    ...SLICE_PROJECTION_STATIC_INPUT_PATHS,
    ...input.declarations.slices.map((slice) => slice.testSourceId),
    ...input.fixturePaths,
  ]);
  for (const source of input.sources.s2Official.manifest.sources) {
    paths.add(source.license.path);
    for (const fragment of source.fragments) paths.add(fragment.path);
  }
  const reference = input.sources.s31.manifest.sources[9];
  paths.add(reference.license.localPath);
  for (const fragment of reference.fragments) paths.add(fragment.localPath);
  return deepFreeze([...paths].toSorted(compareSliceProjectionPaths));
}

export function resolveSliceProjectionInputs(
  captured: SliceProjectionCapturedValues,
): ResolvedSliceProjectionInputs {
  const evidence = materializeFiles(captured);
  const declarations = parseCapturedDeclarations(evidence);
  const requirements = buildRequirementsProjection(evidence);
  const sourceInputs = parseCapturedSourceInputs(evidence);
  const rootPolicy = currentSliceRootPolicyView();
  assertCurrentSemanticSourceBytes(evidence);
  const sourceIdentities = buildSourceProjections(sourceInputs, evidence);
  const testBindings = buildTestBindings(declarations, evidence);
  const fixtures = buildS2FixtureProjection(declarations.slices[0], evidence);
  assertEvidenceSurface(sourceInputs, declarations, evidence, fixtures);
  return deepFreeze({
    capturedFileIdentities: [...evidence.values()].map((file) => ({
      path: file.path,
      byteLength: file.byteLength,
      sha256: file.sha256,
    })),
    declarations,
    requirements,
    sourceInputs,
    sourceIdentities,
    rootPolicy,
    configurationIdentityHash: getConfigContractArtifact().identityHash,
    testBindings,
    fixtures,
  });
}

export function currentSliceRootPolicyView(): SliceRootPolicyView {
  const view: SliceRootPolicyView = {
    configurationDocumentSchemaVersion: ROOT_POLICY.configuration.documentSchemaVersion,
    preflightReceiptSchemaVersion: ROOT_POLICY.receipts.preflightSchemaVersion,
    capabilities: ROOT_POLICY.capabilities,
    contracts: {
      implementation: ROOT_POLICY.contracts.implementation,
      modules: {
        capabilityNegotiation: CAPABILITY_NEGOTIATION_REVISION,
        eventState: EVENT_STATE_REVISION,
        protocolProjection: PROTOCOL_PROJECTION_REVISION,
        schemaSubset: SCHEMA_SUBSET_REVISION,
      },
      schemaDialect: ROOT_POLICY.contracts.schemaDialect,
      protocolIds: ROOT_POLICY.contracts.protocolIds,
      schemaArtifactPath: SLICE_PROJECTION_PATHS.contractSchemaArtifact,
      schemaArtifactVersion: CONTRACT_SCHEMA_ARTIFACT_VERSION,
    },
    forensics: {
      implementation: ROOT_POLICY.forensics.implementation,
      policyHash: canonicalHash(ROOT_POLICY.forensics),
      modules: {
        canonicalization: LEDGER_CANONICAL_REVISION,
        contracts: FORENSIC_CONTRACTS_REVISION,
        crypto: FORENSIC_CRYPTO_REVISION,
        normalization: FORENSIC_NORMALIZATION_REVISION,
        projection: FORENSIC_PROJECTION_REVISION,
        safeStructural: SAFE_STRUCTURAL_REVISION,
        state: FORENSIC_STATE_REVISION,
      },
      schemaDialect: ROOT_POLICY.forensics.schemaDialect,
      canonicalization: ROOT_POLICY.forensics.canonicalization,
      schemaArtifactPath: SLICE_PROJECTION_PATHS.forensicSchemaArtifact,
      schemaArtifactVersion: FORENSIC_SCHEMA_ARTIFACT_VERSION,
    },
    audit: {
      angles: ROOT_POLICY.universalPolicyArchitecture.auditMatrix.angles,
      stages: ROOT_POLICY.universalPolicyArchitecture.auditMatrix.stages,
      evidenceAdmissionAvailable: ROOT_POLICY.universalPolicyArchitecture.auditMatrix.evidenceAdmission.available,
      draftSatisfactionAllowed:
        ROOT_POLICY.universalPolicyArchitecture.auditMatrix.evidenceAdmission.draftSatisfactionAllowed,
    },
  };
  const enabled = Object.entries(view.capabilities).filter(([, value]) => value).map(([key]) => key);
  if (!sameOrderedValues(enabled, ["preflight"]) || view.configurationDocumentSchemaVersion !== 3 ||
    view.preflightReceiptSchemaVersion !== 1) {
    throw new InputError("Root policy view is invalid", "slice_root_policy_view_invalid");
  }
  return deepFreeze(view);
}

function materializeFiles(captured: SliceProjectionCapturedValues): ReadonlyMap<string, MaterializedFile> {
  return new Map(captured.files.map((file) => {
    const bytes = Buffer.from(file.contentBase64, "base64");
    return [file.path, Object.freeze({
      ...file,
      bytes,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    })] as const;
  }));
}

function requireCapturedFile(files: ReadonlyMap<string, MaterializedFile>, path: string): MaterializedFile {
  const file = files.get(path);
  if (!file) throw new InputError("Required captured input is missing", `slice_input_missing:${path}`);
  return file;
}

function capturedText(files: ReadonlyMap<string, MaterializedFile>, path: string): string {
  try {
    return strictUtf8Text(requireCapturedFile(files, path).bytes);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("Captured input is not strict UTF-8", `slice_input_utf8_invalid:${path}`);
  }
}

function parseCapturedDeclarations(files: ReadonlyMap<string, MaterializedFile>): SliceDeclarations {
  return parseSliceDeclarationsText(capturedText(files, SLICE_PROJECTION_PATHS.declarations));
}

function parseCapturedSourceInputs(files: ReadonlyMap<string, MaterializedFile>): SliceProjectionSourceInputs {
  return deepFreeze({
    s2Research: {
      path: S2_RESEARCH_MANIFEST_PATH,
      manifest: parseS2ResearchManifestText(capturedText(files, S2_RESEARCH_MANIFEST_PATH)),
    },
    s2Official: {
      path: SLICE_PROJECTION_PATHS.s2OfficialManifest,
      manifest: parseS2OfficialFragmentManifestText(capturedText(files, SLICE_PROJECTION_PATHS.s2OfficialManifest)),
    },
    s31: {
      path: SLICE_PROJECTION_PATHS.s31SourceManifest,
      manifest: parseS31SourceManifestText(capturedText(files, SLICE_PROJECTION_PATHS.s31SourceManifest)),
    },
  });
}

function buildRequirementsProjection(files: ReadonlyMap<string, MaterializedFile>): RequirementsProjection {
  const registryFile = requireCapturedFile(files, SLICE_PROJECTION_PATHS.requirementsRegistry);
  const sourceFile = requireCapturedFile(files, REQUIREMENTS_REGISTRY_SOURCE_PATH);
  const registry = parseRequirementsRegistryText(capturedText(files, SLICE_PROJECTION_PATHS.requirementsRegistry));
  if (registryFile.sha256 !== REQUIREMENTS_REGISTRY_FILE_SHA256 ||
    sourceFile.sha256 !== REQUIREMENTS_REGISTRY_SOURCE_SHA256) {
    throw new InputError("Requirements bytes do not match their canonical owners", "slice_requirements_bytes_stale");
  }
  const schemaHash = canonicalHash(GENERATED_REQUIREMENTS_REGISTRY_SCHEMA);
  const identity = deepFreeze({
    schemaVersion: REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
    validatorRevision: REQUIREMENTS_REGISTRY_VALIDATOR_REVISION,
    registryFile: SLICE_PROJECTION_PATHS.requirementsRegistry,
    registryFileSha256: registryFile.sha256,
    sourceArtifactPath: REQUIREMENTS_REGISTRY_SOURCE_PATH,
    sourceArtifactSha256: sourceFile.sha256,
    rowSetHashes: registry.rowSetIntegrityHistory,
    schemaHash,
  });
  const identityHash = canonicalHash(identity);
  if (schemaHash !== REQUIREMENTS_REGISTRY_SCHEMA_HASH || identityHash !== REQUIREMENTS_REGISTRY_IDENTITY_HASH) {
    throw new InputError("Requirements semantic identity is stale", "slice_requirements_identity_stale");
  }
  return deepFreeze({
    registry,
    registryCanonicalHash: canonicalHash(registry),
    registryPath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    registryFileSha256: registryFile.sha256,
    sourceArtifactSha256: sourceFile.sha256,
    schemaVersion: REQUIREMENTS_REGISTRY_SCHEMA_VERSION,
    generatedSchema: GENERATED_REQUIREMENTS_REGISTRY_SCHEMA,
    schemaHash,
    identity,
    identityHash,
    schemaArtifactPath: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
    schemaArtifactVersion: REQUIREMENTS_SCHEMA_ARTIFACT_VERSION,
  });
}

function assertCurrentSemanticSourceBytes(files: ReadonlyMap<string, MaterializedFile>): void {
  requireCapturedFile(files, ROOT_POLICY.sourcePath);
  const configSource = requireCapturedFile(files, ROOT_POLICY.configuration.contract.sourcePath);
  if (configSource.sha256 !== ROOT_POLICY.configuration.contract.sourceSha256 ||
    canonicalHash(getConfigContractArtifact().identity) !== getConfigContractArtifact().identityHash ||
    getConfigContractArtifact().identity.schemaHash !== getConfigContractArtifact().schemaHash) {
    throw new InputError("Configuration semantic source is stale", "slice_config_source_stale");
  }
}

function buildSourceProjections(
  input: SliceProjectionSourceInputs,
  evidence: ReadonlyMap<string, MaterializedFile>,
) {
  const s2OfficialManifestSha256 = requireCapturedFile(evidence, input.s2Official.path).sha256;
  const s31ManifestSha256 = requireCapturedFile(evidence, input.s31.path).sha256;
  const researchById = new Map(input.s2Research.manifest.sources.map((source) => [source.id, source]));
  for (const source of input.s2Official.manifest.sources) {
    const research = researchById.get(source.id);
    if (!research || research.url !== source.url || research.sha256 !== source.fullSourceSha256 ||
      !research.ref.includes(source.commit)) {
      throw new InputError("S2 source assertions do not reconcile", `slice_s2_source_mismatch:${source.id}`);
    }
    assertEvidenceHash(source.license.path, source.license.sha256, evidence);
    for (const fragment of source.fragments) assertEvidenceHash(fragment.path, fragment.sha256, evidence);
  }
  const reference = input.s31.manifest.sources[9];
  assertEvidenceHash(reference.license.localPath, reference.license.localSha256, evidence);
  for (const fragment of reference.fragments) {
    parseJsonBytes(
      requireCapturedFile(evidence, fragment.localPath),
      `slice_source_json_invalid:${fragment.localPath}`,
      `slice_source_json_key_duplicate:${fragment.localPath}`,
    );
    assertEvidenceHash(fragment.localPath, fragment.localSha256, evidence);
  }
  return deepFreeze({
    s2ResearchIdentity: canonicalHash(input.s2Research.manifest),
    s2OfficialManifestSha256,
    s31ManifestSha256,
  });
}

function buildTestBindings(
  declarations: SliceDeclarations,
  evidence: ReadonlyMap<string, MaterializedFile>,
): Readonly<Record<string, TestInventoryEntry>> {
  const result: Record<string, TestInventoryEntry> = {};
  for (const slice of declarations.slices) {
    const source = evidence.get(slice.testSourceId);
    if (!source) throw new InputError("Bound test source is missing", `slice_test_source_missing:${slice.testSourceId}`);
    let names: readonly string[];
    try {
      names = discoverTestNames(strictUtf8Text(source.bytes));
    } catch {
      throw new InputError("Bound test source cannot be inventoried", `slice_test_source_invalid:${slice.testSourceId}`);
    }
    for (const behavior of slice.behaviors) {
      if (names.filter((name) => name === behavior.testName).length !== 1) {
        throw new InputError("Behavior test binding is not exact", `slice_test_binding_invalid:${behavior.id}`);
      }
      result[behavior.id] = createTestInventoryEntry(slice.testSourceId, source.sha256, behavior.testName);
    }
  }
  return deepFreeze(result);
}

function buildS2FixtureProjection(
  declaration: Readonly<{
    behaviors: readonly Readonly<{ id: string; fixtureNamespace: string }>[];
    acceptance: Readonly<{ minimumDistinctFixturesPerBehavior: number }>;
  }>,
  evidence: ReadonlyMap<string, MaterializedFile>,
): Readonly<Record<string, readonly Readonly<{ path: string; sha256: string }>[]>> {
  const result: Record<string, readonly Readonly<{ path: string; sha256: string }>[]> = {};
  const allFixturePaths = [...evidence.keys()]
    .filter((path) => path.startsWith("test/fixtures/s2/") && path.endsWith(".json"));
  for (const behavior of declaration.behaviors) {
    const prefix = `test/fixtures/s2/${behavior.fixtureNamespace}/`;
    const paths = allFixturePaths.filter((path) => path.startsWith(prefix)).toSorted(compareSliceProjectionPaths);
    if (paths.length < declaration.acceptance.minimumDistinctFixturesPerBehavior) {
      throw new InputError("Fixture namespace is incomplete", `slice_fixture_namespace_incomplete:${behavior.id}`);
    }
    const fixtures = paths.map((path) => {
      const file = evidence.get(path)!;
      const value = parseJsonBytes(file, `slice_fixture_invalid:${path}`, `slice_fixture_key_duplicate:${path}`);
      if (!isPlainObject(value) || Object.keys(value).length === 0) {
        throw new InputError("Fixture is empty", `slice_fixture_invalid:${path}`);
      }
      return { path, sha256: file.sha256 };
    });
    if (new Set(fixtures.map((fixture) => fixture.sha256)).size !== fixtures.length) {
      throw new InputError("Fixture contents are duplicated", `slice_fixture_duplicate:${behavior.id}`);
    }
    result[behavior.id] = fixtures;
  }
  const projected = Object.values(result).flat().map((fixture) => fixture.path)
    .toSorted(compareSliceProjectionPaths);
  if (!sameOrderedValues(projected, allFixturePaths.toSorted(compareSliceProjectionPaths))) {
    throw new InputError("Fixture surface crosses behavior namespaces", "slice_fixture_surface_invalid");
  }
  return deepFreeze(result);
}

function assertEvidenceSurface(
  sources: SliceProjectionSourceInputs,
  declarations: SliceDeclarations,
  evidence: ReadonlyMap<string, MaterializedFile>,
  fixtures: Readonly<Record<string, readonly Readonly<{ path: string }>[]>>,
): void {
  const expected = deriveSliceProjectionInputPaths({
    declarations,
    sources,
    fixturePaths: Object.values(fixtures).flat().map((fixture) => fixture.path),
  });
  if (!sameOrderedValues(expected, [...evidence.keys()].toSorted(compareSliceProjectionPaths))) {
    throw new InputError("Evidence snapshot surface is incomplete or excessive", "slice_evidence_surface_invalid");
  }
}

function assertEvidenceHash(path: string, expected: string, evidence: ReadonlyMap<string, MaterializedFile>): void {
  if (evidence.get(path)?.sha256 !== expected) {
    throw new InputError("Source evidence hash is stale", `slice_source_evidence_stale:${path}`);
  }
}

function parseJsonBytes(file: MaterializedFile, code: string, duplicateCode: string): unknown {
  let text: string;
  try {
    text = strictUtf8Text(file.bytes);
  } catch {
    throw new InputError("Evidence JSON is invalid", code);
  }
  assertNoDuplicateJsonObjectKeys(text, "Evidence JSON contains a duplicate key", duplicateCode);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError("Evidence JSON is invalid", code);
  }
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new InputError("Values must be unique", code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
