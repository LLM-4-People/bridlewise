<script lang="ts">
  /**
   * THE SWITCH — a reel's 24px micro-sweep (§5.2): the conversation's REAL
   * event density from the `sweep.spectrum` block, decoded by the room's
   * own `micro-bins.ts`. This painter is the Switch's own — it shares
   * nothing with the big SWEEP's painter.
   *
   * Honesty: bars are painted ONLY from a measured `MicroDensity` that
   * passes `assertMicroDensityConsistent`. Pending and absent states render
   * as words ("density not loaded yet" / "no events recorded"), the same
   * fixed 24px tall — data arriving later fills the strip in place with
   * zero layout shift. The canvas is never the only access: a measured
   * strip carries an sr-only sentence naming the real event count.
   */
  import { assertMicroDensityConsistent, type MicroDensity } from "./micro-bins.ts";
  import type { DensityState } from "./switch-feed.ts";
  import type { AnswerStateId } from "../response/grammar.ts";
  import { whileRoomVisible } from "../shell/room-visibility.ts";
  import {
    designConditions,
    watchDesignConditions,
    withPaintTokens,
  } from "../paint/design-tokens.ts";

  let {
    density,
    quiet = false,
    provKey = null,
  }: {
    density: DensityState;
    /** Empty conversation: keep the strip's height, drop the fake bar. */
    quiet?: boolean;
    /** The Broker cache key of the read that produced `density`, for the
     * LENS stamp. Null where a mount has no read behind it — an unbacked
     * strip stays unstamped rather than claiming someone else's record. */
    provKey?: string | null;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  /**
   * Tokens are resolved through the paint owner (paint/design-tokens.ts), not
   * by a private `getComputedStyle` here: one door means the reader cannot
   * outlive the frame, and it means this strip is covered by the same signal
   * every other canvas binds to. Stylesheet-less fallbacks live in
   * TOKEN_FALLBACKS at the paint door — used only where no stylesheet
   * resolves (jsdom).
   */
  function paint(el: HTMLCanvasElement, density: MicroDensity): void {
    assertMicroDensityConsistent(density);
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = el.getContext("2d");
    } catch {
      ctx = null; // jsdom — the a11y sentence below is the access
    }
    if (ctx === null) return;
    const dpr = typeof devicePixelRatio === "number" ? Math.max(1, devicePixelRatio) : 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const bins = density.totals.length;
    let max = 0;
    for (const t of density.totals) if (t > max) max = t;
    if (max === 0) return; // consistent-but-empty: nothing to paint is the truth

    const { ink, alarm } = withPaintTokens(el, (read) => ({
      ink: read("--ink-2"),
      alarm: read("--alarm"),
    }));
    const barW = w / bins;
    for (let i = 0; i < bins; i += 1) {
      const total = density.totals[i]!;
      if (total === 0) continue; // gaps render as gaps (§8.3)
      const errors = density.errors[i]!;
      const barH = Math.max(1, (total / max) * h);
      const x = i * barW;
      ctx.fillStyle = ink;
      ctx.fillRect(x, h - barH, Math.max(1, barW - 1), barH);
      if (errors > 0) {
        // The error overlay rides the TOP of its bar (§6.2's ridge, in
        // miniature) — a real subset of the same counted events.
        const errH = Math.max(1, (errors / max) * h);
        ctx.fillStyle = alarm;
        ctx.fillRect(x, h - barH, Math.max(1, barW - 1), errH);
      }
    }
  }

  /** The design conditions are watched for as long as this strip is on
   * screen; the refcount in the owner means one observer serves every canvas. */
  $effect(() => watchDesignConditions());

  /**
   * WHETHER ANYONE CAN SEE THIS STRIP. The Switch is kept alive, so a
   * hidden room held ~100 PAINTED canvases — each a w×h×4-byte bitmap for
   * pixels nobody could see. On hide the bitmap is RELEASED (a zero-sized
   * canvas frees its backing store); the DENSITY stays in memory, so the
   * show repaints in the same frame from what is already known — the
   * keep-alive law exactly: keep the values, not the pixels.
   */
  let onScreen = $state(true);
  $effect(() => {
    return whileRoomVisible("switch", () => {
      onScreen = true;
      return () => {
        onScreen = false;
        const el = canvas;
        if (el !== undefined) {
          el.width = 0;
          el.height = 0;
        }
      };
    });
  });

  $effect(() => {
    const el = canvas;
    // NAMED SIGNAL. Reading tokens inside `paint` keeps the values fresh, but
    // fresh values are worth nothing if nothing re-runs the paint — a theme
    // switch changes no density and no canvas, so without this tap the strip
    // stayed carbon on a paper page while every line of it looked correct.
    void $designConditions;
    if (!onScreen) return;
    if (el === undefined || density.kind !== "measured") return;
    paint(el, density.density);
  });

  /**
   * THE STRIP'S data-state, IN THE GRAMMAR'S WORDS — the same door the
   * reel's outcome line uses. `density.kind` is the feed's DOMAIN kind; a
   * measured strip is content (the canvas) and carries NO state hue, so only
   * the answer states reach the attribute. Typed against the grammar so a
   * kind it does not admit is a compile error, not an inert attribute. */
  function densityDataState(kind: DensityState["kind"]): AnswerStateId | null {
    switch (kind) {
      case "pending":
        return "pending";
      case "absent":
        return "absent";
      case "measured":
        return null;
    }
  }
</script>

<div
  class="micro"
  class:quiet
  data-state={densityDataState(density.kind)}
  data-prov={provKey}
>
  {#if quiet}
    <!-- Height reserved so a later measured strip does not shift the reel. -->
  {:else if density.kind === "measured"}
    <canvas bind:this={canvas} class="strip" aria-hidden="true"></canvas>
    <span class="sr">{density.density.events} recorded events, dense where the bars rise</span>
  {:else if density.kind === "pending"}
    <span class="note trunc">density not loaded yet</span>
  {:else}
    <span class="note trunc">{density.reason}</span>
  {/if}
</div>

<style>
  .micro {
    height: var(--micro-sweep-h);
    display: flex;
    align-items: center;
    background: var(--ground-1);
    border-top: var(--hairline-w) solid var(--line-1);
    overflow: hidden;
  }
  .micro.quiet {
    background: transparent;
    border-top-color: transparent;
  }
  .strip {
    width: 100%;
    height: 100%;
    display: block;
  }
  .note {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    padding: 0 var(--sp-2);
  }
  .sr {
    position: absolute;
    width: var(--hairline-w);
    height: var(--hairline-w);
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
