<script lang="ts">
  /**
   * Block-level markdown → DOM. Recursive (blockquotes and list items hold
   * blocks). Inline runs go to MdInline; fenced code goes to the ONE code
   * renderer (CodeBlock), so a fence in a chat turn and a file returned by a
   * tool are highlighted by the same code path.
   *
   * TYPOGRAPHY. The heading ramp is deliberately shallow (21/18/16 against
   * 15.5px prose) and leans on weight + a hairline under h1/h2 rather than
   * size: this is a message in a bubble, not a document page, and a 32px h1
   * inside a chat turn reads as shouting. Blocks are a flex column with one
   * rhythm token (--prose-gap) so vertical spacing is decided once instead
   * of per-element margins that fight each other.
   */
  import CodeBlock from "./CodeBlock.svelte";
  import MdInline from "./MdInline.svelte";
  import Self from "./MdBlocks.svelte";
  import type { MdBlock } from "../../../shared/markdown.ts";

  let {
    blocks,
    codeMaxLines,
    dense = false,
  }: {
    blocks: readonly MdBlock[];
    /** Fold fenced code past this many lines (undefined = never fold).
     *  Explicitly `| undefined` because it is FORWARDED to CodeBlock and this
     *  project sets `exactOptionalPropertyTypes` — see CodeBlock.startLine. */
    codeMaxLines?: number | undefined;
    /** Inside an instrument card: code blocks stay within the card width. */
    dense?: boolean;
  } = $props();

  const ALIGN_CSS: Readonly<Record<string, string>> = {
    left: "left",
    center: "center",
    right: "right",
    none: "",
  };
</script>

{#each blocks as block, i (i)}
  {#if block.type === "paragraph"}
    <p><MdInline nodes={block.children} /></p>
  {:else if block.type === "heading"}
    <!-- role/aria-level rather than <h1>–<h6>: a chat turn is embedded
         content, and injecting real document headings into the page outline
         from model output would corrupt the app's heading structure. The
         level classes are bound explicitly (not interpolated) so the styles
         stay statically analysable. -->
    <div
      class="h"
      class:h1={block.level === 1}
      class:h2={block.level === 2}
      class:h3={block.level === 3}
      class:h4={block.level === 4}
      class:h5={block.level === 5}
      class:h6={block.level === 6}
      role="heading"
      aria-level={block.level}
    >
      <MdInline nodes={block.children} />
    </div>
  {:else if block.type === "code"}
    <CodeBlock code={block.code} lang={block.lang} maxLines={codeMaxLines} {dense} />
  {:else if block.type === "hr"}
    <hr />
  {:else if block.type === "blockquote"}
    <blockquote><Self blocks={block.children} {codeMaxLines} {dense} /></blockquote>
  {:else if block.type === "list"}
    {#if block.ordered}
      <ol>
        {#each block.items as item, k (k)}
          <li>
            <MdInline nodes={item.children} />
            {#if item.subBlocks.length > 0}
              <div class="sub"><Self blocks={item.subBlocks} {codeMaxLines} {dense} /></div>
            {/if}
          </li>
        {/each}
      </ol>
    {:else}
      <ul>
        {#each block.items as item, k (k)}
          <li>
            <MdInline nodes={item.children} />
            {#if item.subBlocks.length > 0}
              <div class="sub"><Self blocks={item.subBlocks} {codeMaxLines} {dense} /></div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if block.type === "table"}
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            {#each block.header as cell, c (c)}
              <th style:text-align={ALIGN_CSS[block.align[c] ?? "none"]}>
                <MdInline nodes={cell} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each block.rows as row, r (r)}
            <tr>
              {#each row as cell, c (c)}
                <td style:text-align={ALIGN_CSS[block.align[c] ?? "none"]}>
                  <MdInline nodes={cell} />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/each}

<style>
  /* ── §2.1 THE MEASURE LIVES HERE ──────────────────────────────────────
   * Running prose is capped at --measure (76ch) ON THE BLOCK ITSELF, so
   * the `ch` resolves in the font the text is actually read in. Applying
   * it to an ancestor with a different font size silently yields a
   * different (narrower) column — that was the bug that pinned turns to
   * ~36% of a 1536px screen.
   *
   * INSTRUMENTAL blocks are exempt and BLEED to --rail: a table, a
   * code block or a diff carries columnar meaning and earns the room. */
  p,
  .h,
  ul,
  ol,
  blockquote {
    max-width: min(100%, var(--measure));
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .table-scroll {
    max-width: var(--rail);
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .h {
    font-weight: var(--f-heading-weight);
    line-height: var(--f-heading-lh);
    color: var(--ink-1);
    overflow-wrap: anywhere;
  }
  /* Extra lead ABOVE a heading (never below — the gap owns that), so a
   * heading binds visually to the prose it introduces. */
  .h:not(:first-child) {
    margin-top: var(--prose-heading-space);
  }
  .h1 {
    font-size: var(--f-h1-size);
    padding-bottom: var(--sp-1);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  .h2 {
    font-size: var(--f-h2-size);
    padding-bottom: var(--sp-1);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  .h3 {
    font-size: var(--f-h3-size);
  }
  /* h4–h6 sit at prose size and separate by weight + color alone. */
  .h4,
  .h5,
  .h6 {
    font-size: var(--f-prose-size);
    color: var(--ink-2);
  }
  hr {
    height: var(--hairline-w);
    border: none;
    background: var(--line-1);
    margin: 0;
  }
  blockquote {
    margin: 0;
    padding-left: var(--prose-quote-inset);
    border-left: var(--rule-w) solid var(--line-2);
    color: var(--ink-2);
    display: flex;
    flex-direction: column;
    gap: var(--prose-gap);
  }
  ul,
  ol {
    margin: 0;
    padding-left: var(--prose-list-indent);
    display: flex;
    flex-direction: column;
    gap: var(--prose-tight-gap);
  }
  li {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  li::marker {
    color: var(--ink-3);
  }
  .sub {
    display: flex;
    flex-direction: column;
    gap: var(--prose-tight-gap);
    margin-top: var(--prose-tight-gap);
  }
  /* A table bleeds to --rail (above) and only scrolls when it is
   * wider than THAT — so the common case is a table with room to breathe,
   * not a wide table squeezed into a reading column. The scroll box is its
   * own, so the page body never scrolls sideways. */
  .table-scroll {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    font-size: var(--f-ui-size);
  }
  th,
  td {
    border: var(--hairline-w) solid var(--line-1);
    padding: var(--sp-1) var(--sp-2);
    vertical-align: top;
  }
  th {
    background: var(--ground-1);
    font-weight: var(--f-heading-weight);
    color: var(--ink-1);
    white-space: nowrap;
  }
  td {
    color: var(--ink-2);
  }
</style>
