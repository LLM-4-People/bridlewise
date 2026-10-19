/**
 * COCKPIT FLOW — ingestion: the surviving data layer → the beat log.
 *
 * The DATA layer survives (spec §13): chat-messages, run-state, and checks
 * stores keep being fed by client.ts exactly as before. This module is a
 * RE-RENDERING adapter: it subscribes to those stores and maintains the beat
 * log (log.ts) incrementally — matched prefix untouched, changed messages
 * update their beat in place, new messages append. It never fetches its own
 * copy of anything.
 *
 * Derived beats appended here beyond the 1:1 message mapping:
 *   - EFFECT beats: a successful file-editing tool call commits an effect
 *     beat parented to its tool beat (§3.2) — path from the call's own args,
 *     ±counts measured later from the real diff (EffectBeat fetches it).
 *   - CHECK-DELTA beats: appended only when a check's state CHANGED while
 *     observed (§3.2 — deltas only, never standing state).
 *   - TURN SEAMS: when a run ends, the one-line measured rollup (§4.3).
 *   - ACT beats: an OPERATOR INTERVENTION — "show when we steer, manipulate
 *     context, trim, etc" (the user's words). The Broker records every block
 *     action it performs at the one write door (src/data/ledger.ts), and this
 *     module mints a beat per newly recorded act, quoting the action's own
 *     DECLARED `title`/`consequence` out of the served `blockActions`
 *     manifest. Nothing here is fetched and nothing is authored.
 *   - the DESK-LINE context projection is proposed to the admission
 *     controller on the same boundary (it renders above the composer, not
 *     in the flow).
 *
 * ── ONE INGEST PER WORKSPACE ──────────────────────────────────────────────
 *
 * A page holds N workspaces and one Flow serves all of them, so every cursor
 * below (what has been synced, how many seams, which check statuses were last
 * seen, how many operator acts have been minted) belongs to ONE workspace and
 * is held in `states`, keyed the same way the log is. Sharing them was what
 * made a tab switch re-ingest the whole conversation: the incoming
 * transcript did not match the outgoing cursor, `rebuild()` fired, and
 * `clearLog()` threw away beats that were perfectly good.
 *
 * THREE RULES DECIDE WHETHER A STORE UPDATE IS OURS AT ALL, in this order:
 *
 *   DORMANT — the transcript store is showing a different conversation from
 *     the one this ingest was started for. Its updates are somebody else's;
 *     we take none of them, and in particular the CLEAR that happens on every
 *     chat switch cannot reach our log.
 *
 *   FROZEN — a run owned by ANOTHER workspace is live. The transcript store
 *     is single-tenant (run-ownership.ts spells out why), so while that is
 *     true its contents cannot be trusted to be one conversation. We hold
 *     what we have rather than ingest a concatenation.
 *
 *   ABSENT — the transcript is empty and we hold beats. Empty is what the
 *     store looks like between "the chat changed" and "the history arrived";
 *     it is the absence of a transcript, not the assertion of an empty one,
 *     and treating it as divergence is what cleared warm logs.
 *
 * And one rule decides that a divergence is not a divergence: the SAME
 * records re-read from the database carry DATABASE ids where the live stream
 * gave them client ids. Same role, same words, same tool — the record did not
 * change, only its name did (`sameRecord`). The beats are kept and re-pointed
 * rather than rebuilt.
 */

import {
  messages,
  isStreaming,
  pendingPrepend,
  type ChatMessage,
  type ToolCallView,
} from "../../state/chat-messages.ts";
import { GATE_BLOCK_EVENT_KIND } from "../../../shared/event-types.ts";
import { chatHistoryLoad } from "../../state/chat-history-load.ts";
import { currentChatId } from "../../state/chats.ts";
import { checksForCurrentChat, type AutoCheck } from "../../state/auto-checks.ts";
import {
  activateLog,
  appendBeat,
  batch,
  beatById,
  beatCount,
  clearLog,
  DEFAULT_LOG_ID,
  prependBeats,
  replaceBeat,
  windowSlice,
} from "./log.ts";
import { soleLiveRun } from "./run-ownership.ts";
import {
  effectPathOf,
  type Beat,
  type BeatVerb,
} from "./types.ts";
import { fileEffectToolNames, toolLabel, toolManifest } from "../../state/tools.ts";
import { performedActions } from "../../state/lens.ts";
import { resetWait } from "./wait-stage.ts";
import {
  resetTurnTimings,
  turnTimingFor,
  turnTimingVersion,
  type TurnTiming,
} from "./turn-timing.ts";
import { resetThinkingFolds } from "./thinking-fold.ts";
import { uiSchema } from "../../state/schema-store.ts";
import { computeTurnRollup, computeContextProjection, asFinding } from "../computer/findings.ts";
import { proposeDeskLine, admitAtSeam, type Candidate } from "../computer/admission.ts";

export type IngestOptions = Readonly<{
  /** Verb factories — injected so the wiring lives in verbs.ts and tests can
   * pass inert verbs. Each returns the verbs for one beat. */
  verbsFor?: (beat: Beat) => readonly BeatVerb[];
  /**
   * Called when an effect beat lands, so the host may compute effect-seam
   * findings (impact reach via broker) and dock them. Optional: the flow
   * renders honestly without it.
   */
  onEffect?: (effectBeat: Beat) => void;
  /**
   * Run-boundary debounce. The streaming flag flickers false→true BETWEEN
   * model turns of one run (finish → next turn's start on the same stream),
   * and each false is not a run end. The seam waits this long and is
   * cancelled if streaming resumes — one seam per run, and still inside the
   * 300ms finding→seam budget (§1.5). Tests pass 0 for synchronous seams.
   */
  seamDebounceMs?: number;
  /**
   * Which workspace's log this ingest maintains. Defaults to the single
   * unnamed log, which is what the dev harness and the unit tests use.
   */
  workspaceId?: string;
  /**
   * The conversation this ingest was started for. Supplying it arms the
   * DORMANT rule; a mount that does not know (the harness) declares nothing
   * and ingests whatever the store holds, exactly as before.
   */
  chatId?: string | null;
}>;

/** Default run-boundary debounce (see IngestOptions.seamDebounceMs). */
const SEAM_DEBOUNCE_MS = 250;

type Synced = { msg: ChatMessage; beatId: string };

/** Every cursor that belongs to ONE workspace's ingestion. */
type IngestState = {
  readonly workspaceId: string;
  chatId: string | null | undefined;
  synced: Synced[];
  seamCounter: number;
  deltaCounter: number;
  prevCheckStatus: Map<string, string>;
  checksEverObserved: number;
  actsSeen: number;
  actCounter: number;
  wasStreaming: boolean;
  /**
   * The tool-manifest array reference this workspace's beats were last
   * folded against. The effect fold reads `fileEffectToolNames()`, which
   * derives from the manifest store — a beat folded while the manifest was
   * absent stays effect-less forever unless the fold re-runs when the
   * manifest arrives. The reference (not a deep compare) is the change
   * signal: `setTools` plants a fresh array per read.
   */
  manifestSeen: readonly unknown[] | null;
};

const states = new Map<string, IngestState>();

function stateFor(workspaceId: string): IngestState {
  let state = states.get(workspaceId);
  if (state === undefined) {
    state = {
      workspaceId,
      chatId: undefined,
      synced: [],
      seamCounter: 0,
      deltaCounter: 0,
      prevCheckStatus: new Map(),
      checksEverObserved: 0,
      actsSeen: 0,
      actCounter: 0,
      wasStreaming: false,
      manifestSeen: null,
    };
    states.set(workspaceId, state);
  }
  return state;
}

/** The state of the ingest currently running, or null when stopped. */
let current: IngestState | null = null;
let unsubscribers: Array<() => void> = [];
let options: IngestOptions = {};

/**
 * Is this store update ours to take? The three rules from the header, in
 * order, with the reason each one exists stated where it is applied.
 *
 * Returns the state when the update is ours, `null` when it is not.
 */
function claim(): IngestState | null {
  const state = current;
  if (state === null) return null;
  // DORMANT — the store is showing a different conversation.
  if (state.chatId !== undefined && currentChatId.get() !== state.chatId) return null;
  // FROZEN — another workspace's run is writing into the shared transcript.
  const owner = soleLiveRun();
  if (
    owner !== null &&
    owner.workspaceId !== state.workspaceId &&
    owner.chatId !== state.chatId
  ) {
    return null;
  }
  return state;
}

/**
 * Two ChatMessages that are the SAME RECORD under two different ids.
 *
 * The live stream names a message `msg-<counter>-<time>`; the database names
 * the same message by its row id, and a re-read of the conversation (which is
 * what returning to a workspace costs) therefore comes back with every id
 * changed and nothing else changed. Treating that as divergence rebuilt the
 * whole log for a conversation that had not moved.
 *
 * The comparison is EQUALITY on the payload, not similarity: same role, same
 * words to the byte, same tool by name and status. It never matches two
 * different records — two identical assistant turns in a row are genuinely
 * interchangeable, and mapping a beat onto either of them says the same true
 * thing about the transcript.
 */
function sameRecord(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
  if (a.role === "tool") {
    if (a.toolCall?.name !== b.toolCall?.name) return false;
    if (a.toolCall?.status !== b.toolCall?.status) return false;
  }
  return true;
}

/** Turn index = count of user messages up to and including this one, -1. */
function computeTurnIndex(list: readonly ChatMessage[], i: number): number {
  let users = 0;
  for (let j = 0; j <= i; j += 1) {
    if (list[j]!.role === "user") users += 1;
  }
  return Math.max(0, users - 1);
}

function beatIdFor(msg: ChatMessage): string {
  return `b-${msg.id}`;
}

/**
 * Map one ChatMessage to its beat. `parentModelBeatId` is the id of the
 * model-turn beat currently open (tool calls parent to it); user turns
 * parent to null; model turns parent to the user turn of the same index.
 */
function beatFromMessage(
  msg: ChatMessage,
  turnIndex: number,
  parentId: string | null,
  streaming: boolean,
): Beat {
  const id = beatIdFor(msg);
  const base = {
    id,
    parentId,
    turnIndex,
    at: msg.timestamp,
    verbs: [] as readonly BeatVerb[],
  };
  switch (msg.role) {
    case "user":
      return {
        ...base,
        kind: "turn",
        abnormal: false,
        bleed: false,
        turn: {
          who: "you",
          text: msg.content,
          streaming: false,
          // The steer marking travels with the message (chat-messages.ts
          // owns why it is not persisted); the beat renders the queued state
          // from it — the reader sees their instruction land AND what it
          // will do, in one place.
          ...(msg.steered === true ? { steered: true } : {}),
        },
      };
    case "assistant": {
      // What the STREAM said about when this turn's output began. Absent for a
      // turn re-read from the database (turn-timing.ts is a live measurement,
      // not a persisted one), and absence renders as absence.
      const timing = turnTimingFor(msg.id);
      // A turn the reconcile settled carries its ending on the record; the
      // beat is abnormal with it, exactly as an error-role row is — the
      // reader must not carry on believing an answer is coming.
      const interrupted = msg.incompleteReason !== undefined;
      return {
        ...base,
        kind: "turn",
        abnormal: interrupted,
        bleed: false,
        turn: {
          who: "model",
          sourceId: msg.id,
          text: msg.content,
          streaming,
          ...(msg.reasoning !== undefined ? { reasoning: msg.reasoning } : {}),
          ...(interrupted ? { incompleteReason: msg.incompleteReason } : {}),
          ...(timing?.answerStarted === true ? { answerStarted: true } : {}),
          ...(timing?.firstOutputMs !== undefined
            ? { firstOutputMs: timing.firstOutputMs }
            : {}),
          ...(timing?.generationMs !== undefined
            ? { generationMs: timing.generationMs }
            : {}),
          ...(msg.tokenMetrics !== undefined
            ? {
                inputTokens: msg.tokenMetrics.inputTokens,
                outputTokens: msg.tokenMetrics.outputTokens,
              }
            : {}),
          ...(msg.timingMetrics?.ttftMs !== undefined ? { firstWordMs: msg.timingMetrics.ttftMs } : {}),
          ...(msg.timingMetrics?.tps !== undefined ? { tokPerSec: msg.timingMetrics.tps } : {}),
          ...(msg.finishReason !== undefined ? { finishReason: msg.finishReason } : {}),
          ...(msg.responseModel !== undefined ? { responseModel: msg.responseModel } : {}),
          ...(msg.dedupSummary !== undefined ? { dedupSummary: msg.dedupSummary } : {}),
          ...(msg.redactionNotice !== undefined ? { redactionNotice: msg.redactionNotice } : {}),
        },
      };
    }
    case "tool": {
      const tc: ToolCallView | undefined = msg.toolCall;
      return {
        ...base,
        kind: "tool",
        abnormal: tc?.status === "error",
        bleed: true,
        tool: {
          name: tc?.name ?? "unknown tool",
          label: toolLabel(tc?.name ?? "unknown tool"),
          status: tc?.status ?? "running",
          input: tc?.input,
          output: tc?.output,
          startedAt: tc?.startedAt ?? msg.timestamp,
          ...(tc?.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
          ...(tc?.incompleteReason !== undefined ? { incompleteReason: tc.incompleteReason } : {}),
          ...(tc?.refused === true ? { refused: true as const } : {}),
          ...(tc?.attemptCount !== undefined ? { attemptCount: tc.attemptCount } : {}),
        },
      };
    }
    case "error":
      return {
        ...base,
        kind: "event",
        abnormal: true,
        bleed: true,
        event: { eventKind: "client-error", text: msg.content },
      };
    case "event": {
      // A gate block (its label is one of the gate-block map's values) is an
      // abnormal intervention, as is any error. Derived from the shared
      // kind→label map's values, not a per-kind literal list, so a new
      // gate-block kind is abnormal without an edit here.
      const ek = msg.eventKind ?? "error";
      const abnormal = ek === "error" ||
        (Object.values(GATE_BLOCK_EVENT_KIND) as readonly string[]).includes(ek);
      return {
        ...base,
        kind: "event",
        abnormal,
        bleed: true,
        event: {
          eventKind: ek,
          text: msg.content,
          // The canonical ledger address of this event, when the transcript
          // carries one (live SSE frames, timeline refs, persisted
          // metadata). Carried for the documents fold; never rendered.
          ...(msg.timelineEventId !== undefined ? { eventId: msg.timelineEventId } : {}),
        },
      };
    }
  }
}

/**
 * A MEASUREMENT TAKEN IS A MEASUREMENT KEPT.
 *
 * `turn-timing.ts` is keyed by TRANSCRIPT MESSAGE ID, and two ordinary things
 * take that key away: the map is bounded, and a conversation re-read from the
 * database comes back with every message renamed to its row id (`sameRecord`
 * up top explains why that is a rename and not a change). Either way the beat
 * would be rebuilt WITHOUT the first-token latency this session measured — a
 * number quietly disappearing off a turn nobody touched.
 *
 * So the beat carries it forward. The beat is where the measurement lives once
 * it has been taken; the map is only where it arrives. Nothing is invented:
 * this copies a value that was measured, and never manufactures one that was
 * not. `answerStarted` is carried by the same rule and for the same reason,
 * and it is monotone — an answer that began cannot un-begin.
 */
function carryTurnTiming(prev: Beat | undefined, next: Beat): Beat {
  if (next.kind !== "turn" || next.turn === undefined) return next;
  if (prev?.kind !== "turn" || prev.turn === undefined) return next;
  const keptFirstOutput = next.turn.firstOutputMs ?? prev.turn.firstOutputMs;
  const keptGeneration = next.turn.generationMs ?? prev.turn.generationMs;
  const keptAnswerStarted =
    next.turn.answerStarted === true || prev.turn.answerStarted === true;
  if (
    keptFirstOutput === next.turn.firstOutputMs &&
    keptGeneration === next.turn.generationMs &&
    keptAnswerStarted === (next.turn.answerStarted === true)
  ) {
    return next;
  }
  return {
    ...next,
    turn: {
      ...next.turn,
      ...(keptFirstOutput !== undefined ? { firstOutputMs: keptFirstOutput } : {}),
      ...(keptGeneration !== undefined ? { generationMs: keptGeneration } : {}),
      ...(keptAnswerStarted ? { answerStarted: true } : {}),
    },
  };
}

function withVerbs(beat: Beat): Beat {
  const verbsFor = options.verbsFor;
  if (verbsFor === undefined) return beat;
  return { ...beat, verbs: verbsFor(beat) };
}

/**
 * A successful file-editing tool call commits an effect beat (§3.2). The
 * effect id derives from the tool message id so re-syncs are idempotent.
 */
function maybeAppendEffect(toolBeat: Beat): void {
  const effect = effectBeatFor(toolBeat);
  if (effect === null) return;
  appendBeat(withVerbs(effect));
  options.onEffect?.(effect);
}

/**
 * The effect beat a tool beat commits, or null. Pure and PLACEMENT-FREE,
 * because there are now two places one can land: appended at the tail as a
 * run streams, and interleaved into a page of older beats being prepended
 * (§4). One rule for what an effect IS, two callers deciding where it goes.
 */
function effectBeatFor(toolBeat: Beat): Beat | null {
  if (toolBeat.tool === undefined) return null;
  if (toolBeat.tool.status !== "done") return null;
  if (!fileEffectToolNames().has(toolBeat.tool.name)) return null;
  const path = effectPathOf(toolBeat.tool.input);
  if (path === null) return null;
  const effectId = `${toolBeat.id}-fx`;
  if (beatById(effectId) !== undefined) return null;
  return {
    id: effectId,
    kind: "effect",
    parentId: toolBeat.id,
    turnIndex: toolBeat.turnIndex,
    // ── THE EFFECT IS DATED BY THE CALL THAT PRODUCED IT, NOT BY NOW ──────
    //
    // This read `Date.now()`. For a beat minted as a run streams, that is
    // very nearly the commit instant and it looked harmless. For a beat
    // REBUILT from the database it is the instant the browser rebuilt it —
    // which is not a fact about the conversation at all, and it is the one
    // field the sweep's scrub joins on (`beatsAtOrBefore` walks a PREFIX
    // because a beat recorded later cannot belong to an earlier moment).
    //
    // Paging made that fatal rather than untidy: an older page's effect
    // beats would be stamped NOW and placed at the FRONT, so the prefix walk
    // would stop at the first of them and a planted head would render an
    // empty conversation.
    //
    // The tool call's own recorded instant is a MEASURED time from the
    // record, and it is the time of the fact this effect belongs to. It is
    // not the commit instant and does not claim to be — the row does not
    // carry one, and inventing a plausible offset would be fabrication.
    at: toolBeat.at,
    abnormal: false,
    bleed: true,
    verbs: [],
    effect: { path, producedBy: toolBeat.id },
  };
}

/** Full resync — hydration replaced the transcript (records diverged). */
function rebuild(state: IngestState, list: readonly ChatMessage[], streaming: boolean): void {
  clearLog();
  state.synced = [];
  state.seamCounter = 0;
  state.deltaCounter = 0;
  syncInto(state, list, streaming);
}

/**
 * AN EMPTY TRANSCRIPT IS TWO DIFFERENT FACTS, and only one owner can tell
 * them apart (state/chat-history-load.ts): "the history has not arrived yet"
 * (absence — hold the beats) and "the history arrived and the conversation
 * has no messages" (a MEASURED emptiness — the beats on screen belong to a
 * conversation the reader has left, and holding them renders the previous
 * conversation inside the new one until the first send finally diverges the
 * transcript). The second case was exactly that defect, live: a new
 * conversation opened onto the old conversation's beats.
 */
function measuredEmpty(state: IngestState): boolean {
  const load = chatHistoryLoad.get();
  if (load === null || load.kind !== "measured") return false;
  // The read that landed must be for the conversation THIS ingest serves —
  // a measured emptiness of some other conversation says nothing about ours.
  const servedChat = state.chatId !== undefined ? state.chatId : currentChatId.get();
  return servedChat !== null && load.chatId === servedChat;
}

function syncMessages(list: readonly ChatMessage[], streaming: boolean): void {
  const state = claim();
  if (state === null) return;
  // ABSENT — the store between "the chat changed" and "the history arrived".
  // An empty transcript is the absence of one, and never a reason to throw
  // away beats we already hold; the warm log is the whole point of the tab.
  // EXCEPT when the history read for this conversation has LANDED empty:
  // that is a measured emptiness, and the held beats are another
  // conversation's (see `measuredEmpty`).
  if (list.length === 0 && state.synced.length > 0) {
    if (!measuredEmpty(state)) return;
    rebuild(state, list, streaming);
    return;
  }
  // THE EFFECT FOLD IS A FUNCTION OF THE MANIFEST TOO. A beat folded while
  // the tool manifest was still absent (the read racing the first sync at
  // boot, a tab resumed before the manifest landed) carries no effect beat,
  // and nothing else would ever revisit it: the in-place update path only
  // re-folds CHANGED messages. When the manifest reference this workspace
  // last folded against is no longer the store's, re-fold — and because a
  // mid-log effect must land in causal position (never appended at the
  // tail), the honest placement-correct operation is the same rebuild a
  // transcript divergence gets. Guarded: nothing missing → no rebuild, so
  // a manifest refresh costs one walk, and a normal sync (same reference)
  // costs one comparison.
  if (toolManifest.get() !== state.manifestSeen) {
    state.manifestSeen = toolManifest.get();
    if (someEffectBeatMissing(state)) {
      rebuild(state, list, streaming);
      return;
    }
  }
  syncInto(state, list, streaming);
}

/**
 * Whether any settled tool beat in this workspace is missing its effect
 * beat under the CURRENT manifest. Pure read; the caller decides what to do
 * about it.
 */
function someEffectBeatMissing(state: IngestState): boolean {
  for (const entry of state.synced) {
    const beat = beatById(entry.beatId);
    if (beat === undefined || beat.kind !== "tool") continue;
    if (effectBeatFor(beat) !== null) return true;
  }
  return false;
}

/**
 * ── A PAGE OF OLDER MESSAGES ARRIVED AT THE FRONT (§4) ────────────────────
 *
 * Every cursor in this module is POSITIONAL: `synced[i]` is the beat built
 * for `list[i]`. A prepend shifts all of them by exactly the page's length,
 * and from inside a `messages` subscription that shift is indistinguishable
 * from the transcript having been replaced — which `syncInto` answers by
 * rebuilding the whole log. For a prepend that would be catastrophic and
 * silent: every beat, every measured height and the reader's place thrown
 * away in order to add rows ABOVE them.
 *
 * So the prepend is announced (`pendingPrepend`, set before `messages.set`)
 * and applied here, as a delta: `count` new beats built and placed in front,
 * the existing beats untouched, the existing cursors shifted.
 *
 * TURN INDICES RUN BACKWARDS FROM THE HEAD, and that is deliberate. The turn
 * index of a beat is "how many of your turns preceded it", and the honest
 * value for a beat the session has not seen the start of is unknowable — the
 * conversation may have thousands of earlier turns. Renumbering the beats
 * already on screen so the prefix could start at 0 would be worse than
 * unknowable: every fisheye decision, every group and every reason string
 * about beats the reader is LOOKING AT would change because of rows arriving
 * above them. So the prefix is numbered DOWN from the head — negative where
 * it must be — which keeps every DIFFERENCE (the only thing the fisheye and
 * the grouping ever read) exactly right, and touches nothing already drawn.
 */
function ingestPrefix(
  state: IngestState,
  list: readonly ChatMessage[],
  count: number,
  streaming: boolean,
): void {
  const prefix = list.slice(0, count);
  if (prefix.length === 0) return;
  // The turn the loaded conversation currently starts at, and how many of
  // the reader's turns the prefix adds below it.
  const headBeat = state.synced.length > 0 ? beatById(state.synced[0]!.beatId) : undefined;
  const headTurn = headBeat?.turnIndex ?? 0;
  const usersInPrefix = prefix.filter((m) => m.role === "user").length;
  const turnOffset = headTurn - usersInPrefix;

  const built: Beat[] = [];
  const synced: Synced[] = [];
  let openModelBeatId: string | null = null;
  let lastUserBeatId: string | null = null;
  for (let i = 0; i < prefix.length; i += 1) {
    const msg = prefix[i]!;
    let parentId: string | null = null;
    if (msg.role === "assistant") parentId = lastUserBeatId;
    else if (msg.role === "tool" || msg.role === "event" || msg.role === "error") {
      parentId = openModelBeatId;
    }
    // `streaming` is FALSE for every beat of an older page without needing a
    // test: a page fetched from the database is a page of finished facts, and
    // the only beat that may be streaming is the last of the whole list,
    // which by construction is not in a prefix.
    void streaming;
    const beat = beatFromMessage(msg, turnOffset + computeTurnIndex(prefix, i), parentId, false);
    built.push(beat);
    synced.push({ msg, beatId: beat.id });
    if (msg.role === "user") lastUserBeatId = beat.id;
    if (beat.kind === "turn" && beat.turn?.who === "model") openModelBeatId = beat.id;
    const effect = effectBeatFor(beat);
    if (effect !== null) built.push(effect);
  }

  batch(() => {
    // Bare beats FIRST, verbs second — the same two steps the append path
    // takes, and for the same reason: a verb factory may walk the log for the
    // prompt that caused a beat, so the beat has to be addressable before its
    // verbs are computed.
    prependBeats(built);
    for (const beat of built) replaceBeat(beat.id, withVerbs(beat));
    state.synced.unshift(...synced);
    repairBoundaryParentage(state, count);
  });
  for (const beat of built) {
    if (beat.kind === "effect") options.onEffect?.(beat);
  }
}

/**
 * THE BEAT THAT WAS ALREADY AT THE TOP MAY NOW HAVE A CAUSE.
 *
 * A model turn built when the conversation was loaded at its tail has
 * `parentId: null` — honestly, because the user turn that caused it was not
 * loaded. When the page carrying that user turn arrives, the cause exists and
 * the null becomes a lie of omission: the causal ribbon stops at the page
 * seam, and "what led to this" answers nothing when it now has an answer.
 *
 * Bounded to the beats BEFORE the first user turn of the previously-loaded
 * region: those are exactly the ones whose cause could only have been in the
 * page that just arrived. Everything after has had its parent all along.
 */
function repairBoundaryParentage(state: IngestState, prefixLength: number): void {
  const synced = state.synced;
  let lastUserBeatId: string | null = null;
  for (let i = prefixLength - 1; i >= 0; i -= 1) {
    if (synced[i]!.msg.role === "user") {
      lastUserBeatId = synced[i]!.beatId;
      break;
    }
  }
  if (lastUserBeatId === null) return;
  let openModelBeatId: string | null = null;
  for (let i = prefixLength - 1; i >= 0; i -= 1) {
    const beat = beatById(synced[i]!.beatId);
    if (beat?.kind === "turn" && beat.turn?.who === "model") {
      openModelBeatId = beat.id;
      break;
    }
  }
  for (let i = prefixLength; i < synced.length; i += 1) {
    const entry = synced[i]!;
    if (entry.msg.role === "user") return;
    const beat = beatById(entry.beatId);
    if (beat === undefined) continue;
    if (beat.kind === "turn" && beat.turn?.who === "model") {
      if (beat.parentId === null) replaceBeat(beat.id, { ...beat, parentId: lastUserBeatId });
      openModelBeatId = beat.id;
      continue;
    }
    if (beat.parentId === null && openModelBeatId !== null) {
      replaceBeat(beat.id, { ...beat, parentId: openModelBeatId });
    }
  }
}

function syncInto(
  state: IngestState,
  list: readonly ChatMessage[],
  streaming: boolean,
): void {
  // The announced prefix, BEFORE the positional divergence check below —
  // which would otherwise read a prepend as a different conversation.
  const prepend = pendingPrepend.get();
  if (prepend !== null && prepend.chatId === state.chatId) {
    pendingPrepend.set(null);
    ingestPrefix(state, list, prepend.count, streaming);
  }
  const synced = state.synced;
  // Divergence check: every already-synced record must still match
  // positionally — by id, or (a re-read of the same conversation) by being
  // the same record under a different id.
  let reidentified = false;
  for (let i = 0; i < synced.length; i += 1) {
    if (i >= list.length) {
      rebuild(state, list, streaming);
      return;
    }
    if (list[i]!.id === synced[i]!.msg.id) continue;
    if (sameRecord(list[i]!, synced[i]!.msg)) {
      reidentified = true;
      continue;
    }
    rebuild(state, list, streaming);
    return;
  }
  if (reidentified) {
    // Re-point the cursor at the newly-named records. The BEATS keep their
    // ids: they are the join key for parentage, for the height index's
    // stamps, for the expansion map and for the fisheye's manual overrides,
    // and re-keying them would invalidate all four to fix nothing.
    for (let i = 0; i < synced.length; i += 1) synced[i]!.msg = list[i]!;
  }

  batch(() => {
    // In-place updates for messages whose object identity changed.
    let openModelBeatId: string | null = null;
    for (let i = 0; i < synced.length; i += 1) {
      const msg = list[i]!;
      const prev = synced[i]!;
      const beat = beatById(prev.beatId);
      if (beat?.kind === "turn" && beat.turn?.who === "model") openModelBeatId = beat.id;
      if (msg === prev.msg && beat !== undefined) {
        // Streaming flag may still need to change on the last model beat.
        if (
          beat.kind === "turn" &&
          beat.turn?.who === "model" &&
          beat.turn.streaming &&
          (!streaming || i !== list.length - 1)
        ) {
          replaceBeat(beat.id, { ...beat, turn: { ...beat.turn, streaming: false } });
        }
        continue;
      }
      if (beat === undefined) continue;
      const isLast = i === list.length - 1;
      const next = carryTurnTiming(
        beat,
        withVerbs(
          beatFromMessage(msg, beat.turnIndex, beat.parentId, streaming && isLast && msg.role === "assistant"),
        ),
      );
      replaceBeat(beat.id, next);
      synced[i] = { msg, beatId: beat.id };
      if (next.kind === "tool") maybeAppendEffect(beatById(beat.id)!);
    }

    // Appends.
    for (let i = synced.length; i < list.length; i += 1) {
      const msg = list[i]!;
      const turnIndex = computeTurnIndex(list, i);
      let parentId: string | null = null;
      if (msg.role === "assistant") {
        // Model turn parents to the user turn that caused it.
        for (let j = i - 1; j >= 0; j -= 1) {
          if (list[j]!.role === "user") {
            // Through the CURSOR where one exists: after a re-identification
            // the beat keeps its old id while the record has a new one, and
            // deriving the parent from the record would name a beat that is
            // not in the log.
            parentId = j < synced.length ? synced[j]!.beatId : beatIdFor(list[j]!);
            break;
          }
        }
      } else if (msg.role === "tool" || msg.role === "event" || msg.role === "error") {
        parentId = openModelBeatId;
      }
      const isLast = i === list.length - 1;
      const bare = beatFromMessage(msg, turnIndex, parentId, streaming && isLast && msg.role === "assistant");
      // Append FIRST, wire verbs SECOND: verb factories may consult the log
      // (e.g. "retry" walks back to the causing prompt), so the beat must be
      // addressable before its verbs are computed. Both writes share the
      // surrounding batch — one version bump.
      appendBeat(bare);
      const beat = withVerbs(bare);
      replaceBeat(beat.id, beat);
      synced.push({ msg, beatId: beat.id });
      if (beat.kind === "turn" && beat.turn?.who === "model") openModelBeatId = beat.id;
      if (beat.kind === "tool") maybeAppendEffect(beat);
    }
  });
}

/**
 * ── THE ANSWER STARTING IS A BEAT CHANGE THE TRANSCRIPT NEVER REPORTS ──────
 *
 * The transcript store is deliberately NOT rewritten per answer token: the
 * in-flight text streams through the `streamingTail` atom so the message array
 * is untouched (the O(1) streaming property, §3.8). Which is exactly why the
 * beat cannot learn from `messages` that the answer has begun — the one event
 * the thinking fold has to collapse on.
 *
 * So the observed boundary comes in on its own signal. `turn-timing.ts` bumps
 * its version when it records the first token of a turn (either kind) and when
 * it records the first ANSWER token; this re-stamps the affected model beats
 * and nothing else. One beat replacement per turn per fact, not per token.
 *
 * Only the tail of the log is examined: a turn whose output began is a turn
 * that is streaming or has just stopped, which is always within the last few
 * messages. Walking the whole transcript to find it would be O(n) on a signal
 * that fires during a live run.
 */
const TIMING_LOOKBACK = 6;

function syncTurnTiming(): void {
  const state = claim();
  if (state === null) return;
  const synced = state.synced;
  const from = Math.max(0, synced.length - TIMING_LOOKBACK);
  batch(() => {
    for (let i = from; i < synced.length; i += 1) {
      const entry = synced[i]!;
      const beat = beatById(entry.beatId);
      if (beat === undefined || beat.kind !== "turn") continue;
      const turn = beat.turn;
      if (turn === undefined || turn.who !== "model") continue;
      const timing: TurnTiming | undefined = turnTimingFor(entry.msg.id);
      if (timing === undefined) continue;
      const answerStarted = turn.answerStarted === true || timing.answerStarted;
      const firstOutputMs = turn.firstOutputMs ?? timing.firstOutputMs;
      const generationMs = timing.generationMs ?? turn.generationMs;
      if (
        answerStarted === (turn.answerStarted === true) &&
        firstOutputMs === turn.firstOutputMs &&
        generationMs === turn.generationMs
      ) {
        continue;
      }
      replaceBeat(beat.id, {
        ...beat,
        turn: {
          ...turn,
          ...(answerStarted ? { answerStarted: true } : {}),
          ...(firstOutputMs !== undefined ? { firstOutputMs } : {}),
          ...(generationMs !== undefined ? { generationMs } : {}),
        },
      });
    }
  });
}

/** Check-store transitions → check-delta beats (deltas ONLY, §3.2). */
function syncChecks(checks: readonly AutoCheck[]): void {
  const state = claim();
  if (state === null) return;
  state.checksEverObserved = Math.max(state.checksEverObserved, checks.length);
  batch(() => {
    for (const check of checks) {
      const prev = state.prevCheckStatus.get(check.id);
      state.prevCheckStatus.set(check.id, check.status);
      if (prev === undefined || prev === check.status) continue;
      // "running" is a transient state, not a delta worth a beat.
      if (check.status === "running") continue;
      state.deltaCounter += 1;
      const currentTurn = lastTurnIndex();
      const errorCount = countErrors(check.output);
      const beat: Beat = withVerbs({
        id: `cd-${check.id}-${state.deltaCounter}`,
        kind: "check-delta",
        parentId: lastModelBeatId(),
        turnIndex: currentTurn,
        at: Date.parse(check.createdAt) || Date.now(),
        abnormal: check.status === "failed",
        bleed: true,
        verbs: [],
        checkDelta: {
          checkId: check.id,
          checkName: check.checkName,
          from: prev,
          to: check.status,
          ...(errorCount !== undefined ? { errorCount } : {}),
        },
      });
      appendBeat(beat);
    }
  });
}

function countErrors(output: unknown): number | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (typeof o["errorCount"] === "number") return o["errorCount"];
  if (Array.isArray(o["errors"])) return o["errors"].length;
  return undefined;
}

/**
 * ── OPERATOR INTERVENTIONS ────────────────────────────────────────────────
 *
 * How many acts of the Broker's bounded log have already been turned into
 * beats. The log is append-only and capped (PROVENANCE_HISTORY_LIMIT), so a
 * plain high-water mark is enough while it is growing, and a SHRINK (the cap
 * evicting the oldest) is detected and re-based rather than replayed — a
 * replay would append the same intervention twice, and an intervention that
 * appears twice is a lie about how many times you did it.
 *
 * Per workspace (`IngestState.actsSeen` / `.actCounter`), because an
 * intervention is an act on ONE conversation: minting the acts you performed
 * in tab A into tab B's log would attribute your steering to the wrong run.
 */

/**
 * The DECLARED words for one action, from the served manifest — or nothing.
 *
 * `blockActions` is built at registration time from the same `title` and
 * `consequence` the control shows, and the server refuses to start if an
 * action declares neither (server/blocks/define.ts). Quoting it is what keeps
 * the log and the control from disagreeing.
 *
 * When the schema has not loaded, or names no such action, this returns
 * undefined and the beat renders the absence. It never falls back to prettying
 * up the id: "run.compose/trim" turned into "Trim the compose" would be a
 * sentence nobody declared.
 *
 * Exported because the right menu's act trail renders the same words for the
 * same records — the join is spelled once, here, so the flow's act beats and
 * the menu's trail cannot disagree about what a control does.
 */
export function declaredWords(
  block: string,
  action: string,
): Readonly<{ title: string; consequence: string }> | undefined {
  const manifest = uiSchema.get()?.blockActions;
  const found = manifest?.[block]?.find((d) => d.name === action);
  if (found === undefined) return undefined;
  return { title: found.title, consequence: found.consequence };
}

/**
 * Mint a beat for every act recorded since the last pass.
 *
 * PARENTAGE: the intervention is attached to the model turn that was open
 * when you made it, because that is genuinely where it sits in the causal
 * order — it is the thing that changes what the NEXT turn receives. When no
 * model turn has happened yet it has no parent, which is honest rather than
 * invented.
 */
function syncActs(): void {
  const state = claim();
  if (state === null) return;
  const log = performedActions.get();
  // The cap evicted entries: everything currently held is older than or equal
  // to what we already minted, so re-base instead of replaying.
  if (log.length < state.actsSeen) {
    state.actsSeen = log.length;
    return;
  }
  if (log.length === state.actsSeen) return;
  const fresh = log.slice(state.actsSeen);
  state.actsSeen = log.length;
  batch(() => {
    for (const record of fresh) {
      // Authentication identifies whose telemetry this is, not who pressed
      // a control. Only recorded operator gestures are conversation acts.
      if (record.origin !== "operator") continue;
      const words = declaredWords(record.block, record.action);
      state.actCounter += 1;
      const beat: Beat = {
        id: `act-${state.actCounter}`,
        kind: "act",
        parentId: lastModelBeatId(),
        turnIndex: lastTurnIndex(),
        at: record.settledAt,
        // A refused intervention changed nothing and the reader must not
        // assume otherwise, so it declares itself abnormal and the fisheye
        // refuses to compress it away.
        abnormal: record.state === "failed",
        bleed: true,
        verbs: [],
        act: {
          block: record.block,
          action: record.action,
          ...(words !== undefined
            ? { title: words.title, consequence: words.consequence }
            : {}),
          state: record.state,
          ...(record.input !== undefined ? { input: record.input } : {}),
          latencyMs: record.latencyMs,
          ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
        },
      };
      appendBeat(beat);
      replaceBeat(beat.id, withVerbs(beat));
    }
  });
}

function lastTurnIndex(): number {
  const n = beatCount();
  for (const beat of [...windowSlice(Math.max(0, n - 50), n)].reverse()) {
    if (beat.kind === "turn") return beat.turnIndex;
  }
  return 0;
}

function lastModelBeatId(): string | null {
  const n = beatCount();
  for (const beat of [...windowSlice(Math.max(0, n - 50), n)].reverse()) {
    if (beat.kind === "turn" && beat.turn?.who === "model") return beat.id;
  }
  return null;
}

/**
 * Run boundary: streaming true → false. Renders the turn seam (§3.3 step 8)
 * and proposes the desk-line context projection (§4.3).
 */
function onRunEnded(): void {
  const state = claim();
  if (state === null) return;
  const turnIndex = lastTurnIndex();
  const n = beatCount();
  const turnBeats = windowSlice(0, n).filter((b) => b.turnIndex === turnIndex && b.kind !== "seam");
  if (turnBeats.length === 0) return;
  let oldest = Number.POSITIVE_INFINITY;
  for (const b of turnBeats) if (b.at < oldest) oldest = b.at;
  const rollup = computeTurnRollup({
    turnIndex,
    beats: turnBeats,
    checksObserved: state.checksEverObserved,
    asOf: oldest,
  });
  const abnormal = turnBeats.some((b) => b.abnormal);
  const candidate: Candidate = { finding: asFinding(rollup, "turn-rollup"), abnormal };
  const admission = admitAtSeam([candidate]);
  if (admission.admitted !== null) {
    state.seamCounter += 1;
    const seam: Beat = withVerbs({
      id: `seam-${state.seamCounter}`,
      kind: "seam",
      parentId: null,
      turnIndex,
      at: Date.now(),
      abnormal,
      bleed: true,
      verbs: [],
      seam: {
        turnIndex,
        sentence: admission.admitted.finding.sentence,
        derivation: admission.admitted.finding.derivation,
        queued: admission.queued.length,
      },
    });
    appendBeat(seam);
  }

  // Desk line: projection about the NEXT turn (renders above the composer).
  const points = messages
    .get()
    .filter((m) => m.context?.contextTokens !== undefined)
    .map((m) => ({
      contextTokens: m.context!.contextTokens!,
      ...(m.context!.contextTokenLimit !== undefined
        ? { contextTokenLimit: m.context!.contextTokenLimit }
        : {}),
      at: m.timestamp,
    }));
  const projection = computeContextProjection(points);
  if (projection !== null) {
    proposeDeskLine(asFinding(projection, "context-projection"));
  }
}

/**
 * Start (or RESUME) ingesting for one workspace. Idempotent per session:
 * stops any previous ingestion. Returns the stop function.
 *
 * A RESUME IS NOT A START. The workspace's cursors are kept in `states` and
 * its beats in its own log, so coming back to a tab re-attaches to work
 * already done: `activateLog` puts the beats on screen in the same frame, and
 * the sync below reconciles them against whatever the transcript store holds
 * — which, for a conversation that has not moved, is nothing to do at all.
 */
export function startIngest(opts: IngestOptions = {}): () => void {
  stopIngest();
  options = opts;
  const workspaceId = opts.workspaceId ?? DEFAULT_LOG_ID;
  const state = stateFor(workspaceId);
  state.chatId = opts.chatId;
  current = state;
  // The log this ingest writes and the flow reads: one assignment, no clear.
  activateLog(workspaceId);
  state.wasStreaming = isStreaming.get();

  // Initial sync of whatever the stores already hold.
  syncMessages(messages.get(), state.wasStreaming);
  // Seed check statuses WITHOUT deltas: standing state is not a delta. Only
  // on a FIRST start for this workspace — a resume already knows them, and
  // re-seeding would swallow a transition that happened while it was away.
  if (state.prevCheckStatus.size === 0) {
    for (const check of checksForCurrentChat.get()) {
      state.prevCheckStatus.set(check.id, check.status);
    }
    state.checksEverObserved = checksForCurrentChat.get().length;
  }

  // Interventions recorded BEFORE this ingest started belong to an earlier
  // mount of the same session; they are not replayed into this log.
  state.actsSeen = performedActions.get().length;

  const debounceMs = opts.seamDebounceMs ?? SEAM_DEBOUNCE_MS;
  unsubscribers.push(
    // The Broker's write door is the one place an operator act is recorded.
    // This reads the ALWAYS-LIVE mirror of that ledger (state/lens.ts
    // `performedActions`), not `lensActions` — that atom only advances while
    // the LENS is powered, and the flow must record an intervention whether
    // or not anyone happens to be looking at the lens.
    performedActions.subscribe(() => syncActs()),
    // The observed output boundary (turn-timing.ts). See `syncTurnTiming`:
    // the transcript cannot carry this, because the transcript is deliberately
    // not rewritten per token.
    turnTimingVersion.subscribe(() => syncTurnTiming()),
    messages.subscribe((list) => syncMessages(list, isStreaming.get())),
    // The tool manifest arriving (or changing) re-folds the effect beats —
    // see `syncMessages`'s manifest guard. A subscription rather than a
    // call site: every mount of every workspace self-heals, and no future
    // caller of setTools can forget the fold.
    toolManifest.subscribe(() => syncMessages(messages.get(), isStreaming.get())),
    // The history read LANDING is its own event: `noteChatHistoryRead` fires
    // AFTER the hydration wrote the transcript, so for a conversation whose
    // history is empty the messages emission above arrives while the load
    // still says "pending" and the measured-empty rule cannot fire yet. This
    // re-runs the sync at the moment the one owner can finally say which
    // kind of empty the transcript is.
    chatHistoryLoad.subscribe(() => syncMessages(messages.get(), isStreaming.get())),
    isStreaming.subscribe((streaming) => {
      const wasStreaming = state.wasStreaming;
      if (wasStreaming && !streaming) {
        // Sync first so the final message state is in the log.
        syncMessages(messages.get(), false);
        // The seam waits out the inter-turn flicker (finish → next start on
        // the same stream). Streaming resuming cancels it — one seam per
        // run, never one per model turn.
        if (debounceMs === 0) {
          onRunEnded();
        } else {
          if (seamTimer !== null) clearTimeout(seamTimer);
          seamTimer = setTimeout(() => {
            seamTimer = null;
            if (!isStreaming.get()) onRunEnded();
          }, debounceMs);
        }
      } else if (streaming && seamTimer !== null) {
        clearTimeout(seamTimer);
        seamTimer = null;
      }
      state.wasStreaming = streaming;
    }),
    checksForCurrentChat.subscribe((checks) => syncChecks(checks)),
  );
  return stopIngest;
}

let seamTimer: ReturnType<typeof setTimeout> | null = null;

export function stopIngest(): void {
  for (const stop of unsubscribers) stop();
  unsubscribers = [];
  current = null;
  if (seamTimer !== null) {
    clearTimeout(seamTimer);
    seamTimer = null;
  }
}

/**
 * Forget one workspace's ingestion cursors — its tab was CLOSED. Its log is
 * dropped by the same caller; keeping the cursor for a workspace that no
 * longer exists would make a recycled id resume somebody else's transcript.
 */
export function forgetIngestState(workspaceId: string): void {
  states.delete(workspaceId);
}

/** Reset everything (chat switch / tests). Clears the log. */
export function resetIngest(): void {
  stopIngest();
  clearLog();
  states.clear();
  options = {};
  // The wait instrument belongs to A RUN IN THIS CONVERSATION. Starting the
  // flow over (a chat switch, a reload of the log) means there is no such run
  // to be waiting on, and an instrument left holding the previous
  // conversation's furthest milestone would be reporting a fact about
  // something the reader is no longer looking at.
  resetWait();
  // The live latency measurements and the reader's thinking-fold decisions are
  // facts about THE BEATS BEING THROWN AWAY. Keeping either would hand the next
  // conversation a latency nobody measured for it, or a fold preference the
  // reader expressed about a different message.
  resetTurnTimings();
  resetThinkingFolds();
}
