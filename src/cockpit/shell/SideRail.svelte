<script lang="ts">
  /** The existing inspector toggle, now in the shared header so every room
   * and conversation keeps the same entry without reserving a blank column. */
  import { chordFor } from "./keyboard.ts";
  import { RIGHT_MENU_TITLE, toggleRightMenu, type RightMenuId } from "./right-menu.ts";

  let {
    revealed,
    menu,
  }: {
    /** Boot-complete: the icon is inert chrome until the reveal. */
    revealed: boolean;
    /** The host's open menu (its landed group), so the button announces
     * its own toggle state (`aria-pressed`) — a docked column steals no
     * focus, so without this a screen reader is told nothing when it
     * appears. */
    menu: RightMenuId | null;
  } = $props();

  /** Both chords, taught from the grammar table's own spellings. */
  const t = $derived(
    `${RIGHT_MENU_TITLE} · ${chordFor("run")} lands at the run group · ${chordFor("arm")} at the arm group`,
  );
</script>

<nav class="side-rail" aria-label={RIGHT_MENU_TITLE}>
  <!-- One grip, the grammar target spelled LITERALLY (see the header): the
       click lands at the run group; the arm chord's own control is the arm
       group's cap inside the open menu. -->
  <button
    type="button"
    class="verb bare rail-grip"
    data-chord-target="run"
    data-verb-id="chord.run"
    title={t}
    aria-label={`${RIGHT_MENU_TITLE} · open or close`}
    aria-pressed={menu !== null}
    disabled={!revealed}
    onclick={() => toggleRightMenu("run")}
  ><svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14 4v16M17 8h1M17 12h1M17 16h1"/></svg></button>
</nav>

<style>
  .side-rail { display: flex; flex: none; align-items: center; }
  .rail-grip { padding: 0; width: var(--hit-min); height: var(--hit-min); }
  .glyph { width: var(--mark-size); height: var(--mark-size); fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .rail-grip[aria-pressed="true"] { color: var(--accent); background: var(--accent-soft); }
</style>
