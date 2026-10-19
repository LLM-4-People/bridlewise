<script lang="ts">
  /**
   * The BEAD (spec §11.2): a beam-colored mark that travels the flow's
   * gutter spine along REAL causal edges as they are recorded. Its position
   * derives from the log (the beat doing work now) — it NEVER moves without
   * a corresponding event, and when the run stalls it visibly holds (honest
   * stillness). Size is `--bead-size` (glanceable in the 32px gutter).
   * Compositor-only motion: translateY on an absolutely positioned
   * element. Under reduced motion the transition is disabled — position
   * updates are discrete, no tween (§12.5).
   */
  let {
    target,
  }: {
    target: Readonly<{ offset: number; height: number }> | null;
  } = $props();
</script>

{#if target !== null}
  <div
    class="bead"
    style:transform="translateY({target.offset + Math.min(target.height / 2, 20)}px)"
    aria-hidden="true"
  ></div>
{/if}

<style>
  .bead {
    position: absolute;
    top: 0;
    /* centered on the gutter's spine */
    left: calc((var(--gutter-beat) - var(--bead-size)) / 2);
    width: var(--bead-size);
    height: var(--bead-size);
    border-radius: 0; /* data mark: radius 0 (§12.5) */
    background: var(--beam);
    box-shadow: 0 0 var(--sp-2) var(--beam);
    transition: transform var(--t-2) var(--ease-out);
    will-change: transform;
    z-index: 2;
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .bead {
      transition: none;
    }
  }
</style>
