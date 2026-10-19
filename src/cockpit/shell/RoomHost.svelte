<script lang="ts">
  import { VERB_MARK, VERB_MARK_WORD } from "./verb-marks.ts";
  /**
   * ROOMS host (§2.5) — full-screen surfaces summoned by key or verb, one
   * at a time, Esc closes (the shell's keyboard owner calls `closeRoom`).
   * The flow's state is KEPT ALIVE under the room: the shell hides the
   * stack with CSS (`visibility`), it never unmounts it — keep-alive
   * re-implemented in the cockpit shell, not via any old component.
   *
   * ROOMS ARE KEPT ALIVE THE SAME WAY, and this is the whole answer to
   * "every menu we go, every options reloads". A room used to mount on open
   * and UNMOUNT on close, so every reopen rebuilt the component tree from
   * nothing: scroll snapped to the top, expansion state vanished, canvases
   * repainted, and the feed re-acquired as if the session had just begun.
   * Now every VISITED room stays mounted and the inactive ones are hidden
   * with `visibility: hidden` — which keeps the element's box (so `scrollTop`
   * survives), takes it out of the tab order, and makes it inert to the
   * pointer. Reopening is a CSS flip: the same DOM, at the same scroll, with
   * the same values already painted.
   *
   * WHY VISIBILITY AND NOT `display: none` OR AN `{#if}`. `{#if}` unmounts —
   * that is the defect. `display: none` removes the box, and a removed box has
   * no scroll offset to remember, so reopening lands at the top; it also
   * forces a fresh layout of the whole subtree on every open. `visibility`
   * keeps the box, keeps the offset, and costs nothing but paint.
   *
   * COST CONTROL. Only rooms the user has ACTUALLY VISITED are in the stack —
   * the shell adds one on first open and never speculatively. A hidden room's
   * feed goes quiet through `room-visibility.ts` (the `visibleRoom` store this
   * host does not write; Cockpit.svelte does), so keep-alive costs DOM, never
   * requests.
   *
   * Room components come from `src/cockpit/rooms/<Id>Room.svelte` (see
   * contract.ts). The host renders nothing until a room has been opened once.
   */
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";
  import { becauseChanged, moves } from "../motion/motion.ts";
  import type { RoomId, ShellApi, VisitedRoom } from "./contract.ts";
  import { mouseTitleFor } from "./keyboard.ts";

  // MOUSE-FIRST law (v2.1): the close button IS the click path for the
  // `escape` grammar, and its tooltip teaches the chord (grammar-derived).
  const tEscape = mouseTitleFor("escape");

  /** One kept-alive room: its id and its loaded component (null = the file
   *  does not exist yet, which is an honest state, not a failure). The type
   *  itself lives in contract.ts — the ONE seam the shell publishes. */
  let {
    shell,
    roomId,
    visited,
    covered = false,
    onClose,
  }: {
    shell: ShellApi;
    /** The room ON SCREEN, or null when none is open. */
    roomId: RoomId | null;
    /** Every room opened at least once this session, in first-visit order.
     *  Keyed by id, so the stack is stable and Svelte never re-creates a
     *  kept-alive subtree. */
    visited: readonly VisitedRoom[];
    covered?: boolean;
    onClose: () => void;
  } = $props();

  /**
   * THE ROOM CUT. Sheets slide in from an edge (`sheet-in`); a room is the
   * plane, so the cut is a fade (`cut`). `becauseChanged` refuses an
   * unchanged pair. The FIRST assignment is the landing Switch inside the
   * one-reveal frame — there is no previous room, so there is no cut
   * (ScopeHost's previous-null skip, same reason).
   *
   * Stamped ONCE onto the arriving node (not `use:moves` on every
   * keep-alive section): a shared MovesParam in `{#each}` is consumed by
   * the first action and refused by the second.
   */
  const roomEls = new Map<RoomId, HTMLElement>();
  function remember(node: HTMLElement, id: RoomId) {
    roomEls.set(id, node);
    return {
      destroy(): void {
        if (roomEls.get(id) === node) roomEls.delete(id);
      },
    };
  }

  let lastOpen: RoomId | null = null;
  let cutHandle: { destroy(): void } | null = null;
  $effect(() => {
    const next = roomId;
    if (next === null) return;
    const previous = lastOpen;
    lastOpen = next;
    if (previous === null || previous === next) return;
    const node = roomEls.get(next);
    if (node === undefined) return;
    cutHandle?.destroy();
    const prevNode = roomEls.get(previous);
    if (prevNode !== undefined) {
      prevNode.removeAttribute("data-motion");
      prevNode.removeAttribute("data-motion-cause");
      prevNode.removeAttribute("data-motion-signal");
    }
    cutHandle = moves(node, {
      motion: "cut",
      cause: becauseChanged("the open room", previous, next),
    });
  });
</script>

{#each visited as entry (entry.id)}
  {@const active = entry.id === roomId}
  <!-- `inert` ALONE hides a kept-alive room from assistive technology, the
       tab order and the pointer. `aria-hidden` used to sit beside it and was
       both redundant and wrong: closing a room while focus was inside it
       left aria-hidden over a focused descendant — the exact state Chrome
       flags, with `inert` as its prescribed fix, because a hidden-but-
       focused element still talks to the screen reader. -->
  <section
    class="room"
    class:hidden={!active}
    aria-label={`${entry.id} room`}
    inert={!active || covered}
    data-room-active={active}
    use:remember={entry.id}
  >
    <header class="cap">
      <span class="engraved">{entry.id.charAt(0).toUpperCase() + entry.id.slice(1)}</span>
      <button
        class="verb close "
        data-verb-id="room.close" aria-label={VERB_MARK_WORD.close}
        data-chord-target="escape"
        title={tEscape}
        onclick={onClose}
        tabindex={active ? 0 : -1}
      >{VERB_MARK.close}</button>
    </header>
    <div class="body">
      {#if entry.comp !== null}
        {@const Room = entry.comp}
        <Room {shell} />
      {:else}
        <Answer answer={absent(`${entry.id} — not built yet`)} />
      {/if}
    </div>
  </section>
{/each}

<style>
  .room {
    position: absolute;
    /* Below the HORIZON so the room-tab rail stays the mouse path into
     * Chat and the other rooms. A room that paints over the tabs makes
     * Chat chord-only — the inverse of mouse-first. */
    top: var(--room-top, var(--horizon-h));
    right: var(--room-right, 0px);
    bottom: 0;
    left: 0;
    z-index: 30;
    background: var(--ground-0);
    display: flex;
    flex-direction: column;
  }
  /* KEEP-ALIVE (see the header comment). `visibility: hidden` keeps the box —
   * and therefore every descendant's `scrollTop` — while removing the room
   * from the tab order and from hit-testing. `display: none` would destroy
   * both the scroll offset and the layout, which is the cold start again by
   * another name. */
  .room.hidden {
    visibility: hidden;
  }
  /* The cap row's spine is owned by tokens.css (.cockpit .cap); the room
   * host's cap is the HORIZON-height variant, edged and padded as the room's
   * own header. */
  .cap {
    height: var(--horizon-h);
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-4);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: grid;
    /* ONE COLUMN THAT MAY SHRINK. `place-items: center` sizes the item to
     * max-content and then centres the overflow: the inline-start edge
     * leaves the scrollport (CSS Box Alignment default is unsafe), so a
     * labelled map loses its first glyphs. `minmax(0, 1fr)` still lets a
     * wrapping layout inside a room wrap instead of shoving the room
     * sideways. Stretch fills the cell from the start edge; a room that
     * wants a narrow column (Instruments) self-centers with max-width +
     * margin, not by centering the grid item. */
    grid-template-columns: minmax(0, 1fr);
    justify-items: stretch;
    align-items: stretch;
  }
</style>
