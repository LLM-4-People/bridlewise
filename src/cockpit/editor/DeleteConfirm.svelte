<script lang="ts">
  /**
   * THE DELETE CONFIRMATION — the one destructive control in this room, and
   * the only one that asks you to write something down.
   *
   * The rule it obeys lives in `destructive.ts` and is pure, so what can and
   * cannot fire this is decided by a function under test rather than by the
   * arrangement of this markup. This component's whole job is to make that
   * rule VISIBLE: it states which file, what will be lost, why the button is
   * refusing right now, and how long the confirmation has left.
   *
   * Three things are true of it by construction:
   *   - it is armed for ONE path, and the caller passes the path it is about
   *     to delete, so a confirmation cannot be redirected at another file;
   *   - it cannot be pressed by a click that was already travelling toward
   *     whatever used to be at this spot (the settling interval);
   *   - it cannot be pressed at all until the file's own name has been typed,
   *     which no accident does.
   *
   * The `now` it judges against ticks on a real clock so the timeout states
   * itself instead of waiting to be discovered on the press.
   */
  import { onDestroy } from "svelte";

  import { DELETE_CONFIRM_WINDOW_MS } from "./editor-config.ts";
  import { deleteBlockReason, deleteLossLine, type DeleteArm } from "./destructive.ts";
  import { VERB_MARK_WORD } from "../shell/verb-marks.ts";

  let {
    arm,
    size,
    oncancel,
    onconfirm,
  }: {
    arm: DeleteArm;
    /** The file's measured size, or null for a folder / unmeasured. */
    size: number | null;
    oncancel: () => void;
    /** Called only when the rule below says it may be. */
    onconfirm: () => void;
  } = $props();

  let typedName = $state("");
  let reachedAt = $state<number | null>(null);
  let now = $state(Date.now());

  const tick = setInterval(() => (now = Date.now()), 500);
  onDestroy(() => clearInterval(tick));

  const reach = $derived({
    arm,
    reachedAt,
    typedName,
    now,
    targetPath: arm.path,
  });
  const blocked = $derived(deleteBlockReason(reach));
  const secondsLeft = $derived(
    Math.max(0, Math.ceil((arm.armedAt + DELETE_CONFIRM_WINDOW_MS - now) / 1000)),
  );

  /**
   * The press is judged AGAIN here, against the clock at the instant of the
   * press, so a stale `blocked` value computed half a second ago can never be
   * what lets a delete through. `disabled` is the courtesy; this is the rule.
   */
  function confirm(): void {
    if (deleteBlockReason({ ...reach, now: Date.now() }) !== null) return;
    onconfirm();
  }

  /** A pointer or keyboard focus ARRIVING on the confirm control. Recorded
   * once — a second arrival must not reset the settling it already cleared. */
  function reached(): void {
    if (reachedAt === null) reachedAt = Date.now();
  }
</script>

<div class="confirm" role="group" aria-label={`delete ${arm.name}`}>
  <p class="loss">{deleteLossLine(arm, size)}</p>
  <div class="row">
    <label class="field">
      <span class="engraved">type the name to confirm</span>
      <input
        class="name"
        type="text"
        name="delete-confirm-name"
        autocomplete="off"
        spellcheck="false"
        placeholder={arm.name}
        aria-label={`type ${arm.name} to confirm the deletion`}
        bind:value={typedName}
      />
    </label>
    <button
      class="verb "
      data-verb-id="editor.delete-confirm"
      type="button"
      data-state={blocked === null ? "armed" : null}
      disabled={blocked !== null}
      title={blocked ?? `Moves ${arm.name} to the recycle bin now. Restore from the recycle bin.`}
      onpointerenter={reached}
      onfocus={reached}
      onclick={confirm}>Delete it</button>
    <button
      class="verb cancel "
      data-verb-id="editor.delete-cancel"
      type="button"
      aria-label={VERB_MARK_WORD.cancel}
      title="Leaves the file exactly as it is."
      onclick={oncancel}>{VERB_MARK_WORD.cancel}</button>
  </div>
  <p class="why" aria-live="polite">
    {#if blocked !== null}
      {blocked}
    {:else}
      ready — pressing “delete it” moves {arm.name} to the recycle bin
    {/if}
  </p>
  <p class="clock">this confirmation expires in {secondsLeft}s</p>
</div>

<style>
  .confirm {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-3);
    border: var(--hairline-w) solid var(--line-2);
    border-left: var(--rule-w) solid var(--alarm);
    border-radius: var(--radius-1);
    background: var(--ground-2);
  }
  .loss {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-1);
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  /* The labelled-field recipe is owned by tokens.css (.cockpit .field). */
  .name {
    width: var(--editor-name-w);
    max-width: 100%;
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    padding: 0 var(--sp-2);
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    color: var(--ink-1);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb); the
   * confirmation's verbs keep the smaller engraved register, owned beside
   * it (.cockpit .engraved-ctl) and carried as a marker class. */
  /* The ONE place this room spends colour is now the OWNED armed state:
   * while the control is pressable it is `data-state="armed"`, and the
   * token owner's `.verb[data-state="armed"]` rule spends `--armed-edge`
   * (the alarm hue) on the edge — the treatment is declared once for every
   * armed control, not spelled per room. */
  .why {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-2);
  }
  .clock {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    font-variant-numeric: tabular-nums;
  }
</style>
