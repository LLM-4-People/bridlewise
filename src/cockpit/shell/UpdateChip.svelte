<script lang="ts">
  /**
   * THE UPDATE CHIP — a running page's one honest sentence about a
   * deploy that has already happened: "new version — restart".
   *
   * It renders exactly when the sw-update seam holds evidence (see
   * sw-update.ts for what counts), and the restart is the READER'S click —
   * never automatic. The chip speaks the response grammar's OUTCOME axis:
   * `warn` ("measured, and it needs a look") is the honest state of a page
   * whose bundle is measured to be superseded — nothing broke, nothing is
   * live, but staying here has a named cost. The ink is derived from the
   * axis declaration, not restated, so the grammar owns what warn looks like.
   *
   * Its arrival is a real event — a new version ARRIVED — so the rise is
   * bound to an arrival cause through the motion owner; a chip that faded in
   * on its own would be motion with no event behind it.
   */
  import { OUTCOME_STATES, type OutcomeStateId } from "../response/grammar.ts";
  import { becauseArrived, moves, type MovesParam } from "../motion/motion.ts";
  import { swUpdateReady } from "./sw-update.ts";

  const update = $derived($swUpdateReady);

  const OUTCOME: OutcomeStateId = "warn";
  const ink = OUTCOME_STATES[OUTCOME].ink;

  /** One cause per arrival: the seam is one-shot, so the value changes once
   * (null → ready) and the cause is spent on that one rise. */
  const arrival = $derived.by<MovesParam>(() =>
    update === null
      ? null
      : {
          motion: "rise",
          cause: becauseArrived(
            "a newer cockpit bundle",
            "a new version of the cockpit arrived and is waiting for a restart",
          ),
        },
  );
</script>

{#if update !== null}
  <div class="update-anchor" role="status" aria-live="polite">
    <button
      class="update-chip"
      type="button"
      data-outcome={OUTCOME}
      style={`--update-ink: var(${ink})`}
      title="a new version of the cockpit is ready — restarting reloads this page onto it"
      use:moves={arrival}
      onclick={() => update.apply()}
    >
      New version — restart
    </button>
  </div>
{/if}

<style>
  .update-anchor {
    position: absolute;
    top: calc(var(--horizon-h, 32px) + var(--sp-2));
    right: var(--sp-3);
    z-index: 50;
    display: flex;
    justify-content: flex-end;
  }
  .update-chip {
    appearance: none;
    display: inline-flex;
    align-items: center;
    min-height: var(--hit-min);
    padding: 0 var(--sp-3);
    background: var(--ground-3);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    box-shadow: var(--shadow-sheet);
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    letter-spacing: var(--f-micro-track);
    /* The outcome axis owns the ink — bound above from OUTCOME_STATES. */
    color: var(--update-ink);
    cursor: pointer;
  }
  .update-chip:hover {
    background: var(--layer-hover);
  }
  .update-chip:active {
    background: var(--layer-press);
  }
</style>
