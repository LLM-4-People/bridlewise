<script lang="ts">
  /**
   * One node of a collapsible JSON tree. Recursive.
   *
   * HONESTY RULES this renderer keeps:
   *   - keys appear in RECORDED order, never sorted;
   *   - a collapsed container states its real child count and nothing else
   *     (no sampled preview that could be mistaken for the whole value);
   *   - a folded long string names the exact remaining character count;
   *   - nothing is unreachable: the auto-open heuristic only decides the
   *     DEFAULT state, every node opens on click.
   *
   * Values are interpolated, never injected — a string value containing
   * `<script>` renders as those characters.
   */
  import Self from "./JsonNode.svelte";
  import {
    collapsedSummary,
    foldString,
    jsonEntries,
    jsonKindOf,
    shouldAutoOpen,
  } from "./shapes.ts";
  import { JSON_STRING_PREVIEW_CHARS } from "./render-config.ts";

  let {
    name,
    value,
    depth = 0,
  }: {
    /** The key (object) or index (array) this node sits under; absent at root. */
    name?: string;
    value: unknown;
    depth?: number;
  } = $props();

  const kind = $derived(jsonKindOf(value));
  const isContainer = $derived(kind === "object" || kind === "array");
  const entries = $derived(isContainer ? jsonEntries(value) : []);

  /**
   * Open state = the reader's choice if they made one, else the auto-open
   * default. Kept as two values rather than seeding `$state` from the props:
   * a `$state(shouldAutoOpen(value, depth))` initializer captures only the
   * FIRST value of each prop, so a node whose value is replaced (a streaming
   * tool call re-rendering its args) would keep the stale default. It is
   * also what the compiler's `state_referenced_locally` warning is pointing
   * at.
   */
  const autoOpen = $derived(shouldAutoOpen(value, depth));
  let choice = $state<boolean | null>(null);
  const open = $derived(choice ?? autoOpen);

  let stringExpanded = $state(false);

  const str = $derived(typeof value === "string" ? value : "");
  const strFold = $derived(
    foldString(str, stringExpanded ? Number.POSITIVE_INFINITY : JSON_STRING_PREVIEW_CHARS),
  );

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
</script>

<div class="node">
  {#if isContainer}
    <button class="twisty-row" type="button" onclick={() => (choice = !open)} aria-expanded={open}>
      <span class="twisty" aria-hidden="true">{open ? "▾" : "▸"}</span>
      {#if name !== undefined}<span class="key">{name}</span>{/if}
      {#if !open}<span class="summary">{collapsedSummary(value)}</span>{/if}
      {#if open}<span class="brace">{kind === "array" ? "[" : "{"}</span>{/if}
    </button>
    {#if open}
      <div class="children">
        {#each entries as [childKey, childValue] (childKey)}
          <Self name={childKey} value={childValue} depth={depth + 1} />
        {/each}
      </div>
      <div class="brace close">{kind === "array" ? "]" : "}"}</div>
    {/if}
  {:else}
    <div class="leaf">
      {#if name !== undefined}<span class="key">{name}</span>{/if}
      {#if kind === "string"}
        <span class="str">{strFold.shown}</span>{#if strFold.hidden > 0}<button
            class="more"
            type="button"
            onclick={() => (stringExpanded = true)}>{fmt(strFold.hidden)} more chars</button
          >{:else if stringExpanded && str.length > JSON_STRING_PREVIEW_CHARS}<button
            class="more"
            type="button"
            onclick={() => (stringExpanded = false)}>Fold</button
          >{/if}
      {:else if kind === "number"}
        <span class="num">{String(value)}</span>
      {:else if kind === "boolean"}
        <span class="bool">{String(value)}</span>
      {:else if kind === "null"}
        <span class="nul">null</span>
      {:else}
        <span class="other">{String(value)}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .node {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    min-width: 0;
  }
  .twisty-row {
    appearance: none;
    min-height: var(--hit-min);
    background: none;
    border: none;
    padding: 0;
    display: flex;
    align-items: baseline;
    gap: var(--sp-1);
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .twisty-row:hover .key,
  .twisty-row:hover .summary {
    color: var(--ink-1);
  }
  .twisty {
    display: inline-block;
    width: var(--json-twisty-w);
    /* A FOLD CONTROL IS AN INTERACTIVE GRAPHICAL OBJECT (WCAG 1.4.11, 3:1),
     * and the row's own summary text beside it wears ink-3 — the control was
     * the row's only ink-4 outlier (2.45:1 Carbon / 2.03:1 Logbook, UIE-046).
     * FolderPicker's twisties already read ink-3; this joins them. */
    color: var(--ink-3);
  }
  .children {
    padding-left: var(--json-indent);
    border-left: var(--hairline-w) solid var(--line-1);
    margin-left: var(--json-twisty-w);
  }
  .leaf {
    display: flex;
    align-items: baseline;
    gap: var(--sp-1);
    padding-left: var(--json-twisty-w);
    min-width: 0;
  }
  /* THE TREE'S OWN WRAP LAW, applied to every token it renders. `.str`
   * already wrapped anywhere (the tree's own idiom); the KEY was the
   * deviation — `white-space: nowrap` made one long key the min-content
   * width of its whole flex chain, which at a narrow host (the right
   * menu's overlay column) became the column's horizontal scrollbar (the
   * side-scrolling defect; measured: `.key`/`.num` rows pushing a 157px
   * column to 369px). Keys and scalar tokens now break ANYWHERE when they
   * would overflow — `overflow-wrap: anywhere` is what min-content sizing
   * HONORS, so the flex rows can shrink too (a `break-word` value would
   * paint the same but still report the old min-content width). Short
   * keys never wrap: the value only breaks when the word would overflow. */
  .key {
    color: var(--syn-type);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .key::after {
    content: ":";
    color: var(--syn-punct);
  }
  .summary {
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .brace {
    color: var(--syn-punct);
  }
  .close {
    padding-left: var(--json-twisty-w);
  }
  .str {
    color: var(--syn-string);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .num {
    color: var(--syn-number);
    font-variant-numeric: tabular-nums;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .bool,
  .nul {
    color: var(--syn-keyword);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .other {
    color: var(--ink-2);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .more {
    appearance: none;
    min-height: var(--hit-min);
    padding: 0 var(--sp-1);
    background: none;
    border: none;
    border-bottom: var(--hairline-w) dotted var(--line-2);
    margin-left: var(--sp-1);
    font: inherit;
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
    cursor: pointer;
  }
  .more:hover {
    color: var(--ink-1);
  }
</style>
