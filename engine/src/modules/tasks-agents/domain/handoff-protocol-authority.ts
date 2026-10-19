import { readFileSync } from "node:fs";
import { join } from "node:path";

import { deepFreeze, sha256 } from "../../../kernel/integrity.ts";
import { schemaId, cryptoDomain } from "../../../kernel/product-identity.ts";

/**
 * Production authority for handoff protocol semantics. The canonical JSON
 * manifest is a conformance projection of this object; untrusted manifest
 * bytes never select schemas, limits, invariant/reason catalogs, or sources.
 *
 * This file is deliberately absent from its own semantic-owner set. The
 * higher-level planned-test source inventory binds it without a self-hash
 * cycle.
 */
export const HANDOFF_PROTOCOL_AUTHORITY = deepFreeze({
  manifestSchemaVersion: schemaId("handoff-protocol-manifest", 1),
  currentProtocolVersion: 3,
  featurePolicyDisposition: "capability-unavailable",
  contractSchemaVersions: {
    assignment: schemaId("handoff-assignment", 3),
    proposal: schemaId("handoff-proposal", 3),
    admissionContext: schemaId("handoff-admission-context", 3),
    decision: schemaId("handoff-decision", 3),
  },
  identityDomains: {
    assignment: cryptoDomain("handoff/assignment", 3),
    assignmentCandidate: cryptoDomain("handoff/assignment-candidate", 3),
    proposal: cryptoDomain("handoff/proposal", 3),
    proposalCandidate: cryptoDomain("handoff/proposal-candidate", 3),
    admissionContext: cryptoDomain("handoff/admission-context", 3),
    decision: cryptoDomain("handoff/decision", 3),
  },
  invariantOrder: [
    "assignment-structure",
    "proposal-structure",
    "context-structure",
    "assignment-contract",
    "assignment-identity",
    "proposal-contract",
    "context-contract",
    "active-assignment",
    "task",
    "subtask",
    "attempt",
    "assignee",
    "parent",
    "recipient",
    "subject",
    "output-schema",
    "snapshot",
    "focus",
    "unfinished-work",
    "checklist",
    "evidence",
    "disposition",
    "feature-policy",
    "nominal-authority",
  ],
  reasonOrder: [
    "observer-advisory-only",
    "assignment-structure-rejected",
    "proposal-structure-rejected",
    "context-structure-rejected",
    "assignment-contract-invalid",
    "assignment-identity-invalid",
    "proposal-contract-invalid",
    "admission-context-invalid",
    "active-assignment-mismatch",
    "task-mismatch",
    "subtask-mismatch",
    "attempt-mismatch",
    "assignee-mismatch",
    "parent-mismatch",
    "recipient-mismatch",
    "subject-mismatch",
    "output-schema-mismatch",
    "snapshot-mismatch",
    "focus-mismatch",
    "unfinished-work-mismatch",
    "checklist-mismatch",
    "checklist-unsatisfied",
    "evidence-mismatch",
    "snapshot-authority-unavailable",
    "evidence-authority-unavailable",
    "feature-policy-unavailable",
    "nominal-authority-unavailable",
  ],
  configKeyReferences: [
    {
      purpose: "identifier-maximum",
      owner: "config-document",
      path: "contracts.limits.maximumIdentifierCharacters",
      availability: "required",
    },
    {
      purpose: "handoff-feature-policy",
      owner: "config-document",
      path: "handoffValidation",
      availability: "required-absent",
    },
    {
      purpose: "structural-maximum-canonical-bytes",
      owner: "root-policy",
      path: "forensics.limits.maximumCanonicalBytes",
      availability: "required",
    },
    {
      purpose: "structural-maximum-depth",
      owner: "root-policy",
      path: "forensics.limits.maximumDepth",
      availability: "required",
    },
    {
      purpose: "structural-maximum-nodes",
      owner: "root-policy",
      path: "forensics.limits.maximumNodes",
      availability: "required",
    },
  ],
  semanticOwners: [
    {
      role: "safe-structural-boundary",
      path: "src/kernel/safe-structural.ts",
      byteLength: 12_409,
      sha256: "3e0d84d3338fd408bb2773b76474eb4c8208c8348a6f8f3c7821b5ac3f09b518",
    },
    {
      role: "handoff-domain-owner",
      path: "src/modules/tasks-agents/domain/handoff-contracts.ts",
      byteLength: 30_513,
      sha256: "e0adafd54d537ecea2b97a17fe9b3822f3001db7bd2a41b2c128d8d7e24579bd",
    },
    {
      role: "assignment-compiler",
      path: "src/modules/tasks-agents/application/compile-assignment-contract.ts",
      byteLength: 3_068,
      sha256: "c1f7d79d2a371946c3d03dff4fed3c10840f48a453162996755b16487be4ad27",
    },
    {
      role: "handoff-admission-gate",
      path: "src/modules/tasks-agents/application/admit-handoff.ts",
      byteLength: 11_861,
      sha256: "d5c233e6dafb77012f515cb045b1e3a857b6a41d8b7bfff283e448c523c37fd4",
    },
    {
      role: "tasks-agents-facade",
      path: "src/modules/tasks-agents/index.ts",
      byteLength: 1_168,
      sha256: "a70aecffcb14edb57e056f62f77d2e58772f265e652ddb1fe14e42a9a41b25a5",
    },
  ],
} as const);

export type HandoffProtocolAuthority = typeof HANDOFF_PROTOCOL_AUTHORITY;

/**
 * The REGENERATION PATH for the semantic-owner byte-pins. Each pin
 * (`byteLength` + `sha256`) is a fold-sensitive fact about the named source
 * file; the fold that moved/re-touched those files invalidated them. They were
 * hand-authored, which is the defect: a pin with no owner-side regeneration
 * path rots on every move. This recomputes each pin from the CURRENT bytes of
 * the file at `path` (read from `root`), so re-deriving the authority after a
 * move is one call, never a hand-edit. The recorded `path` is the semantic
 * identity (the module's role in the protocol); only the byte measurements are
 * recomputed.
 */
export function recomputeSemanticOwnerPins(
  root: string,
): ReadonlyArray<Readonly<{ role: string; path: string; byteLength: number; sha256: string }>> {
  return HANDOFF_PROTOCOL_AUTHORITY.semanticOwners.map((owner) => {
    const bytes = readFileSync(join(root, owner.path));
    return deepFreeze({
      role: owner.role,
      path: owner.path,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    });
  });
}
