<script lang="ts">
  /**
   * A tool's RECORDED output, rendered in the shape the data actually has.
   *
   * classifyOutput (shapes.ts) does the deciding and only claims a shape
   * when the value passes a real test, so:
   *   - file content → syntax-highlighted with a number rail (and NO rail
   *     when the content already carries its own numbers — double-numbering
   *     would be a lie about the file);
   *   - command result → preserved-whitespace mono, stdout and stderr kept
   *     apart because the record kept them apart, exit code shown ONLY when
   *     the record carries one (never defaulted to 0);
   *   - search results → a real list of path + line + match;
   *   - structured data → a collapsible tree in recorded key order;
   *   - anything else → the string, verbatim, whitespace preserved.
   *
   * A `read_file` that failed and returned an error object renders as that
   * object, not as fake file content: the branch is chosen by the value, not
   * by the tool's name alone.
   *
   * Long output FOLDS with the remainder named ("N more lines") — never a
   * silent cut, never an unexplained "…".
   *
   * IT DOES NOT KNOW HOW THE CALL WENT, deliberately. This component used to
   * take an `error` flag and tint its whole body alarm-red when the call had
   * failed. That made a failure's output cell a visibly different object from
   * a success's, which is the asymmetry the user asked to be rid of ("success
   * and error tool call should carry the same amount of details"). Status is
   * reported by the status affordances that BOTH outcomes wear — the chip and
   * the beat's leading edge — so the body renders in its natural register
   * either way.
   *
   * What survives is DATA-driven, not status-driven: a non-zero exit code is
   * alarm-inked because the recorded code says so, and `stderr` is alarm-inked
   * because it is stderr — both are true of a "successful" call that wrote to
   * stderr, and neither moves when the tool's status changes.
   */
  import CodeBlock from "./CodeBlock.svelte";
  import StreamText from "./StreamText.svelte";
  import CopyButton from "./CopyButton.svelte";
  import JsonNode from "./JsonNode.svelte";
  import Prose from "./Prose.svelte";
  import { classifyOutput, foldLines, toCopyText } from "./shapes.ts";
  import { toolByName } from "../../state/tools.ts";
  import { IMAGE_MAX_BYTES } from "./render-config.ts";
  import { fileSizeText } from "../editor/file-kind.ts";
  import Answer from "../response/Answer.svelte";
  import { refused } from "../response/grammar.ts";

  let {
    name,
    input,
    output,
    maxLines,
  }: {
    /** The tool's registry name — the strongest real signal about the shape. */
    name: string;
    /** The tool's recorded input (used only to read a path it already names). */
    input: unknown;
    output: unknown;
    /** Fold past this many lines. */
    maxLines: number;
  } = $props();

  /**
   * The shape the tool's registration declared (file / command / search),
   * read off the served manifest — the registry's own answer, so the renderer
   * never re-derives it from the tool's name.
   */
  const declared = $derived(toolByName.get().get(name)?.outputShape);
  const shape = $derived(classifyOutput(input, output, declared));

  let textExpanded = $state(false);

  /** Plain-text bodies (command output, unclassified text) fold here. */
  function fold(text: string) {
    return foldLines(text.split("\n"), textExpanded ? Number.POSITIVE_INFINITY : maxLines);
  }

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
</script>

{#if shape.kind === "file"}
  <CodeBlock
    code={shape.text}
    lang={shape.grammar ?? ""}
    startLine={shape.addLineNumbers ? 1 : undefined}
    {maxLines}
    dense
  />
{:else if shape.kind === "command"}
  <div class="cmd reveal-on-hover">
    {#if shape.view.exitCode !== undefined}
      <div class="exit engraved" class:bad={shape.view.exitCode !== 0}>
        exit {shape.view.exitCode}
      </div>
    {/if}
    {#if shape.view.text !== undefined}
      {@const f = fold(shape.view.text)}
      <pre class="stream"><StreamText text={f.shown.join("\n")} /></pre>
      {#if f.hidden > 0}
        <button class="more" type="button" onclick={() => (textExpanded = true)}>
          {fmt(f.hidden)} more {f.hidden === 1 ? "line" : "lines"}
        </button>
      {/if}
    {/if}
    {#if shape.view.stdout !== undefined && shape.view.stdout.length > 0}
      {@const f = fold(shape.view.stdout)}
      <div class="stream-label engraved">stdout</div>
      <pre class="stream"><StreamText text={f.shown.join("\n")} /></pre>
      {#if f.hidden > 0}
        <button class="more" type="button" onclick={() => (textExpanded = true)}>
          {fmt(f.hidden)} more {f.hidden === 1 ? "line" : "lines"}
        </button>
      {/if}
    {/if}
    {#if shape.view.stderr !== undefined && shape.view.stderr.length > 0}
      {@const f = fold(shape.view.stderr)}
      <div class="stream-label engraved alarm-ink">stderr</div>
      <pre class="stream alarm-ink"><StreamText text={f.shown.join("\n")} /></pre>
      {#if f.hidden > 0}
        <button class="more" type="button" onclick={() => (textExpanded = true)}>
          {fmt(f.hidden)} more {f.hidden === 1 ? "line" : "lines"}
        </button>
      {/if}
    {/if}
    <div class="copy-slot"><CopyButton text={toCopyText(output)} what="copy this output" /></div>
  </div>
{:else if shape.kind === "search"}
  <div class="hits reveal-on-hover">
    <div class="hits-head engraved">
      <span>{fmt(shape.hits.length)} {shape.hits.length === 1 ? "result" : "results"}</span>
      <span class="spacer"></span>
      <CopyButton text={toCopyText(output)} what="copy these results" />
    </div>
    <ol class="hit-list">
      {#each shape.hits.slice(0, textExpanded ? shape.hits.length : maxLines) as hit, i (i)}
        <li class="hit">
          <span class="hit-path trunc">{hit.path}</span>
          {#if hit.line !== undefined}<span class="hit-line">{hit.line}</span>{/if}
          {#if hit.text.length > 0}<span class="hit-text">{hit.text}</span>{/if}
        </li>
      {/each}
    </ol>
    {#if !textExpanded && shape.hits.length > maxLines}
      <button class="more" type="button" onclick={() => (textExpanded = true)}>
        {fmt(shape.hits.length - maxLines)} more
        {shape.hits.length - maxLines === 1 ? "result" : "results"}
      </button>
    {/if}
  </div>
{:else if shape.kind === "image"}
  <!-- THE IMAGE THE CALL RETURNED. The classifier already decided the budget:
       `src` is null exactly when the decoded payload is past IMAGE_MAX_BYTES,
       so this branch cannot render what the budget refused — and the refusal
       is stated through the grammar, naming both numbers, never a silent
       nothing. The copy button still carries the recorded value verbatim
       either way. -->
  <div class="image reveal-on-hover">
    <div class="copy-slot"><CopyButton text={toCopyText(output)} what="copy this image's data" /></div>
    {#if shape.image.src !== null}
      <img
        class="shot"
        src={shape.image.src}
        alt={`the ${shape.image.mediaType} image this call returned (${fileSizeText(shape.image.bytes)})`}
      />
      <div class="image-meta engraved">{shape.image.mediaType} · {fileSizeText(shape.image.bytes)}</div>
    {:else}
      <Answer
        answer={refused(
          `not rendered — ${fileSizeText(shape.image.bytes)} is past the ${fileSizeText(IMAGE_MAX_BYTES)} inline-image budget`,
        )}
      />
    {/if}
  </div>
{:else if shape.kind === "json"}
  <div class="json reveal-on-hover">
    <div class="copy-slot"><CopyButton text={toCopyText(output)} what="copy this output" /></div>
    <JsonNode value={shape.value} />
  </div>
{:else if shape.kind === "markdown"}
  <!-- A MARKDOWN DOCUMENT, rendered by the one prose owner. The shape is
       claimed only for leftover text that carries two distinct block-level
       constructs (shapes.ts::looksLikeMarkdown states the rule) — command
       stdout structurally never reaches it. Prose brings its own budget
       (parseProseBounded), so a hostile document refuses through the grammar
       there; the copy button carries the recorded string verbatim. -->
  <div class="md reveal-on-hover">
    <div class="copy-slot"><CopyButton text={shape.text} what="copy this output" /></div>
    <Prose text={shape.text} codeMaxLines={maxLines} dense />
  </div>
{:else if shape.kind === "text"}
  {@const f = fold(shape.text)}
  <div class="plain reveal-on-hover">
    <div class="copy-slot"><CopyButton text={shape.text} what="copy this output" /></div>
    <pre class="stream"><StreamText text={f.shown.join("\n")} /></pre>
    {#if f.hidden > 0}
      <button class="more" type="button" onclick={() => (textExpanded = true)}>
        {fmt(f.hidden)} more {f.hidden === 1 ? "line" : "lines"}
      </button>
    {/if}
  </div>
{/if}

<style>
  .cmd,
  .json,
  .plain,
  .hits,
  .md,
  .image {
    position: relative;
    min-width: 0;
  }
  /* The picture at its own size, never past the cell: width is bounded by
   * the card, height by the same cap every other output body honours. */
  .shot {
    display: block;
    max-width: 100%;
    max-height: var(--cell-max-h);
    height: auto;
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
  }
  .image-meta {
    color: var(--ink-3);
    margin-top: var(--sp-1);
  }
  .copy-slot {
    position: absolute;
    top: 0;
    right: 0;
    z-index: 1;
  }
  .exit {
    display: inline-block;
    color: var(--ok);
    font-variant-numeric: tabular-nums;
    margin-bottom: var(--sp-1);
  }
  .exit.bad {
    color: var(--alarm);
  }
  .stream-label {
    color: var(--ink-3);
    margin-top: var(--sp-1);
  }
  /* Command output WRAPS: a shell's column carries no structural meaning,
   * and a wrapped line still reads. (Code and diffs scroll instead — see
   * CodeBlock / UnifiedDiff.) */
  .stream {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-code-size);
    line-height: var(--f-code-lh);
    color: var(--ink-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: var(--cell-max-h);
    overflow-y: auto;
    tab-size: 2;
  }
  .alarm-ink {
    color: var(--alarm);
  }
  .hits-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    min-height: var(--hit-min);
  }
  .spacer {
    flex: 1;
  }
  .hit-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    max-height: var(--cell-max-h);
    overflow-y: auto;
  }
  .hit {
    display: flex;
    gap: var(--sp-2);
    align-items: baseline;
    padding: var(--sp-0) 0;
    border-bottom: var(--hairline-w) solid var(--line-1);
    min-width: 0;
  }
  .hit:last-child {
    border-bottom: none;
  }
  .hit-path {
    color: var(--ink-1);
    flex: none;
    max-width: var(--verbs-max-w);
  }
  .hit-line {
    color: var(--ink-4);
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .hit-text {
    color: var(--ink-3);
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .more {
    appearance: none;
    background: none;
    border: none;
    border-bottom: var(--hairline-w) dotted var(--line-2);
    padding: 0;
    margin-top: var(--sp-1);
    min-height: var(--hit-min);
    padding: 0 var(--sp-1);
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    letter-spacing: var(--f-micro-track);
    color: var(--ink-3);
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .more:hover {
    color: var(--ink-1);
  }
</style>
