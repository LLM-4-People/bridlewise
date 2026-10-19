import { z } from "zod";

import type { ConfigDocument } from "../../../kernel/config-contracts.ts";
import { InputError } from "../../../kernel/errors.ts";
import {
  canonicalDomainHash,
  canonicalHash,
  canonicalJson,
  deepFreeze,
} from "../../../kernel/integrity.ts";
import { sameOrderedValues } from "../../../kernel/ordered.ts";
import { ROOT_POLICY } from "../../../kernel/root-policy.ts";
import {
  SAFE_STRUCTURAL_REVISION,
  snapshotJsonValue,
  type SnapshotJsonValue,
  type StructuralSnapshotLimits,
} from "../../../kernel/safe-structural.ts";
import {
  HANDOFF_PROTOCOL_AUTHORITY,
  type HandoffProtocolAuthority,
} from "./handoff-protocol-authority.ts";

const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/u);
const NONNEGATIVE_INTEGER_SCHEMA = z.number().int().nonnegative();
const POSITIVE_INTEGER_SCHEMA = z.number().int().positive();
const MANIFEST_STABLE_ID_SCHEMA = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const SOURCE_PATH_SCHEMA = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);

const ORDER_IDENTITY_SCHEMA = z.strictObject({
  count: POSITIVE_INTEGER_SCHEMA,
  sha256: SHA256_SCHEMA,
});

const CONFIG_KEY_REFERENCE_SCHEMA = z.strictObject({
  purpose: MANIFEST_STABLE_ID_SCHEMA,
  owner: z.enum(["config-document", "root-policy"]),
  path: MANIFEST_STABLE_ID_SCHEMA,
  availability: z.enum(["required", "required-absent"]),
});

const SEMANTIC_OWNER_SCHEMA = z.strictObject({
  role: MANIFEST_STABLE_ID_SCHEMA,
  path: SOURCE_PATH_SCHEMA,
  byteLength: NONNEGATIVE_INTEGER_SCHEMA,
  sha256: SHA256_SCHEMA,
});

const PROTOCOL_LINEAGE_SCHEMA = z.strictObject({
  protocolVersion: POSITIVE_INTEGER_SCHEMA,
  executableSchemaFingerprint: SHA256_SCHEMA,
  invariantOrderIdentity: ORDER_IDENTITY_SCHEMA,
  reasonOrderIdentity: ORDER_IDENTITY_SCHEMA,
  configKeyReferenceIdentity: ORDER_IDENTITY_SCHEMA,
  semanticOwnerSetIdentity: ORDER_IDENTITY_SCHEMA,
  previousExecutableSchemaFingerprint: SHA256_SCHEMA.nullable(),
  disposition: z.enum(["superseded-unqualified", "current-unqualified"]),
});

export const HANDOFF_PROTOCOL_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal(HANDOFF_PROTOCOL_AUTHORITY.manifestSchemaVersion),
  currentProtocolVersion: POSITIVE_INTEGER_SCHEMA,
  featurePolicyDisposition: z.literal(HANDOFF_PROTOCOL_AUTHORITY.featurePolicyDisposition),
  contractSchemaVersions: z.strictObject({
    assignment: MANIFEST_STABLE_ID_SCHEMA,
    proposal: MANIFEST_STABLE_ID_SCHEMA,
    admissionContext: MANIFEST_STABLE_ID_SCHEMA,
    decision: MANIFEST_STABLE_ID_SCHEMA,
  }),
  identityDomains: z.strictObject({
    assignment: MANIFEST_STABLE_ID_SCHEMA,
    assignmentCandidate: MANIFEST_STABLE_ID_SCHEMA,
    proposal: MANIFEST_STABLE_ID_SCHEMA,
    proposalCandidate: MANIFEST_STABLE_ID_SCHEMA,
    admissionContext: MANIFEST_STABLE_ID_SCHEMA,
    decision: MANIFEST_STABLE_ID_SCHEMA,
  }),
  invariantOrder: z.strictObject({
    values: z.array(MANIFEST_STABLE_ID_SCHEMA).min(1),
    identity: ORDER_IDENTITY_SCHEMA,
  }),
  reasonOrder: z.strictObject({
    values: z.array(MANIFEST_STABLE_ID_SCHEMA).min(1),
    identity: ORDER_IDENTITY_SCHEMA,
  }),
  configKeyReferences: z.strictObject({
    values: z.array(CONFIG_KEY_REFERENCE_SCHEMA).min(1),
    identity: ORDER_IDENTITY_SCHEMA,
  }),
  semanticOwners: z.strictObject({
    values: z.array(SEMANTIC_OWNER_SCHEMA).min(1),
    identity: ORDER_IDENTITY_SCHEMA,
  }),
  lineage: z.array(PROTOCOL_LINEAGE_SCHEMA).min(2),
  integrityHash: SHA256_SCHEMA,
});

export type HandoffProtocolManifest = Readonly<z.infer<typeof HANDOFF_PROTOCOL_MANIFEST_SCHEMA>>;

export const HANDOFF_STRUCTURAL_REJECTION_CLASSES = deepFreeze([
  "proxy",
  "accessor-or-hidden-property",
  "unsupported-prototype",
  "cycle",
  "non-json",
  "non-finite-number",
  "maximum-depth",
  "maximum-nodes",
  "maximum-bytes",
  "maximum-identifier-characters",
] as const);

export type HandoffStructuralRejectionClass = typeof HANDOFF_STRUCTURAL_REJECTION_CLASSES[number];
export type HandoffCandidateKind = "assignment" | "proposal" | "context";

const STRUCTURAL_ERROR_CODES = deepFreeze({
  maximumDepth: "handoff_structure_maximum_depth",
  maximumNodes: "handoff_structure_maximum_nodes",
  nonFiniteNumber: "handoff_structure_non_finite_number",
  nonJsonValue: "handoff_structure_non_json",
  proxy: "handoff_structure_proxy",
  cycle: "handoff_structure_cycle",
  arrayPrototype: "handoff_structure_array_prototype",
  sparseArray: "handoff_structure_sparse_array",
  arrayProperty: "handoff_structure_array_property",
  objectPrototype: "handoff_structure_object_prototype",
  symbolKey: "handoff_structure_symbol_key",
  objectProperty: "handoff_structure_object_property",
} as const);

const STRUCTURAL_CLASS_BY_ERROR_CODE: Readonly<Record<string, HandoffStructuralRejectionClass>> =
  deepFreeze({
    [STRUCTURAL_ERROR_CODES.maximumDepth]: "maximum-depth",
    [STRUCTURAL_ERROR_CODES.maximumNodes]: "maximum-nodes",
    [STRUCTURAL_ERROR_CODES.nonFiniteNumber]: "non-finite-number",
    [STRUCTURAL_ERROR_CODES.nonJsonValue]: "non-json",
    [STRUCTURAL_ERROR_CODES.proxy]: "proxy",
    [STRUCTURAL_ERROR_CODES.cycle]: "cycle",
    [STRUCTURAL_ERROR_CODES.arrayPrototype]: "unsupported-prototype",
    [STRUCTURAL_ERROR_CODES.sparseArray]: "accessor-or-hidden-property",
    [STRUCTURAL_ERROR_CODES.arrayProperty]: "accessor-or-hidden-property",
    [STRUCTURAL_ERROR_CODES.objectPrototype]: "unsupported-prototype",
    [STRUCTURAL_ERROR_CODES.symbolKey]: "non-json",
    [STRUCTURAL_ERROR_CODES.objectProperty]: "accessor-or-hidden-property",
  });

export type HandoffStructuralRejection = Readonly<{
  candidate: HandoffCandidateKind;
  classification: HandoffStructuralRejectionClass;
}>;

type HandoffSchemas = ReturnType<typeof buildHandoffSchemas>;

export type HandoffProtocol = Readonly<{
  authority: HandoffProtocolAuthority;
  protocolIdentity: string;
  maximumIdentifierCharacters: number;
  structuralLimits: StructuralSnapshotLimits & Readonly<{ maximumCanonicalBytes: number }>;
  featurePolicyDisposition: "capability-unavailable";
  schemas: HandoffSchemas;
}>;

export type HandoffAssignmentDraft = Readonly<z.infer<HandoffSchemas["assignmentDraft"]>>;
export type HandoffAssignment = Readonly<z.infer<HandoffSchemas["assignment"]>>;
export type HandoffProposalDraft = Readonly<z.infer<HandoffSchemas["proposalDraft"]>>;
export type HandoffProposal = Readonly<z.infer<HandoffSchemas["proposal"]>>;
export type HandoffAdmissionContext = Readonly<z.infer<HandoffSchemas["admissionContext"]>>;
export type HandoffDecision = Readonly<z.infer<HandoffSchemas["decision"]>>;
export type HandoffInvariantDisposition = "satisfied" | "failed" | "unassessed";
export type HandoffInvariantResult = Readonly<{
  invariantId: string;
  disposition: HandoffInvariantDisposition;
  reasonCodes: readonly string[];
}>;

export type HandoffCandidateSnapshot = Readonly<{
  value: SnapshotJsonValue | null;
  candidateIdentity: string | null;
  structuralRejection: HandoffStructuralRejection | null;
}>;

export type HandoffAssignmentCompilation = Readonly<{
  outcome: "compiled" | "rejected";
  assignment: HandoffAssignment | null;
  candidateIdentity: string | null;
  structuralRejection: HandoffStructuralRejection | null;
  reasonCode: "assignment-structure-rejected" | "assignment-contract-invalid" | null;
}>;

export function parseHandoffProtocolManifest(candidate: unknown): HandoffProtocolManifest {
  const snapshot = snapshotJsonValue(
    candidate,
    universalSnapshotLimits(),
    "handoff_protocol_manifest_structure_invalid",
    STRUCTURAL_ERROR_CODES,
  );
  const parsed = HANDOFF_PROTOCOL_MANIFEST_SCHEMA.parse(snapshot);
  const { integrityHash, ...unsigned } = parsed;
  if (canonicalHash(unsigned) !== integrityHash) {
    throw new InputError("Handoff protocol manifest integrity is invalid", "handoff_manifest_integrity_invalid");
  }
  assertOrderIdentity(parsed.invariantOrder, "handoff_manifest_invariant_order_invalid");
  assertOrderIdentity(parsed.reasonOrder, "handoff_manifest_reason_order_invalid");
  assertOrderIdentity(parsed.configKeyReferences, "handoff_manifest_config_references_invalid");
  assertOrderIdentity(parsed.semanticOwners, "handoff_manifest_semantic_owners_invalid");
  assertUnique(parsed.invariantOrder.values, "handoff_manifest_invariant_order_invalid");
  assertUnique(parsed.reasonOrder.values, "handoff_manifest_reason_order_invalid");
  assertUnique(parsed.configKeyReferences.values.map((entry) => entry.purpose),
    "handoff_manifest_config_references_invalid");
  assertUnique(parsed.semanticOwners.values.map((entry) => entry.path),
    "handoff_manifest_semantic_owners_invalid");
  assertLineage(parsed);
  return deepFreeze(parsed);
}

export function createHandoffProtocol(
  manifestCandidate: unknown,
  config: ConfigDocument,
): HandoffProtocol {
  const manifest = parseHandoffProtocolManifest(manifestCandidate);
  assertHandoffManifestAuthority(manifest);
  const authority = HANDOFF_PROTOCOL_AUTHORITY;
  const identifierMaximum = readRequiredAuthorityNumber(authority, "identifier-maximum", config);
  const maximumCanonicalBytes = readRequiredAuthorityNumber(
    authority,
    "structural-maximum-canonical-bytes",
    config,
  );
  const maximumDepth = readRequiredAuthorityNumber(authority, "structural-maximum-depth", config);
  const maximumNodes = readRequiredAuthorityNumber(authority, "structural-maximum-nodes", config);
  const featurePolicyReference = authorityReferenceFor(authority, "handoff-feature-policy");
  if (featurePolicyReference.availability !== "required-absent" ||
    readAuthorityReference(featurePolicyReference, config) !== undefined) {
    throw new InputError("Handoff feature-policy disposition is invalid", "handoff_feature_policy_invalid");
  }
  const schemas = buildHandoffSchemas(authority);
  const executableSchemaFingerprint = deriveHandoffExecutableSchemaFingerprintValue(authority, schemas);
  const current = manifest.lineage.at(-1)!;
  if (current.protocolVersion !== authority.currentProtocolVersion ||
    current.executableSchemaFingerprint !== executableSchemaFingerprint) {
    throw new InputError("Handoff protocol fingerprint requires a versioned manifest update",
      "handoff_protocol_fingerprint_drift");
  }
  return deepFreeze({
    authority,
    protocolIdentity: canonicalHash({
      protocolAuthority: authorityProjectionIdentity(authority),
      executableSchemaFingerprint,
      identifierMaximum,
      structuralRevision: SAFE_STRUCTURAL_REVISION,
      maximumCanonicalBytes,
      maximumDepth,
      maximumNodes,
      featurePolicyDisposition: authority.featurePolicyDisposition,
    }),
    maximumIdentifierCharacters: identifierMaximum,
    structuralLimits: { maximumCanonicalBytes, maximumDepth, maximumNodes },
    featurePolicyDisposition: authority.featurePolicyDisposition,
    schemas,
  });
}

export function deriveHandoffExecutableSchemaFingerprint(
  manifestCandidate: unknown,
): string {
  const manifest = parseHandoffProtocolManifest(manifestCandidate);
  assertHandoffManifestAuthority(manifest);
  return deriveHandoffExecutableSchemaFingerprintValue(
    HANDOFF_PROTOCOL_AUTHORITY,
    buildHandoffSchemas(HANDOFF_PROTOCOL_AUTHORITY),
  );
}

/**
 * The REGENERATION PATH for the canonical manifest's current executable schema
 * fingerprint. The fingerprint is a pure function of the authority (its schema
 * versions, identity domains, ordered catalogs and semantic-owner set), never
 * of the manifest bytes — so it can be re-derived after a fold without a valid
 * manifest in hand. The recorded lineage entry must equal this value; a drift
 * here is re-pinned by regenerating the manifest, never by hand-editing it.
 */
export function deriveCurrentHandoffExecutableSchemaFingerprint(): string {
  return deriveHandoffExecutableSchemaFingerprintValue(
    HANDOFF_PROTOCOL_AUTHORITY,
    buildHandoffSchemas(HANDOFF_PROTOCOL_AUTHORITY),
  );
}

export function snapshotHandoffCandidate(
  candidate: unknown,
  kind: HandoffCandidateKind,
  identityDomain: string,
  protocol: HandoffProtocol,
): HandoffCandidateSnapshot {
  let value: SnapshotJsonValue;
  try {
    value = snapshotJsonValue(
      candidate,
      {
        maximumDepth: protocol.structuralLimits.maximumDepth,
        maximumNodes: protocol.structuralLimits.maximumNodes,
      },
      "handoff_structure_invalid",
      STRUCTURAL_ERROR_CODES,
    );
  } catch (error) {
    const classification = error instanceof InputError
      ? STRUCTURAL_CLASS_BY_ERROR_CODE[error.code] ?? "non-json"
      : "non-json";
    return deepFreeze({
      value: null,
      candidateIdentity: null,
      structuralRejection: { candidate: kind, classification },
    });
  }
  const canonical = canonicalJson(value);
  if (new TextEncoder().encode(canonical).length > protocol.structuralLimits.maximumCanonicalBytes) {
    return rejectedSnapshot(kind, "maximum-bytes");
  }
  if (containsOversizedString(value, protocol.maximumIdentifierCharacters)) {
    return rejectedSnapshot(kind, "maximum-identifier-characters");
  }
  return deepFreeze({
    value,
    candidateIdentity: canonicalDomainHash(identityDomain, value),
    structuralRejection: null,
  });
}

export function canonicalReasonOrder(
  reasons: ReadonlySet<string>,
  authority: HandoffProtocolAuthority,
): readonly string[] {
  const allowedReasons: ReadonlySet<string> = new Set(authority.reasonOrder);
  const unknown = [...reasons].find((reason) => !allowedReasons.has(reason));
  if (unknown !== undefined) {
    throw new InputError("Handoff reason is absent from production authority", "handoff_reason_unregistered");
  }
  return deepFreeze(authority.reasonOrder.filter((reason) => reasons.has(reason)));
}

export function decisionIdentityPayload(decision: HandoffDecision): Readonly<Record<string, unknown>> {
  const { decisionIdentity, ...payload } = decision;
  return payload;
}

function buildHandoffSchemas(authority: HandoffProtocolAuthority) {
  const stableIdentity = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
  const orderedUniqueStableIdentities = z.array(stableIdentity).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "identities must be unique" });
    }
  });
  const parent = z.strictObject({
    parentTaskIdentity: stableIdentity,
    parentAgentIdentity: stableIdentity,
    resultRecipientIdentity: stableIdentity,
  });
  const snapshot = z.strictObject({
    requirementsIdentity: SHA256_SCHEMA,
    repositoryIdentity: SHA256_SCHEMA,
    worktreeIdentity: SHA256_SCHEMA,
    configurationIdentity: SHA256_SCHEMA,
    policyIdentity: SHA256_SCHEMA,
    sourceSetIdentity: SHA256_SCHEMA,
  });
  const focus = z.strictObject({
    foregroundFocusIdentity: stableIdentity,
    unresolvedPredecessorIdentities: orderedUniqueStableIdentities,
  });
  const evidenceRequirement = z.strictObject({
    requirementIdentity: stableIdentity,
    kindIdentity: stableIdentity,
    subjectIdentity: SHA256_SCHEMA,
  });
  const checklistItem = z.strictObject({
    itemIdentity: stableIdentity,
    requiredEvidenceRequirementIdentities: orderedUniqueStableIdentities,
  });
  const assignmentDraft = z.strictObject({
    taskIdentity: stableIdentity,
    subtaskIdentity: stableIdentity,
    attemptIdentity: stableIdentity,
    assigneeAgentIdentity: stableIdentity,
    parent,
    subjectIdentity: SHA256_SCHEMA,
    expectedOutputSchemaIdentity: SHA256_SCHEMA,
    snapshot,
    focus,
    checklist: z.array(checklistItem).min(1).superRefine((items, context) => {
      if (new Set(items.map((item) => item.itemIdentity)).size !== items.length) {
        context.addIssue({ code: "custom", message: "checklist item identities must be unique" });
      }
    }),
    evidenceRequirements: z.array(evidenceRequirement).min(1).superRefine((requirements, context) => {
      if (new Set(requirements.map((entry) => entry.requirementIdentity)).size !== requirements.length) {
        context.addIssue({ code: "custom", message: "evidence requirement identities must be unique" });
      }
    }),
  }).superRefine((draft, context) => {
    const requirementIdentities = draft.evidenceRequirements.map((entry) => entry.requirementIdentity);
    const known = new Set(requirementIdentities);
    const referenced = new Set(draft.checklist.flatMap((item) =>
      item.requiredEvidenceRequirementIdentities
    ));
    if (draft.checklist.some((item) =>
      item.requiredEvidenceRequirementIdentities.some((identity) => !known.has(identity))) ||
      requirementIdentities.some((identity) => !referenced.has(identity))) {
      context.addIssue({ code: "custom", message: "checklist evidence requirements are invalid" });
    }
  });
  const assignment = assignmentDraft.extend({
    schemaVersion: z.literal(authority.contractSchemaVersions.assignment),
    assignmentIdentity: SHA256_SCHEMA,
  });
  const checklistResult = z.strictObject({
    itemIdentity: stableIdentity,
    status: z.enum(["satisfied", "failed", "unassessed"]),
    evidenceRequirementIdentities: orderedUniqueStableIdentities,
  });
  const evidenceReference = z.strictObject({
    requirementIdentity: stableIdentity,
    kindIdentity: stableIdentity,
    subjectIdentity: SHA256_SCHEMA,
    evidenceIdentity: SHA256_SCHEMA,
  });
  const predecessorDisposition = z.strictObject({
    predecessorIdentity: stableIdentity,
    disposition: z.enum(["suspended", "blocked", "completed", "superseded", "cancelled", "abandoned"]),
  });
  const proposalDraft = z.strictObject({
    assignmentIdentity: SHA256_SCHEMA,
    taskIdentity: stableIdentity,
    subtaskIdentity: stableIdentity,
    attemptIdentity: stableIdentity,
    assigneeAgentIdentity: stableIdentity,
    parent,
    recipientIdentity: stableIdentity,
    subjectIdentity: SHA256_SCHEMA,
    outputSchemaIdentity: SHA256_SCHEMA,
    outputIdentity: SHA256_SCHEMA,
    snapshot,
    focus,
    disposition: z.enum(["completed", "suspended", "blocked"]),
    checklistResults: z.array(checklistResult).min(1).superRefine((results, context) => {
      if (new Set(results.map((entry) => entry.itemIdentity)).size !== results.length) {
        context.addIssue({ code: "custom", message: "checklist result identities must be unique" });
      }
    }),
    evidence: z.array(evidenceReference).min(1).superRefine((references, context) => {
      if (new Set(references.map((entry) => entry.requirementIdentity)).size !== references.length) {
        context.addIssue({ code: "custom", message: "evidence requirement identities must be unique" });
      }
    }),
    predecessorDispositions: z.array(predecessorDisposition).superRefine((dispositions, context) => {
      if (new Set(dispositions.map((entry) => entry.predecessorIdentity)).size !== dispositions.length) {
        context.addIssue({ code: "custom", message: "predecessor identities must be unique" });
      }
    }),
  });
  const proposal = proposalDraft.extend({
    schemaVersion: z.literal(authority.contractSchemaVersions.proposal),
    proposalIdentity: SHA256_SCHEMA,
  });
  const admissionContext = z.strictObject({
    schemaVersion: z.literal(authority.contractSchemaVersions.admissionContext),
    evaluatorKind: z.enum(["deterministic-parent-gate", "embedding-observer", "llm-observer"]),
    activeAssignmentIdentity: SHA256_SCHEMA,
    taskIdentity: stableIdentity,
    subtaskIdentity: stableIdentity,
    attemptIdentity: stableIdentity,
    assigneeAgentIdentity: stableIdentity,
    parent,
    snapshot,
    focus,
  });
  const structuralRejection = z.strictObject({
    candidate: z.enum(["assignment", "proposal", "context"]),
    classification: z.enum(HANDOFF_STRUCTURAL_REJECTION_CLASSES),
  });
  const invariantResult = z.strictObject({
    invariantId: stableIdentity,
    disposition: z.enum(["satisfied", "failed", "unassessed"]),
    reasonCodes: z.array(stableIdentity),
  });
  const decision = z.strictObject({
    schemaVersion: z.literal(authority.contractSchemaVersions.decision),
    protocolIdentity: SHA256_SCHEMA,
    decisionIdentity: SHA256_SCHEMA,
    assignmentCandidateIdentity: SHA256_SCHEMA.nullable(),
    assignmentIdentity: SHA256_SCHEMA.nullable(),
    proposalCandidateIdentity: SHA256_SCHEMA.nullable(),
    proposalIdentity: SHA256_SCHEMA.nullable(),
    contextIdentity: SHA256_SCHEMA.nullable(),
    outcome: z.enum(["rejected", "held"]),
    reasonCodes: z.array(stableIdentity).min(1),
    invariantResults: z.array(invariantResult),
    structuralRejections: z.array(structuralRejection),
    featurePolicyDisposition: z.literal(authority.featurePolicyDisposition),
    admissionCapability: z.literal("unavailable"),
    effectAuthorization: z.literal("unavailable"),
    deliveryAuthorization: z.literal("unavailable"),
  }).superRefine((value, context) => {
    const invariantIds = value.invariantResults.map((entry) => entry.invariantId);
    if (!sameOrderedValues(invariantIds, authority.invariantOrder)) {
      context.addIssue({ code: "custom", message: "invariant result order is invalid" });
    }
    const allowedReasons: ReadonlySet<string> = new Set(authority.reasonOrder);
    if (!sameOrderedValues(value.reasonCodes, authority.reasonOrder.filter((reason) =>
      value.reasonCodes.includes(reason)
    )) || value.reasonCodes.some((reason) => !allowedReasons.has(reason))) {
      context.addIssue({ code: "custom", message: "decision reason order is invalid" });
    }
    for (const result of value.invariantResults) {
      if (!sameOrderedValues(result.reasonCodes, authority.reasonOrder.filter((reason) =>
        result.reasonCodes.includes(reason)
      )) || result.reasonCodes.some((reason) => !allowedReasons.has(reason))) {
        context.addIssue({ code: "custom", message: "invariant reason order is invalid" });
      }
    }
  });
  return deepFreeze({
    assignmentDraft,
    assignment,
    proposalDraft,
    proposal,
    admissionContext,
    decision,
  });
}

function deriveHandoffExecutableSchemaFingerprintValue(
  authority: HandoffProtocolAuthority,
  schemas: HandoffSchemas,
): string {
  const jsonSchemaOptions = {
    target: "draft-2020-12" as const,
    unrepresentable: "throw" as const,
    cycles: "ref" as const,
    reused: "ref" as const,
  };
  return canonicalHash({
    protocolVersion: authority.currentProtocolVersion,
    contractSchemaVersions: authority.contractSchemaVersions,
    identityDomains: authority.identityDomains,
    invariantOrderIdentity: orderIdentity(authority.invariantOrder),
    reasonOrderIdentity: orderIdentity(authority.reasonOrder),
    configKeyReferenceIdentity: orderIdentity(authority.configKeyReferences),
    semanticOwnerSetIdentity: orderIdentity(authority.semanticOwners),
    featurePolicyDisposition: authority.featurePolicyDisposition,
    safeStructuralRevision: SAFE_STRUCTURAL_REVISION,
    schemas: {
      assignment: z.toJSONSchema(schemas.assignment, jsonSchemaOptions),
      proposal: z.toJSONSchema(schemas.proposal, jsonSchemaOptions),
      admissionContext: z.toJSONSchema(schemas.admissionContext, jsonSchemaOptions),
      decision: z.toJSONSchema(schemas.decision, jsonSchemaOptions),
    },
  });
}

function universalSnapshotLimits(): StructuralSnapshotLimits {
  return deepFreeze({
    maximumDepth: ROOT_POLICY.forensics.limits.maximumDepth,
    maximumNodes: ROOT_POLICY.forensics.limits.maximumNodes,
  });
}

function rejectedSnapshot(
  candidate: HandoffCandidateKind,
  classification: HandoffStructuralRejectionClass,
): HandoffCandidateSnapshot {
  return deepFreeze({
    value: null,
    candidateIdentity: null,
    structuralRejection: { candidate, classification },
  });
}

function containsOversizedString(value: SnapshotJsonValue, maximumCharacters: number): boolean {
  if (typeof value === "string") return value.length > maximumCharacters;
  if (value === null || typeof value !== "object") return false;
  return Array.isArray(value)
    ? value.some((entry) => containsOversizedString(entry, maximumCharacters))
    : Object.values(value).some((entry) => containsOversizedString(entry, maximumCharacters));
}

function assertHandoffManifestAuthority(manifest: HandoffProtocolManifest): void {
  if (canonicalHash(manifestAuthorityProjection(manifest)) !==
    authorityProjectionIdentity(HANDOFF_PROTOCOL_AUTHORITY)) {
    throw new InputError(
      "Handoff manifest does not conform to production authority",
      "handoff_manifest_authority_mismatch",
    );
  }
}

function manifestAuthorityProjection(manifest: HandoffProtocolManifest): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: manifest.schemaVersion,
    currentProtocolVersion: manifest.currentProtocolVersion,
    featurePolicyDisposition: manifest.featurePolicyDisposition,
    contractSchemaVersions: manifest.contractSchemaVersions,
    identityDomains: manifest.identityDomains,
    invariantOrder: manifest.invariantOrder.values,
    reasonOrder: manifest.reasonOrder.values,
    configKeyReferences: manifest.configKeyReferences.values,
    semanticOwners: manifest.semanticOwners.values,
  };
}

function authorityProjectionIdentity(authority: HandoffProtocolAuthority): string {
  return canonicalHash({
    schemaVersion: authority.manifestSchemaVersion,
    currentProtocolVersion: authority.currentProtocolVersion,
    featurePolicyDisposition: authority.featurePolicyDisposition,
    contractSchemaVersions: authority.contractSchemaVersions,
    identityDomains: authority.identityDomains,
    invariantOrder: authority.invariantOrder,
    reasonOrder: authority.reasonOrder,
    configKeyReferences: authority.configKeyReferences,
    semanticOwners: authority.semanticOwners,
  });
}

function orderIdentity(values: readonly unknown[]): Readonly<{ count: number; sha256: string }> {
  return { count: values.length, sha256: canonicalHash(values) };
}

type AuthorityConfigReference = HandoffProtocolAuthority["configKeyReferences"][number];

function readRequiredAuthorityNumber(
  authority: HandoffProtocolAuthority,
  purpose: AuthorityConfigReference["purpose"],
  config: ConfigDocument,
): number {
  const reference = authorityReferenceFor(authority, purpose);
  const value = readAuthorityReference(reference, config);
  if (reference.availability !== "required" || !Number.isSafeInteger(value) || (value as number) < 1) {
    throw new InputError(
      "Handoff production configuration binding is unavailable",
      "handoff_authority_binding_unavailable",
    );
  }
  return value as number;
}

function authorityReferenceFor(
  authority: HandoffProtocolAuthority,
  purpose: AuthorityConfigReference["purpose"],
): AuthorityConfigReference {
  const reference = authority.configKeyReferences.find((entry) => entry.purpose === purpose);
  if (reference === undefined) {
    throw new InputError(
      "Handoff production configuration binding is absent",
      "handoff_authority_binding_unavailable",
    );
  }
  return reference;
}

function readAuthorityReference(reference: AuthorityConfigReference, config: ConfigDocument): unknown {
  let value: unknown = reference.owner === "config-document" ? config : ROOT_POLICY;
  for (const segment of reference.path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

function assertOrderIdentity(
  projection: Readonly<{ values: readonly unknown[]; identity: Readonly<{ count: number; sha256: string }> }>,
  code: string,
): void {
  if (projection.identity.count !== projection.values.length ||
    projection.identity.sha256 !== canonicalHash(projection.values)) {
    throw new InputError("Handoff manifest ordered identity is invalid", code);
  }
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) {
    throw new InputError("Handoff manifest values must be unique", code);
  }
}

function assertLineage(manifest: HandoffProtocolManifest): void {
  const lineage = manifest.lineage;
  if (lineage.at(-1)?.disposition !== "current-unqualified" ||
    lineage.at(-1)?.protocolVersion !== manifest.currentProtocolVersion ||
    lineage.slice(0, -1).some((entry) => entry.disposition !== "superseded-unqualified")) {
    throw new InputError("Handoff protocol lineage disposition is invalid", "handoff_manifest_lineage_invalid");
  }
  for (const [index, entry] of lineage.entries()) {
    const previous = lineage[index - 1];
    if (index === 0) {
      if (entry.previousExecutableSchemaFingerprint !== null) {
        throw new InputError("Handoff protocol lineage origin is invalid", "handoff_manifest_lineage_invalid");
      }
      continue;
    }
    if (!previous || entry.protocolVersion !== previous.protocolVersion + 1 ||
      entry.previousExecutableSchemaFingerprint !== previous.executableSchemaFingerprint ||
      entry.executableSchemaFingerprint === previous.executableSchemaFingerprint) {
      throw new InputError("Handoff protocol drift lacks a semantic version bump",
        "handoff_manifest_version_bump_required");
    }
  }
  const current = lineage.at(-1)!;
  if (canonicalHash(manifest.invariantOrder.values) !== current.invariantOrderIdentity.sha256 ||
    manifest.invariantOrder.values.length !== current.invariantOrderIdentity.count ||
    canonicalHash(manifest.reasonOrder.values) !== current.reasonOrderIdentity.sha256 ||
    manifest.reasonOrder.values.length !== current.reasonOrderIdentity.count ||
    canonicalHash(manifest.configKeyReferences.values) !== current.configKeyReferenceIdentity.sha256 ||
    manifest.configKeyReferences.values.length !== current.configKeyReferenceIdentity.count ||
    canonicalHash(manifest.semanticOwners.values) !== current.semanticOwnerSetIdentity.sha256 ||
    manifest.semanticOwners.values.length !== current.semanticOwnerSetIdentity.count) {
    throw new InputError("Current handoff protocol lineage identities are stale",
      "handoff_manifest_lineage_identity_invalid");
  }
  const suffix = `/v${manifest.currentProtocolVersion}`;
  if (Object.values(manifest.contractSchemaVersions).some((value) => !value.endsWith(suffix)) ||
    Object.values(manifest.identityDomains).some((value) => !value.endsWith(suffix))) {
    throw new InputError("Handoff protocol versions are not aligned", "handoff_manifest_version_invalid");
  }
}
