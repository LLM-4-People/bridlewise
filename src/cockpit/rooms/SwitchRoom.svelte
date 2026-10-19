<script lang="ts">
  /**
   * THE SWITCH (DESIGN-COCKPIT-V2 §5) — the one navigation gesture. ⌘J or
   * the HORIZON place summons it; its existence at
   * `src/cockpit/rooms/SwitchRoom.svelte` is what makes the shell's
   * registered chord real (file-convention mount, shell/contract.ts).
   *
   * Project groups keep session-stable ordering until a deliberate sort.
   * Wide screens place project context beside content-fitting conversation
   * rows; compact screens stack the same groups. CSS and SwitchRiver share
   * the column count, and measured row heights drive virtual offsets.
   * One New menu states its destination. Secondary actions are contextual;
   * the existing handlers, creation guards and open intent remain authority.
   *
   * Verbs (§1.2): resume (Enter/click → stores set, room closes, the FLOW
   * ingests the loaded history) · replay (same, with the sweep head
   * planted at the conversation's recorded start via the sweep's exported
   * store seam) · ⌘N new conversation in the focused project · ⌘⇧N new
   * project (folder picker; the name is the folder and the day). The
   * custody badge is REAL: the custody feed's `custody.state`
   * read joins uncommitted files to their producing conversations, and a
   * reel badges only its own measured count (§1.1: no measurement, no
   * badge — never a placeholder).
   *
   * Keyboard: full roving focus (arrows walk the reel grid, typing
   * anywhere filters, Enter resumes, ⇧Enter replays, Esc clears filter /
   * closes the picker, then the shell closes the room). The room listens in the
   * CAPTURE phase and stops propagation for what it consumes, so the
   * shell's flow-bound chords never fire underneath an open room.
   */
  import { onMount, tick, untrack } from "svelte";

  import { projects, selectProject } from "../../state/projects.ts";
  import { chatChanges, chatForId, projectChatsFor, currentChatId, selectChat } from "../../state/chats.ts";
  import {
    createChat,
    createProject,
    deleteChat,
    deleteProject,
    listTrash,
    listRecycledFiles,
    loadChatHistory,
    restoreChat,
    restoreProject,
    restoreRecycledFile,
    updateProjectPath,
    type RecycledFile,
    type TrashList,
  } from "../../client.ts";
  // §6.2: creating a conversation or a project are WRITES, and neither is a
  // block action — `broker.action` (where `assertLiveForWrite` normally runs)
  // is not on either path. `isPastView` turns the controls and the chords
  // honest BEFORE the press; `assertLiveForWrite` is the guarantee ON the
  // path. See `newConversation` / `finishCreateProject`.
  import {
    assertLiveForWrite,
    isPastView,
    PAST_VIEW_ACT_REASON,
    PAST_VIEW_READ_ONLY_CODE,
  } from "../../data/asof.ts";
  import { ClientError } from "../../data/errors.ts";
  import type { OutletProps } from "../shell/contract.ts";
  import { chordLabel, detectMac } from "../shell/keyboard.ts";
  import { primaryDown } from "../shell/chords.ts";
  // ROOM-LOCAL CHORDS (shell/room-chords.ts). ⌘N and ⌘⇧N used to be matched
  // by hand in this file, which made them a private keyboard registry the
  // mouse-path guard could not see — and they had no control on screen at
  // all. They are declared now, matched from the declaration, and each has
  // its button in the bar below.
  import { matchRoomChord, roomChordTitle } from "../shell/room-chords.ts";
  import { VERB_MARK, VERB_MARK_WORD } from "../shell/verb-marks.ts";
  import { recycleArmedTitle, recycleFace, takeRecyclePress, type RecycleArm } from "./recycle-confirm.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";
  // THE `+` on the tab strip arms this room to open what you pick in a NEW
  // tab instead of replacing what you are looking at (shell/open-intent.ts).
  import { openIntent, takeOpenIntent } from "../shell/open-intent.ts";
  import { closeWorkspace, openWorkspace } from "../../state/workspaces.ts";
  import { plantHead } from "../sweep/sweep-store.ts";
  import {
    REELS_PER_CAP,
    capPathHints,
    SwitchRiver,
    type ProjectCap,
    type RiverGeometry,
    projectNameFromFolder,
    type Reel as ReelData,
  } from "./switch-data.ts";
  import {
    capOrder,
    chatsStates,
    densityStates,
    feedChanges,
    ensureChats,
    outcomeStates,
    requestReelData,
    revalidateReels,
  } from "./switch-feed.ts";
  // KEEP-ALIVE seam: this room is mounted once and shown/hidden thereafter,
  // so per-OPEN work hangs off visibility, not `onMount`.
  import { SWITCH_MAX_PROJECT_COLUMNS, SWITCH_OVERSCAN_PX, SWITCH_VIEWPORT_ESTIMATE } from "./switch-config.ts";
  import { whileRoomVisible } from "../shell/room-visibility.ts";
  import {
    designConditions,
    watchDesignConditions,
    withPaintTokens,
  } from "../paint/design-tokens.ts";
  import { custodyChatCounts, requestCustody } from "./custody-feed.ts";
  import ReelCell from "./Reel.svelte";
  import FolderPicker from "./FolderPicker.svelte";
  import Popover from "../shell/Popover.svelte";
  import Disclosure from "../shell/Disclosure.svelte";
  import ContextMenu, { type MenuVerb } from "../shell/ContextMenu.svelte";

  let { shell }: OutletProps = $props();

  const isMac = detectMac(typeof navigator !== "undefined" ? navigator : {});

  // Platform-true chord labels (shell/chords.ts — the one spelling owner):
  // the legend must teach the key that actually fires on THIS machine.
  const kResume = chordLabel({ key: "Enter" });
  const kReplay = chordLabel({ key: "Enter", shift: true });
  const kNew = chordLabel({ key: "n", primary: true });
  const kNewProject = chordLabel({ key: "n", primary: true, shift: true });

  // ── room state ─────────────────────────────────────────────────────────
  let filter = $state("");
  let sort = $state<"recent" | "name">("recent");
  let focusIndex = $state(0);
  let riverW = $state(0);
  let riverEl: HTMLDivElement | null | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(SWITCH_VIEWPORT_ESTIMATE);
  let riverVersion = $state(0);
  let legendVersion = $state(0);
  let rootEl: HTMLElement | undefined = $state();
  let filterEl: HTMLInputElement | undefined = $state();
  // Publish measurements together after the observer delivery cycle. Changing
  // the virtual window inside a delivery mounts more observed peers at the
  // same depth, which leaves their first notification skipped until next frame.
  const measurements = new Set<() => void>();
  let measurementFrame: number | null = null;
  function queueMeasurement(publish: () => void): void {
    measurements.add(publish);
    if (measurementFrame !== null) return;
    measurementFrame = requestAnimationFrame(() => {
      measurementFrame = null;
      for (const publish of measurements) { measurements.delete(publish); publish(); }
    });
  }
  function cancelMeasurement(publish: () => void): void {
    measurements.delete(publish);
    if (measurements.size === 0 && measurementFrame !== null) {
      cancelAnimationFrame(measurementFrame); measurementFrame = null;
    }
  }
  let busy = $state(false);
  /** The open instant — every relative time on screen is measured against
   * this one real clock read (no per-reel clock drift). */
  const openedAt = Date.now();
  /**
   * True while the cockpit is showing a past instant (§6.2). The river, the
   * filter, resume and replay are all READS and stay available — a past view
   * is readable. Only the two CREATE gestures go off, because they are the
   * only things in this room that change the world.
   */
  const past = $derived($isPastView);
  const pathHints = $derived(capPathHints($projects));

  /**
   * ARMED BY THE `+`. The room is the same room; what changes is where the
   * choice lands. It says so on the bar, in plain words, because a mode you
   * cannot see is a mode that will surprise you: the next thing you pick
   * opens a NEW tab and leaves the one you are in alone.
   */
  const armed = $derived($openIntent === "new-tab");
  const landing = $derived(
    armed ? "opens in a new tab" : "opens here, replacing what this tab shows",
  );

  // ── new-project picker (⌘⇧N) ───────────────────────────────────────────
  let creating = $state(false);
  let npName = $state("");
  /** The folder the picker chose. A path is NEVER free-typed: the picker
   * is the only source, so a project can only ever be pointed at a folder
   * the server actually listed. */
  let npPath = $state<string | null>(null);
  let npPicking = $state(false);
  let npNote = $state<string | null>(null);

  // ── relink: which project's cap is offering the picker ─────────────────
  let relinkId = $state<string | null>(null);
  let relinkNote = $state<string | null>(null);

  // ── recycle bin (trashed_at hide; restore clears it) ───────────────────
  let showingTrash = $state(false);
  let trash = $state<TrashList>({ projects: [], chats: [] });
  let recycledFiles = $state<readonly RecycledFile[]>([]);
  let trashNote = $state<string | null>(null);
  /** Two-press recycle (recycle-confirm.ts). Cap, reel, and menu share it. */
  let armedBin = $state<RecycleArm | null>(null);
  let projectMenu = $state<{ cap: ProjectCap; at: { x: number; y: number } } | null>(null);
  let createMenu = $state<{ projectId: string | null; projectName: string | null; at: { x: number; y: number } } | null>(null);
  let optionsAt = $state<{ x: number; y: number } | null>(null);
  let showingShortcuts = $state(false);
  const optionVerbs: readonly MenuVerb[] = [
    { id: "switch.recycle-bin", label: "Recycle bin", title: "Restore projects, conversations and files", run: openTrash },
    { id: "switch.shortcuts", label: "Keyboard shortcuts", title: "Navigation and creation shortcuts", run: () => { showingShortcuts = true; } },
  ];
  const createVerbs: readonly MenuVerb[] = $derived(createMenu === null ? [] : [
    ...(createMenu.projectId === null ? [] : [{ id: "switch.new-conversation", roomChord: "switch.new-conversation", label: `New conversation in ${createMenu.projectName}`, title: roomChordTitle("switch.new-conversation"), run: () => newChatIn(createMenu!.projectId!) } satisfies MenuVerb]),
    { id: "switch.new-project-open", roomChord: "switch.new-project", label: "New project", title: roomChordTitle("switch.new-project"), run: openProjectForm },
  ]);
  const projectVerbs: readonly MenuVerb[] = $derived(projectMenu === null ? [] : [
    ...(!past && !busy ? [
      { id: "switch.cap-new-conversation", label: "New conversation", title: "Start a conversation in this project", run: () => newChatIn(projectMenu!.cap.project.id) },
      ...(projectMenu.cap.project.folder === "missing" ? [] : [{ id: "switch.relink", label: "Change folder", title: "Choose this project's folder", run: () => openRelink(projectMenu!.cap.project.id) }]),
      { id: "switch.cap-trash", label: "Move project to bin", title: "Review before moving this project to the recycle bin", run: () => binProject(projectMenu!.cap.project.id, projectMenu!.cap.project.name) },
    ] : []),
  ]);

  // ── the river (in-memory, instant) ─────────────────────────────────────

  function readGeometry(population = projects.get().length): RiverGeometry {
    return withPaintTokens(rootEl, read => {
      const unit = Number.parseFloat(read("--sp-unit"));
      const gap = unit * 2;
      const contentWidth = Math.max(0, riverW - unit * 10);
      const reelWidth = Number.parseFloat(read("--reel-w"));
      const tracks = Math.max(1, Math.floor((contentWidth + gap) / (reelWidth + gap)));
      const columns = Math.max(1, Math.min(SWITCH_MAX_PROJECT_COLUMNS, tracks, population));
      return {
        columns, reelColumns: Math.max(1, Math.floor(tracks / columns)),
        contentWidth,
        reelHeight: Number.parseFloat(read("--reel-h")), reelGap: gap,
        capGap: unit * 3 + Number.parseFloat(read("--hairline-w")),
        headerEstimate: Number.parseFloat(read("--hit-min")) + gap,
      };
    });
  }
  const initialGeometry = readGeometry();
  let geometry = $state.raw(initialGeometry);
  let river = $state.raw(new SwitchRiver(projects.get(), projectChatsFor,
    id => chatsStates.get(id) ?? "pending", initialGeometry, capOrder.get()));
  const counts = $derived.by(() => { void riverVersion; void legendVersion; return river.counts; });
  const totalHeight = $derived.by(() => { void riverVersion; return river.totalHeight; });
  const windowCaps = $derived.by(() => {
    void riverVersion;
    return river.window(Math.max(0, scrollTop - SWITCH_OVERSCAN_PX), scrollTop + viewportHeight + SWITCH_OVERSCAN_PX);
  });
  const visibleReels = $derived(windowCaps.flatMap(item => item.reels));
  const focusedReel = $derived.by(() => { void riverVersion; return river.reelAt(focusIndex)?.reel; });
  function preserveRiverPosition(change: () => void): void {
    const selected = river.reelAt(focusIndex)?.reel;
    const first = river.window(scrollTop, scrollTop + 1)[0];
    const anchor = first?.reels[0] ?? first?.cap.visible[0];
    const anchorIndex = anchor === undefined ? undefined : river.indexOf(anchor.chat.id, anchor.chat.projectId);
    const delta = anchorIndex === undefined ? undefined : river.reelAt(anchorIndex)!.offset - scrollTop;
    change();
    focusIndex = selected === undefined ? 0 : river.indexOf(selected.chat.id, selected.chat.projectId) ?? Math.min(focusIndex, Math.max(0, river.counts.reels - 1));
    const next = anchor === undefined ? undefined : river.indexOf(anchor.chat.id, anchor.chat.projectId);
    if (next !== undefined && delta !== undefined) {
      scrollTop = Math.max(0, river.reelAt(next)!.offset - delta);
      if (riverEl != null) riverEl.scrollTop = scrollTop;
    }
  }
  const anyReplay = $derived(counts.replay);
  const hintsLine = $derived.by(() => {
    const replay = anyReplay ? ` · ${kReplay} replay` : "";
    return past
      ? `${kResume} resume${replay} · ${PAST_VIEW_ACT_REASON}`
      : `${kResume} resume${replay} · ${kNew} ${VERB_MARK.add} conversation · ${kNewProject} ${VERB_MARK.add} project`;
  });
  $effect(() => {
    const query = filter;
    untrack(() => {
      const selected = river.reelAt(focusIndex)?.reel;
      river.setQuery(query);
      riverVersion += 1;
      focusIndex = selected === undefined ? 0 : river.indexOf(selected.chat.id, selected.chat.projectId) ?? 0;
      scrollTop = 0;
      if (riverEl != null) riverEl.scrollTop = 0;
    });
  });

  // Rendered reels request their measured data, in river order (newest
  // first — the queue serves the top of the screen first). Idempotent per
  // chat; the feed's concurrency cap and the Broker's cache do the rest.
  // Custody is ONE read per rendered project (the join arrives grouped by
  // conversation), feeding every reel badge from the same source.
  $effect(() => {
    const rendered = visibleReels;
    untrack(() => {
    const projectsSeen = new Set<string>();
    for (const r of rendered) {
      requestReelData(r.chat.id);
      if (!projectsSeen.has(r.chat.projectId)) {
        projectsSeen.add(r.chat.projectId);
        requestCustody(r.chat.projectId);
      }
    }
    });
  });

  onMount(() => {
    const publishRiver = (): void => {
      if (river.settle()) capOrder.set(river.order());
      riverVersion += 1;
    };
    const updateReplay = (id: string): void => {
      const chat = chatForId(id);
      const outcome = outcomeStates.get(id);
      if (chat !== null && river.setReplay(id, chat.projectId,
        outcome?.kind === "measured" && outcome.startMs !== null)) legendVersion += 1;
    };
    for (const id of outcomeStates.keys()) updateReplay(id);
    publishRiver();
    const stopProjects = projects.listen(list => {
      preserveRiverPosition(() => river.replaceProjects(list));
      // Once settled, membership changes enter through the stable-order law.
      if (capOrder.get().length > 0) capOrder.set(river.order());
      publishRiver();
    });
    const stopChats = chatChanges.listen(({ projectIds }) => {
      preserveRiverPosition(() => {
        if (projectIds === null) river.replaceProjects(projects.get());
        else for (const id of projectIds) river.updateProject(id);
      });
      publishRiver();
    });
    const stopFeed = feedChanges.listen(change => {
      if (change.kind === "reset") {
        geometry = readGeometry();
        river = new SwitchRiver(projects.get(), projectChatsFor,
          id => chatsStates.get(id) ?? "pending", geometry);
        river.setQuery(filter);
        if (sort === "name") river.sortBy(sort);
      } else if (change.kind === "chats") {
        preserveRiverPosition(() => { for (const id of change.ids) river.updateProject(id); });
      } else if (change.kind === "outcome") {
        for (const id of change.ids) updateReplay(id);
        return;
      } else {
        return; // Density is a keyed display update, with no river mutation.
      }
      publishRiver();
    });
    // KEPT ALIVE (shell/RoomHost.svelte): this room is mounted once and then
    // hidden/shown, so `onMount` no longer runs per open. Everything that must
    // happen on every OPEN hangs off visibility instead — and what happens on
    // open is a REVALIDATION, never a reload: the reels keep their measured
    // lines and their strips, and the Broker only touches the network for the
    // ones that have aged past their TTL. Chats are re-ensured for the same
    // reason (a project that failed last time is retried; a loaded one is not).
    // The capture-phase key handler is held the SAME way, and that is not an
    // afterthought: a kept-alive room that kept listening would answer the
    // river's arrow keys while the user was looking at something else. Quiet
    // when hidden applies to the keyboard exactly as it applies to polling.
    const stopVisible = whileRoomVisible("switch", () => {
      ensureChats($projects.map((p) => p.id));
      revalidateReels();
      filterEl?.focus();
      window.addEventListener("keydown", onKeydownCapture, true);
      // ⌘J TOGGLES. Claimed TRANSIENTLY, only while this room is on screen,
      // so the shell's permanent route (open the Switch) comes back the
      // moment it closes — a stack, not a steal (shell/routing.ts).
      const releaseSwitch = shell.claimKey("switch", () => shell.closeRoom(), {
        transient: true,
        owner: "the Switch",
      });
      return () => {
        window.removeEventListener("keydown", onKeydownCapture, true);
        releaseSwitch();
      };
    });
    const stopWatchingConditions = watchDesignConditions();
    return () => {
      if (measurementFrame !== null) cancelAnimationFrame(measurementFrame);
      measurements.clear();
      stopWatchingConditions();
      stopVisible();
      stopProjects();
      stopChats();
      stopFeed();
    };
  });

  // Width/theme are geometry changes; individual completions do not read
  // the stylesheet or remeasure every cap. A first real grid supplies its
  // CSS-constrained width when the initially empty river gains content.
  const hasWindow = $derived(windowCaps.length > 0);
  const geometryPopulation = $derived(counts.matches);
  $effect(() => {
    void $designConditions;
    void riverW;
    void hasWindow;
    const population = geometryPopulation;
    untrack(() => {
      const next = readGeometry(population);
      preserveRiverPosition(() => {
        if (river.setGeometry(next)) { geometry = next; riverVersion += 1; }
      });
    });
  });

  function outcomeFor(id: string) {
    return outcomeStates.get(id) ?? { kind: "pending" } as const;
  }
  function densityFor(id: string) {
    return densityStates.get(id) ?? { kind: "pending" } as const;
  }

  function viewport(node: HTMLDivElement): { destroy: () => void } {
    const measure = (): void => {
      if (node.clientHeight > 0) viewportHeight = node.clientHeight;
      riverW = node.clientWidth;
    };
    queueMeasurement(measure);
    const observer = new ResizeObserver(() => queueMeasurement(measure));
    observer.observe(node);
    return { destroy: () => { observer.disconnect(); cancelMeasurement(measure); } };
  }

  function measureCap(node: HTMLElement, params: { cap: ProjectCap; model: SwitchRiver }): {
    update: (next: { cap: ProjectCap; model: SwitchRiver }) => void;
    destroy: () => void;
  } {
    let current = params;
    let measuredHeight: number | undefined;
    const publish = (): void => {
      if (measuredHeight !== undefined && current.model === river
        && river.measureHeader(current.cap, measuredHeight)) riverVersion += 1;
    };
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        measuredHeight = entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height;
        queueMeasurement(publish);
      }
    });
    observer.observe(node, { box: "border-box" });
    return {
      update: next => {
        if (next.cap === current.cap && next.model === current.model) return;
        current = next;
        // A replacement model/cap can reuse this same mounted header. Its
        // unchanged size will not cause a new ResizeObserver delivery.
        queueMeasurement(publish);
      },
      destroy: () => { observer.disconnect(); cancelMeasurement(publish); },
    };
  }

  function changeSort(): void {
    const selected = river.reelAt(focusIndex)?.reel;
    river.sortBy(sort); capOrder.set(river.order()); riverVersion += 1;
    focusIndex = selected === undefined ? 0 : river.indexOf(selected.chat.id, selected.chat.projectId) ?? 0;
    scrollTop = 0; if (riverEl != null) riverEl.scrollTop = 0;
  }

  function openProjectMenu(event: MouseEvent, cap: ProjectCap): void {
    event.preventDefault();
    const button = event.currentTarget as HTMLElement;
    const box = button.getBoundingClientRect();
    projectMenu = projectMenu?.cap.project.id === cap.project.id ? null : { cap, at: { x: box.right, y: box.bottom } };
  }
  function openCreateMenu(event: MouseEvent): void {
    if (past || busy) return;
    if (createMenu !== null) { createMenu = null; return; }
    const projectId = river.reelAt(focusIndex)?.reel.chat.projectId ?? windowCaps[0]?.cap.project.id ?? $projects[0]?.id ?? null;
    const project = $projects.find(project => project.id === projectId);
    const hint = projectId === null ? undefined : pathHints[projectId];
    const projectName = project === undefined ? null : hint === undefined ? project.name : `${project.name} · ${hint}`;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    createMenu = { projectId, projectName, at: { x: box.left, y: box.bottom } };
  }

  // ── verbs ──────────────────────────────────────────────────────────────

  /**
   * WHERE THE CHOICE LANDS — the one bit the `+` sets, read here and here
   * only, so every verb in this room (resume, replay, create) answers it the
   * same way and no verb can quietly forget.
   *
   * `take` clears it: the arming belongs to the gesture that armed it.
   */
  function land(projectId: string | null, chatId: string | null): void {
    if (takeOpenIntent() === "new-tab") {
      // A new workspace, activated — which projects the pair onto
      // currentProjectId/currentChatId for every existing consumer.
      openWorkspace({ projectId, chatId });
      return;
    }
    selectProject(projectId);
    selectChat(chatId);
  }

  function resume(reel: ReelData): void {
    land(reel.chat.projectId, reel.chat.id);
    shell.closeRoom();
    // The FLOW ingests from the messages store; this fills it (and scopes
    // the timeline, which the sweep's spectrum feed follows).
    void loadChatHistory(reel.chat.id);
  }

  function replay(reel: ReelData): void {
    const outcome = outcomeStates.get(reel.chat.id);
    const startMs =
      outcome !== undefined && outcome.kind === "measured" ? outcome.startMs : null;
    if (startMs === null || !Number.isFinite(startMs)) {
      shell.hint("Replay: no event recorded");
      return;
    }
    land(reel.chat.projectId, reel.chat.id);
    // The reachable replay seam: the sweep's exported head store. The
    // sweep renders "viewing <t> — back to now" and every asOf-reactive
    // surface follows (§6.2).
    plantHead(startMs);
    shell.closeRoom();
    void loadChatHistory(reel.chat.id);
  }

  /**
   * THE ONE WAY A CONVERSATION IS STARTED FROM THIS ROOM (single owner).
   * The central New menu, contextual project shortcut and chord all land
   * here. The menu states its captured project; the chord derives its target
   * from the focused reel / first visible cap.
   */
  async function startConversation(projectId: string): Promise<void> {
    if (busy) return;
    busy = true;
    // A new conversation asked for from an ARMED Switch opens in a new tab,
    // exactly like choosing an existing one. The workspace is opened FIRST
    // and empty, so the selection `createChat` performs lands on the new tab
    // rather than on the one the user was already using. If the server
    // refuses, the empty tab is closed again — a `+` that failed must not
    // leave a stranded tab behind.
    const opened = takeOpenIntent() === "new-tab" ? openWorkspace({ projectId }) : null;
    try {
      // THE GUARANTEE, not the courtesy. `createChat` is a client.ts call, so
      // the Broker's write door is not on this path: a ⌘N pressed from a view
      // of an earlier instant would have created a real conversation in the
      // LIVE project — a write performed from a screen that says it is only
      // looking. The caller's `past` check is what the user sees; this is
      // what makes it true for every caller, including a race that plants
      // the head between the check and the call.
      assertLiveForWrite();
      const chat = await createChat(projectId, { title: "new conversation" });
      selectProject(projectId);
      shell.closeRoom();
      void loadChatHistory(chat.id);
    } catch (err) {
      if (opened !== null) closeWorkspace(opened.id);
      shell.hint(refusalWords(err, "New conversation refused. Nothing was created"));
    } finally {
      busy = false;
    }
  }

  async function newConversation(): Promise<void> {
    if (busy) return;
    if (past) {
      // The chord has no control to grey out, so it says the reason itself —
      // the same sentence the [create] button wears (one owner, §6.2).
      shell.hint(`New conversation: ${PAST_VIEW_ACT_REASON}`);
      return;
    }
    const projectId =
      river.reelAt(focusIndex)?.reel.chat.projectId ?? windowCaps[0]?.cap.project.id ?? $projects[0]?.id ?? null;
    if (projectId === null) {
      shell.hint(`${kNew} ${VERB_MARK.add} conversation: no project yet · ${kNewProject} ${VERB_MARK.add} project`);
      return;
    }
    await startConversation(projectId);
  }

  /**
   * Deliberate creation menus use the same owner as the chord. Writes are
   * refused in past view or while the previous creation is in flight.
   */
  function newChatIn(projectId: string): void {
    if (past || busy) return;
    void startConversation(projectId);
  }

  async function refreshTrash(): Promise<void> {
    try {
      const [rows, files] = await Promise.all([listTrash(), listRecycledFiles()]);
      trash = rows;
      recycledFiles = files;
      trashNote = null;
    } catch (err) {
      trashNote = refusalWords(err, "Recycle bin could not be read");
    }
  }

  function openTrash(): void {
    armedBin = null;
    showingTrash = !showingTrash;
    if (showingTrash) void refreshTrash();
  }

  /**
   * THE ONE DOOR. Cap, reel, and context menu land here. First press
   * arms; second press of the same id recycles. recycle-confirm.ts is
   * the rule; this is the write.
   */
  function isRecycleArmed(kind: RecycleArm["kind"], id: string): boolean {
    return armedBin !== null && armedBin.kind === kind && armedBin.id === id;
  }

  function startRecycle(kind: RecycleArm["kind"], id: string, name: string): void {
    if (past || busy) return;
    armedBin = { kind, id, name, armedAt: Date.now() };
  }

  function binProject(projectId: string, name: string): void {
    startRecycle("project", projectId, name);
  }

  function binChat(chatId: string, name: string): void {
    startRecycle("chat", chatId, name);
  }

  async function confirmArmedBin(): Promise<void> {
    if (armedBin === null || past || busy) return;
    const job = armedBin;
    const taken = takeRecyclePress(job, job, Date.now());
    armedBin = taken.arm;
    if (!taken.fire) return;
    busy = true;
    try {
      assertLiveForWrite();
      if (job.kind === "project") await deleteProject(job.id);
      else await deleteChat(job.id);
      if (showingTrash) await refreshTrash();
    } catch (err) {
      shell.hint(refusalWords(err, "Recycle bin: nothing was moved"));
    } finally {
      busy = false;
    }
  }

  async function undropFile(id: string): Promise<void> {
    if (past || busy) return;
    busy = true;
    try {
      assertLiveForWrite();
      await restoreRecycledFile(id);
      await refreshTrash();
    } catch (err) {
      shell.hint(refusalWords(err, "Restore: nothing came back"));
    } finally {
      busy = false;
    }
  }

  async function undropProject(projectId: string): Promise<void> {
    if (past || busy) return;
    busy = true;
    try {
      assertLiveForWrite();
      await restoreProject(projectId);
      await refreshTrash();
    } catch (err) {
      shell.hint(refusalWords(err, "Restore: nothing came back"));
    } finally {
      busy = false;
    }
  }

  async function undropChat(chatId: string): Promise<void> {
    if (past || busy) return;
    busy = true;
    try {
      assertLiveForWrite();
      await restoreChat(chatId);
      await refreshTrash();
    } catch (err) {
      shell.hint(refusalWords(err, "Restore: nothing came back"));
    } finally {
      busy = false;
    }
  }

  /**
   * The words for a refused create. A past-view refusal is OURS and has one
   * owned sentence; anything else is the server's, and the honest thing to
   * say about it is that nothing was created — never a guess at why.
   */
  function refusalWords(err: unknown, otherwise: string): string {
    return err instanceof ClientError && err.code === PAST_VIEW_READ_ONLY_CODE
      ? err.message
      : otherwise;
  }

  function openProjectForm(): void {
    if (past) {
      shell.hint(`New project: ${PAST_VIEW_ACT_REASON}`);
      return;
    }
    creating = true;
    npName = "";
    npPath = null;
    npPicking = true;
    npNote = null;
  }

  /**
   * The picker's answer. Choosing a folder records the project's name from
   * the folder and the day of the choice, then creates — the name field is
   * not a step the user has to type.
   */
  function pickProjectPath(path: string): void {
    npPath = path;
    npNote = null;
    if (npName.trim().length === 0) npName = projectNameFromFolder(path, Date.now());
    void finishCreateProject();
  }

  function abandonCreate(): void {
    if (busy) return;
    creating = false;
    npPicking = false;
    npPath = null;
    npName = "";
    npNote = null;
  }

  async function finishCreateProject(): Promise<void> {
    if (busy) return;
    const name = npName.trim();
    if (name.length === 0) {
      npNote = "a name is needed";
      return;
    }
    if (npPath === null) {
      npNote = "Choose a project folder with the picker";
      npPicking = true;
      return;
    }
    busy = true;
    // Same landing rule as every other choice in this room (see `land`): an
    // armed Switch puts the new project in a new tab. Opened empty first so
    // the selection `createProject` performs lands there.
    const opened = takeOpenIntent() === "new-tab" ? openWorkspace({}) : null;
    try {
      // Same door, same reason as `newConversation`: `createProject` is a
      // client.ts call with no Broker write door on it, and a project created
      // from a past view would be a real folder registered against today's
      // filesystem. The picker is blocked while a head stands; it can also
      // be left OPEN across a head plant, so the assertion is on the path
      // too.
      assertLiveForWrite();
      await createProject({ name, path: npPath });
      creating = false;
      npPicking = false;
      shell.closeRoom();
      // createProject selects the project and its first conversation; give
      // the FLOW that conversation's (empty) history so it ingests cleanly.
      const chatId = currentChatId.get();
      if (chatId !== null) void loadChatHistory(chatId);
    } catch (err) {
      if (opened !== null) closeWorkspace(opened.id);
      npNote = refusalWords(
        err,
        "the server refused to create the project · nothing was created",
      );
    } finally {
      busy = false;
    }
  }

  // ── relink: point a project at a folder that exists ─────────────────────

  function openRelink(projectId: string): void {
    relinkId = projectId;
    relinkNote = null;
  }

  /**
   * The picker's relink answer, applied to the project. The PATCH re-measures
   * the folder on the server and the response carries the fresh presence, so
   * the badge clears from the same answer — no second fetch, no guessed
   * clearing.
   */
  async function relinkTo(path: string): Promise<void> {
    const id = relinkId;
    if (id === null || busy) return;
    busy = true;
    try {
      assertLiveForWrite();
      await updateProjectPath(id, path);
      relinkId = null;
      relinkNote = null;
      shell.hint("project folder relinked");
    } catch (err) {
      relinkNote = refusalWords(err, "the server refused to relink the project · nothing changed");
    } finally {
      busy = false;
    }
  }

  function toggleExpand(projectId: string): void {
    river.toggleExpanded(projectId);
    riverVersion += 1;
  }

  // ── keyboard: the room owns its grammar while open ─────────────────────

  function isEditable(t: EventTarget | null): boolean {
    return (
      t instanceof HTMLElement &&
      (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")
    );
  }

  function focusReel(i: number): void {
    if (counts.reels === 0) return;
    focusIndex = Math.max(0, Math.min(counts.reels - 1, i));
    const target = river.reelAt(focusIndex);
    if (target !== undefined && riverEl != null) {
      if (target.offset < scrollTop || target.offset > scrollTop + viewportHeight - geometry.reelHeight) {
        scrollTop = Math.max(0, target.offset - viewportHeight / 2);
        riverEl.scrollTop = scrollTop;
      }
    }
    void tick().then(() => {
      const el = rootEl?.querySelector<HTMLElement>(`[data-reel-index="${focusIndex}"]`);
      el?.focus();
      // Optional call: jsdom (the component-test environment) has no
      // scrollIntoView; focus alone is the behavior under test there.
      el?.scrollIntoView?.({ block: "nearest" });
    });
  }

  function consume(ev: KeyboardEvent): void {
    ev.preventDefault();
    // Real key events target the focused element, so this capture-phase
    // listener runs before the shell's window listener and stopPropagation
    // suffices; stopImmediatePropagation additionally covers same-target
    // dispatches (events fired directly at window).
    ev.stopPropagation();
    ev.stopImmediatePropagation();
  }

  function onKeydownCapture(ev: KeyboardEvent): void {
    if (ev.target instanceof Element && ev.target.closest('.popover')) return;
    const primary = primaryDown(ev, isMac);

    // THE ROOM'S OWN CHORDS, matched from their DECLARATION (room-chords.ts)
    // rather than by hand. ⌘J is not among them: the Switch claims the
    // shell's `switch` target while it is open (see onMount), so the toggle
    // goes through the published seam and keeps the click path the place
    // chip and the rail already give it.
    const chord = matchRoomChord(ev, "switch", { isMac });
    if (chord !== null) {
      consume(ev);
      if (chord.id === "switch.new-project") openProjectForm();
      else void newConversation();
      return;
    }
    if (ev.key === "Escape") {
      if (armedBin !== null) {
        consume(ev);
        armedBin = null;
        return;
      }
      if (relinkId !== null) {
        consume(ev);
        relinkId = null;
        filterEl?.focus();
        return;
      }
      if (creating) {
        consume(ev);
        abandonCreate();
        filterEl?.focus();
        return;
      }
      if (filter.length > 0) {
        consume(ev);
        filter = "";
        filterEl?.focus();
        return;
      }
      return; // unconsumed — the shell closes the room
    }
    if (primary || ev.altKey || creating) return;

    const inFilter = ev.target === filterEl;
    const editable = isEditable(ev.target);
    if (editable && !inFilter) return;
    if (ev.target instanceof Element && ev.target.closest('button') && !ev.target.closest('[data-reel-index]')) return;

    switch (ev.key) {
      case "ArrowDown":
        consume(ev);
        focusReel(inFilter ? focusIndex : river.moveVertical(focusIndex, 1) ?? focusIndex);
        return;
      case "ArrowUp":
        if (inFilter) return void consume(ev);
        consume(ev);
        { const previous = river.moveVertical(focusIndex, -1);
        if (previous === undefined) filterEl?.focus(); else focusReel(previous); }
        return;
      case "ArrowRight":
        if (editable) return; // caret editing wins in the filter
        consume(ev);
        focusReel(river.moveHorizontal(focusIndex, 1) ?? focusIndex);
        return;
      case "ArrowLeft":
        if (editable) return;
        consume(ev);
        focusReel(river.moveHorizontal(focusIndex, -1) ?? focusIndex);
        return;
      case "Enter": {
        if (editable && !inFilter) return;
        const reel = river.reelAt(focusIndex)?.reel;
        if (reel === undefined) return;
        consume(ev);
        if (ev.shiftKey) {
          const outcome = outcomeStates.get(reel.chat.id);
          if (outcome === undefined || outcome.kind !== "measured" || outcome.startMs === null) {
            shell.hint("Replay: no event recorded");
            return;
          }
          replay(reel);
        } else resume(reel);
        return;
      }
      default:
        // Type anywhere = filter (§5.2). Single printable characters land
        // in the filter field wherever focus sits.
        if (!editable && ev.key.length === 1 && ev.key !== " ") {
          consume(ev);
          filter += ev.key;
          filterEl?.focus();
        }
    }
  }
</script>

<div class="switch" bind:this={rootEl}>
  <header class="bar">
    <input
      bind:this={filterEl}
      bind:value={filter}
      class="filter"
      type="text"
      name="filter"
      placeholder="Search projects and loaded conversations…"
      aria-label="filter projects and conversations"
      data-verb-id="switch.filter"
    />
    <!-- One creation home. The menu names its captured destination and
         exposes both capabilities declared in shell/room-chords.ts. -->
    <button class="verb add create primary" data-verb-id="switch.create-menu" title={past ? PAST_VIEW_ACT_REASON : "New conversation or project"} disabled={past || busy} aria-haspopup="menu" aria-expanded={createMenu !== null} onclick={openCreateMenu}>{VERB_MARK.add} New</button>
    <div class="sort-control">
      <select class="field" aria-label="Sort projects" bind:value={sort} onchange={changeSort}>
        <option value="recent">Recent activity</option>
        <option value="name">Project name</option>
      </select>
    </div>
    <button class="verb more toolbar-options" data-verb-id="switch.options" aria-label="Project room options" title="Recycle bin and keyboard shortcuts" aria-haspopup="menu" aria-expanded={optionsAt !== null} onclick={event => { const box = event.currentTarget.getBoundingClientRect(); optionsAt = optionsAt === null ? {x: box.left, y: box.bottom} : null; }}>{VERB_MARK.more}</button>
    <span class="counts">
      {$projects.length}
      {$projects.length === 1 ? "project" : "projects"} · {counts.conversations} conversations{counts.pending > 0
        ? ` · ${counts.pending} ${counts.pending === 1 ? "project" : "projects"} still loading`
        : ""}{counts.unavailable > 0
        ? ` · ${counts.unavailable} ${counts.unavailable === 1 ? "project" : "projects"} not reachable`
        : ""}
    </span>
    <!-- WHERE THE NEXT CHOICE LANDS. Stated always, in both modes, because
         the difference between "replaces this tab" and "opens a new tab" is
         invisible otherwise — and it is the only thing the `+` changes. -->
    {#if armed}<span class="landing" data-state="armed">{landing}</span>{/if}
    <!-- The chords are taught as they behave: while a head stands, the two
         CREATE chords do nothing but say why, so the legend stops offering
         them rather than listing a gesture that will be refused. -->
  </header>

  {#if createMenu !== null}
    <ContextMenu title="New" verbs={createVerbs} at={createMenu.at} returnFocus={() => filterEl ?? null} onclose={() => { createMenu = null; }} />
  {/if}
  {#if optionsAt !== null}
    <ContextMenu title="Project room options" verbs={optionVerbs} at={optionsAt} returnFocus={() => filterEl ?? null} onclose={() => { optionsAt = null; }} />
  {/if}
  {#if showingShortcuts}<Popover title="Keyboard shortcuts" onclose={() => { showingShortcuts = false; }}><p>{hintsLine}</p></Popover>{/if}

  {#if projectMenu !== null}
    {#if projectVerbs.length === 0}
      <Popover title={projectMenu.cap.project.name} returnFocus={() => filterEl ?? null} onclose={() => { projectMenu = null; }} style="position: fixed; right: var(--sp-3); top: var(--horizon-h);">
        <p class="project-folder"><strong>Folder</strong> {projectMenu.cap.project.path}</p>
        {#if past}<p>{PAST_VIEW_ACT_REASON}</p>{/if}
      </Popover>
    {:else}
    <ContextMenu title={projectMenu.cap.project.name} verbs={projectVerbs} at={projectMenu.at} returnFocus={() => filterEl ?? null} onclose={() => { projectMenu = null; }}>
      <Disclosure id="switch-project-details" label="Details" menu><p class="project-folder"><strong>Folder</strong> {projectMenu.cap.project.path}</p></Disclosure>
      {#if past}<p>{PAST_VIEW_ACT_REASON}</p>{/if}
    </ContextMenu>
    {/if}
  {/if}

  {#if showingTrash}
    <Popover title="recycle bin" size="picker" onclose={() => (showingTrash = false)} style="top: var(--horizon-h); left: var(--sp-5);">
      {#if trashNote !== null}
        <p class="note" data-state="warn">{trashNote}</p>
      {:else if trash.projects.length === 0 && trash.chats.length === 0 && recycledFiles.length === 0}
        <Answer answer={absent("recycle bin is empty")} />
      {:else}
        <ul class="trash-list">
          {#each trash.projects as p (p.id)}
            <li class="trash-row">
              <span class="trunc">{p.name}</span>
              <span class="engraved">project</span>
              <button
                class="verb restore "
                type="button"
                data-verb-id="switch.restore-project"
                aria-label={`${VERB_MARK_WORD.restore} project ${p.name}`}
                title={`${VERB_MARK_WORD.restore} this project`}
                disabled={past || busy}
                onclick={() => void undropProject(p.id)}>{VERB_MARK.restore}</button
              >
            </li>
          {/each}
          {#each trash.chats as c (c.id)}
            <li class="trash-row">
              <span class="trunc">{c.title}</span>
              <span class="engraved">conversation</span>
              <button
                class="verb restore "
                type="button"
                data-verb-id="switch.restore-chat"
                aria-label={`${VERB_MARK_WORD.restore} conversation ${c.title}`}
                title={`${VERB_MARK_WORD.restore} this conversation`}
                disabled={past || busy}
                onclick={() => void undropChat(c.id)}>{VERB_MARK.restore}</button
              >
            </li>
          {/each}
          {#each recycledFiles as f (f.id)}
            <li class="trash-row">
              <span class="trunc">{f.name}</span>
              <span class="engraved">{f.wasDirectory ? "folder" : "file"}</span>
              <span class="trunc" title={f.originalPath}>{f.relativePath}</span>
              <button
                class="verb restore "
                type="button"
                data-verb-id="switch.restore-file"
                aria-label={`${VERB_MARK_WORD.restore} ${f.name}`}
                title={`${VERB_MARK_WORD.restore} this ${f.wasDirectory ? "folder" : "file"}`}
                disabled={past || busy}
                onclick={() => void undropFile(f.id)}>{VERB_MARK.restore}</button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </Popover>
  {/if}

  {#if creating && npPicking}
    <Popover title="new project" size="picker" onclose={abandonCreate} style="top: var(--horizon-h); left: var(--sp-5);">
      {#if npNote !== null}
        <p class="note" data-state="warn">{npNote}</p>
      {/if}
      {#if busy}
        <p class="note">creating…</p>
      {/if}
      <FolderPicker
        subject="the new project's folder"
        blocked={past ? PAST_VIEW_ACT_REASON : busy ? "creating the project" : null}
        onselect={pickProjectPath}
        oncancel={abandonCreate}
      />
    </Popover>
  {/if}

  {#if armedBin !== null}
    <Popover
      title="recycle"
      kind="alertdialog"
      onclose={() => (armedBin = null)}
      style="top: var(--horizon-h); left: var(--sp-5);"
    >
      <!-- ONE sentence states the move (the arm title, verbatim — the same
           words the reel verb and the confirm button carry, so three
           surfaces cannot disagree); ONE states the recovery. The old second
           line REPEATED "it goes to the recycle bin" from the first (the
           duplicated copy UIE-050 filed) — a sentence that says a thing
           twice says it once and spends the reader's patience the second
           time. -->
      <p class="note">{recycleArmedTitle(armedBin.name)}</p>
      <p class="note">nothing is deleted — restore it from the bin below</p>
      <button
        class="verb "
        type="button"
        data-verb-id="switch.recycle-confirm"
        data-state="armed"
        title={recycleArmedTitle(armedBin.name)}
        disabled={past || busy}
        onclick={() => void confirmArmedBin()}>{recycleFace(true)}</button>
    </Popover>
  {/if}

  {#if relinkId !== null}
    {@const relinkProject = $projects.find((p) => p.id === relinkId)}
    {#if relinkProject !== undefined}
      <Popover
        title={`relink “${relinkProject.name}”`}
        size="picker"
        onclose={() => (relinkId = null)}
        style="top: var(--horizon-h); left: var(--sp-5);"
      >
        <span class="relink-was trunc">was {relinkProject.path}</span>
        <FolderPicker
          subject={`the folder ${relinkProject.name} lives in now`}
          blocked={past ? PAST_VIEW_ACT_REASON : null}
          onselect={(path) => void relinkTo(path)}
          oncancel={() => (relinkId = null)}
        />
        {#if relinkNote !== null}
          <span class="note" data-state="warn">{relinkNote}</span>
        {/if}
      </Popover>
    {/if}
  {/if}

  <div class="river" bind:this={riverEl} use:viewport onscroll={() => { scrollTop = riverEl?.scrollTop ?? 0; }} role="list" aria-label="recency river">
    {#if $projects.length === 0}
      <!-- The wrapper keeps the river's full-row centring; the engraved cap
           face is deliberately dropped — the grammar owns absence's face. -->
      <div class="river-empty">
        <Answer answer={absent(`No projects yet. ${kNewProject} creates one`)} />
      </div>
    {:else if filter.trim().length > 0 && counts.matches === 0}
      <div class="river-empty">
        <Answer answer={absent(`nothing named “${filter.trim()}”`)} />
      </div>
    {/if}

    <div class="river-canvas" style:height={`${totalHeight}px`} role="presentation">
    {#each windowCaps as item (item.cap.project.id)}
      {@const cap = item.cap}
      <section class="group reveal-on-hover" style:top={`${item.offset}px`} style:left={`${item.column * ((geometry.contentWidth ?? 0) + geometry.reelGap) / geometry.columns}px`} style:width={`${((geometry.contentWidth ?? 0) - (geometry.columns - 1) * geometry.reelGap) / geometry.columns}px`} role="listitem" aria-label={cap.project.name}>
        <header class="cap" use:measureCap={{ cap, model: river }}>
          <button class="verb bare project-open cap-name" data-verb-id="switch.open-project" title={`Open ${cap.project.name}`} onclick={() => { land(cap.project.id, null); shell.closeRoom(); }}><span>{cap.project.name}{#if pathHints[cap.project.id]}<span class="cap-path" title={cap.project.path}>{pathHints[cap.project.id]}</span>{/if}</span></button>
          <button class={past || busy ? "verb bare disclose cap-menu" : "verb more cap-menu"} data-verb-id="switch.project-menu" aria-label={`${past || busy ? "Project details" : "Actions"} for ${cap.project.name}`} title={`${past || busy ? "Project details" : "Actions"} for ${cap.project.name}`} aria-haspopup={past || busy ? "dialog" : "menu"} aria-expanded={projectMenu?.cap.project.id === cap.project.id} onclick={event => openProjectMenu(event, cap)}>{#if past || busy}<span class="disclosure-mark" aria-hidden="true"></span>{:else}{VERB_MARK.more}{/if}</button>
          {#if cap.project.folder === "missing"}
            <span class="cap-missing" title={cap.project.path}>this project's folder is missing</span>
            <button
              class="verb "
              data-verb-id="switch.relink"
              title="pick a folder that exists and point this project at it"
              disabled={past || busy}
              onclick={() => openRelink(cap.project.id)}>Relink</button
            >
          {:else if cap.project.folder === "unreadable"}
            <span class="cap-missing" title={cap.project.path}>this project's folder is not readable</span>
          {/if}
          {#if cap.moreCount > 0}
            <button
              class="verb "
              data-verb-id="switch.expand"
              onclick={() => toggleExpand(cap.project.id)}>{cap.moreCount} more</button
            >
          {:else if cap.expanded && cap.reels.length > REELS_PER_CAP}
            <button
              class="verb "
              data-verb-id="switch.collapse"
              onclick={() => toggleExpand(cap.project.id)}>Latest {REELS_PER_CAP} only</button
            >
          {/if}
          {#if cap.chatsState === "failed" && cap.reels.length > 0}
            <span class="cap-stale">Not reachable now. Showing your last visit.</span>
          {/if}
        </header>
        {#if cap.reels.length > 0}
          <div class="grid" style:height={`${item.gridHeight}px`}>
            <div class="grid-window" style:top={`${item.reelOffset}px`}>
            {#each item.rows as row (row.index)}
            <div class="conversation-row" style:--cap-columns={geometry.reelColumns ?? 1}>
            {#each row.reels as reel, index (reel.chat.id)}
              <ReelCell
                {reel}
                index={item.reelStart + row.index + index}
                focused={focusedReel?.chat.id === reel.chat.id}
                current={$currentChatId === reel.chat.id}
                returnFocus={() => filterEl ?? null}
                outcome={outcomeFor(reel.chat.id)}
                density={densityFor(reel.chat.id)}
                custodyFiles={$custodyChatCounts[reel.chat.id] ?? 0}
                nowMs={openedAt}
                onFocus={() => { focusIndex = item.reelStart + row.index + index; }}
                onResume={() => resume(reel)}
                onReplay={() => replay(reel)}
                recycleArmed={isRecycleArmed("chat", reel.chat.id)}
                onTrash={past || busy ? undefined : () => void binChat(reel.chat.id, reel.chat.title)}
              />
            {/each}
            </div>
            {/each}
            </div>
          </div>
        {:else if cap.chatsState === "pending"}
          <Answer answer={pending("reading this project's conversations")} />
        {:else if cap.chatsState === "failed"}
          <Answer answer={failed("conversations not available right now")} />
        {/if}
      </section>
    {/each}
    </div>

  </div>
</div>

<style>
  .switch {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }
  .bar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    align-items: center;
    /* Search leads; creation/options and trailing sort wrap as whole controls. */
    gap: var(--sp-2) var(--sp-3);
    padding: var(--sp-2) var(--sp-5);
    flex: none;
  }
  .filter {
    width: 100%;
    min-width: 0;
    min-height: var(--hit-min);
    font-family: var(--face-sans);
    font-size: var(--f-ui-size);
    color: var(--ink-1);
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: var(--sp-1) var(--sp-2);
  }
  .filter::placeholder {
    color: var(--ink-3);
  }
  .counts {
    grid-column: 1 / -1;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
    /* Counts and pending exceptions yield to available width. */
  }
  .sort-control { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--f-data-size); justify-self: end; grid-column: 4; grid-row: 1; }
  .sort-control select { width: auto; }
  .toolbar-options { grid-column: 3; grid-row: 1; }
  .create { white-space: nowrap; }
  .project-folder { overflow-wrap: anywhere; }
  .landing {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    white-space: nowrap;
  }
  /* Armed by the `+`: the sentence stops being background and starts being
   * the thing you need to read. Ink, not hue — no fact here is abnormal, so
   * it wears the grammar's `armed` word with the brightest ink rather than
   * the alarm edge a destructive control frames itself in. */
  .landing[data-state="armed"] {
    color: var(--ink-1);
  }
  /* The input recipe is owned by tokens.css (.cockpit input.field). */
  .note {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-3);
  }
  .note[data-state="warn"] {
    color: var(--warn);
  }
  .river {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-4) var(--sp-5) var(--sp-7) var(--sp-5);
    width: 100%;
    /* Groups use the available content width. */
    margin: 0;
    /* The model owns offsets for these content-fitting project groups. */
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-3);
  }
  .river-canvas {
    position: relative;
    flex: none;
    width: 100%;
  }
  .group {
    position: absolute;
    left: 0;
    width: 100%;
    min-width: 0;
    padding-bottom: var(--sp-3);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  /* The single contextual action stays beside its exact project name. */
  .cap-menu {
    flex: none;
    align-self: center;
  }
  .trash-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .trash-row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
  }
  /* The cap row's recipe is owned by tokens.css (.cockpit .cap). The
   * name is the project, not an engraved label (those are instrument
   * names — SWITCH, SESSION — and wearing them here made every shelf
   * read as chrome). */

  .cap-name {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .cap-path { display: block; font-size: var(--f-data-size); color: var(--ink-3); overflow-wrap: anywhere; }
  .switch .cap { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
  .cap-name { grid-column: 1; grid-row: 1; }
  .cap-menu { grid-column: 2; grid-row: 1; }
  .cap-stale {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--warn);
    white-space: nowrap;
  }
  /* The missing-folder badge: the same ink and register as the stale
   * warning beside it — an abnormal fact about the project, said plainly,
   * never an error wall. */
  .cap-missing {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--warn);
    white-space: nowrap;
  }
  .cap-stale, .cap-missing { grid-column: 1 / -1; white-space: normal; }

  .relink-was {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    min-width: 0;
  }
  /* The pointer target floor in BOTH axes (--hit-min, tokens.css §12.5 —
   * the one owner of the number). Padding grows the target; the type stays
   * as quiet as it was. */
  /* The verb recipe is owned by tokens.css (.cockpit .verb) — including the
   * hover answering only a control that can act (hover on a refused control
   * would promise an affordance it has withdrawn); this room's verbs keep
   * the smaller engraved register (.engraved-ctl, a marker class) and the
   * tighter pad. */

  .grid {
    position: relative;
    width: 100%;
  }
  .grid-window {
    position: absolute;
    left: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    width: 100%;
  }
  .conversation-row { display: grid; grid-template-columns: repeat(var(--cap-columns), minmax(0, 1fr)); gap: var(--sp-2); height: var(--reel-h); min-width: 0; }
  /* Position only — the words inside are the grammar's. */
  .river-empty {
    flex: 1 1 100%;
    margin: var(--sp-6) 0;
    text-align: center;
  }
</style>
