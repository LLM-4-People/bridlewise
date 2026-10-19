<script lang="ts">
  /**
   * A real unified diff: hunk headers, +/− gutter, both line-number rails,
   * syntax colour, and intra-line change emphasis.
   *
   * THE ONE diff renderer — the flow's micro-diff (EffectBeat) and the SCOPE
   * sheet (DiffSheet) both mount this, so a change looks the same wherever
   * it is read. Input is always the REAL patch from the diff-patch route,
   * parsed by diff.ts; nothing here synthesizes a line, a number, or a path.
   *
   * LAYOUT: horizontal scroll, never wrap. A diff is columnar — gutter, two
   * number rails, and source indentation all carry meaning, and soft-wrap
   * silently breaks the row↔source-line correspondence that makes a diff
   * readable. Prose and command output wrap; diffs and code do not. (The
   * scroller is its own box, so the page body never scrolls sideways.)
   *
   * The two visual signals compose rather than compete: the ROW wash says
   * "this line was added/removed", the stronger INLINE wash inside it says
   * "this is the part that actually changed". paintDiffLine merges the
   * syntax tokens and the change segments into one flat run list so both
   * read at once.
   */
  import { paintDiffLine, type ParsedDiff } from "./diff.ts";
  import { grammarForPath } from "./highlight.ts";
  import CopyButton from "./CopyButton.svelte";

  let {
    parsed,
    patch,
    lang,
    hidden = 0,
    onExpand,
    showPaths = true,
    showCounts = false,
  }: {
    parsed: ParsedDiff;
    /** The raw patch, for the copy button — copies what was recorded. */
    patch: string;
    /** Grammar override; otherwise inferred from each file's own path. */
    lang?: string;
    /** Body lines this view is holding back (from firstHunkOf). */
    hidden?: number;
    /** Called when the reader asks for the held-back lines. */
    onExpand?: () => void;
    showPaths?: boolean;
    /** Show ± in this component's own bar. Default OFF: the flow's effect
     * beat and the custody sheet already state the counts in their own
     * header, and two copies of the same number on one card is noise. */
    showCounts?: boolean;
  } = $props();

  /** The grammar for a file: caller override, else the path's extension. */
  function langFor(path: string | undefined): string {
    if (lang !== undefined) return lang;
    if (path === undefined) return "";
    return grammarForPath(path) ?? "";
  }

  function gutterOf(kind: string): string {
    if (kind === "add") return "+";
    if (kind === "del") return "−";
    return " ";
  }

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
</script>

<div class="diff reveal-on-hover">
  <div class="bar">
    {#if showCounts}
      <span class="counts">
        <span class="add-ink">+{fmt(parsed.added)}</span>
        <span class="del-ink">−{fmt(parsed.removed)}</span>
      </span>
    {/if}
    <span class="spacer"></span>
    <CopyButton text={patch} what="copy this diff" />
  </div>

  <div class="scroller">
    {#each parsed.files as file, f (f)}
      {#if showPaths && file.path !== undefined}
        <div class="file-path">{file.path}</div>
      {/if}
      {#each file.hunks as hunk, h (h)}
        <div class="hunk">
          <span class="hunk-range">{hunk.header.slice(0, hunk.header.lastIndexOf("@@") + 2)}</span>
          {#if hunk.section.length > 0}<span class="hunk-section">{hunk.section}</span>{/if}
        </div>
        {#each hunk.lines as line, l (l)}
          <div
            class="line"
            class:diff-add={line.kind === "add"}
            class:diff-del={line.kind === "del"}
            class:diff-context={line.kind === "context"}
            class:diff-marker={line.kind === "marker"}
          >
            <span class="no" aria-hidden="true">{line.oldNo ?? ""}</span>
            <span class="no" aria-hidden="true">{line.newNo ?? ""}</span>
            <span class="gutter" aria-hidden="true">{gutterOf(line.kind)}</span>
            <span class="text"
              >{#each paintDiffLine(line.text, langFor(file.path), line.segs) as piece, p (p)}<span
                  class="syn-{piece.kind}"
                  class:syn-chg={piece.changed}>{piece.text}</span
                >{/each}</span
            >
          </div>
        {/each}
      {/each}
    {/each}
  </div>

  {#if hidden > 0 && onExpand !== undefined}
    <button class="verb more" type="button" onclick={onExpand}>
      {fmt(hidden)} more {hidden === 1 ? "line" : "lines"} in this change
    </button>
  {:else if hidden > 0}
    <div class="more-absence">
      {fmt(hidden)} more {hidden === 1 ? "line" : "lines"} not shown here
    </div>
  {/if}
</div>

<style>
  /* A DIFF IS CONTENT, NOT A SURFACE.
   *
   * This used to paint its own raised card — ground-1, a hairline and a
   * card radius. Every single mount is already inside a raised surface:
   * the flow's effect beat (.effect card), a tool call's diff argument
   * (.tool card), and the custody room's diff pane. So the card was always
   * a second slab drawn on top of a surface that already had one, which is
   * the gray panel the user rejected — most visibly in custody, where the
   * pane had just been rebuilt as ONE continuous ground with the parcels
   * list and then had a box drawn inside it.
   *
   * The rule is decided HERE rather than passed in by each caller, and it
   * is the simple one: whatever hosts a diff provides its ground. Nothing
   * opts in, nothing opts out, and no caller — including the custody room —
   * has to know. The structural hairlines stay (the bar's rule, the file
   * path's rule): those separate PARTS of the diff from each other, which
   * is meaning, not decoration. */
  .diff {
    position: relative;
    min-width: 0;
    font-family: var(--face-mono);
    font-size: var(--f-code-size);
    line-height: var(--f-code-lh);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--copy-inset) var(--code-pad-x);
    border-bottom: var(--hairline-w) solid var(--line-1);
    min-height: var(--hit-min);
  }
  .counts {
    font-size: var(--f-micro-size);
    letter-spacing: var(--f-micro-track);
    font-variant-numeric: tabular-nums;
  }
  .add-ink {
    color: var(--ok);
  }
  .del-ink {
    color: var(--alarm);
  }
  .spacer {
    flex: 1;
  }
  .scroller {
    overflow-x: auto;
    overflow-y: auto;
    max-height: var(--diff-max-h);
  }
  .file-path {
    padding: var(--sp-1) var(--code-pad-x);
    color: var(--ink-2);
    border-bottom: var(--hairline-w) solid var(--line-1);
    white-space: pre;
  }
  .hunk {
    display: flex;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--code-pad-x);
    background: var(--diff-hunk-wash);
    white-space: pre;
  }
  .hunk-range {
    color: var(--beam);
    font-variant-numeric: tabular-nums;
  }
  .hunk-section {
    color: var(--ink-3);
  }
  .line {
    display: flex;
    align-items: baseline;
    white-space: pre;
    min-height: 1lh;
    padding-right: var(--code-pad-x);
  }
  .diff-add {
    background: var(--diff-add-wash);
  }
  .diff-del {
    background: var(--diff-del-wash);
  }
  .diff-marker {
    color: var(--ink-4);
  }
  /* Context rows carry no wash — they are the unchanged ground the +/− read
   * against. The class exists so the row's kind is expressed in the DOM. */
  .diff-context {
    background: none;
  }
  .no {
    flex: none;
    width: var(--diff-num-w);
    padding-right: var(--sp-1);
    text-align: right;
    color: var(--ink-4);
    font-variant-numeric: tabular-nums;
    user-select: none;
  }
  .gutter {
    flex: none;
    width: var(--diff-gutter-w);
    text-align: center;
    color: var(--ink-3);
    user-select: none;
  }
  .diff-add .gutter {
    color: var(--ok);
  }
  .diff-del .gutter {
    color: var(--alarm);
  }
  .text {
    flex: 1;
    min-width: 0;
    color: var(--ink-1);
    tab-size: 2;
  }
  /* The `.syn-*` role colours and the `.syn-chg` intra-line wash are owned
   * once in tokens.css (shared with CodeBlock) — see "THE SYNTAX ROLE
   * VOCABULARY" there. */
  /* Chrome is `.verb.more`. Layout: the diff's own pad. */
  .more {
    padding: var(--sp-1) var(--code-pad-x);
    font-variant-numeric: tabular-nums;
  }
  .more-absence {
    padding: var(--sp-1) var(--code-pad-x);
    border-top: var(--hairline-w) solid var(--line-1);
    font-size: var(--f-micro-size);
    /* "N more lines not shown" is an absence — the absence ink, no slant. */
    color: var(--state-absent-ink);
    font-variant-numeric: tabular-nums;
  }

</style>
