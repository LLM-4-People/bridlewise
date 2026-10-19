<script lang="ts">
  /**
   * A beat verb (spec §1.2). The ONLY way an interactive control renders in
   * the flow: a wired verb runs its real action; an unwired verb renders
   * disabled with its honest reason ON the control (visible text, not only a
   * tooltip). A verb with neither is a contract violation and throws —
   * tests/cockpit/verb-owner.test.ts holds every flow component to this.
   *
   * The CONTROL'S LOOK — the rest edge, hover answer, refused ink, the focus
   * ring — is owned by the token file (`.cockpit .verb` + the global
   * `:focus-visible` rule), so a control in a room and a control in the flow
   * wear the same states the same way. What stays here is the CONTRACT (the
   * throw, the reason on the unwired control), which is the flow's half.
   */
  import { isPastView, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import { ClientError } from "../../data/errors.ts";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";
  import { armedRewindConfirm } from "./rewind.ts";
  import type { BeatVerb } from "./types.ts";

  let { verb: verbProp }: { verb: BeatVerb } = $props();

  /**
   * THE CONTRACT BELOW, WRITTEN AS A TYPE so the template inherits it.
   *
   * `BeatVerb` declares `reason?: string`, because a WIRED verb has no reason
   * to give. The guard immediately below turns that into an invariant — an
   * unwired verb without a reason never paints, it throws — but a runtime
   * throw teaches the type system nothing, so the disabled branch was reading
   * `verb.reason.length` off a value the checker knew might be undefined.
   *
   * Stating the validated shape is what closes that: past the guard, `wired`
   * discriminates, and the unwired arm CARRIES its reason. The template's
   * `{:else}` then has a `string`, and no cast is involved anywhere — the
   * guard is what makes the claim true and the type is what carries it.
   */
  type ValidatedVerb =
    | (BeatVerb & Readonly<{ wired: true }>)
    | (BeatVerb & Readonly<{ wired: false; reason: string }>);

  // Render-boundary contract, re-validated on every verb value (not just the
  // first): a wired verb without an action, or a disabled verb without its
  // reason, must never paint.
  const checked = $derived.by((): ValidatedVerb => {
    const v = verbProp;
    if (v.wired) {
      if (typeof v.run !== "function") {
        throw new ClientError("cockpit_contract", `verb "${v.label}" claims wired but carries no action (§1.2)`);
      }
      return { ...v, wired: true };
    }
    if (v.reason === undefined || v.reason.length === 0) {
      throw new ClientError("cockpit_contract", `verb "${v.label}" is disabled without an honest reason (§1.2)`);
    }
    return { ...v, wired: false, reason: v.reason };
  });

  /**
   * A PAST VIEW IS READ-ONLY (§6.2) — said on the control, not only at the
   * door.
   *
   * Verbs are built once at INGEST time, so a verb wired while live is still
   * wired in the object when the head is later planted; nothing in the
   * factory can know. This is the reactive half: any verb that DECLARES it
   * writes renders disabled while a head stands, carrying the one owned
   * sentence for why. The refusal itself lives at the write door
   * (`assertLiveForWrite`, in the verb's own `run` and in `broker.action`) —
   * this only means the user learns before the click instead of after it.
   */
  const verb = $derived<ValidatedVerb>(
    checked.writes === true && $isPastView
      ? { ...checked, wired: false, reason: PAST_VIEW_ACT_REASON }
      : checked,
  );

  let busy = $state(false);
  let failure = $state<string | null>(null);
  /** The armed-confirm key the caught failure speaks for, when it is a
   * two-press confirm's first press. `null` for every other failure — those
   * are this control's own to say until its next press. */
  let failureConfirmKey = $state<string | null>(null);

  /**
   * A CONFIRM FACE FOLLOWS ITS ARM (UIE-043). The rewind confirm is ONE
   * slot, and a retarget press on another beat REPLACES the arm — so the
   * sentence a previous press minted is no longer this control's to say:
   * without this gate, two beats both rendered "press again" while one arm
   * existed, and pressing the stale one re-armed rather than performed
   * (safe, but untrue copy). The visible face is therefore derived from
   * the arm's CURRENT key: a confirm failure renders only while its key
   * owns the slot, and the retarget clears the abandoned face by
   * reactivity — the sentence's lifetime is the arm's, not the catching
   * control's.
   */
  const visibleFailure = $derived(
    failure !== null && (failureConfirmKey === null || ($armedRewindConfirm?.key ?? null) === failureConfirmKey)
      ? failure
      : null,
  );

  /**
   * Confirmation lives on the control that acted. Busy → idle with no
   * failure is success; a new failure sentence is the refusal landing.
   * Equal values are refused by `becauseChanged`.
   */
  let lastBusy = false;
  let lastFailure: string | null = null;
  const verbMotion = $derived.by((): MovesParam => {
    const wasBusy = lastBusy;
    const prevFail = lastFailure;
    lastBusy = busy;
    lastFailure = visibleFailure;
    if (visibleFailure !== null && visibleFailure !== prevFail) {
      return {
        motion: "arrive",
        cause: becauseChanged("this verb's refusal", prevFail, visibleFailure),
      };
    }
    if (wasBusy && !busy && visibleFailure === null) {
      return {
        motion: "rise",
        cause: becauseChanged("this verb finished", true, false),
      };
    }
    return null;
  });

  async function act(): Promise<void> {
    if (!verb.wired || busy) return;
    busy = true;
    failure = null;
    failureConfirmKey = null;
    try {
      await verb.run!();
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      failureConfirmKey = err instanceof ClientError ? (err.confirmKey ?? null) : null;
    } finally {
      busy = false;
    }
  }
</script>

{#if verb.wired}
  <button
    class="verb {verb.mark ?? ''}"
    data-verb-id={verb.id}
    aria-label={verb.label}
    title={verb.label}
    disabled={busy}
    aria-busy={busy}
    onclick={act}
    use:moves={verbMotion}
  >{busy ? `${verb.label}…` : verb.label}</button>
  {#if visibleFailure !== null}
    <span class="verb-failure" role="alert">{visibleFailure}</span>
  {/if}
{:else}
  <button
    class="verb verb-unwired"
    data-verb-id={verb.id}
    disabled
    title={verb.reason}
  >{verb.label}<span class="verb-reason plain">: {verb.reason.length > 48 ? `${verb.reason.slice(0, 47)}…` : verb.reason}</span></button>
{/if}

<style>
  /* The verb's whole recipe — rest edge, hover, press, refused ink, the
   * focus ring — is owned by tokens.css (`.cockpit .verb` + the global
   * `:focus-visible` rule). What remains here is only what the FLOW's verb
   * adds to the contract: the unwired verb carries its reason ON the
   * control, so it wraps and right-aligns rather than truncating. */
  .verb-unwired {
    color: var(--layer-disabled);
    white-space: normal;
    text-align: right;
  }
  .verb-reason {
    font-size: var(--f-micro-size);
  }
  .verb-failure {
    color: var(--alarm);
    font-size: var(--f-data-size);
    font-family: var(--face-mono);
  }
</style>
