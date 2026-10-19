<script lang="ts">
  /** A conversation's exact title, recorded date and measured outcome.
   * Normal pending/empty metadata stays quiet. One deliberate menu exposes
   * replay, new-tab opening, recycle and the recorded activity strip through
   * existing handlers. The room owns equal tile geometry and reads. Details exposes exact recorded text.
   */
  import { chordLabel } from "../shell/keyboard.ts";
  import { VERB_MARK, VERB_MARK_WORD } from "../shell/verb-marks.ts";
  import { recycleArmedTitle, recycleFace } from "./recycle-confirm.ts";
  import Popover from "../shell/Popover.svelte";
  import ContextMenu, { type MenuVerb } from "../shell/ContextMenu.svelte";
  // Middle-click = "resume, but in a new tab": the SAME one-bit intent the
  // `+` arms, taken by the room's `land()` at the moment of the choice — so
  // this cannot become a second picker or a second opener.
  import { armNewTab } from "../shell/open-intent.ts";
  import { custodyStateProvKey } from "./custody-feed.ts";
  import { relativeTime, type Reel } from "./switch-data.ts";
  import {
    microSpectrumProvKey,
    pulseProvKey,
    type DensityState,
    type OutcomeState,
  } from "./switch-feed.ts";
  import MicroSweep from "./MicroSweep.svelte";
  import Answer from "../response/Answer.svelte";
  import { absent, type AnswerStateId } from "../response/grammar.ts";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";

  /**
   * THE REEL'S data-state, IN THE GRAMMAR'S WORDS. `outcome.kind` is the
   * switch feed's DOMAIN vocabulary (`measured`/`pending`/`absent`); the
   * attribute is the grammar's PRESENTATION vocabulary. The two are not the
   * same set, so the kind never reaches the attribute directly — it is mapped
   * at this one door: a measured line is content and carries NO state hue
   * (null → the quiet fallback), while the answer states map to themselves.
   * The map is typed against the grammar so a feed kind the grammar does not
   * admit is a compile error here, not an inert attribute on screen. */
  function outcomeDataState(kind: OutcomeState["kind"]): AnswerStateId | null {
    switch (kind) {
      case "pending":
        return "pending";
      case "absent":
        return "absent";
      case "measured":
        return null;
    }
  }

  let {
    reel,
    index,
    focused,
    outcome,
    density,
    nowMs,
    onResume,
    onFocus,
    onReplay,
    onTrash = undefined,
    recycleArmed = false,
    custodyFiles = 0,
    current = false,
    returnFocus,
  }: {
    reel: Reel;
    /** Position in the river's roving-focus sequence. */
    index: number;
    focused: boolean;
    outcome: OutcomeState;
    density: DensityState;
    /** The room's open instant — relative times are computed against it. */
    nowMs: number;
    onResume: () => void;
    onFocus?: () => void;
    onReplay: () => void;
    /** Move this conversation to the recycle bin (soft hide). */
    onTrash?: (() => void) | undefined;
    /** Second press is armed on this conversation. */
    recycleArmed?: boolean;
    /** MEASURED count of uncommitted files the custody join attributes to
     * this conversation (0 / unmeasured → no badge renders). */
    custodyFiles?: number;
    current?: boolean;
    returnFocus?: (() => HTMLElement | null) | undefined;
  } = $props();

  /**
   * Replay is only a verb when a recorded start exists. A conversation
   * with no events has nothing to scrub back to — showing the control
   * would promise a past that was never written.
   */
  const emptyConversation = $derived(outcome.kind === "absent" && outcome.empty === true);

  const canReplay = $derived(
    outcome.kind === "measured" && outcome.startMs !== null,
  );

  /**
   * A spark only when the measured line ARRIVES — pending → measured is
   * news; a re-measurement of the same kind is not. `becauseChanged`
   * refuses an unchanged pair, so a poll cannot dress itself as a spark.
   */
  let lastOutcomeKind: OutcomeState["kind"] | null = null;
  const outcomeMotion = $derived.by((): MovesParam => {
    const next = outcome.kind;
    const previous = lastOutcomeKind;
    lastOutcomeKind = next;
    if (previous !== "pending" || next !== "measured") return null;
    return {
      motion: "rise",
      cause: becauseChanged("this conversation's measured outcome", previous, next),
    };
  });

  /**
   * THE ROW'S VERBS, DECLARED ONCE. The row's own click is
   * `resume`, the menu exposes `replay` when a start was recorded, and
   * the context menu below lists exactly this array — same ids, same
   * handlers. A verb added here reaches the menu because nothing else
   * holds a list.
   */
  const rowVerbs: readonly MenuVerb[] = $derived([
    { id: "switch.open-new-tab", label: "Open in new tab", title: "Keep the current conversation open", run: () => { armNewTab(); onResume(); } },
    ...(canReplay
      ? [
          {
            id: "switch.replay",
            label: "Replay from the start",
            title: "open with the record scrubbed to this conversation's start",
            run: onReplay,
          } satisfies MenuVerb,
        ]
      : []),
    ...(onTrash !== undefined
      ? [
          {
            id: "switch.trash-chat",
            label: recycleFace(recycleArmed, VERB_MARK_WORD.recycle),
            title: recycleArmed
              ? recycleArmedTitle(reel.chat.title)
              : "recycle this conversation",
            run: onTrash,
          } satisfies MenuVerb,
        ]
      : []),
  ]);

  /** Where the right-click landed, or null while no menu is open. */
  let menuAt = $state<Readonly<{ x: number; y: number }> | null>(null);
  let detailsOpen = $state(false);

  function onRowMenu(ev: MouseEvent): void {
    ev.preventDefault();
    if (ev.currentTarget instanceof HTMLElement) ev.currentTarget.querySelector<HTMLElement>('.reel-open')?.focus({ preventScroll: true });
    menuAt = { x: ev.clientX, y: ev.clientY };
  }

  function toggleMenu(event: MouseEvent): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menuAt = menuAt === null ? { x: box.right, y: box.bottom } : null;
  }

  /** Middle-click: arm the new-tab bit, then resume — the room's `land()`
   * takes the bit and opens the workspace. Strictly button 1 (a right press
   * also raises auxclick, and that one is the context menu's). */
  function onRowAuxClick(ev: MouseEvent): void {
    if (ev.button !== 1) return;
    ev.preventDefault();
    armNewTab();
    onResume();
  }

  /** A middle PRESS starts the browser's autoscroll unless refused here. */
  function refuseAutoscroll(ev: MouseEvent): void {
    if (ev.button === 1) ev.preventDefault();
  }
</script>

<!-- The reel IS the resume verb (§5.2: resume — default, Enter/click);
     Enter/⇧Enter are routed by the room's roving-focus keyboard owner. -->
<article
  class="reel"
  class:focused
  class:current
  class:empty-conversation={emptyConversation}
  class:quiet={outcome.kind !== "measured"}
  oncontextmenu={onRowMenu}
>
<button
  class="verb reel-open"
  tabindex={focused ? 0 : -1}
  data-reel-index={index}
  data-verb-id="switch.resume"
  aria-label={`${reel.chat.title} · resume`}
  aria-current={current ? "page" : undefined}
  title={`resume ${reel.chat.title} · middle-click opens it in a new tab`}
  onclick={onResume}
  onfocus={onFocus}
  onauxclick={onRowAuxClick}
  onmousedown={refuseAutoscroll}
  onkeydown={(ev) => {
    // Redundant with the room's owner (belt and braces for AT): Enter on
    // the focused reel resumes; with shift it replays.
    if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) {
      ev.preventDefault(); ev.stopPropagation();
      const box = ev.currentTarget.getBoundingClientRect();
      menuAt = { x: box.right, y: box.bottom };
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) onReplay();
      else onResume();
    }
  }}
>
  <div class="head">
    <span class="name">{reel.chat.title}</span>
    {#if custodyFiles > 0}
      <!-- LENS: the badge is the custody read's ledger join for this
           conversation's project — the name and the time beside it are NOT
           (they come from the conversation list), so they stay unstamped. -->
      <span
        class="custody"
        data-prov={custodyStateProvKey(reel.chat.projectId)}
        title={`${custodyFiles} changed file${custodyFiles === 1 ? "" : "s"} from this conversation are not kept yet — ${chordLabel({ key: "g", primary: true })} to keep or undo them`}
        >Δ{custodyFiles}</span>
    {/if}
    </div><div class="metadata"><span class="when">{relativeTime(reel.updatedMs, nowMs)}</span>
  {#if !emptyConversation && outcome.kind !== "pending"}<div
    class="outcome"
    data-state={outcomeDataState(outcome.kind)}
    data-prov={pulseProvKey(reel.chat.id)}
    use:moves={outcomeMotion}
  >
    {#if outcome.kind === "measured"}
      <span class="line">{outcome.line}</span>
    {:else}
      <Answer as="inline" answer={absent(outcome.reason)} />
    {/if}
  </div>
  {/if}
  </div>
</button>
<button class="verb more" type="button" data-verb-id="switch.conversation-menu" onfocus={onFocus} aria-label={`Actions and activity for ${reel.chat.title}`} title={`Actions and activity for ${reel.chat.title}`} aria-haspopup="menu" aria-expanded={menuAt !== null} tabindex={focused ? 0 : -1} onclick={toggleMenu}>{VERB_MARK.more}</button>
<button class="verb bare disclose reel-details" type="button" data-verb-id="switch.conversation-details" onfocus={onFocus} aria-label={`Details for ${reel.chat.title}`} title="Conversation details" aria-expanded={detailsOpen} tabindex={focused ? 0 : -1} onclick={() => { detailsOpen = !detailsOpen; }}><span class="disclosure-mark" aria-hidden="true"></span></button>
</article>

<!-- The menu is a sibling of the native row controls. -->
{#if menuAt !== null}
  <ContextMenu
    title={`Actions for ${reel.chat.title}`}
    verbs={rowVerbs}
    at={menuAt}
    onclose={() => (menuAt = null)}
    {returnFocus}
  />
{/if}
{#if detailsOpen}
  <Popover title="Conversation details" onclose={() => { detailsOpen = false; }} {returnFocus} style="position: fixed; right: var(--sp-3); top: var(--horizon-h); max-height: calc(100dvh - var(--horizon-h) - var(--sp-3));">
      <p class="full-title">{reel.chat.title}</p>
      <p>{relativeTime(reel.updatedMs, nowMs)}</p>
      {#if outcome.kind === "measured"}<p class="full-outcome">{outcome.line}</p>{:else if !emptyConversation && outcome.kind === "absent"}<Answer as="inline" answer={absent(outcome.reason)} />{/if}
      <div class="recorded-density" aria-label="Recorded activity"><MicroSweep {density} provKey={microSpectrumProvKey(reel.chat.id)} /></div>
  </Popover>
{/if}

<style>
  .reel {
    /* Every tile has the same shared dimensions. Exact content is available
     * in Details through the native menu button, on touch and keyboard. */
    height: var(--reel-h);
    min-width: 0;
    min-height: var(--hit-min);
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--hit-min);
    grid-template-rows: minmax(0, 1fr) var(--hit-min);
    align-items: start;
  }
  .reel :global(.reel-open) { grid-column: 1; grid-row: 1 / -1; height: 100%; }
  .reel > .more { grid-column: 2; grid-row: 1; }
  .reel-details { grid-column: 2; grid-row: 2; }
  /* The row header's spine is owned by tokens.css (.cockpit .head). */
  .head {
    align-items: start;
    gap: var(--sp-1) var(--sp-3);
    min-height: 0;
  }
  .name {
    flex: 1;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  /* Shared action styling lives in tokens.css; this component owns layout. */
  .outcome {
    flex: 1;
    display: flex;
    align-items: center;
    min-height: 0;
    overflow-wrap: anywhere;
  }
  /* Preview and full Details share the exact recorded string. */
  .outcome { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; line-clamp: 1; overflow: hidden; }
  .metadata { display: flex; align-items: baseline; gap: var(--sp-2); margin-top: auto; min-width: 0; }
  .full-title, .full-outcome { white-space: pre-wrap; overflow-wrap: anywhere; }
  .outcome :global(.answer) {
    white-space: normal;
  }
  .recorded-density { margin-top: var(--sp-3); }
</style>
