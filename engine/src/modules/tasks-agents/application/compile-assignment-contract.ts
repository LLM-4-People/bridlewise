import { canonicalDomainHash, deepFreeze } from "../../../kernel/integrity.ts";
import type { SnapshotJsonValue } from "../../../kernel/safe-structural.ts";
import {
  snapshotHandoffCandidate,
  type HandoffAssignment,
  type HandoffAssignmentCompilation,
  type HandoffProtocol,
} from "../domain/handoff-contracts.ts";

/** Snapshots an untrusted assignment exactly once before schema or hash work. */
export function compileAssignmentContract(
  candidate: unknown,
  protocol: HandoffProtocol,
): HandoffAssignmentCompilation {
  const captured = snapshotHandoffCandidate(
    candidate,
    "assignment",
    protocol.authority.identityDomains.assignmentCandidate,
    protocol,
  );
  if (captured.structuralRejection) {
    return deepFreeze({
      outcome: "rejected",
      assignment: null,
      candidateIdentity: null,
      structuralRejection: captured.structuralRejection,
      reasonCode: "assignment-structure-rejected",
    });
  }
  const draft = protocol.schemas.assignmentDraft.safeParse(captured.value);
  if (!draft.success) {
    return deepFreeze({
      outcome: "rejected",
      assignment: null,
      candidateIdentity: captured.candidateIdentity,
      structuralRejection: null,
      reasonCode: "assignment-contract-invalid",
    });
  }
  const payload = {
    schemaVersion: protocol.authority.contractSchemaVersions.assignment,
    ...draft.data,
  };
  const parsed = protocol.schemas.assignment.parse({
    ...payload,
    assignmentIdentity: canonicalDomainHash(protocol.authority.identityDomains.assignment, payload),
  });
  return deepFreeze({
    outcome: "compiled",
    assignment: parsed,
    candidateIdentity: captured.candidateIdentity,
    structuralRejection: null,
    reasonCode: null,
  });
}

/** Inspects an already-snapshotted assignment without re-reading caller-owned state. */
export function inspectAssignmentSnapshot(
  candidate: SnapshotJsonValue,
  protocol: HandoffProtocol,
): HandoffAssignment | null {
  const parsed = protocol.schemas.assignment.safeParse(candidate);
  if (!parsed.success) return null;
  return verifyAssignmentContractIdentity(parsed.data, protocol);
}

/** Verifies identity on a schema-validated assignment without parsing it again. */
export function verifyAssignmentContractIdentity(
  candidate: HandoffAssignment,
  protocol: HandoffProtocol,
): HandoffAssignment | null {
  const { assignmentIdentity, ...payload } = candidate;
  const expected = canonicalDomainHash(protocol.authority.identityDomains.assignment, payload);
  return assignmentIdentity === expected ? deepFreeze(candidate) : null;
}

/** Public untrusted-input inspector; the candidate is snapshotted exactly once. */
export function inspectAssignmentContract(
  candidate: unknown,
  protocol: HandoffProtocol,
): HandoffAssignment | null {
  const captured = snapshotHandoffCandidate(
    candidate,
    "assignment",
    protocol.authority.identityDomains.assignmentCandidate,
    protocol,
  );
  return captured.structuralRejection ? null : inspectAssignmentSnapshot(captured.value, protocol);
}
