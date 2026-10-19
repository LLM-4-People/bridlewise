<script lang="ts">
  /**
   * INSTRUMENTS — one instrument cell (DESIGN-COCKPIT-V2 §8.2). Every cell
   * uses the shared width and minimum height. Real content and pointer
   * targets determine its final height: name, measured value, an optional
   * spark from ≥2 points, measurement time, resolved verbs and pin.
   *
   * HONESTY, mechanically:
   *   - no sample → NO numeral exists in the DOM; the absence words render
   *     in the value's place ("collecting since 14:02" while the feed
   *     runs, "not measured yet" before it) — same cell size;
   *   - <2 measured points or a non-numeric value has no chart or repeated
   *     type/collection label; the actual measured value remains readable;
   *   - digits ROLL only on true value change ({#key} on the formatted
   *     value — a re-measurement of the same value re-keys nothing);
   *   - color ONLY from a declared threshold crossed (none are declared
   *     live — quiet ink, honestly), with the reason on the cell (F1).
   *
   * LENS: the cell declares its signal id in the callout's own vocabulary
   * (`data-signal` — lens/lens-callout-data.ts), NOT a private attribute
   * name. A stamp the instrument cannot read is not a declaration; it is
   * decoration that looks like one.
   */
  import type { SignalEntry } from "../../../shared/ui-schema.ts";
  import {
    abnormalState,
    asOfTime,
    formatMeasuredValue,
    sparkRenderable,
    type InstrumentVerb,
    type SignalPoint,
  } from "./instruments-data.ts";
  import type { SignalSample } from "./instruments-feed.ts";
  import { PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import { SHEET_ABSENT_REASON } from "./setting-sheet-seam.ts";
  import Spark from "./Spark.svelte";
  import { becauseChanged, moves } from "../motion/motion.ts";
  import { mouseTitleFor } from "../shell/keyboard.ts";
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";

  /** The `setting` chord's tooltip — derived from the grammar table, so the
   * control cannot teach a key the router does not fire. */
  const tSetting = mouseTitleFor("setting");

  let {
    signal,
    sample,
    points,
    verbs,
    collectingSince,
    pinned,
    sheetAvailable,
    pastReason = null,
    onVerb,
    onPin,
  }: {
    signal: SignalEntry;
    sample: SignalSample | undefined;
    points: readonly SignalPoint[];
    verbs: readonly InstrumentVerb[];
    /** Epoch-ms collection started (null = feed never ran). */
    collectingSince: number | null;
    pinned: boolean;
    sheetAvailable: boolean;
    /**
     * Why this cell cannot show a reading right now, or null when it can.
     *
     * Set while the cockpit is showing a PAST instant (§6.2). Signal cells
     * are fed by the live signal channel, not by a ranged block read, so
     * there is no reading for 16:00:53 to show — and the live number under
     * a past-view banner would be a true number about the wrong instant,
     * which is the fabrication rule's worst case. The cell renders its
     * normal absence state with THIS reason instead, at the same size.
     */
    pastReason?: string | null;
    onVerb: (verb: InstrumentVerb) => void;
    onPin: () => void;
  } = $props();

  // A withheld reading is an ABSENT reading: the value, the spark, the asOf
  // and the abnormal state all fall away together, so no half of the cell can
  // keep describing an instant the other half has stopped describing.
  const withheld = $derived(pastReason !== null);
  const measured = $derived(sample !== undefined && !withheld);
  const display = $derived(
    measured && sample !== undefined
      ? formatMeasuredValue(sample.v, signal.type, signal.unit)
      : null,
  );
  const numeric = $derived(measured && typeof sample?.v === "number");
  const abnormal = $derived(withheld ? null : abnormalState(signal, sample?.v));
  const absenceWords = $derived(
    pastReason !== null
      ? pastReason
      : collectingSince !== null
        ? `collecting since ${asOfTime(collectingSince)}`
        : "not measured yet",
  );

  // Digit roll ONLY on a true value CHANGE (§11.4): the first appearance
  // of a value and a re-measurement of the same value both roll nothing.
  //
  // THE SIGNAL IS NAMED, and it is this signal's own name. A monitor polls on
  // a schedule, so this is exactly the surface where a timer could drive
  // motion without anyone noticing: every 3 seconds a number is re-read and
  // something twitches, whether or not the number moved. `becauseChanged`
  // refuses an unchanged pair outright, so "the poll fired" cannot be dressed
  // up as "the reading changed".
  //
  // MINTED AND STAMPED ONCE, onto the node the key just created (RoomHost's
  // cut shape). A reactive `use:moves` param beside a keyed remount is
  // consumed twice for one change — the action update spends the fresh cause
  // on the outgoing node and the remount's mount-apply is then refused with
  // it on the arriving one, uncaught — so the roll is minted here, once per
  // change, and applied imperatively. The keyed block stays: a fresh node is
  // what guarantees the roll's CSS animation starts from scratch on a rapid
  // second change, which a persistent node re-wearing identical attributes
  // would silently skip.
  let valueEl = $state<HTMLSpanElement | null>(null);
  let lastDisplay: string | null = null;
  $effect(() => {
    const node = valueEl;
    const next = display;
    const previous = lastDisplay;
    lastDisplay = next;
    if (node === null || previous === null || next === null || previous === next) return;
    moves(node, { motion: "roll", cause: becauseChanged(signal.name, previous, next) });
  });
</script>

<article
  class="cell"
  data-signal={signal.id}
  data-measured={measured}
  data-abnormal={abnormal?.level ?? null}
  title={abnormal !== null ? abnormal.reason : signal.description}
>
  <header class="head">
    <span class="name engraved">{signal.name}</span>
    <button
      class="verb bare pin"
      data-verb-id="instruments.pin"
      aria-pressed={pinned}
      disabled={withheld}
      title={withheld
        ? PAST_VIEW_ACT_REASON
        : pinned ? "unpin from the horizon" : "pin to the horizon"}
      onclick={onPin}
    >{pinned ? "pinned" : "pin"}</button>
  </header>

  <div class="readout">
    {#if measured && display !== null}
      {#key display}
        <span class="value" bind:this={valueEl}>{display}</span>
      {/key}
      {#if numeric && sparkRenderable(points)}
        <Spark {points} />
      {/if}
    {:else}
      <Answer as="inline" answer={absent(absenceWords)} />
    {/if}
  </div>

  <footer class="foot">
    {#if measured && sample !== undefined}
      <span class="asof">asOf {asOfTime(sample.t)}</span>
    {:else}
      <!-- no honest asOf exists; the readout already states the absence -->
      <span class="asof">—</span>
    {/if}
    {#each verbs as verb (verb.kind + verb.label)}
      <span class="dot">·</span>
      {#if withheld}
        <button
          class="verb"
          data-verb-id={`instruments.${verb.kind}`}
          disabled
          title={PAST_VIEW_ACT_REASON}
        >{verb.label}</button>
      {:else if verb.kind === "adjust" && !sheetAvailable}
        <button
          class="verb"
          data-verb-id="instruments.adjust"
          disabled
          title={SHEET_ABSENT_REASON}
        >{verb.label}</button>
      {:else if verb.kind === "adjust"}
        <!-- The `setting` chord's click path (mouse-first law): this verb
             does what `,` does for the focused fact, so it is the control
             that teaches the chord. -->
        <button
          class="verb"
          data-verb-id="instruments.adjust"
          data-chord-target="setting"
          title={tSetting}
          onclick={() => onVerb(verb)}
        >{verb.label}</button>
      {:else}
        <button
          class="verb"
          data-verb-id={`instruments.${verb.kind}`}
          title={verb.kind === "action" ? verb.consequence : undefined}
          onclick={() => onVerb(verb)}
        >{verb.label}</button>
      {/if}
    {/each}
  </footer>
</article>

<style>
  .cell {
    width: 100%;
    max-width: 100%;
    min-height: var(--instrument-h);
    box-sizing: border-box;
    background: var(--ground-2);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-0);
    padding: var(--sp-2) var(--sp-3);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--sp-2);
    color: var(--ink-2);
  }
  .cell[data-abnormal="warn"] {
    color: var(--warn);
    border-color: var(--warn);
  }
  .cell[data-abnormal="alarm"] {
    color: var(--alarm);
    border-color: var(--alarm);
  }
  /* The row header's spine is owned by tokens.css (.cockpit .head). */
  .head {
    justify-content: space-between;
  }
  .name { min-width: 0; overflow-wrap: anywhere; white-space: normal; }
  .cell[data-abnormal] .engraved {
    color: inherit;
  }
  .readout {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    flex-wrap: wrap;
    min-height: var(--spark-h);
  }
  .value {
    overflow-wrap: anywhere;
    min-width: 0;
    font-family: var(--face-mono);
    font-size: var(--f-value-size);
    font-weight: var(--f-value-weight);
    font-variant-numeric: tabular-nums;
    color: var(--ink-1);
  }
  .cell[data-abnormal] .value {
    color: inherit;
  }
  /* §11.4 — the vertical digit roll is declared by the token owner against
   * `[data-motion="roll"]`. It is NOT declared here, because a `.roll` class
   * plus an `animation:` is a motion that starts itself the moment the class
   * lands, and nothing in that arrangement records what the movement means.
   * The roll effect above hands over a cause naming this signal, or the digits
   * do not move. */
  .foot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--sp-1);
    min-width: 0;
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    color: var(--ink-3);
  }
  .asof {
    white-space: nowrap;
  }
  .dot {
    color: var(--ink-4);
  }
  /* The pin is a BORDERLESS verb — the owned `.verb.bare` recipe in
   * tokens.css (rest/hover/refused/focus all read the state vocabulary)
   * plus the cell's micro register. The hit floor is the owned --hit-min. */
  .pin {
    padding: 0 var(--sp-0);
  }
  .pin[aria-pressed="true"] {
    color: var(--ink-1);
  }
</style>
