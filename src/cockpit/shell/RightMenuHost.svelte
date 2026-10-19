<script lang="ts">
  import { VERB_MARK } from "./verb-marks.ts";
  /** One inspector for the active workspace. Group metadata and lazy body
   * loaders live at the established right-menu/outlets extension doors.
   * Only the chosen body mounts; all groups remain discoverable in the nav. */
  import { computed } from "nanostores";
  import { getContext, setContext, tick, untrack, type Component } from "svelte";
  import { INSPECTOR_GROUPS, inspectorGroupComponent, loadInspectorGroup } from "./outlets.ts";
  import { RIGHT_MENU_TITLE, openRightMenu, pendingInspectorSection, type RightMenuId } from "./right-menu.ts";
  import { INSPECTOR_SECTIONS, INSPECTOR_SECTION_ENTRIES, type InspectorSectionId } from "../../../shared/routes.ts";
  import { mouseTitleFor } from "./keyboard.ts";
  import { activeWorkspaceId } from "../../state/workspaces.ts";
  import { currentProject } from "../../state/projects.ts";
  import { currentChat } from "../../state/chats.ts";
  import { currentRun, isRunActive } from "../../state/run-state.ts";
  import { inspectorPage, noteInspectorScroll } from "./workspace-view.ts";
  import { SHELL_CONTEXT_KEY, INSPECTOR_SECTIONS_CONTEXT_KEY, type InspectorSection, type InspectorSections, type ShellApi, type ScopeRequest } from "./contract.ts";
  import { focusSurface } from "./Popover.svelte";
  import Answer from "../response/Answer.svelte";
  import { failed, pending } from "../response/grammar.ts";

  let { menu, presentation, scope = null, onBack = () => {}, onClose }: { menu: RightMenuId | null; presentation: "flow-docked" | "room-docked" | "overlay"; scope?: ScopeRequest | null; onBack?: () => void; onClose: () => void } = $props();
  const summaries = computed(INSPECTOR_GROUPS.map(group => group.summary), (...values) => values);
  const shell = getContext<ShellApi | undefined>(SHELL_CONTEXT_KEY);
  const tEscape = mouseTitleFor("escape");
  // svelte-ignore state_referenced_locally
  let selected = $state<RightMenuId>(menu ?? INSPECTOR_GROUPS.find(group => group.defaultOpen)!.id);
  let menuEl: HTMLElement | undefined = $state();
  $effect(() => { const node = menuEl; if (node !== undefined && presentation === "overlay") return focusSurface(node, true); return undefined; });
  let bodyEl: HTMLDivElement | undefined = $state();
  let Body = $state.raw<Component | null>(null);
  let loadError = $state<string | null>(null);
  let attempt = $state(0);
  let query = $state("");
  let sectionVersion = $state(0);
  let requestedSection = $state<InspectorSectionId | null>(null);
  let sectionNotice = $state<string | null>(null);
  const sections = new Map<string, InspectorSection>();
  setContext<InspectorSections>(INSPECTOR_SECTIONS_CONTEXT_KEY, {
    register(section) {
      sections.set(section.id, section); sectionVersion += 1;
      return () => { if (sections.get(section.id) === section) { sections.delete(section.id); sectionVersion += 1; } };
    },
  });
  const matches = $derived.by(() => {
    const words = query.trim().toLocaleLowerCase();
    return words.length === 0 ? [] : INSPECTOR_SECTION_ENTRIES.filter(section => section.search.includes(words));
  });
  const group = $derived(INSPECTOR_GROUPS.find(group => group.id === selected)!);
  const chat = $derived($currentChat?.projectId === $currentProject?.id ? $currentChat : null);
  const active = $derived(chat !== null && $currentRun?.projectId === chat.projectId && $isRunActive);
  let restoringScroll = false;
  let scopeOrigin: HTMLElement | null = null;
  let scopeScroll = 0;
  $effect.pre(() => {
    const request = scope;
    untrack(() => {
      if (request !== null) {
        if (scopeOrigin === null) {
          scopeOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          scopeScroll = bodyEl?.scrollTop ?? 0;
        }
        void tick().then(() => { if (scope === request) { bodyEl?.querySelector<HTMLButtonElement>('[data-verb-id="scope.close"]')?.focus(); if (bodyEl) bodyEl.scrollTop = 0; } });
      } else if (scopeOrigin !== null) {
        const origin = scopeOrigin; scopeOrigin = null;
        void tick().then(() => { if (scope === null) { if (bodyEl) bodyEl.scrollTop = scopeScroll; if (origin.isConnected) origin.focus({ preventScroll: true }); } });
      }
    });
  });

  function select(id: RightMenuId): void { if (scope !== null) onBack(); selected = id; query = ""; sectionNotice = null; openRightMenu(id); }
  function visitRoom(id: "editor" | "custody"): void {
    shell?.openRoom(id);
    onClose();
  }
  function requestSection(id: InspectorSectionId): void {
    select(INSPECTOR_SECTIONS[id].group);
    requestedSection = id;
  }
  $effect(() => {
    const id = $pendingInspectorSection;
    if (id !== null) untrack(() => { pendingInspectorSection.set(null); requestSection(id); });
  });
  $effect(() => {
    void sectionVersion;
    const id = requestedSection;
    if (id === null || Body === null) return;
    const section = sections.get(id);
    if (section !== undefined) {
      untrack(() => { requestedSection = null; section.open(); });
      return;
    }
    let live = true;
    void tick().then(() => {
      if (!live || requestedSection !== id || sections.has(id)) return;
      const declaration = INSPECTOR_SECTIONS[id];
      sectionNotice = declaration.context === "conversation" && chat === null
        ? "Open a conversation to see " + declaration.label + "."
        : declaration.label + " has no entries in this context yet.";
      requestedSection = null;
    });
    return () => { live = false; };
  });
  function onNavKey(event: KeyboardEvent): void {
    const index = INSPECTOR_GROUPS.findIndex(group => group.id === selected);
    const next = event.key === "ArrowRight" ? (index + 1) % INSPECTOR_GROUPS.length
      : event.key === "ArrowLeft" ? (index + INSPECTOR_GROUPS.length - 1) % INSPECTOR_GROUPS.length
      : event.key === "Home" ? 0 : event.key === "End" ? INSPECTOR_GROUPS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    select(INSPECTOR_GROUPS[next]!.id);
    const nav = event.currentTarget as HTMLElement;
    void tick().then(() => nav.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
  }
  $effect(() => { const id = menu; if (id !== null) untrack(() => select(id)); });
  $effect(() => {
    const id = selected; const workspace = $activeWorkspaceId; void attempt;
    loadError = null;
    restoringScroll = true;
    const scroll = untrack(() => inspectorPage("scroll:" + id) ?? 0);
    Body = inspectorGroupComponent(id);
    let live = true;
    void loadInspectorGroup(id).then(component => {
      if (!live) return;
      Body = component;
      void tick().then(() => {
        if (live && selected === id && $activeWorkspaceId === workspace && bodyEl !== undefined)
          bodyEl.scrollTop = scroll;
        if (live) restoringScroll = false;
      });
    }, error => { if (live) loadError = error instanceof Error ? error.message : String(error); });
    return () => { live = false; };
  });
</script>

<aside bind:this={menuEl} tabindex="-1" class="right-menu" data-presentation={presentation} class:docked={presentation === "flow-docked"} role={presentation === "overlay" ? "dialog" : "complementary"} aria-modal={presentation === "overlay" ? true : undefined} aria-label={RIGHT_MENU_TITLE}>
  <header class="inspector-heading">
    <div class="context-identity">
      <h2>{chat === null ? "Project inspector" : "Conversation inspector"}</h2>
      {#if active}<span class="run-state">● Run active</span>{/if}
    </div>
    <div class="context-actions">
    {#if shell !== undefined && $currentProject !== null}
      <button type="button" class="verb" data-verb-id="right-menu.files" title="Browse this project's files" onclick={() => visitRoom("editor")}>Files</button>
      <button type="button" class="verb" data-verb-id="right-menu.changes" title="Review this project's changes" onclick={() => visitRoom("custody")}>Changes</button>
    {/if}
    <button type="button" class="verb close" data-verb-id="right-menu.close" data-chord-target="escape" title={tEscape} aria-label="close workspace inspector" onclick={onClose}>{VERB_MARK.close}</button>
    </div>
  </header>
  <div class="section-nav" role="tablist" tabindex="-1" aria-label="inspector sections" onkeydown={onNavKey}>
    {#each INSPECTOR_GROUPS as item, index (item.id)}
      <button type="button" role="tab" id="inspector-tab-{item.id}" class="section-tab" data-verb-id="rm.group-{item.id}" data-chord-target={item.chord}
        title={item.chord === undefined ? item.description : mouseTitleFor(item.chord)} aria-selected={selected === item.id}
        aria-controls="inspector-body" tabindex={selected === item.id ? 0 : -1} onclick={() => select(item.id)}>{item.label}{#if $summaries[index] !== null}<span class="group-count">{$summaries[index]}</span>{/if}</button>
    {/each}
  </div>
  <div class="section-finder">
    <input type="search" name="inspector-search" class="field" aria-label="find an inspector section or action" placeholder="Find a section or action…" bind:value={query} />
    {#if query.trim().length > 0}
      <div class="section-results" aria-label="matching inspector sections">
        {#each matches as section (section.id)}
          <button type="button" class="verb" data-verb-id="right-menu.find-{section.id}" title="Open {section.label}" onclick={() => requestSection(section.id)}>{section.label} ↗</button>
        {:else}<p>No matching inspector section.</p>{/each}
      </div>
    {/if}
  </div>
  <div class="body" id="inspector-body" role="tabpanel" aria-labelledby="inspector-tab-{selected}" bind:this={bodyEl}
    onscroll={() => { if (!restoringScroll && scope === null) noteInspectorScroll(Math.round(bodyEl?.scrollTop ?? 0), "scroll:" + selected); }}>
    {#if scope !== null}
      <button type="button" class="verb" data-verb-id="scope.close" data-chord-target="escape" title="Back to {group.label}" onclick={onBack}>← Back to {group.label}</button>
      <h3 class="scope-title">{scope.title}</h3>
      {#if scope.component !== undefined}{@const ScopeBody = scope.component as Component<Record<string, unknown>>}<ScopeBody {...(scope.props ?? {})} {shell} />{/if}
    {/if}
    <div hidden={scope !== null} inert={scope !== null}>
    {#if loadError !== null}
      <Answer answer={failed(loadError)} />
      <button type="button" class="verb" data-verb-id="right-menu.retry" title="Retry loading this inspector section" onclick={() => attempt += 1}>Try again</button>
    {:else if Body !== null}
      {#if sectionNotice !== null}<p role="status">{sectionNotice}</p>{/if}
      <Body />
    {:else}
      <Answer answer={pending(group.label)} />
    {/if}
    </div>
  </div>
</aside>

<style>
  .right-menu { position: absolute; top: 0; right: 0; bottom: 0; width: min(100%, var(--right-menu-w)); z-index: 40; background: var(--ground-1); border-left: var(--hairline-w) solid var(--line-2); box-shadow: var(--shadow-sheet); display: flex; flex-direction: column; }
  .right-menu.docked { position: static; flex: 0 0 var(--right-menu-w); box-shadow: none; height: 100%; }
  .right-menu:not(.docked) { position: fixed; width: min(100vw, var(--right-menu-overlay-w, var(--right-menu-w))); top: var(--room-top, var(--horizon-h)); bottom: 0; }
  .right-menu[data-presentation="room-docked"] { width: var(--right-menu-w); }
  .right-menu[data-presentation="overlay"] { width: 100%; }
  .inspector-heading { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); align-items: center; justify-content: space-between; padding: var(--sp-2); background: var(--accent-soft); }
  .context-identity { flex: 1 1 min-content; min-width: min-content; }
  h2 { margin: 0; color: var(--accent); font-size: var(--f-ui-size); line-height: var(--f-prose-lh); font-weight: var(--f-micro-weight); overflow-wrap: normal; }
  .context-actions { display: flex; align-items: center; gap: var(--sp-0); margin-left: auto; }
  .context-actions .verb { color: var(--accent); font-size: var(--f-data-size); padding-inline: var(--sp-1); }
  .run-state { color: var(--accent); font-size: var(--f-data-size); }
  .section-nav { display: flex; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4); border-bottom: var(--hairline-w) solid var(--line-1); }
  .section-tab { flex: 1; cursor: pointer; }
  .group-count { font-size: var(--f-micro-size); color: var(--ink-2); }
  .body { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; padding: var(--sp-3) var(--sp-4); }
  .section-finder { position: relative; padding: var(--sp-2) var(--sp-4); }
  .section-finder input { width: 100%; }
  .section-results { position: absolute; left: var(--sp-4); right: var(--sp-4); top: 100%; max-height: 50dvh; overflow-y: auto; z-index: 1; display: flex; flex-direction: column; background: var(--ground-3); border: var(--hairline-w) solid var(--line-2); padding: var(--sp-2); box-shadow: var(--shadow-sheet); }
  .section-results p { color: var(--ink-2); font-size: var(--f-data-size); }
</style>
