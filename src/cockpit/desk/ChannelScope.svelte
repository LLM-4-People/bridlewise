<script lang="ts">
  /**
   * SCOPE body for a channel strip (§3.4): the REAL items of the served
   * composition: what the model would be given on the next reply: with
   * each item's ACTUAL TEXT one click away.
   *
   * What changed and why: this scope used to render the item's name and its
   * token count, which is exactly what the strip row already showed. `view`
   * could not tell anyone anything, because the strips read carries nothing
   * else. The gap was on the server, and it is closed there
   * (`run.composeItem`); this surface is where the closing shows.
   *
   * MOUSE-FIRST (v2.1): the ROW is the target, not a chip on it. A row
   * carries its caret at rest, so it reads as openable BEFORE the pointer
   * arrives; hover and focus deepen it rather than revealing it. Rows meet
   * the pointer-target floor (--hit-min) in both axes.
   *
   * The acting verbs (pin / unpin / mute) stay on the strip: this is where
   * you read what is being sent, not where you change it.
   */
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";
  import type { ShellApi } from "../shell/contract.ts";
  import { fmtTokens, type ChannelId, type StripItem } from "./desk-data.ts";
  import ItemBody from "./ItemBody.svelte";

  let {
    shell = null,
    chatId,
    channel,
    name,
    items,
    totalTokens,
    asOf,
    focusItemId = null,
    pinnedIds = [],
    mutedIds = [],
  }: {
    shell?: ShellApi | null;
    chatId: string;
    channel: ChannelId;
    name: string;
    items: readonly StripItem[];
    totalTokens: number;
    /** Epoch ms of the read this scope shows (§1.1: every number has one). */
    asOf: number;
    focusItemId?: string | null;
    pinnedIds?: readonly string[];
    mutedIds?: readonly string[];
  } = $props();

  // Outlet-contract prop; this body renders only served reads.
  const hasShell = $derived(shell !== null);

  /** Open on the row that was clicked; a channel opened whole starts on its
   * first item, because a scope that opens on nothing has taught nothing. */
  let chosen = $state<string | null>(null);
  let chosenFor = $state<string | null>(null);
  const openId = $derived.by(() => {
    const seed = focusItemId ?? items[0]?.id ?? null;
    return chosenFor === `${chatId}/${channel}` ? chosen : seed;
  });

  function toggle(id: string): void {
    chosenFor = `${chatId}/${channel}`;
    chosen = openId === id ? null : id;
  }

  function timeOf(ms: number): string {
    return new Date(ms).toLocaleTimeString("en-US", { hour12: false });
  }
</script>

<div class="channel-scope" data-shell={hasShell ? "yes" : "no"}>
  <p class="provenance">
    what the model would be given as <strong>{name}</strong> on the next reply:
    measured at {timeOf(asOf)} by the same assembly that runs the turn.
  </p>
  {#if items.length === 0}
    <Answer answer={absent("this channel carries nothing for the next reply.")} />
  {:else}
    <ul class="items">
      {#each items as item (item.id)}
        {@const open = openId === item.id}
        <li class="item">
          <button
            class="row"
            data-verb-id="desk.scope/view"
            aria-expanded={open}
            title="show the words this puts into the next reply"
            onclick={() => toggle(item.id)}
          >
            <span class="caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span class="label">{item.label}</span>
            <span class="marks">
              {#if pinnedIds.includes(item.id)}<span class="mark engraved">Pinned</span>{/if}
              {#if mutedIds.includes(item.id)}<span class="mark engraved">Muted</span>{/if}
            </span>
            <span class="tokens">{fmtTokens(item.tokens)} tok</span>
          </button>
          {#if open}
            <ItemBody {chatId} {channel} itemId={item.id} />
          {/if}
        </li>
      {/each}
    </ul>
    <p class="total">{fmtTokens(totalTokens)} tok in this channel</p>
  {/if}
</div>

<style>
  .channel-scope {
    display: flex;
    flex-direction: column;
    gap: var(--sheet-gap);
    min-width: 0;
  }
  .provenance {
    margin: 0;
    color: var(--ink-3);
    font-size: var(--f-data-size);
  }
  .provenance strong {
    color: var(--ink-2);
    font-weight: var(--f-micro-weight);
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .item {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  /* THE ROW IS THE TARGET. At rest it already carries its caret and its
   * hairline, so it reads as openable before the pointer arrives; hover
   * and focus only deepen what is already there. */
  .row {
    display: grid;
    grid-template-columns: max-content 1fr max-content max-content;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    appearance: none;
    background: none;
    border: none;
    border-radius: var(--radius-1);
    padding: var(--sp-1) var(--sp-2);
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--layer-hover);
  }
  .row[aria-expanded="true"] {
    background: var(--layer-select);
  }
  .caret {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
  }
  .row:hover .caret {
    color: var(--ink-1);
  }
  .label {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-1);
  }
  .marks {
    display: flex;
    gap: var(--sp-1);
  }
  /* The mark's engraved recipe is owned by tokens.css (.cockpit .engraved);
   * what the strip owns is the chip's edge around the word. */
  .mark {
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: 0 var(--sp-1);
  }
  .tokens {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .total {
    margin: 0;
    text-align: right;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
  }
</style>
