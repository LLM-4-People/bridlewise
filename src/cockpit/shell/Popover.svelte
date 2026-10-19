<script module lang="ts">
  /** Shared raised-surface focus lifetime. The inspector and Popover use
   * the same Tab containment and return-to-opener behavior. */
  export function focusSurface(node: HTMLElement, contain: boolean, opener: Element | null = document.activeElement, fallback?: () => HTMLElement | null): () => void {
    // Candidate selection is broad; eligibility applies to every selector
    // arm, including disabled controls with an explicit tabindex.
    const items = () => Array.from(node.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex], [contenteditable="true"], summary',
    )).filter(item => {
      if (item.tabIndex < 0 || item.matches(':disabled, input[type="hidden"]') || item.closest('[inert], [hidden]')) return false;
      if (getComputedStyle(item).visibility !== "visible") return false;
      for (let ancestor: HTMLElement | null = item; ancestor !== null; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).display === "none") return false;
        if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector("summary")?.contains(item)) return false;
      }
      return true;
    });
    (items()[0] ?? node).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent): void => {
      if (!contain || event.key !== "Tab") return;
      const list = items();
      if (list.length === 0) { event.preventDefault(); node.focus(); return; }
      const first = list[0]!, last = list[list.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault(); last.focus();
      }
    };
    if (contain) node.addEventListener("keydown", onKey, true);
    return () => {
      node.removeEventListener("keydown", onKey, true);
      // Wait for the owner's inert flags to clear before restoring focus.
      queueMicrotask(() => {
        const focused = document.activeElement;
        if (focused !== document.body && focused !== null && !node.contains(focused)) return;
        const target = opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]") ? opener : fallback?.();
        target?.focus({ preventScroll: true });
      });
    };
  }
</script>

<script lang="ts">
  import { VERB_MARK, VERB_MARK_WORD } from "./verb-marks.ts";
  /**
   * THE POPOVER — the one raised-surface primitive for the cockpit (§12).
   *
   * Before this existed, every menu drew its own box: the arm menu was a
   * flat grey rectangle with a stray `close` at the bottom, the beat menu a
   * rounded card, the setting sheet a bare column. Same system, three
   * accents. This owns the chrome so a menu is recognisably the same
   * instrument wherever it opens:
   *
   *   CAP     engraved micro-label, hairline rule under it, close at the
   *           pointer-target floor — the surface says what it is;
   *   BODY    one gutter (--sheet-pad), one rhythm (--sheet-gap), scrolls
   *           inside its own height cap rather than growing off-screen;
   *   ACTIONS its own rule, right-aligned — decisions live in one place.
   *
   * BEHAVIOUR every popover owes, and none should re-implement:
   *   - Esc dismisses — through the SHELL, not a listener of its own. This
   *     file used to take the key on the capture phase because `claimKey` was
   *     last-claim-wins and the SWEEP claimed `escape` after the FLOW mounted,
   *     so a popover that waited for the shell would sometimes never close.
   *     The shell now owns Esc as a dismissal ladder that closes the INNERMOST
   *     open surface first (shell/routing.ts): a popover pushes a layer while
   *     it exists, and one press closes it and nothing else. The listener that
   *     REMAINS is a focus trap, which is a different job for a different key
   *     (see below) — a popover mounted with no shell above it (the standalone
   *     harnesses) keeps a local Esc on its own element, which is the
   *     web-native pattern and not a global listener racing anyone;
   *   - a pointer press outside dismisses (the web-native menu contract);
   *   - focus MOVES IN on open and is TRAPPED while open, and returns to
   *     whatever opened it on close: a menu you can Tab out of while it
   *     still covers the screen is a keyboard trap in the other direction;
   *   - the entrance is a 6px rise over --t-2. `prefers-reduced-motion`
   *     collapses every --t-* to 1ms globally (tokens.css), so the rise
   *     lands in place instead of travelling — no per-component media query.
   *
   * POSITION is the caller's: `anchor` places the surface, because only the
   * caller knows what it hangs off. What this owns is that the surface can
   * never render taller than the viewport allows.
   */
  import { getContext, untrack, type Snippet } from "svelte";
  import { SHELL_CONTEXT_KEY, type ShellApi } from "./contract.ts";
  import { becauseArrived, moves } from "../motion/motion.ts";

  // The shell, when there is one. `getContext` must run at init, so it is read
  // here and not inside an effect. A popover in a standalone harness has no
  // shell above it and falls back to its own element-scoped Esc.
  const shell = getContext<ShellApi | undefined>(SHELL_CONTEXT_KEY);

  let {
    title,
    onclose,
    /** Right-aligned decision row. Omitted = no actions rule is drawn. */
    actions,
    children,
    /** Extra positioning applied to the surface by the caller. */
    style = "",
    /** APG dialog vs alertdialog (confirmations that interrupt). */
    kind = "dialog",
    /** ContextMenu owns its semantic menu and accessible name. It shares
     * this surface's focus/dismissal without repeating dialog chrome. */
    chrome = "dialog",
    /** Menu (420) vs picker (instrument-wide folder browse). */
    size = "menu",
    returnFocus,
  }: {
    title: string;
    onclose: () => void;
    actions?: Snippet;
    children: Snippet;
    style?: string;
    kind?: "dialog" | "alertdialog";
    chrome?: "dialog" | "menu";
    size?: "menu" | "picker";
    returnFocus?: (() => HTMLElement | null) | undefined;
  } = $props();

  let el = $state<HTMLElement | null>(null);

  /** Read ONCE, and `untrack` says so out loud: the identity of the menu that
   * arrived is the title it opened with. A later retitle is not a second
   * opening and must not re-run the rise. */
  const openedCause = {
    motion: "rise",
    cause: becauseArrived(
      untrack(() => title),
      "a menu opened under the control that opened it",
    ),
  } as const;
  /** Whatever had focus when this opened — the control that opened it. */
  let opener: Element | null = null;

  $effect(() => {
    const node = el;
    if (node === null) return;
    opener = document.activeElement;
    return focusSurface(node, true, opener, returnFocus);
  });

  // ESC — declared to the shell as a dismissal layer while this popover
  // exists. The shell closes the innermost layer first, so a popover opened
  // inside a scope inside a room takes the key ahead of both.
  $effect(() => {
    if (shell === undefined || el === null) return;
    return shell.pushDismiss({ label: `the ${title} menu`, dismiss: onclose });
  });

  /** Standalone fallback: no shell to route Esc, so the surface takes it on
   * its own element (focus is inside it by construction). Never registered
   * under a shell — two owners for one key is the defect this file dropped. */
  function onLocalKeydown(ev: KeyboardEvent): void {
    if (shell !== undefined || ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    onclose();
  }



  // A press outside dismisses — EXCEPT on the control that opened this. That
  // control is a toggle: closing here and letting its own click re-open on
  // the same gesture would make the menu impossible to dismiss from the
  // place a reader most expects to. The opener owns its own toggle.
  $effect(() => {
    const node = el;
    if (node === null) return;
    const onDown = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node)) return;
      if (node.contains(ev.target)) return;
      if (opener !== null && (opener === ev.target || opener.contains(ev.target))) return;
      onclose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  });
</script>

<!-- THE SIGNAL THE RISE IS BOUND TO. This component exists only while the
     menu is open, so its arrival IS the opening — computed once, outside any
     reactive scope, because a cause is spent when it is used and a menu rises
     once per opening rather than once per render. -->
<div
  bind:this={el}
  class="popover"
  class:picker={size === "picker"}
  class:context-menu={chrome === "menu"}
  use:moves={openedCause}
  role={chrome === "menu" ? undefined : kind}
  aria-modal={chrome === "menu" ? undefined : true}
  aria-label={chrome === "menu" ? undefined : title}
  tabindex="-1"
  onkeydown={onLocalKeydown}
  {style}
>
  {#if chrome !== "menu"}<header class="cap">
    <span class="cap-word">{title}</span>
    <button class="verb close " data-verb-id="popover.close" aria-label={VERB_MARK_WORD.close} title="close this menu (Esc)" onclick={onclose}>{VERB_MARK.close}</button>
  </header>{/if}
  <div class="body">
    {@render children()}
  </div>
  {#if actions !== undefined}
    <footer class="actions">
      {@render actions()}
    </footer>
  {/if}
</div>

<style>
  .popover {
    position: absolute;
    z-index: 40;
    display: flex;
    flex-direction: column;
    min-width: var(--menu-min-w);
    max-width: var(--popover-max-w);
    max-height: calc(100vh - var(--sp-7));
    background: var(--ground-3);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-2);
    box-shadow: var(--shadow-sheet);
    color: var(--ink-1);
    font-size: var(--f-ui-size);
    /* The 6px rise is declared by the token owner against
     * `[data-motion="rise"]`, not here: an `animation:` in a component's own
     * block starts itself and names nothing, which is what §11.8's mechanism
     * exists to end. `use:moves` above is what puts the attribute there, and
     * it will not do so without a cause. */
  }
  .popover.picker {
    max-width: var(--picker-max-w);
  }
  .popover.context-menu { min-width: 0; }
  .context-menu > .body { padding: var(--sp-1); gap: var(--sp-1); }
  /* The cap row's spine is owned by tokens.css (.cockpit .cap); the
   * popover's cap is the edged variant that closes the raised surface. */
  .cap {
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-2) var(--sheet-pad);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  .cap-word { min-width: 0; overflow-wrap: anywhere; }
  /* The cap word's engraved recipe is owned by tokens.css (.cockpit .cap-word). */
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: var(--sheet-gap);
    padding: var(--sheet-pad);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sheet-pad);
    border-top: var(--hairline-w) solid var(--line-1);
  }
</style>
