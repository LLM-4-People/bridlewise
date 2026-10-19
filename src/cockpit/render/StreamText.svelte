<script lang="ts">
  /**
   * Plain stream text with its bare URLs walkable — the render half of
   * `linkifyStreamText` (markdown.ts, which owns the judgement: the one
   * allowlist, narrowed to http(s) for streams).
   *
   * Every segment is interpolated with `{...}` — no {@html}, ever. The
   * link's words are the raw characters, so selecting and copying the
   * stream reproduces it byte-for-byte; only the href is minted. Rendered
   * inside a `<pre>`, so the template is whitespace-tight on purpose.
   *
   * `rel="noopener noreferrer"`: a stream's content is untrusted, so a
   * target it names must not get a handle on our window or our URL.
   */
  import { isSafeLinkTarget, linkifyStreamText } from "../../../shared/markdown.ts";

  let { text }: { text: string } = $props();

  const segments = $derived(linkifyStreamText(text));

  /** DEFENCE IN DEPTH, the MdInline pattern: the segmenter already judged
   * every href through the allowlist, and this renderer re-checks with the
   * SAME allowlist before emitting an anchor. A link segment that somehow
   * carries an unsafe target renders as its words with no anchor at all. */
  function anchorHref(href: string): string | undefined {
    return isSafeLinkTarget(href) ? href : undefined;
  }
</script>

{#each segments as seg, i (i)}{#if seg.kind === "link" && anchorHref(seg.href) !== undefined}<a
      href={anchorHref(seg.href)}
      target="_blank"
      rel="noopener noreferrer">{seg.text}</a
  >{:else}{seg.text}{/if}{/each}

<style>
  a {
    color: var(--beam);
    text-decoration-thickness: var(--hairline-w);
    text-underline-offset: var(--sp-0);
  }
  a:hover {
    text-decoration-thickness: var(--rule-w);
  }
</style>
