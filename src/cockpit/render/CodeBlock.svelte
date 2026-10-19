<script lang="ts">
  /**
   * A code block: syntax-highlighted, optionally line-numbered, copyable,
   * folded with a NAMED remainder.
   *
   * The single code renderer for the cockpit — fenced blocks in prose, file
   * content returned by a tool, and any other recorded source all land here,
   * so "how code looks" is decided once.
   *
   * SECURITY: `highlight()` returns TOKENS, never markup. Each token is
   * interpolated with `{tok.text}`, so hostile source (`</span><script>`) is
   * text in a text node — there is no parse path from tool output to DOM
   * structure. This component contains no {@html} and cannot.
   *
   * HONESTY:
   *   - the fold names how many lines it is holding back; nothing is
   *     silently cut;
   *   - when no grammar matched, the language chip says so on hover instead
   *     of the code being mis-colored by a guessed grammar;
   *   - line numbers are only rendered when the caller can anchor them
   *     (`startLine`), and the caller only passes them when the record
   *     supports it.
   *
   * PERFORMANCE: only the SHOWN lines are highlighted. Folding happens
   * before tokenizing, so a 40k-line file costs the same as its 20-line
   * preview until the reader opens it. Highlighting a collapsed block is
   * work the virtualizer never pays for.
   *
   * LAYOUT: horizontal scroll, no wrapping — a source line is a unit and
   * soft-wrapping breaks its correspondence to the number rail.
   */
  import { highlight } from "./highlight.ts";
  import { foldLines } from "./shapes.ts";
  import CopyButton from "./CopyButton.svelte";

  let {
    code,
    lang = "",
    startLine,
    maxLines,
    dense = false,
  }: {
    code: string;
    /** Fence language / grammar hint. Empty means "unstated". */
    lang?: string;
    /**
     * When given, the gutter numbers lines from here. Absent = no gutter.
     *
     * `| undefined` is written out because this project sets
     * `exactOptionalPropertyTypes`, under which `?: number` means "a number or
     * NOT PASSED AT ALL" and refuses an explicit `undefined`. Callers forward
     * their OWN optional straight through (`startLine={someOptional}`), which
     * is passing undefined, so the absent case has to be part of the type or
     * every forwarding caller is a type error. This is not a widening: absence
     * is a value this prop already documents.
     */
    startLine?: number | undefined;
    /** Fold past this many lines. Absent = show everything. Forwarded by
     *  callers, hence the explicit `| undefined` — see `startLine`. */
    maxLines?: number | undefined;
    /** Inside an instrument cell: tighter, no bleed past the card. */
    dense?: boolean;
  } = $props();

  let expanded = $state(false);

  const allLines = $derived(code.split("\n"));
  const cap = $derived(expanded || maxLines === undefined ? Number.POSITIVE_INFINITY : maxLines);
  const fold = $derived(foldLines(allLines, cap));
  /** Only the visible slice is tokenized (see PERFORMANCE above). */
  const hl = $derived(highlight(fold.shown.join("\n"), lang));

  const langLabel = $derived(lang.trim());
  const declined = $derived(hl.declined);

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
</script>

<div class="code-block reveal-on-hover" class:dense>
  <div class="bar engraved">
    {#if langLabel.length > 0}
      <span class="lang" class:unknown={!hl.highlighted} title={declined ?? langLabel}>
        {langLabel}
      </span>
    {/if}
    <span class="lines">{fmt(allLines.length)} {allLines.length === 1 ? "line" : "lines"}</span>
    <span class="spacer"></span>
    <CopyButton text={code} what="copy this code block" />
  </div>

  <div class="scroller">
    <pre class="code"><code>{#each hl.lines as toks, i (i)}<span class="row">{#if startLine !== undefined}<span
              class="no"
              aria-hidden="true">{startLine + i}</span>{/if}<span class="src">{#each toks as tok, t (t)}<span
                class="syn-{tok.kind}">{tok.text}</span>{/each}
</span></span>{/each}</code></pre>
  </div>

  {#if fold.hidden > 0}
    <button class="verb more" type="button" onclick={() => (expanded = true)}>
      {fmt(fold.hidden)} more {fold.hidden === 1 ? "line" : "lines"}
    </button>
  {:else if expanded && maxLines !== undefined && allLines.length > maxLines}
    <button class="verb more" type="button" onclick={() => (expanded = false)}>
      Fold back to {fmt(maxLines)} {maxLines === 1 ? "line" : "lines"}
    </button>
  {/if}
</div>

<style>
  .code-block {
    position: relative;
    max-width: var(--rail);
    min-width: 0;
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-card);
    overflow: hidden;
  }
  .dense {
    max-width: 100%;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--copy-inset) var(--code-pad-x);
    border-bottom: var(--hairline-w) solid var(--line-1);
    font-family: var(--face-mono);
    min-height: var(--hit-min);
  }
  .lang {
    color: var(--ink-2);
  }
  /* No grammar matched: the word is still shown, but it is not a claim that
   * the code was parsed as that language. An absence, so the absence ink and
   * no slant (the retired treatment). */
  .unknown {
    color: var(--state-absent-ink);
  }
  .lines {
    font-variant-numeric: tabular-nums;
  }
  .spacer {
    flex: 1;
  }
  .scroller {
    overflow-x: auto;
    overflow-y: auto;
    max-height: var(--code-max-h);
  }
  .code {
    margin: 0;
    padding: var(--code-pad-y) var(--code-pad-x);
    font-family: var(--face-mono);
    font-size: var(--f-code-size);
    line-height: var(--f-code-lh);
    color: var(--ink-1);
    white-space: pre;
    tab-size: 2;
  }
  .row {
    display: block;
  }
  .no {
    display: inline-block;
    width: var(--code-lineno-w);
    margin-right: var(--code-rail-gap);
    text-align: right;
    color: var(--ink-4);
    font-variant-numeric: tabular-nums;
    user-select: none;
  }
  .src {
    /* The row's text; keeps the number rail out of a copy-drag of the code. */
    white-space: pre;
  }
  /* Chrome is `.verb.more`. Layout: the code-block's own pad. */
  .more {
    padding: var(--sp-1) var(--code-pad-x);
    font-variant-numeric: tabular-nums;
  }
  /* The `.syn-*` role colours are owned once in tokens.css (shared with
   * UnifiedDiff) — see "THE SYNTAX ROLE VOCABULARY" there. */
</style>
