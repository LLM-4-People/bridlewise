<script lang="ts">
  /**
   * The grammar hint — the honesty surface for the keyboard grammar
   * (§2.7): a pressed chord whose target is not built yet NEVER silently
   * does nothing; this line states the chord's meaning and the truth
   * ("not built yet"). Transient, aria-live polite, auto-dismisses.
   * It appears only from user action, so it cannot violate the
   * one-reveal law's idle-stability window (§10.3).
   */
  import { HINT_DISMISS_MS } from "./config.ts";

  let { text, seq }: { text: string; seq: number } = $props();

  let visible = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    void seq;
    if (text.length === 0) return;
    visible = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => (visible = false), HINT_DISMISS_MS);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  });
</script>

<div class="hint-anchor" role="status" aria-live="polite">
  {#if visible}
    <span class="hint">{text}</span>
  {/if}
</div>

<style>
  .hint-anchor {
    position: absolute;
    top: calc(var(--room-top) + var(--sp-3));
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    pointer-events: none;
    z-index: 50;
  }
  .hint {
    background: var(--ground-3);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    box-shadow: var(--shadow-sheet);
    color: var(--ink-2);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    padding: var(--sp-1) var(--sp-3);
  }
</style>
