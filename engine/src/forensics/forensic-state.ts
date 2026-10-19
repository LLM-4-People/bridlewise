import { InputError, SecurityError } from "../kernel/errors.ts";
import {
  FORENSIC_OUTBOX_COMMAND_SCHEMA,
  FORENSIC_OUTBOX_STATE_SCHEMA,
  type ForensicOutboxCommand,
  type ForensicOutboxState,
} from "./forensic-contracts.ts";
import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import { FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS } from "./forensic-structural.ts";
import { snapshotJsonValue } from "../kernel/safe-structural.ts";
import { schemaId } from "../kernel/product-identity.ts";

export const FORENSIC_STATE_REVISION = "s3.1-persist-before-forward-state/v2";

type CommitEvidence = Extract<ForensicOutboxCommand, { type: "commit" }>["evidence"];
type RecordedReceipt = Extract<ForensicOutboxCommand, { type: "record-receipt" }>["receipt"];

export function createForensicOutboxState(eventId: string, inputHash: string): ForensicOutboxState {
  return parseState({
    schemaVersion: schemaId("forensic-outbox-state", 1),
    eventId,
    inputHash,
    phase: "received",
  });
}

/** Pure reducer only. It grants no storage, forwarding, callback, or receipt effect. */
export function reduceForensicOutbox(
  stateInput: unknown,
  commandInput: unknown,
): ForensicOutboxState {
  const state = parseState(stateInput);
  let safeCommand: unknown;
  try {
    safeCommand = snapshotJsonValue(commandInput, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_outbox_command_invalid");
  } catch {
    throw new InputError("Forensic outbox command is invalid", "forensic_outbox_command_invalid");
  }
  const parsedCommand = FORENSIC_OUTBOX_COMMAND_SCHEMA.safeParse(safeCommand);
  if (!parsedCommand.success) {
    throw new InputError("Forensic outbox command is invalid", "forensic_outbox_command_invalid");
  }
  const command = parsedCommand.data;
  if (state.eventId !== command.eventId || state.inputHash !== command.inputHash) {
    throw new SecurityError("Forensic outbox correlation changed", "forensic_outbox_correlation_conflict");
  }
  if (command.type === "prepare") return prepare(state);
  if (command.type === "commit") return commit(state, command.evidence);
  if (command.type === "authorize-forward") return authorizeForward(state);
  if (command.type === "record-receipt") return recordReceipt(state, command.receipt);
  return fail(state, command.failureCode);
}

export function forensicOutboxCanForward(stateInput: unknown): boolean {
  const state = parseState(stateInput);
  return state.phase === "forwardable";
}

function prepare(state: ForensicOutboxState): ForensicOutboxState {
  if (state.phase === "received") return parseState({ ...state, phase: "prepared" });
  if (["prepared", "committed", "forwardable", "receipted"].includes(state.phase)) return state;
  return invalidTransition(state.phase, "prepare");
}

function commit(
  state: ForensicOutboxState,
  evidence: CommitEvidence,
): ForensicOutboxState {
  if (state.phase === "prepared") return parseState({ ...state, phase: "committed", evidence });
  if (state.phase === "committed" || state.phase === "forwardable" || state.phase === "receipted") {
    if (canonicalHash(state.evidence) === canonicalHash(evidence)) return state;
    throw new SecurityError("Forensic outbox commit evidence changed", "forensic_outbox_commit_conflict");
  }
  return invalidTransition(state.phase, "commit");
}

function authorizeForward(state: ForensicOutboxState): ForensicOutboxState {
  if (state.phase === "committed" && state.evidence !== undefined) {
    return parseState({ ...state, phase: "forwardable" });
  }
  if (state.phase === "forwardable" || state.phase === "receipted") return state;
  return invalidTransition(state.phase, "authorize-forward");
}

function recordReceipt(
  state: ForensicOutboxState,
  receipt: RecordedReceipt,
): ForensicOutboxState {
  if (state.phase === "receipted") {
    if (canonicalHash(state.receipt) === canonicalHash(receipt)) return state;
    throw new SecurityError("Forensic receipt changed", "forensic_receipt_conflict");
  }
  if (state.phase !== "forwardable" || state.evidence === undefined) {
    return invalidTransition(state.phase, "record-receipt");
  }
  if (receipt.eventId !== state.eventId || receipt.ledgerId !== state.evidence.ledgerId ||
    receipt.segmentId !== state.evidence.segmentId || receipt.sequence !== state.evidence.sequence ||
    receipt.entryHash !== state.evidence.entryHash ||
    receipt.entryMac !== state.evidence.entryMac || receipt.projectionHash !== state.evidence.projectionHash ||
    receipt.sealedPayloadHash !== state.evidence.sealedPayloadHash) {
    throw new SecurityError("Forensic receipt does not bind committed evidence", "forensic_receipt_binding_conflict");
  }
  return parseState({ ...state, phase: "receipted", receipt });
}

function fail(state: ForensicOutboxState, failureCode: string): ForensicOutboxState {
  if (state.phase === "receipted") return invalidTransition(state.phase, "fail");
  if (state.phase === "failed") {
    if (state.failureCode === failureCode) return state;
    throw new SecurityError("Forensic outbox failure code changed", "forensic_outbox_failure_conflict");
  }
  return parseState({ ...state, phase: "failed", failureCode });
}

function parseState(candidate: unknown): ForensicOutboxState {
  let snapshot: unknown;
  try {
    snapshot = snapshotJsonValue(candidate, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_outbox_state_invalid");
  } catch {
    throw new InputError("Forensic outbox state is invalid", "forensic_outbox_state_invalid");
  }
  const parsed = FORENSIC_OUTBOX_STATE_SCHEMA.safeParse(snapshot);
  if (!parsed.success) throw new InputError("Forensic outbox state is invalid", "forensic_outbox_state_invalid");
  return deepFreeze(parsed.data) as ForensicOutboxState;
}


function invalidTransition(phase: ForensicOutboxState["phase"], command: string): never {
  throw new SecurityError(
    `Forensic outbox cannot apply ${command} while ${phase}`,
    "forensic_outbox_transition_invalid",
  );
}
