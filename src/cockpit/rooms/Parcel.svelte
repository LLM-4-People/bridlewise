<script lang="ts">
  /**
   * CUSTODY — one work parcel (§7.2): the changes one producing conversation
   * holds (or the honest "not from a recorded conversation" bucket), with
   * the three verbs. `keep` opens ONE inline line — the suggested message
   * quoted from the producing turn's own words, editable, ⏎ saves. No
   * modal. `undo` arms an inline confirmation that states the MEASURED loss
   * (exact ± from the real diff) and only a second press executes.
   *
   * The parcel is presentational: the room injects the real actions
   * (`onKeep`/`onUndo` → the custody block's declared verbs) so this state
   * machine is testable without a network.
   */
  import {
    countsLine,
    lossLine,
    parcelTitle,
    suggestedMessage,
    undoableFiles,
    undoConfirmBlockReason,
    UNRESTORABLE_STATES,
    type CustodyFileWire,
    type ParcelWire,
  } from "./custody-data.ts";
  import { UNDO_CONFIRM_SETTLE_MS, UNDO_CONFIRM_WINDOW_MS } from "./custody-config.ts";
  import { isPastView, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import { VERB_MARK_WORD } from "../shell/verb-marks.ts";
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";
  import Popover from "../shell/Popover.svelte";

  let {
    parcel,
    onKeep,
    onUndo,
    onSee,
    whenText,
    provKey = null,
  }: {
    parcel: ParcelWire;
    /** The real keep action (files, message) — resolves when saved. */
    onKeep: (files: readonly string[], message: string) => Promise<void>;
    /** The real undo action — resolves when restored. */
    onUndo: (files: readonly string[]) => Promise<void>;
    /** Open the diff sheet for one file, with the state the room measured
     * for it (the sheet's absence sentence depends on it). */
    onSee: (file: string, state: string) => void;
    /** Relative time for the parcel's newest recorded touch ("" if none). */
    whenText: string;
    /** The Broker cache key of the `custody.state` read this parcel came
     * from, for the LENS stamp. Null when a mount has no read behind it. */
    provKey?: string | null;
  } = $props();

  const suggestion = $derived(suggestedMessage(parcel.attribution));
  const restorable = $derived(undoableFiles(parcel));

  /**
   * PAST VIEW (§6.2). `keep` and `undo` write the project's real history and
   * its real files; a planted head is a view of an instant that has already
   * happened, and the working tree they would act on is TODAY's. The Broker
   * refuses the write either way (`assertLiveForWrite`), so nothing can
   * execute — but a control has to say so BEFORE the click, not fail at the
   * door. `see` is a read and stays available: a past view is readable.
   *
   * This compounds with the shield above: a destructive verb one stray click
   * away is worse when the click is aimed from a view of another moment.
   */
  const past = $derived($isPastView);
  /** The one sentence every disabled reason collapses to in a past view. */
  const reasonFor = (live: string): string => (past ? PAST_VIEW_ACT_REASON : live);

  // ── the one inline keep line ───────────────────────────────────────────
  let keepOpen = $state(false);
  let message = $state("");
  let messageEl: HTMLInputElement | undefined = $state();

  // ── the armed undo confirmation ("all" or one path) ────────────────────
  let armedUndo = $state<"all" | string | null>(null);
  /** When it was armed, when the pointer/focus last ARRIVED on the confirm,
   * and a tick that re-reads the clock so the shield's own sentence stops
   * being stale — see undoConfirmBlockReason. */
  let armedAt = $state<number | null>(null);
  let reachedAt = $state<number | null>(null);
  let clockTick = $state(0);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  let busy = $state(false);
  let failure = $state<string | null>(null);

  function disarm(): void {
    armedUndo = null;
    armedAt = null;
    reachedAt = null;
    clearTimeout(settleTimer);
    clearTimeout(expiryTimer);
  }

  function openKeep(): void {
    // Same rule as the disabled attribute, re-checked on the path: a
    // disabled attribute is a hint to the pointer, not a guarantee.
    if (past) return;
    keepOpen = true;
    disarm();
    failure = null;
    message = suggestion.text;
    queueMicrotask(() => messageEl?.focus());
  }

  async function submitKeep(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const m = message.trim();
    if (m.length === 0 || busy || past) return;
    busy = true;
    failure = null;
    try {
      await onKeep(parcel.files.map((f) => f.path), m);
      keepOpen = false;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function armUndo(target: "all" | string): void {
    if (past) return;
    clearTimeout(settleTimer);
    clearTimeout(expiryTimer);
    armedUndo = target;
    armedAt = Date.now();
    // A fresh arm has NOT been reached, whatever the pointer was doing a
    // moment ago — a stale arrival must not authorise a new confirmation.
    reachedAt = null;
    keepOpen = false;
    failure = null;
    // Re-read the clock when the shield's window opens and when it closes,
    // so the button's own state (and its stated reason) follow the rule
    // instead of freezing at the instant of arming.
    settleTimer = setTimeout(() => (clockTick += 1), UNDO_CONFIRM_SETTLE_MS);
    expiryTimer = setTimeout(() => disarm(), UNDO_CONFIRM_WINDOW_MS);
  }

  /** A deliberate ARRIVAL on the destructive control: the pointer moving
   * onto it, or keyboard focus landing on it. Recorded, not trusted — the
   * rule still requires it to have happened after the settle window. */
  function reachConfirm(): void {
    reachedAt = Date.now();
  }

  const armedFiles = $derived.by((): readonly CustodyFileWire[] => {
    if (armedUndo === null) return [];
    if (armedUndo === "all") return restorable;
    const one = parcel.files.find((f) => f.path === armedUndo);
    return one === undefined ? [] : [one];
  });

  /** Why the armed confirmation is refusing right now, or null when it will
   * really run. `clockTick` is read so the timers above re-evaluate it. */
  const blockReason = $derived.by((): string | null => {
    void clockTick;
    return undoConfirmBlockReason({ armedAt, reachedAt, now: Date.now() });
  });

  async function confirmUndo(): Promise<void> {
    // The SAME rule the button's disabled state uses, re-checked here: a
    // disabled attribute is a hint to the pointer, not a guarantee about
    // the code path. Nothing destructive runs without it.
    if (busy || past || armedFiles.length === 0) return;
    if (undoConfirmBlockReason({ armedAt, reachedAt, now: Date.now() }) !== null) return;
    busy = true;
    failure = null;
    try {
      await onUndo(armedFiles.map((f) => f.path));
      disarm();
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<section class="parcel" data-prov={provKey} aria-label={parcelTitle(parcel.attribution)}>
  <header class="cap">
    <span class="engraved title trunc">{parcelTitle(parcel.attribution)}</span>
    {#if whenText.length > 0}<span class="when">{whenText}</span>{/if}
    <span class="sum">{countsLine(parcel.insertions, parcel.deletions)}</span>
    <span class="verbs">
      <button class="verb " data-verb-id="custody.state/keep" disabled={busy || past} onclick={openKeep}
        title={reasonFor("Saves these files' changes into the project's history under your message; the files stay as they are now.")}
        >Keep all</button>
      {#if restorable.length > 0}
        <button class="verb " data-verb-id="custody.state/undo" disabled={busy || past} onclick={() => armUndo("all")}
          title={reasonFor("Returns these files to their last saved state — your unsaved edits leave the working tree.")}
          >Undo all</button>
      {:else}
        <button class="verb plain unwired" data-verb-id="custody.state/undo" disabled
          title={reasonFor("Nothing here can be returned to an earlier saved state, so there is no undo to offer.")}
          >Undo all — these files are new; there is no earlier saved version to return to</button>
      {/if}
    </span>
  </header>

  {#if parcel.attribution.kind === "outside"}
    <p class="note">{parcel.attribution.reason}</p>
  {/if}

  <!--
    THE INLINE LINE — one reserved slot, always present.

    Opening `keep` or arming `undo` used to INSERT a line here, which moved
    every file row below it down by a line. That is how a click aimed at one
    row's verb lands on another row's, and it is how a destructive control
    arrives under a pointer that was going somewhere else. The slot now
    holds its height whether or not a line is in it, so nothing below moves.
  -->
  <div class="line-slot">
    {#if keepOpen}
      <form class="keep-line" onsubmit={submitKeep} aria-label="keep these changes">
        {#if suggestion.fromRequest}
          <span class="hintlabel">from your request:</span>
        {/if}
        <input
          bind:this={messageEl}
          bind:value={message}
          class="field"
          type="text"
          name="save-message"
          placeholder="what this work was"
          aria-label="save message"
          data-verb-id="custody.state/keep"
          title={reasonFor("The words this work is saved under — quoted from your own request when there is one to quote.")}
          disabled={busy || past}
        />
        <button class="verb ok primary" aria-busy={busy} type="submit" data-verb-id="custody.state/keep" disabled={busy || past || message.trim().length === 0}
          title={reasonFor("Saves these files' changes into the project's history under this message.")}
          >{busy ? "Saving…" : "Save changes"}</button>
        <button
          class="verb cancel "
          type="button"
          data-verb-id="custody.keep-cancel"
          aria-label={VERB_MARK_WORD.cancel}
          onclick={() => (keepOpen = false)}
          title="Closes this line and saves nothing.">{VERB_MARK_WORD.cancel}</button>
      </form>
    {:else if armedUndo !== null}
      <Popover title="restore last saved" kind="alertdialog" onclose={disarm}>
        <div class="undo-line">
          <span class="loss">{lossLine(armedFiles)}</span>
          <button
            class="verb warn"
            data-verb-id="custody.state/undo"
            disabled={busy || past || blockReason !== null}
            title={past ? PAST_VIEW_ACT_REASON : (blockReason ?? "Returns each file to its last saved state.")}
            onpointerenter={reachConfirm}
            onpointermove={reachConfirm}
            onfocus={reachConfirm}
            onclick={confirmUndo}
            >{busy ? "restoring…" : "really undo"}</button>
          <button
            class="verb cancel "
            data-verb-id="custody.undo-cancel"
            aria-label={VERB_MARK_WORD.cancel}
            onclick={disarm}
            title="Leaves every one of these changes exactly as it is.">{VERB_MARK_WORD.cancel}</button>
        </div>
        {#if blockReason !== null && !busy}
          <p class="shield" role="status">{blockReason}</p>
        {/if}
      </Popover>
    {/if}
  </div>

  {#if failure !== null}
    <p class="failure" role="alert">{failure}</p>
  {/if}

  <ul class="files">
    {#each parcel.files as file (file.path)}
      <li class="row">
        <span class="state">{file.state === "changed" ? "±" : file.state}</span>
        <span class="path trunc" title={file.path}>{file.path}</span>
        <span class="counts">
          {#if file.insertions !== null && file.deletions !== null}
            {countsLine(file.insertions, file.deletions)}
          {:else}
            <!-- The old title-attribute reason is folded into the words: a
                 reason a reader had to hover for was a reason most readers
                 never saw. -->
            <Answer
              as="inline"
              answer={absent(
                file.state === "new"
                  ? "all new"
                  : file.countsAbsentReason !== undefined
                    ? `not counted — ${file.countsAbsentReason}`
                    : "not counted",
              )}
            />
          {/if}
        </span>
        <span class="verbs">
          <button class="verb " data-verb-id="custody.see" onclick={() => onSee(file.path, file.state)}
            title="Shows this file's difference against its last saved state.">See</button>
          {#if !UNRESTORABLE_STATES.has(file.state)}
            <button class="verb " data-verb-id="custody.state/undo" disabled={busy || past} onclick={() => armUndo(file.path)}
              title={reasonFor("Arms a confirmation; the change is only discarded once you deliberately press the confirmation.")}>Undo</button>
          {/if}
        </span>
      </li>
    {/each}
  </ul>
</section>

<style>
  /* A parcel is one packable item on the room's board: it asks for its own
   * measure and grows into whatever the row has left, so a wide viewport
   * carries several parcels side by side (see CustodyRoom's .board). */
  .parcel {
    flex: 1 1 var(--custody-parcel-w);
    min-width: 0;
    max-width: 100%;
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    background: var(--ground-1);
    padding: var(--sp-2) var(--sp-3);
    position: relative;
  }
  /* The cap row's spine is owned by tokens.css (.cockpit .cap); the
   * parcel's cap wraps and mixes its gaps. */
  .cap {
    align-items: center;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-3);
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .when {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    white-space: nowrap;
  }
  .sum {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
    white-space: nowrap;
  }
  /* The verb row's recipe is owned by tokens.css (.cockpit .verbs); the
   * parcel's cluster is inline so it packs beside the keep line. */
  .verbs {
    display: inline-flex;
  }
  /* The pointer-target floor (§12.5; --hit-min in tokens.css is its one
   * owner). These verbs were 19px chips — under the floor for the clicks
   * this whole room exists to serve. */
  /* The verb recipe is owned by tokens.css (.cockpit .verb); this
   * room's verbs keep the smaller engraved register (.engraved-ctl,
   * carried as a marker class) and its own ink/pad. */
  .verb.warn {
    color: var(--alarm);
    border-color: var(--alarm);
  }
  .verb.unwired {
    white-space: normal;
    text-align: left;
  }
  .note {
    margin: var(--sp-1) 0 0;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    /* The attribution reason is an absence sentence (why this file is here);
     * it wears the absence ink and no slant, not the retired italic-faint. */
    color: var(--state-absent-ink);
  }
  /* THE RESERVED SLOT — held at exactly one control's height whether or not
   * a line is in it, so opening `keep` or arming `undo` cannot move the file
   * rows (and therefore cannot move a verb under a travelling pointer). */
  .line-slot {
    position: relative;
    display: flex;
    align-items: stretch;
    min-height: var(--hit-min);
    margin-top: var(--sp-2);
  }
  .keep-line,
  .undo-line {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0 var(--sp-2);
    background: var(--ground-2);
    border-left: var(--hairline-w) solid var(--line-2);
  }
  /* The shield's own sentence: why the destructive control is refusing.
   * Hung out of flow beneath its line, on its own opaque ground, so it is
   * legible over whatever it covers and moves nothing while it is there. */
  .shield {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 1;
    margin: 0;
    padding: var(--sp-0) var(--sp-2);
    background: var(--ground-2);
    border-left: var(--hairline-w) solid var(--line-2);
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    /* A block reason is a refusal said in words — the absence/refusal ink,
     * no slant (slant was retired from the answer register). */
    color: var(--state-absent-ink);
  }
  .hintlabel {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    white-space: nowrap;
  }
  /* The input recipe is owned by tokens.css (.cockpit input.field); the
   * keep-line's field grows into the row and pads a step tighter. */
  .field {
    flex: 1;
    padding: var(--sp-0) var(--sp-1);
    /* The keep line sits on the card's own ground (ground-0), one step
     * quieter than the owned recipe's inset (ground-1) — kept because the
     * field must not read as a raised box inside the parcel's own box. */
    background: var(--ground-0);
  }
  .loss {
    flex: 1;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--alarm);
  }
  .failure {
    margin: var(--sp-1) 0 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--alarm);
  }
  /* The file list packs into columns of its OWN measure the moment the
   * parcel is wider than one row needs — which is what happens when a
   * project's whole change set sits in a single parcel and the board hands
   * it the full width. Grid fills ROW-MAJOR, so the order the server sent
   * is still the order that is read: left → right, then down. */
  .files {
    list-style: none;
    margin: var(--sp-2) 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--custody-file-col), 1fr));
    gap: var(--sp-0) var(--sp-5);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  .state {
    color: var(--ink-4);
    width: var(--sp-6);
    flex: none;
  }
  .path {
    flex: 1;
    min-width: 0;
    color: var(--ink-1);
  }
  .counts {
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
    white-space: nowrap;
  }
</style>
