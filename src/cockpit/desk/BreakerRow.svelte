<script lang="ts">
  /**
   * One BREAKER ROW of the open desk (§3.5): a tool of the current chat:
   *
   *   - state chip from the SERVED read (on ● / off ○ / tripped ▲): the
   *     chip never confirms from hope: a flip marks pending optimistically
   *     and the chip changes only when the forced re-read lands (desk-feed);
   *   - the standing ARM auto-trip renders on the row itself ("armed at N")
   *     beside the counts: a setting that materially changes behavior
   *     (the tool switches itself off after N failures) is not a secret the
   *     `,` sheet keeps; the row states every standing setting it owns;
   *   - real call counts + last duration + last error, folded from the
   *     ledger's recorded tool events (served by the read, never tallied
   *     client-side);
   *   - [off]/[on] via `set { at: "next-boundary" }`, the consequence ON
   *     the control; [reset]/[why] on tripped ([why] opens the RECORDED
   *     trip event in the SCOPE);
   *   - `,` on the row opens the trip-threshold setting sheet inline (the
   *     `arm` action);
   *   - the row glows ONLY while this tool's call is genuinely in flight
   *     (derived from the one run stream's store: no second stream).
   */
  import type { ShellApi } from "../shell/contract.ts";
  import { tick } from "svelte";
  // A planted head makes the whole cockpit read-only (§6.2). The Broker
  // refuses the write regardless; disabling here is what stops the control
  // from LOOKING live, and the reason travels ON it rather than in a hint
  // the user has to provoke.
  import { isPastView, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import {
    DEFAULT_TRIP_AFTER_FAILURES,
    TRIP_AFTER_MAX,
    TRIP_AFTER_MIN,
  } from "./desk-config.ts";
  import { fmtMs, type BreakerRowView } from "./desk-data.ts";
  import type { OutcomeStateId } from "../response/grammar.ts";
  import {
    actFailures,
    actKey,
    armBreaker,
    disarmBreaker,
    flipBreaker,
    pendingActs,
    resetBreaker,
  } from "./desk-feed.ts";
  import TripScope from "./TripScope.svelte";

  let {
    shell = null,
    chatId,
    row,
    executing = false,
    highlight = false,
  }: {
    shell?: ShellApi | null;
    chatId: string;
    row: BreakerRowView;
    /** True ONLY while this tool's call is genuinely in flight (the panel
     * derives it from the shared run-stream store). */
    executing?: boolean;
    /** Transient mark after a `breaker` verb jump landed on this row. */
    highlight?: boolean;
  } = $props();

  const pending = pendingActs;
  const failures = actFailures;

  const key = $derived(actKey("breaker", row.id));
  const isPending = $derived($pending[key] !== undefined);
  /** True while the cockpit is showing a past instant: no writes possible. */
  const past = $derived($isPastView);
  /** One derived pair so every verb on this row says the same thing about
   * why it is off: the past view first (it outranks a pending act: you
   * cannot act at all), then the act already in flight. */
  const actOff = $derived(past || isPending);
  const hasActivity = $derived(row.calls > 0 || row.lastMs !== undefined || row.tripAfterFailures !== undefined || executing);

  /** The §3.5 consequence, ON the control (visible while acting/hovering). */
  const CONSEQUENCE = "takes effect at the next tool decision: a call already running finishes";

  let armOpen = $state(false);
  let armValue = $state(DEFAULT_TRIP_AFTER_FAILURES);
  let rowElement: HTMLDivElement | undefined;

  function closeArm(): void {
    const focused = document.activeElement;
    const owned = focused instanceof HTMLElement && rowElement?.querySelector(".arm-sheet")?.contains(focused);
    armOpen = false;
    void tick().then(() => {
      if (owned && !focused.isConnected && document.activeElement === document.body)
        rowElement?.querySelector<HTMLButtonElement>(".tool-label")?.focus();
    });
  }

  async function reset(): Promise<void> {
    if (actOff) return;
    const focused = document.activeElement;
    const owned = focused instanceof HTMLElement && rowElement?.contains(focused);
    await resetBreaker(chatId, row.id);
    await tick();
    if (owned && !focused.isConnected && document.activeElement === document.body)
      rowElement?.querySelector<HTMLButtonElement>(".state-control")?.focus();
  }

  $effect(() => {
    // The sheet opens on the recorded threshold when one exists.
    armValue = row.tripAfterFailures ?? DEFAULT_TRIP_AFTER_FAILURES;
  });

  function onRowKeydown(ev: KeyboardEvent): void {
    if (ev.key === "," && !(ev.target instanceof HTMLInputElement)) {
      ev.preventDefault();
      ev.stopPropagation();
      armOpen = !armOpen;
    }
  }

  function clampArm(v: number): number {
    return Math.min(TRIP_AFTER_MAX, Math.max(TRIP_AFTER_MIN, Math.round(v)));
  }

  function submitArm(): void {
    if (actOff) return;
    armValue = clampArm(armValue);
    void armBreaker(chatId, row.id, armValue);
    closeArm();
  }

  function openWhy(): void {
    if (shell === null) return;
    shell.openScope({
      title: `${row.label}: why it tripped`,
      component: TripScope,
      props: { tool: row.id, lastError: row.lastError ?? null },
    });
  }

  const chip = $derived(
    row.state === "on" ? "●" : row.state === "off" ? "○" : "▲",
  );
  /** The chip's state, in the outcome axis's own words: the row's breaker
   * vocabulary mapped at the ONE door, so the chip reads the same
   * `--outcome-ink` mapping every other surface reads. `off` is an absence
   * of conduction, not a failure, so it maps to NO grammar state (the chip
   * wears the quiet fallback ink rather than asserting a measured outcome
   * nobody measured). The domain word `off` never reaches the attribute. */
  const chipState = $derived<OutcomeStateId | null>(
    row.state === "on" ? "ok" : row.state === "tripped" ? "alarm" : null,
  );
</script>

<!-- JUSTIFICATION for the two suppressions below. The row is a COMPOSITE
     WIDGET, not a passive container: it is a deliberate focus stop (the tool
     beat's `breaker` verb scrolls the desk here and focuses it, §3.5) and it
     carries the `,` setting chord ON the focused row (§2.7 home keys). A
     focusable `role="group"` owning several controls is exactly the ARIA
     shape for that, and it is keyboard-complete: Tab reaches the row, Tab
     again reaches each control, and the row states the chord in its own
     accessible name. The generic non-interactive-element rules cannot see
     the grouping, so they misfire here. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={rowElement}
  class="breaker-row"
  class:executing
  class:highlight
  data-tool={row.id}
  role="group"
  aria-label="breaker for {row.label}: press comma for its auto-trip setting"
  tabindex="0"
  onkeydown={onRowKeydown}
>
  <div class="row">
    <button class="tool-label verb bare disclose" data-verb-id="desk.arm-sheet/open" aria-expanded={armOpen}
      aria-label={`About ${row.label}`} title="What this tool does and when it stops after failures"
      onclick={() => (armOpen = !armOpen)}><strong>{row.label}</strong><span class="disclosure-mark" aria-hidden="true"></span></button>
    {#if row.state === "tripped"}
      <span class="chip" data-state={chipState}>{chip} Tripped</span>
    {:else}
      <button class="verb state-control" role="switch" aria-checked={row.state === "on"}
        aria-label={`Allow ${row.label} to run`} aria-busy={isPending}
        data-verb-id="tools.breaker/set" disabled={past} aria-disabled={actOff}
        title={past ? PAST_VIEW_ACT_REASON : CONSEQUENCE}
        onclick={() => { if (!actOff) void flipBreaker(chatId, row.id, row.state !== "on"); }}>
        <span class="state-path" aria-hidden="true"></span>
      </button>
    {/if}
    {#if hasActivity}
    <span class="counts">
      {row.calls} call{row.calls === 1 ? "" : "s"}{#if row.lastMs !== undefined}&nbsp;· last {fmtMs(row.lastMs)}{/if}
      {#if row.tripAfterFailures !== undefined}
        <span
          class="trip-fact"
          data-field="breaker-armed"
          title="an auto-trip is armed: after {row.tripAfterFailures} recorded failures in a row, the tool switches itself off at the next safe moment (the , key changes it)"
        >armed at {row.tripAfterFailures}</span>
      {/if}
      {#if executing}<span class="live-chip" title="a call is running now: from the live run stream">● running</span>{/if}
    </span>
    {/if}
    {#if row.state === "tripped"}
    <span class="verbs">
        <button
          class="verb"
          data-verb-id="tools.breaker/reset"
          disabled={past} aria-disabled={actOff}
          title={past
            ? PAST_VIEW_ACT_REASON
            : "clears the tripped state and turns the tool back on from the next tool decision; the auto-trip setting stays armed"}
          onclick={() => void reset()}
        >Reset</button>
        <button
          class="verb"
          data-verb-id="desk.scope/why"
          disabled={shell === null}
          title={shell === null ? "this mount has no scope surface" : "the recorded trip event"}
          onclick={openWhy}
        >Why</button>
    </span>
    {/if}
  </div>

  {#if row.state === "tripped" && row.lastError !== undefined}
    <p class="trip-line">{row.lastError}</p>
  {/if}
  {#if isPending}
    <p class="note" data-note="live">{$pending[key]}: {CONSEQUENCE}</p>
  {:else if $failures[key] !== undefined}
    <p class="note" data-note="fail">{$failures[key]}</p>
  {/if}

  {#if armOpen}
    {@const description = row.description ?? "This tool has no description available."}
    {@const sentenceEnd = description.indexOf(". ")}
    <div class="arm-sheet">
      <p class="tool-description">{sentenceEnd < 0 ? description : description.slice(0, sentenceEnd + 1)}</p>
      {#if sentenceEnd >= 0}
        <details class="setting-details tool-manual"><summary>Full description</summary><p class="tool-description">{description.slice(sentenceEnd + 2)}</p></details>
      {/if}
      {#if !hasActivity}<span class="counts">0 calls</span>{/if}
      <label class="engraved" for="arm-{row.id}">Auto-trip after</label>
      <input
        id="arm-{row.id}"
        class="arm-input"
        data-verb-id="tools.breaker/arm"
        type="number"
        disabled={past}
        title={past ? PAST_VIEW_ACT_REASON : undefined}
        min={TRIP_AFTER_MIN}
        max={TRIP_AFTER_MAX}
        bind:value={armValue}
        onkeydown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            submitArm();
          }
        }}
      />
      <span class="engraved">failures in a row</span>
      <button
        class="verb"
        data-verb-id="tools.breaker/arm"
        disabled={past} aria-disabled={actOff}
        title={past
          ? PAST_VIEW_ACT_REASON
          : "after this many recorded failures in a row, the tool switches itself off at the next safe moment; the trip is recorded"}
        onclick={submitArm}
      >Arm</button>
      {#if row.tripAfterFailures !== undefined}
        <button
          class="verb"
          data-verb-id="tools.breaker/disarm"
          disabled={past} aria-disabled={actOff}
          title={past
            ? PAST_VIEW_ACT_REASON
            : "removes the auto-trip setting: failures stop counting toward a trip until one is armed again; the on/off state stays as it is"}
          onclick={() => {
            if (actOff) return;
            void disarmBreaker(chatId, row.id);
            closeArm();
          }}
        >Disarm</button>
      {:else}
        <span class="note">Not armed yet</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .breaker-row {
    container-type: inline-size;
    container-name: context-control-row;
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
    padding: var(--sp-2) var(--sp-1);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  .breaker-row.executing {
    border-bottom-color: var(--beam);
    background: var(--layer-select);
  }
  .breaker-row.highlight {
    background: var(--layer-select);
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    align-items: center;
    gap: var(--sp-1) var(--sp-2);
    min-height: var(--row-h);
  }
  /* The status chip's recipe + hue are owned by tokens.css (`.cockpit .chip`
   * reading `--outcome-ink`); the chip's `data-state` is set from the outcome
   * axis at the markup door above. */
  .counts {
    grid-column: 1 / -1;
    font-family: var(--face-sans);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
  }
  .live-chip {
    color: var(--beam);
    margin-left: var(--sp-2);
  }
  /* The row's own statement of the standing auto-trip setting: the same
   * words the `,` sheet uses ("armed at N"), worn quietly beside the counts:
   * it is a standing fact, not a live event, so it reads the counts' ink
   * rather than the beam. A reader scanning the panel sees which tools are
   * armed without opening any sheet. */
  .trip-fact {
    color: var(--ink-3);
    margin-left: var(--sp-2);
  }
  .verbs {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
  /* The verb recipe: base, hover, refused: is owned by tokens.css
   * (`.cockpit .verb`); this file keeps only the desk's own VARIANTS. */
  /* `.bare` is the owned edge-dropping marker; the quiet variant adds a
   * dimmer resting ink so the `,` grip recedes until it is asked for. */
  .trip-line {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    color: var(--alarm);
    overflow-wrap: anywhere;
  }
  .note {
    margin: 0;
    font-size: var(--f-micro-size);
    color: var(--ink-3);
  }
  /* The live/fail note hues read the outcome axis's own inks rather than
   * re-spelling them: the beam is the one live hue, the alarm is failure. */
  .note[data-note="live"] {
    color: var(--beam);
  }
  .note[data-note="fail"] {
    color: var(--alarm);
  }
  .arm-sheet {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) 0;
  }
  .arm-input {
    width: var(--sp-7);
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    color: var(--ink-1);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    padding: var(--sp-0) var(--sp-1);
  }
  .tool-description {
    flex-basis: 100%;
    margin: 0 0 var(--sp-2);
    color: var(--ink-2);
    font: var(--f-data-size) / var(--lh-readout) var(--face-sans);
    overflow-wrap: anywhere;
  }
  .tool-manual { flex-basis: 100%; }
</style>
