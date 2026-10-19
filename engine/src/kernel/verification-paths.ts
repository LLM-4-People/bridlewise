import { deepFreeze } from "./integrity.ts";
import { ROOT_POLICY } from "./root-policy.ts";

/** Neutral path authority shared by runtime-neutral verification cores and scripts. */
export const VERIFICATION_PATHS = deepFreeze({
  testInventory: "traceability/s1-test-inventory.json",
} as const);

/**
 * THE GENERATED README CONSUMER BLOCKS: every README.md carrying `begin`
 * holds one block, up to `end`, that `generator` (repository-relative)
 * projects from the import graph. `harness sync` writes them, `harness check`
 * reports their drift, and every such README is a generated output
 * (`generatedOutputPaths`, src/workflow/hash-binding-registry.ts).
 */
export const README_CONSUMER_BLOCK = deepFreeze({
  generator: "tests/helpers/readme-consumers.ts",
  begin: "<!-- consumers:generated -->",
  end: "<!-- /consumers:generated -->",
} as const);

/**
 * THE SOURCE-AUTHORITY PIN TARGETS (engine-relative): the files whose byte
 * pins `scripts/pin-authority-regeneration.ts` re-derives in a sync pass, and
 * the projection it rewrites beside one. Named here, below the scripts layer,
 * so the generated-output set (`generatedOutputPaths`,
 * src/workflow/hash-binding-registry.ts) lists them: a candidate's
 * regenerated copy is its own and copies back, like every other pin.
 */
export const PIN_AUTHORITY_PATHS = deepFreeze({
  handoffProtocolAuthority: "src/modules/tasks-agents/domain/handoff-protocol-authority.ts",
  handoffProtocolManifest: "traceability/canonical/handoff-protocol-manifest.json",
  plannedNodeTestSourceAuthority: "test/support/planned-node-test-source-authority.ts",
} as const);

/**
 * The decision index (`docs/decisions/README.md`, repository-relative): its
 * index block, between `begin` and `end`, is generated from the decision
 * files by `generator` (relative to the engine), a generated output like the
 * README consumer blocks; the prose around it is hand-written.
 */
export const DECISION_INDEX = deepFreeze({
  path: "docs/decisions/README.md",
  generator: "scripts/verification/decision-index.ts",
  begin: "<!-- BEGIN GENERATED: the decision index, from each file's front matter (harness sync; engine/scripts/verification/decision-index.ts) -->",
  end: "<!-- END GENERATED: the decision index -->",
} as const);

/**
 * THE SHIPPED HOOKS (`<directory>/<name>`, repository-relative): the tracked
 * hooks whose text is canonical — the `guarded` ones, which hand over to the
 * commit guard, and the promotion `trigger`. Each file's WHOLE text is a
 * generated output of `generator` (relative to the engine): `harness sync`
 * writes it from its owners (`shippedHookText`,
 * `scripts/verification/staged-move-loss.ts`, over `promotionTriggerHookText`,
 * src/workflow/promotion/trigger-hook.ts) and `harness check` reports a stale
 * one — never a hand edit (UR-02, PROMO34FIX-HOOK-GENERATOR).
 */
export const SHIPPED_HOOK_FILES = deepFreeze({
  directory: ".githooks",
  guarded: ["pre-commit", "pre-merge-commit", "commit-msg"],
  trigger: "reference-transaction",
  generator: "scripts/verification/shipped-hooks.ts",
} as const);

/**
 * THE EVIDENCE IGNORE BLOCK of the root `.gitignore`: the evidence folders git
 * ignores, written by `harness sync` and every ingest from the evidence
 * manifests (src/workflow/evidence-store.ts `syncEvidenceIgnore`). Registered
 * here like every other generated block (design M9), so a candidate's
 * regenerated copy is its own, never a source edit.
 */
export const EVIDENCE_IGNORE_BLOCK = deepFreeze({
  path: ROOT_POLICY.workflow.evidenceStore.ignoreBlock.file,
  generator: "src/workflow/evidence-store.ts",
  begin: ROOT_POLICY.workflow.evidenceStore.ignoreBlock.begin,
  end: ROOT_POLICY.workflow.evidenceStore.ignoreBlock.end,
} as const);

/** Every generated BLOCK a hand-written file can carry (its generator owns the text between `begin` and `end`). */
export const GENERATED_BLOCKS = deepFreeze([README_CONSUMER_BLOCK, DECISION_INDEX, EVIDENCE_IGNORE_BLOCK] as const);

export const SLICE_PROJECTION_PATHS = deepFreeze({
  declarations: "traceability/canonical/slice-declarations.json",
  requirementsRegistry: "traceability/requirements.json",
  requirementsSchemaArtifact: "traceability/s2.4-requirements-schema.json",
  contractSchemaArtifact: "traceability/s2-contract-schemas.json",
  forensicSchemaArtifact: "traceability/s3.1-forensic-schemas.json",
  s2ResearchManifest: "traceability/sources/s2/research-manifest.json",
  s2OfficialManifest: "traceability/sources/s2/manifest.json",
  s31SourceManifest: "traceability/sources/s3.1/manifest.json",
  s2Trace: "traceability/s2.json",
  /** The engine's test surface: a tree that carries it (the development branch) judges every fixture the S2 trace pins; a product tree ships the trace without it. */
  testSurface: "test",
  s24Trace: "traceability/s2.4.json",
  s31Trace: "traceability/s3.1.json",
  downstreamArtifactManifest: "traceability/artifacts/manifest.json",
  downstreamCandidateReceipt: "traceability/candidate.json",
  guardianSpecSchemaArtifact: "traceability/self-protection/guardian-spec-schema.json",
} as const);

export const SLICE_PROJECTION_ARTIFACT_PATHS = deepFreeze([
  SLICE_PROJECTION_PATHS.requirementsSchemaArtifact,
  SLICE_PROJECTION_PATHS.contractSchemaArtifact,
  SLICE_PROJECTION_PATHS.forensicSchemaArtifact,
  SLICE_PROJECTION_PATHS.s2Trace,
  SLICE_PROJECTION_PATHS.s24Trace,
  SLICE_PROJECTION_PATHS.s31Trace,
] as const);
