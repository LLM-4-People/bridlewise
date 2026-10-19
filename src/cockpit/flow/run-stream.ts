/**
 * COCKPIT run stream — ONE stream, TWO consumers (§6.6 live ticking).
 *
 * `beginCockpitRun` is the cockpit's send path: it appends the user turn,
 * starts the run, and opens THE run's SSE stream (client.ts
 * `openRunStream`) exactly once. That one stream already feeds the
 * surviving data layer internally (chat-messages / run-state — what the
 * FLOW ingests from); the handlers passed here are the SECOND consumer:
 * they forward the same received events to the SWEEP —
 *
 *   - a received `timeline` record  → `ingestLiveSweepEvent` (band point +
 *     now-edge tick + live status);
 *   - a received model event        → `recordReceivedEvent` with a
 *     receipt-time tick (edge + liveness only — model events are not
 *     ledger records, so they never fabricate band density; the recorded
 *     ledger points arrive via timeline records and the post-run query);
 *   - a stream transport error      → `markStreamReconnecting` /
 *     `markStreamClosed` (a frozen band must say so, §6.6);
 *   - the run's terminal facts      → `markStreamClosed` via `runSettled`
 *     (the error frame, the lost connection, and the natural done/cancelled
 *     close — the stream's OWN endings, in alarm ink for the deaths and
 *     resolved calm by the run's settled status on the pane);
 *   - the run's output ending       → `markStreamEnding` via the debounced
 *     isStreaming run boundary (an INFERENCE — the model stopped producing;
 *     the epilogue legitimately continues, so the word is "ending", never
 *     the transport's "closed"; same debounce idiom as flow/ingest.ts — the
 *     flag flickers false between model turns of one run).
 *
 * No polling, no timers except the run-boundary debounce, and the now
 * edge NEVER advances except on a genuinely received event (the sweep
 * store enforces it — `recordReceivedEvent` is its only mover).
 *
 * Imports obey the cockpit import law: client data functions + src/state +
 * cockpit-internal only.
 */

import {
  adoptLiveRun,
  openRunStream,
  startRun,
  sendUserMessage,
  withdrawUserMessage,
  type StreamController,
  type StreamHandlers,
} from "../../client.ts";
import { assertLiveForWrite } from "../../data/asof.ts";
import type { ModelEvent } from "../../../shared/types.ts";
import { ClientError } from "../../data/errors.ts";
// READ-only store subscription (the sole-writer law: cockpit modules read
// state stores; every state-store WRITE stays inside client.ts).
import { isStreaming, messages } from "../../state/chat-messages.ts";
import {
  noteOutputDelta,
  noteToolInputDelta,
  noteTurnEnd,
  noteTurnStart,
} from "./turn-timing.ts";
import {
  ingestLiveSweepEvent,
  markStreamClosed,
  markStreamEnding,
  markStreamReconnecting,
  resetLiveSweepBuffer,
} from "../sweep/sweep-data.ts";
import { recordReceivedEvent, recordContextReading } from "../sweep/sweep-store.ts";
import type { SweepCategoryId } from "../sweep/types.ts";
import { advanceWait, beginWait, endWaitWithout, resetWait } from "./wait-stage.ts";
import { refusalReason } from "../../data/absence.ts";
import { activeWorkspaceId, workspaces } from "../../state/workspaces.ts";
import {
  activeWorkspaceForRuns,
  applyActiveWorkspace,
  noteRunEnded,
  forgetWorkspaceRuns,
  noteRunStarted,
} from "./run-ownership.ts";

import { bindClosedWorkspaces } from "./flow-view.ts";

/** Run-boundary debounce — mirrors flow/ingest.ts SEAM_DEBOUNCE_MS: the
 * streaming flag flickers false BETWEEN model turns of one run; only a
 * false that survives this window is the run actually ending. */
const RUN_END_DEBOUNCE_MS = 250;

// ── The sweep feed (the stream's second consumer) ──────────────────────────

let liveTickSeq = 0;

/** Category of a model event's receipt tick — from the event's own type. */
function modelEventCategory(type: ModelEvent["type"]): SweepCategoryId {
  if (type.startsWith("tool_call")) return "tool";
  if (type === "error") return "safety";
  return "llm";
}

/**
 * A genuinely received model event ticks the now edge at its RECEIPT time
 * and proves liveness. It is NOT buffered as a band point: model events are
 * not ledger records — the band's density comes from real recorded
 * `TimelineEventRecord`s (live + query), never from receipt-time synths.
 */
function tickFromModelEvent(runId: string, event: ModelEvent): void {
  liveTickSeq += 1;
  recordReceivedEvent(
    Object.freeze({
      eventId: `live-model-${runId}-${liveTickSeq}`,
      timeMs: Date.now(),
      category: modelEventCategory(event.type),
      isError: event.type === "error",
      eventType: event.type,
      // Model-event receipt ticks carry no ledger columns of their own —
      // they are receipts, not records; the recorded ledger point arrives
      // via the timeline event path with the real values.
      outcome: null,
      errorCode: null,
      runId,
      turnId: null,
      parentEventId: null,
      description: "",
    }),
  );
}

/**
 * ── WHEN THIS TURN'S OUTPUT BEGAN, FROM THE FRAMES THEMSELVES ─────────────
 *
 * THE REQUIREMENT (paraphrased, not quoted): for a thinking model, ttft counts
 * from the moment it starts thinking. flow/turn-timing.ts holds the measurement and states why
 * it is a second quantity rather than a redefinition of the recorded one; this
 * is only the wire from the stream to it, and it is HERE because this handler
 * is the cockpit's own consumer of the run stream and therefore the one place
 * that sees `reasoning_delta` and `text_delta` as the distinct frames they are.
 *
 * WHICH TURN a frame belongs to is answered by the transcript, not by a
 * counter: `client.ts` appends the assistant message on the same `start` frame
 * this reads, and does so BEFORE fanning the event out here (`ingestModelEvent`
 * precedes `handlers.onModelEvent`), so the last assistant message is already
 * the one these deltas are streaming into. A counter would have to guess after
 * a reconnect; the transcript cannot.
 *
 * Returns null when there is no assistant message to attribute the frame to —
 * the synthetic `start` the steering path emits arrives while the last message
 * is a steering event, and attributing a turn's clock to it would be a
 * measurement of the wrong thing.
 */
function openAssistantMessageId(): string | null {
  const list = messages.get();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]!.role === "assistant") return list[i]!.id;
  }
  return null;
}

/**
 * ── EVERY PHASE OF A TURN NEEDS SOMETHING WATCHING IT ─────────────────────
 *
 * What the wire carries, and who observes each one. Two rows of this table
 * were BLANK, and each blank showed up as an instrument that had gone dead
 * while the model was working:
 *
 *   start             → the wait milestone, and this turn's clock zero
 *   reasoning_delta   → the thinking block, the ttft clock, and the rail
 *   text_delta        → the transcript tail (prose + rail), answer-start
 *   tool_call_start   → the tool beat opens
 *   tool_call_delta   → THE RAIL. Nothing else: `src/client.ts` discards
 *                       these frames outright, so before this line they
 *                       reached no store and no surface at all — the whole
 *                       emission of an artifact's HTML was invisible.
 *   tool_call_done    → the tool beat's input
 *   tool_result (SSE) → the tool beat's output and status
 *   usage             → the footer's token counts
 *   finish            → the tail commits, streaming clears, the seam renders
 *   error             → an error beat
 *
 * The two that were blank are `reasoning_delta` (the model thinking for up to
 * two minutes with the rail frozen on "the model is answering") and
 * `tool_call_delta` (the model emitting tens of thousands of characters of
 * arguments with the same rail frozen). They are the same defect twice: the
 * model is producing and the UI is watching a channel that has gone quiet.
 */
function noteOutputFrame(event: ModelEvent): void {
  if (event.type === "start") {
    const id = openAssistantMessageId();
    if (id !== null) noteTurnStart(id, Date.now());
    return;
  }
  if (event.type === "tool_call_delta") {
    const id = openAssistantMessageId();
    if (id === null) return;
    noteToolInputDelta(id, event.argumentsDelta.length, Date.now());
    return;
  }
  if (event.type === "finish" || event.type === "error") {
    // Closes the producing window. Deliberately NOT the moment `usage` lands:
    // this provider sends `usage` after `finish`, and the window is about when
    // the model stopped producing, not about when its accounting arrived.
    const id = openAssistantMessageId();
    if (id !== null) noteTurnEnd(id, Date.now());
    return;
  }
  if (event.type !== "reasoning_delta" && event.type !== "text_delta") return;
  const id = openAssistantMessageId();
  if (id === null) return;
  noteOutputDelta(
    id,
    event.type === "text_delta" ? "answer" : "thinking",
    Date.now(),
    event.delta.length,
  );
}

/** The handlers openRunStream fans received events out to — the sweep's
 * live wire (tests capture them off the mocked openRunStream call). */
function sweepFeedHandlers(runId: string): StreamHandlers {
  return {
    // MILESTONE 2 — the server acknowledged the open stream for this run.
    // This handler exists for the wait instrument alone; `connected` was
    // already emitted by the server and already listened for by client.ts,
    // so nothing new is observed here, it is merely no longer discarded.
    onConnected: () => {
      advanceWait("connected");
    },
    onModelEvent: (event, applied, replayed) => {
      // MILESTONE 3 — the model has begun. Advance-only, so only the FIRST
      // event of the run moves the instrument; the rest are ordinary ticks.
      advanceWait("answering");
      // Replay is a transport receipt, but its rejected output cannot
      // restart or extend a turn's original producing clock.
      if (applied !== false && replayed !== true) noteOutputFrame(event);
      tickFromModelEvent(runId, event);
    },
    onTimelineEvent: (event) => {
      ingestLiveSweepEvent(event);
    },
    // THE COMPOSE REFRESH — the run's own report of what the assembled
    // request held. This is the live wire the ARM "context crosses N%"
    // trigger evaluates on (sweep/arm-fire.ts recordContextReading): the
    // context is a MEASUREMENT the run serves once per compose, not a
    // per-token stream, so the trigger fires at the measurement's
    // arrival — and the row says so. No polling: the door opens only
    // when a genuinely received context event pushes it.
    onContextEvent: (context) => {
      recordContextReading(context);
    },
    onError: (error) => {
      // Parse failures can leave the source alive. Only the stream owner's
      // actual transport settlement retires ownership; reconnecting is a
      // nonterminal status observation.
      if (error.code === "stream_error") markStreamReconnecting();
    },
    // The client delivers this after every actual transport ending,
    // including errors, and even when the owning workspace is parked.
    onRunSettled: () => {
      runSettled(runId);
    },
  };
}

// ── Parking: a run whose workspace is not on screen ────────────────────────
//
// Subscribed at module load, once. The registry does the deciding
// (run-ownership.ts states WHY a background stream must be parked rather than
// left writing); this is only the wire from the workspace atom to it.
activeWorkspaceId.subscribe((id) => applyActiveWorkspace(id));

// ── Run boundary → the honest "ending" inference ────────────────────────────

let stopRunEndWatch: (() => void) | null = null;
/** The run the armed boundary watcher belongs to — the scoped-stop key: a
 * terminal frame for a DIFFERENT run must never disarm this run's watcher
 * (two runs of one client replace the watcher; a replaced run's late
 * terminal close is not the current run's). */
let runEndWatchRunId: string | null = null;
/** The workspace the armed watcher was installed for — `boundaryIsOurs` for
 * the terminal paths, so a parked run's natural close can never reset the
 * FOREGROUND run's wait instrument. */
let runEndWatchWorkspaceId: string | null = null;

// The existing close binder also observes sign-out's workspace reset. A tab
// removed from the list can never reopen; release its local closure before
// closeWorkspace switches the active ID to its neighbour.
bindClosedWorkspaces((workspaceId) => {
  forgetWorkspaceRuns(workspaceId);
  if (runEndWatchWorkspaceId === workspaceId) stopRunEndWatch?.();
});

/**
 * Stop the armed boundary watcher, but only when it belongs to `runId` AND
 * its boundary is ours (the active workspace matches). Returns whether the
 * stopped watcher was the live one for this run — the caller resets the
 * wait instrument only on `true`, so a backgrounded run's settle never
 * clears a foreground run's outstanding wait.
 */
function settleRunEndWatch(runId: string): boolean {
  if (stopRunEndWatch === null || runEndWatchRunId !== runId) return false;
  const ours = runEndWatchWorkspaceId === null || activeWorkspaceForRuns() === runEndWatchWorkspaceId;
  stopRunEndWatch();
  return ours;
}

/**
 * THE RUN SETTLED — the stream's OWN terminal fact (the error frame, the
 * lost connection, the natural done/cancelled close). Marks the sweep's
 * transport state "closed" (the word only these paths may claim), retires
 * the run from the ownership registry, and disarms the boundary watcher
 * FOR THIS RUN so its inference cannot overwrite the terminal truth with a
 * softer "ending" a debounce later.
 */
function runSettled(runId: string): void {
  noteRunEnded(runId);
  if (settleRunEndWatch(runId)) {
    markStreamClosed();
    // The wait instrument belonged to this run's send (the watcher we just
    // disarmed was armed for it and its workspace is the one on screen) —
    // back to absence, the same reset the boundary's own firing performs.
    resetWait();
  }
}

/** Watch the isStreaming run boundary; a debounced true→false marks the
 * run ENDING on the band. One watcher per run — a new run replaces it.
 *
 * THE INFERENCE'S OWN WORD (UIE-084): the boundary knows the run's MODEL
 * OUTPUT stopped — nothing more. It does not know the socket closed (the
 * drive-18 wire proved the opposite: one GET, no reconnect, and the next
 * epilogue event arriving on the same socket), so it may not paint
 * "closed", the transport's word for death, in alarm ink beside a run view
 * still reading "running". It paints "ending" — neutral, honest about what
 * is known, and REVISABLE (the next received event reclaims "live", which
 * is also what recovers a mid-run tool-gap firing when the next turn
 * opens). The honest "closed" belongs to the stream's own terminal facts
 * (`runSettled` above). */
function watchRunEnd(debounceMs: number, runId: string, workspaceId: string | null): void {
  stopRunEndWatch?.();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let was = isStreaming.get();
  const stop = (): void => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stopRunEndWatch === stop) {
      stopRunEndWatch = null;
      runEndWatchRunId = null;
      runEndWatchWorkspaceId = null;
    }
  };
  // `isStreaming` IS THE SHARED TRANSCRIPT'S FLAG, not this run's. Switching
  // workspaces clears the transcript store, and clearing it sets the flag
  // false — so for a run whose workspace has just gone to the background, this
  // boundary is a report about the SWITCH and not about the run. `boundaryIsOurs`
  // is what tells the two apart; the run's own terminal callback (onRunSettled above)
  // ends a backgrounded run. When the registry knows nothing about workspaces
  // (the dev harness, the unit tests) it stands down and the boundary works
  // exactly as it always did.
  const boundaryIsOurs = (): boolean => {
    const active = activeWorkspaceForRuns();
    return workspaceId === null || active === workspaceId;
  };
  const runEnded = (): void => {
    if (!boundaryIsOurs()) return;
    markStreamEnding();
    // The wait is over, so the instrument stops claiming one. Back to
    // absence rather than to a stale "the model is answering".
    resetWait();
    // Output ending is an inference, not transport closure. Retain both
    // the registry entry and watcher through tool gaps and the epilogue so
    // a workspace switch can still park the source and terminal can settle.
  };
  const unsubscribe = isStreaming.subscribe((streaming) => {
    if (was && !streaming) {
      if (debounceMs === 0) {
        runEnded();
      } else {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!isStreaming.get()) runEnded();
        }, debounceMs);
      }
    } else if (streaming && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    was = streaming;
  });
  stopRunEndWatch = stop;
  runEndWatchRunId = runId;
  runEndWatchWorkspaceId = workspaceId;
}

// ── The cockpit send path ──────────────────────────────────────────────────

export type BeginCockpitRunOptions = Readonly<{
  chatId: string;
  modelId?: string;
  /** Tests pass 0 for a synchronous run-end boundary. */
  runEndDebounceMs?: number;
  /**
   * Called the instant the user's words are IN THE TRANSCRIPT — after
   * `sendUserMessage`, before the awaited `startRun`. The composer empties on
   * this rather than on the resolved promise (composer-router.ts states the
   * defect in full: the reader saw their sentence in the flow AND still in the
   * box for as long as the server took to accept the run).
   */
  onCommitted?: () => void;
}>;

/**
 * Attach the cockpit's ONE stream to a run and register it with the run
 * ownership registry — the shared adoption block for BOTH ways a run becomes
 * ours: the server accepting our start, and the `chat_run_live` refusal
 * naming a run that was already live (a raw-API start, a second window, a
 * raced door). One block so the two cannot drift into adopting differently —
 * the refused case used to leave the named run invisible AND unsteerable,
 * the refusal's own remedy sentence promising a steer the composer had no
 * run to send to.
 */
function adoptRunStream(
  runId: string,
  opts: BeginCockpitRunOptions,
  debounceMs: number,
  workspaceId: string | null,
): StreamController {
  // A response can arrive after close or sign-out removed its workspace.
  // There is no future reopen door for that ID; leave the server run alone
  // and do not create an unreachable local attachment.
  if (workspaceId !== null && !workspaces.get().some((workspace) => workspace.id === workspaceId)) {
    return { close: () => {} };
  }
  // Capture ownership BEFORE startRun's await. The same opener is used for
  // acceptance, an adopted live-run refusal, and returning to a parked tab.
  const open = (): StreamController => {
    if (activeWorkspaceId.get() === workspaceId) {
      resetLiveSweepBuffer();
      watchRunEnd(debounceMs, runId, workspaceId);
    }
    return openRunStream(runId, sweepFeedHandlers(runId));
  };
  const controller = open();
  if (workspaceId !== null) {
    noteRunStarted({ runId, workspaceId, chatId: opts.chatId }, controller, open);
  }
  return controller;
}

/**
 * Begin a chat run from the cockpit: append the user's prompt (the beat
 * appears instantly via the store → flow-ingest path), start the run, and
 * open the ONE SSE stream with the sweep feed attached. Model/timeline/
 * agent ingestion into the shared stores happens inside openRunStream
 * exactly as before — this wrapper adds the sweep as the stream's second
 * consumer; it never opens a second stream.
 *
 * Sole-writer law: this module performs NO state-store writes. The user
 * turn goes through client.ts (`sendUserMessage`); the streaming flag
 * flips when the stream's own first model event is ingested by client.ts
 * (liveness from a received event — no optimistic flag to unwind); a
 * `startRun` failure is rethrown for the caller's refusal surface (the
 * composer hint keeps the user's words).
 */
export async function beginCockpitRun(
  projectId: string,
  prompt: string,
  opts: BeginCockpitRunOptions,
): Promise<StreamController> {
  // A PAST VIEW IS READ-ONLY (§6.2), asserted HERE because this is the one
  // cockpit door for starting a run: `sendUserMessage` and `startRun` are
  // client.ts calls, so nothing on this path passes the Broker's write door,
  // and every caller — the composer's plain-text route and the `retry` verb
  // alike — is covered by asserting once at the door rather than N times at
  // the call sites. Refused BEFORE `sendUserMessage`, so a refused run never
  // appends an optimistic user turn it then has to unwind.
  assertLiveForWrite();
  const workspaceId = activeWorkspaceId.get();
  const ownsWorkspace = (): boolean => activeWorkspaceId.get() === workspaceId;
  // A NEW RUN STARTS FROM ABSENCE, with its clock running. Called before the
  // first milestone so the instrument can never carry the previous run's
  // furthest stage into this one (wait-stage.ts is advance-only by design;
  // this and `resetWait` are the only things that move it backwards).
  beginWait();
  // THE SEND NEEDS NO ANNOUNCEMENT. This appends the user's beat
  // synchronously, so the reader sees their own words land in the flow in the
  // same frame — there is no window in which a sentence saying "your message
  // is in" would tell them anything the screen was not already showing, and
  // there used to be a milestone here doing exactly that (wait-stage.ts
  // records why it is gone). What the wait row reports from here on is what
  // the reader CANNOT see: how long the harness is taking, and how far the
  // run has got.
  const beatId = sendUserMessage(prompt);
  // …and THAT is the fact the composer should empty on. Everything below this
  // line is the server accepting the run, which the box has no stake in.
  opts.onCommitted?.();
  let runId: string;
  try {
    ({ runId } = await startRun({
      projectId,
      prompt,
      chatId: opts.chatId,
      ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
    }));
  } catch (err) {
    // THE REFUSAL UNWINDS THE WAIT, at the one door every caller passes
    // (the composer's plain route and the retry verb alike). Without this
    // the instrument ticked "waiting for the harness to take the run"
    // FOREVER over a run the server had already declined — no milestone was
    // ever coming, and only a stream boundary (which a refused run never
    // opens) would have reset it. The standing state speaks the response
    // grammar: a principled refusal (428/503 with the server's own
    // sentence) is REFUSED, anything else is FAILED. Rethrown unchanged for
    // the caller's own refusal surface.
    const refusal = refusalReason(err);
    // A REFUSED SEND NEVER HAPPENED, so its optimistic beat is taken back
    // HERE — the same door that raised it. A refused run persists nothing
    // (the start route writes the user message only once it accepts), so the
    // optimistic row was a client-only phantom: visible exactly until the
    // next reload erased it, the reader's words on screen and nowhere. A
    // FAILED attempt (network, an untyped 5xx) KEEPS its beat — the send
    // genuinely left and the reader's own words stay in the flow as the
    // record of what was attempted. The composer's half of the same
    // contract (the words return to the box) lives at the caller, which owns
    // the box; this door owns the transcript.
    if (refusal !== null && ownsWorkspace()) withdrawUserMessage(beatId);
    if (ownsWorkspace()) endWaitWithout(
      refusal !== null
        ? { kind: "refused", reason: refusal }
        : { kind: "failed", reason: err instanceof Error ? err.message : String(err) },
    );
    // ── THE REFUSAL NAMES ITS SUBJECT, AND THE SUBJECT IS ADOPTED ─────────
    //
    // A `chat_run_live` refusal now carries the run it is about. That run
    // was not started by this client (a raw-API start, a second window on
    // the same chat, a raced door) — until this block, it streamed
    // server-side with NOTHING attached on this side: the flow rendered
    // none of its beats (only a reload, re-reading history, brought them
    // in), and the sentence's own remedy ("steer it with your next
    // message") was unreachable, because the composer's steer door needs a
    // run view this client never had. Adopting the named run does both at
    // once: the stream's beats render live, and the planted view routes
    // the next send to the steer door the sentence promises. The refused
    // send itself stays refused — the beat was taken back above and the
    // words return at the caller, exactly as before.
    const liveRunId = err instanceof ClientError ? err.liveRunId : undefined;
    if (refusal !== null && liveRunId !== undefined) {
      if (ownsWorkspace()) adoptLiveRun(liveRunId, projectId);
      adoptRunStream(liveRunId, opts, opts.runEndDebounceMs ?? RUN_END_DEBOUNCE_MS, workspaceId);
    }
    throw err;
  }
  // MILESTONE 1 — the server took the run and named it. A `startRun` that
  // throws never reaches here (the catch above ends the wait with the
  // refusal standing), so a refused run advances nothing.
  if (ownsWorkspace()) advanceWait("accepted");
  return adoptRunStream(runId, opts, opts.runEndDebounceMs ?? RUN_END_DEBOUNCE_MS, workspaceId);
}
