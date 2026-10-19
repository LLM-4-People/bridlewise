<script lang="ts" module>
  import type { RoomChordId } from "./room-chords.ts";
  /**
   * One entry in a row's context menu. `run` IS the row's existing handler —
   * the whole point of this component is that a right-click lists the verbs
   * a row already has, wired to the identical functions, so there is never a
   * second action path to drift from the first.
   */
  export type MenuVerb = Readonly<{
    /** The verb's registry name — the same `data-verb-id` the visible
     * control carries, so the menu entry and the control are greppably one
     * action. */
    id: string;
    label: string;
    /** Plain words for what this does (zero-knowledge law). */
    title: string;
    /** Capability exposed by this deliberate menu path, when it has a chord. */
    roomChord?: RoomChordId;
    run: () => void;
  }>;
</script>

<script lang="ts">
  /**
   * THE ROW CONTEXT MENU — right-click on a row, get that row's
   * OWN verbs, in the one raised-surface primitive the cockpit has.
   *
   * This is a projection, not a surface with opinions: the caller hands the
   * verbs it already renders (same handlers, same ids), this component lays
   * them into a Popover at the pointer. Everything a menu owes — Esc through
   * the shell's dismissal ladder, pointer-outside dismissal, the focus trap,
   * focus return, the arrival-caused rise — comes from Popover and is not
   * re-implemented here.
   *
   * A menu with no verbs cannot be spelled usefully: callers refuse to open
   * one (they leave the browser's native menu alone), and this component
   * renders the honest absence if it is ever handed none anyway.
   */
  import Popover from "./Popover.svelte";
  import { onMount, type Snippet } from "svelte";
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";

  let {
    title,
    verbs,
    at,
    onclose,
    children,
    returnFocus,
  }: {
    /** What the menu is about, in the reader's words ("this conversation"). */
    title: string;
    verbs: readonly MenuVerb[];
    /** The pointer position the menu opens at (viewport coordinates). */
    at: Readonly<{ x: number; y: number }>;
    onclose: () => void;
    children?: Snippet;
    returnFocus?: (() => HTMLElement | null) | undefined;
  } = $props();
  let menu: HTMLDivElement | undefined = $state();
  let height = $state(0);
  let width = $state(0);
  onMount(() => {
    const panel = menu?.closest<HTMLElement>(".popover");
    if (panel === undefined || panel === null) return;
    const measure = () => { height = panel.offsetHeight; width = panel.offsetWidth; };
    const observer = new ResizeObserver(measure);
    observer.observe(panel); measure();
    menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    return () => observer.disconnect();
  });
  function navigate(event: KeyboardEvent): void {
    if (menu === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index + items.length - 1) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key.length === 1 && event.key !== " ") {
      for (let step = 1; step <= items.length; step++) {
        const item = items[(index + step) % items.length]!;
        if (item.textContent?.trim().toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())) { next = item; break; }
      }
    }
    if (next !== undefined) { event.preventDefault(); event.stopPropagation(); next.focus(); }
  }
</script>

<Popover {title} {onclose} {returnFocus} chrome="menu" style={`position: fixed; width: max-content; max-width: min(var(--popover-max-w), calc(100vw - 2 * var(--sp-3))); left: clamp(var(--sp-3), ${at.x}px, calc(100vw - ${width}px - var(--sp-3))); top: clamp(var(--sp-3), ${at.y}px, calc(100dvh - ${height}px - var(--sp-3))); max-height: calc(100dvh - 2 * var(--sp-3));`}>
  <div class="menu-items" role="menu" tabindex="-1" aria-label={title} bind:this={menu} onkeydown={navigate}>
    {#if verbs.length === 0}
      <Answer answer={absent("this row has no actions")} />
    {/if}
    {#each verbs as verb (verb.id)}
      <button
        class="verb menu"
        role="menuitem"
        type="button"
        data-verb-id={verb.id}
        data-room-chord={verb.roomChord}
        title={verb.title}
        onclick={(ev) => {
          // The menu floats INSIDE the row it describes, and the row has its
          // own click verb — a menu click must not fall through and fire it.
          ev.stopPropagation();
          verb.run();
          onclose();
        }}
      >{verb.label}</button>
    {/each}
  </div>
  {#if children !== undefined}{@render children()}{/if}
</Popover>

<style>
  .menu-items {
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
    min-width: 0;
  }
</style>
