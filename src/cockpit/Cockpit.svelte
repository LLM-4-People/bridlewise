<script lang="ts">
  /**
   * COCKPIT root — the shell grammar (§2): HORIZON · FLOW · SWEEP · DESK,
   * fixed instruments framing a full-bleed flow; ROOMS summoned over it;
   * SCOPE as a right sheet (side-docked ≥1900px). Layout is never
   * user-arranged; the shell owns geometry, breakpoints (§2.7), the
   * complete keyboard grammar, and the one-reveal boot (§10).
   *
   * ONE-REVEAL LAW (§10.3): the static shell renders at exact final
   * geometry on first paint, inert, in the ground palette. The
   * registration column types real probes into the flow measure. When the
   * critical batch completes, `revealed` flips in a single frame —
   * everything that appears with the reveal appears IN that frame — and
   * afterwards nothing mounts, moves or resizes except from user action
   * or a live event (guard: tests/cockpit/cockpit-boot-owner*).
   *
   * Surfaces integrate through the file conventions + ShellApi in
   * shell/contract.ts — never by editing this file.
   */
  import { onMount, setContext, tick, untrack, type Component } from "svelte";

  import { submitLogout } from "../client.ts";
  import { currentProject, projects } from "../state/projects.ts";
  import { currentChat, currentChatId } from "../state/chats.ts";
  // WORKSPACES (state/workspaces.ts) — a page may hold several projects at
  // once, and the strip below the HORIZON is how you move between them.
  import { activeWorkspaceId, workspaceCount } from "../state/workspaces.ts";
  // THE GLOBAL PAST VIEW (§6.2). The shell owns the unmistakable state — a
  // planted head is not the sweep's private mode, it is the whole cockpit's
  // condition, and it has to read that way from anywhere on screen.
  import { asOfHead, PAST_VIEW_ACT_REASON, returnToLive } from "../data/asof.ts";

  import {
    SHELL_CONTEXT_KEY,
    type Annunciator,
    type DeskLineRequest,
    type GrammarTarget,
    type Monitor,
    type OutletProps,
    type RoomId,
    type ScopeRequest,
    type ShellApi,
    type VisitedRoom,
  } from "./shell/contract.ts";
  import { loadOutlet, loadRoom, roomExists } from "./shell/outlets.ts";
  // THE KEY-ROUTING CONTRACT (§2.7) — the claim stack and the dismissal
  // ladder. The shell walks the ladder here; routing.ts owns the stacks and
  // the rule that a second permanent claimant is a defect, not a winner.
  import { createKeyRouting } from "./shell/routing.ts";
  // WARM DATA. Three seams, one idea: never show a cold start for something
  // the app already knows.
  //   - `setVisibleRoom` tells kept-alive rooms whether anyone is looking, so
  //     a hidden room stops POLLING without ever clearing what it measured;
  //   - `recordRoomActivation` counts real opens (never seeded) so the idle
  //     warm can order itself by the user's own history;
  //   - `warmAtIdle` fills the Broker cache after the reveal — cache writes
  //     only, no render path, so the one-reveal law holds by construction.
  import { bindShellVisibility, setVisibleRoom } from "./shell/room-visibility.ts";
  // THE ANNUNCIATOR FEED (§2.4). The shell consumes the one derivation of
  // "which abnormal facts light a slot" through its own door
  // (`setAnnunciators`), so the API surfaces and the derived feed cannot
  // disagree about what a lit slot is.
  import { horizonAnnunciators } from "./shell/annunciator-data.ts";
  import { recordRoomActivation, warmAtIdle } from "./shell/room-warm.ts";
  // PER-WORKSPACE VIEW. The open room and the open desk belong to ONE
  // workspace; switching restores what that tab was looking at, by patching
  // the two values — the room itself stays mounted (keep-alive), so a switch
  // costs no remount, no reload and no blank frame.
  import { bindWorkspaceView, noteShellView, viewToRecord } from "./shell/workspace-view.ts";
  import { armNewTab, clearOpenIntent, openIntent } from "./shell/open-intent.ts";
  import { consumeShellViewRequest, pendingShellView } from "./shell/view-request.ts";
  import { requestEditorOpen } from "./editor/open-request.ts";
  import { holdFlowAnchor } from "./shell/flow-anchor.ts";
  import {
    GRAMMAR,
    chordLabel,
    detectMac,
    isNativeKeyTarget,
    matchChord,
    mouseTitleFor,
    type ChordSpec,
  } from "./shell/keyboard.ts";
  import { createRegistration, type AuthGate, type ProbeLine } from "./boot/probes.ts";
  import { SIDE_DOCK_MIN_PX, RUN_PANE_DOCK_MIN_PX, logTime } from "./shell/config.ts";

  import Horizon from "./shell/Horizon.svelte";
  import WorkspaceStrip from "./shell/WorkspaceStrip.svelte";
  import Desk from "./shell/Desk.svelte";
  import RoomHost from "./shell/RoomHost.svelte";
  import ScopeHost from "./shell/ScopeHost.svelte";
  import RightMenuHost from "./shell/RightMenuHost.svelte";
  // THE RIGHT MENU (shell/right-menu.ts): the flow's ONE inspector column,
  // opened from the flow region's right edge (SideRail's single icon button)
  // and landed at its two groups by the chords (⌘R at the run group, ⌘⇧A at
  // the arm group), closed through the dismissal ladder. The store is the
  // seam the SWEEP's ⌘⇧A claim and the band's `a` key reach the host
  // through — the sweep owns the chord, the shell owns the column.
  import {
    RIGHT_MENU_TITLE,
    closeRightMenu,
    openRightMenu,
    openInspectorSection,
    rightMenu,
    toggleRightMenu,
  } from "./shell/right-menu.ts";
  // The empty-composer refusal's one owner (composer-router owns the send's
  // refusal sentences; the shell's no-flow hint states the same one).
  import { COMPOSER_EMPTY_REASON } from "./flow/composer-router.ts";
  import GrammarHint from "./shell/GrammarHint.svelte";
  import UpdateChip from "./shell/UpdateChip.svelte";
  import Registration from "./boot/Registration.svelte";
  import ConnectionBlock from "./shell/ConnectionBlock.svelte";
  // THE ONE CONNECTION FACT (src/data/connection.ts), read here because
  // an unreachable API is the WHOLE cockpit's condition — the same reason the
  // planted head is owned by the shell and not by the sweep.
  import { connection } from "../data/connection.ts";

  /**
   * IS THE WHOLE COCKPIT BLOCKED. One derivation from the one owner — never
   * a second opinion about reachability, and never a per-surface guess.
   *
   * `inert` is what actually does the blocking: it removes the entire shell
   * subtree from hit-testing, from the tab order and from the accessibility
   * tree in a single declaration, so a control a future surface adds without
   * knowing this exists is covered too. The opaque ground in
   * ConnectionBlock.svelte is only how that is made visible.
   */
  const apiUnreachable = $derived($connection.kind === "unreachable");

  // ── boot / reveal ──────────────────────────────────────────────────────
  let revealed = $state(false);
  let revealTs = 0;
  let lines = $state<readonly ProbeLine[]>([]);
  let gate = $state<AuthGate | null>(null);
  let complete = $state(false);
  let username = $state("");
  /**
   * Signed-in working surface. `revealed` is boot-complete; chrome (desk,
   * composer, sweep, room tabs, place chip) waits for a username so a
   * finished-but-signed-out probe column cannot grow the shell.
   */
  const authed = $derived(revealed && username.length > 0);

  // ── shell state ────────────────────────────────────────────────────────
  /**
   * THE RIGHT MENUS — the run inspector and the arm menu, one column on the
   * flow's right edge (shell/right-menu.ts owns the state; see the import's
   * note). Per-workspace like the desk for the RUN half: a tab switch
   * restores what that tab was looking at (the recorded view's
   * `runPaneOpen`), and a reload deliberately does NOT reopen either (the
   * one-reveal law: nothing mounts post-reveal except from a user action;
   * the store starts null and is not persisted).
   */
  let composerText = $state("");
  let focusRequest = $state(0);
  let hintText = $state("");
  let hintSeq = $state(0);
  let roomId = $state<RoomId | null>(null);
  // Imports may finish after another gesture or workspace activation. Only
  // the most recent navigation may publish a room or its failure message.
  let roomRequest = 0;
  /**
   * KEEP-ALIVE (§2.5). Every room the user has opened at least once stays
   * mounted; closing hides it, it does not unmount. This list is the stack —
   * first-visit order, one entry per room, never removed.
   *
   * This is the fix for "every menu we go, every options reloads": an
   * unmount-on-close room paid its whole mount cost again on every reopen and
   * lost scroll position, expansion state and every painted value with it. A
   * kept-alive room reopens as a CSS flip. Only VISITED rooms are kept — the
   * shell never mounts one speculatively, so the cost is bounded by what the
   * user actually used.
   */
  let visitedRooms = $state<readonly VisitedRoom[]>([]);
  /**
   * THE CONTROL THAT SUMMONED THE OPEN ROOM — captured at the open, restored
   * at the close (the identity menu's own pattern: Popover.svelte captures
   * `document.activeElement` on open and hands focus back on close).
   *
   * WHY THE SHELL OWNS THIS AND NOT EACH ROOM. Every close path — the room's
   * CLOSE button, the Esc ladder, the chat chord, an agent's navigation, the
   * Switch's own choice — funnels through `closeRoom`, and no room knows who
   * opened it. Capturing at `openRoomById`'s top (synchronously, before the
   * first-open import awaits) records the element the SUMMONING GESTURE left
   * focused: the rail grip for a mouse open, whatever held focus for a chord.
   * Captured ONLY when no room is already open — a room-to-room hop (the lens
   * routing a settings jump) keeps the ORIGINAL flow-layer opener, which is
   * the control the whole excursion started from; re-capturing mid-chain
   * would name a focus inside a room that is hidden by the time it closes,
   * and restoring focus into a hidden room is the one state this must never
   * produce. The boot landing and the shell-view restore set `roomId`
   * directly, bypassing the capture on purpose: a room nobody summoned has
   * no opener to return to, and focus falls to the document as before.
   */
  let roomOpener: HTMLElement | null = null;
  let scopeReq = $state<ScopeRequest | null>(null);
  let scopeSelection: string | null = null;
  const scopeIdentity = $derived(JSON.stringify([$activeWorkspaceId, $currentProject?.id, $currentChatId]));
  $effect(() => {
    const selection = scopeIdentity;
    untrack(() => { if (scopeSelection !== null && selection !== scopeSelection) shell.closeScope(); });
  });
  /** The room the open scope was opened FROM (its dismissal context) — the
   *  one fact that decides both whether the sheet may dock into the flow and
   *  whether it paints above the room plane. Null = the base shell. */
  let scopeCtx = $state<RoomId | null>(null);
  let scopeInInspector = $state(false);
  let deskLineReq = $state<DeskLineRequest | null>(null);
  let annunciators = $state<readonly Annunciator[]>([]);
  let monitors = $state<readonly Monitor[]>([]);
  let wideViewport = $state(false);
  /**
   * THE TAB STRIP (§ shell/WorkspaceStrip.svelte). It exists only when there
   * is more than one workspace to name — with one, there is nothing to
   * switch between and the place chip already says where you are.
   */
  const stripVisible = $derived($workspaceCount > 1);
  /** Whether the strip is currently NAMING the active pair. False when the
   * strip is absent, and also when it is too narrow to render even one tab
   * — in which case the place chip comes back rather than leaving the
   * active workspace unnamed. */
  let activeTabVisible = $state(false);
  const placeVisible = $derived(!stripVisible || !activeTabVisible);
  /** The flow region, for the scroll anchor held across a strip change. */
  let flowRegionEl = $state<HTMLElement | null>(null);

  // ── outlet components (loaded BEFORE the reveal — §10.3) ──────────────
  let FlowComp = $state<Component<OutletProps> | null>(null);
  let SweepComp = $state<Component<OutletProps> | null>(null);
  let GaugeComp = $state<Component<OutletProps> | null>(null);
  let LensComp = $state<Component<OutletProps> | null>(null);
  /** Preloaded so the Switch can land IN the reveal frame, not after it.
   * Not $state: it is written once before reveal and read into visitedRooms
   * in that same frame — a reactive assignment would re-render after the
   * reveal. */
  let SwitchComp: Component<OutletProps> | null = null;
  /** Outlets whose module EXISTS but failed to import. A broken outlet
   * must not block the reveal (§10.3 — a failing non-critical read renders
   * as an in-place absence, never a hung boot); the failure prints as its
   * own registration line and the outlet renders "failed to load". */
  let outletFailed = $state<ReadonlySet<string>>(new Set());
  let outletsReady: Promise<void> = Promise.resolve();

  const isMac = detectMac(typeof navigator !== "undefined" ? navigator : {});
  // Platform-true chord labels (shell/chords.ts — the one spelling owner).
  const kSend = chordLabel({ key: "Enter", primary: true });
  /**
   * The routing stacks. A conflicting PERMANENT claim is loud: in dev it
   * throws at the claim site, where the two claimants can be read off the
   * stack trace; in a shipped build it refuses the claim and states the
   * collision on the grammar hint rather than taking a chord away from the
   * surface that already answers it.
   */
  const routing = createKeyRouting({
    strict: import.meta.env.DEV,
    onRefused: (message) => showHint(message),
  });
  const composerSubmitHandlers = new Set<(text: string) => void>();
  const composerChangeHandlers = new Set<(text: string) => void>();

  // Per-keystroke composer seam: the bound input writes composerText; this
  // effect fans the new value out to subscribers (live `/`-autocomplete).
  let lastNotifiedComposerText = "";
  $effect(() => {
    const text = composerText;
    if (text === lastNotifiedComposerText) return;
    lastNotifiedComposerText = text;
    for (const handler of composerChangeHandlers) handler(text);
  });

  const projectList = $derived($projects);
  // ── the place (§2.4): `project ▸ conversation`, LIVE from the stores.
  // `currentChatId` is the selection truth (persisted; boot validates it —
  // boot/probes.ts) and `currentChat` its metadata; the moment a
  // conversation exists (auto-created on first send, picked in the Switch,
  // restored at boot) the place says so — never a frozen boot snapshot.
  const placeProjectName = $derived(
    $currentProject?.name ?? projectList[0]?.name ?? null,
  );
  const placeConversation = $derived.by(() => {
    const open = $currentChat;
    if (open !== null) return open.title.length > 0 ? open.title : "untitled conversation";
    const id = $currentChatId;
    // Selected but metadata not (yet) loaded: the id is the honest fact.
    if (id !== null) return `conversation ${id}`;
    return "no conversation open";
  });
  const place = $derived(
    !revealed
      ? ""
      : placeProjectName === null
        ? "no project yet"
        : `${placeProjectName} ▸ ${placeConversation}`,
  );
  // Docking is a property of the FLOW layout — the sheet becomes a grid
  // column beside the conversation. A sheet that belongs to a ROOM is not
  // part of the flow (the room covers the flow entirely), so it never docks:
  // docked-under-a-room was the invisible-sheet defect by another door.
  const scopeDocked = $derived(scopeReq !== null && !scopeInInspector && wideViewport && scopeCtx === null);
  /**
   * THE RUN PANE'S DOCK POINT. The pane docks beside the flow while the
   * viewport can hold the flow's floor beside the pane's width; below
   * that, squeezing the flow under its floor to keep an inspector docked
   * would trade the conversation's readability for the inspector's
   * persistence — the pane overlays instead, exactly as the SCOPE sheet
   * does under its own breakpoint. The number lives in shell/config.ts
   * (the shell's breakpoint owner), derived from the two token widths.
   */
  let paneDocks = $state(false);
  const inspectorPresentation = $derived(!paneDocks ? "overlay" : roomId === null ? "flow-docked" : "room-docked");
  const inspectorOverlays = $derived($rightMenu !== null && inspectorPresentation === "overlay");
  // STACKING FOLLOWS THE DISMISSAL LADDER. A scope whose dismissal context
  // is the room ON SCREEN is the innermost open surface — Esc takes it
  // before the room (routing.ts's ladder, step 1 before step 2) — so it
  // must also PAINT above that room; a sheet Esc dismisses first that is
  // invisible under the room plane was the `,`-chord-in-a-room defect. A
  // scope from any OTHER context stays under the room, exactly as the
  // ladder has Esc close the room first.
  const scopeOverRoom = $derived(
    scopeReq !== null && roomId !== null && scopeCtx === roomId,
  );

  // ── PAST VIEW (§6.2) ───────────────────────────────────────────────────
  // The planted head, read from the ONE owner (src/data/asof.ts) — the
  // same atom the Broker consults before every read. There is no second
  // copy to fall out of step with the data on screen.
  const pastAsOf = $derived($asOfHead);

  // ── MISSING PROJECT FOLDER ─────────────────────────────────────────────
  // The active project's folder presence is measured server-side on every
  // project read (the wire view owns the field). A project whose folder was
  // wiped is a first-class state the user should see BEFORE a run discovers
  // it — so the chat surface carries a band, with the way out (the Switch's
  // relink picker) beside it.
  const activeFolder = $derived($currentProject?.folder);
  const folderMissing = $derived(activeFolder === "missing" || activeFolder === "unreadable");

  // ── ShellApi (stable object; closures read live $state) ───────────────
  const shell: ShellApi = {
    revealAt: () => revealTs,
    openRoom: (id) => void openRoomById(id),
    closeRoom: () => {
      roomRequest += 1;
      // The room is HIDDEN, not dropped: `visitedRooms` keeps its subtree,
      // its scroll offset and its measured values, so the next open restores
      // instantly instead of starting cold.
      roomId = null;
      // FOCUS GOES BACK TO WHOEVER SUMMONED THE ROOM. The closing room is
      // `inert` the same frame, and a focused element inside an inert subtree
      // is dropped to BODY by the engine — which strands a keyboard reader at
      // the document top for their next Tab. The opener capture
      // (`openRoomById`) is restored here, exactly the identity-menu pattern;
      // `isConnected` is the honest guard: an opener unmounted since the open
      // (a beat verb virtualized away) has nothing to come back to, and
      // focus falls to the document as before rather than to a dead node.
      const opener = roomOpener;
      const request = roomRequest;
      void tick().then(() => {
        if (request === roomRequest && roomId === null && opener?.isConnected) opener.focus();
      });
      roomOpener = null;
      // Leaving the Switch without choosing disarms the `+`. An intent that
      // survived the room would make the NEXT ⌘J open a tab nobody asked for.
      clearOpenIntent();
    },
    openScope: (req) => {
      // The SCOPE is a dismissal layer like any other surface, bound to the
      // room it was opened FROM (Instruments opens setting sheets from inside
      // its own room). That is what makes Esc close the sheet before the room
      // that summoned it, instead of pulling the room out from under it.
      releaseScopeLayer?.();
      scopeReq = req;
      scopeSelection = untrack(() => scopeIdentity);
      scopeInInspector = rightMenu.get() !== null;
      scopeCtx = untrack(() => roomId);
      // An inspector detail is a page inside the same surface. Its one
      // dismissal entry goes Back before closing; no competing outer layer.
      if (!scopeInInspector) releaseScopeLayer = routing.pushDismiss(
        { label: `the ${req.title} scope`, dismiss: () => shell.closeScope() },
        untrack(() => scopeCtx),
      );
    },
    closeScope: () => {
      scopeReq = null;
      scopeSelection = null;
      scopeInInspector = false;
      scopeCtx = null;
      releaseScopeLayer?.();
      releaseScopeLayer = null;
    },
    setAnnunciators: (list) => {
      annunciators = list;
    },
    setMonitors: (list) => {
      monitors = list;
    },
    claimKey: (target, handler, opts) => routing.claim(target, handler, opts),
    // A layer is stamped with the room ON SCREEN right now — the surface does
    // not have to know, or care, which room it is nested in.
    //
    // UNTRACKED, and it has to be. A surface registers from a `$effect`, so a
    // tracked read of `roomId` here would make that effect depend on it: the
    // moment the room closed, the surface's own effect would re-run and push
    // its layer again stamped with the NEW context — and a difference left
    // open inside a hidden Custody would start answering Esc from the flow.
    // The context is a snapshot of where the surface opened, not a live read.
    pushDismiss: (req) => routing.pushDismiss(req, untrack(() => roomId)),
    hint: showHint,
    composerText: () => composerText,
    onComposerSubmit: (handler) => {
      composerSubmitHandlers.add(handler);
      return () => composerSubmitHandlers.delete(handler);
    },
    prefillComposer: (text) => {
      composerText = text;
      focusRequest += 1;
    },
    clearComposer: (sent) => {
      // Consume EXACTLY the sent snapshot. The reader may have kept typing
      // between the send and this clear — those words are theirs, still in
      // flight, and wiping them was silent data loss one keystroke wide.
      // The snapshot leaves only as the field's PREFIX (the position it was
      // sent from); an edited-since field is not provably the send's to
      // take, so it stands untouched.
      composerText =
        composerText === sent
          ? ""
          : composerText.startsWith(sent)
            ? composerText.slice(sent.length)
            : composerText;
    },
    restoreComposerText: (text) => {
      // A refused send consumed nothing: the words come back ahead of
      // whatever arrived in the box meanwhile (the reader's in-window
      // typing), which is the order they were typed in — the box returns to
      // what it would have held had the send never taken them.
      composerText = text + composerText;
      focusRequest += 1;
    },
    onComposerChange: (handler) => {
      composerChangeHandlers.add(handler);
      return () => composerChangeHandlers.delete(handler);
    },
    setDeskLine: (req) => {
      deskLineReq = req;
    },
  };
  setContext(SHELL_CONTEXT_KEY, shell);

  /** Release for the SCOPE's own dismissal layer (one scope at a time). */
  let releaseScopeLayer: (() => void) | null = null;

  // ── THE TOGGLED SHELL SURFACES JOIN THE LADDER (the LENS precedent) ─────
  //
  // The right menus and the desk are toggles with aria-pressed, exactly like
  // LENS — and LENS registers a dismissal layer while it is armed, so a
  // toggled surface is a layer, not a mode outside the grammar: Esc closes
  // the most recently raised one first, and the "nothing open" hint cannot
  // fire while a surface is visibly up.
  //
  // PUSHED WITH ctx = null, deliberately. These live UNDER rooms (a room
  // covers the flow region and the desk's housing), so while a room is on
  // screen the room is the innermost thing Esc means and the menu/desk
  // layers are inactive by their context — close the room first, and the
  // next press reaches them. Registration is an $effect on the state itself,
  // so every path that raises or lowers the surface (the chord, the side
  // rail, the `+`-tab restore, a view request from the LLM's
  // control_interface, the SWEEP's ⌘⇧A claim) is covered without anyone
  // remembering to register.
  $effect(() => {
    const menu = $rightMenu;
    if (menu === null && scopeInInspector) untrack(() => shell.closeScope());
    if (menu === null) return;
    return routing.pushDismiss(
      { label: `the ${RIGHT_MENU_TITLE}`, dismiss: () => {
        if (scopeInInspector && scopeReq !== null) shell.closeScope();
        else closeRightMenu();
      } },
      roomId,
    );
  });

  function showHint(text: string): void {
    hintText = text;
    hintSeq += 1;
  }

  /**
   * The `+` — open another project or conversation in a NEW tab.
   *
   * It summons the Switch rather than inventing a second picker (§5.1: one
   * navigation gesture), with the choice armed to land in a new workspace.
   * Everything else that opens the Switch goes through `openRoomById`, which
   * disarms — so the mode cannot leak into the next ⌘J.
   */
  function newTab(): void {
    armNewTab();
    void openRoomById("switch", { armed: true });
  }

  async function openRoomById(
    id: RoomId,
    opts: Readonly<{ armed?: boolean }> = {},
  ): Promise<void> {
    const request = ++roomRequest;
    // Opening the Switch any other way means the ORIGINAL gesture: choosing
    // replaces what this tab is showing.
    if (id === "switch" && opts.armed !== true) clearOpenIntent();
    // THE OPENER CAPTURE — see `roomOpener`'s declaration note. Only a
    // flow-layer → room transition captures: at this instant no room is on
    // screen, so whatever holds focus is by construction in the visible flow
    // layer (the rail grip, the composer), and it will still be there —
    // visible and reachable — when the room closes.
    if (roomId === null) {
      const active = document.activeElement;
      roomOpener = active instanceof HTMLElement ? active : null;
    }
    // A REVISIT IS A CSS FLIP. The room is already mounted with its scroll
    // position, its expansion state and its last-known values on screen, so
    // there is no import to await and no frame to wait for — this is the
    // ~0ms path the <200ms room-open budget used to be spent on.
    if (visitedRooms.some((r) => r.id === id)) {
      roomId = id;
      recordRoomActivation(id);
      return;
    }
    let comp: Component<OutletProps> | null;
    try {
      comp = (await loadRoom(id)) as Component<OutletProps> | null;
    } catch {
      if (request !== roomRequest) return;
      // The dynamic room import failed (stale HMR graph, dropped network).
      // Routing law (§2.7): a chord NEVER silently does nothing — state the
      // failure and the honest way out instead of half-opening the room.
      // The way out is TRYING AGAIN, not a reload: the room never entered
      // `visitedRooms`, so the very next press re-runs this import — the
      // old "reload the page" hint prescribed a full page loss for a retry
      // the next keystroke already performs.
      showHint(`${id} failed to load — try again`);
      return;
    }
    if (request !== roomRequest) return;
    // Guard the race: two opens of the same room before either import
    // resolved must not stack two copies of it.
    if (!visitedRooms.some((r) => r.id === id)) {
      visitedRooms = [...visitedRooms, { id, comp }];
    }
    roomId = id;
    recordRoomActivation(id);
  }

  // WHAT IS ON SCREEN — published once, from the one place that knows. Kept-
  // alive rooms read this to stop their acquisition while hidden (and to
  // revalidate when shown again) WITHOUT ever clearing what they measured.
  // See shell/room-visibility.ts.
  $effect(() => {
    setVisibleRoom(roomId);
  });

  // THE ANNUNCIATORS LIGHT FROM THE DERIVED FEED — through the same door any
  // surface would use, so there is exactly one producer and one cap.
  $effect(() => {
    shell.setAnnunciators($horizonAnnunciators);
  });

  // WHAT THIS TAB IS LOOKING AT — recorded while it is still the active one,
  // which is the only moment `workspaceScopedKey` can name its slot. The
  // incoming workspace's values are applied by `bindWorkspaceView` (onMount).
  $effect(() => {
    // AN ARMED SWITCH BELONGS TO THE TAB THAT DOES NOT EXIST YET. The `+`
    // opens the picker over the tab you are in, but you did not ask to leave
    // that tab sitting in the picker — recording it would drop you back into
    // the Switch the next time you came back here, having chosen nothing.
    noteShellView(viewToRecord(roomId, $openIntent === "new-tab", $rightMenu));
  });

  // THE READER'S PLACE, held across the strip appearing or disappearing.
  // The strip takes a row out of the flow's box, and a browser keeps
  // `scrollTop` across a resize — so without this the conversation jumps by
  // exactly the strip's height. Captured BEFORE the DOM changes ($effect.pre)
  // and restored after it, so the same beat stays under the same pixel row.
  let restoreFlowAnchor: (() => void) | null = null;
  $effect.pre(() => {
    stripVisible;
    restoreFlowAnchor = holdFlowAnchor(flowRegionEl);
  });
  $effect(() => {
    stripVisible;
    restoreFlowAnchor?.();
    restoreFlowAnchor = null;
  });

  // ── registration ───────────────────────────────────────────────────────
  const registration = createRegistration({
    onLine: (line) => {
      lines = [...lines, line];
    },
    onAuthGate: (g) => {
      gate = g;
    },
    onComplete: ({ username: user }) => {
      username = user;
      void reveal();
    },
  });

  /** Cancels the post-reveal idle warm; held so a teardown cannot leave a
   * speculative fill running behind the cockpit that asked for it. */
  let cancelIdleWarm: (() => void) | null = null;

  async function reveal(): Promise<void> {
    await outletsReady; // outlet modules are in memory before the frame
    // Capture BEFORE the frame: $state reads inside rAF can see a stale
    // snapshot. The landing module was assigned when outletsReady settled.
    const landing = SwitchComp;
    requestAnimationFrame(() => {
      // THE one coordinated frame (§10.2 step 4): everything the reveal
      // brings appears in this single update; revealTs marks the boundary
      // the boot-owner guard measures from.
      revealTs = performance.now();
      complete = true;
      revealed = true;
      // THE LANDING SURFACE is the project room (the Switch). Loaded
      // before this frame, mounted IN it — not after it. A room summoning
      // itself after the reveal would break the one-reveal law; landing
      // ON the Switch is the first paint of the working surface.
      if (landing !== null && !visitedRooms.some((r) => r.id === "switch")) {
        visitedRooms = [{ id: "switch", comp: landing }];
        roomId = "switch";
      }
      // THE IDLE FILL — started AFTER the reveal frame has been committed,
      // so it can never compete with it, and expressed purely as Broker
      // prefetches. ONE-REVEAL LAW (§10.3) is not merely respected here, it
      // is unbreakable: warming writes to the cache and has no render path,
      // so there is nothing it could mount, move or resize. The order is the
      // user's own measured activation counts, falling back to a declared
      // static order on a first session (shell/room-warm.ts).
      cancelIdleWarm = warmAtIdle();
    });
  }

  function onAuthed(user: string, ms: number): void {
    gate = null;
    lines = [
      ...lines,
      {
        id: "signed-in",
        label: "signed in",
        detail: `${user} · recorded ${logTime(Date.now())}`,
        ms,
        state: "ok",
      },
    ];
    void registration.afterAuth(user);
  }

  /**
   * Start the registration over.
   *
   * RE-ENTRANT-SAFE, and that is not defensive padding: two overlapping
   * `registration.start()` calls both append a `session` line, and the
   * column is a KEYED each block — Svelte throws `each_key_duplicate` and
   * the shell dies. It is reachable by a reader double-clicking "probe
   * again" as well as by the reconnect effect below firing while a probe is
   * still resolving.
   */
  let bootRunning = false;
  function retryBoot(): void {
    // Re-entrancy is the whole point — see above. Every path that begins a
    // registration goes through here: the mount, the reconnect effect, and
    // the reader's own "probe again".
    if (bootRunning) return;
    bootRunning = true;
    lines = [];
    gate = null;
    void registration.start().finally(() => {
      bootRunning = false;
    });
  }

  /**
   * THE BOOT RESUMES BY ITSELF when the API comes back.
   *
   * THE USER'S INSTRUCTION, VERBATIM: "it must also reconnect by itself and
   * clear error/blocking state". For a cockpit that HAS revealed, the Broker's
   * `revalidateAll` does that — every standing read re-runs and the surfaces
   * repaint. For one that never got past registration there is nothing
   * standing to revalidate: the boot did not complete, so no feed subscribed,
   * and clearing the block alone would leave the reader looking at a dead
   * registration column with a manual "probe again" as their only way out.
   * That is the same manual-recovery failure one layer up.
   *
   * So the un-revealed case restarts the boot instead. Guarded on `revealed`
   * rather than on the gate, because the question is "did the cockpit ever
   * come up", and a boot that failed at `schema` has no gate set at all.
   */
  let wasUnreachable = false;
  $effect(() => {
    const down = apiUnreachable;
    untrack(() => {
      if (down) {
        wasUnreachable = true;
        return;
      }
      // ONLY ON THE TRANSITION. Without this latch the effect would fire on
      // mount — when nothing has gone wrong — and start a SECOND registration
      // beside the one `onMount` already started, which is a doubled boot
      // dressed up as a recovery.
      if (!wasUnreachable) return;
      wasUnreachable = false;
      if (!revealed) retryBoot();
    });
  });

  async function signOut(): Promise<void> {
    await submitLogout();
    // Boot is the product's entry (§10) — a fresh registration, not a
    // client-side unmount dance over stale stores.
    window.location.reload();
  }

  // ── keyboard grammar (complete — §2.7) ────────────────────────────────
  const ROOM_TARGETS: Partial<Record<GrammarTarget, RoomId>> = {
    switch: "switch",
    instruments: "instruments",
    settings: "settings",
    custody: "custody",
    editor: "editor",
  };

  function notBuilt(spec: ChordSpec): void {
    showHint(`${spec.chord} ${spec.means} — not built yet`);
  }

  /**
   * `,` — the focused fact's setting. Nothing here is new machinery: the
   * LENS stamp vocabulary already declares which pixels are facts
   * (`data-setting` / `data-signal`, read by `readTarget` up the ancestor
   * chain), and the settings openers already resolve a fact to its sheet
   * mechanically (identical-id, then namespace, then the honest "nothing is
   * linked" hint). This chord asks those two existing owners about whatever
   * currently HOLDS FOCUS — the keyboard's own notion of "this one".
   *
   * Imported at press time: the settings surface and the callout model stay
   * out of the boot graph, exactly as the rooms do.
   */
  async function openSettingForFocusedFact(spec: ChordSpec): Promise<void> {
    // The catch guards the IMPORTS and nothing else: an error thrown by the
    // openers themselves is a defect that must surface, not be re-labelled
    // "failed to load" — an exception that becomes a plausible answer is a
    // lie with a plausible shape.
    let modules;
    try {
      modules = await Promise.all([
        import("./lens/lens-callout-data.ts"),
        import("./settings/open.ts"),
      ]);
    } catch {
      // The same class as a failed room import: state it, the next press retries.
      showHint(`${spec.chord} ${spec.means} — failed to load, try again`);
      return;
    }
    const [{ readTarget }, opener] = modules;
    const target = readTarget(document.activeElement);
    if (target.settingId !== null) opener.openSettingSheet(shell, target.settingId);
    else if (target.signalId !== null) opener.openSettingForSignal(shell, target.signalId);
    else
      showHint(
        `${spec.chord} ${spec.means} — nothing focused declares a fact · instrument cells and setting rows do`,
      );
  }

  function route(spec: ChordSpec, shift: boolean): void {
    const claimed = routing.handlerFor(spec.target);

    if (spec.target === "desk") {
      toggleRightMenu("setup");
      return;
    }
    if (spec.target === "run") {
      toggleRightMenu("run");
      return;
    }
    if (spec.target === "chat") {
      // Chat is the flow outlet: close any room, keep composer + sweep.
      shell.closeRoom();
      return;
    }
    if (spec.target === "escape") {
      // THE DISMISSAL LADDER (shell/routing.ts). Innermost first, one level
      // per press — a popover inside a scope inside a room dismisses in that
      // order, and nothing on the way down needs a capture-phase listener to
      // get its turn.
      //
      // 1. the innermost open surface in the room ON SCREEN. Layers pushed
      //    inside a kept-alive room that is currently hidden are not on
      //    screen, so they are not what Esc means here.
      const layer = routing.topDismissal(roomId);
      if (layer !== null) {
        layer.dismiss();
        return;
      }
      // 2. the room itself.
      if (roomId !== null) {
        shell.closeRoom();
        return;
      }
      // 3. a scope with no active layer left — one opened inside a room the
      //    user has since closed. Rare, and an orphan is still on screen.
      if (scopeReq !== null) {
        shell.closeScope();
        return;
      }
      // 4. the planted head. A past view is a CONDITION, not a surface
      //    nested in anything, so it waits until nothing is open. The SWEEP
      //    pushes this floor layer (its return-to-live also unpins the band's
      //    view); the fallback below is for a shell with no sweep mounted —
      //    a narrow shell, a failed outlet — where the head can still be
      //    planted by a restored session and Esc must still be the way back.
      const floor = routing.floorDismissal();
      if (floor !== null) {
        floor.dismiss();
        return;
      }
      if (asOfHead.get() !== null) {
        returnToLive();
        return;
      }
      showHint("Esc — nothing open, already at now");
      return;
    }
    if (spec.target === "command") {
      focusRequest += 1;
      if (claimed !== undefined) claimed({ shift });
      else if (spec.key === "k")
        showHint(`${spec.chord} command grammar — not built yet · the composer keeps your words`);
      return;
    }
    if (spec.target === "send") {
      submitComposer();
      return;
    }
    if (spec.target === "setting") {
      if (claimed !== undefined) {
        claimed({ shift });
        return;
      }
      void openSettingForFocusedFact(spec);
      return;
    }
    const room = ROOM_TARGETS[spec.target];
    if (room !== undefined) {
      if (claimed !== undefined) claimed({ shift });
      else if (roomExists(room)) void openRoomById(room);
      else notBuilt(spec);
      return;
    }
    if (claimed !== undefined) claimed({ shift });
    else notBuilt(spec);
  }

  /**
   * Run a grammar target from a MOUSE gesture (MOUSE-FIRST law, v2.1).
   *
   * It goes through `route()` — the SAME function the keydown handler calls
   * — so a grip and its chord can never diverge: same claim lookup, same
   * room-exists check, same honest "not built yet" hint. `shift` carries the
   * ⇧-variant (a shift-click on a scrub grip scrubs by run, exactly as ⇧[).
   */
  function routeTarget(target: GrammarTarget, shift: boolean = false): void {
    const spec = GRAMMAR.find((s) => s.target === target);
    if (spec === undefined) return;
    route(spec, shift);
  }

  function submitComposer(): void {
    // The button is disabled while a head is planted; this is the KEYBOARD
    // half of the same rule (Enter in the composer, ⌘⏎ from anywhere). The
    // routing law still holds — the chord says what it would have done and
    // why it did not, and the typed words are untouched.
    if (asOfHead.get() !== null) {
      showHint(PAST_VIEW_ACT_REASON);
      return;
    }
    if (composerSubmitHandlers.size > 0) {
      for (const handler of composerSubmitHandlers) handler(composerText);
      return;
    }
    if (composerText.length === 0) {
      showHint(`${kSend} send — ${COMPOSER_EMPTY_REASON}`);
      return;
    }
    showHint(
      `send — the flow is not built yet · your ${composerText.length} characters are kept`,
    );
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.defaultPrevented) return;
    const spec = matchChord(ev, {
      isMac,
      inControl: isNativeKeyTarget(ev.target, ev.key),
    });
    if (spec === null) return;
    ev.preventDefault();
    route(spec, ev.shiftKey);
  }

  onMount(() => {
    // From here until teardown, THIS shell is the authority on what is on
    // screen; kept-alive rooms hold their feeds against it.
    const unbindVisibility = bindShellVisibility();

    // A view asked for from OUTSIDE the shell (the LLM's control_interface
    // pipeline — view-request.ts). Consumed one-shot, and honored through
    // the SAME doors a chord uses: `roomExists` + `openRoomById`, or the
    // shell's own closeRoom for the flow — so an agent's navigation and a
    // pressed ⌘G cannot diverge.
    const unbindViewRequest = pendingShellView.subscribe((req) => {
      if (req === null) return;
      consumeShellViewRequest();
      if (req.kind === "flow") {
        shell.closeRoom();
        return;
      }
      if (req.kind === "pane") {
        if (req.mode === "close" || (req.mode === "toggle" && rightMenu.get() !== null)) closeRightMenu();
        else if (req.section !== undefined) openInspectorSection(req.section);
        else openRightMenu(req.group ?? "run");
        return;
      }
      if (!roomExists(req.id)) {
        showHint(`${req.id} — not built yet`);
        return;
      }
      // THE PAYLOAD. A path rides the request into the room that
      // can consume one — today the editor, through its own one-shot open
      // seam, so the file opens by the identical mechanism a tree click
      // uses. Any other room REFUSES the whole request out loud rather than
      // opening while the payload silently evaporates — a consumed-looking
      // request whose payload went nowhere is the plugged-in-but-inert
      // failure this shell is built to refuse.
      if (req.path !== undefined) {
        if (req.id !== "editor") {
          showHint(`${req.id} — cannot open a file; only the editor can`);
          return;
        }
        requestEditorOpen(req.path);
      }
      void openRoomById(req.id);
    });

    // SWITCHING TABS RESTORES WHAT THAT TAB WAS LOOKING AT. Two assignments,
    // no remount: the room is already mounted (keep-alive), so this is the
    // same CSS flip a re-open is — no blanking, no reload, no layout shift.
    // The recorded view names only the RUN half of the right menus (the arm
    // menu is a transient surface, exactly as its Popover was); restoring a
    // tab that did not have the run column open therefore closes whatever
    // column is up — the incoming tab's record is the truth.
    const unbindWorkspaceView = bindWorkspaceView((view) => {
      roomRequest += 1;
      roomId = view.room;
      if (view.inspector !== null) openRightMenu(view.inspector);
      else closeRightMenu();
    });

    outletsReady = (async () => {
      const load = async (id: "flow" | "sweep" | "gauge" | "lens") => {
        const t0 = performance.now();
        try {
          return (await loadOutlet(id)) as Component<OutletProps> | null;
        } catch {
          // The module exists but would not import. Boot facts print as
          // lines (§10.2) — never a silent hang, never a blocked reveal.
          outletFailed = new Set([...outletFailed, id]);
          lines = [
            ...lines,
            {
              id: `outlet-${id}`,
              label: id,
              detail: "failed to load",
              ms: Math.max(1, Math.round(performance.now() - t0)),
              state: "failed",
            },
          ];
          return null;
        }
      };
      const [flow, sweep, gauge, lens, switchRoom] = await Promise.all([
        load("flow"),
        load("sweep"),
        load("gauge"),
        load("lens"),
        loadRoom("switch").catch(() => null),
      ]);
      FlowComp = flow;
      SweepComp = sweep;
      GaugeComp = gauge;
      LensComp = lens;
      SwitchComp = switchRoom as Component<OutletProps> | null;
    })();

    // matchMedia is absent in jsdom (the boot-owner harness environment);
    // without it the scope simply never side-docks — an overlay-only shell.
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(min-width: ${SIDE_DOCK_MIN_PX}px)`)
        : null;
    wideViewport = mq?.matches ?? false;
    const onMq = (e: MediaQueryListEvent): void => {
      wideViewport = e.matches;
    };
    mq?.addEventListener("change", onMq);
    // The run pane's own dock/overlay breakpoint (its floor is the flow's
    // readability floor, not the scope's wider side-dock point).
    const paneMq =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(min-width: ${RUN_PANE_DOCK_MIN_PX}px)`)
        : null;
    paneDocks = paneMq?.matches ?? true; // no matchMedia → dock (the jsdom floor)
    const onPaneMq = (e: MediaQueryListEvent): void => {
      paneDocks = e.matches;
    };
    paneMq?.addEventListener("change", onPaneMq);
    window.addEventListener("keydown", onKeydown);

    // THROUGH THE SAME LATCH as every other start. A bare
    // `registration.start()` here was the other half of the duplicate-line
    // crash: `retryBoot` guarded itself, but not against the boot ALREADY
    // running from mount, so a reconnect landing mid-boot cleared the column
    // and then let two registrations append `session` into a keyed each
    // block.
    retryBoot();

    return () => {
      roomRequest += 1;
      mq?.removeEventListener("change", onMq);
      paneMq?.removeEventListener("change", onPaneMq);
      window.removeEventListener("keydown", onKeydown);
      cancelIdleWarm?.();
      unbindWorkspaceView();
      unbindViewRequest();
      // The shell is going away, so nothing is on screen — and nothing is
      // left to say what is. A kept-alive room's feed must not be held behind
      // a torn-down tree, and no later surface should wait on an authority
      // that no longer exists.
      unbindVisibility();
    };
  });
</script>

<!-- THE CONNECTION BLOCK, OUTSIDE the shell subtree on purpose: it must not
     be inside the thing it makes inert, or it would disable its own retry
     verb. THE USER'S INSTRUCTION, VERBATIM: "the entire ux must be instantly
     blocked when api is offline unhealthy or not responding and show a proper
     message. it must also reconnect by itself and clear error/blocking
     state". -->
<ConnectionBlock />

<div
  class="cockpit shell"
  class:wide={wideViewport}
  class:past={pastAsOf !== null}
  class:tabs={authed && stripVisible}
  class:room-open={roomId !== null}
  class:room-inspected={$rightMenu !== null && inspectorPresentation === "room-docked"}
  data-revealed={revealed}
  data-authed={authed}
  data-past-view={pastAsOf !== null ? String(pastAsOf) : undefined}
  inert={apiUnreachable}
>
  <Horizon
    revealed={revealed && !inspectorOverlays}
    {authed}
    {username}
    {place}
    placeProject={placeProjectName}
    placeConversation={placeConversation}
    showPlace={placeVisible}
    showNewTab={!stripVisible}
    onNewTab={newTab}
    {annunciators}
    {monitors}
    {roomId}
    menu={$rightMenu}
    onChord={routeTarget}
    onSignOut={() => void signOut()}
  />

  <!-- THE TAB STRIP — a row of its own, present only when there is more than
       one workspace to name. With one there is nothing to switch between and
       the place chip in the HORIZON already says where you are; the `+`
       stays visible in both arrangements, in exactly one of them at a time. -->
  {#if authed && stripVisible}
    <WorkspaceStrip
      revealed={revealed && !inspectorOverlays}
      onnewtab={newTab}
      onactivevisible={(v) => (activeTabVisible = v)}
    />
  {/if}

  <!-- THE PAST VIEW BAND (§6.2 "unmistakably a past view"). It takes a ROW of
       its own in the shell column, and that is a correction: it used to be
       absolutely positioned over the top of the flow, out of caution about
       the one-reveal law — but the law exempts exactly what the user's own
       action moves, and this band appears from the user's own click on the
       head. Overlaying bought nothing and cost the top ~38px of whatever
       beat happened to be at the top of the stream, which the user reported
       as the header overlapping borders. A row cannot overlap anything.
       It states the instant it is showing in the same HH:MM:SS the sweep
       uses, says plainly that nothing can be changed from here, and carries
       the way back. -->
  {#if authed && pastAsOf !== null}
    <div class="past-band" role="status">
      <span class="past-mark engraved">past view</span>
      <span class="past-time">viewing {logTime(pastAsOf)}</span>
      <span class="past-note trunc">{PAST_VIEW_ACT_REASON}</span>
      <button
        class="past-return"
        data-verb-id="sweep.head/return-to-now"
        title={mouseTitleFor("escape")}
        onclick={returnToLive}
      >Back to now</button>
    </div>
  {/if}

  <!-- THE MISSING-FOLDER BAND. Same row-owning shape as the past-view band:
       a fact about the world the user must see before they act on it, with
       the way out beside it. The Switch opens on the relink affordance. -->
  {#if authed && folderMissing && $currentProject !== null}
    <div class="past-band folder-band" role="alert">
      <span class="past-mark engraved">folder {activeFolder === "missing" ? "missing" : "not readable"}</span>
      <span class="past-note trunc">
        this project's folder is {activeFolder === "missing" ? "gone from this machine" : "not readable"} — nothing here can touch the files until it is relinked
      </span>
      <button
        class="past-return"
        data-verb-id="project.relink"
        title="pick a folder that exists and point this project at it"
        onclick={() => void openRoomById("switch")}
      >Relink the folder</button>
    </div>
  {/if}

  <main class="flow-region" bind:this={flowRegionEl}>
    <div class="flow-outlet" inert={roomId !== null || inspectorOverlays}>
      {#if revealed && FlowComp !== null}
        <FlowComp {shell} />
      {:else}
        <Registration
          {lines}
          {gate}
          {complete}
          flowNote={FlowComp !== null
            ? null
            : outletFailed.has("flow")
              ? "the flow failed to load — this registration record stands in its place"
              : "the flow is not built yet — this registration record stands in its place"}
          {onAuthed}
          onRetry={retryBoot}
        />
      {/if}
    </div>
    {#if $rightMenu !== null}
      <!-- THE RIGHT MENUS (shell/right-menu.ts + RightMenuHost): one column,
            mutually exclusive by the host's own state. The run pane mounts
            under the host UNCHANGED; the arm menu's body is the same body
            the standalone sweep's Popover hosts. Docked beside the flow
            while the viewport holds the flow's floor (the pane's own
            breakpoint, RUN_PANE_DOCK_MIN_PX), overlaying below — the same
            dock-vs-overlay split the SCOPE sheet owns. -->
      <RightMenuHost
        menu={$rightMenu}
        presentation={inspectorPresentation}
        scope={scopeInInspector ? scopeReq : null}
        onBack={shell.closeScope}
        onClose={closeRightMenu}
      />
    {/if}
    {#if scopeDocked}
      <div class="covered-scope" inert={roomId !== null || inspectorOverlays}><ScopeHost {shell} request={scopeReq} docked={true} onClose={shell.closeScope} /></div>
    {/if}
  </main>

  <!-- THE FINDINGS ROW (§4.3) — ABOVE the band, and this is where the order
       is decided.
       It used to ride the DESK's top edge, which put the computer's sentences
       underneath the timeline; the user asked for them above it, between the
       conversation and the band ("I want these messages to show above the
       timeline as said before, not below"). The move is a REORDER OF THE
       SHELL'S OWN COLUMN — one row taken out of Desk.svelte and declared here,
       in reading order — rather than margins pushed around until it looked
       right, because the column is the only thing that can own an order.
       The row is content-sized and appears only from a live event or from
       typing, exactly as before; nothing about the finding itself changed,
       and its sentence still carries the derivation it was computed from. -->
  {#if authed && deskLineReq !== null}
    {@const Line = deskLineReq.component as Component}
    <div class="line-slot" data-testid="desk-line-slot" inert={roomId !== null || inspectorOverlays}>
      <Line {...deskLineReq.props ?? {}} />
    </div>
  {/if}

  {#if authed}
  <div class="sweep-outlet" inert={roomId !== null || inspectorOverlays}>
    {#if SweepComp !== null}
      <SweepComp {shell} />
    {:else}
      <span class="engraved">
        {outletFailed.has("sweep") ? "sweep — failed to load" : "sweep — not built yet"}
      </span>
    {/if}
  </div>
  {/if}

  <!-- Outlet components render ONLY from the reveal frame (§10.3): their
       modules finish loading DURING boot, and letting the gauge/panel slot
       swap in as each import resolves would be exactly the pop-in cascade
       the one-reveal law forbids (caught by the e2e stillness guard). -->
  {#if authed}
  <div class="desk-underlay" inert={roomId !== null || inspectorOverlays}>
  <Desk
    {shell}
    {revealed}
    bind:text={composerText}
    gauge={GaugeComp}
    onSubmit={submitComposer}
    {focusRequest}
  />
  </div>
  {/if}

  {#if scopeReq !== null && !scopeDocked && !scopeInInspector}
    <ScopeHost
      {shell}
      request={scopeReq}
      docked={false}
      overRoom={scopeOverRoom}
      onClose={shell.closeScope}
    />
  {/if}

  <RoomHost {shell} {roomId} covered={inspectorOverlays} visited={visitedRooms} onClose={shell.closeRoom} />

  <!-- LENS (§9.2): mounted IN the reveal frame; renders nothing until ⌘L
       arms it, so it adds zero post-reveal mutations and zero idle cost. -->
  {#if authed && LensComp !== null}
    {@const Lens = LensComp}
    <Lens {shell} />
  {/if}

  <GrammarHint text={hintText} seq={hintSeq} />

  <!-- The one sentence a silent deploy is turned into (shell/sw-update.ts):
       renders nothing until the update seam holds evidence. -->
  <UpdateChip />
</div>

<style>
  .desk-underlay { display: contents; }
  .room-open .flow-outlet,
  .room-open .desk-underlay,
  .room-open .line-slot,
  .room-open .sweep-outlet { visibility: hidden; }
  .covered-scope { display: contents; }
  .shell.tabs { --room-top: calc(var(--horizon-h) + var(--tabstrip-h)); }
  .shell.room-inspected { --room-right: var(--right-menu-w); }
  .shell {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    /* CLIP, NOT HIDDEN. `overflow: hidden` still creates a scrollable
     * overflow box, and the browser SCROLLS it on focus: focusing anything
     * partially out of view (the composer near the bottom edge, a control
     * inside a room) shifted the whole shell to a stuck offset — the fixed
     * chrome clipped by ~22px with no scrollbar and no way back. The shell
     * itself is never a legitimate scroller (its children own their own
     * scrolling: the flow outlet, the room bodies); `clip` removes the
     * scrollable box entirely, so scroll-by-focus has nothing to move.
     * Guard: tests/cockpit/e2e/shell-scroll-clip.spec.ts. */
    overflow: clip;
  }
  .flow-region {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--ground-0);
    /* The run pane's overlay mode positions itself against this box. */
    position: relative;
  }
  .flow-outlet {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  /* When the SCOPE side-docks the flow keeps its floor width. The wide
   * class is driven by matchMedia(SIDE_DOCK_MIN_PX) in the script — ONE
   * owner for the breakpoint number (shell/config.ts), no CSS twin. */
  .flow-region :global(.scope.docked) {
    flex: 0 0 var(--scope-w);
  }
  .shell.wide .flow-outlet {
    min-width: var(--flow-min-docked);
  }
  /* THE FINDINGS ROW — the shell's own row, between the flow and the band.
   *
   * It carries no ground of its own. On the desk edge it wore `--ground-1`,
   * because down there it was the top of the desk's housing; up here its
   * neighbours are the flow above and the band's reserved airspace below,
   * both `--ground-0`, and a lit strip between them would read as a third
   * instrument rather than as the computer's last word on the conversation.
   * The hairline is what separates it from the flow — a line, not a slab,
   * which is the cockpit's own rule for elevation (§12.5). */
  .line-slot {
    flex: none;
    border-top: var(--hairline-w) solid var(--line-1);
    padding: var(--sp-0) var(--gutter-bleed);
  }
  .sweep-outlet {
    height: var(--sweep-h);
    /* THE BAND'S RESERVED AIRSPACE (tokens.css --sweep-ruler-rise).
     *
     * The sweep's readouts lift above the band on purpose — a ruler chip
     * drawn ON the density would cover the thing it is reading. What was
     * wrong is that the lift came out of nobody's budget: the shell gave the
     * band exactly `--sweep-h`, so a chip rising 1.4rem rose into whatever
     * the band's upper neighbour was, and that surface fills its own box.
     *
     * WHO THE NEIGHBOUR IS NOW — re-derived, because the column changed
     * underneath this rule. It used to be the FLOW, always, and the comment
     * said so. Since the findings row moved above the band the neighbour is
     * the FINDINGS ROW whenever the computer has something to say, and the
     * FLOW the rest of the time. That is precisely why the reservation is
     * still spent HERE and not paid for by either of them: a margin on this
     * slot is empty air no matter which surface is above it, where a padding
     * on the findings row would vanish the moment the finding was dismissed
     * and leave the risers back in the flow. The guard now measures
     * disjointness from BOTH neighbours
     * (tests/cockpit/e2e/sweep-airspace-owner.spec.ts).
     *
     * A margin, not a taller slot: `--sweep-h` stays the ONE owner of the
     * band's height (the band measures this slot's content box), and the
     * flex column simply hands the flow that much less room. The strip is
     * `--ground-0` like everything above it, so it reads as the last inch of
     * air above the band rather than as a gap — and it is reserved at every
     * width and in both themes, so nothing can ever be underneath a riser. */
    margin-top: var(--sweep-ruler-rise);
    background: var(--ground-1);
    border-top: var(--hairline-w) solid var(--line-1);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sweep-outlet:has(:global(.sweep[data-empty="true"])) { margin-top: 0; height: var(--row-h); }
  .sweep-outlet:has(:global(.sweep[data-quiet-empty="true"])) { height: 0; margin-top: 0; border: 0; overflow: clip; }
  /* The engraved label is owned by tokens.css (`.cockpit .engraved`). */

  /* PAST VIEW — the whole shell wears it, not one instrument. The inset ring
   * is drawn on a pseudo-element so it costs no layout and cannot be mistaken
   * for a focus ring; `--warn` is the palette's "abnormal but not broken"
   * ink, which is exactly what a past view is. */
  .shell.past::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    border: var(--focus-ring-width) solid var(--warn);
    z-index: 30;
  }
  .past-band {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-1) var(--sp-3);
    background: var(--ground-3);
    border-bottom: var(--hairline-w) solid var(--warn);
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved); the
   * past mark spends the warn ink over it. */
  .past-mark {
    color: var(--warn);
  }
  .past-time {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-1);
  }
  .past-note {
    font-size: var(--f-ui-size);
    color: var(--ink-2);
  }
  .past-return {
    margin-left: auto;
    flex: none;
    min-height: var(--hit-min);
    font: inherit;
    font-size: var(--f-ui-size);
    color: var(--ink-1);
    background: none;
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    padding: var(--sp-1) var(--sp-2);
    cursor: pointer;
  }
  .past-return:hover {
    background: var(--layer-hover);
  }
</style>
