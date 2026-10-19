import { observeUnexpectedPromise } from "../shared/best-effort.ts";
import { InputError, SecurityError } from "./errors.ts";
import { canonicalHash, deepFreeze } from "./integrity.ts";
import {
  assertNotProxy,
  snapshotJsonValue,
  type StructuralSnapshotLimits,
} from "./safe-structural.ts";
import {
  computeChainHash,
  nextLedgerSequence,
  LedgerPersistenceUncertainError,
  isLedgerPersistenceUncertainError,
  CORRELATION_FIELD_NAMES,
  DECIMAL_SEQUENCE_PATTERN,
  formatSequence,
  generateIdentifier,
  GENESIS_SEQUENCE,
  HEX_64_PATTERN,
  IDENTIFIER_PATTERN,
  MAXIMUM_CORRELATION_FIELDS,
  MAXIMUM_DESCRIPTION_BYTES,
  MAXIMUM_IDENTIFIER_CHARACTERS,
  MAXIMUM_SEQUENCE,
  ZERO_CHAIN_HASH,
} from "../timeline/ledger-primitives.ts";
import { schemaId, cryptoDomain } from "./product-identity.ts";

/**
 * Global execution closure.
 *
 * The forensic ledger primitives in `forensic-contracts.ts`, `forensic-state.ts`,
 * `forensic-crypto.ts`, and `ledger-canonical.ts` define how a single event is
 * canonicalized, chained, sealed, and persist-before-forward transitioned. They
 * do not by themselves guarantee that every harness-visible side effect is
 * recorded with no gaps: an operation can still occur outside the ledger and
 * leave no intent or terminal lineage.
 *
 * This module owns the missing half: the global execution closure. It is the
 * single in-process authority for the closed registry of effect kinds that must
 * be recorded, the intent/terminal lineage pairing that the canonical
 * requirements call the "end-to-end audit completeness oracle", the append-only
 * tamper-evident chain that makes any gap or tamper detectable, and the
 * crash-recovery surface that enumerates pending effects after a process loss.
 *
 * The closure is deliberately decoupled from physical storage (which remains
 * unavailable until the s3.2 storage slice). It is a pure, deterministic recorder
 * plus an independent completeness oracle. The future runtime, provider
 * adapters, tool executors, file editors, git lifecycle, and quality gates route
 * every side effect through `beginEffect` / `endEffect`; independent observers
 * register externally observed effects through `observeExternalEffect`; and the
 * release gate calls `assertClosureComplete` to make "any observed effect
 * without a durable intent plus exactly one terminal or recoverable-pending
 * lineage" a zero-tolerance failure instead of an invisible action.
 */

export const EXECUTION_CLOSURE_SCHEMA_VERSION = schemaId("execution-closure", 1);
export const EXECUTION_CLOSURE_DOMAIN =
  `${cryptoDomain("execution-closure-chain", 1)}\u0000` as const;
export const EXECUTION_CLOSURE_RECORD_DOMAIN =
  cryptoDomain("execution-closure-record", 1);

/** Closed registry of side-effect kinds that the completeness oracle inventories. */
export const EXECUTION_EFFECT_KINDS = deepFreeze([
  "provider",
  "network",
  "process",
  "filesystem",
  "git",
  "memory",
  "permission",
  "quality",
  "promotion",
  "ledger",
] as const);

export const EXECUTION_OUTCOMES = deepFreeze([
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "denied",
] as const);

export const EXECUTION_CLOSURE_REVISION = "execution-closure-global-lineage/v1" as const;

const EFFECT_KINDS = new Set<ExecutionEffectKind>(EXECUTION_EFFECT_KINDS);
const OUTCOMES = new Set<ExecutionOutcome>(EXECUTION_OUTCOMES);

export type ExecutionEffectKind = typeof EXECUTION_EFFECT_KINDS[number];
export type ExecutionOutcome = typeof EXECUTION_OUTCOMES[number];

export type ExecutionActor = Readonly<{
  kind: string;
  id: string;
  role?: string;
}>;

export type ExecutionCorrelation = Readonly<{
  runId?: string;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  taskId?: string;
  attemptId?: string;
  agentId?: string;
  parentEffectId?: string;
}>;

export type ExecutionTimestamp = Readonly<{
  wallTime: string;
  monotonicNanoseconds?: string;
}>;

export type ExecutionErrorSummary = Readonly<{
  category: string;
  code: string;
  message: string;
  retryable: boolean;
}>;

export type ExecutionIntent = Readonly<{
  schemaVersion: typeof EXECUTION_CLOSURE_SCHEMA_VERSION;
  recordKind: "intent";
  ledgerId: string;
  segmentId: string;
  effectId: string;
  kind: ExecutionEffectKind;
  actor: ExecutionActor;
  correlation: ExecutionCorrelation;
  description: string;
  intentHash: string;
  timestamp: ExecutionTimestamp;
  sequence: string;
  previousChainHash: string;
  chainHash: string;
}>;

export type ExecutionTerminal = Readonly<{
  schemaVersion: typeof EXECUTION_CLOSURE_SCHEMA_VERSION;
  recordKind: "terminal";
  ledgerId: string;
  segmentId: string;
  effectId: string;
  outcome: Exclude<ExecutionOutcome, "pending">;
  resultHash: string;
  timestamp: ExecutionTimestamp;
  sequence: string;
  previousChainHash: string;
  chainHash: string;
  error?: ExecutionErrorSummary;
}>;

export type ExecutionObservation = Readonly<{
  schemaVersion: typeof EXECUTION_CLOSURE_SCHEMA_VERSION;
  recordKind: "observation";
  ledgerId: string;
  segmentId: string;
  observationId: string;
  effectId?: string;
  kind: ExecutionEffectKind;
  evidenceHash: string;
  timestamp: ExecutionTimestamp;
  sequence: string;
  previousChainHash: string;
  chainHash: string;
}>;

export type ExecutionClosureRecord =
  | ExecutionIntent
  | ExecutionTerminal
  | ExecutionObservation;

export type ExecutionLineageStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "denied"
  | "orphaned-observation";

export type ExecutionLineage = Readonly<{
  effectId: string;
  kind: ExecutionEffectKind;
  intent?: ExecutionIntent;
  terminal?: ExecutionTerminal;
  observations: readonly ExecutionObservation[];
  status: ExecutionLineageStatus;
}>;

export type ExecutionClosureCompletenessViolation = Readonly<{
  code: string;
  effectId?: string;
  observationId?: string;
  detail: string;
}>;

export type ExecutionClosureCompletenessReport = Readonly<{
  complete: boolean;
  closureIntact: boolean;
  violationCount: number;
  pendingCount: number;
  terminalCount: number;
  observationCount: number;
  orphanedObservationCount: number;
  violations: readonly ExecutionClosureCompletenessViolation[];
}>;

export type ExecutionChainVerification = Readonly<{
  valid: boolean;
  verifiedRecords: number;
  breakAtSequence?: string;
  code?: "empty" | "previous-hash" | "record-hash" | "sequence" | "tamper";
}>;

export type ExecutionClosureClock = Readonly<{
  now(): ExecutionTimestamp;
}>;

export type ExecutionClosureOptions = Readonly<{
  ledgerId?: string;
  segmentId?: string;
  clock?: ExecutionClosureClock;
}>;

export type ExecutionIntentInput = Readonly<{
  effectId: string;
  kind: ExecutionEffectKind;
  actor: ExecutionActor;
  correlation?: ExecutionCorrelation;
  description: string;
  intentHash: string;
}>;

export type ExecutionTerminalInput = Readonly<{
  outcome: Exclude<ExecutionOutcome, "pending">;
  resultHash: string;
  error?: ExecutionErrorSummary;
}>;

export type ExecutionObservationInput = Readonly<{
  observationId: string;
  effectId?: string;
  kind: ExecutionEffectKind;
  evidenceHash: string;
}>;

export type ExecutionClosureSnapshot = Readonly<{
  schemaVersion: typeof EXECUTION_CLOSURE_SCHEMA_VERSION;
  ledgerId: string;
  segmentId: string;
  nextSequence: string;
  chainTipHash: string;
  records: readonly ExecutionClosureRecord[];
}>;

const EXECUTION_CLOSURE_SNAPSHOT_LIMITS: StructuralSnapshotLimits = deepFreeze({
  maximumDepth: 32,
  maximumNodes: 8192,
});

type ClosureState = {
  readonly ledgerId: string;
  readonly segmentId: string;
  readonly clock: ExecutionClosureClock;
  records: ExecutionClosureRecord[];
  intents: Map<string, ExecutionIntent>;
  terminals: Map<string, ExecutionTerminal>;
  observations: ExecutionObservation[];
  nextSequence: bigint;
  chainTipHash: string;
};

/** Synchronous, operation-local persistence of the admitted immutable record. */
export type ExecutionPersistence<T extends ExecutionClosureRecord> = (record: T) => undefined;

export type ExecutionClosure = Readonly<{
  readonly ledgerId: string;
  readonly segmentId: string;
  readonly revision: typeof EXECUTION_CLOSURE_REVISION;
  beginEffect(input: ExecutionIntentInput, persist?: ExecutionPersistence<ExecutionIntent>): ExecutionIntent;
  endEffect(effectId: string, input: ExecutionTerminalInput, persist?: ExecutionPersistence<ExecutionTerminal>): ExecutionTerminal;
  observeExternalEffect(input: ExecutionObservationInput, persist?: ExecutionPersistence<ExecutionObservation>): ExecutionObservation;
  lineage(): readonly ExecutionLineage[];
  pendingEffects(): readonly ExecutionIntent[];
  observations(): readonly ExecutionObservation[];
  assertClosureComplete(): ExecutionClosureCompletenessReport;
  verifyChain(): ExecutionChainVerification;
  snapshot(): ExecutionClosureSnapshot;
  nextSequence(): string;
  recordCount(): number;
}>;

export function isExecutionEffectKind(value: unknown): value is ExecutionEffectKind {
  return typeof value === "string" && EFFECT_KINDS.has(value as ExecutionEffectKind);
}

export function isExecutionOutcome(value: unknown): value is ExecutionOutcome {
  return typeof value === "string" && OUTCOMES.has(value as ExecutionOutcome);
}

export function createExecutionClosure(options: ExecutionClosureOptions = {}): ExecutionClosure {
  const ledgerId = options.ledgerId === undefined ? generateIdentifier("ledger") : validateIdentifier(options.ledgerId, "execution_ledger_id_invalid");
  const segmentId = options.segmentId === undefined ? generateIdentifier("segment") : validateIdentifier(options.segmentId, "execution_segment_id_invalid");
  const clock = options.clock ?? defaultExecutionClock();
  return sealClosure(freshState(ledgerId, segmentId, clock));
}

export function restoreExecutionClosure(snapshotInput: unknown): ExecutionClosure {
  const snapshot = parseSnapshot(snapshotInput);
  const state = restoreState(snapshot);
  return sealClosure(state);
}

/**
 * Non-throwing independent oracle. An external reviewer feeds a serialized
 * closure snapshot and receives a chain verification report instead of a live
 * recorder. This is the "end-to-end audit completeness oracle" entry point that
 * release gates and independent reviewers use to prove no tamper or gap before
 * trusting a captured run; `restoreExecutionClosure` is the throwing variant
 * that rebuilds a live recorder from a snapshot already judged sound.
 */
export function verifyExecutionClosureSnapshot(snapshotInput: unknown): ExecutionChainVerification {
  let snapshot: ExecutionClosureSnapshot;
  try {
    snapshot = parseSnapshot(snapshotInput);
  } catch {
    return deepFreeze({ valid: false, verifiedRecords: 0, code: "tamper" });
  }
  const replay = replayChainRecords(snapshot.records, snapshot.ledgerId, snapshot.segmentId);
  if (!replay.valid) {
    return chainReport(false, replay.verifiedRecords, replay.breakAtSequence, replay.code);
  }
  if (replay.recomputedTip !== snapshot.chainTipHash || replay.recomputedNextSequence !== snapshot.nextSequence) {
    return chainReport(false, replay.verifiedRecords, undefined, "tamper");
  }
  return chainReport(true, replay.verifiedRecords, undefined, replay.code);
}

function chainReport(valid: boolean, verifiedRecords: number, breakAtSequence: string | undefined, code: ExecutionChainVerification["code"]): ExecutionChainVerification {
  const base = { valid, verifiedRecords };
  if (breakAtSequence !== undefined && code !== undefined) {
    return deepFreeze({ ...base, breakAtSequence, code });
  }
  if (code !== undefined) {
    return deepFreeze({ ...base, code });
  }
  return deepFreeze(base);
}

function freshState(ledgerId: string, segmentId: string, clock: ExecutionClosureClock): ClosureState {
  return {
    ledgerId,
    segmentId,
    clock,
    records: [],
    intents: new Map<string, ExecutionIntent>(),
    terminals: new Map<string, ExecutionTerminal>(),
    observations: [],
    nextSequence: GENESIS_SEQUENCE,
    chainTipHash: ZERO_CHAIN_HASH,
  };
}

function restoreState(snapshot: ExecutionClosureSnapshot): ClosureState {
  const replay = replayChainRecords(snapshot.records, snapshot.ledgerId, snapshot.segmentId);
  if (!replay.valid) {
    throw new SecurityError("Restored execution closure chain is invalid", `execution_closure_restore_chain_${replay.code ?? "invalid"}`);
  }
  if (replay.recomputedTip !== snapshot.chainTipHash) {
    throw new SecurityError("Restored chain tip does not match recomputed tip", "execution_closure_restore_tip_drift");
  }
  if (replay.recomputedNextSequence !== snapshot.nextSequence) {
    throw new SecurityError("Restored next sequence does not match replayed sequence", "execution_closure_restore_sequence_drift");
  }
  const state = freshState(snapshot.ledgerId, snapshot.segmentId, defaultExecutionClock());
  state.nextSequence = parseSequence(snapshot.nextSequence);
  state.chainTipHash = snapshot.chainTipHash;
  const seen = new Set<string>();
  for (const record of snapshot.records) {
    if (record.recordKind === "intent") {
      if (seen.has(record.effectId)) {
        throw new SecurityError("Restored intent duplicates an effect identifier", "execution_closure_restore_duplicate");
      }
      seen.add(record.effectId);
      state.intents.set(record.effectId, record);
    } else if (record.recordKind === "terminal") {
      const intent = state.intents.get(record.effectId);
      if (intent === undefined) {
        throw new SecurityError("Restored terminal has no matching intent", "execution_closure_restore_orphan_terminal");
      }
      if (state.terminals.has(record.effectId)) {
        throw new SecurityError("Restored terminal duplicates an effect identifier", "execution_closure_restore_duplicate");
      }
      assertTerminalMatchesIntent(intent, record);
      state.terminals.set(record.effectId, record);
    } else {
      if (seen.has(record.observationId)) {
        throw new SecurityError("Restored observation duplicates an observation identifier", "execution_closure_restore_duplicate");
      }
      seen.add(record.observationId);
      state.observations.push(record);
    }
    state.records.push(record);
  }
  return state;
}

function sealClosure(state: ClosureState): ExecutionClosure {
  let mutating = false;
  let persistenceUncertain = false;
  function mutate<T extends ExecutionClosureRecord>(
    persist: ExecutionPersistence<T> | undefined,
    prepareAndCommit: (persist: ExecutionPersistence<T> | undefined) => T,
  ): T {
    if (persistenceUncertain) throw new LedgerPersistenceUncertainError();
    if (mutating) throw new SecurityError("Execution mutation is reentrant", "execution_mutation_reentrant");
    mutating = true;
    try {
      if (persist !== undefined) {
        assertNotProxy(persist, "execution_persistence_invalid");
        if (typeof persist !== "function") throw new InputError("Execution persistence callback is invalid", "execution_persistence_invalid");
      }
      return prepareAndCommit(persist === undefined ? undefined : (record) => {
        const result: unknown = persist(record);
        if (result !== undefined) {
          // Never await persistence: asynchronous completion cannot authorize a
          // synchronous memory commit. Observe a native Promise rejection only.
          persistenceUncertain = true;
          observeUnexpectedPromise(result);
          throw new LedgerPersistenceUncertainError();
        }
        return undefined;
      });
    } catch (error) {
      if (isLedgerPersistenceUncertainError(error)) persistenceUncertain = true;
      throw error;
    } finally {
      mutating = false;
    }
  }
  const beginEffect = (input: ExecutionIntentInput, persist?: ExecutionPersistence<ExecutionIntent>): ExecutionIntent =>
    mutate(persist, (admitted) => recordIntent(state, input, admitted));
  const endEffect = (effectId: string, input: ExecutionTerminalInput, persist?: ExecutionPersistence<ExecutionTerminal>): ExecutionTerminal =>
    mutate(persist, (admitted) => recordTerminal(state, effectId, input, admitted));
  const observeExternalEffect = (input: ExecutionObservationInput, persist?: ExecutionPersistence<ExecutionObservation>): ExecutionObservation =>
    mutate(persist, (admitted) => recordObservation(state, input, admitted));
  const lineage = (): readonly ExecutionLineage[] => computeLineage(state);
  const pendingEffects = (): readonly ExecutionIntent[] => [...state.intents.values()]
    .filter((intent) => !state.terminals.has(intent.effectId))
    .toSorted(compareBySequence);
  const observations = (): readonly ExecutionObservation[] => [...state.observations].toSorted(compareBySequence);
  const assertClosureComplete = (): ExecutionClosureCompletenessReport => computeCompleteness(state);
  const verifyChain = (): ExecutionChainVerification => verifyChainRecords(state);
  const snapshot = (): ExecutionClosureSnapshot => makeSnapshot(state);
  const nextSequence = (): string => formatSequence(state.nextSequence);
  const recordCount = (): number => state.records.length;
  return deepFreeze({
    ledgerId: state.ledgerId,
    segmentId: state.segmentId,
    revision: EXECUTION_CLOSURE_REVISION,
    beginEffect,
    endEffect,
    observeExternalEffect,
    lineage,
    pendingEffects,
    observations,
    assertClosureComplete,
    verifyChain,
    snapshot,
    nextSequence,
    recordCount,
  });
}

/**
 * THE ADMITTED FIELDS OF AN EFFECT'S RECORDS — one validation owner for the
 * in-memory closure and the persisted timeline recorder (which keeps no
 * closure: SCALE-CR1 C6). Pure: no clock, no chain, no state; the caller
 * reads the time ({@link readExecutionTimestamp}) once the record is admitted.
 */
export type ExecutionIntentFields = Readonly<Pick<ExecutionIntent, "effectId" | "kind" | "actor" | "correlation" | "description" | "intentHash">>;
export type ExecutionTerminalFields = Readonly<Pick<ExecutionTerminal, "effectId" | "outcome" | "resultHash" | "error">>;
export type ExecutionObservationFields = Readonly<Pick<ExecutionObservation, "observationId" | "effectId" | "kind" | "evidenceHash">>;

export function admitIntentInput(input: ExecutionIntentInput): ExecutionIntentFields {
  assertNotProxy(input, "execution_intent_input_invalid");
  const effectId = validateIdentifier(input.effectId, "execution_effect_id_invalid");
  const kind = input.kind;
  if (!isExecutionEffectKind(kind)) {
    throw new InputError("Execution effect kind is invalid", "execution_effect_kind_invalid");
  }
  const actor = validateActor(input.actor);
  const correlation = validateCorrelation(input.correlation);
  const description = validateDescription(input.description);
  const intentHash = validateHash(input.intentHash, "execution_intent_hash_invalid");
  return deepFreeze({ effectId, kind, actor, correlation, description, intentHash });
}

export function admitTerminalInput(effectIdInput: string, input: ExecutionTerminalInput): ExecutionTerminalFields {
  assertNotProxy(input, "execution_terminal_input_invalid");
  const effectId = validateIdentifier(effectIdInput, "execution_effect_id_invalid");
  const outcome = validateTerminalOutcome(input.outcome);
  const resultHash = validateHash(input.resultHash, "execution_result_hash_invalid");
  const inputError = input.error;
  const error = inputError === undefined ? undefined : validateErrorSummary(inputError);
  return deepFreeze({ effectId, outcome, resultHash, ...(error === undefined ? {} : { error }) });
}

export function admitObservationInput(input: ExecutionObservationInput): ExecutionObservationFields {
  assertNotProxy(input, "execution_observation_input_invalid");
  const observationId = validateIdentifier(input.observationId, "execution_observation_id_invalid");
  const kind = input.kind;
  if (!isExecutionEffectKind(kind)) {
    throw new InputError("Execution effect kind is invalid", "execution_effect_kind_invalid");
  }
  const evidenceHash = validateHash(input.evidenceHash, "execution_evidence_hash_invalid");
  const inputEffectId = input.effectId;
  const effectId = inputEffectId === undefined ? undefined : validateIdentifier(inputEffectId, "execution_effect_id_invalid");
  return deepFreeze({ observationId, ...(effectId === undefined ? {} : { effectId }), kind, evidenceHash });
}

/** The clock's reading, snapshotted (no accessor of the clock's value runs twice) and validated. */
export function readExecutionTimestamp(clock: ExecutionClosureClock): ExecutionTimestamp {
  const timestamp = snapshotJsonValue(clock.now(), EXECUTION_CLOSURE_SNAPSHOT_LIMITS, "execution_timestamp_invalid") as ExecutionTimestamp;
  validateTimestamp(timestamp);
  return timestamp;
}

function recordIntent(state: ClosureState, input: ExecutionIntentInput, persist?: ExecutionPersistence<ExecutionIntent>): ExecutionIntent {
  const { effectId, kind, actor, correlation, description, intentHash } = admitIntentInput(input);
  if (state.intents.has(effectId)) {
    throw new SecurityError("Effect identifier is already recorded", "execution_effect_duplicate");
  }
  const sequence = state.nextSequence;
  const previousChainHash = state.chainTipHash;
  const timestamp = readExecutionTimestamp(state.clock);
  const envelope: ExecutionIntent = deepFreeze({
    schemaVersion: EXECUTION_CLOSURE_SCHEMA_VERSION,
    recordKind: "intent",
    ledgerId: state.ledgerId,
    segmentId: state.segmentId,
    effectId,
    kind,
    actor,
    correlation,
    description,
    intentHash,
    timestamp,
    sequence: formatSequence(sequence),
    previousChainHash,
    chainHash: "",
  });
  const chainHash = computeChainHash(EXECUTION_CLOSURE_DOMAIN, previousChainHash, envelopeWithoutChain(envelope));
  const intent: ExecutionIntent = deepFreeze({ ...envelope, chainHash });
  appendRecord(state, intent, persist);
  state.intents.set(effectId, intent);
  return intent;
}

function recordTerminal(state: ClosureState, effectIdInput: string, input: ExecutionTerminalInput, persist?: ExecutionPersistence<ExecutionTerminal>): ExecutionTerminal {
  const { effectId, outcome, resultHash, error } = admitTerminalInput(effectIdInput, input);
  const intent = state.intents.get(effectId);
  if (intent === undefined) {
    throw new SecurityError("Terminal recorded for an unknown effect", "execution_terminal_orphan");
  }
  if (state.terminals.has(effectId)) {
    throw new SecurityError("Effect already has a terminal record", "execution_terminal_duplicate");
  }
  const sequence = state.nextSequence;
  const previousChainHash = state.chainTipHash;
  const timestamp = readExecutionTimestamp(state.clock);
  const envelope: ExecutionTerminal = deepFreeze({
    schemaVersion: EXECUTION_CLOSURE_SCHEMA_VERSION,
    recordKind: "terminal",
    ledgerId: state.ledgerId,
    segmentId: state.segmentId,
    effectId,
    outcome,
    resultHash,
    timestamp,
    sequence: formatSequence(sequence),
    previousChainHash,
    chainHash: "",
    ...(error === undefined ? {} : { error }),
  });
  const chainHash = computeChainHash(EXECUTION_CLOSURE_DOMAIN, previousChainHash, envelopeWithoutChain(envelope));
  const terminal: ExecutionTerminal = deepFreeze({ ...envelope, chainHash });
  assertTerminalMatchesIntent(intent, terminal);
  appendRecord(state, terminal, persist);
  state.terminals.set(effectId, terminal);
  return terminal;
}

function recordObservation(state: ClosureState, input: ExecutionObservationInput, persist?: ExecutionPersistence<ExecutionObservation>): ExecutionObservation {
  const { observationId, effectId, kind, evidenceHash } = admitObservationInput(input);
  if (state.observations.some((observation) => observation.observationId === observationId)) {
    throw new SecurityError("Observation identifier is already recorded", "execution_observation_duplicate");
  }
  const sequence = state.nextSequence;
  const previousChainHash = state.chainTipHash;
  const timestamp = readExecutionTimestamp(state.clock);
  const envelope: ExecutionObservation = deepFreeze({
    schemaVersion: EXECUTION_CLOSURE_SCHEMA_VERSION,
    recordKind: "observation",
    ledgerId: state.ledgerId,
    segmentId: state.segmentId,
    observationId,
    ...(effectId === undefined ? {} : { effectId }),
    kind,
    evidenceHash,
    timestamp,
    sequence: formatSequence(sequence),
    previousChainHash,
    chainHash: "",
  });
  const chainHash = computeChainHash(EXECUTION_CLOSURE_DOMAIN, previousChainHash, envelopeWithoutChain(envelope));
  const observation: ExecutionObservation = deepFreeze({ ...envelope, chainHash });
  appendRecord(state, observation, persist);
  state.observations.push(observation);
  return observation;
}

function appendRecord<T extends ExecutionClosureRecord>(state: ClosureState, record: T, persist?: ExecutionPersistence<T>): void {
  const successor = nextLedgerSequence(state.nextSequence, "execution_sequence_exhausted");
  persist?.(record);
  state.records.push(record);
  state.nextSequence = successor;
  state.chainTipHash = record.chainHash;
}

function computeLineage(state: ClosureState): readonly ExecutionLineage[] {
  const lineages = new Map<string, ExecutionLineage>();
  for (const intent of state.intents.values()) {
    const terminal = state.terminals.get(intent.effectId);
    const observed = state.observations.filter((observation) => observation.effectId === intent.effectId);
    lineages.set(intent.effectId, deepFreeze({
      effectId: intent.effectId,
      kind: intent.kind,
      intent,
      ...(terminal === undefined ? {} : { terminal }),
      observations: observed,
      status: terminalOutcomeStatus(terminal),
    }));
  }
  for (const observation of state.observations) {
    if (observation.effectId !== undefined) continue;
    if (lineages.has(observation.observationId)) continue;
    lineages.set(observation.observationId, deepFreeze({
      effectId: observation.observationId,
      kind: observation.kind,
      observations: [observation],
      status: "orphaned-observation",
    }));
  }
  return [...lineages.values()].toSorted(compareLineageBySequence);
}

function computeCompleteness(state: ClosureState): ExecutionClosureCompletenessReport {
  const violations: ExecutionClosureCompletenessViolation[] = [];
  for (const observation of state.observations) {
    const effectId = observation.effectId;
    if (effectId === undefined) {
      violations.push({
        code: "execution_closure_orphaned_observation",
        observationId: observation.observationId,
        detail: `Observation ${observation.observationId} for ${observation.kind} is unattributed`,
      });
      continue;
    }
    if (!state.intents.has(effectId)) {
      violations.push({
        code: "execution_closure_orphaned_observation",
        observationId: observation.observationId,
        effectId,
        detail: `Observation ${observation.observationId} references unrecorded effect ${effectId}`,
      });
    }
  }
  const chain = verifyChainRecords(state);
  if (!chain.valid) {
    violations.push({
      code: "execution_closure_chain_broken",
      detail: `Chain verification failed at ${chain.breakAtSequence ?? "unknown"} (${chain.code ?? "unknown"})`,
    });
  }
  const pendingCount = state.intents.size - state.terminals.size;
  const orphanedObservationCount = violations.filter((violation) => violation.code === "execution_closure_orphaned_observation").length;
  return deepFreeze({
    complete: violations.length === 0,
    closureIntact: chain.valid,
    violationCount: violations.length,
    pendingCount,
    terminalCount: state.terminals.size,
    observationCount: state.observations.length,
    orphanedObservationCount,
    violations,
  });
}

function verifyChainRecords(state: ClosureState): ExecutionChainVerification {
  const replay = replayChainRecords(state.records, state.ledgerId, state.segmentId);
  if (!replay.valid) return chainReport(false, replay.verifiedRecords, replay.breakAtSequence, replay.code);
  if (replay.recomputedTip !== state.chainTipHash) {
    return chainReport(false, replay.verifiedRecords, undefined, "tamper");
  }
  return chainReport(true, replay.verifiedRecords, undefined, replay.code);
}

type ChainReplay = Readonly<{
  valid: boolean;
  verifiedRecords: number;
  breakAtSequence?: string;
  code?: NonNullable<ExecutionChainVerification["code"]>;
  recomputedTip: string;
  recomputedNextSequence: string;
}>;

function replayChainRecords(
  records: readonly ExecutionClosureRecord[],
  ledgerId: string,
  segmentId: string,
): ChainReplay {
  if (records.length === 0) {
    return deepFreeze({
      valid: true,
      verifiedRecords: 0,
      code: "empty",
      recomputedTip: ZERO_CHAIN_HASH,
      recomputedNextSequence: formatSequence(GENESIS_SEQUENCE),
    });
  }
  let expectedSequence = GENESIS_SEQUENCE;
  let previousHash = ZERO_CHAIN_HASH;
  let verified = 0;
  for (const record of records) {
    assertRecordKind(record);
    assertRecordCoordinate(record, ledgerId, segmentId);
    if (parseSequence(record.sequence) !== expectedSequence) {
      return replayFailure("sequence", verified, record.sequence);
    }
    if (record.previousChainHash !== previousHash) {
      return replayFailure("previous-hash", verified, record.sequence);
    }
    const recomputed = computeChainHash(EXECUTION_CLOSURE_DOMAIN, record.previousChainHash, envelopeWithoutChain(record));
    if (recomputed !== record.chainHash) {
      return replayFailure("record-hash", verified, record.sequence);
    }
    previousHash = record.chainHash;
    expectedSequence += 1n;
    verified += 1;
  }
  return deepFreeze({
    valid: true,
    verifiedRecords: verified,
    recomputedTip: previousHash,
    recomputedNextSequence: formatSequence(expectedSequence),
  });
}

function replayFailure(code: NonNullable<ExecutionChainVerification["code"]>, verified: number, breakAtSequence: string): ChainReplay {
  return deepFreeze({
    valid: false,
    verifiedRecords: verified,
    breakAtSequence,
    code,
    recomputedTip: ZERO_CHAIN_HASH,
    recomputedNextSequence: formatSequence(GENESIS_SEQUENCE),
  });
}

function makeSnapshot(state: ClosureState): ExecutionClosureSnapshot {
  return deepFreeze({
    schemaVersion: EXECUTION_CLOSURE_SCHEMA_VERSION,
    ledgerId: state.ledgerId,
    segmentId: state.segmentId,
    nextSequence: formatSequence(state.nextSequence),
    chainTipHash: state.chainTipHash,
    records: [...state.records],
  });
}

function terminalOutcomeStatus(terminal: ExecutionTerminal | undefined): ExecutionLineageStatus {
  if (terminal === undefined) return "pending";
  return terminal.outcome;
}

function envelopeWithoutChain(record: ExecutionClosureRecord): Readonly<Record<string, unknown>> {
  const { chainHash: _omitted, ...rest } = record;
  void _omitted;
  return rest as Readonly<Record<string, unknown>>;
}

function assertTerminalMatchesIntent(intent: ExecutionIntent, terminal: ExecutionTerminal): void {
  if (intent.ledgerId !== terminal.ledgerId || intent.segmentId !== terminal.segmentId ||
    intent.effectId !== terminal.effectId) {
    throw new SecurityError("Terminal does not bind to its intent", "execution_terminal_binding_conflict");
  }
}

function assertRecordKind(record: unknown): void {
  if (record === null || typeof record !== "object") {
    throw new InputError("Restored record is not an object", "execution_closure_restore_record_invalid");
  }
  const kind = (record as Readonly<Record<string, unknown>>).recordKind;
  if (kind !== "intent" && kind !== "terminal" && kind !== "observation") {
    throw new InputError("Restored record kind is invalid", "execution_closure_restore_record_invalid");
  }
}

function assertRecordCoordinate(record: ExecutionClosureRecord, ledgerId: string, segmentId: string): void {
  if (record.ledgerId !== ledgerId || record.segmentId !== segmentId) {
    throw new SecurityError("Restored record coordinate drift", "execution_closure_restore_coordinate_drift");
  }
}

function parseSnapshot(snapshotInput: unknown): ExecutionClosureSnapshot {
  assertNotProxy(snapshotInput, "execution_snapshot_invalid");
  const snapshot = snapshotJsonValue(snapshotInput, EXECUTION_CLOSURE_SNAPSHOT_LIMITS, "execution_snapshot_invalid") as ExecutionClosureSnapshot;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new InputError("Execution closure snapshot is invalid", "execution_snapshot_invalid");
  }
  const raw = snapshot as Readonly<Record<string, unknown>>;
  if (raw.schemaVersion !== EXECUTION_CLOSURE_SCHEMA_VERSION) {
    throw new InputError("Execution closure snapshot schema version is invalid", "execution_snapshot_invalid");
  }
  if (typeof raw.ledgerId !== "string" || typeof raw.segmentId !== "string" ||
    typeof raw.nextSequence !== "string" || typeof raw.chainTipHash !== "string" ||
    !Array.isArray(raw.records)) {
    throw new InputError("Execution closure snapshot shape is invalid", "execution_snapshot_invalid");
  }
  validateIdentifier(raw.ledgerId, "execution_snapshot_invalid");
  validateIdentifier(raw.segmentId, "execution_snapshot_invalid");
  parseSequence(raw.nextSequence);
  validateHash(raw.chainTipHash, "execution_snapshot_invalid");
  return snapshot;
}

function validateIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_IDENTIFIER_CHARACTERS ||
    !IDENTIFIER_PATTERN.test(value)) {
    throw new InputError("Execution identifier is invalid", code);
  }
  return value;
}

function validateHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    throw new InputError("Execution hash is invalid", code);
  }
  return value;
}

function validateDescription(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_DESCRIPTION_BYTES) {
    throw new InputError("Execution description is invalid", "execution_description_invalid");
  }
  return value;
}

function validateActor(input: unknown): ExecutionActor {
  const snapshot = snapshotJsonValue(input, EXECUTION_CLOSURE_SNAPSHOT_LIMITS, "execution_actor_invalid");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new InputError("Execution actor is invalid", "execution_actor_invalid");
  }
  const raw = snapshot as Readonly<Record<string, unknown>>;
  const kind = validateIdentifier(raw.kind, "execution_actor_invalid");
  const id = validateIdentifier(raw.id, "execution_actor_invalid");
  const role = raw.role === undefined ? undefined : validateIdentifier(raw.role, "execution_actor_invalid");
  return deepFreeze({ kind, id, ...(role === undefined ? {} : { role }) });
}

function validateCorrelation(input: unknown): ExecutionCorrelation {
  if (input === undefined) return deepFreeze({});
  const snapshot = snapshotJsonValue(input, EXECUTION_CLOSURE_SNAPSHOT_LIMITS, "execution_correlation_invalid");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new InputError("Execution correlation is invalid", "execution_correlation_invalid");
  }
  const raw = snapshot as Readonly<Record<string, unknown>>;
  const allowed = CORRELATION_FIELD_NAMES;
  const keys = Object.keys(raw);
  if (keys.length > MAXIMUM_CORRELATION_FIELDS) {
    throw new InputError("Execution correlation exceeds field ceiling", "execution_correlation_invalid");
  }
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new InputError("Execution correlation field is invalid", "execution_correlation_invalid");
    }
    const value = raw[key];
    if (value === undefined) continue;
    result[key] = validateIdentifier(value, "execution_correlation_invalid");
  }
  return deepFreeze(result);
}

function validateErrorSummary(input: unknown): ExecutionErrorSummary {
  const snapshot = snapshotJsonValue(input, EXECUTION_CLOSURE_SNAPSHOT_LIMITS, "execution_error_invalid");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new InputError("Execution error summary is invalid", "execution_error_invalid");
  }
  const raw = snapshot as Readonly<Record<string, unknown>>;
  const category = validateIdentifier(raw.category, "execution_error_invalid");
  const code = validateIdentifier(raw.code, "execution_error_invalid");
  if (typeof raw.message !== "string" || raw.message.length === 0 ||
    Buffer.byteLength(raw.message, "utf8") > MAXIMUM_DESCRIPTION_BYTES) {
    throw new InputError("Execution error message is invalid", "execution_error_invalid");
  }
  if (typeof raw.retryable !== "boolean") {
    throw new InputError("Execution error retryable flag is invalid", "execution_error_invalid");
  }
  return deepFreeze({ category, code, message: raw.message, retryable: raw.retryable });
}

function validateTerminalOutcome(value: unknown): Exclude<ExecutionOutcome, "pending"> {
  if (typeof value !== "string" || value === "pending" || !OUTCOMES.has(value as ExecutionOutcome)) {
    throw new InputError("Execution terminal outcome is invalid", "execution_outcome_invalid");
  }
  return value as Exclude<ExecutionOutcome, "pending">;
}

function validateTimestamp(timestamp: ExecutionTimestamp): void {
  if (typeof timestamp.wallTime !== "string" || timestamp.wallTime.length === 0 ||
    timestamp.wallTime.length > 64) {
    throw new InputError("Execution timestamp is invalid", "execution_timestamp_invalid");
  }
  if (timestamp.monotonicNanoseconds !== undefined) {
    if (typeof timestamp.monotonicNanoseconds !== "string" ||
      !DECIMAL_SEQUENCE_PATTERN.test(timestamp.monotonicNanoseconds)) {
      throw new InputError("Execution monotonic time is invalid", "execution_timestamp_invalid");
    }
  }
}

function parseSequence(value: string): bigint {
  if (typeof value !== "string" || !DECIMAL_SEQUENCE_PATTERN.test(value)) {
    throw new InputError("Execution sequence is invalid", "execution_sequence_invalid");
  }
  const parsed = BigInt(value);
  if (parsed < GENESIS_SEQUENCE || parsed > MAXIMUM_SEQUENCE) {
    throw new InputError("Execution sequence is out of range", "execution_sequence_invalid");
  }
  return parsed;
}

function compareBySequence(left: { sequence: string }, right: { sequence: string }): number {
  const leftSequence = BigInt(left.sequence);
  const rightSequence = BigInt(right.sequence);
  if (leftSequence < rightSequence) return -1;
  if (leftSequence > rightSequence) return 1;
  return 0;
}

function compareLineageBySequence(left: ExecutionLineage, right: ExecutionLineage): number {
  const leftSequence = left.intent?.sequence ?? left.observations[0]?.sequence ?? "0";
  const rightSequence = right.intent?.sequence ?? right.observations[0]?.sequence ?? "0";
  return compareBySequence({ sequence: leftSequence }, { sequence: rightSequence });
}

/** The wall clock plus the monotonic clock: the default of the closure and of the persisted recorder. */
export function defaultExecutionClock(): ExecutionClosureClock {
  return Object.freeze({
    now: (): ExecutionTimestamp => {
      const wallTime = new Date().toISOString();
      const monotonicNanoseconds = String(BigInt(Math.round(performance.now() * 1_000_000)));
      return deepFreeze({ wallTime, monotonicNanoseconds });
    },
  });
}

export const EXECUTION_CLOSURE_IDENTITY = deepFreeze({
  schemaVersion: EXECUTION_CLOSURE_SCHEMA_VERSION,
  revision: EXECUTION_CLOSURE_REVISION,
  domain: EXECUTION_CLOSURE_DOMAIN,
  effectKinds: EXECUTION_EFFECT_KINDS,
  outcomes: EXECUTION_OUTCOMES,
  recordDomain: EXECUTION_CLOSURE_RECORD_DOMAIN,
});

export const EXECUTION_CLOSURE_IDENTITY_HASH = canonicalHash(EXECUTION_CLOSURE_IDENTITY);
