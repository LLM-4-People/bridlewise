<script lang="ts">
  /** The existing vector brand mark, shared by entry and workspace chrome. */
  let { wordmark = false }: { wordmark?: boolean } = $props();
</script>

<span class="brand" class:wordmark>
  <img src="/icons/icon.svg" width="40" height="40" alt={wordmark ? "" : "Bridlewise"} />
  {#if wordmark}<span>bridlewise</span>{/if}
</span>

<style>
  .brand { display: inline-flex; align-items: center; gap: var(--sp-3); min-width: 0; color: var(--ink-1); font: var(--f-prose-size) var(--face-sans); }
  img { display: block; width: var(--monitor-h); height: var(--monitor-h); border-radius: var(--radius-1); }
  .wordmark img { width: var(--horizon-h); height: var(--horizon-h); }
</style>
