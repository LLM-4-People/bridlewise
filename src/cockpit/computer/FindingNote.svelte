<script lang="ts">
  /**
   * A finding (spec §1.3, §4): a computed sentence in the ∴ register — one
   * sentence, distinct typographic register, derivation one LENS-level deep
   * behind an inline fold, and the verb where one exists.
   *
   * The derivation prop is MANDATORY and validated at the render boundary
   * (assertDerivation throws) — enforced by tests/cockpit/derivation-owner.
   * The ∴ mark is ink-2, never beam: beam stays live-only (§12.4).
   */
  import { assertDerivation, type Derivation } from "./derivation.ts";
  import Verb from "../flow/Verb.svelte";
  import type { BeatVerb } from "../flow/types.ts";
  import {
    becauseChanged,
    moves,
    type MovesParam,
  } from "../motion/motion.ts";

  let {
    sentence,
    derivation,
    verbs = [],
    onDismiss = undefined,
    mark = true,
  }: {
    sentence: string;
    derivation: Derivation;
    verbs?: readonly BeatVerb[];
    onDismiss?: (() => void) | undefined;
    /** The ∴ register mark. False when the host gutter already draws it. */
    mark?: boolean;
  } = $props();

  // Render-boundary contract: throws when the derivation is missing/degenerate.
  const checked = $derived(assertDerivation(derivation, sentence));

  let showDerivation = $state(false);

  /** Skip the first assignment (the note starts folded). Unfolding arrives.
   * DERIVED, NOT STORED: a `$state` land written by an `$effect` can hand a
   * re-mounted note a cause the contract already spent — an uncaught
   * MotionContract throw (the flow-arrival crash's twin shape). The derived
   * mints the cause in the render that reads it. */
  let lastShown: boolean | null = null;
  const land = $derived.by((): MovesParam => {
    const next = showDerivation;
    const previous = lastShown;
    lastShown = next;
    if (previous === null || previous === next || next === false) {
      return null;
    }
    return {
      motion: "arrive",
      cause: becauseChanged("the finding derivation", previous, next),
    };
  });

  function ageWords(asOf: number): string {
    const s = Math.max(0, Math.round((Date.now() - asOf) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }
</script>

<div class="finding beat-card" data-finding>
  {#if mark}<span class="mark" aria-hidden="true">∴</span>{/if}
  <div class="body">
    <span class="sentence">{sentence}</span>
    <span class="verbs">
      {#each verbs as verb (verb.id)}
        <Verb {verb} />
      {/each}
      <button
        class="verb"
        data-verb-id="finding.derivation"
        onclick={() => (showDerivation = !showDerivation)}
      >{showDerivation ? "hide how" : "how?"}</button>
      {#if onDismiss !== undefined}
        <button class="verb" data-verb-id="finding.dismiss" onclick={onDismiss}>Dismiss</button>
      {/if}
    </span>
    {#if showDerivation}
      <div class="derivation" use:moves={land}>
        <div class="method">{checked.method}</div>
        <ul>
          {#each checked.steps as step (step.sourceId + step.source)}
            <li>{step.source} — {step.count.toLocaleString("en-US")} <span class="src-id">({step.sourceId})</span></li>
          {/each}
        </ul>
        <div class="asof">oldest input {ageWords(checked.asOf)}{checked.window !== undefined ? ` · window: ${checked.window}` : ""}</div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* A finding is the COMPUTER speaking about the conversation, so it wears
   * the system voice: `.beat-card` + the beat's `data-voice="system"` drop
   * the fill for a rule-led register (tokens.css). The `∴` mark below is the
   * family's second mark — a CONCLUSION, which carries a derivation, as
   * against the harness event's `!`, which is an observation. */
  .finding {
    display: flex;
    gap: var(--sp-2);
    align-items: baseline;
  }
  .mark {
    color: var(--ink-2);
    font-family: var(--face-mono);
    flex: none;
  }
  .body {
    min-width: 0;
    flex: 1;
  }
  .sentence {
    font-size: var(--f-ui-size);
    font-style: italic;
    color: var(--ink-1);
  }
  .verbs {
    margin-left: var(--sp-3);
    white-space: nowrap;
  }
  .derivation {
    margin-top: var(--sp-1);
    padding: var(--sp-1) var(--sp-2);
    border-left: var(--hairline-w) solid var(--line-2);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
    font-style: normal;
  }
  .derivation ul { margin: var(--sp-1) 0; padding-left: var(--sp-4); }
  .src-id { color: var(--ink-4); }
  .asof { color: var(--ink-3); }
</style>
