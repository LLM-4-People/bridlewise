<script lang="ts">
  import { VERB_MARK } from "./verb-marks.ts";
  /**
   * THE `+` — one control, two homes.
   *
   * It sits beside the place (`project ▸ conversation`) while there is a
   * single workspace, and moves into the tab strip as soon as there are
   * two. Both are the same component so the two homes cannot drift into two
   * different affordances with two different words.
   *
   * Chrome is the owned `.verb`. `.new-tab` is the identity marker the
   * two homes and the strip tests share — layout only (gap, flex).
   *
   * IT SAYS WHAT IT DOES. A bare `+` is a symbol you have to already know;
   * the words next to it are the whole zero-knowledge story — "new tab" is
   * the user's own vocabulary for this ("kinda like terminal tab"), and the
   * tooltip spells out what lands in it. It does not teach a chord because
   * it does not have one: adding a keystroke here would be a second thing to
   * learn for a control that is, by design, the most visible one on screen.
   *
   * What it opens is the Switch (§5.2) — the one place you choose what to
   * work on — with the choice armed to land in a new tab instead of
   * replacing this one (shell/open-intent.ts). There is no second picker.
   */
  let {
    onclick,
    disabled = false,
  }: {
    onclick: () => void;
    disabled?: boolean;
  } = $props();

  /** One owner for the words, so the two homes say the same thing. */
  const NEW_TAB_TITLE =
    "open another project or conversation in a new tab; this one stays open";
</script>

<button
  class="verb add new-tab"
  data-verb-id="workspace.open"
  title={NEW_TAB_TITLE}
  aria-label={NEW_TAB_TITLE}
  {disabled}
  {onclick}
>
  <span class="plus" aria-hidden="true">{VERB_MARK.add}</span>
  <span class="word">New tab</span>
</button>

<style>
  .new-tab {
    gap: var(--sp-1);
    flex: none;
  }
  .plus {
    font-family: var(--face-mono);
    font-size: var(--f-ui-size);
    line-height: var(--lh-tight);
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved). */
  .word {
    display: var(--new-tab-word-display);
    white-space: nowrap;
  }
</style>
