<script lang="ts">
  /**
   * THE RAIL — one instrument for the whole of "waiting for the model",
   * from the moment you press send to the last character that arrives.
   *
   * WHAT IT IS. A fixed rail of hairline ticks with one lit head that
   * ADVANCES EXACTLY ONE CELL PER OBSERVED EVENT, plus a readout of what
   * that event was. It is a readout, not decoration: every pixel of
   * movement is caused by something that actually happened.
   *
   * WHY NOT A SPINNER OR A THREE-DOT ELLIPSIS. Those animate on a timer, so
   * they say "something is happening" whether or not anything is. They keep
   * spinning through a stall, a dead socket, and a model that has gone quiet
   * — which is the exact moment a reader needs the truth. This rail FREEZES
   * when nothing arrives, so a stall is visible as a stall, and it reports a
   * real characters-per-second figure while text flows. That is diagnostic
   * information a spinner actively hides.
   *
   * ── WHAT IT MEASURES CHANGES; THE INSTRUMENT DOES NOT ─────────────────────
   *
   * THE USER'S REPORT, VERBATIM: "I don't like the first animation we are
   * getting when submitting the message, the waiting thing, I do like a lot
   * the one we use for streaming tho, maybe we can use something similar but
   * appropriate?"
   *
   * The offender was this component's own pre-first-token state: fourteen
   * dead cells and the words "waiting for the first characters". The rail was
   * not lying — nothing HAD arrived — but a reader cannot tell a system that
   * is working from one that has fallen over, which is a spinner's failure
   * reached from the opposite direction.
   *
   * The fix is not a second widget. Before the first character there ARE
   * things to measure — four of them, each a real observation on the send
   * path (wait-stage.ts states them and why there is no fifth) — so the rail
   * measures those instead, and the head's position is one arithmetic:
   *
   *     total = milestones observed + character arrivals observed
   *     head  = total === 0 ? none : (total - 1) mod cells
   *
   * At the first token the count simply keeps going: cell 3 (the model has
   * begun) → cell 4 (the first characters landed). Nothing swaps, nothing
   * restarts, and the handoff needs no animation because there is no seam.
   * Because both terms are facts about the RUN rather than about this
   * component instance, two mounts of this rail during one run agree on the
   * cell — which is what lets the instrument move from the flow's tail into
   * the model turn's footer the moment that turn exists, without jumping.
   *
   * THE MOTION LAW (§ the sweep's paint-path honesty rule, applied here).
   * There is no `animation`, no keyframes, no private interval, no timeout,
   * no rAF loop in this component. After the first character, the ONLY
   * things that move the head are a milestone being observed and the tail
   * growing — a stall freezes, which is the diagnostic. Before the first
   * character the observation IS that time passed (Nielsen 2026: never let
   * the bar stall). The shared elapsed clock ticks; the head walks one cell
   * per whole elapsed second; the numeral prints the tenth. At the first
   * character those clock-cells LATCH, so the head does not jump backward.
   *
   * REDUCED MOTION. The head still advances (that is DATA — suppressing it
   * would hide the run's real state), but its travel transition is removed,
   * so it steps instead of sliding. State changes survive; only the tweening
   * goes. The global --t-* collapse already handles the timing; the explicit
   * block below removes the transition outright.
   *
   * LAYOUT STABILITY. Every part is fixed-size: the rail is a fixed count of
   * fixed-width cells, and the readout sits in a reserved box (--stream-say-w)
   * wide enough for the longest sentence it can hold, so neither a stage
   * change nor the arrival of a rate figure resizes anything. Nothing here
   * changes size as the run proceeds, so the virtualizer never re-measures
   * because of the indicator. (The BUBBLE grows as prose arrives — that is
   * the message itself, and it is measured normally.)
   */
  import { untrack } from "svelte";
  import { STREAM_RAIL_CELLS } from "../render/render-config.ts";
  import { MS_PER_SECOND } from "../../../shared/constants.ts";
  import { fmtElapsedSeconds, startElapsedTick } from "./elapsed-clock.ts";
  import { WAIT_SAY, waitSteps, type WaitStage } from "./wait-stage.ts";
  import type { ArrivalChannel } from "./turn-timing.ts";

  let {
    chars,
    stage = "idle",
    channel = null,
    startedAt = null,
  }: {
    /**
     * CHARACTERS OBSERVED SO FAR on this turn's wire. Its GROWTH is the
     * arrival record.
     *
     * It used to be the in-flight answer TEXT, and taking its length was the
     * whole of what this component did with it — which quietly made "an
     * arrival" mean "an arrival of answer text". A model turn streams three
     * things (thinking, the reply, and a tool call's arguments), so two thirds
     * of its arrivals were invisible here and the rail froze through them. A
     * count rather than a string is the honest shape: the caller decides what
     * counts as received, and every channel can.
     */
    chars: number;
    /** The furthest send-path milestone observed for this run (wait-stage.ts). */
    stage?: WaitStage;
    /**
     * WHAT IS ARRIVING right now, so the count cannot be misread. During a
     * tool call these characters are the call's arguments — not one word the
     * reader will ever see — and an unlabelled number would have them watching
     * a count that corresponds to nothing on screen.
     */
    channel?: ArrivalChannel | null;
    /**
     * WHEN THE SEND HAPPENED — the same timestamp WaitLine measures from.
     * Present only while this rail is the wait instrument (the turn is
     * streaming, no characters yet). Null otherwise: a finished turn has
     * no outstanding send, and a clock with no origin is a number nobody
     * took.
     */
    startedAt?: number | null;
  } = $props();

  /** Cells lit behind the head — a short comet tail, not a loop. */
  const TRAIL = 2;

  // Non-reactive bookkeeping: written inside the effect, never read as a
  // reactive dependency (which would make the effect re-trigger itself).
  let lastLen = 0;

  /** Character arrivals observed. One per observed growth of the count. */
  let steps = $state(0);
  /** Characters received so far in this stream (measured, not estimated). */
  let received = $state(0);
  /** TRUE until the first character of this stream. The wait-clock walks
   *  the head only in that window; after it, arrivals own the motion. */
  let waiting = $state(true);
  /** Whole-second elapsed latched at the first character, so the head
   *  does not jump backward when the clock hands off to arrivals. */
  let latchedClockCells = $state(0);
  let nowMs = $state(Date.now());

  $effect(() => {
    if (!waiting || startedAt === null) return;
    return startElapsedTick((n) => {
      nowMs = n;
    });
  });

  const liveClockCells = $derived(
    startedAt === null ? 0 : Math.floor(Math.max(0, nowMs - startedAt) / MS_PER_SECOND),
  );
  const clockCells = $derived(waiting ? liveClockCells : latchedClockCells);
  const elapsedSay = $derived(
    waiting && startedAt !== null ? fmtElapsedSeconds(nowMs - startedAt) : null,
  );

  /**
   * ── THE RATE MOVED TO THE FOOTER; THIS RAIL KEEPS THE MOTION ────────────
   *
   * A DESIGN DECISION — NOT user rulings. An earlier version of this comment
   * attributed five verbatim quotes to the user ("no need c/s", "replace c/s by
   * tok/s", and others). The user said none of them; they were removed. On this
   * subject the user said exactly one thing: "for thinking models, ttft is from
   * the time it starts thinking".
   *
   * The decision, on its own merits: ONE rate slot, because two components
   * printing a rate is how the footer came to disagree with itself. It shows
   * characters/second while streaming and tokens/second once a token count
   * exists, and it never converts one into the other — a token is not a unit
   * the wire carries (measured: 46 deltas against 157 completion tokens, so a
   * delta is not a token either).
   *
   * So there is now exactly ONE rate in the turn's footer, at its left, after
   * ttft, and `flow/TurnBeat.svelte` owns it. What this component still owns is
   * the MOTION: the cells advancing once per observed arrival, the count, and
   * the channel word. Two components printing a rate was how the footer came
   * to hold both `470 c/s` and `176.4 tok/s` at once.
   */

  $effect(() => {
    const len = chars;
    // A shorter count means a new stream began (the atom was reset).
    if (len < lastLen) {
      lastLen = 0;
      steps = 0;
      received = 0;
      waiting = true;
      latchedClockCells = 0;
    }
    if (len === lastLen) return;
    if (waiting && len > 0) {
      latchedClockCells = untrack(() => liveClockCells);
      waiting = false;
    }
    lastLen = len;
    // The previous count is read UNTRACKED: `steps += 1` would read `steps`
    // as a dependency of the very effect that writes it — a self-dependency
    // that runs the effect twice per arrival (and is the shape Svelte's
    // effect_update_depth_exceeded guard exists for).
    steps = untrack(() => steps) + 1;
    received = len;
  });

  /**
   * ONE COUNT FOR THE WHOLE WAIT. Milestones, then elapsed whole seconds
   * while still waiting, then character arrivals — the order they happen
   * in — so the head never moves backwards and the handoff at the first
   * token is a single increment like every other.
   */
  const observed = $derived(waitSteps(stage) + clockCells + steps);

  /** The lit cell, or -1 when nothing has been observed at all. */
  const head = $derived(observed === 0 ? -1 : (observed - 1) % STREAM_RAIL_CELLS);

  /**
   * WHAT THE READOUT SAYS, in the order the run answers it:
   *   - characters are flowing → the measured rate and the real count;
   *   - the first characters have landed but no span exists yet → the count
   *     alone (a rate needs two arrivals; inventing one is fabrication);
   *   - nothing has arrived yet → the furthest milestone, in plain words.
   *
   * The old text said "waiting for the first characters" in the second case
   * too, which was untrue the moment a character had landed.
   */
  const say = $derived(received === 0 ? WAIT_SAY[stage] : null);

  /**
   * THE CHANNEL, IN PLAIN WORDS (§1.1 zero-knowledge language). No
   * "reasoning_delta", no "tool_call_delta", no "arguments" — the reader is
   * told which of the three things a model turn streams they are watching.
   * Absent when the stream has not said, and absence renders as absence.
   */
  const CHANNEL_SAY: Readonly<Record<ArrivalChannel, string>> = {
    thinking: "thinking",
    answer: "the reply",
    "tool-input": "a tool call's input",
  };
  const channelSay = $derived(channel === null ? null : CHANNEL_SAY[channel]);

  /** Distance behind the head, wrapped — decides a cell's brightness. */
  function lag(i: number): number {
    if (head < 0) return STREAM_RAIL_CELLS;
    return (head - i + STREAM_RAIL_CELLS) % STREAM_RAIL_CELLS;
  }

  function fmt(n: number): string {
    return Math.round(n).toLocaleString("en-US");
  }
</script>

<span class="rail-group" aria-live="off">
  <span
    class="rail"
    role="img"
    aria-label={say !== null
      ? (elapsedSay !== null ? `${say} · ${elapsedSay}` : say)
      : `received ${fmt(received)} characters of ${channelSay ?? "the model's output"} so far`}
  >
    {#each { length: STREAM_RAIL_CELLS } as _, i (i)}
      <span
        class="cell"
        class:head={lag(i) === 0}
        class:trail={lag(i) > 0 && lag(i) <= TRAIL}
      ></span>
    {/each}
  </span>

  <!-- The readout's box is FIXED (--stream-say-w): a stage change and the
       arrival of a rate figure must not resize the footer they sit in. -->
  <span class="readout">
    {#if say !== null}
      <span class="waiting">{say}</span>
    {:else}
      <span class="count" data-field="chars">{fmt(received)} chars</span>
    {/if}
  </span>

  <!-- WHAT those characters are. Its own reserved box, so the word changing
       several times inside one turn (thinking → the reply → a tool call's
       input → the reply) never resizes the footer it sits in. -->
  <!-- While waiting, this reserved box holds elapsed (the channel word is
       empty until characters land). After the first character it holds the
       channel, and elapsed leaves with the wait. One box, never two facts. -->
  <span class="channel" data-field={elapsedSay !== null ? "wait-elapsed" : "channel"}>
    {elapsedSay ?? channelSay ?? ""}
  </span>
</span>

<style>
  .rail-group {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .rail {
    display: inline-flex;
    align-items: flex-end;
    gap: var(--stream-cell-gap);
    /* Fixed box: the rail never resizes as tokens land. */
    height: var(--stream-rail-h);
  }
  .cell {
    width: var(--stream-cell-w);
    height: var(--stream-cell-h);
    background: var(--ink-4);
    /* Only brightness/height travel — never the box. */
    transition:
      background var(--t-1) var(--ease-out),
      height var(--t-1) var(--ease-out);
  }
  /* THE one beam cell — the live hue's rarity is its meaning (§12.2). */
  .cell.head {
    background: var(--beam);
    height: var(--stream-rail-h);
  }
  .cell.trail {
    background: var(--ink-2);
  }
  /* THE RESERVED READOUT. One box, one width, whatever it currently holds —
   * so "your message is in", "listening for the answer" and "412 c/s 1,204
   * chars" all occupy the same pixels and the bubble around them never moves. */
  .readout {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    width: var(--stream-say-w);
    overflow: hidden;
  }
  .count {
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  /* RESERVED, like every other part of this footer: the channel word changes
   * within a turn and must not resize the row (the virtualizer would then
   * re-measure the beat because of its own activity indicator). */
  .channel {
    width: var(--stream-channel-w);
    overflow: hidden;
    white-space: nowrap;
    color: var(--ink-4);
  }
  .waiting {
    color: var(--ink-3);
    white-space: nowrap;
  }
  /* The head still ADVANCES under reduced motion — that is the run's real
   * state, not decoration — it simply steps instead of travelling. State
   * changes are data and survive; only the tweening is removed. */
  @media (prefers-reduced-motion: reduce) {
    .cell {
      transition: none;
    }
  }
</style>
