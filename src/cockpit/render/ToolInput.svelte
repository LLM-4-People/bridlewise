<script lang="ts">
  /**
   * A tool's RECORDED input, rendered so a call reads like an invocation
   * rather than a debug dump — while keeping every argument reachable.
   *
   * This keeps the v2.2 direction (args are readable `key: value` rows, not
   * a raw JSON blob) and adds what a web UI can do that a terminal cannot:
   *   - a nested object or array becomes a COLLAPSIBLE tree instead of a
   *     one-line JSON.stringify that has to be read by counting braces;
   *   - a multi-line string argument (file content, a patch, a script)
   *     becomes a real code block — syntax-highlighted using the language
   *     the call's OWN `path` argument implies, folded with the remainder
   *     named;
   *   - an argument that genuinely parses as a unified diff renders as a
   *     diff. That branch is taken only when parsing actually yields hunks,
   *     so a key merely NAMED "patch" that holds prose stays prose.
   *
   * Nothing is reformatted: strings are shown as recorded (whitespace
   * included), key order is the recorded order, and no argument is hidden.
   */
  import CodeBlock from "./CodeBlock.svelte";
  import JsonNode from "./JsonNode.svelte";
  import UnifiedDiff from "./UnifiedDiff.svelte";
  import { parseUnifiedDiff } from "./diff.ts";
  import { grammarForPath } from "./highlight.ts";
  import { inputPath, jsonKindOf } from "./shapes.ts";
  import { isRecord } from "../../state/coverage.ts";

  let {
    input,
    maxLines,
  }: {
    input: unknown;
    /** Fold long string arguments past this many lines. */
    maxLines: number;
  } = $props();

  /** Top-level rows when the input is a plain object; null otherwise. */
  const rows = $derived(
    isRecord(input) && !Array.isArray(input) ? Object.entries(input) : null,
  );

  /** The language implied by the call's own path argument (may be null). */
  const pathLang = $derived.by(() => {
    const p = inputPath(input);
    return p === null ? "" : (grammarForPath(p) ?? "");
  });

  /** Keys whose value we will TRY to parse as a patch (verified before use). */
  const PATCH_KEYS: ReadonlySet<string> = new Set(["patch", "diff", "unified_diff", "unifiedDiff"]);

  /** A parsed patch for this row, or null when it does not really parse. */
  function asPatch(key: string, value: unknown) {
    if (!PATCH_KEYS.has(key) || typeof value !== "string" || value.length === 0) return null;
    const parsed = parseUnifiedDiff(value);
    return parsed.empty ? null : parsed;
  }

  function isMultiline(v: unknown): v is string {
    return typeof v === "string" && v.includes("\n");
  }
</script>

{#if rows !== null && rows.length > 0}
  <dl class="args">
    {#each rows as [key, value] (key)}
      {@const patch = asPatch(key, value)}
      <dt>{key}</dt>
      <dd>
        {#if patch !== null}
          <UnifiedDiff parsed={patch} patch={value as string} showPaths={true} showCounts={true} />
        {:else if isMultiline(value)}
          <CodeBlock code={value} lang={pathLang} {maxLines} dense />
        {:else if typeof value === "string"}
          <span class="str">{value}</span>
        {:else if jsonKindOf(value) === "object" || jsonKindOf(value) === "array"}
          <JsonNode {value} />
        {:else if value === null}
          <span class="lit">null</span>
        {:else}
          <span class="lit">{String(value)}</span>
        {/if}
      </dd>
    {/each}
  </dl>
{:else if typeof input === "string"}
  {#if input.includes("\n")}
    <CodeBlock code={input} lang="" {maxLines} dense />
  {:else}
    <span class="str">{input}</span>
  {/if}
{:else if input !== undefined && input !== null}
  <JsonNode value={input} />
{/if}

<style>
  .args {
    margin: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-1) var(--sp-3);
    align-items: baseline;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  dt {
    color: var(--ink-3);
    white-space: nowrap;
  }
  dt::after {
    content: ":";
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  .str {
    color: var(--ink-1);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  .lit {
    color: var(--syn-number);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
</style>
