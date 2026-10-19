import { HarnessError } from "../../../kernel/errors.ts";
import { canonicalDomainHash, canonicalHash, deepFreeze } from "../../../kernel/integrity.ts";
import { sameOrderedValues } from "../../../kernel/ordered.ts";
import type { SnapshotJsonValue } from "../../../kernel/safe-structural.ts";
import { verifyAssignmentContractIdentity } from "./compile-assignment-contract.ts";
import {
  canonicalReasonOrder,
  decisionIdentityPayload,
  snapshotHandoffCandidate,
  type HandoffAdmissionContext,
  type HandoffAssignment,
  type HandoffDecision,
  type HandoffInvariantDisposition,
  type HandoffInvariantResult,
  type HandoffProposal,
  type HandoffProtocol,
} from "../domain/handoff-contracts.ts";

type ResultState = { disposition: HandoffInvariantDisposition; reasons: Set<string> };

function compileProposalSnapshot(
  candidate: SnapshotJsonValue,
  protocol: HandoffProtocol,
): HandoffProposal | null {
  const draft = protocol.schemas.proposalDraft.safeParse(candidate);
  if (!draft.success) return null;
  const payload = {
    schemaVersion: protocol.authority.contractSchemaVersions.proposal,
    ...draft.data,
  };
  return deepFreeze(protocol.schemas.proposal.parse({
    ...payload,
    proposalIdentity: canonicalDomainHash(protocol.authority.identityDomains.proposal, payload),
  }));
}

function exactObject(left: unknown, right: unknown): boolean {
  return canonicalHash(left) === canonicalHash(right);
}

function issueDecision(
  payload: Omit<HandoffDecision, "decisionIdentity">,
  protocol: HandoffProtocol,
): HandoffDecision {
  return deepFreeze(protocol.schemas.decision.parse({
    ...payload,
    decisionIdentity: canonicalDomainHash(protocol.authority.identityDomains.decision, payload),
  }));
}

/**
 * Rejects demonstrable binding failures and otherwise holds the proposal. This
 * gate never issues admission, effect, or delivery authority; those nominal
 * authorities are deliberately unavailable in this foundation.
 */
export function admitHandoff(
  assignmentCandidate: unknown,
  proposalCandidate: unknown,
  contextCandidate: unknown,
  protocol: HandoffProtocol,
): HandoffDecision {
  // Capture every caller-owned value once, before any schema or identity operation.
  const assignmentCapture = snapshotHandoffCandidate(
    assignmentCandidate,
    "assignment",
    protocol.authority.identityDomains.assignmentCandidate,
    protocol,
  );
  const proposalCapture = snapshotHandoffCandidate(
    proposalCandidate,
    "proposal",
    protocol.authority.identityDomains.proposalCandidate,
    protocol,
  );
  const contextCapture = snapshotHandoffCandidate(
    contextCandidate,
    "context",
    protocol.authority.identityDomains.admissionContext,
    protocol,
  );

  const states = new Map<string, ResultState>(protocol.authority.invariantOrder.map((id) => [
    id,
    { disposition: "unassessed", reasons: new Set<string>() },
  ]));
  const set = (
    id: string,
    disposition: HandoffInvariantDisposition,
    ...reasons: string[]
  ): void => {
    const state = states.get(id);
    if (!state) throw new HarnessError(`handoff_invariant_unregistered:${id}`, "handoff_invariant_unregistered");
    state.disposition = disposition;
    for (const reason of reasons) state.reasons.add(reason);
  };
  const structuralRejections = [
    assignmentCapture.structuralRejection,
    proposalCapture.structuralRejection,
    contextCapture.structuralRejection,
  ].filter((entry) => entry !== null);

  set(
    "assignment-structure",
    assignmentCapture.structuralRejection ? "failed" : "satisfied",
    ...(assignmentCapture.structuralRejection ? ["assignment-structure-rejected"] : []),
  );
  set(
    "proposal-structure",
    proposalCapture.structuralRejection ? "failed" : "satisfied",
    ...(proposalCapture.structuralRejection ? ["proposal-structure-rejected"] : []),
  );
  set(
    "context-structure",
    contextCapture.structuralRejection ? "failed" : "satisfied",
    ...(contextCapture.structuralRejection ? ["context-structure-rejected"] : []),
  );

  let assignment: HandoffAssignment | null = null;
  if (!assignmentCapture.structuralRejection) {
    const parsed = protocol.schemas.assignment.safeParse(assignmentCapture.value);
    if (!parsed.success) {
      set("assignment-contract", "failed", "assignment-contract-invalid");
    } else {
      set("assignment-contract", "satisfied");
      assignment = verifyAssignmentContractIdentity(parsed.data, protocol);
      set(
        "assignment-identity",
        assignment ? "satisfied" : "failed",
        ...(assignment ? [] : ["assignment-identity-invalid"]),
      );
    }
  }

  let proposal: HandoffProposal | null = null;
  if (!proposalCapture.structuralRejection) {
    proposal = compileProposalSnapshot(proposalCapture.value, protocol);
    set(
      "proposal-contract",
      proposal ? "satisfied" : "failed",
      ...(proposal ? [] : ["proposal-contract-invalid"]),
    );
  }

  let context: HandoffAdmissionContext | null = null;
  if (!contextCapture.structuralRejection) {
    const parsed = protocol.schemas.admissionContext.safeParse(contextCapture.value);
    context = parsed.success ? deepFreeze(parsed.data) : null;
    set(
      "context-contract",
      context ? "satisfied" : "failed",
      ...(context ? [] : ["admission-context-invalid"]),
    );
  }

  const evaluate = (id: string, matched: boolean, reason: string): void => {
    set(id, matched ? "satisfied" : "failed", ...(matched ? [] : [reason]));
  };
  if (assignment && proposal && context) {
    evaluate(
      "active-assignment",
      assignment.assignmentIdentity === context.activeAssignmentIdentity &&
        proposal.assignmentIdentity === assignment.assignmentIdentity,
      "active-assignment-mismatch",
    );
    evaluate("task", assignment.taskIdentity === context.taskIdentity &&
      proposal.taskIdentity === assignment.taskIdentity, "task-mismatch");
    evaluate("subtask", assignment.subtaskIdentity === context.subtaskIdentity &&
      proposal.subtaskIdentity === assignment.subtaskIdentity, "subtask-mismatch");
    evaluate("attempt", assignment.attemptIdentity === context.attemptIdentity &&
      proposal.attemptIdentity === assignment.attemptIdentity, "attempt-mismatch");
    evaluate("assignee", assignment.assigneeAgentIdentity === context.assigneeAgentIdentity &&
      proposal.assigneeAgentIdentity === assignment.assigneeAgentIdentity, "assignee-mismatch");
    evaluate("parent", exactObject(assignment.parent, context.parent) &&
      exactObject(proposal.parent, assignment.parent), "parent-mismatch");
    evaluate("recipient", proposal.recipientIdentity === assignment.parent.resultRecipientIdentity,
      "recipient-mismatch");
    evaluate("subject", proposal.subjectIdentity === assignment.subjectIdentity, "subject-mismatch");
    evaluate("output-schema", proposal.outputSchemaIdentity === assignment.expectedOutputSchemaIdentity,
      "output-schema-mismatch");

    const snapshotMatches = exactObject(assignment.snapshot, context.snapshot) &&
      exactObject(proposal.snapshot, assignment.snapshot);
    set("snapshot", snapshotMatches ? "unassessed" : "failed",
      snapshotMatches ? "snapshot-authority-unavailable" : "snapshot-mismatch");
    evaluate("focus", assignment.focus.foregroundFocusIdentity === context.focus.foregroundFocusIdentity &&
      proposal.focus.foregroundFocusIdentity === assignment.focus.foregroundFocusIdentity,
    "focus-mismatch");
    const predecessorsMatch = sameOrderedValues(
      assignment.focus.unresolvedPredecessorIdentities,
      context.focus.unresolvedPredecessorIdentities,
    ) && sameOrderedValues(
      proposal.focus.unresolvedPredecessorIdentities,
      assignment.focus.unresolvedPredecessorIdentities,
    ) && sameOrderedValues(
      proposal.predecessorDispositions.map((entry) => entry.predecessorIdentity),
      assignment.focus.unresolvedPredecessorIdentities,
    );
    evaluate("unfinished-work", predecessorsMatch, "unfinished-work-mismatch");

    const expectedChecklist = assignment.checklist.map((entry) => entry.itemIdentity);
    const actualChecklist = proposal.checklistResults.map((entry) => entry.itemIdentity);
    const checklistBindingsMatch = sameOrderedValues(expectedChecklist, actualChecklist) &&
      assignment.checklist.every((item, index) => sameOrderedValues(
        item.requiredEvidenceRequirementIdentities,
        proposal.checklistResults[index]?.evidenceRequirementIdentities ?? [],
      ));
    evaluate("checklist", checklistBindingsMatch, "checklist-mismatch");
    evaluate("disposition", proposal.checklistResults.every((entry) => entry.status === "satisfied"),
      "checklist-unsatisfied");

    const evidenceMatches = proposal.evidence.length === assignment.evidenceRequirements.length &&
      assignment.evidenceRequirements.every((requirement, index) => {
        const evidence = proposal.evidence[index];
        return evidence?.requirementIdentity === requirement.requirementIdentity &&
          evidence.kindIdentity === requirement.kindIdentity &&
          evidence.subjectIdentity === requirement.subjectIdentity;
      });
    set("evidence", evidenceMatches ? "unassessed" : "failed",
      evidenceMatches ? "evidence-authority-unavailable" : "evidence-mismatch");
  }

  set("feature-policy", "unassessed", "feature-policy-unavailable");
  set("nominal-authority", "unassessed", "nominal-authority-unavailable");
  const observer = context !== null && context.evaluatorKind !== "deterministic-parent-gate";
  if (observer) states.get("nominal-authority")?.reasons.add("observer-advisory-only");

  const invariantResults: HandoffInvariantResult[] = protocol.authority.invariantOrder.map((id) => {
    const state = states.get(id)!;
    return deepFreeze({
      invariantId: id,
      disposition: state.disposition,
      reasonCodes: canonicalReasonOrder(state.reasons, protocol.authority),
    });
  });
  const allReasons = new Set(invariantResults.flatMap((result) => result.reasonCodes));
  const reasonCodes = canonicalReasonOrder(allReasons, protocol.authority);
  const hasFailure = invariantResults.some((result) => result.disposition === "failed");
  return issueDecision({
    schemaVersion: protocol.authority.contractSchemaVersions.decision,
    protocolIdentity: protocol.protocolIdentity,
    assignmentCandidateIdentity: assignmentCapture.candidateIdentity,
    assignmentIdentity: assignment?.assignmentIdentity ?? null,
    proposalCandidateIdentity: proposalCapture.candidateIdentity,
    proposalIdentity: proposal?.proposalIdentity ?? null,
    contextIdentity: contextCapture.candidateIdentity,
    outcome: observer || !hasFailure ? "held" : "rejected",
    reasonCodes: [...reasonCodes],
    invariantResults: invariantResults.map((result) => ({
      ...result,
      reasonCodes: [...result.reasonCodes],
    })),
    structuralRejections: structuralRejections.map((entry) => ({ ...entry })),
    featurePolicyDisposition: protocol.featurePolicyDisposition,
    admissionCapability: "unavailable",
    effectAuthorization: "unavailable",
    deliveryAuthorization: "unavailable",
  }, protocol);
}

export function inspectHandoffDecision(candidate: unknown, protocol: HandoffProtocol): HandoffDecision | null {
  const captured = snapshotHandoffCandidate(
    candidate,
    "context",
    protocol.authority.identityDomains.admissionContext,
    protocol,
  );
  if (captured.structuralRejection) return null;
  const parsed = protocol.schemas.decision.safeParse(captured.value);
  if (!parsed.success || parsed.data.protocolIdentity !== protocol.protocolIdentity) return null;
  const expected = canonicalDomainHash(
    protocol.authority.identityDomains.decision,
    decisionIdentityPayload(parsed.data),
  );
  return parsed.data.decisionIdentity === expected ? deepFreeze(parsed.data) : null;
}
