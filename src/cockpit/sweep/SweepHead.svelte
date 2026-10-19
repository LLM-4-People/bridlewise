<script lang="ts">
  /**
   * THE HEAD (§6.2) — the band's readout, and the answer to "what am I
   * looking at?"
   *
   * It renders in the strip of RESERVED AIRSPACE the shell keeps empty above
   * the band (`--sweep-ruler-rise`, spent in Cockpit.svelte). Two readouts
   * live there:
   *
   *   THE HEAD LINE   the RÉSUMÉ of the window on screen: the instant the
   *                   playhead sits on (when one is planted), the stretch of
   *                   time the band is showing, how much of the record that
   *                   is, how many events are in it and how many of those
   *                   went wrong. Its words come from ONE owner
   *                   (band-scope.ts `bandViewLine`) — this file lays them
   *                   out and never composes a sentence of its own.
   *   THE RULER       a chip tracking the pointer with the full-precision
   *                   instant under it. It rides its own row above the line
   *                   so the two can never be drawn through one another.
   *
   * WHAT THE LINE DOES NOT SAY, AND WHY. Under a shell it does not say "past
   * view" and it does not carry the way back. The shell's own past-view band
   * already states the condition, the reason acting is refused, and the
   * return — across the full width, in warn ink. Saying it again down here is
   * the duplication the user reported. STANDING ALONE (the dev harness, the
   * component tests) there is nothing above the band, so the band says it
   * itself: `standalone` is the switch, and band-scope.ts owns which clauses
   * that produces.
   *
   * IT IS ALSO NOT A READING-POSITION READOUT. It describes the BAND's
   * window, which scrolling the conversation does not move — a reader who
   * scrolls up is not time-travelling, and a header that changed under them
   * would be claiming they were.
   *
   * WHAT SURVIVES THE FOLD. Below the §2.7 breakpoint the window's start and
   * end step out through `--sweep-headline-detail` — a token, like every
   * other cockpit breakpoint decision — rather than being clipped mid-word.
   * The span and the counts stay, because they are the résumé.
   *
   * Pure presentation over props: the Sweep owns hit-testing and state.
   */
  import { bandDataState, bandViewLine } from "./band-scope";
  import { formatFullPrecision } from "./now-edge";
  import { xAtTime } from "./zoom";
  import type { SweepWindow } from "./types";

  let {
    view,
    widthPx,
    hoverMs = null,
    headMs = null,
    contents = null,
    measuredEmpty = false,
    standalone = false,
    onReturnLive,
  }: {
    /** Null before anything is on the band. The strip still renders — it is
     * reserved geometry, and a header that MOUNTS when the data lands is a
     * post-reveal mount (§10.3). Only its words arrive. */
    view: SweepWindow | null;
    widthPx: number;
    hoverMs?: number | null;
    headMs?: number | null;
    /** Measured contents of the window on screen (band-scope owns the words). */
    contents?: Readonly<{ events: number; errors: number }> | null;
    /** True only when the open conversation's own spectrum read landed and
     * honestly reported nothing — the one viewless state the head words
     * (band-scope.ts owns the sentence and the law). */
    measuredEmpty?: boolean;
    /** True when no shell above the band owns the past-view banner. */
    standalone?: boolean;
    /** Wired to the Sweep's return-to-live (Esc / now edge / this button). */
    onReturnLive?: () => void;
  } = $props();

  /**
   * How far from either edge the ruler chip is allowed to sit. It is centred
   * on the pointer, so without this it would hang half off the band at the
   * extremes. Named rather than inline: a threshold with no name is a number
   * nobody can find again (guard: tests/prevention/no-hardcoded-values).
   */
  const RULER_EDGE_INSET_PX = 44;

  const hoverX = $derived(
    hoverMs === null || view === null ? null : xAtTime(view, hoverMs, widthPx),
  );
  const line = $derived(
    bandViewLine({ view, headMs, contents, standalone, measuredEmpty }),
  );
</script>

<!-- THE AIRSPACE — the strip the shell keeps empty above the band. Two ROWS,
     stacked, so the pointer-tracking ruler and the standing head line can
     never be drawn through one another: the ruler rides the upper row and
     moves with the cursor; the line holds the lower row, hard against the
     band it describes. The strip's total height is `--sweep-ruler-rise`, the
     same token the shell spends, so there is one number and both sides read
     it. -->
<div class="airspace" class:unrecorded={measuredEmpty}>
  <div class="ruler-row">
    {#if hoverMs !== null && hoverX !== null && hoverX >= 0 && hoverX <= widthPx}
      <div
        class="ruler"
        style:left={`${Math.min(
          Math.max(hoverX, RULER_EDGE_INSET_PX),
          Math.max(RULER_EDGE_INSET_PX, widthPx - RULER_EDGE_INSET_PX),
        )}px`}
        aria-hidden="true"
      >{formatFullPrecision(hoverMs)}</div>
    {/if}
  </div>

  <!-- The head line. NOT a live region: the shell's own past-view band is
       already `role="status"` and announces the condition change, and two
       live regions saying the same thing on one event is chatter, not
       access. The full sentence is on the title, so a clause that steps out
       at a narrow width is still reachable.

       The ROW always exists; only its words arrive with the data. A header
       that mounted when the spectrum landed would be a post-reveal mount
       (§10.3) — and an empty row here says the honest thing anyway: there is
       nothing on the band to describe yet, which the band's own empty extent
       shows. -->
  <div class="line" data-state={bandDataState(line)} title={line?.label}>
    {#if line !== null}
      {#if line.absenceLabel !== null}
        <!-- THE MEASURED-EMPTY SENTENCE (UIE-048): the conversation's own
             record, read back empty, stated in the flow's own absence voice.
             Every other viewless state stays wordless — band-scope.ts owns
             that law and this clause only exists where it measured. -->
        <span class="count">{line.absenceLabel}</span>
      {:else}
        {#if line.stateLabel !== null}
          <span class="state engraved">{line.stateLabel}</span>
        {/if}
        {#if line.viewingLabel !== null}
          <span class="viewing">{line.viewingLabel}</span>
          {#if standalone}
            <button type="button" class="back" onclick={() => onReturnLive?.()}
              data-action="client-nav:sweep.return-to-live">Back to now</button>
          {/if}
        {/if}
        {#if line.windowLabel !== null}<span class="detail">{line.windowLabel}</span>{/if}
        {#if line.spanLabel !== null}<span class="span">{line.spanLabel}</span>{/if}
        {#if line.eventsLabel !== null}
          <span class="count">{line.eventsLabel}</span>
        {/if}
        {#if line.errorsLabel !== null}
          <span class="count errors">{line.errorsLabel}</span>
        {/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  /* The strip itself. `bottom: 100%` alone would land on the band's own
   * border-top — an absolutely positioned child is placed against the
   * PADDING box and the hairline lives outside it, which is a readout
   * sitting ON a border rather than above it. Clear the hairline explicitly.
   * Nothing here takes layout: activating the band must not move a pixel. */
  .airspace {
    position: absolute;
    bottom: calc(100% + var(--hairline-w));
    left: 0;
    right: 0;
    height: calc(var(--sweep-ruler-rise) - var(--hairline-w));
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    pointer-events: none;
    z-index: 3;
  }
  /* The upper row is the ruler's lane. It holds its height whether or not a
   * ruler is in it, so the line below never shifts when the pointer arrives. */
  .ruler-row {
    position: relative;
    flex: none;
    height: var(--sweep-ruler-row-h);
  }
  .airspace.unrecorded { top: 0; bottom: 0; height: auto; justify-content: center; }
  .unrecorded .ruler-row { display: none; }
  .unrecorded .line { font-family: var(--face-sans); font-size: var(--f-data-size); }
  .line {
    flex: none;
    padding: 0 var(--sp-2);
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    line-height: var(--lh-readout);
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
  }
  /* The state word is the one clause that changes what the controls will do,
   * so it is the one clause that carries ink. `--warn` is the palette's
   * "abnormal but not broken", which is exactly what a past view is — and it
   * is the same ink the shell's own past-view band wears, so the two read as
   * one condition rather than two warnings. */
  /* The engraved register is owned by tokens.css (.cockpit .engraved); the
   * head's state word keeps its own ink and size (the résumé's data face). */
  .state {
    flex: none;
    color: var(--ink-2);
  }
  .line[data-state="past"] .state {
    color: var(--warn);
  }
  .viewing {
    flex: none;
    color: var(--ink-1);
  }
  /* The résumé — how much is in the window, and how much of it went wrong.
   * Both numbers come from the SAME binning of the SAME window, so they can
   * be read as one sentence. Errors take `--alarm` only when there are some:
   * a clean window is a normal state and normal states earn no colour. */
  .count {
    flex: none;
  }
  .count.errors {
    color: var(--alarm);
  }
  .span {
    flex: none;
  }
  /* The detail clause — the window's start and end. It steps out
   * below the §2.7 breakpoint through the token, never by
   * clipping: a sliced timestamp is not an arrangement. */
  .detail {
    display: var(--sweep-headline-detail);
    flex: none;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .back {
    flex: none;
    pointer-events: auto;
    font: inherit;
    color: var(--ink-2);
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    padding: 0 var(--sp-1);
    cursor: pointer;
  }
  .back:hover {
    color: var(--ink-1);
    background: var(--layer-hover);
  }
  .ruler {
    position: absolute;
    bottom: 0;
    transform: translateX(-50%);
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    letter-spacing: var(--f-micro-track);
    color: var(--ink-1);
    background: var(--ground-3);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    padding: 0 var(--sp-1);
    line-height: var(--lh-readout);
    pointer-events: none;
    white-space: nowrap;
  }
</style>
