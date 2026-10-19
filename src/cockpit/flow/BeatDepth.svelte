<script lang="ts">
  /**
   * THE INLINE DEPTH — everything the SCOPE sheet used to add, under the card
   * it belongs to.
   *
   * ── WHY IT EXISTS ─────────────────────────────────────────────────────────
   *
   * THE USER'S RULING, VERBATIM, said three times about the same gesture:
   * "when clicking on a tool, it shows up on the right side on top of
   * expanding in the chat, I just want expanding in the chat" · "sometimes
   * when clicking around the tool open on the right side, I don't want that" ·
   * "scope also opens on a right menu."
   *
   * So a tool beat opens in place and never into a sheet (beat-state.ts
   * `opensScopeSheet` owns that). But deleting the control without moving what
   * it showed would fail the OTHER rule the same user set, from the `[view]`
   * exchange: a control "should first bring more details and second just be
   * clickable". So this is the inventory of what the sheet added over the open
   * card, moved here whole:
   *
   *   WHEN         the clock time of the fact. The card states a DURATION;
   *                only the sheet stated the instant. Both are measurements
   *                and neither substitutes for the other.
   *   CAUSE        the beat this one was caused by, named as a THING ("in
   *                reply to your message at 10:23:12") and clickable, so the
   *                causal chain can be followed — the point of the recording.
   *   VERBS        EVERY verb, including the refusing ones with their full
   *                reason. The options row above deliberately carries only
   *                the wired ones (a refusal printed on every resting row is
   *                a sentence the reader skips hundreds of times); the sheet
   *                was where the whole set lived. For a kind with no sheet,
   *                here is where it lives.
   *   THE RECORD   the ids and the exchange number, one level deeper behind a
   *                closed disclosure. Real, reachable, and not the body —
   *                exactly as the sheet held them.
   *
   * NOTHING WAS LEFT BEHIND. The sheet's remaining section was the beat's own
   * body rendered expanded, which is the card this sits under.
   *
   * ── WHY THE VERBS ARE REPEATED HERE ───────────────────────────────────────
   *
   * They are not repeated: the options row shows the WIRED subset and this
   * shows the complete set, which is a strictly different fact (which of this
   * beat's verbs cannot run right now, and why). A reader who opens a card is
   * asking for the complete answer; that is what "more details" means.
   */
  import Verb from "./Verb.svelte";
  import { beatById } from "./log.ts";
  import { causalPhrase, type Beat } from "./types.ts";

  let {
    beat,
    onfocuscause = undefined,
  }: {
    beat: Beat;
    /** Focus the causing beat AND bring it into view — the causal reference's
     * click path. Absent when the host cannot move the flow; the reference
     * then renders as plain text rather than as a button that would do
     * nothing (§1.2). */
    onfocuscause?: ((id: string) => void) | undefined;
  } = $props();

  const HHMMSS_LEN = 8; // "14:02:07"
  function clockOf(at: number): string {
    return new Date(at).toTimeString().slice(0, HHMMSS_LEN);
  }

  /** The beat this one was caused by, when the record names one we still hold. */
  const parent = $derived(beat.parentId !== null ? beatById(beat.parentId) : undefined);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events (this row sits inside the
     card's body-click target; the stop is what keeps ONE gesture to ONE
     outcome — pressing a verb in here must not also fold the card) -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="depth" data-field="beat-depth" onclick={(e) => e.stopPropagation()}>
  <p class="when">at {clockOf(beat.at)}</p>

  {#if parent !== undefined}
    <p class="cause">
      {#if onfocuscause !== undefined}
        <button
          class="cause-link"
          data-verb-id="flow.focus/cause"
          title="focus the beat this one was caused by"
          onclick={() => onfocuscause(parent.id)}
        >{causalPhrase(parent)} at {clockOf(parent.at)}</button>
      {:else}
        <span class="cause-text">{causalPhrase(parent)} at {clockOf(parent.at)}</span>
      {/if}
    </p>
  {:else if beat.parentId !== null}
    <!-- The record names a cause this session no longer holds. Say that,
         rather than printing the address of something we cannot show. -->
    <p class="cause"><span class="cause-text">what caused this is not in the loaded history</span></p>
  {/if}

  {#if beat.verbs.length > 0}
    <div class="verbs">
      {#each beat.verbs as verb (verb.id)}
        <Verb {verb} />
      {/each}
    </div>
  {/if}

  <details class="record">
    <summary class="record-grip engraved">the precise record</summary>
    <dl class="record-rows">
      <dt>this row</dt>
      <dd>{beat.id}</dd>
      {#if beat.parentId !== null}
        <dt>caused by row</dt>
        <dd>{beat.parentId}</dd>
      {/if}
      <dt>exchange</dt>
      <dd>{beat.turnIndex + 1}</dd>
    </dl>
  </details>
</div>

<style>
  /* The rule down the left is the whole of the visual claim: this is MORE
   * ABOUT THE CARD ABOVE, not a new object. No ground step, no border box —
   * a second card here would read as a second fact. */
  .depth {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
    padding-left: var(--beat-depth-pad);
    border-left: var(--hairline-w) solid var(--line-1);
    min-width: 0;
  }
  .when {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .cause {
    margin: 0;
  }
  .cause-link {
    appearance: none;
    background: none;
    border: none;
    border-radius: var(--radius-1);
    display: inline-flex;
    align-items: center;
    min-height: var(--hit-min);
    padding: 0 var(--sp-1);
    font: inherit;
    font-size: var(--f-ui-size);
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: var(--sp-0);
    cursor: pointer;
    text-align: left;
  }
  .cause-link:hover {
    background: var(--layer-hover);
    color: var(--ink-1);
  }
  .cause-text {
    font-size: var(--f-ui-size);
    color: var(--ink-3);
  }
  /* The verb row's recipe is owned by tokens.css (.cockpit .verbs); the
   * open card's verbs wrap and breathe wider than a row cluster. */
  .verbs {
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .record-grip {
    display: inline-flex;
    align-items: center;
    min-height: var(--hit-min);
    font-family: var(--face-mono);
    cursor: pointer;
  }
  .record-grip:hover {
    color: var(--ink-1);
  }
  .record-rows {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-1) var(--sp-3);
    margin: var(--sp-2) 0 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  .record-rows dt {
    color: var(--ink-3);
    white-space: nowrap;
  }
  .record-rows dd {
    margin: 0;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
</style>
