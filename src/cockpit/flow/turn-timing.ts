/**
 * WHEN THE MODEL'S OUTPUT ACTUALLY BEGAN — observed, per model turn.
 *
 * ── A DESIGN DECISION (provenance corrected — not a user instruction) ────────────────────────────────────────────
 *
 *   "for thinking models, ttft is from the time it starts thinking"
 *
 * They are right, and the reason is that thinking tokens ARE output. The
 * moment they begin arriving the reader is watching the model work and the
 * wait is over; a latency measured to the first ANSWER token reports a wait
 * nobody experienced. On this provider that gap is not a rounding error —
 * a `glm-5.2` turn measured here spent 37 reasoning deltas before its first
 * content delta, and earlier in this session first-word latencies of 26s and
 * 136s were recorded.
 *
 * ── TWO QUANTITIES, BOTH KEPT, NEITHER REDEFINED ───────────────────────────
 *
 * THIS IS THE HONESTY DECISION AND IT IS DELIBERATE. There was an easier
 * option: change the existing first-token clock to stop at the first thinking
 * token and be done. It was refused. `timingMetrics.ttftMs` — recorded by
 * `src/client.ts` live and by the server into every assistant message's
 * metadata, and rendered in this product as "first word" — has ALWAYS meant
 * "time to the first token of the ANSWER" (both writers set their clock in the
 * `text_delta` branch). Every latency already in the database means that.
 * Redefining it in place would leave one column holding two different
 * quantities with nothing to tell them apart, and this product computes
 * deviations by matching the present against its recorded past (§4.2) — so a
 * comparison spanning today would be a quiet lie, told by a join that has no
 * way to notice.
 *
 * So a SECOND, distinctly named quantity is added instead:
 *
 *   firstOutputMs — time to the FIRST TOKEN OF ANY KIND (thinking or answer).
 *                   The user's TTFT. Rendered as "first token".
 *   ttftMs        — unchanged, unmoved, still time to the first ANSWER token.
 *                   Rendered as "first word", exactly as before.
 *
 * Nothing recorded before today changes meaning, so no record needs marking
 * and no comparison needs refusing. A turn with no thinking simply has the two
 * numbers equal, which needs no special case: "the first token of any kind" IS
 * the first answer token when there was nothing before it. And a long think is
 * itself worth knowing about — the DIFFERENCE between the two numbers is how
 * long the model spent thinking before it said anything, which neither number
 * carries alone.
 *
 * ── WHY THE MEASUREMENT LIVES HERE ─────────────────────────────────────────
 *
 * `firstOutputMs` is NOT persisted; the server's metadata blob does not carry
 * it and this module does not reach into the server to make it. It is measured
 * from the frames THIS session received (flow/run-stream.ts is the cockpit's
 * own consumer of the run stream, and it sees every model event), so a
 * conversation re-read from the database has no such measurement and renders
 * its absence rather than a number nobody took (§1.1).
 *
 * ── ANSWER-START IS AN OBSERVED FRAME, NOT AN INFERENCE ────────────────────
 *
 * `answerStarted` flips on a received `text_delta` and on nothing else. It is
 * the boundary the thinking fold collapses at (thinking-fold.ts), and it had
 * to be a fact rather than a guess: inferring "the answer began" from content
 * shape, or from a pause, or from a delay, would be fabricated data. The wire
 * distinguishes the two — `reasoning_delta` and `text_delta` are separate
 * members of the model-event union (contracts) and the provider genuinely
 * sends them in that order — so there is nothing to infer.
 */

import { atom } from "nanostores";

import { registerReset } from "../../state/store-registry.ts";
import { MS_PER_SECOND } from "../../../shared/constants.ts";
import type { TurnBody } from "./types.ts";

/**
 * WHICH CHANNEL A RECEIVED FRAME CARRIED.
 *
 * A model turn does not stream one thing. It streams thinking, then the reply,
 * and in between it can spend thousands of characters emitting a tool call's
 * ARGUMENTS — and those three are different enough that the reader must be
 * told which one they are watching arrive.
 */
export type ArrivalChannel = "thinking" | "answer" | "tool-input";

/** What was observed about ONE model turn's output, all of it measured. */
export type TurnTiming = Readonly<{
  /** Receipt time of the turn's `start` frame — the clock's zero. */
  startedAt?: number;
  /** Receipt of this turn's first ending. Replayed output cannot reopen it. */
  finishedAt?: number;
  /** ms from `start` to the first token of ANY kind. Absent until one lands. */
  firstOutputMs?: number;
  /** True once a `text_delta` has been received for this turn. */
  answerStarted: boolean;
  /**
   * EVERY CHARACTER THIS TURN'S WIRE CARRIED — thinking, reply and tool-call
   * arguments alike. Counted, never estimated.
   *
   * THE DEFECT THIS EXISTS FOR (reported, and pre-existing): the token rail
   * advances one cell per observed arrival and freezes when nothing arrives —
   * which is the honest behaviour, and is why a frozen rail means the
   * instrument is being fed nothing. It was fed the ANSWER TEXT ONLY. So
   * through the entire emission of a `create_artifact` call — an argument
   * object carrying a whole HTML document, tens of thousands of characters —
   * the model was working at full rate and the rail sat dead, resuming only
   * when prose came back. The user watched it "stop moving and counting
   * between 400-600 tokens", which is the length of the PREAMBLE before the
   * tool call, not any buffer threshold.
   *
   * It is not artifact-specific: `src/client.ts` discards every
   * `tool_call_delta` outright ("Partial arguments are not accumulated"), so
   * those characters reach no store at all and ANY tool call with sizeable
   * arguments freezes the rail for as long as it takes to emit them. Artifacts
   * merely made a blink into a stall.
   *
   * Counting them here does not bend the instrument's law — that motion must
   * be caused by something genuinely arriving. A tool-call argument delta IS a
   * received frame. What would break the law is a timer keeping the rail alive
   * through a real stall, and there is none.
   */
  observedChars: number;
  /** The channel the most recent observed frame carried, or null. */
  lastChannel: ArrivalChannel | null;
  /**
   * HOW LONG THIS TURN SPENT PRODUCING — first token of any kind to `finish`.
   *
   * A DESIGN DECISION — not a user request. An earlier version of this comment
   * fabricated a verbatim user quote here; the user never said it. The decision
   * stands on its own merits, recorded below. The footer already had a `tok/s` slot
   * and it was ALWAYS EMPTY, for a reason that is worth writing down because
   * nothing about it is visible from the client's own code:
   *
   *   `src/client.ts` computes tokens-per-second in its `finish` handler, and
   *   guards it on `m.tokenMetrics !== undefined`. THIS PROVIDER SENDS `usage`
   *   AFTER `finish` — verified against the wire: the finish-reason chunk
   *   arrives, and only then a chunk carrying `usage` and no choices. So at
   *   the moment the rate is computed the token counts do not exist yet, the
   *   guard fails, and no rate is ever written. The counts land a frame later
   *   and nothing recomputes. That is why every turn showed its token totals
   *   and never its rate.
   *
   * Measuring the WINDOW instead of the rate is what makes the ordering stop
   * mattering: the duration is a fact about frames this module already
   * watches, and the rate is arithmetic done at render time against whatever
   * token count the beat has by then. Late `usage` simply fills in later.
   *
   * The window starts at the FIRST TOKEN OF ANY KIND, which is the same
   * decision as ttft and is required for the number to mean anything: the
   * provider's `completion_tokens` INCLUDES reasoning tokens, so dividing them
   * by an answer-only duration would report a rate the model never achieved.
   * Absent when no first token was observed — a turn that produced nothing has
   * no rate, and absence renders as absence.
   */
  generationMs?: number;
  /**
   * NOT HERE, DELIBERATELY: a running token count of this turn's own.
   *
   * A `liveTokens` field, a `noteLiveTokens` writer and two extra members on
   * `observedFor`'s answer used to sit here, described as "the plumbing is
   * built and the source is left open". Nothing wrote them and nothing read
   * them — neither end was ever connected — and the sentence claiming that
   * every `usage` frame landed here was simply not true: `run-stream.ts`'s
   * frame handler has no `usage` branch and never had one.
   *
   * It is not rebuilt, for the reason the measurements directly above give:
   * `usage` arrives ONCE, in the last chunk, in all four configured families
   * (57/57, 8/8, 56/56, 152/152), so there is no mid-stream count to carry.
   * The end-of-turn count already reaches the footer once, by the committed
   * path (`client.ts` writes `tokenMetrics`; `turnLatency` divides it by the
   * window measured here). A second path to the same number is how one row
   * ends up with two figures for one thing, disagreeing — which this module
   * spends its longest comment refusing.
   *
   * If a provider ever does count DURING the turn, the window measured here
   * is still the right half to own, and the count belongs on the beat with
   * the rest of the record — not in a private map beside it.
   */
}>;

/**
 * Keyed by the transcript message id the frames were streaming into.
 *
 * BOUNDED, because a long session is unbounded: the oldest entries are dropped
 * once the map passes the cap. Dropping is safe — `flow/ingest.ts` copies each
 * measurement onto the beat the first time it sees it and never lets it go
 * (`carryTurnTiming`), so the beat, not this map, is where a measurement
 * lives once it has been taken.
 */
const TIMING_LIMIT = 200;
const timings = new Map<string, TurnTiming>();

/**
 * TWO SIGNALS, AT TWO GRANULARITIES, AND THE SPLIT IS LOAD-BEARING.
 *
 * `turnTimingVersion` fires on the COARSE facts — the first token landed, the
 * answer began. There are at most two of those per turn, and `flow/ingest.ts`
 * listens to it and re-stamps the beat, which costs a log version bump and a
 * re-derivation of the flow's whole visible window.
 *
 * `arrivalVersion` fires PER RECEIVED FRAME — hundreds of times while a large
 * tool call's arguments stream. Nothing structural may listen to it: only the
 * rail hosts do — `flow/TurnBeat.svelte` while the turn still renders, and
 * `flow/ToolBeat.svelte` when that turn is hidden (a silent model turn, the
 * tool still running). That is the same split `streamingTail` already uses
 * (§3.8 — the log array is never rewritten per token). Wiring the arrival
 * signal into the ingest instead would rebuild a beat per token and re-derive
 * the window with it, which is the known Svelte 5 large-proxy trap reached by
 * a different road. The live tool beat subscribes ONLY while its parent is
 * hidden, so argument streaming does not re-render the card per frame.
 */
export const turnTimingVersion = atom<number>(0);
export const arrivalVersion = atom<number>(0);

function publish(): void {
  turnTimingVersion.set(turnTimingVersion.get() + 1);
}

function publishArrival(): void {
  arrivalVersion.set(arrivalVersion.get() + 1);
}

function trim(): void {
  while (timings.size > TIMING_LIMIT) {
    const oldest = timings.keys().next();
    if (oldest.done === true) return;
    timings.delete(oldest.value);
  }
}

/**
 * A model turn began: the `start` frame for `messageId` arrived at `at`.
 *
 * Re-arming an id that already has a start is refused — a turn's clock has one
 * zero, and a second `start` naming the same message would be an out-of-order
 * frame, not a new turn.
 */
export function noteTurnStart(messageId: string, at: number): void {
  if (timings.has(messageId)) return;
  timings.set(messageId, {
    startedAt: at,
    answerStarted: false,
    observedChars: 0,
    lastChannel: null,
  });
  trim();
  publish();
}

/**
 * A token landed for `messageId`. `kind` is which wire frame carried it —
 * `"thinking"` for a `reasoning_delta`, `"answer"` for a `text_delta`.
 *
 * The first call of EITHER kind stops the first-output clock. Only an
 * `"answer"` sets `answerStarted`, and once set it never clears: a turn whose
 * answer has begun has begun, and later interleaved thinking does not un-begin
 * it.
 */
export function noteOutputDelta(
  messageId: string,
  kind: "thinking" | "answer",
  at: number,
  chars = 0,
): void {
  const prev = timings.get(messageId);
  if (prev?.finishedAt !== undefined) return;
  // A delta for a turn whose start we never saw has no clock to stop. The
  // answer-start fact is still worth keeping — it is what the fold reads —
  // so the entry is created without a first-output measurement rather than
  // inventing a zero for it.
  const base: TurnTiming = prev ?? {
    answerStarted: false,
    observedChars: 0,
    lastChannel: null,
  };
  // A NEGATIVE SPAN IS NOT A ZERO SPAN. `Math.max(0, …)` here would turn a
  // backwards clock jump (an NTP correction mid-turn) into a reported "0ms to
  // first token" — a measurement nobody took, printed as one. An elapsed time
  // that does not make sense is recorded as ABSENT instead (§1.1).
  const elapsed = prev?.startedAt !== undefined ? at - prev.startedAt : undefined;
  const firstOutput =
    prev !== undefined && prev.firstOutputMs !== undefined
      ? prev.firstOutputMs
      : elapsed !== undefined && elapsed >= 0
        ? elapsed
        : undefined;
  const next: TurnTiming = {
    ...(base.startedAt !== undefined ? { startedAt: base.startedAt } : {}),
    ...(firstOutput !== undefined ? { firstOutputMs: firstOutput } : {}),
    answerStarted: base.answerStarted || kind === "answer",
    observedChars: base.observedChars + chars,
    lastChannel: kind,
  };
  timings.set(messageId, next);
  trim();
  // The coarse facts, only when one of them actually changed — this is what
  // rebuilds a beat, and it must not happen per token.
  if (
    prev === undefined ||
    prev.firstOutputMs !== next.firstOutputMs ||
    prev.answerStarted !== next.answerStarted
  ) {
    publish();
  }
  publishArrival();
}

/**
 * A TOOL CALL'S ARGUMENTS ARRIVING — the frames `src/client.ts` throws away.
 *
 * These characters never reach the transcript and never become anything the
 * reader will read, so they are counted here and NOWHERE else. They move the
 * rail (they are real arrivals) and they are labelled as what they are (the
 * rail names its channel), so nobody is shown a character count that reads as
 * "the answer so far" while it is in fact a JSON argument blob.
 *
 * They deliberately do NOT stop the first-token clock and do NOT set
 * `answerStarted`: a tool call is not the model beginning to answer, and ttft
 * is about the first token the model produced — which by then has already
 * happened, since a tool call cannot precede the turn's own output.
 */
export function noteToolInputDelta(messageId: string, chars: number, _at: number): void {
  const prev = timings.get(messageId);
  if (prev?.finishedAt !== undefined) return;
  const base: TurnTiming = prev ?? {
    answerStarted: false,
    observedChars: 0,
    lastChannel: null,
  };
  timings.set(messageId, {
    ...base,
    observedChars: base.observedChars + chars,
    lastChannel: "tool-input",
  });
  trim();
  publishArrival();
}

/**
 * Characters observed on this turn's wire, and what arrived last.
 *
 * Zero and null for a turn this session did not watch — a conversation re-read
 * from the database has no arrival record, because arrivals are frames and
 * frames are not persisted.
 */
export function observedFor(messageId: string): Readonly<{
  chars: number;
  channel: ArrivalChannel | null;
}> {
  const t = timings.get(messageId);
  return { chars: t?.observedChars ?? 0, channel: t?.lastChannel ?? null };
}


/**
 * The turn stopped producing — its `finish` (or `error`) frame arrived.
 *
 * Closes the generation window. A turn whose first token was never observed
 * gets no window rather than one measured from a zero it does not have.
 */
export function noteTurnEnd(messageId: string, at: number): void {
  const prev = timings.get(messageId);
  if (prev === undefined || prev.finishedAt !== undefined) return;
  // Same rule as the first-token clock: a span that does not make sense is no
  // span, not a zero one — and a zero here would print an infinite tok/s.
  const ms = prev.startedAt !== undefined && prev.firstOutputMs !== undefined ? at - (prev.startedAt + prev.firstOutputMs) : undefined;
  timings.set(messageId, { ...prev, finishedAt: at, ...(ms !== undefined && ms >= 0 ? { generationMs: ms } : {}) });
  publish();
}

/** What was observed for one message, or undefined — never a substitute. */
export function turnTimingFor(messageId: string): TurnTiming | undefined {
  return timings.get(messageId);
}

// ── WHAT THE FOOTER IS ALLOWED TO CALL "ttft" ──────────────────────────────

/**
 * THE ONE LATENCY A TURN REPORTS, and which recorded number may wear the name.
 *
 * PROVENANCE, CORRECTED. An earlier version of this header listed three
 * "verbatim user rulings" about renaming, deduping and always using ttft. The
 * user said NONE of them. What the user actually said, in full, was:
 *
 *   "for thinking models, ttft is from the time it starts thinking"
 *
 * Everything below is a design decision derived from that one sentence, and it
 * is recorded as a decision so a later reader does not mistake it for an
 * instruction. Inventing a decision's provenance is the same defect as
 * inventing a measurement — worse here, because a comment outlives the session
 * and the next reader treats it as settled.
 *
 * The decision: ONE number, called ttft, and no second latency beside it. That
 * settles the display. What it does NOT settle — and what this function exists to
 * settle — is which recorded value is entitled to be called ttft, because two
 * different quantities are in play and only one of them is that:
 *
 *   - A turn that recorded NO THINKING has only one kind of token, so its
 *     first ANSWER word IS its first token of any kind. The long-recorded
 *     `firstWordMs` therefore IS its ttft — exactly, not approximately. Every
 *     non-thinking turn in the database, including every one recorded before
 *     today, reads correctly under the new name. This is also the dedup: one
 *     measurement, one label, never printed twice.
 *
 *   - A turn that DID think has an answer-word latency that is NOT its ttft.
 *     Its ttft is the live measurement (`firstOutputMs`) or it is ABSENT.
 *
 * THE ABSENCE IS THE DELIBERATE PART. A thinking turn re-read from the
 * database shows no ttft, because nobody measured one: `firstOutputMs` is a
 * live measurement of received frames and the server persists no equivalent.
 * That is an honest absence (§1.1), and it is the whole reason this is a
 * function rather than a rename. The alternative — printing a 136-second
 * answer-word latency under a name that claims the reader waited that long for
 * the first sign of life — is the exact lie the rename was asked for to
 * remove, moved one field to the left.
 *
 * NOTHING RECORDED WAS REDEFINED to achieve this. `timingMetrics.ttftMs`, in
 * the database and in the server's writer, still means what it has always
 * meant; this reads it and decides whether that meaning matches the label,
 * per turn, from the turn's own record. So a latency comparison across today
 * cannot be misled: there is no boundary to be misled across.
 */
export type TurnLatency = Readonly<{
  /** Time to the first token of ANY kind, when the record can support it. */
  ttftMs?: number;
  /**
   * Tokens per second over the producing window, when both terms are measured.
   *
   * The live window (`generationMs` × the turn's own token count) wins when
   * it exists. On a re-read that window is gone — it is frames, not a
   * persisted field — so the recorded `tokPerSec` the finish/usage writers
   * stamped is what stays in the footer. That stamp uses the same window
   * (first token of any kind to finish), thinking included.
   */
  tokPerSec?: number;
}>;

/** A rate is reported to one decimal, like every other measured rate here. */
const RATE_PRECISION = 10;

/**
 * What the latency derivation actually reads. `TurnBody` is the flow beat's
 * shape; the run pane's per-turn projection carries the same six fields and
 * is a legal caller. Widening here is what lets the pane ask the ONE owner
 * of "which recorded number may wear the ttft name" without restating its
 * arithmetic — the same door `toolCallDurationMs` opens for durations.
 */
export type TurnLatencySource = Pick<
  TurnBody,
  "reasoning" | "firstOutputMs" | "firstWordMs" | "generationMs" | "outputTokens" | "tokPerSec"
>;

export function turnLatency(turn: TurnLatencySource): TurnLatency {
  const thought = (turn.reasoning ?? "").length > 0;
  const ttft = turn.firstOutputMs ?? (thought ? undefined : turn.firstWordMs);

  let rate: number | undefined;
  if (turn.generationMs !== undefined && turn.generationMs > 0 && turn.outputTokens !== undefined) {
    rate =
      Math.round(
        (turn.outputTokens / (turn.generationMs / MS_PER_SECOND)) * RATE_PRECISION,
      ) / RATE_PRECISION;
  } else if (turn.tokPerSec !== undefined) {
    // The live window is gone on a re-read (generationMs is frames, not a
    // persisted field). The recorded rate is what the finish/usage writers
    // stamped onto the message — the same number this footer showed live —
    // so a refresh must keep it, thinking turns included. generationMs still
    // wins when present: it is the window measured from the first token of
    // any kind, and that is the rate the live footer already printed.
    rate = turn.tokPerSec;
  }

  return {
    ...(ttft !== undefined ? { ttftMs: ttft } : {}),
    ...(rate !== undefined ? { tokPerSec: rate } : {}),
  };
}

/** Forget everything (a chat switch, a test). */
export function resetTurnTimings(): void {
  if (timings.size === 0) return;
  timings.clear();
  publish();
  publishArrival();
}

registerReset("flow-turn-timing", resetTurnTimings);
