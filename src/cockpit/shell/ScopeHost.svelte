<script lang="ts">
  import { VERB_MARK, VERB_MARK_WORD } from "./verb-marks.ts";
  /**
   * SCOPE host (§2 shell grammar) — the inspector. A right sheet
   * min(560px, 42vw). At ≥1900px viewport the shell side-docks it (the
   * FLOW narrows — see Cockpit.svelte's grid); below, it overlays.
   * Esc closes (shell keyboard owner). Bodies are supplied by surfaces
   * via `shell.openScope({ title, component, props })`.
   */
  import type { Component } from "svelte";
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";
  import type { ScopeRequest, ShellApi } from "./contract.ts";
  import { mouseTitleFor } from "./keyboard.ts";

  // MOUSE-FIRST law (v2.1): the close button IS the click path for the
  // `escape` grammar, and its tooltip teaches the chord (grammar-derived).
  const tEscape = mouseTitleFor("escape");

  let {
    shell,
    request,
    docked,
    overRoom = false,
    onClose,
  }: {
    shell: ShellApi;
    request: ScopeRequest | null;
    docked: boolean;
    /** True when this sheet's dismissal context is the room ON SCREEN — the
     *  shell (Cockpit) decides it from the same fact the Esc ladder uses, so
     *  the paint order and the dismissal order cannot disagree. */
    overRoom?: boolean;
    onClose: () => void;
  } = $props();

  /**
   * THE SIGNAL THIS SHEET'S ARRIVAL IS BOUND TO — the scope's subject becoming
   * a different subject. The slide used to be a bare `animation:` in this
   * file's own style block, which fired on mount and named nothing; it was
   * honest by accident (a sheet only mounts when someone opened it) and there
   * was no mechanism keeping it that way. Now the movement cannot start
   * without this transition existing, and `becauseChanged` REFUSES an
   * unchanged pair — so a re-render that opens the same subject again does not
   * re-slide a sheet that never went anywhere.
   */
  let lastSubject: string | null = null;
  const arrival = $derived.by((): MovesParam => {
    const subject = request === null ? null : request.title;
    if (subject === lastSubject) return null; // a re-render is not an opening
    const previous = lastSubject;
    lastSubject = subject;
    return subject === null || docked
      ? null
      : {
          motion: "sheet-in",
          cause: becauseChanged("the scope sheet's subject", previous, subject),
        };
  });

  const Body = $derived(
    request !== null && request.component !== undefined
      ? (request.component as Component<Record<string, unknown>>)
      : null,
  );

  // Focus MOVES INTO the sheet when it opens and returns to whatever opened
  // it when it closes. Without this the sheet is a surface you can only read
  // with a mouse: Tab stays behind it in the FLOW, and a reader who opened a
  // strip row with the keyboard is left pointing at a row whose detail is
  // now somewhere they cannot reach. Not a trap — the sheet is a sibling
  // region, so Tab leaves it normally; only the entry point is placed.
  let sheetEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const node = sheetEl;
    if (node === null) return;
    const opener = document.activeElement;
    node.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  });
</script>

{#if request !== null}
  <aside
    class="scope"
    class:docked
    class:over-room={overRoom}
    use:moves={arrival}
    bind:this={sheetEl}
    tabindex="-1"
    aria-label={`scope — ${request.title}`}
  >
    <header class="cap">
      <span class="engraved">{request.title}</span>
      <button
        class="verb close "
        data-verb-id="scope.close" aria-label={VERB_MARK_WORD.close}
        data-chord-target="escape"
        title={tEscape}
        onclick={onClose}
      >{VERB_MARK.close}</button>
    </header>
    <div class="body">
      {#if Body !== null}
        <Body {...(request.props ?? {})} shell={shell} />
      {:else}
        <Answer answer={absent("nothing to inspect yet")} />
      {/if}
    </div>
  </aside>
{/if}

<style>
  .scope {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--scope-w);
    z-index: 20;
    background: var(--ground-3);
    border-left: var(--hairline-w) solid var(--line-2);
    box-shadow: var(--shadow-sheet);
    display: flex;
    flex-direction: column;
    /* THE SLIDE IS NOT DECLARED HERE. The overlay sheet slides in from the
     * edge it belongs to, so where it came from is legible instead of it
     * simply appearing — but a `animation:` in a component's own block starts
     * itself and names nothing, which is the exact shape §11.8 forbids. The
     * rule lives in the token owner against `[data-motion="sheet-in"]`, and
     * the `use:moves` above is what puts the attribute there, in exchange for
     * a cause. */
  }
  /* Side-docked, the sheet is part of the layout, not a thing that arrived
   * over it — sliding a column of the grid would be a lie about what moved.
   * Expressed as "no cause is offered while docked" (see `use:moves` above)
   * rather than as an `animation: none` override, because a motion nobody
   * asked for should not need cancelling. */
  .scope.docked {
    position: static;
    box-shadow: none;
    height: 100%;
  }
  /* STACKING FOLLOWS THE DISMISSAL LADDER (shell/routing.ts). A sheet whose
   * dismissal context is the room ON SCREEN is the surface Esc takes FIRST,
   * so it must paint above the room plane (RoomHost's 30) — a sheet opened
   * from inside a room that painted UNDER it was the invisible `,`-chord
   * defect. Below the Horizon/Popover layer (40): the sheet is still a
   * sheet, not a transient. The base z of 20 above stays: a sheet from a
   * DIFFERENT context sits under the room, exactly as Esc closes the room
   * first. Guard: tests/cockpit/setting-chord.test.ts asserts this file's
   * over-room z against RoomHost's room z, and drives both directions. */
  .scope.over-room {
    z-index: 32;
  }
  /* The cap row's spine is owned by tokens.css (.cockpit .cap); the scope
   * host's cap is the HORIZON-height variant, edged and padded. */
  .cap {
    height: var(--horizon-h);
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-4);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  /* One interior gutter and one rhythm, shared with every other raised
   * surface (--sheet-pad / --sheet-gap, tokens.css). A sheet body that sets
   * its own spacing is how three inspectors come to feel like three
   * different products. */
  .body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sheet-gap);
    padding: var(--sheet-pad);
  }
</style>
