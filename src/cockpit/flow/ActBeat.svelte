<script lang="ts">
  /**
   * AN OPERATOR INTERVENTION, rendered — "show when we steer, manipulate
   * context, trim, etc" (the user's own words).
   *
   * It answers two questions and no others: WHAT CHANGED, and WHAT IT WILL
   * AFFECT. Both are quoted, never composed here:
   *
   *   WHAT CHANGED   — the action's DECLARED `title` ("Pin", "Flip breaker",
   *                    "Set trim point"), plus the input the act was actually
   *                    issued with, read through the same component that
   *                    renders a tool call's arguments. An operator act IS an
   *                    input → outcome transformation, so it is shown as one;
   *                    the reader learns one grammar, not two.
   *   WHAT IT AFFECTS — the action's DECLARED `consequence`, verbatim: "Always
   *                    include this memory in what the model sees for this
   *                    chat, starting with the next reply…". The server
   *                    refuses to start if an action registers without one
   *                    (server/blocks/define.ts), and the control that fires
   *                    the act shows the same sentence — so the log and the
   *                    control cannot drift apart, because there is one
   *                    sentence and both read it.
   *
   * WHAT IT WILL NOT DO IS FILL A HOLE. If the served manifest has not loaded,
   * or names no such action, the declared words are ABSENT and this says so
   * (§1.1). Writing a plausible sentence here would be inventing a promise
   * about what the run will do next, which is the worst class of thing to
   * invent.
   *
   * The card carries no verbs of its own: an intervention is a thing that
   * HAPPENED, and the control that could do it again lives on the surface it
   * belongs to (the desk, the breaker row, the arm menu).
   */
  import ToolInput from "../render/ToolInput.svelte";
  import { TOOL_CELL_FOLD_LINES } from "../render/render-config.ts";
  import { fmtDurationMs } from "../render/shapes.ts";
  import { beatState, stateWord, STATE_GLYPH } from "./beat-state.ts";
  import type { Beat } from "./types.ts";

  let { beat }: { beat: Beat } = $props();

  const act = $derived(beat.act!);
  /** The one owner decides the state; this component only renders it. */
  const state = $derived(beatState(beat));

  /** True when the record carries any input worth reading back. */
  const hasInput = $derived(
    act.input !== undefined &&
      act.input !== null &&
      !(typeof act.input === "object" && Object.keys(act.input as object).length === 0),
  );

</script>

<div class="act beat-card">
  <div class="head">
    <span class="who engraved">you</span>
    <!-- The declared title, or an honest statement that the manifest has not
         told us what this action is called. Never a guess from the id. -->
    <span class="title" data-field="act-title">
      {act.title ?? `${act.block} · ${act.action} — this action's declared words are not in the loaded manifest`}
    </span>
    <span class="chip" data-state={state} data-field="status">
      <span class="state-glyph" aria-hidden="true">{STATE_GLYPH[state]}</span>
      {stateWord(state)}
    </span>
    <span class="meta">{fmtDurationMs(act.latencyMs)}</span>
  </div>

  {#if hasInput}
    <div class="what" data-untrusted>
      <ToolInput input={act.input} maxLines={TOOL_CELL_FOLD_LINES} />
    </div>
  {/if}

  <!-- WHAT IT WILL AFFECT — the declared sentence, verbatim. -->
  {#if act.consequence !== undefined}
    <p class="consequence" data-field="consequence">{act.consequence}</p>
  {/if}

  {#if act.state === "failed"}
    <!-- A refused intervention changed NOTHING, and saying so is the point:
         a reader must not assume the run's behaviour moved. The code is the
         one the Broker recorded; no message is invented around it.

         `not-applied`, NOT `failed`: this sentence reports the act's
         OUTCOME (the same axis the status chip renders — beatState maps a
         failed act to `alarm`), while `failed` is a name the response
         grammar owns for the ANSWER axis ("the attempt to read this
         surface's content broke"). The card's content is present; only the
         intervention's outcome is being stated, so the class wears a local,
         non-owned name instead of routing through the grammar. -->
    <p class="consequence not-applied" data-field="outcome">
      this did not go through{act.errorCode !== undefined ? ` — ${act.errorCode}` : ""}, so nothing
      about the run changed
    </p>
  {/if}
</div>

<style>
  /* Register, ground and the leading state edge come from `.beat-card` and
   * the beat's `data-voice`/`data-state` (tokens.css). An intervention is the
   * OPERATOR speaking to the machine, which renders in the rule-led register
   * — no fill, so it can never be mistaken for someone speaking IN the
   * conversation. This component states only what is its own. */
  .act {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  /* The row header's spine is owned by tokens.css (.cockpit .head). */
  .head {
    flex-wrap: wrap;
  }
  /* "you" is engraved rather than emphasised: the authorship is the first
   * thing to read, and it is a label, not a shout. The engraved recipe is
   * owned by tokens.css (.cockpit .engraved). */
  .who {
    flex: none;
  }
  .title {
    color: var(--ink-1);
  }
  .meta {
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  /* The status chip's recipe + state hue are owned by tokens.css
   * (`.cockpit .chip` reading `--outcome-ink`). */
  .state-glyph {
    font-family: var(--face-mono);
    letter-spacing: normal;
  }
  /* The same three outcome hues, on the same affordance, as every other beat
   * (success green, error red, warning yellow — see beat-state.ts). */
  /* The state hue reaches the chip through `--outcome-ink` (set by the
   * `[data-state]` mapping in tokens.css) — never a per-class re-spelling. */
  .what {
    min-width: 0;
  }
  /* The consequence is a SENTENCE TO A PERSON, so it reads in the reading
   * face at the measure — not in the instrument's mono register. It is the
   * one part of this card a reader is meant to read rather than scan. */
  .consequence {
    margin: 0;
    max-width: var(--measure);
    font-family: var(--face-sans);
    font-size: var(--f-ui-size);
    color: var(--ink-2);
  }
  /* Dimmer than the promised consequence above it: the not-applied line is
   * a statement that nothing happened, and it must not outrank the declared
   * sentence it annuls. (Renamed from an owned grammar class — see the
   * markup comment.) */
  .consequence.not-applied {
    color: var(--ink-3);
  }
</style>
