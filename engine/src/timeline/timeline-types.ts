import type { KeyObject } from "node:crypto";
import { deepFreeze } from "../kernel/integrity.ts";
import { memberOf } from "../shared/type-guards.ts";
import { schemaId, cryptoDomain } from "../kernel/product-identity.ts";

/**
 * Timeline types and vocabulary.
 *
 * The timeline is the durable, queryable, append-only event ledger that
 * persists every harness-visible operation: run, turn, message, header,
 * token/cost, agent/task/subtask, tool input/output, error/success, timing,
 * resource, file effect, test, git operation, commit/tag, context/memory
 * event, and artifact.
 *
 * The execution-closure ledger (`src/execution-closure.ts`) is the in-memory
 * intent→terminal lineage oracle for side-effect completeness. The timeline
 * store is its durable superset: every closure record is also a timeline
 * event, but the timeline additionally records standalone lifecycle events
 * (run start, turn start, message content, token usage) that are not
 * side-effect intents.
 *
 * Both chains are domain-separated and independent. The closure chain
 * proves effect completeness; the timeline chain proves durable ordering
 * and tamper-evidence across all observed operations.
 */

export const TIMELINE_SCHEMA_VERSION = schemaId("timeline", 1);
export const TIMELINE_DOMAIN = `${cryptoDomain("timeline-chain", 1)}\u0000` as const;
export const TIMELINE_RECORD_DOMAIN = cryptoDomain("timeline-record", 1);
export const TIMELINE_REVISION = "timeline-durable-ledger/v1" as const;

/** Closed registry of record kinds stored in the timeline. */
export const TIMELINE_RECORD_KINDS = deepFreeze([
  "intent",
  "terminal",
  "observation",
  "event",
] as const);

/**
 * Closed registry of semantic event types. Every harness operation maps to
 * exactly one event type. The closure effect kinds (provider, network,
 * process, filesystem, git, memory, permission, quality, promotion, ledger)
 * are included so closure records carry their native classification.
 */
export const TIMELINE_EVENT_TYPES = deepFreeze([
  // lifecycle
  "run",
  "turn",
  "message",
  // transport
  "header",
  "token",
  "cost",
  // agents / tasks
  "agent",
  "task",
  "subtask",
  // tools
  "tool",
  "tool-input",
  "tool-output",
  // outcomes
  "error",
  "success",
  "timing",
  "resource",
  // effects
  "file-effect",
  "test",
  "git",
  "commit",
  "tag",
  "checkpoint",
  "rollback",
  // context / memory
  "context",
  "memory",
  // artifacts
  "artifact",
  // closure effect kinds (mapped from execution-closure)
  "provider",
  "network",
  "process",
  "filesystem",
  // the database lane: one event per data-facade call (method-shaped args
  // only — raw DB arguments never enter the ledger)
  "db",
  "permission",
  "quality",
  "promotion",
  "ledger",
  // the browser lane: facts the web client measured about itself. An
  // uncaught page error (client-error) and a renderer measurement — a long
  // task, an SSE ingest lag, a dropped-events count (client-metric). The
  // browser is a harness component; these are its observations, recorded
  // through the ingestion route after the server redacts + attributes them.
  "client-error",
  "client-metric",
  // the engine lane: one engine function the server called through the
  // canonical hub, measured by the hub's auto-decoration
  // (engine/src/performance/engine-instrumentation.ts). The engine's own
  // runtime calls never cross the hub, so this lane holds exactly the
  // engine work a request performed — what functions it called, how long,
  // what they cost, with argument shapes only.
  "engine",
] as const);

/** Closed registry of typed evidence-graph edges. */
export const TIMELINE_EDGE_TYPES = deepFreeze([
  "causal",
  "part-of",
  "performed-by",
  "used-context",
  "produced",
  "validated-by",
  "supersedes",
  "rolled-back-by",
] as const);

/** Outcomes for terminal records (aligned with execution-closure outcomes). */
export const TIMELINE_OUTCOMES = deepFreeze([
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "denied",
] as const);

export type TimelineRecordKind = typeof TIMELINE_RECORD_KINDS[number];
export type TimelineEventType = typeof TIMELINE_EVENT_TYPES[number];
export type TimelineEdgeType = typeof TIMELINE_EDGE_TYPES[number];
export type TimelineOutcome = typeof TIMELINE_OUTCOMES[number];

// THE VOCABULARY'S OWN MEMBERSHIP TEST, HELD IN A CLOSURE NOTHING CAN NAME.
// `new Set<string>(X)` erases the element type and hands out a MUTABLE set,
// so a predicate built from a vocabulary could still be made to disagree with
// it — driven: one `.delete(…)` typechecked, left every suite green, and
// silently dropped a live value at a boundary. It also made these predicates
// byte-identical siblings across four modules, carried for months as an
// allowlisted duplicate whose own reason read "to remove this entry, extract
// a shared helper and import at all sites". This is that helper.
export const isTimelineRecordKind = memberOf(TIMELINE_RECORD_KINDS);
export const isTimelineEventType = memberOf(TIMELINE_EVENT_TYPES);
export const isTimelineEdgeType = memberOf(TIMELINE_EDGE_TYPES);
export const isTimelineOutcome = memberOf(TIMELINE_OUTCOMES);

/**
 * Whether the rollback planner treats a record kind as a COMPLETED effect.
 *
 * WHY THIS IS A TOTAL MAPPING AND WHY IT LIVES HERE
 *
 * The planner used to inline `if (event.recordKind !== "terminal") continue`.
 * That silently excluded every standalone `event` record — which is the kind
 * `recordFileEffect` produces, so a ledger full of recorded file writes
 * planned as nothing to roll back. The whole `IRREVERSIBLE_REASONS` table in
 * `rollback.ts` names event types (`git`, `commit`, `tool`, `message`,
 * `task`,...) that are ONLY ever written as standalone events, so that table
 * was unreachable too: the planner could not report what it was unable to
 * undo either.
 *
 * Declared as a TOTAL `Record<TimelineRecordKind, ...>` rather than a list of
 * included kinds, and declared next to `TIMELINE_RECORD_KINDS` rather than in
 * the planner, so the mismatch is not merely fixed but unrepresentable:
 * adding a kind to the registry above without giving it a disposition here is
 * a COMPILE error, and the recorder and the planner read one another's
 * contract from the same declaration instead of restating it.
 *
 * - `plan`  — the record completes an effect; the planner considers it.
 * - `skip`  — the record is the non-completing half of a pair (an `intent`
 *   awaiting its terminal) or a side observation. Counting it would
 *   double-count the effect its terminal already represents.
 */
export const ROLLBACK_RECORD_KIND_DISPOSITION = deepFreeze({
  intent: "skip",
  terminal: "plan",
  observation: "skip",
  event: "plan",
} as const) satisfies Readonly<Record<TimelineRecordKind, "plan" | "skip">>;

/** Whether the rollback planner considers records of this kind. */
export function isRollbackPlannedRecordKind(kind: TimelineRecordKind): boolean {
  return ROLLBACK_RECORD_KIND_DISPOSITION[kind] === "plan";
}

/**
 * Whether an event type is a reversible effect, its rollback classification,
 * and — when it is not reversible — the typed reason shown for skipping it.
 *
 * WHY THIS IS A TOTAL MAPPING AND WHY IT LIVES HERE
 *
 * The planner used to keep three partial re-statements of this registry in
 * `rollback.ts`: a `REVERSIBLE_EVENT_TYPES` set, an `IRREVERSIBLE_REASONS`
 * map (which silently omitted most event types behind a fallback sentence),
 * and a `classifyEffect` chain. A new event type added to
 * `TIMELINE_EVENT_TYPES` above got NO disposition — it fell through to
 * "generic" + a generic reason, and nothing said so. Declared as a TOTAL
 * `Record<TimelineEventType, …>` beside the registry, the mismatch is
 * unrepresentable: adding an event type without deciding its rollback
 * disposition is a COMPILE error here, and the planner reads the registry's
 * own answer instead of restating it.
 */
export const ROLLBACK_EVENT_DISPOSITION = deepFreeze({
  // lifecycle — not file-system effects
  run: { reversible: false, kind: "generic", reason: "Run lifecycle events are not reversible via rollback" },
  turn: { reversible: false, kind: "generic", reason: "Turn lifecycle events are not reversible via rollback" },
  message: { reversible: false, kind: "generic", reason: "Messages are not reversible via rollback" },
  // transport — observations, not effects
  header: { reversible: false, kind: "generic", reason: "Transport records are not reversible via rollback" },
  token: { reversible: false, kind: "generic", reason: "Transport records are not reversible via rollback" },
  cost: { reversible: false, kind: "generic", reason: "Cost records are not reversible via rollback" },
  // agents / tasks
  agent: { reversible: false, kind: "generic", reason: "Agent lifecycle events are not file-system effects" },
  task: { reversible: false, kind: "generic", reason: "Task lifecycle events are not reversible via rollback" },
  subtask: { reversible: false, kind: "generic", reason: "Subtask lifecycle events are not reversible via rollback" },
  // tools
  tool: { reversible: false, kind: "generic", reason: "Tool execution effects require effect-specific reversal" },
  "tool-input": { reversible: false, kind: "generic", reason: "Tool execution effects require effect-specific reversal" },
  "tool-output": { reversible: false, kind: "generic", reason: "Tool execution effects require effect-specific reversal" },
  // outcomes — observations
  error: { reversible: false, kind: "generic", reason: "Outcome records are not reversible via rollback" },
  success: { reversible: false, kind: "generic", reason: "Outcome records are not reversible via rollback" },
  timing: { reversible: false, kind: "generic", reason: "Timing records are not reversible via rollback" },
  resource: { reversible: false, kind: "generic", reason: "Resource records are not reversible via rollback" },
  // effects — the reversible ones, plus git which needs the guarded port
  "file-effect": { reversible: true, kind: "file-effect" },
  test: { reversible: true, kind: "test" },
  git: { reversible: false, kind: "git", reason: "Git operations require the guarded git port for reversal" },
  commit: { reversible: false, kind: "git", reason: "Commits require the guarded git port for reversal" },
  tag: { reversible: false, kind: "git", reason: "Tags require the guarded git port for reversal" },
  checkpoint: { reversible: true, kind: "checkpoint" },
  rollback: { reversible: false, kind: "generic", reason: "A rollback is itself a recorded effect" },
  // context / memory
  context: { reversible: false, kind: "generic", reason: "Context records are not reversible via rollback" },
  memory: { reversible: false, kind: "generic", reason: "Memory records are not reversible via rollback" },
  // artifacts
  artifact: { reversible: false, kind: "generic", reason: "Artifact records are not reversible via rollback" },
  // closure effect kinds — outward effects, irreversible
  provider: { reversible: false, kind: "generic", reason: "Provider API effects are irreversible" },
  network: { reversible: false, kind: "generic", reason: "Network requests are irreversible" },
  process: { reversible: false, kind: "generic", reason: "Process execution effects are irreversible" },
  filesystem: { reversible: false, kind: "generic", reason: "Filesystem effects require effect-specific reversal" },
  db: { reversible: false, kind: "generic", reason: "Database operations require effect-specific reversal" },
  permission: { reversible: false, kind: "generic", reason: "Permission records are not reversible via rollback" },
  quality: { reversible: false, kind: "generic", reason: "Quality records are not reversible via rollback" },
  promotion: { reversible: false, kind: "generic", reason: "Promotion records are not reversible via rollback" },
  ledger: { reversible: false, kind: "generic", reason: "Ledger records are not reversible via rollback" },
  // the browser lane — observations the page sent about itself, never effects
  "client-error": { reversible: false, kind: "generic", reason: "Client error records are observations, not effects" },
  "client-metric": { reversible: false, kind: "generic", reason: "Client measurements are observations, not effects" },
  // the engine lane — measured engine function calls through the hub, never effects
  "engine": { reversible: false, kind: "generic", reason: "Engine function measurements are observations, not effects" },
} as const) satisfies Readonly<Record<TimelineEventType, Readonly<{
  reversible: boolean;
  kind: RollbackEffectKind;
  reason?: string;
}>>>;

/** The rollback disposition the planner reads for one event type. */
export function rollbackEventDisposition(type: TimelineEventType): Readonly<{
  reversible: boolean;
  kind: RollbackEffectKind;
  reason?: string;
}> {
  return ROLLBACK_EVENT_DISPOSITION[type];
}

/**
 * Whether a recorded outcome is a FAILURE VERDICT — the disposition a reader
 * of the outcome column needs when it asks "which events did not succeed".
 *
 * WHY THIS IS A TOTAL MAPPING AND WHY IT LIVES HERE
 *
 * The failure-half of the outcome vocabulary was restated as bare literals
 * in the dig reader's SQL (`outcome IN ('failed','denied')`), so an outcome
 * added to `TIMELINE_OUTCOMES` above silently fell outside every failure
 * filter that read it. Declared as a TOTAL `Record<TimelineOutcome, …>`
 * beside the registry, the mismatch is unrepresentable: an outcome added
 * without a disposition is a COMPILE error here.
 *
 * The disposition itself is a semantic decision, not a derivation:
 * `failed` and `denied` are the verdicts that say the work did not succeed
 * for a reason attributable to it; `cancelled` says the CALLER withdrew
 * (a different fact someone may want to filter on separately), and
 * `pending` is not a verdict at all.
 */
export const TIMELINE_FAILURE_OUTCOME_DISPOSITION = deepFreeze({
  pending: false,
  succeeded: false,
  failed: true,
  cancelled: false,
  denied: true,
} as const) satisfies Readonly<Record<TimelineOutcome, boolean>>;

/** The failure-verdict outcome names, DERIVED from the registry — never restated. */
export const TIMELINE_FAILURE_OUTCOME_NAMES: readonly TimelineOutcome[] = deepFreeze(
  [...TIMELINE_OUTCOMES].filter((outcome) => TIMELINE_FAILURE_OUTCOME_DISPOSITION[outcome]),
);

/**
 * Effect kind → canonical ledger event type — the ONE mapping both effect
 * sinks consume (the web server's timeline bridge and the harness runtime
 * bootstrap). The kind is an OPEN string vocabulary (the wrapper accepts any
 * producer's word for what it wrapped); the table records which kinds each
 * producer tree ACTUALLY produces and which lane each lands in:
 *
 *   tool       — server/tool-executor.ts::executeToolCall
 *   git        — server/git-bridge.ts::gitText (mutating invocations only)
 *   llm        — server/llm-bridge.ts::recordProviderStream
 *   process    — server/tool-executor.ts::spawnSyncSafe and
 *                server/auto-check-runner.ts::spawnCapture
 *   filesystem — server/routes/filesystem.ts (the mkdir route)
 *   http       — server/router/router.ts::dispatch (the handler call)
 *   db         — server/db/async-client.ts::call and ::transaction
 *   action     — engine/src/shared/exposure/action.ts (block ACTION verbs)
 *   engine     — engine/src/performance/engine-instrumentation.ts
 *                (engineSpans: every function-valued re-export of the
 *                canonical hub, decorated at the ONE boundary server code
 *                crosses — a new hub re-export is covered the day it lands)
 *
 * There is deliberately NO `file` entry: file effects do not travel through
 * the generic sink. The editor bridge records them with the purpose-built
 * `recordFileEffect`, which carries the real before/after digests this sink
 * has no field for. A `recordEffect("file", …)` call site that ever appears
 * fails the choke-point guard until an entry is deliberately added — the
 * same gate that made the former speculative entries (`file`, `provider`,
 * `network`, `memory`: kinds neither sink's producers ever emitted) go
 * away: a declared kind nothing produces is a lane that lies.
 */
export const EFFECT_KIND_EVENT_TYPES: Readonly<Record<string, TimelineEventType>> = deepFreeze({
  tool: "tool",
  git: "git",
  // A provider call — the ledger's "provider" lane.
  llm: "provider",
  process: "process",
  filesystem: "filesystem",
  // An HTTP request's handler dispatch — the request/response transport
  // between the client and this server: the ledger's "network" lane.
  http: "network",
  // One data-facade call (method-shaped arguments only — raw DB arguments
  // never enter the ledger). The ledger's own "db" lane.
  db: "db",
  // A block ACTION — a user-invoked verb. The ledger's "task" lane: a
  // discrete piece of work someone asked for, distinct from the model's
  // tool calls and from the subprocesses the work may itself record.
  action: "task",
  // One engine function call through the canonical hub — the ledger's
  // "engine" lane: the engine work a request performed, measured at the
  // import boundary every server-visible engine function crosses.
  engine: "engine",
});

/**
 * The event type an effect of this kind lands as. An UNMAPPED kind keeps the
 * display floor — `"resource"`, the lane for measurements about the process —
 * so the event is never lost; the sinks make the unmapped kind observable
 * beside it, and the choke-point guard reds at CI until the producer's entry
 * is added here.
 */
export function eventTypeForEffectKind(kind: string): TimelineEventType {
  return EFFECT_KIND_EVENT_TYPES[kind] ?? "resource";
}

export type TimelineActor = Readonly<{
  kind: string;
  id: string;
  role?: string;
}>;

export type TimelineCorrelation = Readonly<{
  runId?: string;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  taskId?: string;
  attemptId?: string;
  agentId?: string;
  parentEffectId?: string;
}>;

export type TimelineErrorSummary = Readonly<{
  category: string;
  code: string;
  message: string;
  retryable: boolean;
}>;

/** Exact UTF8 text in at most one inline field; neither field means a digest-only reference. */
export type TimelineDocumentInput = Readonly<{
  name: string;
  contentJson?: string;
  orderedJson?: string;
  contentDigest: string;
}>;

export type TimelineEdgeInput = Readonly<{
  edgeType: TimelineEdgeType;
  targetEventId?: string;
  targetKind?: string;
  targetId?: string;
}>;

export type TimelineIntentInput = Readonly<{
  eventId: string;
  ledgerId: string;
  eventType: TimelineEventType;
  effectKind: string;
  effectId: string;
  actor: TimelineActor;
  correlation?: TimelineCorrelation;
  description: string;
  intentHash: string;
  wallTime: string;
  monotonicNanoseconds?: string;
  traceId?: string;
  spanId?: string;
  parentEventId?: string;
  documents?: readonly TimelineDocumentInput[];
  edges?: readonly TimelineEdgeInput[];
}>;

/** Provenance is derived from the unique persisted intent, never the caller. */
export type TimelineTerminalInput = Readonly<{
  eventId: string;
  ledgerId: string;
  eventType: TimelineEventType;
  effectId: string;
  outcome: Exclude<TimelineOutcome, "pending">;
  resultHash: string;
  error?: TimelineErrorSummary;
  wallTime: string;
  monotonicNanoseconds?: string;
  documents?: readonly TimelineDocumentInput[];
  edges?: readonly TimelineEdgeInput[];
}>;

export type TimelineObservationInput = Readonly<{
  eventId: string;
  ledgerId: string;
  eventType: TimelineEventType;
  observationId: string;
  actor: TimelineActor;
  correlation?: TimelineCorrelation;
  effectId?: string;
  evidenceHash: string;
  wallTime: string;
  monotonicNanoseconds?: string;
  traceId?: string;
  spanId?: string;
  parentEventId?: string;
  documents?: readonly TimelineDocumentInput[];
  edges?: readonly TimelineEdgeInput[];
}>;

export type TimelineStandaloneEventInput = Readonly<{
  eventId: string;
  ledgerId: string;
  eventType: TimelineEventType;
  actor: TimelineActor;
  correlation?: TimelineCorrelation;
  description: string;
  wallTime: string;
  monotonicNanoseconds?: string;
  traceId?: string;
  spanId?: string;
  parentEventId?: string;
  payloadRef?: string;
  payloadDigest?: string;
  outcome?: TimelineOutcome;
  /**
   * Failure detail, as ONE value — the same `TimelineErrorSummary` that
   * `appendTerminal` already takes.
   *
   * WHY NOT FOUR OPTIONAL FIELDS
   *
   * This used to be `errorCategory? / errorCode? / errorMessage? /
   * errorRetryable?`, and the store built its payload as
   * `input.errorCategory !== undefined ? {...} : undefined`. A caller that
   * supplied `errorCode` without `errorCategory` therefore lost the code
   * entirely — no throw, no warning, an event whose `error_code` column is
   * NULL exactly where a real failure happened. The reverse combination was
   * no better: a category alone was completed with the invented literals
   * `code: "unknown"` and `message: ""`, which is placeholder data written
   * into a tamper-evident ledger and then chain-hashed as if observed.
   *
   * One value makes both defects UNREPRESENTABLE rather than merely fixed:
   * `TimelineErrorSummary` requires all four members, so "code without
   * category" no longer type-checks and there is nothing left to default.
   * `validateStandaloneInput` runs the same `validateErr` the terminal path
   * uses, so an untyped caller is denied rather than partially accepted.
   */
  error?: TimelineErrorSummary;
  documents?: readonly TimelineDocumentInput[];
  edges?: readonly TimelineEdgeInput[];
}>;

export type TimelineAppendInput =
  | TimelineIntentInput
  | TimelineTerminalInput
  | TimelineObservationInput
  | TimelineStandaloneEventInput;

export type TimelineDocumentRecord = Readonly<{
  docId: number;
  eventId: string;
  position: number;
  name: string;
  contentJson: string | null;
  orderedJson: string | null;
  contentDigest: string;
  /**
   * `exact`: the row holds the document as it was appended. `protected`: the
   * operational projection masked it; the row holds the masked text (and its
   * digest), `originalDigest` names the original, and the original is kept
   * only sealed (`EventLedgerStoragePort.originalDocuments`).
   */
  projectionDisposition: "exact" | "protected";
  /** The appended original's digest: set exactly when the row is `protected`. */
  originalDigest: string | null;
}>;

export type TimelineEdgeRecord = Readonly<{
  edgeId: number;
  sourceEventId: string;
  edgeType: TimelineEdgeType;
  targetEventId: string | null;
  targetKind: string | null;
  targetId: string | null;
  position: number;
}>;

export type TimelineEventRecord = Readonly<{
  eventId: string;
  ledgerId: string;
  sequence: string;
  recordKind: TimelineRecordKind;
  eventType: TimelineEventType;
  effectKind: string | null;
  effectId: string | null;
  observationId: string | null;
  outcome: string | null;
  wallTime: string;
  monotonicNanoseconds: string | null;
  traceId: string | null;
  spanId: string | null;
  parentEventId: string | null;
  actorKind: string;
  actorId: string;
  actorRole: string | null;
  runId: string | null;
  sessionId: string | null;
  turnId: string | null;
  messageId: string | null;
  taskId: string | null;
  attemptId: string | null;
  agentId: string | null;
  parentEffectId: string | null;
  intentHash: string | null;
  resultHash: string | null;
  evidenceHash: string | null;
  errorCategory: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  description: string;
  payloadRef: string | null;
  payloadDigest: string | null;
  previousChainHash: string;
  chainHash: string;
  documents: readonly TimelineDocumentRecord[];
  edges: readonly TimelineEdgeRecord[];
}>;

/**
 * ONE EVENT ROW, WITHOUT ITS ATTACHMENTS — the flat-lane record.
 *
 * DERIVED from `TimelineEventRecord` by omission, never restated: the row
 * is every column of one `event_log` row; the attachments (documents,
 * edges) are what `getEvent` — the detail door — adds. A column added to
 * the record lands here automatically; a consumer hand-listing fields here
 * would be the second source of truth the derivation exists to prevent.
 *
 * WHY THE LIST READS NEED THIS: a page of attachments is the bulk of a
 * flat query's cost — the two batched attachment SELECTs, the nested
 * objects, and every attachment string walked by an egress redaction pass
 * — while no list consumer reads them (the lane renders rows; detail is
 * lazy-loaded per event through `getEvent`). Serving rows from the list
 * reads and attachments from the detail door is the contract, not an
 * optimization: the flat lane answers "what happened", the detail door
 * answers "what did it carry".
 */
export type TimelineEventSummary = Omit<TimelineEventRecord, "documents" | "edges">;

export type TimelineChainVerification = Readonly<{
  valid: boolean;
  verifiedRecords: number;
  breakAtSequence?: string;
  code?: "empty" | "previous-hash" | "record-hash" | "sequence" | "tamper";
}>;

/**
 * Lifetime occurrence counts over the WHOLE ledger FILE, grouped by the
 * vocabulary columns.
 *
 * WHY FILE SCOPE, WHEN EVERY OTHER READ IS LEDGER-SCOPED
 *
 * These counts exist for coverage instruments that ask "has this declared
 * vocabulary member EVER occurred?" — a question about the system's recorded
 * history, which is the file. Mechanically, file scope is also what makes the
 * answer cheap enough to ask casually: each grouped count is a pure
 * covering-index scan (`idx_event_log_event_type`, `idx_event_log_record_kind`,
 * `idx_event_edges_type`, `idx_event_log_ledger_seq`) touching no table rows,
 * whereas adding a `ledger_id` predicate forces a row fetch per index entry
 * plus a temp B-tree for the grouping (measured; see the EXPLAIN assertions
 * in timeline-coverage-counts.test.ts). Nothing is hidden by the wider scope:
 * `ledgers` states exactly which ledgers the counts span, so a multi-ledger
 * file is visible in the result rather than silently merged.
 *
 * The record keys are whatever the ledger actually holds — the CALLER joins
 * them against the declared registries (`TIMELINE_EVENT_TYPES`, …), so a
 * value present here but absent from a registry is detectable as undeclared
 * vocabulary rather than silently dropped.
 */
export type TimelineOccurrenceCounts = Readonly<{
  /** Every event in the file — the sum over `ledgers`. */
  totalEvents: number;
  /** Events per ledger id — the scope statement for all counts here. */
  ledgers: readonly Readonly<{ ledgerId: string; events: number }>[];
  eventTypeCounts: Readonly<Record<string, number>>;
  recordKindCounts: Readonly<Record<string, number>>;
  edgeTypeCounts: Readonly<Record<string, number>>;
  /** Every evidence-graph row — the sum over `edgeTypeCounts`. */
  edgeRows: number;
}>;

/**
 * How many events lack run/trace attribution — the recording gaps a health
 * instrument watches shrink. File-scoped for the same reasons as
 * `TimelineOccurrenceCounts` (these are facts about the recorded history,
 * served by covering or type-bounded index searches). When scoped to one
 * event type, all three numbers cover only that type's events.
 */
export type TimelineRecordingGapCounts = Readonly<{
  /** Events in scope (all events, or all events of the given type). */
  events: number;
  /** Events in scope with `run_id` NULL — recorded outside any run. */
  withoutRun: number;
  /** Events in scope with `trace_id` NULL — recorded outside any trace. */
  withoutTrace: number;
}>;

/**
 * The document names two recorder methods actually write, declared by the
 * shared wire-literals owner so a reader of those documents joins on the
 * RECORDED name rather than restating it. `recordFileEffect` writes one
 * document named `effect` whose JSON carries
 * `{path, operation, preimageDigest, postimageDigest}`; `recordTokenUsage`
 * writes one document named `usage` whose JSON carries
 * `{promptTokens, completionTokens, totalTokens}`. The synthesis facts
 * decode exactly these documents — and their round-trip through the real
 * recorder is pinned in timeline-synthesis-facts.test.ts, so the constants
 * cannot drift from what is written.
 */
export { TIMELINE_FILE_EFFECT_DOCUMENT, TIMELINE_TOKEN_USAGE_DOCUMENT } from "../../../shared/constants.ts";
/**
 * Name of the document carrying a file effect's PRE-IMAGE — the file's text
 * before a write (`recordFileEffect`), which a rollback restores from its
 * seal. Engine-internal: the web reads file effects through the effect
 * document, never the pre-image.
 */
export const TIMELINE_PREIMAGE_DOCUMENT = "preimage";
/** Why a caller opens sealed originals — recorded with every opening (`EventLedgerStoragePort.originalDocuments`). */
export type TimelineOriginalPurpose = "rollback" | "workspace-shard-import";
/**
 * One check-status change, recorded as a standalone `quality` event carrying a
 * document with this name. The document's JSON carries
 * `{checkId, checkName, fromStatus, toStatus, projectId, chatId}` —
 * `fromStatus` is `null` on the first recorded status for a check (nothing to
 * flip from), and `chatId`/`projectId` travel in the DOCUMENT because the
 * ledger's correlation vocabulary has no chat/project field; run attribution
 * comes from the ambient recording context like every other event.
 *
 * This is the append-only history stream beside the auto-checks store's
 * latest-status upsert: the upsert keeps "what is the status now" cheap, and
 * these events keep "when did it change" derivable — which the upsert alone
 * destroys at write time.
 */
export { TIMELINE_CHECK_STATUS_DOCUMENT } from "../../../shared/constants.ts";

/**
 * THE ONE decoder for a recorded token-usage document — the single answer to
 * "did this `usage` document yield numbers, and which".
 *
 * ── WHY IT IS TOLERANT, AND WHO DECIDED THAT ─────────────────────────────
 *
 * The writer (`recordTokenUsage`) always writes three numbers
 * `{promptTokens, completionTokens, totalTokens}` — but the two former
 * decoders disagreed about what a document must carry: the store's synthesis
 * reader required ALL THREE (a document without `totalTokens` was counted
 * unparsed, its measured tokens dropped from every run summary) while the dig
 * reader required only TWO (the same document folded its tokens in happily).
 * Same ledger, same document, two verdicts — the drift this owner ends.
 *
 * The honest contract follows the WRITER's shape: `promptTokens` +
 * `completionTokens` are the measured pair and REQUIRED; `totalTokens` is
 * accepted when present and DERIVED as their sum when absent, so a producer
 * that writes the pair without the redundant total loses nothing. Anything
 * else — unparseable JSON, a non-object, missing or non-finite or negative
 * numbers — is `undefined`, which every consumer must COUNT (never fold in
 * as zero): the failure stays observable in the reader's own unparsed tally.
 *
 * This function is TOTAL: it never throws, because a stored document that
 * does not decode is expected bad material, represented by `undefined`, not
 * an exceptional state.
 */
export type DecodedTokenUsage = Readonly<{
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}>;

export function decodeTokenUsageDocument(contentJson: string): DecodedTokenUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const promptTokens = record["promptTokens"];
  const completionTokens = record["completionTokens"];
  const totalTokens = record["totalTokens"];
  if (
    typeof promptTokens !== "number" || !Number.isFinite(promptTokens) || promptTokens < 0 ||
    typeof completionTokens !== "number" || !Number.isFinite(completionTokens) || completionTokens < 0
  ) {
    return undefined;
  }
  if (totalTokens === undefined) {
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Token-usage aggregates for one run, decoded from the run's recorded
 * `usage` documents.
 *
 * HONESTY RULES OF THIS SHAPE
 *
 * - `samples` counts only documents that actually decoded through the ONE
 *   usage decoder (`decodeTokenUsageDocument`: the measured pair required,
 *   the total accepted or derived); anything else is
 *   `unparsedDocuments`, never a silently-skipped row and never a zero
 *   folded into a sum.
 * - `first`/`last` are chosen by ledger `sequence` (the total order), not by
 *   wall time, and each carries the sequence it was read from so a caller can
 *   state exactly which recorded rows an extrapolation used.
 * - A run with no decodable usage documents has `first`/`last` `null` and
 *   sums of 0 with `samples: 0` — the caller can (and must) distinguish
 *   "measured zero samples" from a fabricated total.
 */
export type TimelineRunTokenUsage = Readonly<{
  samples: number;
  unparsedDocuments: number;
  promptTokensSum: number;
  completionTokensSum: number;
  totalTokensSum: number;
  first: Readonly<{ sequence: string; promptTokens: number }> | null;
  last: Readonly<{ sequence: string; promptTokens: number }> | null;
}>;

/**
 * Everything one run's ledger rows add up to — the exact-join aggregate a
 * synthesis reader needs to state facts about a conversation without pulling
 * event content it does not need.
 *
 * SCOPE — RUN-KEYED, NOT LEDGER-KEYED
 *
 * The predicate is `run_id = ?` alone (a bounded search of
 * `idx_event_log_run`), for the same reason `occurrenceCounts` is
 * file-scoped: a run id is minted once (UUID-based) and never reused across
 * ledgers, so adding a `ledger_id` predicate would only force the planner off
 * the run index while excluding nothing real. Only runs with at least one
 * event appear in the result — an absent run is a PROVEN absence (the search
 * really ran), mechanically distinct from a row of zeros.
 *
 * `toolDescriptionCounts` groups tool events by their RECORDED description
 * (e.g. `tool:read_file`) — the ledger has no separate tool-name column, and
 * inventing one by parsing would be inference; the caller gets the recorded
 * string and may state exactly that.
 */
export type TimelineRunActivitySummary = Readonly<{
  runId: string;
  events: number;
  eventTypeCounts: Readonly<Record<string, number>>;
  toolDescriptionCounts: Readonly<Record<string, number>>;
  /** Events carrying recorded error detail (`error_code IS NOT NULL`). */
  errorEvents: number;
  /** Events whose recorded outcome is `failed`. */
  failedOutcomes: number;
  firstWallTime: string;
  lastWallTime: string;
  firstSequence: string;
  lastSequence: string;
  tokenUsage: TimelineRunTokenUsage;
}>;

/**
 * One decoded file-change record: a `file-effect` event joined to its own
 * `effect` document. Everything here is a recorded value — the path and
 * operation come out of the document the recorder wrote at effect time, not
 * out of any parse of the description.
 */
export type TimelineFileEffectFact = Readonly<{
  eventId: string;
  sequence: string;
  runId: string | null;
  traceId: string | null;
  wallTime: string;
  path: string;
  operation: string;
  description: string;
}>;

/**
 * Scope for a file-effect read. DENY-BY-DEFAULT: at least one of `runIds` or
 * `paths` must be non-empty — there is no "all file effects" read here,
 * because an unbounded content read is not a question synthesis asks.
 *
 * - `runIds` alone: "which files did these runs touch" (drives
 *   `idx_event_log_run`).
 * - `paths` alone: "which recorded history touched these exact paths"
 *   (drives `idx_event_log_event_type`, bounded by the count of `file-effect`
 *   events in the file — 2,149 in the live ledger at the time this was
 *   built). Matching is EXACT string equality against the recorded path;
 *   there is no globbing and no normalisation, because either would be a
 *   guess about what the recorder meant.
 * - both: the intersection.
 *
 * If the `file-effect` population ever grows to where an event-type-bounded
 * pass is too costly, the honest fix is a dedicated indexed path column on a
 * projection — not a LIKE scan added here.
 */
export type TimelineFileEffectFactsFilter = Readonly<{
  runIds?: readonly string[];
  paths?: readonly string[];
  /** Cap on returned facts (default 2000, max 10000). Excess sets `truncated`. */
  limit?: number;
}>;

export type TimelineFileEffectFacts = Readonly<{
  /** Matching facts in ledger order (ascending sequence). */
  facts: readonly TimelineFileEffectFact[];
  /** How many `file-effect` events the read examined — the honest denominator. */
  fileEffectEventsExamined: number;
  /**
   * Examined `file-effect` events whose `effect` document was missing or did
   * not decode to `{path, operation}`. These cannot be matched OR excluded,
   * so they are counted — never silently dropped, never guessed at.
   */
  undecodableEffects: number;
  /** True when more facts matched than `limit` allowed back. */
  truncated: boolean;
}>;

/**
 * One decoded check-status record: a `quality` event joined to its own
 * `check-status` document. Everything here is a recorded value — the check
 * name and both statuses come out of the document written at upsert time, not
 * out of any parse of the description. Statuses are carried as the recorded
 * strings (the check vocabulary belongs to the layer that runs checks; the
 * ledger does not re-validate it).
 */
export type TimelineCheckStatusFact = Readonly<{
  eventId: string;
  sequence: string;
  runId: string | null;
  wallTime: string;
  checkName: string;
  /** The status the check held before this write; null = first recording. */
  fromStatus: string | null;
  toStatus: string;
  /** Decoded from the document — the chat the check was scoped to, if any. */
  chatId: string | null;
}>;

/**
 * Scope for a check-status read. DENY-BY-DEFAULT: at least one of `runIds` or
 * `chatIds` must be non-empty — there is no "all check history" read here.
 *
 * - `runIds` alone: check-status events attributed to these runs (bounded
 *   searches of `idx_event_log_run`).
 * - `chatIds` alone: events whose DECODED document names one of these chats
 *   (bounded search of `idx_event_log_event_type` over `quality` events —
 *   a check run from the checks panel happens outside any run, so its event
 *   carries no run id and is reachable only through the chat id it recorded).
 * - both: the UNION, deduplicated by event id — a conversation's check
 *   history is "recorded by its runs OR recorded against the chat itself".
 *   (Contrast `fileEffectFacts`, where runIds∩paths is an intersection: paths
 *   NARROW a run's effects, while a chat id is an alternative ATTRIBUTION
 *   route to the same conversation.)
 */
export type TimelineCheckStatusFactsFilter = Readonly<{
  runIds?: readonly string[];
  chatIds?: readonly string[];
  /** Cap on returned facts (default 2000, max 10000). Excess sets `truncated`. */
  limit?: number;
}>;

export type TimelineCheckStatusFacts = Readonly<{
  /** Matching facts in ledger order (ascending sequence). */
  facts: readonly TimelineCheckStatusFact[];
  /** How many `quality` events the read examined — the honest denominator. */
  checkEventsExamined: number;
  /**
   * Examined `quality` events whose `check-status` document was missing or
   * did not decode to `{checkName, toStatus}`. Counted, never silently
   * dropped — a `quality` event from another writer is not a non-fact, it is
   * an event this read cannot interpret.
   */
  undecodableCheckEvents: number;
  /** True when more facts matched than `limit` allowed back. */
  truncated: boolean;
}>;

/**
 * Scope for a spectrum read (the time-binned density aggregation behind the
 * web UI's SWEEP band).
 *
 * - `runIds` present: only events attributed to those runs (chat/project
 *   scope — an indexed search using the shared set predicate). An explicitly-empty
 *   array matches NOTHING (a chat with no runs yet), which is distinct from
 *   `undefined` (no run filter → this store's ledger).
 * - `traceId` present: only the events one HTTP request's causal chain
 *   recorded (trace scope — a seek of `idx_event_log_ledger_trace_seq` over
 *   this ledger). The two are independent conjunctions when both are given.
 * - `fromWallTime` / `toWallTime`: inclusive ISO-8601 bounds on `wall_time`
 *   (the ranged-read `until` convention rides on `toWallTime`).
 * - `bins`: how many equal-width time bins to fold the matched events into
 *   (1..2000 — the SWEEP's own ceiling).
 */
export type TimelineSpectrumFilter = Readonly<{
  runIds?: readonly string[];
  traceId?: string;
  fromWallTime?: string;
  toWallTime?: string;
  bins: number;
}>;

/**
 * Per-bin event-density counts over the matched scope.
 *
 * HONESTY RULES OF THIS SHAPE
 *
 * - `events` is the number of rows the search matched; every one of them is
 *   in exactly one bin of exactly one `eventTypeBins` row, or counted in
 *   `unbinnable` (a `wall_time` that did not parse as a date) — never
 *   silently dropped.
 * - `t0`/`t1` are the OBSERVED first/last `wall_time` of the matched rows,
 *   not the requested bounds — a caller stating "this range was measured"
 *   states what was actually seen. Both `null` (and `binMs` 0) when nothing
 *   matched: an empty spectrum is a proven absence, not a row of zeros over
 *   an invented range.
 * - `eventTypeBins` has a row ONLY for event types that occurred in scope;
 *   with `events` as the denominator, an absent type is a proven zero.
 * - `errorBins` counts events carrying recorded failure — outcome `failed`
 *   or a non-null `error_code` — each such event once. It is an OVERLAY:
 *   every event it counts is ALSO in its `eventTypeBins` row, so per-bin
 *   `errorBins[b] <= sum of eventTypeBins[*][b]`, and totals come from
 *   `eventTypeBins` alone (the web sweep draws this row as the alarm ridge
 *   ON TOP of the category stack — canonical, pinned by the web repo's
 *   spectrum tests).
 */
export type TimelineSpectrum = Readonly<{
  events: number;
  unbinnable: number;
  t0: string | null;
  t1: string | null;
  binMs: number;
  bins: number;
  eventTypeBins: Readonly<Record<string, readonly number[]>>;
  errorBins: readonly number[];
}>;

export type TimelineQueryFilter = Readonly<{
  ledgerId?: string;
  /** Exact recorded error code, applied before ordering and the result limit. */
  errorCode?: string;
  runId?: string;
  /** Multiple run IDs (chat/project scope). Server-side `IN (...)` filter;
   * the single `runId` above is kept for backward compatibility and the
   * canonical CLI. When both `runId` and `runIds` are set, the union is
   * filtered. Empty array = no run filter. */
  runIds?: readonly string[];
  turnId?: string;
  agentId?: string;
  taskId?: string;
  eventType?: TimelineEventType;
  recordKind?: TimelineRecordKind;
  effectId?: string;
  /**
   * Every event of one causal chain.
   *
   * `trace_id` is the only causal key a reader can be handed HONESTLY without
   * already holding a ledger row: an ambient recording context carries the
   * trace across every await, so a response envelope can state the trace it
   * was produced under. It cannot state an `event_id`, because a read appends
   * no event and minting one would be a fabricated reference. Without this
   * filter the whole trace was addressable only by walking `parent_event_id`
   * from an event id nobody had, so causal-ancestry reads had no entry point.
   *
   * Composes with `cursor` and `ascending` unchanged: this is an equality
   * predicate, and the total order still comes from `sequence`
   * (`UNIQUE (ledger_id, sequence)`). Indexed by
   * `idx_event_log_ledger_trace_seq (ledger_id, trace_id, sequence)`, whose
   * column order is exactly ledger equality, trace equality, then the
   * sequence range and ordering the query actually asks for.
   */
  traceId?: string;
  fromSequence?: string;
  toSequence?: string;
  fromWallTime?: string;
  toWallTime?: string;
  limit?: number;
  offset?: number;
  ascending?: boolean;
  /**
   * Keyset pagination cursor: the `sequence` of the last event of the previous
   * page. Resumes STRICTLY after it in the current sort direction
   * (`sequence < cursor` descending, `sequence > cursor` ascending).
   *
   * Preferred over `offset` because `sequence` is unique per ledger
   * (`UNIQUE (ledger_id, sequence)`), so the order is total and the page
   * boundary is exact. An offset walk over an append-only ledger re-reads or
   * skips rows whenever an append lands between two pages, which for a live
   * timeline is every page.
   */
  cursor?: string;
}>;

export type TimelineQueryResult = Readonly<{
  events: readonly TimelineEventRecord[];
  total: number;
  hasMore: boolean;
  /**
   * Cursor to pass back for the next page, or `null` when this is the last
   * page. Always the `sequence` of the last event returned, so resuming is
   * exact regardless of what was appended in between.
   */
  nextCursor: string | null;
}>;

/**
 * The flat-lane page: the same envelope as `TimelineQueryResult` carrying
 * `TimelineEventSummary` rows (see the summary type for the row/attachment
 * contract). Pagination, counts and the keyset cursor behave identically —
 * only the per-event detail is elided to the detail door.
 */
export type TimelineEventSummariesResult = Readonly<{
  events: readonly TimelineEventSummary[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}>;

export type RollbackEffectKind = "file-effect" | "git" | "test" | "checkpoint" | "generic";

export type RollbackEffect = Readonly<{
  eventId: string;
  sequence: string;
  eventType: TimelineEventType;
  effectId: string | null;
  description: string;
  rollbackKind: RollbackEffectKind;
  reversible: boolean;
  reason?: string;
  documents: readonly TimelineDocumentRecord[];
}>;

export type RollbackPlan = Readonly<{
  rollbackId: string;
  targetSequence: string;
  effects: readonly RollbackEffect[];
  reversibleCount: number;
  irreversibleCount: number;
  irreversibleEffects: readonly RollbackEffect[];
}>;

export type RollbackResult = Readonly<{
  rollbackId: string;
  rollbackEventId: string;
  restoredCount: number;
  skippedCount: number;
  failedCount: number;
  failedEffects: readonly Readonly<{ effectId: string; reason: string }>[];
  plan: RollbackPlan;
}>;

export type RollbackOptions = Readonly<{
  ledgerId?: string;
  targetSequence: string;
  actor?: TimelineActor;
  description?: string;
  fileRestorer?: FileEffectRestorer;
}>;

export type FileEffectRestorer = Readonly<{
  canRestore(effect: RollbackEffect): boolean;
  restore(effect: RollbackEffect): boolean;
}>;

export type TimelineStoreOptions = Readonly<{
  path: string;
  /**
   * The store key, already admitted by its owner (the web timeline passes the
   * web database's). Absent: the key of this ledger's FOLDER through the one
   * key owner (`resolvePersistedKey`, in the key home) — shared by every store
   * of that folder, so the owner mints one only when no store sharing it holds
   * ciphertext. It seals the originals the projection masked and recognises
   * authenticated field ciphertext; the ledger records its check value at the
   * first seal and refuses any other key at open (`timeline_seal_key_mismatch`).
   */
  key?: KeyObject;
  ledgerId?: string;
  synchronous?: "FULL" | "NORMAL" | "EXTRA";
}>;

export type EventLedgerStoragePort = Readonly<{
  readonly ledgerId: string;
  readonly schemaVersion: typeof TIMELINE_SCHEMA_VERSION;

  appendIntent(input: TimelineIntentInput): TimelineEventRecord;
  appendTerminal(input: TimelineTerminalInput): TimelineEventRecord;
  appendObservation(input: TimelineObservationInput): TimelineEventRecord;
  appendEvent(input: TimelineStandaloneEventInput): TimelineEventRecord;

  getEvent(eventId: string): TimelineEventRecord | undefined;
  query(filter?: TimelineQueryFilter): readonly TimelineEventRecord[];
  /**
   * The LIST read's row projection: the same filtering, ordering and
   * pagination as `query`, without the two batched attachment fetches —
   * `TimelineEventSummary` rows, attachments served by `getEvent`.
   */
  querySummaries(filter?: Partial<TimelineQueryFilter>): readonly TimelineEventSummary[];
  count(filter?: Partial<TimelineQueryFilter>): number;
  /**
   * Does one trace hold an event attributed to any of `runIds`? A single
   * indexed existence lookup over the trace (the composite
   * `ledger_id, trace_id, sequence` index narrows to the trace's rows) that
   * stops at the first matching row in the explicitly selected ledger. This
   * is an existence witness, not authority to read other rows of that trace.
   */
  traceMatchesAnyRun(traceId: string, runIds: readonly string[], ledgerId: string): boolean;
  /** Lifetime vocabulary-occurrence counts. FILE-scoped — see the type's note. */
  occurrenceCounts(): TimelineOccurrenceCounts;
  /** Run/trace attribution gaps, whole-file or bounded to one event type. */
  recordingGapCounts(eventType?: TimelineEventType): TimelineRecordingGapCounts;
  /** Per-run activity aggregates. Run-keyed — see `TimelineRunActivitySummary`. */
  runActivitySummaries(runIds: readonly string[]): readonly TimelineRunActivitySummary[];
  /** Decoded file-change records for a run and/or exact-path scope. */
  fileEffectFacts(filter: TimelineFileEffectFactsFilter): TimelineFileEffectFacts;
  /** Decoded check-status history for a run and/or chat scope. */
  checkStatusFacts(filter: TimelineCheckStatusFactsFilter): TimelineCheckStatusFacts;
  /** Time-binned density counts (the SWEEP aggregation) — see `TimelineSpectrum`. */
  spectrum(filter: TimelineSpectrumFilter): TimelineSpectrum;

  nextSequence(): string;
  chainTipHash(): string;
  verifyChain(ledgerId?: string): TimelineChainVerification;
  /**
   * The intents of this ledger with no terminal, in sequence order: the
   * effects that began and have not ended (live, or left by a crash for boot
   * reconciliation). One indexed scan of the paired rows (migration 11), never
   * a walk of the ledger.
   */
  pendingIntents(): readonly TimelineEventRecord[];
  /**
   * The event's documents EXACTLY as they were appended: a `protected`
   * document's masked text replaced by its sealed original (opened with the
   * store key and verified against `originalDigest`; anything else is refused,
   * `timeline_sealed_original_unavailable`). What a rollback restores from.
   * `undefined` when the event is not in this ledger.
   *
   * THE DECRYPT DOOR, and every opening of a seal through it is AUDITED
   * (`timeline.original.open`: ledger, event, the documents opened, the
   * caller's `purpose` and the outcome — never bytes; a3-design M6). It is
   * the seam an approval gate (cred-final APR-1) takes when the vault of
   * REQ-025 is built.
   */
  originalDocuments(eventId: string, purpose: TimelineOriginalPurpose): readonly TimelineDocumentRecord[] | undefined;
  rebuildProjections(): void;

  close(): void;
}>;

export const TIMELINE_IDENTITY = deepFreeze({
  schemaVersion: TIMELINE_SCHEMA_VERSION,
  revision: TIMELINE_REVISION,
  domain: TIMELINE_DOMAIN,
  recordKinds: TIMELINE_RECORD_KINDS,
  eventTypes: TIMELINE_EVENT_TYPES,
  edgeTypes: TIMELINE_EDGE_TYPES,
  outcomes: TIMELINE_OUTCOMES,
  recordDomain: TIMELINE_RECORD_DOMAIN,
});

export const TIMELINE_MIGRATIONS = deepFreeze([
  Object.freeze({
    id: 1,
    name: "timeline-source-tables-v1",
    description: "event_log, event_documents, event_edges, schema_migrations, append-only triggers",
  }),
  Object.freeze({
    id: 2,
    name: "timeline-projections-v1",
    description: "timeline_projection, projection_offsets, projection rebuild triggers",
  }),
] as const);
