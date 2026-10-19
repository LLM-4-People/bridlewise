<script lang="ts">
  /**
   * ONE strip item's REAL body (§3.4): the words the next reply will
   * actually carry for this item, read from `run.composeItem`.
   *
   * WHY THIS EXISTS. The strips read serves a name and a token cost, which
   * is everything a bar needs and nothing a reader wants: `[view]` could
   * only ever repeat the row. A context desk whose whole promise is "see
   * exactly what you are about to send" has to be able to show the text.
   *
   * WHAT IT WILL AND WILL NOT SHOW:
   *   - the SERVED body, or an honest absence. There is no placeholder
   *     body, no summary standing in for text that failed to load, and no
   *     "(empty)" where the server said nothing: `itemBodyViolations`
   *     (desk-data) is the mechanical statement of that rule;
   *   - the body renders in the shape it really has: prose as prose, a
   *     turn's tool calls as the structure they are, a tool's answer as
   *     data when it is data and as source when it is not. Same renderers
   *     the FLOW uses, so one thing looks like itself everywhere;
   *   - long bodies FOLD with the remainder counted ("N more lines"), never
   *     a silent cut. When the server itself withheld characters at its
   *     payload ceiling, that count is printed too: a cut nobody can see
   *     is the one thing this surface must never do.
   *
   * ABSENCE-FIRST (§1.5): the caller has already painted this item's name
   * and cost from the strips read. This fills in underneath and nothing
   * above it moves when the body lands.
   */
  import Answer from "../response/Answer.svelte";
  import { absent, pending } from "../response/grammar.ts";
  import CodeBlock from "../render/CodeBlock.svelte";
  import Prose from "../render/Prose.svelte";
  import ToolInput from "../render/ToolInput.svelte";
  import { foldLines } from "../render/shapes.ts";
  import { SCOPE_BODY_FOLD_LINES } from "./desk-config.ts";
  import { decodeToolCalls, fmtTokens, type ChannelId } from "./desk-data.ts";
  import { itemDetailLoads, itemLoadKey, requestItemDetail } from "./desk-feed.ts";

  let {
    chatId,
    channel,
    itemId,
  }: { chatId: string; channel: ChannelId; itemId: string } = $props();

  const loads = itemDetailLoads;

  const key = $derived(itemLoadKey(chatId, channel, itemId));
  const load = $derived($loads[key] ?? null);

  $effect(() => {
    return requestItemDetail(chatId, channel, itemId);
  });

  /** Which parts the reader has opened past the fold. */
  let unfolded = $state<Record<number, true>>({});
  // A different item is a different body: an old part's fold state must not
  // decide how much of a new part is shown.
  $effect(() => {
    void key;
    unfolded = {};
  });

  function fold(text: string, open: boolean) {
    return foldLines(
      text.split("\n"),
      open ? Number.POSITIVE_INFINITY : SCOPE_BODY_FOLD_LINES,
    );
  }

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
</script>

<div class="item-body">
  {#if load === null || load.kind === "pending"}
    <Answer answer={pending("reading the words this carries")} />
  {:else if load.kind === "absent"}
    <Answer answer={absent(`not readable right now: ${load.reason}`)} />
  {:else}
    {@const view = load.view}
    <p class="origin">{view.origin}</p>

    {#if view.parts.length === 0}
      <Answer answer={absent(view.absence ?? "this carries no text into the next reply")} />
    {:else}
      {#each view.parts as part, i (i)}
        {@const calls = part.field === "tool_calls" ? decodeToolCalls(part.text) : null}
        <section class="part">
          {#if view.parts.length > 1 || part.field === "tool_calls"}
            <p class="part-cap engraved">
              {part.role}{#if part.field === "tool_calls"} · the calls it makes{/if}
            </p>
          {/if}
          {#if calls !== null}
            <!-- Each call through the render layer's own tool-input renderer,
                 so a call reads the same here as it does in the FLOW. -->
            {#each calls as call, c (c)}
              <div class="call">
                <span class="call-name">{call.name}</span>
                <ToolInput input={call.args} maxLines={SCOPE_BODY_FOLD_LINES} />
              </div>
            {/each}
          {:else if part.role === "tool" || part.field === "tool_calls" || part.field === "schema"}
            <CodeBlock code={part.text} maxLines={SCOPE_BODY_FOLD_LINES} dense />
          {:else}
            {@const f = fold(part.text, unfolded[i] === true)}
            <Prose text={f.shown.join("\n")} codeMaxLines={SCOPE_BODY_FOLD_LINES} dense />
            {#if f.hidden > 0}
              <button
                class="verb"
                data-verb-id="desk.body/expand"
                onclick={() => (unfolded = { ...unfolded, [i]: true })}
              >{fmt(f.hidden)} more {f.hidden === 1 ? "line" : "lines"}</button>
            {/if}
          {/if}
        </section>
      {/each}
    {/if}

    <p class="foot">
      {fmtTokens(view.tokens)} tok of the next reply{#if view.withheldChars > 0}
        · {fmt(view.withheldChars)} more characters are in what gets sent but past
        this view's size ceiling{/if}
    </p>
  {/if}
</div>

<style>
  .item-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-2) 0 var(--sp-3) var(--sp-3);
    border-left: var(--hairline-w) solid var(--line-2);
    margin-left: var(--sp-1);
    min-width: 0;
  }
  .origin {
    margin: 0;
    font-size: var(--f-micro-size);
    color: var(--ink-3);
  }
  .part {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }
  .part-cap {
    margin: 0;
  }
  .call {
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
    min-width: 0;
  }
  .call-name {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-1);
  }
  /* Chrome is `.verb`. Layout: the fold chip sits under its part. */
  .part > .verb {
    align-self: flex-start;
  }
  .foot {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    color: var(--ink-4);
  }
</style>
