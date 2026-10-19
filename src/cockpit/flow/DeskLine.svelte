<script lang="ts">
  /**
   * The desk-line content (§4.3) — what the FLOW docks into the shell's
   * desk-edge slot (ShellApi.setDeskLine): the live grammar menu while the
   * composer holds a `/` or `?` prefix, and the admitted next-turn finding.
   * Pure presentation — the Flow owns admission, matching and dismissal.
   */
  import FindingNote from "../computer/FindingNote.svelte";
  import { trimVerbPlaceholder } from "../computer/findings.ts";
  import type { GrammarMenuItem } from "./composer-router.ts";
  import type { FindingBody } from "./types.ts";

  let {
    menu = [],
    finding = null,
    onDismiss = undefined,
  }: {
    /** Live grammar matches for the current composer text ([] = none). */
    menu?: readonly GrammarMenuItem[];
    /** The admitted desk-line finding, or null. */
    finding?: FindingBody | null;
    onDismiss?: (() => void) | undefined;
  } = $props();
</script>

{#if menu.length > 0}
  <ul class="menu" aria-label="matching grammar entries">
    {#each menu as item (item.head)}
      <li><span class="head">{item.head}</span> <span class="detail">{item.detail}</span></li>
    {/each}
  </ul>
{/if}

{#if finding !== null}
  <FindingNote
    sentence={finding.sentence}
    derivation={finding.derivation}
    verbs={finding.verbs ?? [trimVerbPlaceholder("the history strip above — this desk's own trim point")]}
    onDismiss={onDismiss}
  />
{/if}

<style>
  .menu {
    list-style: none;
    margin: 0;
    padding: var(--sp-1) var(--sp-2);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    max-height: var(--menu-max-h);
    overflow-y: auto;
  }
  .menu .head {
    color: var(--ink-1);
  }
  .menu .detail {
    color: var(--ink-3);
  }
</style>
