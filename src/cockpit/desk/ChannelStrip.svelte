<script lang="ts">
  /**
   * One CHANNEL STRIP of the open desk (§3.4): a context source of the
   * NEXT turn, mixing-desk style: engraved name, MEASURED bar (share of the
   * next composition: the fraction comes from desk-data `stripsFrom`, i.e.
   * served tokens over served total, nothing else), measured token count,
   * expandable items, and the real composition verbs:
   *
   *   [view]  → the SCOPE with the served item(s);
   *   [pin]   → run.compose/pin   (memories: always include);
   *   [mute]  → run.compose/mute  (item or channel: out of the next turn);
   *   [unmute] → run.compose/unmute (the way back: §3.4: no one-way verbs);
   *   HISTORY → the draggable trim handle, numbered in the FULL saved
   *             conversation's turns (the numbering the trim action
   *             consumes: the shown number IS the sent number).
   *
   * Acts acknowledge optimistically (<100ms: the pending mark is
   * synchronous) and CONFIRM from the forced re-read (desk-feed): the bar
   * and counts only ever move because a read moved them.
   */
  import type { ShellApi } from "../shell/contract.ts";
  import { chordLabel } from "../shell/chords.ts";
  // §6.2: a planted head makes the cockpit read-only. Every composition verb
  // here writes, so every one of them states that reason on itself rather
  // than failing at the Broker after the click.
  import { isPastView, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import {
    fmtPercent,
    fmtTokens,
    relabelHistoryItem,
    type ComposeSettingsView,
    type StripItem,
    type StripView,
    type TrimNumbering,
  } from "./desk-data.ts";
  import {
    actFailures,
    actKey,
    muteChannel,
    muteMemoryItem,
    pendingActs,
    pinMemory,
    setTrim,
    unmuteChannel,
    unmuteMemoryItem,
    unpinMemory,
  } from "./desk-feed.ts";
  import ChannelScope from "./ChannelScope.svelte";
  import Answer from "../response/Answer.svelte";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";
  import { absent } from "../response/grammar.ts";

  let {
    shell = null,
    chatId,
    strip,
    settings,
    asOf,
    numbering = null,
  }: {
    shell?: ShellApi | null;
    chatId: string;
    strip: StripView;
    settings: ComposeSettingsView;
    /** Epoch ms of the read this strip renders (§1.1). */
    asOf: number;
    /** History only: the trim numbering (desk-data owns the math). */
    numbering?: TrimNumbering | null;
  } = $props();

  // Svelte auto-subscription over the nanostores atoms (store contract).
  const pending = pendingActs;
  const failures = actFailures;

  let expanded = $state(false);
  let previousTokens: number | null = null;
  const tokenMotion = $derived.by((): MovesParam => {
    const next = strip.channel.tokens, previous = previousTokens; previousTokens = next;
    return previous !== null && previous !== next ? { motion: "arrive", cause: becauseChanged("context for the next turn", previous, next) } : null;
  });

  const isMemories = $derived(strip.channel.id === "memories");
  const isHistory = $derived(strip.channel.id === "history");
  const isToolResults = $derived(strip.channel.id === "toolResults");
  const channelKey = $derived(actKey("compose", `channel:${strip.channel.id}`));
  const channelMuted = $derived(settings.mutedChannels.includes(strip.channel.id));

  const items = $derived(
    numbering !== null
      ? strip.channel.items.map((i) => relabelHistoryItem(i, numbering))
      : strip.channel.items,
  );

  function itemKey(item: StripItem): string {
    return actKey("compose", `memories:${item.id}`);
  }

  function openChannelScope(focusItemId: string | null): void {
    if (shell === null) return;
    shell.openScope({
      title: strip.name,
      component: ChannelScope,
      props: {
        chatId,
        channel: strip.channel.id,
        name: strip.name,
        items,
        totalTokens: strip.channel.tokens,
        asOf,
        focusItemId,
        pinnedIds: settings.pinnedMemoryIds,
        mutedIds: settings.mutedMemoryIds,
      },
    });
  }

  // ── Trim handle (history only): shown number IS the sent number ────────
  const kApply = chordLabel({ key: "Enter" });
  let draft = $state<number | null>(null);
  const trimValue = $derived(
    numbering === null ? null : (draft ?? numbering.current),
  );
  let trackEl = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);

  const trimPos = $derived.by(() => {
    if (numbering === null || trimValue === null) return 0;
    const span = numbering.max - numbering.min;
    return span <= 0 ? 0 : (trimValue - numbering.min) / span;
  });

  function clampTrim(v: number): number {
    if (numbering === null) return v;
    return Math.min(numbering.max, Math.max(numbering.min, v));
  }

  function commitTrim(): void {
    if (numbering === null || draft === null) return;
    const value = draft;
    draft = null;
    if (value === numbering.current) return;
    // The number shown on the handle is EXACTLY the number sent (§3.4).
    void setTrim(chatId, value);
  }

  function onTrimKeydown(ev: KeyboardEvent): void {
    // `aria-disabled` tells assistive tech; this is what makes it TRUE. The
    // trim track is a div wearing a slider role, and a div has no `disabled`
    // attribute to lean on: so the handlers themselves have to refuse while
    // the cockpit is read-only.
    if (numbering === null || past) return;
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
      ev.preventDefault();
      draft = clampTrim((trimValue ?? numbering.current) + 1);
    } else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
      ev.preventDefault();
      draft = clampTrim((trimValue ?? numbering.current) - 1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      commitTrim();
    } else if (ev.key === "Escape" && draft !== null) {
      ev.preventDefault();
      ev.stopPropagation();
      draft = null;
    }
  }

  function valueFromPointer(ev: PointerEvent): number {
    if (numbering === null || trackEl === null) return numbering?.current ?? 1;
    const rect = trackEl.getBoundingClientRect();
    const f = rect.width > 0 ? (ev.clientX - rect.left) / rect.width : 0;
    return clampTrim(numbering.min + Math.round(f * (numbering.max - numbering.min)));
  }

  function onTrackPointerDown(ev: PointerEvent): void {
    if (numbering === null || past) return;
    dragging = true;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    draft = valueFromPointer(ev);
  }
  function onTrackPointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    draft = valueFromPointer(ev);
  }
  function onTrackPointerUp(): void {
    if (!dragging) return;
    dragging = false;
    commitTrim();
  }

  const PCT = 100;

  /** True while the cockpit is showing a past instant: no writes possible. */
  const past = $derived($isPastView);
</script>

<div class="strip" data-channel={strip.channel.id} data-empty={strip.channel.tokens === 0} data-muted={channelMuted} use:moves={tokenMotion}>
  <div class="row">
    <button
      class="name verb bare disclose"
      data-verb-id="desk.strip/expand"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    ><span class="disclosure-mark" aria-hidden="true"></span><span class="channel-name"><strong>{strip.name}</strong><span class="tokens">{strip.channel.tokens === 0 ? "No tokens" : `${fmtTokens(strip.channel.tokens)} tok`}</span></span></button>
    <div
      class="tick-track"
      role="img"
      aria-label="{strip.name}: {fmtTokens(strip.channel.tokens)} tokens: {fmtPercent(strip.fraction)} of the next turn"
    >
      <div class="tick-fill" style:width="{strip.fraction * PCT}%"></div>
    </div>
    <span class="verbs">
      <!-- THE CHANNEL'S `[view]` CHIP IS GONE.
           THE USER'S DECISION, VERBATIM: "remove the view buttons in the
           desk, just the clickable entries is enough."
           This row was already a click path: its name button opens the
           channel and lists what it is actually serving: so a `[view]` chip
           beside it was a second way to ask the same question, landing on a
           different surface. One click, one outcome: the name opens the
           channel here, and each entry inside opens its own real text. -->
      {#if isMemories || isToolResults}
        <!-- Two-way (§3.4: no one-way verbs: the same shape pin/unpin
             takes): once muted, the control BECOMES `unmute` rather than
             sitting disabled describing the action it can no longer
             perform. The unmute's own title states the expiry rule the
             mute's window follows. -->
        <button
          class="verb state-control"
          data-verb-id={channelMuted ? "run.compose/unmute" : "run.compose/mute"}
          role="switch" aria-checked={!channelMuted} aria-label={`Include ${strip.name} in the next turn`}
          aria-busy={$pending[channelKey] !== undefined}
          disabled={past}
          aria-disabled={past || $pending[channelKey] !== undefined}
          title={past ? PAST_VIEW_ACT_REASON : channelMuted
            ? "muted next turn: puts this channel back in; the mute would have lifted at the next run anyway"
            : "leaves this whole channel out of the next reply: pinned items stay included"}
          onclick={() => {
            if (past || $pending[channelKey] !== undefined) return;
            void (channelMuted
              ? unmuteChannel(chatId, strip.channel.id as "memories" | "toolResults")
              : muteChannel(chatId, strip.channel.id as "memories" | "toolResults"));
          }}
        ><span class="state-path" aria-hidden="true"></span></button>     {/if}
    </span>
  </div>
  {#if $pending[channelKey] !== undefined}
    <p class="note" data-note="live">{$pending[channelKey]}</p>
  {:else if $failures[channelKey] !== undefined}
    <p class="note" data-note="fail">{$failures[channelKey]}</p>
  {/if}

  {#if isHistory && numbering !== null}
    <div class="trim">
      <span class="engraved">Trim point ▸ turn {trimValue}</span>
      <div
        class="trim-track"
        bind:this={trackEl}
        data-verb-id="run.compose/trim"
        role="slider"
        tabindex={past ? -1 : 0}
        aria-disabled={past}
        title={past ? PAST_VIEW_ACT_REASON : undefined}
        aria-label="trim point: the model stops seeing conversation before this turn of the saved conversation, from the next reply"
        aria-valuemin={numbering.min}
        aria-valuemax={numbering.max}
        aria-valuenow={trimValue}
        aria-valuetext="sends from turn {trimValue} of the saved conversation"
        onkeydown={onTrimKeydown}
        onpointerdown={onTrackPointerDown}
        onpointermove={onTrackPointerMove}
        onpointerup={onTrackPointerUp}
        onpointercancel={() => (dragging = false)}
      >
        <div class="trim-handle" style:left="{trimPos * PCT}%"></div>
      </div>
      {#if draft !== null && draft !== numbering.current}
        <span class="note" data-note="live">sends from turn {draft}: {kApply} applies</span>
      {:else if $pending[actKey("compose", "trim")] !== undefined}
        <span class="note" data-note="live">{$pending[actKey("compose", "trim")]}</span>
      {:else if $failures[actKey("compose", "trim")] !== undefined}
        <span class="note" data-note="fail">{$failures[actKey("compose", "trim")]}</span>
      {:else if numbering.offset > 0}
        <button
          class="verb"
          data-verb-id="run.compose/trim"
          disabled={past}
          title={past
            ? PAST_VIEW_ACT_REASON
            : "sends the whole saved conversation again from the next reply"}
          onclick={() => void setTrim(chatId, 1)}
        >Send from turn 1 again</button>
      {/if}
    </div>
  {/if}

  {#if expanded}
    {#if items.length === 0}
      <!-- The absence the removed `[view]` scope used to state. Losing the
           chip must not lose the sentence: a channel that is serving tokens
           but naming no items, or serving nothing at all, says so here (§1.1)
           rather than opening as a blank list. -->
      <div class="stated"><Answer answer={absent("this channel carries nothing for the next reply.")} /></div>
    {/if}
    <ul class="items">
      {#each items as item (item.id)}
        {@const key = itemKey(item)}
        {@const pinned = settings.pinnedMemoryIds.includes(item.id)}
        {@const muted = settings.mutedMemoryIds.includes(item.id)}
        <li class="item">
          <!-- MOUSE-FIRST (v2.1): the ROW opens this item's real text, not a
               chip on it. The chevron and the row's own hairline are drawn
               at rest, so it reads as openable before the pointer arrives. -->
          <button
            class="item-row"
            data-verb-id="desk.scope/view"
            onclick={() => openChannelScope(item.id)}
            disabled={shell === null}
            title={shell === null
              ? "this mount has no scope surface"
              : "show the words this puts into the next reply"}
          >
            <span class="item-label trunc" class:muted-label={muted}>{item.label}</span>
            <span class="item-tokens">{fmtTokens(item.tokens)} tok</span>
            <span class="open-mark" aria-hidden="true">▸</span>
          </button>
          <span class="verbs">
            {#if isMemories}
              <!-- A pin can be taken back (§3.4: no one-way verbs): the
                   pinned item's control BECOMES `unpin` rather than sitting
                   there disabled saying "pinned". -->
              {#if pinned}
                <button
                  class="verb"
                  data-verb-id="run.compose/unpin"
                  disabled={past || $pending[key] !== undefined}
                  title={past ? PAST_VIEW_ACT_REASON : "stops always including this memory: it can still be recalled on its own"}
                  onclick={() => void unpinMemory(chatId, item.id)}
                >Unpin</button>
              {:else}
                <button
                  class="verb"
                  data-verb-id="run.compose/pin"
                  disabled={past || $pending[key] !== undefined}
                  title={past ? PAST_VIEW_ACT_REASON : "always include this memory in this conversation's replies, even when recall would miss it"}
                  onclick={() => void pinMemory(chatId, item.id)}
                >Pin</button>
              {/if}
              <!-- Two-way, the same shape pin/unpin takes above: a muted
                   item's control BECOMES `unmute`: no dead verb wearing a
                   title for a thing it can no longer do. -->
              {#if muted}
                <button
                  class="verb"
                  data-verb-id="run.compose/unmute"
                  disabled={past || $pending[key] !== undefined}
                  title={past ? PAST_VIEW_ACT_REASON : "muted next turn: puts this memory back in; the mute would have lifted at the next run anyway"}
                  onclick={() => void unmuteMemoryItem(chatId, item.id)}
                >Unmute</button>
              {:else}
                <button
                  class="verb"
                  data-verb-id="run.compose/mute"
                  disabled={past || $pending[key] !== undefined}
                  title={past ? PAST_VIEW_ACT_REASON : "leaves this memory out of the next reply"}
                  onclick={() => void muteMemoryItem(chatId, item.id)}
                >Mute</button>
              {/if}
            {/if}
          </span>
          {#if $pending[key] !== undefined}
            <span class="note" data-note="live">{$pending[key]}</span>
          {:else if $failures[key] !== undefined}
            <span class="note" data-note="fail">{$failures[key]}</span>
          {/if}
        </li>
      {/each}
      {#if items.length === 0}
        <li class="item"><span class="note">nothing in this channel for the next reply</span></li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .strip {
    container-type: inline-size;
    container-name: context-control-row;
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
    padding: var(--sp-3) 0;
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    align-items: center;
    gap: var(--sp-1) var(--sp-3);
    min-height: var(--row-h);
  }
  /* Every control on the strip meets the pointer-target floor in BOTH axes
   * (--hit-min, one owner in tokens.css). The visible ink stays quiet:
   * padding does the growing, not the type. */
  .name { grid-row: 1; }
  .channel-name { display: flex; flex-direction: column; gap: var(--sp-1); }
  .channel-name strong { font-weight: var(--f-micro-weight); }
  /* Component-named (not the generic `bar`/`fill`): the desk shell sizes its
     own `.bar` for the composer row, and a scoped rule that ever slips out
     unscoped lands on every same-named class: a shared generic name is a
     collision waiting for one bad emission. */
  .tick-track {
    grid-row: 2;
    grid-column: 1 / -1;
    height: var(--gauge-bar-h);
    background: var(--line-1);
    min-width: 0;
  }
  .tick-fill {
    height: 100%;
    background: var(--accent);
  }
  .strip[data-muted="true"] .tick-fill { background: var(--warn); }
  .strip[data-empty="true"] .tokens { font-family: var(--face-sans); color: var(--ink-3); }
  .strip[data-empty="true"] .tick-track { display: none; }
  .tokens {
    grid-row: 1;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-1);
    white-space: nowrap;
  }
  .verbs {
    grid-row: 1;
    justify-content: flex-end;
  }
  /* The verb recipe is owned by tokens.css (`.cockpit .verb`). */
  .note {
    margin: 0;
    font-size: var(--f-micro-size);
    color: var(--ink-3);
  }
  /* The strip's own gutter, and nothing else. What used to live here: a
   * fourth opinion about the ink, face and slant of an absence: belongs to
   * the response grammar. */
  .stated {
    padding: var(--sp-1) var(--sp-2);
  }
  .note[data-note="live"] {
    color: var(--beam);
  }
  .note[data-note="fail"] {
    color: var(--alarm);
  }
  .trim {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--row-h);
  }
  /* The slider's HIT area is the floor while its visible ink stays a
   * 3px rail: the track is padded to --hit-min and the rail is drawn
   * inside it, so the hand gets a target the eye is not shouted at by. */
  .trim-track {
    position: relative;
    flex: 1;
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    display: flex;
    align-items: center;
    cursor: ew-resize;
    touch-action: none;
  }
  .trim-track::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: var(--tick-h);
    background: var(--line-2);
  }
  .trim-handle {
    position: absolute;
    width: var(--caret-w);
    height: calc(var(--tick-h) + var(--sp-3));
    margin-left: calc(-0.5 * var(--caret-w));
    background: var(--ink-1);
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 0 0 0 var(--sp-4);
    display: flex;
    flex-direction: column;
  }
  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--row-h);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  /* THE ROW IS THE TARGET (§ item 2). Its chevron and hairline are drawn at
   * rest: the row LOOKS openable before the pointer arrives: and hover
   * deepens what is already there rather than revealing it. */
  .item-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    appearance: none;
    background: none;
    border: none;
    border-radius: var(--radius-1);
    padding: 0 var(--sp-1);
    text-align: left;
    cursor: pointer;
  }
  .item-row:hover:not(:disabled) {
    background: var(--layer-hover);
  }
  .item-row:disabled {
    cursor: default;
  }
  .open-mark {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
  }
  .item-row:hover:not(:disabled) .open-mark {
    color: var(--ink-1);
  }
  .item-row:disabled .open-mark {
    color: var(--layer-disabled);
  }
  .item-label {
    flex: 1;
    min-width: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .muted-label {
    color: var(--ink-4);
    text-decoration: line-through;
  }
  .item-tokens {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
    white-space: nowrap;
  }
</style>
