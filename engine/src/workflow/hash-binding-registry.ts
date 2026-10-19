import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { resolve } from "node:path";

import { InputError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { REQUIREMENTS_REGISTRY_IDENTITY_HASH, REQUIREMENTS_REGISTRY_SOURCE_PATH } from "../kernel/requirements.ts";
import { FORENSIC_SCHEMA_BUNDLE_HASH } from "../forensics/forensic-contracts.ts";
import { S3_OFFLINE_FORENSIC_HASH } from "../forensics/offline-forensics.ts";
import { DECISION_INDEX, EVIDENCE_IGNORE_BLOCK, GENERATED_BLOCKS, PIN_AUTHORITY_PATHS, README_CONSUMER_BLOCK, SHIPPED_HOOK_FILES, SLICE_PROJECTION_PATHS, VERIFICATION_PATHS } from "../kernel/verification-paths.ts";
import { ownedFiles } from "../git/repository-ownership.ts";

/**
 * Central hash-binding registry — the single source of truth for every
 * SHA-256 literal that binds a source file's bytes (or a stable field inside
 * a source JSON file) to a literal stored in a target file.
 *
 * Detection (`verifyAllBindings`, used by `harness check`) and repair
 * (`repairAllBindings`, used by `harness regenerate`) consume the SAME
 * registry, so they can never disagree about which bindings exist. No
 * function here claims to cover "all bindings" while only covering a subset:
 * the list below is exhaustive and every function iterates it.
 *
 * A binding is either:
 * - `file-sha256`: the expected literal is `sha256(sourcePath)`.
 * - `json-field`: the expected literal is `JSON.parse(sourcePath)[fieldName]`,
 * falling back to `sha256(sourcePath)` when the field is absent (mirrors the
 * historical `computeInventoryBinding` / `computeDispositionBinding` rules
 * for the `inventoryHash` and `integrityHash` fields).
 *
 * The literal is located in the target by:
 * - TypeScript targets: a `findRegex` whose match is exactly the 64-hex hash
 * (anchored with lookbehind/lookahead on unique surrounding context so the
 * match is unique). Repair replaces the matched hash only, preserving all
 * surrounding formatting.
 * - JSON targets: a `jsonPath` parsed from the target. Verify navigates the
 * path; repair does a surgical string replacement of
 * `"leafKey": "currentValue"` -> `"leafKey": "newValue"` so the rest of the
 * file keeps its exact bytes (no reformatting, no key reordering).
 *
 * Every write goes through `atomicWriteFile` (the canonical atomic-write owner).
 */

export const HASH_BINDING_REGISTRY_VERSION = schemaId("hash-binding-registry", 1);

export type HashMode =
  | Readonly<{ kind: "file-sha256" }>
  | Readonly<{ kind: "file-binary-sha256" }>
  /**
   * The SOURCE embeds the very literal the binding writes into the target:
   * the bundle compiles `root-policy.ts`, which holds the bundle's own pin.
   * Hashing the raw bytes would make the pin depend on the pin (no fixed
   * point, or one that depends on which bundle was on disk before), so the
   * digest is `sha256` of the source with that ONE literal — located by the
   * binding's own `findRegex`, exactly once, else a typed refusal — replaced
   * by {@link SELF_PIN_PLACEHOLDER}. The pin is then a pure function of every
   * other byte, so two fresh checkouts of one tree agree on it, and
   * {@link sealSelfPinnedSource} publishes the source carrying its own
   * digest (the exact bytes a rebuild from the re-pinned tree produces).
   */
  | Readonly<{ kind: "self-pinned-sha256" }>
  | Readonly<{ kind: "json-field"; fieldName: string }>
  /**
   * The expected literal is a value a named MODULE computes (not derivable
   * from a file's bytes) — e.g. the requirements registry identity, which
   * changes when the schema-id namespace rotates. `compute` resolves it live.
   * This is the mode for a projection that must track a derived constant, not
   * a file's bytes.
   */
  | Readonly<{ kind: "module-constant"; compute: (root: string) => string }>;

/**
 * Where a binding's SOURCE comes from — and therefore whether the repository
 * is supposed to contain it.
 *
 * WHY THIS FIELD EXISTS, MEASURED. A binding pins bytes, and it compares those
 * bytes only when the file is there. That is correct for what it does and it
 * says nothing about whether the file SHOULD be there. Two of the bindings
 * below name paths that `.gitignore` excludes, and both sit under
 * `selfProtection.mayNotBeDisabled`, so a reader who found that had no way to
 * tell "deliberately a build artifact" from "swallowed by an ignore rule the
 * way `coverage/` swallowed a live component in the web tree". The pin cannot
 * answer the question because the question is not about bytes.
 *
 * So each binding declares it, and the answer is checked in BOTH directions:
 * a `repository-source` that git does not track is a clone that cannot
 * verify itself, and a `build-output` that git DOES track is a second answer
 * to a question `src/` already answers, which will go stale on the first
 * branch that edits the source.
 *
 * The field is REQUIRED, so a binding added tomorrow cannot skip the question
 * — that is the difference between this and a list of the two known paths,
 * which would have to be remembered.
 */
export type HashBindingSourceOrigin =
  /** Committed to the repository; a clone must contain these bytes. */
  | Readonly<{ kind: "repository-source" }>
  /**
   * Produced by a build, deliberately not committed. `producedBy` is the
   * command that creates it, so absence is a state with a way out rather than
   * a bare error — the consumer can NAME the action instead of describing the
   * lookup that failed.
   */
  | Readonly<{ kind: "build-output"; producedBy: string }>;

export type HashBinding = Readonly<{
  id: string;
  description: string;
  sourcePath: string;
  sourceOrigin: HashBindingSourceOrigin;
  targetPath: string;
  targetKind: "typescript" | "json";
  hashMode: HashMode;
  findRegex?: string;
  jsonPath?: readonly string[];
}>;

export type BindingVerifyResult = Readonly<{
  id: string;
  matches: boolean;
  expected: string;
  actual: string;
  sourcePath: string;
  targetPath: string;
  error?: string;
}>;

export type BindingRepairResult = Readonly<{
  id: string;
  repaired: boolean;
  previousHash: string;
  newHash: string;
  targetPath: string;
  error?: string;
}>;

export type BindingRegistryReport = Readonly<{
  schemaVersion: typeof HASH_BINDING_REGISTRY_VERSION;
  root: string;
  totalBindings: number;
  matched: number;
  mismatched: number;
  errors: number;
  results: readonly BindingVerifyResult[];
  allMatch: boolean;
  generatedAt: string;
  integrityHash: string;
}>;

export type BindingRepairReport = Readonly<{
  schemaVersion: typeof HASH_BINDING_REGISTRY_VERSION;
  root: string;
  totalBindings: number;
  repairedCount: number;
  alreadyMatchedCount: number;
  errorCount: number;
  results: readonly BindingRepairResult[];
  allMatch: boolean;
  generatedAt: string;
  integrityHash: string;
}>;

const SHA256_HEX = "[0-9a-f]{64}";

const REGEX_META = /[.*+?^${}()|[\]\\]/gu;

function escapeForRegex(literal: string): string {
  return literal.replace(REGEX_META, "\\$&");
}

const HASH_BINDINGS: readonly HashBinding[] = deepFreeze([
  {
    id: "root-policy-config-contracts-source-sha256",
    description: "src/config-contracts.ts bytes -> root-policy.ts configuration.contract.sourceSha256",
    sourcePath: ROOT_POLICY.configuration.contract.sourcePath,
    sourceOrigin: { kind: "repository-source" },
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=sourcePath: "${escapeForRegex(ROOT_POLICY.configuration.contract.sourcePath)}",\s*sourceSha256: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-directory-worker-source-sha256",
    description: "src/filesystem/private-directory-create-worker.mjs bytes -> root-policy.ts directoryWorker.sourceSha256",
    sourcePath: ROOT_POLICY.filesystemInfrastructure.privateState.directoryWorker.sourcePath,
    sourceOrigin: { kind: "repository-source" },
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=sourcePath: "src/filesystem/private-directory-create-worker\.mjs",\s*sourceSha256: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-test-inventory-hash",
    description: "test inventory file inventoryHash field -> root-policy.ts verification.testInventoryHash",
    sourcePath: VERIFICATION_PATHS.testInventory,
    sourceOrigin: { kind: "repository-source" },
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "json-field", fieldName: "inventoryHash" },
    findRegex: String.raw`(?<=testInventorySchema: "bridlewise-test-inventory/v4",\s*testInventoryHash: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-disposition-file-sha256",
    description: "traceability/test-surface-dispositions.json bytes -> root-policy.ts testSurfaceDispositionBinding.fileSha256",
    sourcePath: ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath,
    sourceOrigin: { kind: "repository-source" },
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=testSurfaceDispositionBinding:\s*\{\s*fileSha256: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-disposition-identity-hash",
    description: "traceability/test-surface-dispositions.json integrityHash field -> root-policy.ts testSurfaceDispositionBinding.identityHash",
    sourcePath: ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath,
    sourceOrigin: { kind: "repository-source" },
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "json-field", fieldName: "integrityHash" },
    findRegex: String.raw`(?<=testSurfaceDispositionBinding:\s*\{\s*fileSha256:\s*"${SHA256_HEX}",\s*identityHash: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> requirements.ts REQUIREMENTS_REGISTRY_FILE_SHA256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: "src/kernel/requirements.ts",
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=export const REQUIREMENTS_REGISTRY_FILE_SHA256\s*=\s*")${SHA256_HEX}(?=")`,
  },
  {
    id: "requirements-registry-source-sha256",
    description: "traceability/canonical/harness-requirements.md bytes -> requirements.ts REQUIREMENTS_REGISTRY_SOURCE_SHA256",
    sourcePath: REQUIREMENTS_REGISTRY_SOURCE_PATH,
    sourceOrigin: { kind: "repository-source" },
    targetPath: "src/kernel/requirements.ts",
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=export const REQUIREMENTS_REGISTRY_SOURCE_SHA256\s*=\s*")${SHA256_HEX}(?=")`,
  },
  {
    id: "s1-trace-requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> traceability/s1.json requirementsRegistry.fileSha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: "traceability/s1.json",
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "fileSha256"],
  },
  {
    id: "s1-trace-requirements-registry-identity-hash",
    description: "requirements registry identity -> traceability/s1.json requirementsRegistry.identityHash",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: "traceability/s1.json",
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => REQUIREMENTS_REGISTRY_IDENTITY_HASH },
    jsonPath: ["requirementsRegistry", "identityHash"],
  },
  {
    id: "s2-trace-requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> traceability/s2.json requirementsRegistry.fileSha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s2Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "fileSha256"],
  },
  {
    id: "s2-4-trace-requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> traceability/s2.4.json requirementsRegistry.fileSha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s24Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "fileSha256"],
  },
  {
    id: "s3-1-trace-requirements-registry-file-sha256",
    description: "traceability/requirements.json bytes -> traceability/s3.1.json requirementsRegistry.fileSha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s31Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "fileSha256"],
  },
  // The slice trace files pin the requirements registry's IDENTITY (a derived
  // module constant — it rotates when the schema-id namespace rotates, e.g. on
  // a product rename). The expected value is computed live from the registry
  // owner, never read from a file's bytes, so a rename re-derives it through
  // `harness regenerate`/`sync` instead of needing a hand-edit.
  {
    id: "s2-trace-requirements-registry-identity-hash",
    description: "requirements registry identity -> traceability/s2.json requirementsRegistry.identityHash",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s2Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => REQUIREMENTS_REGISTRY_IDENTITY_HASH },
    jsonPath: ["requirementsRegistry", "identityHash"],
  },
  {
    id: "s2-4-trace-requirements-registry-identity-hash",
    description: "requirements registry identity -> traceability/s2.4.json requirementsRegistry.identityHash",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s24Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => REQUIREMENTS_REGISTRY_IDENTITY_HASH },
    jsonPath: ["requirementsRegistry", "identityHash"],
  },
  {
    id: "s3-1-trace-requirements-registry-identity-hash",
    description: "requirements registry identity -> traceability/s3.1.json requirementsRegistry.identityHash",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsRegistry,
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s31Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => REQUIREMENTS_REGISTRY_IDENTITY_HASH },
    jsonPath: ["requirementsRegistry", "identityHash"],
  },
  // The S3.1 trace's CONTRACT identities are derived module constants too:
  // the offline forensic identity hashes the whole `ROOT_POLICY.forensics`
  // section, so a new forensic domain moved it and nothing regenerated the
  // trace (FIX-1: the S1-B08 scenario was the only witness). Computed live
  // from their owners, so `harness sync` re-derives them and `harness check`
  // reports their drift.
  {
    id: "s3-1-trace-offline-forensic-hash",
    description: "offline forensic identity -> traceability/s3.1.json contracts.offlineForensicHash",
    sourcePath: "src/forensics/offline-forensics.ts",
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s31Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => S3_OFFLINE_FORENSIC_HASH },
    jsonPath: ["contracts", "offlineForensicHash"],
  },
  {
    id: "s3-1-trace-forensic-schema-bundle-hash",
    description: "generated forensic schema bundle -> traceability/s3.1.json contracts.schemaBundleHash",
    sourcePath: "src/forensics/forensic-contracts.ts",
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s31Trace,
    targetKind: "json",
    hashMode: { kind: "module-constant", compute: () => FORENSIC_SCHEMA_BUNDLE_HASH },
    jsonPath: ["contracts", "schemaBundleHash"],
  },
  {
    id: "s2-4-trace-requirements-source-artifact-sha256",
    description: "traceability/canonical/harness-requirements.md bytes -> traceability/s2.4.json requirementsRegistry.sourceArtifactSha256",
    sourcePath: REQUIREMENTS_REGISTRY_SOURCE_PATH,
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s24Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "sourceArtifactSha256"],
  },
  {
    id: "s2-4-trace-requirements-schema-artifact-sha256",
    description: "traceability/s2.4-requirements-schema.json bytes -> traceability/s2.4.json requirementsRegistry.schemaArtifact.sha256",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
    sourceOrigin: { kind: "repository-source" },
    targetPath: SLICE_PROJECTION_PATHS.s24Trace,
    targetKind: "json",
    hashMode: { kind: "file-sha256" },
    jsonPath: ["requirementsRegistry", "schemaArtifact", "sha256"],
  },
  {
    id: "slice-traces-requirements-schema-artifact-sha256",
    description: "traceability/s2.4-requirements-schema.json bytes -> scripts/verification/slice-traces.ts schemaArtifact z.literal",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
    sourceOrigin: { kind: "repository-source" },
    targetPath: "scripts/tooling/verification/slice-traces.ts",
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=schemaArtifact:\s*z\.strictObject\(\{\s*path:\s*z\.literal\(SLICE_PROJECTION_PATHS\.requirementsSchemaArtifact\),\s*sha256:\s*z\.literal\(")${SHA256_HEX}(?="\),)`,
  },
  {
    id: "s1-verification-requirements-schema-artifact-sha256",
    description: "traceability/s2.4-requirements-schema.json bytes -> scripts/s1-verification.ts sha256(schemaBytes) literal",
    sourcePath: SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
    sourceOrigin: { kind: "repository-source" },
    targetPath: "scripts/tooling/s1-verification.ts",
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=sha256\(schemaBytes\)\s*!==\s*")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-self-protection-guardian-binary-sha256",
    description: "guardian/build/harness-landlock-guardian bytes -> root-policy.ts selfProtection.binarySha256",
    sourcePath: ROOT_POLICY.selfProtection.binaryRelativePath,
    sourceOrigin: { kind: "build-output", producedBy: "node guardian/build.ts" },
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-binary-sha256" },
    findRegex: String.raw`(?<=binarySha256: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-self-protection-bundle-sha256",
    description: "dist/bundle.js bytes, its own embedded pin normalised out -> root-policy.ts selfProtection.bundleSha256 (run `node src/cli.ts harness sync --with-bundle` after any src/ change — builds the bundle, re-pins, and verifies in one pass)",
    sourcePath: ROOT_POLICY.selfProtection.bundleRelativePath,
    sourceOrigin: { kind: "build-output", producedBy: "node scripts/build-bundle.ts" },
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "self-pinned-sha256" },
    findRegex: String.raw`(?<=bundleSha256: ")${SHA256_HEX}(?=")`,
  },
  {
    id: "root-policy-self-protection-spec-schema-artifact-sha256",
    description: "traceability/self-protection/guardian-spec-schema.json bytes -> root-policy.ts selfProtection.specSchemaArtifactSha256",
    sourcePath: ROOT_POLICY.selfProtection.specSchemaArtifactPath,
    sourceOrigin: { kind: "repository-source" },
    targetPath: ROOT_POLICY.sourcePath,
    targetKind: "typescript",
    hashMode: { kind: "file-sha256" },
    findRegex: String.raw`(?<=specSchemaArtifactSha256: ")${SHA256_HEX}(?=")`,
  },
]);

export function listAllBindings(): readonly HashBinding[] {
  return HASH_BINDINGS;
}

/**
 * EVERY FILE THE SUITE REGENERATES — the binding targets this registry owns
 * plus the wholesale-artifact owners (the test inventory, the disposition
 * manifest, the config schema artifact). Repo-relative from the repository
 * root, because both consumers compare paths as the repository reports them:
 * the testing floor's judgements walk git-reported paths, and the measured
 * surface's file walk declares its paths from the repository root (the
 * `engine/` prefix is the same monorepo-shape assumption that module's
 * measured-path declaration already makes).
 *
 * Its consumers ask this one question through this one derivation, so they
 * can never disagree about which files are regenerated:
 *
 *   - the measured-surface derivation (`tree-identity.ts`), which hashes
 *     a regenerated file with its pin literals normalized away, so a
 *     convergence pin restatement is not a content change of the surface a
 *     profile report binds to;
 *   - every generated-output question (`generatedOutputPaths` below): the
 *     promotion's projection, which judges a regenerated file of the target
 *     pins-normalized (a regeneration is never a target edit) and lets the
 *     candidate re-derive it; the workspace merge's generation-only rule; the
 *     commit guard and the candidate tooling.
 *
 * A binding added tomorrow joins the set with no edit to any consumer — a
 * regenerated file added outside this derivation is a freshness regression
 * waiting to recur, which is the rot a hand-maintained list is.
 */
export function suiteRegeneratedPaths(): ReadonlySet<string> {
  return new Set([
    ...listAllBindings().map((binding) => `engine/${binding.targetPath}`),
    GENERATED_TEST_INVENTORY,
    `engine/${ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath}`,
    GENERATED_CONFIG_SCHEMA_ARTIFACT,
  ]);
}

/** The test inventory, repository-relative: regenerated wholesale from the test files (and pin-bearing). */
const GENERATED_TEST_INVENTORY = `engine/${VERIFICATION_PATHS.testInventory}`;
/** The architecture manifest, repository-relative: the registrar rewrites it wholesale; it carries no pin. */
const GENERATED_ARCHITECTURE_MANIFEST = `engine/${ROOT_POLICY.universalPolicyArchitecture.moduleArchitecture.manifest}`;
/** The config-contract schema artifact, repository-relative: one canonical-JSON blob of the contract. */
const GENERATED_CONFIG_SCHEMA_ARTIFACT = `engine/${ROOT_POLICY.configuration.contract.generatedSchemaPath}`;
/** The guardian spec schema artifact, repository-relative: written by the bundle build from the spec schema. */
const GENERATED_SPEC_SCHEMA_ARTIFACT = `engine/${ROOT_POLICY.selfProtection.specSchemaArtifactPath}`;

/**
 * THE WHOLLY GENERATED OUTPUTS, repository-relative: the subset of
 * {@link generatedOutputPaths} that holds nothing but a generator's output of
 * the tree — no authored byte. Everything else a sync pass writes is AUTHORED
 * with a generated part (a pin literal in a hand-written module, a README's
 * consumer block, the disposition manifest's hand-decided dispositions,
 * a ratchet baseline's reasons), so its authored part must survive a merge.
 *
 * Consumers: `harness workspace` — such a path is never leasable (two
 * workspaces would fork the generated authority) and a merge conflict on it
 * is resolved to the target's side and re-derived by the regenerate phase
 * (the merged tree's own sources decide its bytes).
 */
export function wholesaleGeneratedPaths(): ReadonlySet<string> {
  return new Set([GENERATED_TEST_INVENTORY, GENERATED_ARCHITECTURE_MANIFEST, GENERATED_CONFIG_SCHEMA_ARTIFACT, GENERATED_SPEC_SCHEMA_ARTIFACT, ...SHIPPED_HOOK_PATHS]);
}

/** The shipped hooks (repository-relative), each written whole by its generator (`SHIPPED_HOOK_FILES.generator`). */
const SHIPPED_HOOK_PATHS: readonly string[] = Object.freeze([...SHIPPED_HOOK_FILES.guarded, SHIPPED_HOOK_FILES.trigger].map((hook) => `${SHIPPED_HOOK_FILES.directory}/${hook}`));

/**
 * EVERY PATH A REGENERATE/SYNC PASS MAY WRITE, repository-relative — the one
 * list of generated outputs. It is {@link suiteRegeneratedPaths} (the
 * pin-bearing targets and the wholesale inventory, dispositions and schema
 * artifact) plus the architecture manifest, which the registrar rewrites
 * wholesale and which carries no pin, the guardian spec schema artifact the
 * bundle build writes, the ratchet baselines the pass prunes, the
 * source-authority pins it re-derives (`PIN_AUTHORITY_PATHS`), and the READMEs
 * of `repositoryRoot` whose consumer block the pass regenerates
 * ({@link generatedReadmePaths}). Consumers: the commit guard (a commit
 * whose generated outputs are not staged is refused), the working-copy and
 * candidate tooling, and the generator-door tests.
 */
export function generatedOutputPaths(repositoryRoot: string): ReadonlySet<string> {
  return generatedOutputPathsOfReadmes(generatedReadmePaths(repositoryRoot));
}

/**
 * {@link generatedOutputPaths} of a tree that is not a work tree on disk (a
 * commit: the promotion projection), given its paths and its texts.
 */
export function generatedOutputPathsOf(paths: readonly string[], readText: (path: string) => string | null): ReadonlySet<string> {
  return generatedOutputPathsOfReadmes(generatedReadmePathsOf(paths, readText));
}

function generatedOutputPathsOfReadmes(readmes: readonly string[]): ReadonlySet<string> {
  return new Set([
    ...readmes,
    ...suiteRegeneratedPaths(),
    GENERATED_ARCHITECTURE_MANIFEST,
    // Written by the bundle build (`scripts/build-bundle.ts`, run by
    // `harness sync --with-bundle` and the checkout setup) from the guardian
    // spec schema: a generated output like the others, so a candidate's
    // regenerated copy is its own, never a source edit.
    GENERATED_SPEC_SCHEMA_ARTIFACT,
    // The ratchet baselines a regenerate pass prunes against their guards'
    // scans (`scripts/verification/ratchet-baselines.ts`; already
    // repository-relative).
    ...Object.values(ROOT_POLICY.verification.ratchetBaselines),
    // The decision index a regenerate pass rebuilds from the decision files
    // (`DECISION_INDEX.generator`).
    DECISION_INDEX.path,
    // The root ignore file's evidence block, which a sync pass rewrites from the
    // evidence manifests (`EVIDENCE_IGNORE_BLOCK.generator`).
    EVIDENCE_IGNORE_BLOCK.path,
    // The shipped hooks a regenerate pass writes whole from their owners
    // (`SHIPPED_HOOK_FILES.generator`).
    ...SHIPPED_HOOK_PATHS,
    // The source-authority pins a regenerate pass re-derives
    // (`scripts/pin-authority-regeneration.ts`) and the projection beside one.
    ...Object.values(PIN_AUTHORITY_PATHS).map((path) => `engine/${path}`),
  ]);
}

/**
 * The READMEs of `repositoryRoot` (repository-relative) whose generated
 * consumer block (`README_CONSUMER_BLOCK`) a sync pass regenerates: every
 * owned README.md carrying the begin marker. Before, the blocks were
 * regenerated by hand and outside the candidate's copy-back set, so every
 * writer ran the generator in the live tree (WF-DEL leftover). Empty outside
 * a work tree.
 */
export function generatedReadmePaths(repositoryRoot: string): readonly string[] {
  return generatedReadmePathsOf(ownedFiles(repositoryRoot) ?? [], (path) => {
    const absolute = resolve(repositoryRoot, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  });
}

/** The READMEs among `paths` whose text (`readText`) carries the generated consumer block. */
function generatedReadmePathsOf(paths: readonly string[], readText: (path: string) => string | null): readonly string[] {
  return paths.filter((path) => (path === "README.md" || path.endsWith("/README.md")) && (readText(path)?.includes(README_CONSUMER_BLOCK.begin) ?? false));
}

/**
 * The ignored build outputs the registry PINS (its `build-output` bindings,
 * e.g. the bundle and the guardian binary), repository-relative. A copy of the
 * repository that carries the pins but not these answers a different question;
 * the test working copies and the candidate checkout's copy-back carry both.
 */
export function pinnedBuildOutputPaths(): readonly string[] {
  return listAllBindings()
    .filter((binding) => binding.sourceOrigin.kind === "build-output")
    .map((binding) => `engine/${binding.sourcePath}`);
}

/**
 * The regenerated-pin literal's shape, global-matched for normalization: every
 * 64-hex literal in a suite-regenerated file is a pin the suite re-derives
 * from the tree, so comparing (or hashing) such a file with the pin literals
 * intact judges the re-derivation as a content change. The anchored
 * whole-string validation of the same digest shape is owned by the integrity
 * module; this is the find-all variant the normalizer needs.
 */
const REGENERATED_PIN_SHAPE = /[0-9a-f]{64}/g;

/**
 * Replace every 64-hex pin literal with a stable marker, so two blobs (or two
 * versions of one blob) that differ only in their regenerated pins compare
 * equal. Scoped by the CALLER to files in `suiteRegeneratedPaths()` — a pin
 * literal in any other file is an authored value, and normalizing it would
 * blind every comparison that consumes this normalization.
 */
export function stripRegeneratedPins(text: string): string {
  return text.replace(REGENERATED_PIN_SHAPE, "<regenerated-pin>");
}

/** The text with the body of every `begin`…`end` block blanked (the markers stay; an unterminated block is left as it is). */
function blankBlocks(text: string, begin: string, end: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const opened = text.indexOf(begin, from);
    const closed = opened < 0 ? -1 : text.indexOf(end, opened + begin.length);
    if (closed < 0) return out + text.slice(from);
    out += `${text.slice(from, opened + begin.length)}<generated-block>`;
    from = closed;
  }
}

/**
 * A generated output's text with its GENERATED parts blanked: the pin
 * literals of a pin-bearing file ({@link suiteRegeneratedPaths}, the
 * source-authority pins) and the body of every generated block
 * (`GENERATED_BLOCKS`: a README's consumer block, the decision index). What
 * is left is the file's AUTHORED part.
 */
function stripGeneratedParts(path: string, text: string): string {
  const pinBearing = suiteRegeneratedPaths().has(path) || Object.values(PIN_AUTHORITY_PATHS).some((pinned) => `engine/${pinned}` === path);
  return GENERATED_BLOCKS.reduce((current, block) => blankBlocks(current, block.begin, block.end), pinBearing ? stripRegeneratedPins(text) : text);
}

/**
 * THE ONE ANSWER to "is this change of a generated output REGENERATION
 * ONLY?" (`path` ∈ {@link generatedOutputPaths}; `before`/`after` its texts,
 * null where the tree has none): a wholly generated output always is
 * ({@link wholesaleGeneratedPaths}); any other is only when its authored
 * part ({@link stripGeneratedParts}) is unchanged — an added, deleted or
 * hand-edited file is an authored change. Consumers: `harness workspace`'s
 * lease exemption (the write-set proof, the merge precheck, the merged-since
 * and pending-lease checks) and its conflict resolution, so a hand edit of a
 * file that also carries a pin or a generated block is leased like any
 * source.
 */
export function isGenerationOnlyChange(path: string, before: string | null, after: string | null): boolean {
  if (wholesaleGeneratedPaths().has(path)) return true;
  return before !== null && after !== null && stripGeneratedParts(path, before) === stripGeneratedParts(path, after);
}

/**
 * ABSENCE IS A GUIDED STATE, AND `sourceOrigin` IS WHAT MAKES IT ONE.
 *
 * The field's own doc promised that `producedBy` exists "so absence is a state
 * with a way out rather than a bare error — the consumer can NAME the action
 * instead of describing the lookup that failed". Measured in a fresh clone
 * that legitimately lacks the build outputs, the consumer said:
 *
 *     hash binding source file not found: dist/bundle.js
 *
 * A bare error. `producedBy` was required at compile time, carried in every
 * binding, and read by NOTHING outside one test file — computed, recorded,
 * gated on by nothing, which is the exact shape this sequence exists to
 * eliminate.
 *
 * So the two origins now produce two different messages, because they are two
 * different situations with two different ways out. A build output is missing
 * because it has not been built, and the command that builds it is declared
 * right here. A repository source is missing because the working tree is
 * incomplete, which is not something the reader can fix by running a build.
 */
function missingSourceMessage(binding: HashBinding): string {
  if (binding.sourceOrigin.kind === "build-output") {
    return `${binding.sourcePath} has not been built yet, so the hash binding "${binding.id}" has ` +
      `nothing to pin. It is a build output and is deliberately not committed. Produce it with: ` +
      `${binding.sourceOrigin.producedBy}`;
  }
  return `${binding.sourcePath} is missing from the working tree, so the hash binding ` +
    `"${binding.id}" has nothing to pin. It is a committed repository source, not a build output, ` +
    `so no build produces it — restore it from version control.`;
}

export function computeBindingHash(root: string, binding: HashBinding): string {
  // A module-constant binding's expected value is computed by the owning
  // module, not derived from a file's bytes — resolve it live before any file
  // read (the sourcePath still anchors where the value CONCEPTUALLY comes from
  // and is verified to exist below for the repository-source origin).
  if (binding.hashMode.kind === "module-constant") {
    return binding.hashMode.compute(root);
  }
  const sourceAbsolutePath = resolve(root, binding.sourcePath);
  if (!existsSync(sourceAbsolutePath)) {
    throw new InputError(missingSourceMessage(binding), "input_error");
  }
  if (binding.hashMode.kind === "file-binary-sha256") {
    // Binary files (e.g. the guardian executable) MUST be hashed as raw bytes;
    // reading them as UTF-8 text corrupts non-ASCII bytes and yields a
    // different digest than the bytes on disk. This mode reads a Buffer.
    const sourceBytes = readFileSync(sourceAbsolutePath);
    return sha256(sourceBytes);
  }
  const sourceText = readFileSync(sourceAbsolutePath, "utf8");
  if (binding.hashMode.kind === "file-sha256") {
    return sha256(sourceText);
  }
  if (binding.hashMode.kind === "self-pinned-sha256") {
    return selfPinDigest(binding, sourceText);
  }
  const fieldName = binding.hashMode.fieldName;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    throw new InputError(`hash binding source is not valid JSON: ${binding.sourcePath}`, "input_error");
  }
  const fieldValue = readJsonPath(parsed, [fieldName]);
  return typeof fieldValue === "string" && /^[0-9a-f]{64}$/u.test(fieldValue) ? fieldValue : sha256(sourceText);
}

export function verifyBinding(root: string, binding: HashBinding): BindingVerifyResult {
  const base = {
    id: binding.id,
    sourcePath: binding.sourcePath,
    targetPath: binding.targetPath,
  };
  let expected: string;
  try {
    expected = computeBindingHash(root, binding);
  } catch (error) {
    return deepFreeze({ ...base, matches: false, expected: "", actual: "", error: errorMessage(error) });
  }
  let actual: string;
  try {
    actual = readCurrentLiteral(root, binding);
  } catch (error) {
    return deepFreeze({ ...base, matches: false, expected, actual: "", error: errorMessage(error) });
  }
  return deepFreeze({ ...base, matches: expected === actual, expected, actual });
}

/**
 * The bindings APPLICABLE to this tree. A binding pins a hash into a target
 * file; a tree that does not carry that target file (a product-only tree that
 * ships no verification-runner scripts) has nothing for the binding to
 * verify — its absence is the tree's shape, not drift. Filtering at this ONE
 * choke point (rather than in each verify/repair) means every consumer judges
 * the same applicable set. A binding whose target IS present is always
 * judged, so the filter can never mask real drift on a tree that carries the
 * file.
 */
function applicableBindings(root: string): readonly HashBinding[] {
  return [...HASH_BINDINGS, ...fixtureDigestBindings(root)].filter((binding) => existsSync(resolve(root, binding.targetPath)));
}

/**
 * THE S2 BEHAVIOUR FIXTURE DIGESTS ARE BINDINGS TOO — derived, not listed.
 *
 * `traceability/s2.json` pins every behaviour fixture by `sha256`
 * (`behaviors[i].fixtures[j]`), and the slice verifier refuses a fixture whose
 * bytes disagree (`s2-fixture-hash-mismatch`). No generator owned those pins,
 * so an edited fixture could only be re-pinned by hand — and twenty were left
 * stale when the Responses fixtures were rewritten. Each entry the trace
 * declares becomes a `file-sha256` binding from the fixture's bytes to its
 * own `sha256` field, so `harness sync` re-pins it and `harness check`
 * (hash-bindings) reports it. Derived from the trace on every call: a fixture
 * added to the trace is bound the moment it is declared.
 *
 * A tree that does not carry the test surface at all (`test/`) binds none:
 * the product tree a promotion builds ships the trace but never the test
 * surface, so its pins there describe fixtures that live on the development
 * branch. In a tree that carries the test surface, a declared fixture that is
 * missing stays an error, as any absent source is — the fixtures' folder
 * deleted wholesale included (`harness check`, the commit guard's facts leg,
 * still refuses it; keyed on the folder itself it went silent: PROMO-2 N6).
 */
export function fixtureDigestBindings(root: string): readonly HashBinding[] {
  const tracePath = resolve(root, SLICE_PROJECTION_PATHS.s2Trace);
  if (!existsSync(tracePath) || !existsSync(resolve(root, SLICE_PROJECTION_PATHS.testSurface))) return [];
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as { behaviors?: unknown };
  if (!Array.isArray(trace.behaviors)) return [];
  const bindings: HashBinding[] = [];
  trace.behaviors.forEach((behavior: unknown, behaviorIndex) => {
    const fixtures = (behavior as { fixtures?: unknown } | null)?.fixtures;
    if (!Array.isArray(fixtures)) return;
    fixtures.forEach((fixture: unknown, fixtureIndex) => {
      const path = (fixture as { path?: unknown } | null)?.path;
      if (typeof path !== "string") return;
      bindings.push({
        id: `s2-fixture-digest:${path}`,
        description: `${path} bytes -> ${SLICE_PROJECTION_PATHS.s2Trace} behaviors[${behaviorIndex}].fixtures[${fixtureIndex}].sha256`,
        sourcePath: path,
        sourceOrigin: { kind: "repository-source" },
        targetPath: SLICE_PROJECTION_PATHS.s2Trace,
        targetKind: "json",
        hashMode: { kind: "file-sha256" },
        jsonPath: ["behaviors", String(behaviorIndex), "fixtures", String(fixtureIndex), "sha256"],
      });
    });
  });
  return bindings;
}

export function verifyAllBindings(root: string): BindingRegistryReport {
  const results = applicableBindings(root).map((binding) => verifyBinding(root, binding));
  return buildRegistryReport(root, results);
}

/**
 * Verify a single binding by its registry id. This is the file-truthful way
 * to read the CURRENT on-disk literal for a binding: `result.actual` always
 * comes from the target file's current bytes, never from a static in-process
 * import that may be stale after a write in the same process.
 */
export function verifyBindingById(root: string, id: string): BindingVerifyResult {
  const binding = HASH_BINDINGS.find((entry) => entry.id === id);
  if (binding === undefined) {
    throw new InputError(`unknown hash binding id: ${id}`, "input_error");
  }
  return verifyBinding(root, binding);
}

export function repairBinding(root: string, binding: HashBinding): BindingRepairResult {
  const base = { id: binding.id, targetPath: binding.targetPath };
  let newHash: string;
  try {
    newHash = computeBindingHash(root, binding);
  } catch (error) {
    return deepFreeze({ ...base, repaired: false, previousHash: "", newHash: "", error: errorMessage(error) });
  }
  const targetAbsolutePath = resolve(root, binding.targetPath);
  if (!existsSync(targetAbsolutePath)) {
    return deepFreeze({ ...base, repaired: false, previousHash: "", newHash: "", error: "target file not found" });
  }
  let content = readFileSync(targetAbsolutePath, "utf8");
  let previousHash: string;
  try {
    previousHash = readCurrentLiteralFromContent(binding, content);
  } catch (error) {
    return deepFreeze({ ...base, repaired: false, previousHash: "", newHash, error: errorMessage(error) });
  }
  if (previousHash === newHash) {
    return deepFreeze({ ...base, repaired: false, previousHash, newHash });
  }
  try {
    content = replaceCurrentLiteral(binding, content, previousHash, newHash);
  } catch (error) {
    return deepFreeze({ ...base, repaired: false, previousHash, newHash, error: errorMessage(error) });
  }
  const writeResult = atomicWriteFile(targetAbsolutePath, content);
  if (!writeResult.success) {
    return deepFreeze({ ...base, repaired: false, previousHash, newHash, error: writeResult.reason ?? "atomic write failed" });
  }
  return deepFreeze({ ...base, repaired: true, previousHash, newHash });
}

export function repairAllBindings(
  root: string,
  options: Readonly<{ write?: boolean }> = {},
): BindingRepairReport {
  const write = options.write ?? true;
  const results = applicableBindings(root).map((binding) => {
    if (!write) {
      return verifyBasedRepairResult(root, binding);
    }
    return repairBinding(root, binding);
  });
  return buildRepairReport(root, results);
}

function verifyBasedRepairResult(root: string, binding: HashBinding): BindingRepairResult {
  const verify = verifyBinding(root, binding);
  return deepFreeze({
    id: binding.id,
    targetPath: binding.targetPath,
    repaired: false,
    previousHash: verify.actual,
    newHash: verify.expected,
    ...(verify.error !== undefined ? { error: verify.error } : {}),
  });
}

function readCurrentLiteral(root: string, binding: HashBinding): string {
  const targetAbsolutePath = resolve(root, binding.targetPath);
  if (!existsSync(targetAbsolutePath)) {
    throw new InputError(`hash binding target file not found: ${binding.targetPath}`, "input_error");
  }
  const content = readFileSync(targetAbsolutePath, "utf8");
  return readCurrentLiteralFromContent(binding, content);
}

function readCurrentLiteralFromContent(binding: HashBinding, content: string): string {
  if (binding.targetKind === "typescript") {
    return readTypescriptLiteral(binding, content);
  }
  return readJsonLiteral(binding, content);
}

function readTypescriptLiteral(binding: HashBinding, content: string): string {
  return uniqueLiteralMatch(binding, content, binding.targetPath).text;
}

/**
 * The ONE locator of a binding's literal: its `findRegex`, matched exactly
 * once in `content` (the target's text, or — for a self-pinned binding — the
 * source's). Zero or several matches are a typed refusal naming `where`,
 * never a guess: a decoy spelled like the pin makes the text ambiguous, it
 * never acquires the pin's exemption.
 */
function uniqueLiteralMatch(binding: HashBinding, content: string, where: string): Readonly<{ index: number; text: string }> {
  const pattern = binding.findRegex;
  if (pattern === undefined) {
    throw new InputError(`typescript binding ${binding.id} has no findRegex`, "input_error");
  }
  const matches = [...content.matchAll(new RegExp(pattern, "gu"))];
  if (matches.length === 0) {
    throw new InputError(`hash literal not found in ${where} for binding ${binding.id}`, "input_error");
  }
  if (matches.length > 1) {
    throw new InputError(`hash literal match is ambiguous in ${where} (${matches.length} occurrences) for binding ${binding.id}`, "input_error");
  }
  const match = matches[0]!;
  return { index: match.index!, text: match[0] };
}

/** What a self-pinned source's own pin literal is replaced by before hashing. */
export const SELF_PIN_PLACEHOLDER = "0".repeat(64);

function replaceUniqueLiteral(binding: HashBinding, text: string, literal: string, where: string): string {
  const match = uniqueLiteralMatch(binding, text, where);
  return `${text.slice(0, match.index)}${literal}${text.slice(match.index + match.text.length)}`;
}

function selfPinDigest(binding: HashBinding, text: string): string {
  return sha256(replaceUniqueLiteral(binding, text, SELF_PIN_PLACEHOLDER, binding.sourcePath));
}

/**
 * Seal a freshly built self-pinned source (the bundle): its digest with its
 * own pin normalised out, and the text carrying that digest as its pin — the
 * exact bytes a rebuild produces once the target is re-pinned, so the
 * published file is a pure function of the other sources (never of what was
 * on disk before). The binding is the one whose `sourcePath` is `sourcePath`
 * and whose mode is `self-pinned-sha256`.
 */
export function sealSelfPinnedSource(sourcePath: string, text: string): Readonly<{ text: string; digest: string }> {
  const bindings = HASH_BINDINGS.filter((binding) => binding.sourcePath === sourcePath && binding.hashMode.kind === "self-pinned-sha256");
  const binding = bindings[0];
  if (bindings.length !== 1 || binding === undefined) {
    throw new InputError(`no single self-pinned hash binding has the source ${sourcePath} (${bindings.length} found)`, "input_error");
  }
  const digest = selfPinDigest(binding, text);
  return deepFreeze({ text: replaceUniqueLiteral(binding, text, digest, sourcePath), digest });
}

function readJsonLiteral(binding: HashBinding, content: string): string {
  const jsonPath = binding.jsonPath;
  if (jsonPath === undefined || jsonPath.length === 0) {
    throw new InputError(`json binding ${binding.id} has no jsonPath`, "input_error");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InputError(`target is not valid JSON: ${binding.targetPath}`, "input_error");
  }
  const value = readJsonPath(parsed, jsonPath);
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new InputError(`json path ${jsonPath.join(".")} in ${binding.targetPath} is not a 64-hex string`, "input_error");
  }
  return value;
}

function replaceCurrentLiteral(binding: HashBinding, content: string, previousHash: string, newHash: string): string {
  if (binding.targetKind === "typescript") {
    return replaceTypescriptLiteral(binding, content, newHash);
  }
  return replaceJsonLiteral(binding, content, previousHash, newHash);
}

function replaceTypescriptLiteral(binding: HashBinding, content: string, newHash: string): string {
  return replaceUniqueLiteral(binding, content, newHash, binding.targetPath);
}

function replaceJsonLiteral(binding: HashBinding, content: string, previousHash: string, newHash: string): string {
  const jsonPath = binding.jsonPath!;
  const leafKey = jsonPath[jsonPath.length - 1]!;
  const escapedKey = escapeRegex(leafKey);
  const escapedPrevious = escapeRegex(previousHash);
  const regex = new RegExp(`("${escapedKey}"\\s*:\\s*")${escapedPrevious}(")`, "u");
  const matches = content.match(regex);
  if (matches === null) {
    throw new InputError(`json literal "${leafKey}": "${previousHash}" not found in ${binding.targetPath}`, "input_error");
  }
  const remaining = content.replace(regex, "");
  if (remaining.match(regex) !== null) {
    throw new InputError(`json literal "${leafKey}": "${previousHash}" is not unique in ${binding.targetPath}`, "input_error");
  }
  return content.replace(regex, `$1${newHash}$2`);
}

function readJsonPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      // An array step is a decimal index, never a property name.
      if (!/^(?:0|[1-9]\d*)$/u.test(key)) return undefined;
      current = current[Number(key)];
      continue;
    }
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function buildRegistryReport(root: string, results: readonly BindingVerifyResult[]): BindingRegistryReport {
  const matched = results.filter((result) => result.matches).length;
  const errors = results.filter((result) => result.error !== undefined).length;
  const mismatched = results.length - matched;
  const unsigned = {
    schemaVersion: HASH_BINDING_REGISTRY_VERSION,
    root,
    totalBindings: results.length,
    matched,
    mismatched,
    errors,
    results: deepFreeze(results),
    allMatch: matched === results.length,
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as BindingRegistryReport);
}

function buildRepairReport(root: string, results: readonly BindingRepairResult[]): BindingRepairReport {
  const repairedCount = results.filter((result) => result.repaired).length;
  const errorCount = results.filter((result) => result.error !== undefined).length;
  const alreadyMatchedCount = results.filter((result) => !result.repaired && result.error === undefined && result.previousHash === result.newHash).length;
  const unsigned = {
    schemaVersion: HASH_BINDING_REGISTRY_VERSION,
    root,
    totalBindings: results.length,
    repairedCount,
    alreadyMatchedCount,
    errorCount,
    results: deepFreeze(results),
    allMatch: errorCount === 0 && results.every((result) => result.previousHash === result.newHash || result.repaired),
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as BindingRepairReport);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
