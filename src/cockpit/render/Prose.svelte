<script lang="ts">
  /**
   * THE prose renderer for the cockpit (§3.2 turn bodies).
   *
   * One entry point: text in, rendered markdown out. Every consumer —
   * TurnBeat's model and user prose, the reasoning fold, any future prose
   * surface — goes through here, so "how words look" is decided once and a
   * fix lands everywhere. The single-renderer rule is enforced by
   * tests/cockpit/render-sanitization-owner.test.ts (parseMarkdown may only
   * be imported by this component).
   *
   * STREAMING: the parser is lenient, so re-parsing on every token never
   * produces broken structure — a half-typed `**bold` is literal text until
   * its closer arrives. The caret is the caller's business; this renders the
   * committed text plus whatever tail it was handed.
   *
   * MEASURE (§2.1). This container does NOT cap its own width. The measure
   * belongs to the RUNNING PROSE blocks — paragraphs, headings, lists,
   * quotes — and is applied to them in MdBlocks, in the font they are
   * actually read in (`ch` is font-relative, so a measure applied on an
   * ancestor with a different font size resolves to a different, usually
   * narrower, number).
   *
   * INSTRUMENTAL content BLEEDS past it: code blocks, tables and diffs get
   * --rail. Trapping a wide table inside a 76ch reading rail and
   * making it scroll horizontally — while a thousand pixels of screen sit
   * empty — is the "not space optimized" charge, and it throws away the
   * single biggest thing a web UI can offer over a terminal here: room.
   */
  import MdBlocks from "./MdBlocks.svelte";
  import { parseProseBounded } from "../../../shared/markdown.ts";
  import { MAX_MARKDOWN_CHARS } from "./render-config.ts";
  import Answer from "../response/Answer.svelte";
  import { refused } from "../response/grammar.ts";

  let {
    text,
    codeMaxLines,
    dense = false,
  }: {
    text: string;
    /** Fold fenced code blocks past this many lines. Explicitly `| undefined`
     *  because it is FORWARDED to MdBlocks — see CodeBlock.startLine. */
    codeMaxLines?: number | undefined;
    /** Instrument-card context: no bleed past the card. */
    dense?: boolean;
  } = $props();

  const parsed = $derived(parseProseBounded(text, MAX_MARKDOWN_CHARS));
</script>

<div class="prose" class:dense data-untrusted>
  {#if parsed.overLimit}
    <!-- The markdown was REFUSED, on purpose, by a budget this product set.
         That is `refused`, not `absent`: nothing is missing and nothing broke
         — a decision was taken, and the grammar has a word for that which the
         one-ink `.absence` rule could not express. -->
    <Answer
      answer={refused(
        `rendered as plain text — ${text.length.toLocaleString("en-US")} characters is past the ${MAX_MARKDOWN_CHARS.toLocaleString("en-US")}-character markdown budget`,
      )}
    />
  {/if}
  <MdBlocks blocks={parsed.blocks} {codeMaxLines} {dense} />
</div>

<style>
  .prose {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--prose-gap);
    /* The outer bound only — the reading measure is applied per prose block
     * (MdBlocks), so instrumental blocks can bleed past it up to here. */
    max-width: var(--rail);
    min-width: 0;
    font-size: var(--f-prose-size);
    line-height: var(--f-prose-lh);
    color: var(--ink-1);
    overflow-wrap: anywhere;
  }
  .dense {
    max-width: 100%;
    font-size: var(--f-ui-size);
  }
</style>
