import type { TimelineDocumentInput } from "./timeline-types.ts";
/**
 * `recordEffect` — wrap work so that performing it IS recording it.
 *
 * Binding guideline: "we must ensure things cannot NOT be recorded... the
 * recording is part of that."
 *
 * WHY A WRAPPER RATHER THAN A CALL
 *
 * Recording currently happens where somebody wrote a `recorder.recordX(...)`
 * call — about ten of them, essentially all in one route file. The ledger
 * therefore holds exactly six event types, which is precisely the set someone
 * remembered. Tool calls, file effects and git operations produce no events at
 * all, so the timeline's most prominent lane is structurally always empty.
 *
 * Adding more calls would reproduce the defect at a larger scale. A wrapper
 * inverts it: the work cannot happen without the record, because the record is
 * how the work is invoked.
 *
 * WHAT THE WRAPPER KNOWS THAT A CALL SITE DOES NOT
 *
 *   - `outcome` — it observes whether the function RETURNED or THREW. Today
 *     `outcome` is null on 87% of events because setting it is the caller's
 *     job and callers forget. A wrapper cannot forget: it is holding the
 *     result.
 *   - `parentEventId` / `traceId` — spans nest on the ambient context stack,
 *     so causality comes from call STRUCTURE rather than from a caller
 *     threading ids through. Those fields are currently 60% and 0% populated.
 *   - duration — it holds both ends of the call.
 *
 * Sync and async are both supported: an async function's outcome is resolved
 * when its promise settles, not when it is created, or every await-ing effect
 * would record "succeeded" the instant it started.
 */

import { types as nodeTypes } from "node:util";
import { snapshotPlainRecord } from "../kernel/safe-structural.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { isLedgerPersistenceUncertainError, LedgerPersistenceUncertainError, IDENTIFIER_PATTERN, HEX_64_PATTERN, DECIMAL_SEQUENCE_PATTERN, MAXIMUM_SEQUENCE } from "./ledger-primitives.ts";
import { bestEffort, bestEffortBoxed, observeUnexpectedPromise } from "../shared/best-effort.ts";
import { HarnessError } from "../kernel/errors.ts";
import { startResourceDeltaProbe, type ResourceDelta } from "../performance/metrics-collector.ts";
import { withSpan, currentActor, currentRecordingContext, type RecordingActor } from "./recording-context.ts";
import type { ExecutionEffectKind } from "../kernel/execution-closure.ts";
import type { TimelineStoreRecordResult } from "./timeline-recorder.ts";

/**
 * How an effect ended.
 *
 * A NARROWING of the ledger's closed outcome registry (`TIMELINE_OUTCOMES`:
 * pending, succeeded, failed, cancelled, denied) — an effect record is
 * always terminal, so `pending` never appears here, and the wrapper may
 * only speak words the ledger already accepts. `cancelled` settles work
 * that was abandoned before its natural end (a provider stream whose
 * consumer stopped pulling, an aborted request); `denied` settles work a
 * gate refused before it started (an unauthenticated request, a rate-limit
 * rejection). Both words ride the registry's own failure disposition
 * (`TIMELINE_FAILURE_OUTCOME_DISPOSITION`: denied is a failure verdict,
 * cancelled is not), so no consumer re-derives what the vocabulary already
 * answers.
 */
export type EffectOutcome = "succeeded" | "failed" | "cancelled" | "denied";

/**
 * A ledger document an effect attaches to its own event, shaped exactly like
 * the recorder's document channel (`TimelineEventRecordInput.documents`) so
 * the sink can forward it without translation. The SINK bounds documents to
 * the store's configured `maxDocumentBytes` — an effect hands over the full
 * payload and its digest; fitting the ledger is the sink's job, not every
 * call site's.
 */
export type EffectDocument = TimelineDocumentInput;

/** What the wrapper reports for one completed effect. */
export type EffectRecord = Readonly<{
  /** Effect kind, e.g. `"tool"`, `"file"`, `"git"`, `"llm"`. */
  kind: string;
  /** Specific operation within the kind, e.g. the tool name. */
  name: string;
  outcome: EffectOutcome;
  durationMs: number;
  /**
   * CPU time (user + system) the effect consumed, in ms, measured across the
   * same window as `durationMs`. Present when the measurement succeeded; a
   * reading is cheap (a microsecond-scale process pair) so it rides on every
   * effect rather than being sampled. Whether it is PERSISTED is the config
   * contract's `performance.resourceDeltas.enabled` decision, made by the
   * consumers — the wrapper measures, it does not policy.
   */
  cpuMs?: number;
  /**
   * Heap growth across the effect, in bytes. NEGATIVE when the effect
   * released more than it allocated — a normal reading for work that hands
   * back memory, never an error.
   */
  heapDeltaBytes?: number;
  /** Present when the effect threw. */
  error?: Readonly<{ message: string; code?: string }>;
  /**
   * The effect's invocation arguments, redacted by the call site before the
   * getter hands them over. A GETTER read once at emit time (see
   * `EffectOptions.argsOf`); present only when the effect supplied one and it
   * did not throw. The sink writes them as their own document beside the
   * timing document.
   */
  args?: unknown;
  /**
   * Documents the effect captured about its own work (a provider call's
   * request and response, for one). Present only when the effect supplied
   * them; the sink writes them beside its own timing document.
   */
  documents?: readonly EffectDocument[];
  /** Span this effect ran in; becomes the parent of anything nested inside. */
  spanId: string;
  /** Trace the span belongs to. */
  traceId: string | undefined;
  /**
   * WHO performed the effect, taken from the ambient recording context.
   *
   * This is the field the whole ambient-context mechanism exists for: the
   * measured defect was `actor_kind` being the constant `"harness"` on all
   * 24,816 recorded events, making "who did this" unanswerable. Reading it
   * from the context rather than from a parameter is what stops it degrading
   * back to a default that nobody passes. Outside any boundary it is the
   * visible `unattributed` marker — an admission that something recorded with
   * no owner, which is a wiring bug worth seeing rather than hiding.
   */
  actor: RecordingActor;
}>;

/**
 * Where completed effect records are delivered.
 *
 * The sink MAY return the ledger's record result — the event id the record
 * landed under — so a wrapper's caller can parent a LATER event onto the
 * effect it just recorded (a gate-block's inline account is the child of the
 * tool event the wrapper emitted). A sink that records nothing (no ledger
 * attached) or cannot say the id returns nothing, and `onRecorded` simply
 * never fires — the absence is honest, never a fabricated id.
 */
export type EffectIntent = Readonly<{
  effectKind: ExecutionEffectKind;
  args?: unknown;
  documents?: readonly EffectDocument[];
}>;

export type EffectIntentRecord = EffectIntent & Pick<EffectRecord, "kind" | "name" | "spanId" | "traceId" | "actor">;

/** Private lifetime capability: finish always targets the recorder that acknowledged intent. */
export type EffectPair = Readonly<{
  receipt: TimelineStoreRecordResult;
  finish(record: EffectRecord): TimelineStoreRecordResult;
}>;

/** Optional telemetry sinks may lack paired persistence; required work then refuses to start. */
export type EffectSink = ((record: EffectRecord) => TimelineStoreRecordResult | void) & Readonly<{
  begin?: (record: EffectIntentRecord) => EffectPair;
}>;

/** Work and recording settle independently; a failed attempt can still have a receipt. */
export type EffectSettlement<T> =
  | Readonly<{ status: "returned"; value: T }>
  | Readonly<{ status: "threw"; error: unknown }>
  | Readonly<{ status: "not-started"; error: unknown }>;

export type RecordingSettlement =
  | Readonly<{ status: "not-attempted" }>
  | Readonly<{ status: "recorded"; receipt: TimelineStoreRecordResult }>
  | Readonly<{ status: "failed"; error: HarnessError; receipt?: TimelineStoreRecordResult }>;

/** Private control/evidence value: original thrown objects are not safe public/log DTOs. */
export type RequiredEffectResult<T> = Readonly<{
  work: EffectSettlement<T>;
  intent?: RecordingSettlement;
  recording: RecordingSettlement;
}>;

export class RequiredRecordingError extends HarnessError {
  constructor() {
    super("Required effect recording is unavailable", "required_recording_unavailable");
  }
}

/** Preserve the original work failure, including `throw undefined`, before recording failure. */
export function requireRecordedEffect<T>(result: RequiredEffectResult<T>): Readonly<{ value: T; receipt: TimelineStoreRecordResult }> {
  if (result.work.status !== "returned") throw result.work.error;
  if (result.intent !== undefined && result.intent.status !== "recorded") throw result.intent.status === "failed" ? result.intent.error : new RequiredRecordingError();
  if (result.recording.status !== "recorded") throw result.recording.status === "failed" ? result.recording.error : new RequiredRecordingError();
  return Object.freeze({ value: result.work.value, receipt: result.recording.receipt });
}

/** Shape admission is not proof of durability; installed recorder sinks supply that acknowledgment. */
function receiptOf(value: unknown): TimelineStoreRecordResult {
  if (observeUnexpectedPromise(value)) throw new LedgerPersistenceUncertainError();
  const receipt = snapshotPlainRecord(value, ["eventId", "sequence", "chainHash"], { maximumDepth: ROOT_POLICY.forensics.limits.maximumDepth, maximumNodes: ROOT_POLICY.forensics.limits.maximumNodes });
  if (typeof receipt.eventId !== "string" || !IDENTIFIER_PATTERN.test(receipt.eventId) ||
    typeof receipt.chainHash !== "string" || !HEX_64_PATTERN.test(receipt.chainHash) ||
    typeof receipt.sequence !== "string" || !DECIMAL_SEQUENCE_PATTERN.test(receipt.sequence) ||
    receipt.sequence.length > MAXIMUM_SEQUENCE.toString().length || BigInt(receipt.sequence) < 1n || BigInt(receipt.sequence) > MAXIMUM_SEQUENCE) {
    throw new RequiredRecordingError();
  }
  return receipt as TimelineStoreRecordResult;
}

function pairOf(value: unknown, onReceipt: (receipt: TimelineStoreRecordResult) => void): EffectPair {
  if (observeUnexpectedPromise(value)) throw new LedgerPersistenceUncertainError();
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) throw new RequiredRecordingError();
  const fields = Object.getOwnPropertyDescriptors(value);
  const receipt = fields.receipt;
  const finish = fields.finish;
  if (receipt === undefined || !("value" in receipt)) throw new RequiredRecordingError();
  const acknowledged = receiptOf(receipt.value);
  onReceipt(acknowledged);
  if (finish === undefined || !("value" in finish) ||
    typeof finish.value !== "function" || nodeTypes.isAsyncFunction(finish.value)) throw new RequiredRecordingError();
  const complete = finish.value as EffectPair["finish"];
  return Object.freeze({ receipt: acknowledged, finish: (record: EffectRecord) => complete.call(value, record) });
}

/** Central fixed diagnostics, retaining only the owned safe uncertainty taxonomy. */
function attemptRecording<T>(fn: () => T): Readonly<{ value: T }> | Readonly<{ error: HarnessError }> {
  let error: HarnessError = new RequiredRecordingError();
  const result = bestEffort(() => {
    try { return { value: fn() }; }
    catch (caught) { if (isLedgerPersistenceUncertainError(caught)) error = caught; throw caught; }
  });
  return result ?? { error };
}

/**
 * The sink. A module-level slot rather than a parameter because the WRAPPERS
 * are spread across subsystems (tools, editor, git, llm) and threading a sink
 * through each of them would be the same "remember to pass it" problem the
 * ambient context exists to remove.
 *
 * Unset by default. Optional telemetry can run without a ledger; the required
 * completion API reports a typed refusal when no sink acknowledges its event.
 */
let sink: EffectSink | undefined;

/** Install the sink. Called once, where the ledger is constructed. */
export function setEffectSink(next: EffectSink | undefined): void {
  sink = next;
}

/**
 * Whether a sink is currently installed. Lets an initializer (the harness
 * bootstrap, the web timeline bridge) avoid clobbering a sink installed
 * earlier by the other — the slot holds exactly one sink, so respecting an
 * existing one is what guarantees no effect is ever recorded twice.
 */
export function hasEffectSink(): boolean {
  return sink !== undefined;
}

/**
 * Per-effect options.
 *
 * `failedWhen` exists because return-vs-throw is NOT sufficient on its own.
 * Plenty of choke points signal failure by RETURN VALUE — `executeToolCall`
 * answers `{ success: false, output }` for an unknown tool rather than
 * throwing. Without this hook the wrapper recorded such calls as "succeeded",
 * which is worse than not recording them: a confidently wrong ledger is
 * harder to distrust than an empty one.
 */
export type EffectOptions<T> = Readonly<{
  /** Return true when this result represents a failure. */
  failedWhen?: (result: T) => boolean;
  /**
   * The outcome for a SETTLED result, overriding the binary classification
   * when the choke point knows a finer word.
   *
   * `failedWhen` answers only succeeded-or-failed. A choke point that can
   * tell a cancellation from a failure (a provider stream abandoned by its
   * consumer is not an error) or a refusal from a fault (a rate-limited
   * request never became work) names it here. `undefined` defers to the
   * `failedWhen` verdict — the hook widens the vocabulary, it never narrows
   * an existing classification. A hook that itself throws is ignored for
   * the same reason a broken `failedWhen` is: a broken observer must never
   * change the outcome of the work.
   */
  outcomeOf?: (result: T) => EffectOutcome | undefined;
  /**
   * The outcome for a THROWN error, overriding the binary throw
   * classification. `undefined` defers to the `failedWhenError` verdict.
   * A refusal recorded by throwing its typed error (the router's refusal
   * lane) names `denied` here; the thrown error still travels as the
   * record's detail whatever the word.
   */
  outcomeOfError?: (err: unknown) => EffectOutcome | undefined;
  /**
   * Classify a THROWN error, the way `failedWhen` classifies a result.
   *
   * Return true when this error represents a failure; return false when the
   * throw is how this choke point signals an outcome the ledger should class
   * as succeeded. The default — no hook, or a hook that itself throws — is
   * "failed": a throw is a failure unless the choke point says otherwise, and
   * a broken classifier must never upgrade a throw into a success.
   *
   * The thrown error still travels as the record's failure detail whatever
   * the classification (the thrown error IS the detail), so a throw classed
   * as succeeded keeps its message beside an outcome that agrees with the
   * same result arriving by return value.
   */
  failedWhenError?: (err: unknown) => boolean;
  /**
   * Extract the failure detail from a result-signalled failure.
   *
   * `failedWhen` answers WHETHER it failed; without this, WHY was lost. A
   * thrown error carries its message to the ledger, but a choke point that
   * reports failure by return value (`{ success: false, output }`) produced an
   * event with `outcome = "failed"` and `error_category`/`error_code`/
   * `error_message` all NULL — a timeline that says something broke and
   * cannot say what. Only consulted when the effect is classified as failed.
   */
  errorOf?: (result: T) => Readonly<{ message: string; code?: string }> | undefined;
  /**
   * Documents the effect captured about its own work, handed to the ledger
   * beside the wrapper's timing measurement.
   *
   * A GETTER, not a value, because the interesting payloads of a streaming
   * effect are only complete when the effect SETTLES: the wrapper calls this
   * once, at emit time, on both the success and the failure path. A broken
   * extractor is treated as "nothing to attach" for the same reason
   * `classify` treats a broken predicate as success — an observer must never
   * change or break the work it observes.
   */
  documentsOf?: (result: T) => readonly EffectDocument[] | undefined;
  /**
   * The effect's invocation arguments — "what arguments it used" — handed to
   * the ledger as their own document beside the timing measurement.
   *
   * A GETTER read once at emit time, not a value, so the redaction work (the
   * call site redacts before handing over) is only paid when a record is
   * actually emitted, and only once. Unlike `documentsOf` it takes NO result:
   * arguments describe the INVOCATION, which exists on every path — success,
   * result-signalled failure, and a thrown error alike — so a tool call that
   * exploded still answers "with what arguments did it explode". The same
   * defensive contract applies: a broken getter costs the args, never the
   * work.
   *
   * THE CALL SITE REDACTS. The wrapper carries what the getter returns
   * verbatim; masking happens in the getter through the single redaction
   * owner, before the args exist as a value — the same discipline the
   * provider payload capture follows (the store deliberately does not mask
   * document content).
   */
  argsOf?: () => unknown;
  /**
   * THE LEDGER IDENTITY of the event this effect recorded, handed back to
   * the wrapper's caller the moment the sink returns it.
   *
   * Exists because a PAIRED event must parent onto the effect's own ledger
   * row: a gate-blocked tool call records its refusal twice by design (the
   * tool event the wrapper emits, plus the gate's inline account), and the
   * inline account is only a DEPENDENT view of the same incident when it
   * can name the tool event as its parent. The id is the ledger's own
   * pairing vocabulary (`event_log.parent_event_id` is a foreign key to a
   * real event), so exposing it here is recording, not a new wire.
   *
   * Fires only when the sink actually recorded (a result came back); with no
   * ledger attached there is nothing to report and the caller's pairing is
   * honestly absent. A throwing observer must never change the work — same
   * contract as every other hook here.
   */
  onRecorded?: (recorded: TimelineStoreRecordResult) => void;
}>;

/**
 * The choke point's own outcome word for a SETTLED result, when it declared
 * one. `undefined` when there is no hook, when the hook names nothing, or
 * when the hook itself throws — a broken observer must never change the
 * outcome of the work, so a broken hook defers to the binary classification
 * exactly like an absent one.
 */
function namedOutcomeOf<T>(result: T, opts?: EffectOptions<T>): EffectOutcome | undefined {
  if (opts?.outcomeOf === undefined) return undefined;
  try {
    return opts.outcomeOf(result);
  } catch {
    return undefined;
  }
}

/**
 * The choke point's own outcome word for a THROWN error — the refusal lane's
 * `denied` and any finer word a gate's throw carries. Same broken-observer
 * contract as `namedOutcomeOf`: a throwing hook defers to the binary
 * classification.
 */
function namedOutcomeOfError(err: unknown, opts?: { outcomeOfError?: (err: unknown) => EffectOutcome | undefined }): EffectOutcome | undefined {
  if (opts?.outcomeOfError === undefined) return undefined;
  try {
    return opts.outcomeOfError(err);
  } catch {
    return undefined;
  }
}

/** Outcome from the result, honouring result-signalled failure and any
 * finer word the choke point declared. */
function classify<T>(result: T, opts?: EffectOptions<T>): EffectOutcome {
  const named = namedOutcomeOf(result, opts);
  if (named !== undefined) return named;
  if (opts?.failedWhen !== undefined) {
    try {
      return opts.failedWhen(result) ? "failed" : "succeeded";
    } catch {
      // A broken predicate must not change the outcome of the work; treat it
      // as "cannot tell" and report success, which is what return-without-
      // throwing already means.
      return "succeeded";
    }
  }
  return "succeeded";
}

/**
 * Outcome for a THROWN error, honouring a throw-path classifier. The default
 * is "failed" — a throw is a failure unless the choke point classifies it
 * otherwise — and a classifier that itself throws changes nothing: a broken
 * observer must never upgrade a throw into a success.
 */
function classifyThrown(err: unknown, opts?: { failedWhenError?: (err: unknown) => boolean; outcomeOfError?: (err: unknown) => EffectOutcome | undefined }): EffectOutcome {
  const named = namedOutcomeOfError(err, opts);
  if (named !== undefined) return named;
  if (opts?.failedWhenError === undefined) return "failed";
  try {
    return opts.failedWhenError(err) ? "failed" : "succeeded";
  } catch {
    return "failed";
  }
}

/**
 * Failure detail for a result-signalled failure, or `undefined` when there is
 * none to report. Consulted for any non-succeeded outcome the choke point
 * settled on (failed, denied, cancelled): a denial carries the refusal's
 * typed reason the same way a failure carries its fault. A broken extractor
 * is treated as "cannot tell" for the same reason `classify` is: an observer
 * must never change or break the work.
 */
function resultError<T>(
  result: T,
  outcome: EffectOutcome,
  opts?: EffectOptions<T>,
): Readonly<{ message: string; code?: string }> | undefined {
  if (outcome === "succeeded" || opts?.errorOf === undefined) return undefined;
  try {
    return opts.errorOf(result);
  } catch {
    return undefined;
  }
}

/**
 * Documents the effect captured, or `undefined` when there are none. A broken
 * extractor costs the documents, never the work — same contract as
 * `resultError` above.
 */
function extractDocuments(
  documentsOf?: () => readonly EffectDocument[] | undefined,
): readonly EffectDocument[] | undefined {
  if (documentsOf === undefined) return undefined;
  try {
    const docs = documentsOf();
    return docs !== undefined && docs.length > 0 ? docs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The effect's redacted invocation arguments, or `undefined` when there are
 * none. A broken getter costs the args, never the work — same contract as
 * `extractDocuments` above.
 */
function extractArgs(argsOf?: () => unknown): unknown | undefined {
  if (argsOf === undefined) return undefined;
  try {
    return argsOf();
  } catch {
    return undefined;
  }
}

let spanCounter = 0;

/**
 * A unique span id. Monotonic within a process; the trace ties them together.
 *
 * THE ID CONFORMS TO THE LEDGER'S IDENTIFIER GRAMMAR EVEN WHEN THE NAME DOES
 * NOT. Effect names are human-readable and may hold anything ("GET
 * /api/chats/:id", a query mark, a space) — they are the DESCRIPTION's
 * content, where that readability belongs. But the span id is an IDENTIFIER
 * in the ledger, and the ledger's identifier grammar admits only letters,
 * digits and `. _ : / -`. A span id minted verbatim from a spaced name made
 * the whole event refuse to store — measured: the first http effect was
 * dropped with "Timeline identifier is invalid" while the request it observed
 * returned 200. So the mint conforms the name here, at the one place span ids
 * are born, rather than requiring every call site to pre-sanitize its name.
 */
function nextSpanId(kind: string, name: string): string {
  spanCounter += 1;
  const conform = (part: string): string => {
    const cleaned = part
      .replace(/[^A-Za-z0-9._:/-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/-+$/, "");
    return cleaned.length > 0 ? cleaned : "unnamed";
  };
  return `${conform(kind)}:${conform(name)}:${spanCounter}`;
}

function toError(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === "string" ? { message: err.message, code } : { message: err.message };
  }
  return { message: String(err) };
}

function emit(
  kind: string,
  name: string,
  outcome: EffectOutcome,
  startedAt: number,
  spanId: string,
  probe: ReturnType<typeof startResourceDeltaProbe>,
  error?: { message: string; code?: string },
  documentsOf?: () => readonly EffectDocument[] | undefined,
  argsOf?: () => unknown,
  onRecorded?: (recorded: TimelineStoreRecordResult) => void,
  required = false,
  target: EffectSink | undefined = sink,
): RecordingSettlement {
  if (target === undefined) return Object.freeze({ status: "failed", error: new RequiredRecordingError() });
  // The resource delta is measured across the SAME window as the duration:
  // the probe is stopped here, at emit time, which is when the effect has
  // fully settled (for an async effect, when its promise resolved — not when
  // it was created).
  const resource: ResourceDelta = probe.stop();
  // The extractors run here rather than at the call site so that a run with
  // no sink attached (a test, a script, a CLI) pays none of their cost: the
  // redaction pass behind `argsOf` and the payload assembly behind
  // `documentsOf` only happen when a record will actually be stored. Each is
  // read at most once, and a broken extractor costs its own document — never
  // the work, and never the rest of the record.
  let captureFailed = false;
  let documents: readonly EffectDocument[] | undefined;
  let args: unknown;
  if (required) {
    // Each extractor failure reports one fixed central diagnostic; the caught value stays private.
    const capturedDocuments = bestEffortBoxed(() => documentsOf?.());
    const capturedArgs = bestEffortBoxed(() => argsOf?.());
    captureFailed = capturedDocuments === undefined || capturedArgs === undefined;
    documents = capturedDocuments?.value;
    args = capturedArgs?.value;
  } else {
    documents = extractDocuments(documentsOf);
    args = extractArgs(argsOf);
  }
  // Both contracts use the same single sink attempt and fixed central diagnostic.
  // Optional telemetry ignores missing receipts; required completion refuses them.
  // Capture failure may still yield a failed ledger row, but never valid evidence.
  const attempt = attemptRecording(() => {
    const result = target({
      kind,
      name,
      outcome: captureFailed ? "failed" : outcome,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(Number.isFinite(resource.cpuMs) ? { cpuMs: resource.cpuMs } : {}),
      ...(Number.isFinite(resource.heapDeltaBytes) ? { heapDeltaBytes: resource.heapDeltaBytes } : {}),
      ...(captureFailed ? { error: { message: "Required effect evidence is unavailable", code: "required_recording_unavailable" } }
        : error !== undefined ? { error } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(documents !== undefined ? { documents } : {}),
      spanId,
      traceId: currentRecordingContext()?.traceId,
      actor: currentActor(),
    });
    return result === undefined ? undefined : receiptOf(result);
  });
  const recorded = "value" in attempt ? attempt.value : undefined;
  if (recorded !== undefined && onRecorded !== undefined) {
    // Same broken-observer contract as every hook: an onRecorded that throws
    // costs the callback, never the work and never the recorded event.
    bestEffort(() => onRecorded(recorded));
  }
  if (recorded === undefined || captureFailed) {
    return Object.freeze({ status: "failed", error: "error" in attempt ? attempt.error : new RequiredRecordingError(), ...(recorded !== undefined ? { receipt: recorded } : {}) });
  }
  return Object.freeze({ status: "recorded", receipt: recorded });
}

/**
 * Required completion recording, using the same sink/emitter as optional effects.
 * The tagged result retains both the work and its actual storage receipt; callers
 * must inspect it or use requireRecordedEffect before dependent effects. This is
 * completion evidence unless an intent is supplied; then work is gated on its
 * acknowledgment and completion uses the captured lifetime capability. Neither
 * receipt shape nor acknowledgment alone is an fsync/durability guarantee.
 * Capture is strict and runs on either work branch. No callback is part of this
 * contract, so a failed observer cannot lose a receipt or trigger a second emit.
 */
export async function recordRequiredEffectAsync<T>(
  kind: string,
  name: string,
  fn: () => Promise<T>,
  options: Readonly<{
    outcomeOf?: (work: EffectSettlement<T>) => EffectOutcome;
    documentsOf?: () => readonly EffectDocument[] | undefined;
    argsOf?: () => unknown;
    /** Paired recording gates fn on an actual intent receipt. */
    intent?: EffectIntent;
    /** Explicit same-recorder capability; never installs or replaces the global sink. */
    sink?: EffectSink;
    signal?: AbortSignal;
  }> = {},
): Promise<RequiredEffectResult<T>> {
  const spanId = nextSpanId(kind, name);
  const startedAt = performance.now();
  const probe = startResourceDeltaProbe();
  const selectedSink = options.sink ?? sink;
  return withSpan(spanId, async () => {
    let target: EffectSink = (record) => selectedSink?.(record);
    let intent: RecordingSettlement | undefined;
    const intentInput = options.intent;
    if (intentInput !== undefined) {
      let acknowledged: TimelineStoreRecordResult | undefined;
      const attempt = attemptRecording(() => {
        const begin = selectedSink?.begin;
        if (begin === undefined || nodeTypes.isAsyncFunction(begin)) throw new RequiredRecordingError();
        return pairOf(begin.call(selectedSink, {
          ...intentInput,
          kind, name, spanId,
          traceId: currentRecordingContext()?.traceId,
          actor: currentActor(),
        }), (receipt) => { acknowledged = receipt; });
      });
      if ("error" in attempt) {
        const error = attempt.error;
        return Object.freeze({ work: Object.freeze({ status: "not-started" as const, error }), intent: Object.freeze({ status: "failed" as const, error, ...(acknowledged !== undefined ? { receipt: acknowledged } : {}) }), recording: Object.freeze({ status: "not-attempted" as const }) });
      }
      const pair = attempt.value;
      intent = Object.freeze({ status: "recorded", receipt: pair.receipt });
      target = (record) => pair.finish(record);
    }
    let work: EffectSettlement<T>;
    if (options.signal?.aborted) work = Object.freeze({ status: "not-started", error: options.signal.reason });
    else {
      try { work = Object.freeze({ status: "returned", value: await fn() }); }
      catch (error) { work = Object.freeze({ status: "threw", error }); }
    }
    let outcome: EffectOutcome = options.signal?.aborted ? "cancelled" : work.status !== "returned" ? "failed" : "succeeded";
    // `outcomeOf` returns an outcome, so no box is needed: undefined here means
    // the classifier THREW (a2-design L3).
    const classified = bestEffort(() => options.outcomeOf?.(work) ?? outcome);
    const classificationFailed = classified === undefined;
    outcome = classified ?? "failed";
    // A provider's thrown object is private. Required diagnostics are fixed;
    // its safe evidence belongs in the supplied documents, not Error.message.
    const emitted = attemptRecording(() => emit(kind, name, outcome, startedAt, spanId, probe,
      work.status !== "returned" ? { message: "Effect failed", code: "effect_failed" } : undefined,
      () => {
        const documents = options.documentsOf?.();
        if (classificationFailed) throw new RequiredRecordingError();
        return documents;
      }, options.argsOf, undefined, true, target));
    const recording: RecordingSettlement = "value" in emitted ? emitted.value : Object.freeze({ status: "failed", error: emitted.error });
    return Object.freeze({ work, recording, ...(intent !== undefined ? { intent } : {}) });
  });
}

/**
 * Run a synchronous effect, recording it.
 *
 * The result is returned unchanged and exceptions propagate unchanged, so
 * wrapping is invisible to callers — which is what allows a choke point to be
 * wrapped without auditing everything that calls it.
 */
export function recordEffect<T>(
  kind: string,
  name: string,
  fn: () => T,
  opts?: EffectOptions<T>,
): T {
  const spanId = nextSpanId(kind, name);
  const startedAt = performance.now();
  const probe = startResourceDeltaProbe();
  return withSpan(spanId, () => {
    try {
      const result = fn();
      const outcome = classify(result, opts);
      emit(
        kind,
        name,
        outcome,
        startedAt,
        spanId,
        probe,
        resultError(result, outcome, opts),
        opts?.documentsOf !== undefined ? () => opts.documentsOf!(result) : undefined,
        opts?.argsOf,
        opts?.onRecorded,
      );
      return result;
    } catch (err) {
      // No result exists on a thrown effect, so there is nothing to extract
      // documents from — the same reason `errorOf` is not consulted here: the
      // thrown error IS the detail. An effect that must attach documents on
      // its failure path settles a result carrying them instead of throwing
      // past the wrapper. The ARGS still travel: they describe the invocation,
      // which existed, and are exactly what a reader needs to see when the
      // work exploded. The OUTCOME is the choke point's classification of the
      // error (`failedWhenError`); the error detail travels whatever the
      // class, so a throw classed as succeeded keeps its message.
      emit(kind, name, classifyThrown(err, opts), startedAt, spanId, probe, toError(err), undefined, opts?.argsOf, opts?.onRecorded);
      throw err;
    }
  });
}

/** A promise-or-thenable result: the shape that settles an async effect. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Run an effect that may be EITHER synchronous or promise-returning, recording
 * it either way — the entry point a decorator that cannot know the wrapped
 * function's shape needs.
 *
 * The sync and async entry points above both require the CALL SITE to already
 * know which shape it is wrapping. A boundary decorator applied to a whole
 * module's exported functions does not: some are `async`, some return promises
 * without being declared async, and some are plain. This variant decides per
 * CALL, on the result:
 *
 *   - a plain value settles the record immediately (recordEffect semantics);
 *   - a thenable settles the record when the promise settles
 *     (recordEffectAsync semantics), WITHOUT wrapping the caller's promise —
 *     the ORIGINAL thenable is returned, and the outcome is observed through
 *     handlers attached to it.
 *
 * A promise-returning function therefore keeps its exact return identity, and
 * the caller's own await/`catch` sees the original settlement — the record
 * rides along, it never interposes.
 */
export function recordEffectAuto<T>(
  kind: string,
  name: string,
  fn: () => T,
  opts?: EffectOptions<T>,
): T | Promise<T> {
  const spanId = nextSpanId(kind, name);
  const startedAt = performance.now();
  const probe = startResourceDeltaProbe();
  return withSpan(spanId, () => {
    try {
      const result = fn();
      if (isThenable(result)) {
        // Observe settlement without interposing: handlers attached to the
        // ORIGINAL promise emit the record; the promise itself is returned
        // unchanged. Rejection is not swallowed for the caller — attaching a
        // handler observes it, and the caller's own await still sees it.
        void (result as PromiseLike<T>).then(
          (value) => {
            const outcome = classify(value, opts);
            emit(
              kind,
              name,
              outcome,
              startedAt,
              spanId,
              probe,
              resultError(value, outcome, opts),
              opts?.documentsOf !== undefined ? () => opts.documentsOf!(value) : undefined,
              opts?.argsOf,
              opts?.onRecorded,
            );
          },
          (err: unknown) => {
            emit(kind, name, classifyThrown(err, opts), startedAt, spanId, probe, toError(err), undefined, opts?.argsOf, opts?.onRecorded);
          },
        );
        return result;
      }
      const outcome = classify(result, opts);
      emit(
        kind,
        name,
        outcome,
        startedAt,
        spanId,
        probe,
        resultError(result, outcome, opts),
        opts?.documentsOf !== undefined ? () => opts.documentsOf!(result) : undefined,
        opts?.argsOf,
        opts?.onRecorded,
      );
      return result;
    } catch (err) {
      emit(kind, name, classifyThrown(err, opts), startedAt, spanId, probe, toError(err), undefined, opts?.argsOf, opts?.onRecorded);
      throw err;
    }
  });
}

/**
 * Run an asynchronous effect, recording it when it SETTLES.
 *
 * Separate from the sync form because an async function returns a promise
 * immediately: recording at return time would mark every awaited effect
 * "succeeded" the moment it started, which is worse than not recording at all
 * — it would be confidently wrong.
 */
export async function recordEffectAsync<T>(
  kind: string,
  name: string,
  fn: () => Promise<T>,
  opts?: EffectOptions<T>,
): Promise<T> {
  const spanId = nextSpanId(kind, name);
  const startedAt = performance.now();
  const probe = startResourceDeltaProbe();
  return withSpan(spanId, async () => {
    try {
      const result = await fn();
      const outcome = classify(result, opts);
      emit(
        kind,
        name,
        outcome,
        startedAt,
        spanId,
        probe,
        resultError(result, outcome, opts),
        opts?.documentsOf !== undefined ? () => opts.documentsOf!(result) : undefined,
        opts?.argsOf,
        opts?.onRecorded,
      );
      return result;
    } catch (err) {
      // No result exists on a thrown effect, so there is nothing to extract
      // documents from — the same reason `errorOf` is not consulted here: the
      // thrown error IS the detail. An effect that must attach documents on
      // its failure path settles a result carrying them instead of throwing
      // past the wrapper. The ARGS still travel: they describe the invocation,
      // which existed, and are exactly what a reader needs to see when the
      // work exploded. The OUTCOME is the choke point's classification of the
      // error (`failedWhenError`); the error detail travels whatever the
      // class, so a throw classed as succeeded keeps its message.
      emit(kind, name, classifyThrown(err, opts), startedAt, spanId, probe, toError(err), undefined, opts?.argsOf, opts?.onRecorded);
      throw err;
    }
  });
}
