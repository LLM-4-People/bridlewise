<script lang="ts">
  /**
   * THE WAIT ROW — the one element between pressing send and the first
   * character, and the only thing on screen reporting that window.
   *
   * ── WHAT WAS HERE BEFORE, AND WHY IT WENT ────────────────────────────────
   *
   * THE USER'S REPORT, VERBATIM: "when waiting for generation, i see your
   * message is in for a brief moment beside the frozen animation, then it
   * starts generating with the animation moving. wondering if there is a
   * cleaner way to let the user know its being sent" — narrowed by them to
   * "when sending a message i mean".
   *
   * This row used to mount the token rail (StreamPulse). The rail is an
   * ARRIVAL instrument: one cell per observed arrival, frozen when nothing
   * arrives. That is exactly right while text is flowing and exactly wrong
   * here, because before the first token there are no arrivals to count — so
   * it rendered as a rail stuck at cell 0, and **a frozen instrument is
   * visually indistinguishable from a broken one**. Which is the same
   * "cannot tell working from fallen-over" failure the rail was built to
   * remove, reached from the other side.
   *
   * Beside it sat the sentence "your message is in", which was doing the real
   * communicating — and which was itself redundant, because
   * `sendUserMessage()` appends the reader's own beat SYNCHRONOUSLY, so their
   * words are already on screen in the same frame. Two elements, one job, and
   * the more prominent one saying nothing. Both are gone: the milestone
   * (wait-stage.ts records why) and the rail-before-its-first-arrival.
   *
   * ── WHAT REPLACES THEM ───────────────────────────────────────────────────
   *
   * One row, and every part of it is something the reader CANNOT already see:
   *
   *   - WHERE THE RUN IS, in plain words — the furthest milestone actually
   *     observed on the send path;
   *   - HOW FAR THROUGH the known sequence that is, so stillness has a
   *     position. Stillness with a position is informative; stillness alone
   *     is not;
   *   - HOW LONG it has taken, ticking.
   *
   * THE CLOCK IS THE MOTION, and it is honest motion. A spinner claims
   * activity that may not exist. A clock claims that time passed, which is
   * true and measured from a real timestamp (`waitStartedAt`, taken at the
   * send). It is also DIAGNOSTIC, which is the whole point: "the run was
   * accepted · 0.4s" reads as normal and "the run was accepted · 14s" tells
   * the reader — and us — exactly which hop is slow. That is the same value
   * the rail's rate figure gives during streaming, extended to the phase
   * before it.
   *
   * ── THE HANDOFF ──────────────────────────────────────────────────────────
   *
   * At the first arrival the model's turn gets a beat of its own, and the
   * rail lives in that beat's footer where it has something to measure. This
   * row disappears in the same update. One sense of progress at a time, never
   * two widgets swapping.
   *
   * ── WHY THE CONNECTION IS NOT REPEATED HERE ──────────────────────────────
   *
   * A refusal mid-wait is not this row's news to break. The connection is one
   * global fact with one owner, and an unreachable API blanks and blocks the
   * ENTIRE cockpit (shell/ConnectionBlock.svelte, at the user's instruction)
   * — which is the wait row converting to the offline statement, at the scale
   * the user asked for. Restating it here as well would be two elements
   * asserting one fact, which is the defect this row was just rewritten to
   * stop committing.
   *
   * FIXED height (--beat-ghost-h, one line — a ghost row's budget), outside
   * the virtualized spacer, so it can neither shift the beats above it nor be
   * measured by the height index.
   */
  import Answer from "../response/Answer.svelte";
  import { failed, refused } from "../response/grammar.ts";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";
  import { fmtElapsedSeconds, startElapsedTick } from "./elapsed-clock.ts";
  import {
    WAIT_MILESTONE_COUNT,
    WAIT_ROW_IDLE_SAY,
    WAIT_SAY,
    waitSteps,
    type WaitEnd,
    type WaitStage,
  } from "./wait-stage.ts";

  let {
    stage,
    startedAt,
    end = null,
  }: {
    stage: WaitStage;
    startedAt: number | null;
    /** The send settled with no run to wait for (wait-stage.ts `waitEnd`):
     *  the row stops being a wait and states the outcome in the response
     *  grammar — refused with the server's own sentence, or failed. */
    end?: WaitEnd | null;
  } = $props();

  /** Milestones observed. Zero at `idle` — nothing has been reported yet, and
   *  nothing is claimed. */
  const reached = $derived(waitSteps(stage));

  /** Before the first milestone this row's absence is about the SEND, not
   *  about characters — see `WAIT_ROW_IDLE_SAY`. */
  const sentence = $derived(stage === "idle" ? WAIT_ROW_IDLE_SAY : WAIT_SAY[stage]);

  let nowMs = $state(Date.now());
  $effect(() => {
    if (startedAt === null) return;
    return startElapsedTick((n) => {
      nowMs = n;
    });
  });

  /** Elapsed since the send, one decimal. Measured, never estimated: `null`
   *  when there is no start timestamp, because a duration with no origin is
   *  a number nobody took. */
  const elapsed = $derived(startedAt === null ? null : fmtElapsedSeconds(nowMs - startedAt));

  /**
   * A spark only when the send-path milestone ADVANCES. The clock tick is
   * not news (it is the same row still waiting); a new observed hop is.
   * `becauseChanged` refuses an unchanged pair.
   */
  let lastStage: WaitStage | null = null;
  const stageMotion = $derived.by((): MovesParam => {
    const next = stage;
    const previous = lastStage;
    lastStage = next;
    if (previous === null || previous === next) return null;
    return {
      motion: "arrive",
      cause: becauseChanged("the send-path milestone", previous, next),
    };
  });
</script>

<div class="wait-line" data-field="wait-line" data-wait-stage={end !== null ? end.kind : stage} use:moves={stageMotion}>
  <span class="gutter-mark" aria-hidden="true">‹</span>
  {#if end !== null}
    <!-- THE WAIT ENDED WITHOUT A RUN. No clock (no send is outstanding), no
         milestones (none were observed): the outcome stands in the response
         grammar's own vocabulary — refused quotes the server's sentence,
         failed states what broke. -->
    <p class="say" data-field="wait-say" aria-live="polite">
      <Answer answer={end.kind === "refused" ? refused(end.reason) : failed(end.reason)} as="inline" />
    </p>
  {:else}
    <p class="say" data-field="wait-say" aria-live="polite">
      <span class="stage">{sentence}</span>
      {#if reached > 0}
        <!-- Only once a milestone has genuinely been observed. At zero this
             would be "0 of 3", which is a progress claim over no progress. -->
        <span class="sep" aria-hidden="true">·</span>
        <span class="steps" data-field="wait-steps">{reached} of {WAIT_MILESTONE_COUNT}</span>
      {/if}
      {#if elapsed !== null}
        <span class="sep" aria-hidden="true">·</span>
        <span class="elapsed" data-field="wait-elapsed">{elapsed}</span>
      {/if}
    </p>
  {/if}
</div>

<style>
  .wait-line {
    /* The beat gutter's width, so the row lines up with the glyph column
     * every row above it uses. */
    display: grid;
    grid-template-columns: var(--gutter-beat) minmax(0, 1fr);
    align-items: center;
    /* FIXED: one line, the ghost row's budget. Nothing here may grow — and
     * `flex: none` so the column above cannot squeeze it either, which would
     * be a size change caused by content the row has nothing to do with. */
    flex: none;
    height: var(--beat-ghost-h);
    padding: 0 var(--gutter-bleed) 0 0;
  }
  .gutter-mark {
    justify-self: center;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-4);
    line-height: var(--lh-tight);
  }
  .say {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    min-width: 0;
    color: var(--ink-1);
    font-size: var(--f-data-size);
    white-space: nowrap;
    overflow: hidden;
  }
  .sep {
    color: var(--ink-4);
    font-style: normal;
  }
  .steps {
    color: var(--ink-4);
    font-style: normal;
    font-variant-numeric: tabular-nums;
  }
  /* Reserved and tabular: the tenths digit changes five times a second and
   * must not shift the sentence to its left as it does. */
  .elapsed {
    min-width: 5ch;
    color: var(--ink-3);
    font-style: normal;
    font-variant-numeric: tabular-nums;
  }
</style>
