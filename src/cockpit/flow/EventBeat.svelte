<script lang="ts">
  /**
   * An inline event beat (spec §3.2): kind glyph + plain sentence. Kinds are
   * the canonical EVENT_KINDS vocabulary plus the client's own observed
   * error ("client-error" — an error the client itself recorded).
   */
  import { beatState } from "./beat-state.ts";
  import type { Beat } from "./types.ts";

  let { beat }: { beat: Beat } = $props();

  const ev = $derived(beat.event!);
  /**
   * The ONE owner decides the state; this beat only renders it. It used to
   * ink its kind label from `beat.abnormal` alone, which painted a WARNING
   * red while the leading edge beside it was yellow — one fact, two answers.
   * Now the label and the edge read the same function, so the three outcome
   * hues (green / yellow / red) mean the same thing here as everywhere else.
   *
   * The hue itself is the grammar's, not a class of this file: `data-state`
   * sets the owned `--outcome-ink` (tokens.css) and `.kind` reads it. A
   * `state-*` class would be a second spelling of the same axis, which the
   * token owner's guard rejects.
   */
  const state = $derived(beatState(beat));

</script>

<div class="event beat-card" data-state={state}>
  <span class="kind engraved">{ev.eventKind.replace("_", " ").replace("client-error", "error")}</span>
  <span class="text" data-untrusted>{ev.text}</span>
</div>

<style>
  /* Register, ground and the leading state edge come from `.beat-card` and
   * the beat's `data-voice`/`data-state` (tokens.css). An event is the
   * HARNESS speaking, so it renders in the system voice: no fill, a leading
   * rule, the engraved kind label. */
  .event {
    display: flex;
    gap: var(--sp-2);
    align-items: baseline;
    color: var(--ink-2);
  }
  /* The kind label's engraved recipe is owned by tokens.css (.cockpit
   * .engraved); here it reads the outcome ink its own card's data-state set,
   * so the word and the leading edge are the one mapping. `neutral` sets no
   * ink, and the engraved ink remains — an absence of state renders as
   * absence, never as a green tick nobody measured (§1.1). */
  .kind {
    color: var(--outcome-ink, var(--ink-3));
    flex: none;
  }
  .text { overflow-wrap: anywhere; min-width: 0; }
</style>
