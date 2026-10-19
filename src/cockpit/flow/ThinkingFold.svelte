<script lang="ts">
  /**
   * THE THINKING BLOCK — open while the model thinks, folded when it answers.
   *
   * THE USER'S RULING, VERBATIM: "when chatting with a thinking model, its
   * thinking block is collapsed, i want its thinking to be expanded from the
   * moment it starts thinking until it starts producing the real answer".
   *
   * `flow/thinking-fold.ts` owns the DECISION (the three states, the auto rule,
   * and the reader's per-beat preference that beats it); this component owns
   * only the drawing of it, so the height index and the render cannot disagree
   * about whether the block is open — they call the same function.
   *
   * ── WHAT MOVES AND WHAT DOES NOT ─────────────────────────────────────────
   *
   * The block's own box is CAPPED (--fold-max-h) and scrolls internally, so a
   * model that thinks for two minutes cannot grow the beat without bound: past
   * the cap the beat's height stops changing entirely and the virtualizer stops
   * re-measuring it. While the thinking is LIVE the inner box follows its own
   * tail, so the reader watches the newest sentence rather than the first one —
   * and that following stops the moment the reader scrolls inside it, because a
   * surface that scrolls away from what you are reading is worse than one that
   * does not scroll at all.
   *
   * ── THIS IS NOT THE FISHEYE, AND IT CLAIMS NO CHORD ──────────────────────
   *
   * Said again here, at the component, because this is where the confusion
   * would be introduced: the open/closed state of THIS SECTION is a different
   * axis from the beat's fisheye LEVEL. The fisheye pins every turn to `full`
   * and draws no compression grip on one (fisheye.ts `compressesInFlow`), so
   * the grip below is the only control on a turn and it controls only this
   * block. It never writes a fisheye override and `← →` never reach it.
   *
   * Which is exactly why it carries NO `data-chord-target`. That attribute
   * means "this control is the mouse path for a key in the grammar"
   * (`cockpit-mouse-path-owner.test.ts` holds the two sides together), and
   * inventing a target for this fold would either mint a chord nobody
   * declared or quietly attach it to `← →` — which is the fisheye's pair, on
   * the other axis, and is the shape of the "one click, one outcome" defects
   * this separation exists to prevent. It is a plain button with a plain
   * click path, which is all the reader needs and all it honestly is.
   *
   * ── REDUCED MOTION ───────────────────────────────────────────────────────
   *
   * The open/closed state is DATA and survives untouched; only the tweening of
   * the disclosure mark is removed. Nothing here animates on a timer.
   */
  import Prose from "../render/Prose.svelte";
  import { TURN_CODE_FOLD_LINES } from "../render/render-config.ts";
  import {
    becauseChanged,
    moves,
    type MovesParam,
  } from "../motion/motion.ts";

  let {
    text,
    open,
    live,
    onToggle,
  }: {
    /** The thinking, exactly as received. Never empty — the caller does not
     *  render this component for a turn that produced no thinking. */
    text: string;
    open: boolean;
    /** TRUE while thinking is arriving and no answer token has been received.
     *  Drives the live label and the inner tail-following, nothing else. */
    live: boolean;
    onToggle: () => void;
  } = $props();

  let body: HTMLDivElement | undefined = $state();
  /** Set when the reader scrolls inside the block: their position wins over
   *  the automatic tail-following, for the rest of this turn. */
  let readerScrolled = $state(false);

  /** How close to the bottom still counts as "at the tail". */
  const TAIL_SLACK_PX = 24;

  function onBodyScroll(): void {
    if (body === undefined) return;
    const atTail =
      body.scrollHeight - body.scrollTop - body.clientHeight <= TAIL_SLACK_PX;
    // Returning to the bottom yourself re-arms the following — the same
    // "follow the tail unless you have moved away from it" rule the flow uses.
    readerScrolled = !atTail;
  }

  /**
   * FOLLOW THE THINKING'S OWN TAIL, and only ever because more of it arrived.
   * `text` is the dependency, so this runs on a real arrival and on nothing
   * else — there is no timer and no rAF loop in this component.
   */
  $effect(() => {
    const grown = text.length;
    if (!open || !live || readerScrolled || body === undefined) return;
    // Read `grown` so the effect depends on the arrival.
    void grown;
    body.scrollTop = body.scrollHeight;
  });

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }

  /**
   * WHAT THE GRIP SAYS. Live: that thinking is happening now, with its
   * measured size. Settled: the same measured size, and the way back in.
   * Nothing here claims the thinking is "complete" — the stream never said so
   * (thinking-fold.ts § the three states).
   */
  const label = $derived(
    live
      ? `thinking · ${fmt(text.length)} chars`
      : open
        ? "hide thinking"
        : `thinking · ${fmt(text.length)} chars`,
  );

  /** Skip the first assignment (live thinking starts open). Re-open arrives.
   * DERIVED, NOT STORED: a `$state` land written by an `$effect` can hand a
   * re-mounted fold a cause the contract already spent — an uncaught
   * MotionContract throw (the Flow crash's twin shape). The derived mints
   * the cause in the render that reads it; re-renders that change nothing
   * re-derive null rather than replay a stored one. */
  let lastOpen: boolean | null = null;
  const land = $derived.by((): MovesParam => {
    const next = open;
    const previous = lastOpen;
    lastOpen = next;
    if (previous === null || previous === next || next === false) {
      return null;
    }
    return {
      motion: "arrive",
      cause: becauseChanged("the thinking block", previous, next),
    };
  });
</script>

<button
  class="verb grip"
  class:live
  type="button"
  data-verb-id="flow.expand"
  data-field="thinking-grip"
  aria-expanded={open}
  onclick={onToggle}
>
  <span class="mark" class:open aria-hidden="true">▸</span>
  <span class="label">{label}</span>
</button>

{#if open}
  <div
    class="thinking"
    data-field="thinking"
    bind:this={body}
    onscroll={onBodyScroll}
    use:moves={land}
  >
    <Prose text={text} codeMaxLines={TURN_CODE_FOLD_LINES} />
  </div>
{/if}

<style>
  /* Chrome is the owned `.verb`. Layout only: sit at the start of the beat. */
  .grip {
    gap: var(--sp-1);
    color: var(--ink-3);
    align-self: flex-start;
  }
  /* THE ONE LIVE HUE, spent on the one thing that is happening now (§12.2).
   * It leaves the label the instant the answer begins, which is also the
   * instant the block folds — one state change, told twice. */
  .grip.live .label { color: var(--beam); }
  .mark {
    display: inline-block;
    transition: transform var(--t-1) var(--ease-out);
  }
  .mark.open { transform: rotate(90deg); }
  /* Thinking is prose too — the same renderer, held in a quieter register
   * (muted ink, a rule down its left edge) so it never competes with the
   * answer it sits above. */
  .thinking {
    border-left: var(--hairline-w) solid var(--line-2);
    padding: var(--sp-1) var(--sp-3);
    color: var(--ink-3);
    /* THE CAP IS LOAD-BEARING, not cosmetic: it bounds how much this beat can
     * grow while the thinking streams, so the height index re-measures a
     * bounded row instead of one that climbs for the length of a long think. */
    max-height: var(--fold-max-h);
    overflow-y: auto;
    min-width: 0;
  }
  .thinking :global(.prose) {
    font-size: var(--f-ui-size);
    color: var(--ink-3);
  }
  /* The state change is data and survives; only the tweening is removed. */
  @media (prefers-reduced-motion: reduce) {
    .mark { transition: none; }
  }
</style>
