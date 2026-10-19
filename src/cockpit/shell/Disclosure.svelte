<script lang="ts">
  /**
   * THE DISCLOSURE — the collapsible section, as ONE shared primitive.
   *
   * The APG Disclosure pattern (WAI-ARIA APG, "Disclosure (Show/Hide)
   * Pattern", retrieved 2026-09-04 — research/round73-single-right-menu/):
   * a real `<button>` that shows and hides a section of content, carrying
   * `aria-expanded` for the state and `aria-controls` pointing at the
   * content element. The right menu's sections (the run group's seven and
   * the arm group's) all collapse the same way, so the chrome lives here
   * once — one owner for the disclosure grammar, the same way `.verb` owns
   * the control chip and `.cap` owns the header row.
   *
   * THE FIXED-LABEL LAW (APG Button Pattern, verbatim: "it is critical the
   * label on a toggle does not change when its state changes"): the
   * section's name is constant; the chevron — aria-hidden — is the state's
   * picture, never part of the accessible name. The COUNT rides in the
   * header's meta slot and stays visible when the body is collapsed (the
   * accordion pattern's "visually persistent … snippet of the hidden
   * content"), so a collapsed section still states its population.
   *
   * COLLAPSED CONTENT IS REMOVED FROM THE DOM, not hidden — the same
   * `{#if}` idiom ThinkingFold and the desk's channel strips use, and the
   * APG-conformant choice for a menu that mounts measurement derivations:
   * a collapsed section's rows do not render, so a streaming run costs a
   * collapsed section nothing. The trade is documented, not free: the
   * header's own count still reads its store (a handful of coarse
   * recomputations per turn), and re-expanding re-renders the rows from
   * the same stores — nothing is lost, nothing is stale.
   *
   * Manual choices survive closing and reopening through the existing
   * per-workspace view owner. Remembering a section does not open a menu;
   * defaults apply only until the reader makes a choice.
   *
   * THE META SNIPPET carries the section's own verbs (the progress
   * section's stop verb, the codebase section's re-read) — adjacent,
   * always-visible controls the accordion pattern explicitly expects; the
   * grip button stays the only thing that toggles.
   */
  import { getContext, tick, untrack, type Snippet } from "svelte";
  import { INSPECTOR_SECTIONS_CONTEXT_KEY, type InspectorSections } from "./contract.ts";
  import { activeWorkspaceId } from "../../state/workspaces.ts";
  import { disclosureChoice, noteDisclosureChoice } from "./workspace-view.ts";

  let {
    /** Stable DOM id: the body element's id (aria-controls) + the test marker. */
    id,
    /** The FIXED label — the section's name, constant across states. */
    label,
    keywords = "",
    /** The persistent count, or null when the section has no population. */
    count = null,
    /** Whether the section starts open (judged by the consumer from its
     * data's presence — this component never reads a store). */
    defaultOpen = false,
    menu = false,
    /** The section's own always-visible verbs (adjacent to the grip). */
    meta = undefined,
    /** Told every open-state change, with the new state. Optional: a
     * section whose data is read on demand (the ledger) learns HERE that
     * its body is visible — the section owns the read, the primitive owns
     * the chrome, and neither reads the other's state. */
    onOpenChange = undefined,
    children,
  }: {
    id: string;
    label: string;
    /** Optional action/search words. The inspector discovers this section
     * without another list; controls retain their data-verb-id metadata. */
    keywords?: string;
    count?: number | null;
    defaultOpen?: boolean;
    /** Menu details use the same row padding/label edge as adjacent actions. */
    menu?: boolean;
    meta?: Snippet;
    onOpenChange?: (open: boolean) => void;
    children?: Snippet;
  } = $props();

  // The default is CAPTURED AT MOUNT, deliberately: `defaultOpen` is the
  // consumer's presence judgment for the moment the section appears, and
  // the reader's toggles from there are the reader's own — a later change
  // to the prop (rows arriving while the menu is open) must not reorganize
  // a menu the reader is reading. This is the capture the compiler warns
  // about, named so the next reader knows it is the design.
  // svelte-ignore state_referenced_locally
  const initialOpen = defaultOpen;
  let open = $state(initialOpen);
  let sectionEl: HTMLDivElement | undefined = $state();
  const inspector = getContext<InspectorSections | undefined>(INSPECTOR_SECTIONS_CONTEXT_KEY);

  $effect(() => {
    const section = { id, label, keywords, open: () => {
    if (!open) {
      open = true;
      noteDisclosureChoice(id, true);
      onOpenChange?.(true);
    }
    void tick().then(() => {
      if (!sectionEl?.isConnected) return;
      sectionEl.scrollIntoView?.({ block: "start" });
      sectionEl.querySelector<HTMLButtonElement>(".disc-grip")?.focus({ preventScroll: true });
    });
    } };
    return untrack(() => inspector?.register(section));
  });

  $effect(() => {
    // A kept-alive inspector can change workspace without remounting.
    void $activeWorkspaceId;
    const next = disclosureChoice(id) ?? initialOpen;
    open = next;
    untrack(() => onOpenChange?.(next));
  });

  function toggle(): void {
    open = !open;
    noteDisclosureChoice(id, open);
    onOpenChange?.(open);
  }
</script>

<div class="disclosure" data-disclosure={id} bind:this={sectionEl}>
  <div class="cap disc-cap">
    <button
      class="disc-grip"
      class:verb={menu}
      class:menu
      class:menu-grip={menu}
      type="button"
      id="{id}-grip"
      data-verb-id="disclosure.{id}"
      aria-expanded={open}
      aria-controls={id}
      aria-describedby={count === null ? undefined : `${id}-count`}
      title={open ? `collapse ${label}` : `expand ${label}`}
      onclick={toggle}
    >
      <span class="disc-mark" aria-hidden="true">▸</span>
      <span class="disc-label">{label}</span>
    </button>
    {#if count !== null}
      <span id="{id}-count" class="disc-count">{count}</span>
    {/if}
    {#if meta !== undefined}
      <div class="disc-meta">
        {@render meta()}
      </div>
    {/if}
  </div>
  {#if open}
    <!-- The body is named by its controller (aria-labelledby — the APG
         accordion's own recommendation) WITHOUT `role="region"`: the
         pointer is what aria-controls already gives, the name is what
         labelledby gives, and a landmark per section would be the
         proliferation the pattern warns about at this menu's size. -->
    <div class="disc-body" {id} aria-labelledby="{id}-grip">
      {@render children?.()}
    </div>
  {/if}
</div>

<style>
  .disclosure {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-width: 0;
  }
  /* The header row reuses the owned cap recipe (tokens.css .cockpit .cap);
   * a hairline closes the section the way every section cap in the cockpit
   * closes — the border is the section's lower edge, not decoration. */
  .disc-cap {
    border-bottom: var(--hairline-w) solid var(--line-1);
    align-items: center;
  }
  /* The grip is a real control: the pointer-target floor in both axes, the
   * owned hover ink, and NO resting box — the group caps above are the
   * boxed bars (a bezel + the ground-2 tint) and the section caps are the
   * quieter unboxed rows their hairline closes, so the two disclosure
   * levels read as ONE grammar (a mark + the engraved word) at two sizes,
   * never as two different box shapes for the same job. The grip carries
   * the affordance (the hover wash + the pointer cursor + the rotated
   * mark); the row's own hairline carries the separation. */
  .disc-grip:not(.menu-grip) {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--ink-1);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    padding: 0 var(--sp-1);
    font: inherit;
    overflow-wrap: anywhere;
  }
  .disc-grip:hover:enabled {
    background: var(--layer-hover);
    color: var(--ink-1);
  }
  .disc-grip:active:enabled {
    background: var(--layer-press);
    color: var(--accent);
  }
  /* The state's picture rotates with the disclosure — form first, the same
   * mark ThinkingFold and the channel strips use. */
  .disc-mark {
    width: var(--mark-size);
    height: var(--mark-size);
    flex: none;
    font-size: 0;
    background: currentColor;
    mask: var(--mark-disclose) center / contain no-repeat;
    /* Motion is local to the state change: one rotation at the grip the
     * reader just pressed, none at rest. */
    transition: transform var(--t-1) var(--ease-out);
  }
  .menu-grip .disc-mark { order: 1; margin-left: auto; }
  .menu-grip .disc-label { font: inherit; }
  .disc-grip[aria-expanded="true"] .disc-mark {
    transform: rotate(90deg);
    color: var(--accent);
  }
  .disc-label {
    color: inherit;
    font-family: var(--face-sans);
    font-size: var(--f-ui-size);
    text-align: left;
    font-weight: var(--f-micro-weight);
  }
  .disc-count {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  /* The section's own verbs park page-right, beside the count — always
   * visible whether the body is collapsed or not. */
  .disc-meta {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .disc-body {
    padding-bottom: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-width: 0;
  }
</style>
