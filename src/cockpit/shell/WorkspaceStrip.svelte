<script lang="ts">
  import { VERB_MARK } from "./verb-marks.ts";
  /**
   * THE TAB STRIP — several projects open at once, in one page.
   *
   * THE USER'S ASK, verbatim: "we should also be able to work on multiple
   * projects from the same tab, kinda like terminal tab, like we should have
   * a + at the top with tabs open for projects/chats", and then "we don't
   * have a + button beside the conversation title at the top left of the
   * page to allow us to open another conversation/project."
   *
   * WHERE IT LIVES. A row of its own directly under the HORIZON, and ONLY
   * when there is more than one workspace to name. The HORIZON is 40px and
   * three fixed columns (§2.4) — tabs do not fit in it, and a fourth thing
   * competing for the left column would be the crowding the spec spends a
   * whole section refusing. With one workspace there is nothing to switch
   * between, so the strip is absent and the place chip keeps its job; the
   * `+` is visible either way, because a control you only get after you
   * already have two of something cannot be how you get the second one.
   *
   * IT NEVER SAYS THE SAME THING TWICE (§1.4). The active tab names
   * `project ▸ conversation`; the place chip in the HORIZON names exactly
   * that pair. So when the active tab is on screen, the place chip
   * collapses — and when the strip is so narrow that not even one tab fits,
   * the chip comes back, because then nothing else is naming it. The shell
   * owns that switch; this component reports which of the two cases holds
   * (`onactivevisible`).
   *
   * NOTHING IS EVER CLIPPED. Tabs are sized to their own words and the ones
   * that do not fit fold behind a single control — the same idiom the room
   * rail already uses below 1100px, not a second one invented here. A
   * half-drawn conversation name is a different name, and this project has
   * already had that defect reported once. See shell/tab-fit.ts for the
   * arithmetic, which is where the no-clip rule is actually enforced.
   *
   * NO LAYOUT SHIFT. Every tab carries its border and its padding at rest;
   * hover and the active state change colour and nothing else. The strip
   * measures in a hidden gauge row rather than by growing and shrinking the
   * real one, so a fit decision cannot be seen happening.
   */
  import { untrack } from "svelte";

  import {
    activateWorkspace,
    activeWorkspaceId,
    closeWorkspace,
    moveWorkspace,
    workspaceLabel,
    workspaces,
    type Workspace,
  } from "../../state/workspaces.ts";
  import { projects } from "../../state/projects.ts";
  import { chatChanges, chatForId } from "../../state/chats.ts";
  import { fitTabs, type Fit } from "./tab-fit.ts";
  import ContextMenu, { type MenuVerb } from "./ContextMenu.svelte";
  import NewTabButton from "./NewTabButton.svelte";
  import Popover from "./Popover.svelte";

  let {
    revealed,
    onnewtab,
    onactivevisible,
  }: {
    revealed: boolean;
    /** The `+`: arm the Switch to land in a new tab, and open it. */
    onnewtab: () => void;
    /** True while the ACTIVE workspace is named by a rendered tab — the
     * shell hides the place chip exactly then (§1.4). */
    onactivevisible: (visible: boolean) => void;
  } = $props();

  // ── The labels ─────────────────────────────────────────────────────────
  //
  // Names come from the real stores. When a name is genuinely not loaded
  // yet the tab SAYS SO rather than inventing one or falling back to an id:
  // "not loaded yet" is a fact, "Untitled" would be a fabrication and
  // `p_8f21` would teach nothing (§1.1, zero-knowledge law).

  const projectNames = $derived(new Map($projects.map((p) => [p.id, p.name])));
  let chatTitleVersion = $state(0);
  $effect(() => {
    const membership = new Set($workspaces.map(workspace => workspace.projectId));
    return chatChanges.listen(({ projectIds }) => {
      if (projectIds === null || projectIds.some(id => membership.has(id))) {
        untrack(() => { chatTitleVersion += 1; });
      }
    });
  });

  function labelFor(ws: Workspace): string {
    void chatTitleVersion;
    return workspaceLabel(
      ws,
      (id) => projectNames.get(id) ?? "project not loaded yet",
      (id) => {
        const chat = chatForId(id);
        return chat === null ? "conversation not loaded yet" : chat.title || "untitled conversation";
      },
    );
  }

  const list = $derived($workspaces);
  const labels = $derived(list.map(labelFor));
  const activeIndex = $derived(list.findIndex((w) => w.id === $activeWorkspaceId));
  /** One string that changes whenever any tab's words change — the fit's
   * dependency on the LABELS, stated as a value rather than as a stray read. */
  const labelKey = $derived(labels.join("\n"));

  // ── The fit ────────────────────────────────────────────────────────────

  let stripEl = $state<HTMLElement | null>(null);
  let gaugeEl = $state<HTMLElement | null>(null);
  let newSlotEl = $state<HTMLElement | null>(null);
  let availW = $state(0);
  /**
   * `null` = not measured yet, which renders EVERY tab. That is the right
   * first frame: the alternative (start at zero tabs and fill in) would take
   * the place chip away and give it back inside one frame, and a chip that
   * blinks on boot is a layout shift with extra steps.
   */
  let fit = $state<Fit | null>(null);
  let foldOpen = $state(false);

  const window_ = $derived(fit ?? { start: 0, count: list.length, activeVisible: activeIndex >= 0 });
  const visible = $derived(list.slice(window_.start, window_.start + window_.count));
  const hidden = $derived([
    ...list.slice(0, window_.start),
    ...list.slice(window_.start + window_.count),
  ]);

  /**
   * Measure, then decide. The measurements come from a hidden gauge row that
   * renders EVERY tab at its natural width, so a tab that is currently
   * folded away is measured exactly like one on screen — without it, a tab
   * could never earn its way back in.
   *
   * Reads of `fit` are untracked: comparing against the value this effect
   * writes would make the effect its own dependency and it would never
   * settle.
   */
  $effect(() => {
    // Dependencies, named explicitly: the words, how many, and how much room.
    labelKey;
    const room = availW;
    const strip = stripEl;
    const gauge = gaugeEl;
    newSlotEl;
    if (strip === null || gauge === null) return;

    const measured = [...gauge.querySelectorAll<HTMLElement>("[data-gauge-tab]")].map(
      (el) => el.offsetWidth,
    );
    const newButton = newSlotEl?.offsetWidth ?? 0;
    const fold = gauge.querySelector<HTMLElement>("[data-gauge-fold]")?.offsetWidth ?? 0;
    const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;

    const next = fitTabs({
      widths: measured,
      gap,
      available: room,
      newButton,
      fold,
      activeIndex,
      start: untrack(() => fit?.start ?? 0),
    });
    const current = untrack(() => fit);
    if (
      current === null ||
      next.start !== current.start ||
      next.count !== current.count ||
      next.activeVisible !== current.activeVisible
    ) {
      fit = next;
    }
  });

  // The shell learns whether the active pair is named down here, so it can
  // decide whether the place chip is still needed. Reported from its own
  // effect so it fires on the value, not on every measurement pass.
  $effect(() => {
    onactivevisible(window_.activeVisible);
  });

  // ── Verbs ──────────────────────────────────────────────────────────────

  function open(ws: Workspace): void {
    foldOpen = false;
    if (ws.id === activeWorkspaceId.get()) return;
    activateWorkspace(ws.id);
  }

  function close(ws: Workspace): void {
    // The last one is refused by the state owner (a cockpit with no
    // workspace has nothing to render and no way back) — say so rather than
    // letting the click do nothing.
    if (!closeWorkspace(ws.id)) return;
    if (hidden.length === 0) foldOpen = false;
  }

  const closeTitle = (label: string): string =>
    list.length <= 1
      ? "this is the only tab open — it cannot be closed"
      : `close this tab — ${label}`;

  // ── The tab context menu ─────────────────────────────────────
  //
  // A tab's verbs are the two its buttons already render — switch to it and
  // close it — wired to the SAME handlers. The close verb appears exactly
  // when the close button is pressable (the last tab cannot be closed, and
  // the strip's own button says why), so the menu can never be a second door
  // past that refusal.
  let tabMenu = $state<Readonly<{ at: { x: number; y: number }; ws: Workspace }> | null>(null);

  function tabMenuVerbs(ws: Workspace): readonly MenuVerb[] {
    const label = labelFor(ws);
    const verbs: MenuVerb[] = [
      {
        id: "workspace.activate",
        label: "switch to",
        title: ws.id === $activeWorkspaceId ? `you are here — ${label}` : `switch to ${label}`,
        run: () => open(ws),
      },
    ];
    if (list.length > 1) {
      verbs.push({
        id: "workspace.close",
        label: "close",
        title: closeTitle(label),
        run: () => close(ws),
      });
    }
    return verbs;
  }

  function onTabMenu(ev: MouseEvent, ws: Workspace): void {
    if (!revealed) return;
    ev.preventDefault();
    tabMenu = { at: { x: ev.clientX, y: ev.clientY }, ws };
  }

  // ── drag to reorder ────────────────────────────────────────────────────
  //
  // POINTER EVENTS with capture, like every drag in this shell — never the
  // HTML5 drag API (ghost images, gestures dropped at the first missed
  // dragover). The tab REORDERS LIVE under the pointer: crossing a
  // neighbour's midpoint moves the workspace in the ONE order owner
  // (state/workspaces.moveWorkspace), whose write-through persists it like
  // any other list change. There is no second order to reconcile on drop —
  // release simply ends the gesture.
  //
  // A drag is not a click: the press that started it must not also switch
  // tabs on release, so a gesture that crossed the start threshold swallows
  // the click that follows it. Below the threshold, a press is a click.
  const DRAG_START_PX = 4;
  let tabDrag = $state<{ id: string; pointerId: number; startX: number; moved: boolean } | null>(
    null,
  );

  function onTabPointerDown(ev: PointerEvent, ws: Workspace): void {
    if (!revealed || ev.button !== 0) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    tabDrag = { id: ws.id, pointerId: ev.pointerId, startX: ev.clientX, moved: false };
  }

  function onTabPointerMove(ev: PointerEvent): void {
    const drag = tabDrag;
    if (drag === null || ev.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(ev.clientX - drag.startX) < DRAG_START_PX) return;
    if (!drag.moved) tabDrag = { ...drag, moved: true };
    const slots = [...(stripEl?.querySelectorAll<HTMLElement>(".tabs .slot") ?? [])];
    if (slots.length === 0) return;
    // The rendered slots ARE the visible window, in order: the drop position
    // is how many of their midpoints the pointer has passed.
    let passed = 0;
    for (const slot of slots) {
      const r = slot.getBoundingClientRect();
      if (ev.clientX > r.left + r.width / 2) passed += 1;
    }
    const from = visible.findIndex((w) => w.id === drag.id);
    if (from === -1) return;
    const to = passed > from ? passed - 1 : passed;
    if (to !== from) moveWorkspace(drag.id, window_.start + to);
  }

  function onTabPointerUp(ev: PointerEvent): void {
    if (tabDrag === null || ev.pointerId !== tabDrag.pointerId) return;
    const moved = tabDrag.moved;
    tabDrag = null;
    // The click event fires after pointerup on the same button; a real drag
    // must not turn into a tab switch.
    if (moved) swallowClick = true;
  }

  let swallowClick = false;

  function onTabClick(ws: Workspace): void {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    open(ws);
  }

  // ── middle-click closes ────────────────────────────────────────────────
  //
  // The browser-tab gesture, wired to the SAME close path as the × — the
  // last-tab refusal lives in the state owner (`closeWorkspace`), so this
  // cannot be a second door past it. Strictly button 1: a right press also
  // raises auxclick, and that one belongs to the context menu.
  function onTabAuxClick(ev: MouseEvent, ws: Workspace): void {
    if (ev.button !== 1 || !revealed) return;
    ev.preventDefault();
    close(ws);
  }

  /** A middle PRESS starts the browser's autoscroll unless refused here —
   * the aux CLICK arrives too late to stop it. */
  function refuseAutoscroll(ev: MouseEvent): void {
    if (ev.button === 1) ev.preventDefault();
  }
</script>

<div class="workspace-strip" bind:this={stripEl} bind:clientWidth={availW}>
  <nav class="tabs" aria-label="open tabs">
    {#each visible as ws, i (ws.id)}
      {@const label = labels[window_.start + i] ?? ""}
      {@const active = ws.id === $activeWorkspaceId}
      <span class="slot" class:active>
        <button
          class="tab"
          class:dragging={tabDrag?.moved === true && tabDrag.id === ws.id}
          data-verb-id="workspace.activate"
          data-workspace-id={ws.id}
          aria-current={active ? "page" : undefined}
          title={(active ? `You are here: ${label}` : `Switch to ${label}`) +
            " · drag to reorder" +
            (list.length > 1 ? " · middle-click closes" : "")}
          disabled={!revealed}
          onclick={() => onTabClick(ws)}
          onauxclick={(ev) => onTabAuxClick(ev, ws)}
          onmousedown={refuseAutoscroll}
          onpointerdown={(ev) => onTabPointerDown(ev, ws)}
          onpointermove={onTabPointerMove}
          onpointerup={onTabPointerUp}
          onpointercancel={onTabPointerUp}
          oncontextmenu={(ev) => onTabMenu(ev, ws)}
        >{label}</button>
        <button
          class="verb bare close tab-close"
          data-verb-id="workspace.close"
          aria-label={closeTitle(label)}
          title={closeTitle(label)}
          disabled={!revealed || list.length <= 1}
          onclick={() => close(ws)}
          oncontextmenu={(ev) => onTabMenu(ev, ws)}
        >{VERB_MARK.close}</button>
      </span>
    {/each}
  </nav>

  {#if hidden.length > 0}
    <button
      class="verb fold"
      data-verb-id="workspace.fold"
      aria-haspopup="menu"
      aria-expanded={foldOpen}
      title="Show every open tab that does not fit on this screen"
      disabled={!revealed}
      onclick={() => (foldOpen = !foldOpen)}
    >{hidden.length} more tabs</button>
  {/if}

  <!-- The `+` is measured where it lives — there is only ever one of it,
       and a second copy in the gauge would be a second button in the DOM. -->
  <span class="new-slot" bind:this={newSlotEl}>
    <NewTabButton disabled={!revealed} onclick={onnewtab} />
  </span>

  {#if tabMenu !== null}
    <ContextMenu
      title={labelFor(tabMenu.ws)}
      verbs={tabMenuVerbs(tabMenu.ws)}
      at={tabMenu.at}
      onclose={() => (tabMenu = null)}
    />
  {/if}

  {#if foldOpen}
    <Popover
      title="tabs that do not fit"
      onclose={() => (foldOpen = false)}
      style="top: var(--tabstrip-h); right: var(--sp-3);"
    >
      <nav class="fold-list" aria-label="folded tabs">
        {#each hidden as ws (ws.id)}
          {@const label = labelFor(ws)}
          <span class="fold-row" class:active={ws.id === $activeWorkspaceId}>
            <button
              class="verb fold-open"
              data-verb-id="workspace.activate"
              data-workspace-id={ws.id}
              title={`switch to ${label} · middle-click closes`}
              onclick={() => open(ws)}
              onauxclick={(ev) => onTabAuxClick(ev, ws)}
              onmousedown={refuseAutoscroll}
            >{label}</button>
            <button
              class="verb close fold-close"
              data-verb-id="workspace.close"
              aria-label={closeTitle(label)}
              title={closeTitle(label)}
              disabled={list.length <= 1}
              onclick={() => close(ws)}
            >{VERB_MARK.close}</button>
          </span>
        {/each}
      </nav>
    </Popover>
  {/if}

  <!-- THE GAUGE. Every tab at its natural width, out of the flow and out of
       hit-testing, so the fit above can be decided from real measurements
       instead of from a guess at how wide a name is. It is aria-hidden and
       inert: a second copy of the tab row must never be reachable, read out,
       or clickable. -->
  <div class="gauge" bind:this={gaugeEl} aria-hidden="true" inert>
    {#each list as ws, i (ws.id)}
      <span class="slot" data-gauge-tab>
        <span class="tab">{labels[i] ?? ""}</span>
        <span class="verb bare close tab-close">{VERB_MARK.close}</span>
      </span>
    {/each}
    <span class="verb engraved fold" data-gauge-fold>{list.length} more tabs</span>
  </div>
</div>

<style>
  .workspace-strip {
    position: relative;
    height: var(--tabstrip-h);
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0 var(--sp-3);
    background: var(--ground-1);
    border-bottom: var(--hairline-w) solid var(--line-1);
    overflow: hidden;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  /* One tab: the name and its close control share a bezel, so the pair reads
   * as one object and the close is unmistakably ABOUT this tab. */
  .slot {
    display: inline-flex;
    align-items: center;
    flex: none;
    border: var(--hairline-w) solid transparent;
    border-radius: var(--radius-1);
    background: transparent;
  }
  /* The active tab is the one the whole screen belongs to. It is stated with
   * ink and a ground step, never with size — a tab that grew when selected
   * would move its neighbours under the pointer. */
  .slot.active {
    background: var(--accent-soft);
    border-color: transparent;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-1);
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    padding: var(--sp-2) var(--sp-3);
    background: none;
    border: none;
    font-size: var(--f-ui-size);
    font-family: var(--face-sans);
    color: var(--ink-2);
    /* No ellipsis, no clip: the fit decides what renders, and what renders
     * renders whole (shell/tab-fit.ts). */
    white-space: nowrap;
    cursor: pointer;
  }
  .slot.active .tab {
    color: var(--accent);
  }
  .tab:hover:enabled {
    color: var(--ink-1);
  }
  /* The held tab: the pointer owns it, and the cursor says so. The tab keeps
   * its size and its words — reordering happens in the list, not as a ghost. */
  .tab.dragging {
    cursor: grabbing;
    touch-action: none;
  }
  .tab:disabled,
  .tab-close:disabled {
    color: var(--layer-disabled);
    cursor: default;
  }
  /* Chrome is `.verb.bare.close` — the slot already edges the pair.
   * Layout only: the splitter between the name and ×. Svelte 5 scopes
   * with :where(), so this must beat `.cockpit .verb.bare`. */
  :global(.cockpit) .slot .verb.tab-close {
    border-left-color: transparent;
    margin-right: var(--sp-1);
  }
  .fold {
    flex: none;
  }
  .fold-list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .fold-row {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }
  .fold-open {
    flex: 1;
    justify-content: flex-start;
    font-size: var(--f-ui-size);
  }
  .fold-row.active .fold-open {
    color: var(--ink-1);
    border-color: var(--line-2);
  }
  /* `visibility: hidden` keeps the boxes (and therefore the widths) while
   * removing them from paint; absolute takes them out of the strip's own
   * layout entirely. It holds only non-interactive copies — the `+` is
   * measured where it actually is, so the DOM never carries two of it. */
  .new-slot {
    display: inline-flex;
    flex: none;
  }
  /* THE GAUGE — measured, never seen. */
  .gauge {
    position: absolute;
    top: 0;
    left: 0;
    visibility: hidden;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    white-space: nowrap;
  }
</style>
