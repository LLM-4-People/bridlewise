<script lang="ts">
  /**
   * Inline markdown nodes → DOM. Recursive (emphasis nests).
   *
   * Every leaf is interpolated with `{...}`, so the browser never parses
   * model output as markup. There is no {@html} here and there cannot be.
   *
   * DEFENCE IN DEPTH on links: the parser already demoted unsafe schemes to
   * plain text, and this renderer re-checks with the SAME allowlist before
   * emitting an anchor. A link node that somehow carries `javascript:` (a
   * parser regression, a hand-built node in a test) renders as its words
   * with no anchor at all. The guard test mutates exactly this path.
   *
   * `rel="noopener noreferrer"` on every external anchor: model output is
   * untrusted, so a target it names must not get a handle on our window or
   * our URL.
   */
  import { isSafeLinkTarget, type InlineNode } from "../../../shared/markdown.ts";
  import Self from "./MdInline.svelte";

  let { nodes }: { nodes: readonly InlineNode[] } = $props();

  /** The render-time half of the link allowlist. */
  function anchorHref(href: string): string | undefined {
    return isSafeLinkTarget(href) ? href : undefined;
  }
</script>

{#each nodes as node, i (i)}{#if node.type === "text"}{node.text}{:else if node.type === "code"}<code
      class="inline-code">{node.code}</code>{:else if node.type === "bold"}<strong><Self
        nodes={node.children}
      /></strong>{:else if node.type === "italic"}<em><Self nodes={node.children} /></em
    >{:else if node.type === "strike"}<s><Self nodes={node.children} /></s
    >{:else if node.type === "link"}{#if anchorHref(node.href) !== undefined}<a
        href={anchorHref(node.href)}
        target="_blank"
        rel="noopener noreferrer">
        <Self nodes={node.children} /></a
      >{:else}<Self nodes={node.children} />{/if}{/if}{/each}

<style>
  .inline-code {
    font-family: var(--face-mono);
    font-size: var(--f-code-inline-scale);
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: 0 var(--sp-1);
    color: var(--ink-1);
    overflow-wrap: break-word;
  }
  a {
    color: var(--beam);
    text-decoration-thickness: var(--hairline-w);
    text-underline-offset: var(--sp-0);
  }
  a:hover {
    text-decoration-thickness: var(--rule-w);
  }
  strong {
    font-weight: var(--f-heading-weight);
    color: var(--ink-1);
  }
  s {
    color: var(--ink-3);
  }
</style>
