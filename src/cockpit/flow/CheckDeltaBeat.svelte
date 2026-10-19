<script lang="ts">
  /**
   * A check delta beat (spec §3.2): appears ONLY when a check's state
   * changed while observed — `lint: passing → failing (3 errors)`. Never a
   * standing "checks: 2/3" block; standing state belongs to the annunciator
   * (the shell's HORIZON, not this beat).
   */
  import type { Beat } from "./types.ts";

  let { beat }: { beat: Beat } = $props();

  const delta = $derived(beat.checkDelta!);

  function word(status: string): string {
    // Plain words for the transition sentence.
    if (status === "passed") return "passing";
    if (status === "failed") return "failing";
    return status;
  }
</script>

<div class="delta beat-card" class:regressed={delta.to === "failed"} class:recovered={delta.to === "passed"}>
  <span class="name">{delta.checkName}</span>
  <span class="transition">
    {word(delta.from)} → <span class="to">{word(delta.to)}</span>
    {#if delta.errorCount !== undefined}
      ({delta.errorCount} {delta.errorCount === 1 ? "error" : "errors"})
    {/if}
  </span>
</div>

<style>
  /* Ground, hairline, radius, padding and the mono register come from the
   * shared `.beat-card` vocabulary; the leading edge is tinted there from
   * the beat's own `data-state` (a failed check is an alarm). */
  .delta {
    display: flex;
    gap: var(--sp-3);
    align-items: baseline;
  }
  .name { color: var(--ink-1); }
  .transition { color: var(--ink-2); }
  .regressed .to { color: var(--alarm); }
  .recovered .to { color: var(--ok); }
</style>
