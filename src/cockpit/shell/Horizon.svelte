<script lang="ts">
  /**
   * HORIZON (§2.4) — the only top chrome, fixed 40px.
   * Left: identity glyph (sign-out lives UNDER it, not in the strip) and
   * the place (`project ▸ conversation`) — the Switch trigger.
   * Center: ≤3 annunciator slots — dark when healthy; a lit slot is an
   * abnormal fact + its verb, and carries its reason (title) per §1.5 F1.
   * Right: ≤4 pinned monitors (uniform 96×28 references, §1.4) + THE ROOM
   * RAIL. No metrics strip, no model selector, no logout button here.
   *
   * THE ROOM RAIL (MOUSE-FIRST law, v2.1) — the right side used to hold one
   * unlabelled LENS glyph and nothing else, which meant Instruments,
   * Settings, Custody and ARM were reachable by chord ALONE. A chord-only
   * capability is a defect. The rail is the visible half of the grammar:
   * one engraved word per room, quiet ink, no hue, each a ChordGrip
   * whose tooltip is generated from the grammar table — so the mouse path
   * TEACHES the chord instead of hiding it.
   *
   * ROOMS ONLY. The two words that are not rooms — `run` and `arm`, the
   * inspector columns that sit BESIDE the flow rather than covering it —
   * moved to the flow region's own right edge (shell/SideRail.svelte),
   * which is where they open from and which never folds; this rail names
   * rooms and modes that cover the screen, and the folded menu below the
   * §2.7 breakpoint keeps exactly the same set.
   *
   * The Switch keeps its own affordance (the place chip is the Switch
   * trigger, §2.4) rather than being duplicated into the rail; the chip now
   * carries the same `data-chord-target` claim and the same taught chord.
   *
   * Every grip renders from first paint (inert until `revealed`) — a rail
   * that appeared AT the reveal would be a late mount (§10.3).
   *
   * NARROW WIDTHS. The HORIZON is 40px at every width, so nothing in it may
   * wrap, and at 375–1100px the engraved words are wider than the column
   * they sit in — the rail used to simply overflow and be CLIPPED by it,
   * which read as "USTODY · SETTINGS · ARM · LENS": a word sliced in half,
   * and two rooms with no mouse path at all. A clipped word is never an
   * arrangement. So below the §2.7 breakpoint the pinned monitors hide and
   * the rail folds behind ONE control that opens the same grips in a
   * menu — every room stays one click away at every width, still teaching
   * its own chord, and nothing is ever half-drawn.
   *
   * BOTH forms render from first paint and the width token decides which is
   * shown, so crossing the breakpoint mounts nothing (§10.3).
   */
  import {
    SHELL_CONTEXT_KEY,
    type Annunciator,
    type GrammarTarget,
    type Monitor,
    type RoomId,
    type ShellApi,
  } from "./contract.ts";
  import { MAX_ANNUNCIATORS, MAX_MONITORS, logTime } from "./config.ts";
  import { mouseTitleFor } from "./keyboard.ts";
  import Popover from "./Popover.svelte";
  import Brand from "./Brand.svelte";
  // The place chip is the Switch's opener, so it is a hover target with a
  // room behind it exactly like a rail grip — same warm, same dwell, same
  // derivation from the target it fires (shell/room-warm.ts).
  import { planForTarget, warmOnIntent } from "./room-warm.ts";
  import ChordGrip from "./ChordGrip.svelte";
  import NewTabButton from "./NewTabButton.svelte";
  import SideRail from "./SideRail.svelte";
  import type { RightMenuId } from "./right-menu.ts";
  import { getContext } from "svelte";

  // The shell, when there is one (Popover's own pattern): the identity menu
  // registers in the shell's dismissal ladder while it is open, so Esc closes
  // it through the ONE router instead of a listener of its own.
  const shell = getContext<ShellApi | undefined>(SHELL_CONTEXT_KEY);

  let {
    revealed,
    authed,
    username,
    place,
    placeProject = null,
    placeConversation = null,
    showPlace = true,
    showNewTab = true,
    onNewTab,
    annunciators,
    monitors,
    roomId = null,
    menu = null,
    onChord,
    onSignOut,
  }: {
    revealed: boolean;
    /** Signed-in working surface — the rail, place chip, and + hide until then. */
    authed: boolean;
    username: string;
    place: string;
    placeProject?: string | null;
    placeConversation?: string | null;
    /**
     * Whether the place chip states the pair HERE. It collapses when the tab
     * strip is naming the same `project ▸ conversation` one row down —
     * one manifestation per fact (§1.4), and the duplication this user
     * objects to by name. The shell decides; see Cockpit.svelte.
     */
    showPlace?: boolean;
    /** Whether the `+` lives here. It moves into the tab strip once the
     * strip exists, so exactly one `+` is ever on screen. */
    showNewTab?: boolean;
    /** Open another project or conversation in a new tab. */
    onNewTab: () => void;
    annunciators: readonly Annunciator[];
    monitors: readonly Monitor[];
    /** The room on screen, or null when Chat (the flow) is showing. */
    roomId?: RoomId | null;
    menu?: RightMenuId | null;
    /** Run a grammar target — the SAME router the chord takes, so a click
     * and its keystroke can never diverge (Cockpit.routeTarget). */
    onChord: (target: GrammarTarget) => void;
    onSignOut: () => void;
  } = $props();

  let menuOpen = $state(false);
  /** The folded rail's menu (narrow widths only — see the header). */
  let railOpen = $state(false);
  /** The identity menu's own box, for the outside-press rule below. */
  let identityEl = $state<HTMLElement | null>(null);

  // ESC — declared to the shell as a dismissal layer while the identity menu
  // is open (Popover's own behaviour): the ladder closes the innermost open
  // surface first, so the menu takes the key ahead of any room, and no
  // layer-blind "nothing open" hint can fire while it is visibly open.
  $effect(() => {
    if (!menuOpen || shell === undefined) return;
    return shell.pushDismiss({ label: "the identity menu", dismiss: () => (menuOpen = false) });
  });

  // A press outside dismisses — the web-native menu contract, and the same
  // rule the shared Popover enforces for every raised surface. The glyph that
  // opened the menu is EXEMPT (the opener owns its own toggle: closing here
  // and letting its own click re-open on the same gesture would make the menu
  // impossible to dismiss from the place a reader most expects to).
  $effect(() => {
    if (!menuOpen || identityEl === null) return;
    const onDown = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node)) return;
      if (identityEl?.contains(ev.target) === true) return;
      menuOpen = false;
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  });

  const lit = $derived(
    [...annunciators]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_ANNUNCIATORS),
  );
  const pinned = $derived(monitors.slice(0, MAX_MONITORS));
</script>

<header class="horizon">
  <div class="side left">
    <div class="identity" bind:this={identityEl}>
      <button
        class="verb bare glyph"
        aria-label={username.length > 0 ? `Account: ${username}` : "Bridlewise"}
        aria-expanded={menuOpen}
        disabled={!revealed}
        onclick={() => (menuOpen = !menuOpen)}
      ><Brand /></button>
      {#if menuOpen}
        <div class="identity-menu">
          <span class="who">{username.length > 0 ? username : "signed out"}</span>
          <button class="verb" onclick={() => { menuOpen = false; onSignOut(); }}>
            Sign out
          </button>
        </div>
      {/if}
    </div>
    <!-- THE PLACE, or the trigger alone. The chip has two jobs — it NAMES
         `project ▸ conversation` and it opens the Switch. When the tab strip
         is naming that pair one row down, the naming job is done and only
         the trigger is left, so it renders as the engraved word instead of
         as a second copy of the same sentence. Losing the chip must never
         mean losing the mouse path to the Switch (MOUSE-FIRST law). -->
    {#if authed && showPlace}
      <button
        class="verb bare place"
        data-chord-target="switch"
        title={`${place} · ${mouseTitleFor("switch")}`}
        disabled={!revealed}
        onclick={() => onChord("switch")}
        use:warmOnIntent={revealed ? planForTarget("switch") : null}
      >
        {#if placeProject !== null}<span class="place-project trunc">{placeProject}</span><span class="place-conversation trunc">{placeConversation}</span>{:else}{place}{/if}
      </button>
    {:else if authed}
      <ChordGrip
        target="switch"
        label="Switch"
        disabled={!revealed}
        onclick={() => onChord("switch")}
      />
    {/if}
    <!-- THE `+` (§ tab strip). It sits beside the conversation title while
         there is a single workspace — which is exactly where the user looked
         for it — and moves into the strip the moment the strip exists. -->
    {#if authed && showNewTab}
      <NewTabButton disabled={!revealed} onclick={onNewTab} />
    {/if}
  </div>

  <div class="annunciators" aria-label="annunciators">
    {#each lit as a (a.id)}
      <button class="annunciator" title={a.reason} onclick={a.verb.run}>
        <span class="a-label">{a.label}</span>
        <span class="a-verb engraved">{a.verb.label}</span>
      </button>
    {/each}
  </div>

  <div class="side right">
    {#each pinned as m (m.id)}
      <button class="monitor" onclick={m.openSource} title={`asOf ${logTime(m.asOf)}`}>
        <span class="m-label engraved trunc">{m.label}</span>
        <span class="m-value">{m.value}</span>
      </button>
    {/each}
    {#if authed}
    <!-- Written out one grip per line, with the grammar target spelled
          LITERALLY at each call site: the mouse path is greppable from the
          chord it teaches, and the mouse-path guard can read it. Reading
          order: Chat (the flow), then the rooms. Chat is roomId === null —
          not a room file. The run and arm inspector columns open from the
          flow region's right edge instead (shell/SideRail.svelte) — they sit
          BESIDE the conversation, they do not cover it. -->
    <div class="rail room-tabs" role="tablist" aria-label="rooms and modes">
      <ChordGrip
        target="chat"
        label="Chat"
        tab={true}
        selected={roomId === null}
        disabled={!revealed}
        onclick={() => onChord("chat")}
      />
      <ChordGrip
        target="instruments"
        label="Instruments"
        tab={true}
        selected={roomId === "instruments"}
        disabled={!revealed}
        onclick={() => onChord("instruments")}
      />
      <ChordGrip
        target="custody"
        label="Custody"
        tab={true}
        selected={roomId === "custody"}
        disabled={!revealed}
        onclick={() => onChord("custody")}
      />
      <ChordGrip
        target="editor"
        label="Editor"
        tab={true}
        selected={roomId === "editor"}
        disabled={!revealed}
        onclick={() => onChord("editor")}
      />
      <ChordGrip
        target="settings"
        label="Settings"
        tab={true}
        selected={roomId === "settings"}
        disabled={!revealed}
        onclick={() => onChord("settings")}
      />
      <ChordGrip
        target="lens"
        label="Lens"
        tab={true}
        selected={false}
        disabled={!revealed}
        onclick={() => onChord("lens")}
      />
    </div>

    <!-- THE FOLDED RAIL. Shown only below the §2.7 breakpoint (the token
          decides, tokens.css owns it). One word, then the same grips in
          the shared Popover — so a narrow cockpit loses no room, teaches the
          same chords, and Esc closes the menu through the shell's dismissal
          ladder like every other raised surface. ROOMS ONLY, the same set
          the wide rail holds: the run and arm columns open from the flow
          region's right edge (the side rail), which does not fold — below
          this breakpoint it is the replacement mouse path for them. -->
    <button
      class="verb rail-fold"
      aria-haspopup="menu"
      aria-expanded={railOpen}
      title="rooms and modes"
      disabled={!revealed}
      onclick={() => (railOpen = !railOpen)}
    >Rooms</button>
    {#if railOpen}
      <Popover
        title="rooms and modes"
        onclose={() => (railOpen = false)}
        style="top: var(--horizon-h); right: var(--sp-3);"
      >
        <div class="rail-list room-tabs" role="tablist" aria-label="rooms and modes">
          <ChordGrip
            target="chat"
            label="Chat"
            tab={true}
            selected={roomId === null}
            onclick={() => { railOpen = false; onChord("chat"); }}
          />
          <ChordGrip
            target="switch"
            label="Switch"
            tab={true}
            selected={roomId === "switch"}
            onclick={() => { railOpen = false; onChord("switch"); }}
          />
          <ChordGrip
            target="instruments"
            label="Instruments"
            tab={true}
            selected={roomId === "instruments"}
            onclick={() => { railOpen = false; onChord("instruments"); }}
          />
          <ChordGrip
            target="custody"
            label="Custody"
            tab={true}
            selected={roomId === "custody"}
            onclick={() => { railOpen = false; onChord("custody"); }}
          />
          <ChordGrip
            target="editor"
            label="Editor"
            tab={true}
            selected={roomId === "editor"}
            onclick={() => { railOpen = false; onChord("editor"); }}
          />
          <ChordGrip
            target="settings"
            label="Settings"
            tab={true}
            selected={roomId === "settings"}
            onclick={() => { railOpen = false; onChord("settings"); }}
          />
          <ChordGrip
            target="lens"
            label="Lens"
            tab={true}
            selected={false}
            onclick={() => { railOpen = false; onChord("lens"); }}
          />
        </div>
      </Popover>
    {/if}
    <SideRail {revealed} {menu} />
    {/if}
  </div>
</header>

<style>
  .horizon {
    height: var(--horizon-h);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    background: var(--ground-0);
    border-bottom: var(--hairline-w) solid var(--line-1);
    padding: 0 var(--sp-3);
    column-gap: var(--sp-2);
    /* The containing block for the folded rail's menu. `.side.right` clips
     * its own overflow; hanging the menu off the HORIZON instead means the
     * clip that keeps the strip tidy cannot also swallow the menu. */
    position: relative;
  }
  .side {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
  }
  .side.right {
    justify-content: flex-end;
    /* Under crowding (4 pinned monitors on a narrow box) the overflow runs
     * off the START edge and is clipped here, so the horizon never spills
     * and the RAIL — the mouse path to four rooms — is never the thing that
     * disappears. Monitors keep their uniform 96×28 (§2.4). */
  }
  .monitor,
  .rail {
    flex: none;
  }
  .rail {
    display: var(--rail-display);
    align-items: center;
    gap: var(--sp-0);
    padding-left: var(--sp-2);
    margin-left: var(--sp-1);
    border-left: var(--hairline-w) solid var(--line-1);
  }
  /* The folded rail's own control — the mirror of `.rail`, and only one of
   * the two is ever displayed (tokens.css owns which, by width). */
  .rail-fold {
    display: var(--rail-fold-display);
    align-items: center;
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    padding: 0 var(--sp-2);
    margin-left: var(--sp-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
  }
  .rail-fold:hover:enabled {
    background: var(--layer-hover);
    color: var(--ink-1);
  }
  /* Inside the menu the grips read as a column of words, one per line — the
   * same engraved vocabulary the wide rail uses, just stacked. */
  .rail-list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-0);
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    /* REST-STATE FLOOR (audit §7.5): every button in the top chrome wears
     * a hairline edge at rest, so the chrome's controls read as controls. */
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: 0 var(--sp-1);
    cursor: pointer;
  }
  button:disabled {
    color: var(--layer-disabled);
    cursor: default;
  }
  .identity {
    position: relative;
  }
  .glyph {
    width: var(--monitor-h);
    height: var(--monitor-h);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
    display: grid;
    place-items: center;
  }
  .glyph:hover:enabled {
    background: var(--layer-hover);
  }
  .identity-menu {
    position: absolute;
    top: calc(var(--monitor-h) + var(--sp-1));
    left: 0;
    z-index: 40;
    background: var(--ground-3);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-2);
    box-shadow: var(--shadow-sheet);
    padding: var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-width: var(--menu-min-w);
  }
  .who {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .verb { text-align: left; }
  .place {
    flex: 1;
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
    text-align: left;
    min-height: var(--hit-min);
    font-size: var(--f-ui-size);
    color: var(--ink-2);
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--radius-1);
  }
  .place-project, .place-conversation { display: block; width: 100%; min-width: 0; max-width: 100%; }
  .place-project { font-size: var(--f-micro-size); color: var(--accent); }
  .place-conversation { font-size: var(--f-ui-size); color: var(--ink-1); }
  .place:hover:enabled {
    background: var(--layer-hover);
    color: var(--ink-1);
  }
  .annunciators {
    display: flex;
    gap: var(--sp-2);
    min-height: var(--monitor-h);
    align-items: center;
  }
  .annunciator {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    height: var(--monitor-h);
    padding: 0 var(--sp-2);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    color: var(--warn);
    font-size: var(--f-data-size);
    font-family: var(--face-mono);
  }
  .a-verb {
    color: var(--ink-1);
  }
  /* §2.7: the pinned monitors HIDE below the narrow breakpoint. The HORIZON
   * is 40px at every width and nothing in it may wrap, so something has to
   * give — and a monitor is a REFERENCE whose source is one click away
   * (§1.4), while the rail is the only mouse path to four rooms and two
   * modes. The token carries the decision (tokens.css owns every width). */
  .monitor {
    display: var(--monitor-display);
    width: var(--monitor-w);
    height: var(--monitor-h);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-0);
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-2);
    background: var(--ground-1);
  }
  .m-value {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-1);
  }
</style>
