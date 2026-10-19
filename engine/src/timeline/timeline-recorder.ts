import { assertTerminalProvenanceAbsent, isLedgerPersistenceUncertainError, snapshotLedgerInput } from "./ledger-primitives.ts";
import { types as nodeTypes } from "node:util";
import { HarnessError, InputError, SecurityError } from "../kernel/errors.ts";
import { currentRecordingContext } from "./recording-context.ts";
import { deepFreeze, generateId, generateShortId, sha256 } from "../kernel/integrity.ts";
import {
  admitIntentInput,
  admitObservationInput,
  admitTerminalInput,
  defaultExecutionClock,
  readExecutionTimestamp,
  type ExecutionClosureClock,
  type ExecutionEffectKind,
  type ExecutionIntentFields,
  type ExecutionIntentInput,
  type ExecutionObservationFields,
  type ExecutionObservationInput,
  type ExecutionTerminalFields,
  type ExecutionTerminalInput,
  type ExecutionTimestamp,
} from "../kernel/execution-closure.ts";
import type {
  EventLedgerStoragePort,
  TimelineChainVerification,
  TimelineDocumentInput,
  TimelineEdgeInput,
  TimelineEventRecord,
  TimelineEdgeType,
  TimelineErrorSummary,
  TimelineEventType,
  TimelineOutcome,
  TimelineQueryFilter,
  TimelineQueryResult,
} from "./timeline-types.ts";
// The recurring document names this recorder WRITES — one import path (the
// vocabulary module's re-export of the shared wire-literals owner), so the
// writer and every reader join on the same name by construction.
import {
  TIMELINE_FILE_EFFECT_DOCUMENT,
  TIMELINE_PREIMAGE_DOCUMENT,
  TIMELINE_TOKEN_USAGE_DOCUMENT,
} from "./timeline-types.ts";
// The resource-sample document's name — owned by the shared wire-literals
// file with every other recurring document name, so a reader joins on the
// recorded name rather than a literal restated beside the writer.
import { TIMELINE_RESOURCE_METRIC_DOCUMENT } from "../../../shared/constants.ts";
import { createTimelineQuery, type TimelineQuery } from "./timeline-query.ts";
import { createRollbackController, type RollbackController } from "./rollback.ts";

/**
 * Timeline recorder — the unified runtime API over the durable
 * `EventLedgerStoragePort` (persistent append-only event ledger, queryable
 * projections).
 *
 * `beginEffect`/`endEffect`/`observeExternalEffect` admit their input through
 * the execution-closure validators (one owner of what an intent, a terminal
 * and an observation may hold) and append it to the store; the STORE is the
 * one pairing owner (`resolveLineage`: no duplicate intent, no orphan or
 * second terminal, the terminal's type equal to its intent's). The recorder
 * keeps NO in-memory closure: an in-process copy of every record grew by
 * about 1.6 KB per paired effect for the life of the process (SCALE-CR1 C6,
 * an uncatchable out-of-memory in hours at scale). What is pending is asked
 * of the store (`pendingEffects`, one indexed scan).
 *
 * The recorder also exposes `recordEvent` for standalone timeline events
 * that are not side-effect intents (run start, turn start, message content,
 * token usage, resource metrics).
 */

export type TimelineRecorderOptions = Readonly<{
  store: EventLedgerStoragePort;
  clock?: ExecutionClosureClock;
  actor?: Readonly<{ kind: string; id: string; role?: string }>;
  correlation?: Readonly<{
    runId?: string;
    sessionId?: string;
    agentId?: string;
  }>;
}>;

export type TimelineRecorder = Readonly<{
  readonly ledgerId: string;
  readonly store: EventLedgerStoragePort;
  readonly query: TimelineQuery;
  readonly rollback: RollbackController;

  beginEffect(input: ExecutionIntentInput, evidence?: TimelineEffectEvidence): RecordedExecution<TimelineEffectIntent>;
  endEffect(effectId: string, input: ExecutionTerminalInput, evidence?: TimelineEffectEvidence): RecordedExecution<TimelineEffectTerminal>;
  observeExternalEffect(input: ExecutionObservationInput, evidence?: TimelineEffectEvidence): RecordedExecution<TimelineEffectObservation>;
  recordEvent(input: TimelineEventRecordInput): TimelineStoreRecordResult;

  recordRun(input: TimelineLifecycleInput): TimelineStoreRecordResult;
  recordTurn(input: TimelineLifecycleInput): TimelineStoreRecordResult;
  recordMessage(input: TimelineLifecycleInput): TimelineStoreRecordResult;
  recordTokenUsage(input: TimelineTokenUsageInput): TimelineStoreRecordResult;
  recordResource(input: TimelineResourceInput): TimelineStoreRecordResult;
  recordTest(input: TimelineTestInput): TimelineStoreRecordResult;
  recordGitOperation(input: TimelineGitInput): TimelineStoreRecordResult;
  recordCommit(input: TimelineCommitInput): TimelineStoreRecordResult;
  recordFileEffect(input: TimelineFileEffectInput): TimelineStoreRecordResult;

  /** The intents of this ledger with no terminal, from the store (never an in-memory copy). */
  pendingEffects(): readonly TimelineEventRecord[];
  verifyTimelineChain(ledgerId?: string): TimelineChainVerification;
  rebuildProjections(): void;

  close(): void;
}>;

/** An admitted effect record with the time it was taken (no in-memory chain: the store's chain is the one). */
export type TimelineEffectIntent = ExecutionIntentFields & Readonly<{ timestamp: ExecutionTimestamp }>;
export type TimelineEffectTerminal = ExecutionTerminalFields & Readonly<{ timestamp: ExecutionTimestamp }>;
export type TimelineEffectObservation = ExecutionObservationFields & Readonly<{ timestamp: ExecutionTimestamp }>;

/** Exact acknowledged store identity; it does not assert fsync or full payload retention. */
export type RecordedExecution<T extends TimelineEffectIntent | TimelineEffectTerminal | TimelineEffectObservation> = Readonly<{
  record: T;
  receipt: TimelineStoreRecordResult;
}>;

export type TimelineEffectEvidence = Readonly<{
  documents?: readonly TimelineDocumentInput[];
  edges?: readonly TimelineEdgeInput[];
}>;

function snapshotEvidence(evidence: TimelineEffectEvidence = {}): TimelineEffectEvidence {
  const snapshot = snapshotLedgerInput(evidence, "timeline_evidence_invalid");
  if (Object.keys(snapshot).some((key) => key !== "documents" && key !== "edges")) {
    throw new InputError("Timeline evidence fields are invalid", "timeline_evidence_invalid");
  }
  return snapshot as TimelineEffectEvidence;
}

function storeReceipt(record: TimelineEventRecord): TimelineStoreRecordResult {
  return deepFreeze({ eventId: record.eventId, sequence: record.sequence, chainHash: record.chainHash });
}

export type TimelineEventRecordInput = Readonly<{
  eventType: TimelineEventType;
  description: string;
  correlation?: Readonly<{
    runId?: string;
    sessionId?: string;
    turnId?: string;
    messageId?: string;
    taskId?: string;
    attemptId?: string;
    agentId?: string;
    parentEffectId?: string;
  }>;
  parentEventId?: string;
  outcome?: TimelineOutcome;
  /**
   * Failure detail as one complete value, mirroring the store's
   * `TimelineStandaloneEventInput.error`.
   *
   * Kept the same shape at BOTH levels deliberately. Had the recorder retained
   * four independent optional fields and assembled them on the way down, the
   * "code without category" hole would simply have moved up one layer — the
   * recorder would be the thing deciding what to do with a half-stated error,
   * which is how it got dropped in the first place. There is nothing to decide
   * when the incomplete state cannot be expressed.
   */
  error?: TimelineErrorSummary;
  documents?: readonly TimelineDocumentInput[];
  edges?: readonly Readonly<{
    edgeType: TimelineEdgeType;
    targetEventId?: string;
    targetKind?: string;
    targetId?: string;
  }>[];
}>;

export type TimelineLifecycleInput = Readonly<{
  description: string;
  correlation: Readonly<{ runId: string; turnId?: string; messageId?: string; sessionId?: string }>;
  parentEventId?: string;
  outcome?: TimelineOutcome;
  documents?: readonly TimelineDocumentInput[];
}>;

export type TimelineTokenUsageInput = Readonly<{
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  correlation: Readonly<{ runId: string; turnId: string }>;
  parentEventId?: string;
  outcome?: TimelineOutcome;
}>;

export type TimelineResourceInput = Readonly<{
  metric: string;
  value: number;
  unit: string;
  correlation: Readonly<{ runId?: string; turnId?: string }>;
  parentEventId?: string;
  outcome?: TimelineOutcome;
}>;

export type TimelineTestInput = Readonly<{
  description: string;
  passed: boolean;
  testCount: number;
  correlation: Readonly<{ runId?: string; turnId?: string }>;
}>;

export type TimelineGitInput = Readonly<{
  operation: string;
  description: string;
  correlation: Readonly<{ runId?: string; turnId?: string }>;
}>;

export type TimelineCommitInput = Readonly<{
  commitSha: string;
  description: string;
  correlation: Readonly<{ runId?: string; turnId?: string }>;
}>;

export type TimelineFileEffectInput = Readonly<{
  effectId: string;
  path: string;
  operation: "write" | "delete" | "mkdir";
  preimageDigest: string;
  postimageDigest: string;
  description: string;
  correlation: Readonly<{ runId?: string; turnId?: string; agentId?: string }>;
  preimageContent?: string;
}>;

export type TimelineStoreRecordResult = Readonly<{
  eventId: string;
  sequence: string;
  chainHash: string;
}>;

const EFFECT_KIND_TO_EVENT_TYPE: Readonly<Record<ExecutionEffectKind, TimelineEventType>> = Object.freeze({
  provider: "provider",
  network: "network",
  process: "process",
  filesystem: "filesystem",
  git: "git",
  memory: "memory",
  permission: "permission",
  quality: "quality",
  promotion: "promotion",
  ledger: "ledger",
});

export function createTimelineRecorder(options: TimelineRecorderOptions): TimelineRecorder {
  const store = options.store;
  const clock = options.clock ?? defaultExecutionClock();
  // The construction-time actor is now only a FALLBACK.
  //
  // Previously this was the effective actor for every event the recorder ever
  // wrote, because no call site passes one — which is why `actor_kind` is the
  // constant "harness" across all 24,816 recorded events. `resolveActor()`
  // consults the ambient recording context first, so an event is attributed to
  // whoever is actually acting WITHOUT any call site being changed or
  // remembered. That is the whole point: recording attribution must not be
  // something anyone can forget to do.
  const fallbackActor = options.actor ?? deepFreeze({ kind: "harness", id: "runtime", role: "timeline" });

  /** The ambient actor when inside a boundary; the construction fallback otherwise. */
  function resolveActor(explicit?: Readonly<{ kind: string; id: string; role?: string }>) {
    if (explicit !== undefined) return explicit;
    const ambient = currentRecordingContext();
    return ambient?.actor ?? fallbackActor;
  }

  /**
   * Trace/span identity taken from the ambient recording context.
   *
   * The context ALREADY carries these — `withSpan` establishes a span id and
   * inherits (or opens) a trace id on every `recordEffect` wrap — but nothing
   * read them on the way to the ledger, so `trace_id` and `span_id` were NULL
   * on every one of 26,635 recorded events. The causal chain was computed and
   * then discarded one function short of being persisted.
   *
   * Read HERE, at the single point every append crosses, so a call site can
   * neither supply it nor forget it. `parentEventId` is deliberately NOT
   * derived from `spanId`: a span id is a call-structure label
   * (`tool:read_file:7`), not an event id, and `event_log.parent_event_id`
   * carries a foreign key to a real event.
   */
  function ambientProvenance(): Readonly<{ traceId?: string; spanId?: string }> {
    const ambient = currentRecordingContext();
    if (ambient === undefined) return {};
    return {
      ...(ambient.traceId !== undefined ? { traceId: ambient.traceId } : {}),
      ...(ambient.spanId !== undefined ? { spanId: ambient.spanId } : {}),
    };
  }
  const baseCorrelation: { readonly runId?: string; readonly sessionId?: string; readonly agentId?: string } = options.correlation ?? {};
  const effectEventTypeMap = new Map<string, TimelineEventType>();

  const queryApi = createTimelineQuery(store);
  const rollbackController = createRollbackController(store);

  function timestamp(): string {
    return options.clock?.now().wallTime ?? new Date().toISOString();
  }

  function monotonicNs(): string {
    return String(BigInt(Math.round(performance.now() * 1_000_000)));
  }

  /**
   * Correlation for an append: construction defaults, then the AMBIENT
   * context, then whatever the call site stated explicitly (most specific
   * wins).
   *
   * The ambient layer is the one that was missing. `resolveActor` already
   * consulted the context, so "who" was ambient while "within what" still had
   * to be threaded by hand — and anything recorded from a choke point that
   * does not know the run (the effect sink behind `recordEffect`, for one)
   * landed with `run_id` NULL. Measured: every one of 404 tool events had a
   * NULL run id, which is why they were invisible to any run/chat/project
   * scoped view even though they were faithfully recorded.
   */
  function mergeCorrelation(corr?: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
    const merged: Record<string, string | undefined> = {};
    if (baseCorrelation.runId !== undefined) merged.runId = baseCorrelation.runId;
    if (baseCorrelation.sessionId !== undefined) merged.sessionId = baseCorrelation.sessionId;
    if (baseCorrelation.agentId !== undefined) merged.agentId = baseCorrelation.agentId;
    const ambient = currentRecordingContext();
    if (ambient !== undefined) {
      if (ambient.runId !== undefined) merged.runId = ambient.runId;
      if (ambient.sessionId !== undefined) merged.sessionId = ambient.sessionId;
      if (ambient.turnId !== undefined) merged.turnId = ambient.turnId;
      if (ambient.agentId !== undefined) merged.agentId = ambient.agentId;
    }
    if (corr !== undefined) {
      for (const [key, value] of Object.entries(corr)) {
        if (value !== undefined) merged[key] = value;
      }
    }
    return deepFreeze(merged);
  }

  function recordStandaloneEvent(input: TimelineEventRecordInput): TimelineStoreRecordResult {
    const eventId = generateId("evt");
    const wallTime = timestamp();
    const correlation = mergeCorrelation(input.correlation);
    const record = store.appendEvent({
      eventId,
      ledgerId: store.ledgerId,
      eventType: input.eventType,
      actor: resolveActor(),
      ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
      description: input.description,
      wallTime,
      monotonicNanoseconds: monotonicNs(),
      ...ambientProvenance(),
      ...(input.parentEventId !== undefined ? { parentEventId: input.parentEventId } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.documents !== undefined
        ? { documents: input.documents }
        : {}),
      ...(input.edges !== undefined
        ? { edges: input.edges }
        : {}),
    });
    return storeReceipt(record);
  }

  /**
   * Shared envelope for the five single-document record methods
   * (recordTokenUsage, recordResource, recordTest, recordGitOperation,
   * recordCommit). Each serializes a payload to canonical JSON, computes its
   * SHA-256 digest, and records a standalone timeline event carrying one
   * document named `documentName`. This is the single owner of that
   * `JSON.stringify` → `sha256` → `recordStandaloneEvent({ documents })`
   * sequence so the five methods cannot drift apart.
   */
  function recordDocumentEvent(
    eventType: TimelineEventType,
    description: string,
    correlation: Readonly<Record<string, string | undefined>>,
    documentName: string,
    payload: unknown,
    opts?: Readonly<{
      parentEventId?: string;
      outcome?: TimelineOutcome;
    }>,
  ): TimelineStoreRecordResult {
    const contentJson = JSON.stringify(payload);
    const contentDigest = sha256(contentJson);
    return recordStandaloneEvent({
      eventType,
      description,
      correlation,
      ...(opts?.parentEventId !== undefined ? { parentEventId: opts.parentEventId } : {}),
      ...(opts?.outcome !== undefined ? { outcome: opts.outcome } : {}),
      documents: deepFreeze([{ name: documentName, contentJson, contentDigest }]),
    });
  }

  return deepFreeze({
    ledgerId: store.ledgerId,
    store,
    query: queryApi,
    rollback: rollbackController,

    beginEffect(input: ExecutionIntentInput, evidence?: TimelineEffectEvidence): RecordedExecution<TimelineEffectIntent> {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      const attachments = snapshotEvidence(evidence);
      const intent = admitIntentInput(input);
      const at = readExecutionTimestamp(clock);
      const correlation = mergeCorrelation(intent.correlation);
      let receipt: TimelineStoreRecordResult;
      try {
        receipt = storeReceipt(store.appendIntent({
          eventId: `intent-${intent.effectId}`,
          ledgerId: store.ledgerId,
          eventType: EFFECT_KIND_TO_EVENT_TYPE[intent.kind],
          effectKind: intent.kind,
          effectId: intent.effectId,
          actor: intent.actor,
          ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
          description: intent.description,
          intentHash: intent.intentHash,
          wallTime: at.wallTime,
          ...(at.monotonicNanoseconds !== undefined ? { monotonicNanoseconds: at.monotonicNanoseconds } : {}),
          ...ambientProvenance(),
          ...attachments,
        }));
      } catch (error) { throw wrapStoreError(error); }
      // Bounded by the effects IN FLIGHT: the entry leaves at the terminal.
      effectEventTypeMap.set(intent.effectId, EFFECT_KIND_TO_EVENT_TYPE[intent.kind]);
      return deepFreeze({ record: { ...intent, timestamp: at }, receipt });
    },

    endEffect(effectId: string, input: ExecutionTerminalInput, evidence?: TimelineEffectEvidence): RecordedExecution<TimelineEffectTerminal> {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      assertTerminalProvenanceAbsent(input);
      const attachments = snapshotEvidence(evidence);
      const terminal = admitTerminalInput(effectId, input);
      // The binding of an effect THIS recorder began is in hand; any other
      // (begun before a restart, or already ended) is the store's to answer:
      // its intent row names the type, and the store refuses a second terminal.
      const eventType = effectEventTypeMap.get(terminal.effectId) ?? store.getEvent(`intent-${terminal.effectId}`)?.eventType;
      if (eventType === undefined) throw new SecurityError("Execution intent has no timeline binding", "timeline_recorder_intent_unbound");
      const at = readExecutionTimestamp(clock);
      let receipt: TimelineStoreRecordResult;
      try {
        receipt = storeReceipt(store.appendTerminal({
          eventId: `terminal-${terminal.effectId}`,
          ledgerId: store.ledgerId,
          eventType,
          effectId: terminal.effectId,
          outcome: terminal.outcome,
          resultHash: terminal.resultHash,
          ...(terminal.error !== undefined ? { error: terminal.error } : {}),
          wallTime: at.wallTime,
          ...(at.monotonicNanoseconds !== undefined ? { monotonicNanoseconds: at.monotonicNanoseconds } : {}),
          ...attachments,
        }));
      } catch (error) { throw wrapStoreError(error); }
      effectEventTypeMap.delete(terminal.effectId);
      return deepFreeze({ record: { ...terminal, timestamp: at }, receipt });
    },

    observeExternalEffect(input: ExecutionObservationInput, evidence?: TimelineEffectEvidence): RecordedExecution<TimelineEffectObservation> {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      const attachments = snapshotEvidence(evidence);
      const observation = admitObservationInput(input);
      const at = readExecutionTimestamp(clock);
      const correlation = mergeCorrelation();
      let receipt: TimelineStoreRecordResult;
      try {
        receipt = storeReceipt(store.appendObservation({
          eventId: `obs-${observation.observationId}`,
          ledgerId: store.ledgerId,
          eventType: EFFECT_KIND_TO_EVENT_TYPE[observation.kind],
          observationId: observation.observationId,
          actor: resolveActor(),
          ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
          ...(observation.effectId !== undefined ? { effectId: observation.effectId } : {}),
          evidenceHash: observation.evidenceHash,
          wallTime: at.wallTime,
          ...(at.monotonicNanoseconds !== undefined ? { monotonicNanoseconds: at.monotonicNanoseconds } : {}),
          ...ambientProvenance(),
          ...attachments,
        }));
      } catch (error) { throw wrapStoreError(error); }
      return deepFreeze({ record: { ...observation, timestamp: at }, receipt });
    },

    recordEvent(input: TimelineEventRecordInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordStandaloneEvent(input);
    },

    recordRun(input: TimelineLifecycleInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordStandaloneEvent({
        eventType: "run",
        description: input.description,
        correlation: input.correlation,
        ...(input.parentEventId !== undefined ? { parentEventId: input.parentEventId } : {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.documents !== undefined ? { documents: input.documents } : {}),
      });
    },

    recordTurn(input: TimelineLifecycleInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordStandaloneEvent({
        eventType: "turn",
        description: input.description,
        correlation: input.correlation,
        ...(input.parentEventId !== undefined ? { parentEventId: input.parentEventId } : {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.documents !== undefined ? { documents: input.documents } : {}),
      });
    },

    recordMessage(input: TimelineLifecycleInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordStandaloneEvent({
        eventType: "message",
        description: input.description,
        correlation: input.correlation,
        ...(input.parentEventId !== undefined ? { parentEventId: input.parentEventId } : {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.documents !== undefined ? { documents: input.documents } : {}),
      });
    },

    recordTokenUsage(input: TimelineTokenUsageInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordDocumentEvent(
        "token",
        `Token usage: prompt=${input.promptTokens} completion=${input.completionTokens} total=${input.totalTokens}`,
        input.correlation,
        TIMELINE_TOKEN_USAGE_DOCUMENT,
        {
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          totalTokens: input.totalTokens,
        },
        {
          ...(input.parentEventId !== undefined ? { parentEventId: input.parentEventId } : {}),
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        },
      );
    },

    recordResource(input: TimelineResourceInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordDocumentEvent(
        "resource",
        `Resource ${input.metric}: ${input.value}${input.unit}`,
        input.correlation,
        TIMELINE_RESOURCE_METRIC_DOCUMENT,
        { metric: input.metric, value: input.value, unit: input.unit },
        {
          ...(input.parentEventId !== undefined ? { parentEventId: input.parentEventId } : {}),
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        },
      );
    },

    recordTest(input: TimelineTestInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordDocumentEvent(
        "test",
        input.description,
        input.correlation,
        "result",
        { passed: input.passed, testCount: input.testCount },
      );
    },

    recordGitOperation(input: TimelineGitInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordDocumentEvent(
        "git",
        input.description,
        input.correlation,
        "operation",
        { operation: input.operation },
      );
    },

    recordCommit(input: TimelineCommitInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      return recordDocumentEvent(
        "commit",
        input.description,
        input.correlation,
        "commit",
        { commitSha: input.commitSha },
      );
    },

    recordFileEffect(input: TimelineFileEffectInput): TimelineStoreRecordResult {
      input = snapshotLedgerInput(input, "timeline_recorder_input_invalid");
      const correlation = mergeCorrelation(input.correlation);
      const eventId = generateShortId(`file-${input.effectId}`);
      const wallTime = timestamp();
      const effect = {
        path: input.path,
        operation: input.operation,
        preimageDigest: input.preimageDigest,
        postimageDigest: input.postimageDigest,
      };
      const effectJson = JSON.stringify(effect);
      const documents: { name: string; contentJson?: string; contentDigest: string }[] = [
        {
          name: TIMELINE_FILE_EFFECT_DOCUMENT,
          contentJson: effectJson,
          contentDigest: sha256(effectJson),
        },
      ];
      if (input.preimageContent !== undefined && input.operation === "write") {
        documents.push({
          name: TIMELINE_PREIMAGE_DOCUMENT,
          contentJson: input.preimageContent,
          contentDigest: input.preimageDigest,
        });
      }
      const record = store.appendEvent({
        eventId,
        ledgerId: store.ledgerId,
        eventType: "file-effect",
        actor: resolveActor(),
        ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
        description: input.description,
        wallTime,
        monotonicNanoseconds: monotonicNs(),
        ...ambientProvenance(),
        documents: deepFreeze(documents),
      });
      return storeReceipt(record);
    },

    pendingEffects(): readonly TimelineEventRecord[] {
      return store.pendingIntents();
    },
    verifyTimelineChain(ledgerId?: string): TimelineChainVerification {
      return store.verifyChain(ledgerId);
    },
    rebuildProjections(): void {
      store.rebuildProjections();
    },
    close(): void {
      store.close();
    },
  });
}

function wrapStoreError(error: unknown): unknown {
  if (isLedgerPersistenceUncertainError(error)) return error;
  if (nodeTypes.isNativeError(error) && [HarnessError.prototype, InputError.prototype, SecurityError.prototype].includes(Object.getPrototypeOf(error))) return error;
  return new SecurityError("Timeline store append failed", "timeline_store_append_failed");
}

export type { TimelineQueryFilter, TimelineQueryResult };
