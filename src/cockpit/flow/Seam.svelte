<script lang="ts">
  /**
   * The turn seam (spec §3.3 step 8, §4.3): a full-bleed hairline carrying
   * the turn's measured rollup in ONE line — not a card. The sentence is a
   * finding (∴ register) with its mandatory derivation; queued findings sit
   * behind the "+N more" count (the admission controller admitted one).
   */
  import FindingNote from "../computer/FindingNote.svelte";
  import type { Beat } from "./types.ts";

  let { beat }: { beat: Beat } = $props();

  const seam = $derived(beat.seam!);
</script>

<div class="seam">
  <div class="rule" aria-hidden="true"></div>
  <div class="line">
    <FindingNote sentence={seam.sentence} derivation={seam.derivation} verbs={beat.verbs} />
    {#if seam.queued > 0}
      <span class="queued">+{seam.queued} more</span>
    {/if}
  </div>
  <div class="rule" aria-hidden="true"></div>
</div>

<style>
  .seam {
    padding: var(--sp-0) var(--gutter-bleed);
  }
  .rule {
    height: var(--hairline-w);
    background: var(--line-2);
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    padding: var(--sp-0) 0;
  }
  .queued {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-4);
    white-space: nowrap;
  }
</style>
