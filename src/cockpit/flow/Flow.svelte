<script lang="ts">
  /**
   * The FLOW (spec §2.1, §3) — full-bleed causal block stream with a custom
   * HEIGHT-INDEXED virtualizer (§3.8, the Warp SumTree approach):
   *
   *   - beats are indexed by measured height (HeightIndex — a Fenwick tree);
   *     their contents are opaque to the index;
   *   - the event log lives OUTSIDE reactive state (log.ts — plain module
   *     array + version counter); ONLY the visible window is reactive here;
   *   - each rendered beat measures itself via ResizeObserver and writes the
   *     measurement back into the index.
   *
   * SHELL INTEGRATION (shell/contract.ts): mounted as the `flow` outlet with
   * `{ shell }`. The flow claims the beat-grammar keys (↑↓ ←→ Enter Esc),
   * routes composer submissions through the three grammars (§5.3), and opens
   * beats in the shell's SCOPE. It also mounts standalone (shell = null) for
   * the dev harness — keys then bind to the flow element itself.
   *
   * The BEAD (§11.2) rides the gutter: a beam pulse at the beat doing work
   * NOW. It moves only when the log version changes on real events; under
   * reduced motion position updates are discrete (no tween).
   *
   * The DESK LINE (§4.3) — projections about the NEXT turn — renders as this
   * component's bottom edge, immediately above the desk in the shell stack
   * (the shell's Desk has no line slot; this edge is the same pixel row).
   */
  import { tick, untrack } from "svelte";
  import {
    logVersion,
    beatCount,
    beatsAtOrBefore,
    beatIndexAt,
    windowSlice,
    beatById,
    causalChainOf,
    lastBeat,
    indexOfBeat,
    DEFAULT_LOG_ID,
    displayedLogId,
    dropLog,
    logIsReloading,
    prependedCount,
  } from "./log.ts";
  import { activeWorkspaceId } from "../../state/workspaces.ts";
  import {
    bindClosedWorkspaces,
    bindFlowView,
    flowViewForActive,
    noteFlowView,
    type FlowView,
  } from "./flow-view.ts";
  import { forgetIngestState } from "./ingest.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";
  import { loadChatHistory, loadOlderHistory } from "../../client.ts";
  import { messages } from "../../state/chat-messages.ts";
  import { chatHistoryLoad } from "../../state/chat-history-load.ts";
  import { historyReach } from "../../state/chat-history-reach.ts";
  import { FLOW_VIEW_MIRROR_MS, OLDER_PAGE_TRIGGER_PX, HISTORY_HEAD_H } from "./flow-config.ts";
  import { FOCUS_BEAT_CONTRACT, type FocusBeatDetail } from "../sweep/focus-seam.ts";
  import { asOfHead } from "../../data/asof.ts";
  import { DEFAULT_ESTIMATE, HeightIndex, SHAPE_HEIGHT } from "./heights.ts";
  import {
    fisheyeLevel,
    overrideFor,
    renderedLevel,
    setOverride,
    type FisheyeResult,
  } from "./fisheye.ts";
  import { isStreaming } from "../../state/chat-messages.ts";
  import { currentProject } from "../../state/projects.ts";
  import { currentChatId } from "../../state/chats.ts";
  import { deskLine, dismissDeskLine } from "../computer/admission.ts";
  import { startIngest } from "./ingest.ts";
  import { makeVerbsFor } from "./verbs.ts";
  import { opensScopeSheet, rendersInFlow } from "./beat-state.ts";
  import { thinkingFoldVersion, thinkingOpen, thinkingState } from "./thinking-fold.ts";
  import { groupPlacements, type GroupPlace } from "./grouping.ts";
  import { grammarMenuFor, routeComposerSubmission } from "./composer-router.ts";
  import { dockImpactFinding } from "./effect-findings.ts";
  import type { ShellApi } from "../shell/contract.ts";
  import BeatView from "./Beat.svelte";
  import BeatScope from "./BeatScope.svelte";
  import WaitLine from "./WaitLine.svelte";
  import { waitEnd, waitStage, waitStartedAt } from "./wait-stage.ts";
  import Bead from "./Bead.svelte";
  import DeskLine from "./DeskLine.svelte";
  import FindingNote from "../computer/FindingNote.svelte";
  import { trimVerbPlaceholder } from "../computer/findings.ts";
  import { beatNoun, type Beat } from "./types.ts";
  // The right menu's row paths ask about beats through the one-shot seam
  // (flow/beat-request.ts) — the pane has no handle into the flow, and the
  // flow answers with its own open/reveal functions so an externally-asked
  // beat and a clicked one land identically.
  import { consumeBeatRequest, pendingBeatRequest } from "./beat-request.ts";

  let {
    shell = null,
    onOpen = undefined,
    prefill = null,
    ingest = true,
  }: {
    shell?: ShellApi | null;
    /** Harness hook: called on Enter-open in addition to the shell scope. */
    onOpen?: ((beat: Beat) => void) | undefined;
    /** Composer prefill sink. Default: the shell's prefill seam
     * (ShellApi.prefillComposer); a harness may override. Only a mount
     * with NEITHER renders the verb disabled (§1.2). */
    prefill?: ((text: string) => void) | null;
    /** Tests/harness may drive the log directly and disable store ingestion. */
    ingest?: boolean;
  } = $props();

  const OVERSCAN = 6;
  /** Extra beats read on each side of the window purely to decide batch
   * boundaries from real neighbours rather than from the viewport edge. */
  const GROUP_LOOKAROUND = 32;

  /**
   * ── ONE HEIGHT INDEX PER WORKSPACE ──────────────────────────────────────
   *
   * The index is measurements BY POSITION, and position 12 is a different
   * beat in every conversation. A single index shared across tabs would hand
   * workspace B the pixel heights workspace A measured — a virtualizer laid
   * out against somebody else's rows, which is scroll geometry that is wrong
   * in a way nothing on screen explains.
   *
   * Held here rather than in log.ts because heights are a fact about THIS
   * RENDER (the shape stamps come from `shapeOf` below, and the same log
   * rendered at another density measures differently). The log is the record;
   * this is the drawing of it.
   */
  const heightIndexes = new Map<string, HeightIndex>();
  function heightsFor(id: string): HeightIndex {
    let index = heightIndexes.get(id);
    if (index === undefined) {
      index = new HeightIndex(DEFAULT_ESTIMATE);
      heightIndexes.set(id, index);
    }
    return index;
  }
  /** The index for the log ON SCREEN. Re-resolved on every version bump, so
   * `activateLog`'s own bump is what swaps it — there is no second ordering
   * to get right. */
  let heights = heightsFor(DEFAULT_LOG_ID);

  /**
   * `bind:this` sets this to NULL on unmount, not undefined. Every guard
   * below therefore tests for both: a queued `scrollToEnd` microtask that
   * outlived its component threw `Cannot read properties of null` into the
   * console — harmless to the surface, and exactly the kind of noise that
   * trains a reader to ignore the console.
   */
  let container: HTMLDivElement | null | undefined;
  let scrollTop = $state(0);
  let viewportH = $state(600);
  /** Mirrors logVersion into Svelte reactivity. */
  let version = $state(0);
  /** Bumped when a measurement or manual override changes layout. */
  let layoutVersion = $state(0);
  /* ── THE FOUR VIEW LOCALS BELONG TO ONE WORKSPACE ──────────────────────
   * One Flow instance serves every tab, so these four are the flow's half of
   * the workspace split (flow-view.ts states which and why). They are still
   * plain locals — the component is the only reader — and `bindFlowView`
   * below swaps them on activation and records them on departure, the same
   * shape `shell/workspace-view.ts` uses for the room and the desk. */
  let focusedId = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});
  let follow = true;
  /** A restored offset waiting for the incoming log's rows to exist. */
  let pendingScrollRestore: number | null = null;

  const projectPath = $derived($currentProject?.path ?? null);
  const projectId = $derived($currentProject?.id ?? null);
  const chatId = $derived($currentChatId);
  /**
   * An empty conversation that just became the one on screen arrives
   * once. Skip the first assignment (boot / one-reveal). `arrive` is
   * the owned spark — not a second empty-state animation.
   *
   * DERIVED, NOT STORED — and this is the difference between an arrival
   * and an uncaught crash (driven: three drives in a row threw
   * `MotionContract: the cause "the open conversation" has already moved
   * something` from this very spot). A `$state` land written by an
   * `$effect` hands the div a STALE cause whenever the empty-state branch
   * re-mounts before the effect's tick — a spent cause re-consumed, and
   * the contract refuses it by throwing. The derived shape mints the cause
   * IN the render that mounts the div, so the cause is fresh exactly when
   * the element reads it, and re-renders that change nothing re-derive
   * `null` rather than replay a stored one. The locals below advance only
   * when the derived re-evaluates, which is when the chat actually changed.
   */
  let lastChat: string | null = null;
  const land = $derived.by((): MovesParam => {
    const next = chatId;
    const previous = lastChat;
    lastChat = next;
    if (next === null || previous === null || previous === next) {
      return null;
    }
    return {
      motion: "arrive",
      cause: becauseChanged("the open conversation", previous, next),
    };
  });
  /** The log/index/cursor key. `DEFAULT_LOG_ID` when the page has no
   * workspaces at all (the dev harness), which is the single-tenant case
   * this component has always handled. */
  const workspaceId = $derived($activeWorkspaceId ?? DEFAULT_LOG_ID);

  /** The composer prefill sink: explicit prop wins; under the shell the
   * seam is ShellApi.prefillComposer — so "edit & resend" is WIRED here. */
  const prefillSink = $derived(prefill ?? (shell !== null ? shell.prefillComposer : null));

  /** Live composer text mirrored from the shell (per keystroke) — feeds
   * the `/` and `?` grammar menu on the desk line. */
  let composerLive = $state("");

  // ── Ingestion: stores → beat log, with wired verbs (§1.2) ────────────────

  $effect(() => {
    if (!ingest) return;
    const pid = projectId;
    const cid = chatId;
    const ws = workspaceId;
    const sink = prefillSink;
    const stop = startIngest({
      workspaceId: ws,
      chatId: cid,
      verbsFor: makeVerbsFor({
        chatId: cid,
        projectId: pid,
        toggleExpand: toggleExpandById,
        prefillComposer: sink,
        hint: shell !== null ? shell.hint : null,
        userPromptBefore,
      }),
      onEffect: (effectBeat) => {
        const path = projectPath;
        if (path !== null) void dockImpactFinding(effectBeat, path);
      },
    });
    return stop;
  });

  function userPromptBefore(beatId: string): string | null {
    const i = indexOfBeat(beatId);
    if (i < 0) return null;
    for (const beat of [...windowSlice(0, i)].reverse()) {
      if (beat.kind === "turn" && beat.turn?.who === "you") return beat.turn.text;
    }
    return null;
  }

  // ── Log subscription ─────────────────────────────────────────────────────

  /**
   * ── WHAT EACH LOG HAS ALREADY PREPENDED, AS FAR AS THIS INDEX KNOWS ──────
   *
   * Beats now arrive at BOTH ends: a run appends, a page of older messages
   * prepends (§4). The two are opposite events for a position-keyed index —
   * an append leaves every existing measurement where it is, a prepend moves
   * all of them down — and the version bump alone cannot tell them apart,
   * because both are "the count went up".
   *
   * So the log counts what it has put at the front, and this remembers what
   * this index has already been told about. The difference is the shift.
   *
   * A DECREASE is a resync, not a negative shift: the log was cleared or
   * evicted, and its beats are gone rather than moved.
   */
  const prependSeen = new Map<string, number>();

  /**
   * ── HOLDING THE READER STILL WHILE THE PAST ARRIVES ABOVE THEM ───────────
   *
   * `k` rows appear above everything on screen. The browser keeps `scrollTop`
   * through that, so the words under the reader's eyes move DOWN by the whole
   * height of the page that just arrived — which, at a page of 200 beats, is
   * the reader being thrown thousands of pixels from what they were reading,
   * by a fetch they did not ask for in any visible way.
   *
   * The correction is exact rather than approximate: the new rows occupy
   * `offsetOf(k)` pixels, and that is precisely how much further down
   * everything they were reading now sits. Their measurements land a frame
   * later and move it again — which is what `holdReadingPosition` (called
   * from the measure action) already exists to absorb, and it absorbs this
   * for the same reason and by the same anchored-beat rule.
   *
   * NOT WHEN FOLLOWING. A reader at the tail asked to be at the tail, and
   * nothing arriving above them changes where the tail is.
   */
  type ReadingAnchor = Readonly<{ index: number; into: number }>;

  /**
   * The beat under the top of the viewport, and how far into it the reader
   * is. Read BEFORE the index shifts, because both numbers are positional.
   *
   * It states WHERE THE READER IS and makes no decision about whether to act
   * on it: the one check that decides — a reader who is following owns their
   * own position — lives in `absorbPrepend`, at the moment the restore would
   * happen. A second copy here was mutation-tested and could not be made to
   * fail, because the restore refuses anyway; a check that cannot be observed
   * to be wrong cannot be observed to be right either.
   */
  function readingAnchor(index: HeightIndex): ReadingAnchor | null {
    if (container === undefined || container === null) return null;
    const top = Math.max(0, container.scrollTop - headHeight());
    const at = index.indexAtOffset(top);
    return { index: at, into: top - index.offsetOf(at) };
  }

  /**
   * Put the reader back on the same words, `k` rows further down the log.
   *
   * AFTER `tick()`, not before, and that is the whole correctness of it: the
   * new rows do not exist in the DOM until the spacer re-renders, so the
   * document is still its old height at this instant and the browser would
   * CLAMP the larger `scrollTop` to it. The clamp is not undone when the
   * height arrives, so a compensation applied one frame early is a permanent
   * jump — the same trap `holdReadingPosition` documents for a shrink.
   */
  /**
   * ── ONE OWNER OF THE SCROLL POSITION AT A TIME ───────────────────────────
   *
   * `holdReadingPosition` also restores a scroll position across a `tick()`,
   * and during a prepend the two would fight: it captures its anchor from
   * `indexAtOffset(scrollTop)` at a moment when the INDEX has already shifted
   * by `k` but `scrollTop` has not, so it names a beat `k` places from the
   * reader's and restores to a position that partly undoes the compensation.
   *
   * Measured before this flag: four trials of five held the reader to within
   * 1px and the fifth moved 126px. Two owners for one scroll position is how
   * a fight starts, and the file already says so for `follow`.
   */
  let prependPending = false;

  function absorbPrepend(index: HeightIndex, k: number, anchor: ReadingAnchor): void {
    prependPending = true;
    void tick().then(() => {
      prependPending = false;
      if (container === undefined || container === null || follow || heights !== index) return;
      const next = index.offsetOf(anchor.index + k) + anchor.into + headHeight();
      container.scrollTop = next;
      scrollTop = container.scrollTop;
    });
  }

  $effect(() => {
    const unsubscribe = logVersion.subscribe((v) => {
      // The DISPLAYED log is the authority for which index to grow. Resolving
      // it here — rather than from an effect that races the ingest's own
      // effect — means `activateLog`'s single version bump both puts the new
      // beats on screen and puts the right measurements under them.
      const id = displayedLogId();
      heights = heightsFor(id);
      // The FRONT first, then the back. A prepend must be applied before the
      // count is reconciled, or the tail-append below would create the new
      // rows at the WRONG END and every measurement already taken would be
      // attributed to the beat `k` places after the one it measured.
      const prepended = prependedCount();
      const delta = prepended - (prependSeen.get(id) ?? 0);
      prependSeen.set(id, prepended);
      if (delta > 0) {
        const anchor = readingAnchor(heights);
        heights.prepend(delta);
        if (anchor !== null) absorbPrepend(heights, delta, anchor);
      }
      while (heights.length < beatCount()) heights.append();
      if (heights.length > beatCount()) heights.truncate(beatCount());
      version = v;
      if (pendingScrollRestore !== null) {
        const top = pendingScrollRestore;
        pendingScrollRestore = null;
        queueMicrotask(() => {
          if (container === undefined || container === null) return;
          container.scrollTop = top;
          scrollTop = top;
        });
      } else if (follow) {
        queueMicrotask(scrollToEnd);
      }
    });
    return unsubscribe;
  });

  function scrollToEnd(): void {
    if (container === undefined || container === null) return;
    container.scrollTop = container.scrollHeight;
  }

  /**
   * ── THE HEAD ROW OCCUPIES REAL PIXELS AND THE INDEX DOES NOT KNOW IT ─────
   *
   * The line above the oldest loaded beat ("older messages not loaded yet" /
   * "this is the beginning of the conversation") is not a beat: it has no
   * position in the height index, no measurement and no id. It is rendered as
   * the scroller's first child, ABOVE the virtualized spacer, so every beat
   * offset the index reports is `headHeight()` pixels short of where the row
   * actually sits.
   *
   * One conversion, used everywhere scroll pixels and index offsets meet, so
   * the two coordinate systems cannot drift: `scrollTop - headHeight()` is
   * index space, `offsetOf(i) + headHeight()` is scroll space. The height is
   * DECLARED (flow-config.ts) rather than measured, exactly like a beat's
   * shape height, and the row is one non-wrapping line so it cannot exceed it.
   *
   * Zero when no beats are drawn: the empty and unread states render their own
   * statement and the head row is not there to be counted.
   */
  function headHeight(): number {
    return visibleCount > 0 ? HISTORY_HEAD_H : 0;
  }

  function onScroll(): void {
    if (container === undefined || container === null) return;
    scrollTop = container.scrollTop;
    follow = container.scrollTop + container.clientHeight >= container.scrollHeight - 48;
    reachBackwards();
    recordView();
  }

  /**
   * ── TRAVELLING BACKWARDS IS A SCROLL, NOT A BUTTON ───────────────────────
   *
   * *"do lazy loadings"*. The reader approaching the top of what is loaded is
   * the request; the verb on the head row exists for the reader who would
   * rather ask, and for the one whose last page failed.
   *
   * `loadOlderHistory` is idempotent under a burst — it refuses while a page
   * is in flight, using the reach's own `loading` flag — so calling it on
   * every scroll event is one page, not one page per event. That guard lives
   * there rather than here on purpose: the flow is not the only caller.
   */
  function reachBackwards(): void {
    if (container === undefined || container === null) return;
    const cid = chatId;
    if (cid === null) return;
    const reach = $historyReach;
    if (reach === null || reach.chatId !== cid || !reach.hasOlder || reach.loading) return;
    // A failed page is NOT retried by scrolling. The identical request that
    // just failed is not a recovery strategy (the same rule the conversation
    // open follows); the head row states the failure and offers the verb.
    if (reach.failure !== null) return;
    if (container.scrollTop > OLDER_PAGE_TRIGGER_PX) return;
    void loadOlderHistory(cid);
  }

  /** The head row's verb: ask again, once, deliberately. Clears the recorded
   * failure by attempting — `loadOlderHistory` re-states it if it fails
   * again. */
  function readEarlier(): void {
    const cid = chatId;
    if (cid === null) return;
    void loadOlderHistory(cid);
  }

  // ── The workspace's reading position (§ flow-view.ts) ────────────────────

  /** What this component is showing right now, as one value. */
  function currentView(): FlowView {
    return { scrollTop, focusedId, expanded, follow };
  }

  /**
   * Write the reload MIRROR, debounced. The in-memory hand-off on a switch is
   * exact and synchronous (`bindFlowView`'s record callback); this is only
   * about surviving a browser reload, and a `sessionStorage` write per scroll
   * event would be a storage round-trip inside the scroll handler.
   */
  let recordTimer: ReturnType<typeof setTimeout> | null = null;
  function recordView(): void {
    if (recordTimer !== null) return;
    recordTimer = setTimeout(() => {
      recordTimer = null;
      noteFlowView(currentView());
    }, FLOW_VIEW_MIRROR_MS);
  }

  function applyView(view: FlowView): void {
    focusedId = view.focusedId;
    expanded = { ...view.expanded };
    follow = view.follow;
    scrollTop = view.scrollTop;
    // The rows of the incoming log do not exist yet. The restore is handed to
    // the version bump that brings them, so it lands on real geometry instead
    // of on the outgoing conversation's scroll height.
    pendingScrollRestore = view.scrollTop;
  }

  // NOT gated on `ingest`: where a tab was reading is a fact about the
  // WORKSPACE, not about where its beats came from. A harness mount that
  // drives the log by hand still has tabs, and still has to hand them back
  // the position they were left at.
  $effect(() => {
    // Boot: the mirror for the workspace we opened on, if this browser tab
    // has one. Nothing mounts late — the values are read before first paint
    // of the window and the scroll lands with the first version bump.
    const restored = flowViewForActive();
    if (restored !== null) applyView(restored);
    const unbindView = bindFlowView(applyView, () => currentView());
    const unbindClosed = bindClosedWorkspaces((id) => {
      // A closed tab: its beats, its cursors and its measurements all go.
      dropLog(id);
      forgetIngestState(id);
      heightIndexes.delete(id);
    });
    return () => {
      unbindView();
      unbindClosed();
      if (recordTimer !== null) clearTimeout(recordTimer);
    };
  });

  /**
   * THE TRANSCRIPT STORE IS EMPTY AND A CONVERSATION IS OPEN — ask for it.
   *
   * `state/chat-messages.ts` is cleared on every chat switch, and a workspace
   * switch IS a chat switch. Nothing else in the cockpit re-reads history on
   * that path (the Switch room does it when YOU pick a conversation; there is
   * no picker in a tab click), so without this the store stays empty under a
   * warm log and the next thing you send diverges from it.
   *
   * `askedFor` makes it exactly one request per conversation per visit: a
   * conversation that genuinely has no messages answers with an empty list,
   * which sets the store empty again, which would otherwise re-enter here
   * forever.
   */
  let askedFor: string | null = null;
  $effect(() => {
    if (!ingest) return;
    const cid = chatId;
    const empty = $messages.length === 0;
    if (cid === null || !empty) {
      askedFor = null;
      return;
    }
    if (askedFor === cid) return;
    askedFor = cid;
    void loadChatHistory(cid).catch(() => {
      // Said out loud, and NOT tried again on its own.
      //
      // `askedFor` deliberately stays set. Re-arming it here made the next
      // re-run of this effect (any `$messages` mutation, any re-render) issue
      // the byte-identical request that had just failed — measured: the same
      // 34,665ms read fired twice against a 30,000ms timeout, both aborted,
      // and the second was guaranteed to fail the same way before it was
      // sent. An automatic identical retry is not a recovery strategy.
      //
      // The absence itself is stated by `chat-history-load.ts` and rendered
      // in place below, with a verb the reader can press. The hint is the
      // transient half of the same statement, for a reader whose eyes are
      // elsewhere in the shell.
      shell?.hint("could not read this conversation — what is on screen may be incomplete");
    });
  });

  /**
   * THE WAY FORWARD, as a gesture rather than a loop. Clears the arm so the
   * effect above may ask again, and asks once.
   */
  function readAgain(): void {
    const cid = chatId;
    if (cid === null) return;
    askedFor = cid;
    void loadChatHistory(cid).catch(() => {
      shell?.hint("could not read this conversation — what is on screen may be incomplete");
    });
  }

  // ── The reactive window — the ONLY reactive projection of the log ────────

  type WindowItem = Readonly<{
    beat: Beat;
    index: number;
    offset: number;
    fisheye: FisheyeResult;
    onChain: boolean;
    /** Where this beat sits in its batch of consecutive tool calls, when it
     * is in one at all (grouping.ts owns the rule). */
    group?: GroupPlace;
  }>;

  const focusContext = $derived.by(() => {
    version;
    layoutVersion;
    // NO SUBSTITUTE FOR A FOCUS. Falling back to `lastBeat()` here pinned the
    // fisheye to the tail of the log, which collapses `causalDistance` and
    // `recency` into one number and turns the DOI into an age ramp — every
    // beat past the third-newest turn compressed before the reader had
    // touched anything. `null` says what is true: nothing is focused. The
    // fisheye then compresses nothing, and starts compressing the moment the
    // reader focuses a beat.
    const focus = focusedId !== null ? beatById(focusedId) : undefined;
    const chain = focus !== undefined ? new Set(causalChainOf(focus.id)) : new Set<string>();
    const latest = lastBeat();
    return {
      focusTurnIndex: focus?.turnIndex ?? null,
      chain,
      latestTurnIndex: latest?.turnIndex ?? 0,
    };
  });

  /**
   * THE FLOW AT THE PLANTED HEAD (§6.2).
   *
   * The sweep plants a head and the banner says the screen is showing an
   * earlier instant. Until now the FLOW ignored it: the rendered text was
   * byte-identical with and without a head, which made the banner a caption
   * on the wrong picture — the exact class of lie the recorder exists to
   * eliminate. Beats already carry a measured `at`, so honouring the head
   * needs no new data, only this bound: the flow renders the prefix of the
   * log whose facts had already happened.
   *
   * `heights` is NOT truncated — the measurements for the hidden tail are
   * still correct and returning to live must not have to re-measure them.
   * Only the WINDOW and the scroll height are bounded, which is why the
   * spacer below uses `offsetOf(n)` rather than `totalHeight()`.
   */
  const visibleCount = $derived.by(() => {
    version;
    const head = $asOfHead;
    return head === null ? beatCount() : beatsAtOrBefore(head);
  });

  /**
   * WHAT THE HEAD ROW SAYS — one of five, and never inferred from a count.
   *
   * `unknown` is the honest answer while no reach has been recorded for this
   * conversation (a harness mount that drives the log by hand, a workspace
   * whose beats are warm but whose page facts were never fetched). It renders
   * nothing: an empty row is not a claim, and claiming "the beginning" for a
   * conversation nobody asked the server about would be exactly the
   * fabricated absence this row exists to prevent.
   */
  const headState = $derived.by<"unknown" | "loading" | "failed" | "older" | "beginning">(() => {
    const reach = $historyReach;
    if (reach === null || (chatId !== null && reach.chatId !== chatId)) return "unknown";
    if (reach.loading) return "loading";
    if (reach.failure !== null) return "failed";
    return reach.hasOlder ? "older" : "beginning";
  });

  /**
   * HOW MANY EARLIER MESSAGES ARE NOT LOADED — a measured difference, or the
   * word "more" when it cannot be measured.
   *
   * `messageCount` is the server's COUNT of message rows; `loaded` is how many
   * of them this session received. The transcript also carries rows that were
   * never messages (inline events reconstructed from timeline refs), so the
   * subtraction can come out at or below zero while older messages genuinely
   * exist — `hasOlder` is the authority on WHETHER, and this is only the
   * quantity. When the two disagree, the quantity is dropped rather than
   * printed as a number nobody measured.
   */
  const earlierCount = $derived.by<string>(() => {
    const reach = $historyReach;
    if (reach === null) return "more";
    const remaining = reach.messageCount - reach.loaded;
    return remaining > 0 ? remaining.toLocaleString() : "more";
  });

  /** Is the log on screen one whose beats the memory budget released? */
  const reloading = $derived.by(() => {
    version;
    return logIsReloading();
  });

  /**
   * DID THE READ LAND? (DESIGN-PERFORMANCE §1 L3.)
   *
   * Non-null only when a history read for THIS conversation failed. It is the
   * difference between "there is nothing recorded" and "I could not reach
   * it", which the beat count alone cannot express — and rendering the first
   * when the second is true is a fabricated absence, the failure this whole
   * product exists to prevent.
   */
  const unread = $derived.by(() => {
    const load = $chatHistoryLoad;
    if (load === null || load.kind !== "absent") return null;
    if (chatId !== null && load.chatId !== chatId) return null;
    return load;
  });

  /**
   * WHICH LOG THE ROWS ON SCREEN BELONG TO — read from the LOG, not from the
   * workspace atom.
   *
   * The two can legitimately disagree: a harness mount ingests nothing, so
   * the displayed log stays the default one while the page still has an
   * active workspace. Measurements must follow what is DRAWN, and what is
   * drawn is the displayed log — taking the atom instead filed every
   * measurement under a workspace whose beats were not on screen.
   *
   * `activateLog` bumps the version, so this re-derives on exactly the event
   * that changes the answer.
   */
  const logId = $derived.by(() => {
    version;
    return displayedLogId();
  });

  const win = $derived.by<{ items: readonly WindowItem[]; total: number }>(() => {
    version;
    layoutVersion;
    const n = visibleCount;
    if (n === 0) return { items: [], total: 0 };
    // Scroll pixels → index offsets (see `headHeight`).
    const top = scrollTop - HISTORY_HEAD_H;
    const start = Math.max(0, heights.indexAtOffset(top) - OVERSCAN);
    const end = Math.min(n, heights.indexAtOffset(top + viewportH) + 1 + OVERSCAN);
    const slice = windowSlice(start, end);
    // BATCH BOUNDARIES ARE COMPUTED OVER A WIDENED SLICE, never over the
    // viewport. A group's edges depend on the beats on either side of it, so
    // grouping only what is on screen would split one batch in two whenever
    // the viewport happened to cut through it — and the split would move as
    // you scrolled. The window is already overscanned; this widens it further
    // by a batch's worth so both edges are decided from real neighbours.
    const gStart = Math.max(0, start - GROUP_LOOKAROUND);
    const gEnd = Math.min(n, end + GROUP_LOOKAROUND);
    const places = groupPlacements(windowSlice(gStart, gEnd));
    const { focusTurnIndex, chain, latestTurnIndex } = focusContext;
    const items: WindowItem[] = slice.map((beat, k) => {
      const index = start + k;
      const onChain = chain.has(beat.id);
      const override = overrideFor(beat.id);
      const group = places.get(beat.id);
      return {
        beat,
        index,
        offset: heights.offsetOf(index),
        onChain,
        ...(group !== undefined ? { group } : {}),
        fisheye: fisheyeLevel({
          beat,
          focusTurnIndex,
          onFocusChain: onChain,
          latestTurnIndex,
          ...(override !== undefined ? { override } : {}),
        }),
      };
    });
    return { items, total: heights.offsetOf(n) };
  });

  // ── The bead position: the beat doing work RIGHT NOW (§11.2) ─────────────

  const beadTarget = $derived.by<{ offset: number; height: number } | null>(() => {
    version;
    layoutVersion;
    if (!$isStreaming) return null;
    const n = beatCount();
    const tailStart = Math.max(0, n - 30);
    const tail = windowSlice(tailStart, n);
    for (let k = tail.length - 1; k >= 0; k -= 1) {
      const b = tail[k]!;
      const live =
        (b.kind === "turn" && b.turn?.streaming === true) ||
        (b.kind === "tool" && b.tool?.status === "running");
      if (live) {
        const index = tailStart + k;
        return { offset: heights.offsetOf(index), height: heights.heightOf(index) };
      }
    }
    const last = n - 1;
    if (last < 0) return null;
    return { offset: heights.offsetOf(last), height: heights.heightOf(last) };
  });

  /**
   * IS THE WAIT INSTRUMENT HOMELESS RIGHT NOW?
   *
   * The rail's permanent home is the streaming model turn's footer. That turn
   * does not exist as a beat until the transcript appends the assistant
   * message, which happens on the first model event — so the first three
   * milestones of a send have nowhere to render. While that is true, and only
   * while it is true, the flow lends the instrument a row at its tail.
   *
   * The test is on the LOG, not on the stage: "does a streaming turn exist
   * yet" is the exact question, and asking the stage instead would guess at
   * the answer (a milestone and the beat it produces are not the same event,
   * and a reload mid-run has milestones it never observed).
   */
  const showWaitLine = $derived.by<boolean>(() => {
    version;
    // A SEND IS OUTSTANDING — not "a milestone has been reached". The two
    // used to be the same test, because the first milestone fired on the
    // line after the send. That milestone is gone (wait-stage.ts records
    // why), and gating on the stage would now leave the whole pre-acceptance
    // window unreported — which is precisely the window a hung `startRun`
    // lives in, and the one the reader most needs a clock for.
    // …or the send ENDED WITHOUT A RUN (refused/failed): the row stays to
    // state the outcome — a refusal that vanished with the clock would be a
    // run that silently never happened.
    if ($waitStartedAt === null && $waitEnd === null) return false;
    // THE ANSWER HAS BEGUN — the row's subject is over. The wait covers
    // send → first character; from the first character the instrument's
    // home is the model turn's own beat (its rail while streaming, its
    // committed text after). Without this arm the row came BACK the moment
    // the turn settled — "the model is answering · 3 of 3" ticking over a
    // message that had already finished, for as long as end-of-run work
    // kept the run (and so the stage, which is advance-only) open.
    //
    // The stage is checked rather than only the log because the two know
    // different halves: a turn can stream more beats than the tail window
    // below sees (the stage still says answering), and a reload mid-run
    // loses every milestone the session observed while the turn keeps
    // streaming (the log still shows it). Either fact alone re-opens the
    // stale row; together they close it.
    if ($waitStage === "answering") return false;
    const n = beatCount();
    for (const b of windowSlice(Math.max(0, n - 8), n)) {
      if (b.kind === "turn" && b.turn?.streaming === true) return false;
    }
    return true;
  });

  // ── Measurement: ResizeObserver writes real heights into the index ───────

  /**
   * THE SHAPE A BEAT IS CURRENTLY DRAWN AS — the stamp its measured height is
   * only valid for.
   *
   * A beat does not have "a height"; it has a height AT A SHAPE. The same
   * tool call is a card at `full`, a line at `ghost`, a mark at `tick`, and
   * NOTHING at all when the flow declines to draw it. Anything that changes
   * which of those is on screen must appear in this string, or the index will
   * keep reserving the height of a shape that is no longer rendered.
   */
  function shapeOf(item: WindowItem): string {
    if (!rendersInFlow(item.beat)) return "none";
    const level = renderedLevel(item.beat.kind, item.fisheye.level);
    // The batch cap is real pixels drawn by the first member only.
    const cap = item.group?.first === true ? "+cap" : "";
    // An expanded card is a different shape from a folded one at the same
    // level; the ResizeObserver would catch it, but only a frame later.
    const open = level === "full" && (expanded[item.beat.id] ?? false) ? "+open" : "";
    // ── THE THINKING BLOCK IS A SECOND, INDEPENDENT AXIS ───────────────────
    //
    // A model turn's thinking block opens and closes on its own rule
    // (thinking-fold.ts) — a rule that has nothing to do with the fisheye
    // LEVEL above, and deliberately so: the fisheye pins every turn to `full`,
    // so `level` never moves for a turn and could never carry this. The two
    // axes are kept apart everywhere except HERE, where they must both appear,
    // because both change how many pixels the row paints and the stamp's whole
    // job is to name the shape a recorded height was measured for.
    //
    // Without this term the auto-collapse at the first answer token would leave
    // the index reserving the OPEN block's height until a ResizeObserver
    // callback happened to land — the same class of stale reservation that put
    // 224px of phantom space under folded rows.
    void $thinkingFoldVersion;
    const think =
      thinkingState(item.beat) === "absent" ? "" : thinkingOpen(item.beat) ? "+think" : "+nothink";
    return `${level}${cap}${open}${think}`;
  }

  /**
   * Declare the height a shape is worth BEFORE anything measures it, and
   * invalidate whatever the index was holding for the previous shape.
   *
   * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
   *
   * Without it the index's only writer is the ResizeObserver, which means a
   * beat that changes shape reserves its OLD shape's height until an RO
   * callback lands — and for the one shape that draws nothing, forever,
   * because a caller that ignores zero readings never hears about it.
   *
   * `none` is the case that shipped as the visible defect: a beat the flow
   * deliberately does not draw is still an `.item` in the index, and it sat
   * there holding the 56px estimate. The reader saw a column of one-line
   * beats separated by tall empty gaps with a broken causal spine — the
   * index and the render disagreeing, in pixels.
   *
   * Same pattern as the artifact frame (render/artifact.ts), and for the same
   * reason: DECLARE the box from what the thing IS, never derive it from what
   * happens to be inside it, so the height index cannot be corrupted after
   * measurement.
   */
  function declareShape(idx: HeightIndex, index: number, shape: string): void {
    if (idx.stampOf(index) === shape) return;
    const base = shape.startsWith("full") ? SHAPE_HEIGHT["full"]! : (SHAPE_HEIGHT[shape.split("+")[0]!] ?? DEFAULT_ESTIMATE);
    holdReadingPosition();
    idx.update(index, base, shape);
    // DEBUG-PROBE
    layoutVersion += 1;
  }

  /**
   * ── HOLDING THE READER'S PLACE ACROSS A HEIGHT CHANGE THEY DID NOT MAKE ──
   *
   * Same job as `shell/flow-anchor.ts` does for the workspace strip, and the
   * same reason: something other than the reader changed how tall the content
   * is, and a browser keeps `scrollTop` through that, so the words under their
   * eyes move. The difference is WHICH invariant is held. The strip changes the
   * VIEWPORT, so distance-from-bottom is the right thing to preserve. Here the
   * CONTENT changes, at one known row, so the right thing to preserve is the
   * ANCHORED BEAT: the beat under the top of the viewport, and how far into it
   * the reader is. Distance-from-bottom would be actively wrong for a shrink
   * below the reading position — it would drag them down by exactly the amount
   * that was removed from underneath them.
   *
   * THE CASE THIS EXISTS FOR, precisely. When a thinking block auto-collapses,
   * the row is re-declared at the un-measured estimate first and only reaches
   * its true collapsed height when the ResizeObserver lands a frame later. For
   * that one frame the document is much shorter than it will settle at — and if
   * the reader is scrolled up but not far up, the browser CLAMPS `scrollTop` to
   * the transiently-short document. The clamp is not undone when the height
   * comes back, so a transient over-shrink becomes a permanent jump. Holding
   * the anchor across the round trip is what makes the collapse cost the reader
   * nothing.
   *
   * NOT WHEN FOLLOWING. A reader at the tail asked to be at the tail; the
   * existing `scrollToEnd` owns them, and two owners for one scroll position is
   * how a fight starts.
   */
  let anchorHeld = false;
  function holdReadingPosition(): void {
    // A prepend absorption owns the scroll position until it lands; see
    // `prependPending`. Holding here as well would restore an anchor
    // captured against a half-applied geometry.
    if (container === undefined || container === null || follow || anchorHeld || prependPending) return;
    const el = container;
    const head = headHeight();
    // ── THE READER ON THE HEAD ROW IS NOT ANCHORED TO A BEAT ────────────────
    //
    // Above the first beat there is only the head row, whose height is
    // DECLARED and therefore cannot change. Anchoring anyway clamps the
    // index-space offset to 0, resolves to beat 0, and restores to
    // `offsetOf(0) + 0 + head` — which scrolls the head row off the top by
    // exactly its own height. Observed in the browser: scrolling to 0 landed
    // at 34, and "the beginning of this conversation" was pushed out of view
    // the moment it became true.
    if (el.scrollTop <= head) return;
    const top = el.scrollTop - head;
    const index = heights.indexAtOffset(top);
    // Where the reader is INSIDE the anchored beat. Held separately from the
    // beat's offset so a beat that itself changes height keeps its top edge
    // under the same pixel row rather than sliding by its own delta.
    const into = top - heights.offsetOf(index);
    const idx = heights;
    anchorHeld = true;
    void tick().then(() => {
      anchorHeld = false;
      // The reader may have taken over in the meantime (a scroll flips
      // `follow`, a workspace switch swaps the index). Their action wins.
      if (container === undefined || container === null || follow || heights !== idx) return;
      const next = Math.max(0, idx.offsetOf(index) + into + headHeight());
      if (Math.abs(next - container.scrollTop) < 0.5) return;
      container.scrollTop = next;
      scrollTop = container.scrollTop;
    });
  }

  /**
   * ── A MEASUREMENT BELONGS TO THE WORKSPACE THAT DREW IT ─────────────────
   *
   * The row carries the workspace it was rendered for, and every write — the
   * shape declaration and the observer's reading alike — is ADDRESSED to that
   * workspace's index. Addressing is the whole guard: there is no shared
   * index left to leak into, so a reading can only ever land where it is
   * true.
   *
   * It has to be the row's own `ws` and not "whatever is on screen now",
   * because a ResizeObserver callback is delivered asynchronously: a row
   * measured while A was up can fire after the switch to B, and filing that
   * reading against B would lay B's rows out at A's pixel heights.
   *
   * A row that OUTLIVES a switch (two tabs on the same conversation share
   * beat ids, so the keyed `{#each}` re-uses it) re-declares its shape into
   * the incoming workspace's index the moment `ws` changes — see `update`.
   * It never carries the outgoing workspace's recorded height across.
   */
  function measure(
    node: HTMLElement,
    params: { index: number; shape: string; ws: string },
  ): { update: (p: { index: number; shape: string; ws: string }) => void; destroy: () => void } {
    let current = params.index;
    let shape = params.shape;
    let ws = params.ws;
    declareShape(heightsFor(ws), current, shape);
    const ro = new ResizeObserver((entries) => {
      const idx = heightsFor(ws);
      for (const entry of entries) {
        const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        // ZERO IS A MEASUREMENT.
        //
        // This used to read `if (h > 0 && …)`, and that gate is the reported
        // defect's true cause. A beat the flow deliberately draws NOTHING for
        // — a model turn that acted without speaking — measures 0 and IS 0.
        // The observer fired for those rows (verified in the page:
        // `{blockSize: 0, contentRect: 0}`); the gate threw the reading away,
        // so the index went on reserving the un-measured 56px estimate for a
        // row that paints no pixels, forever. It was the one measurement the
        // index could never receive and therefore the one it could never fix,
        // and at four folded rows in a row that is 224px of nothing with the
        // causal spine broken across it.
        //
        // The reading is recorded unconditionally and STAMPED with the shape
        // it measured, so it can never be mistaken later for a different
        // shape's height. Only a change worth re-laying-out bumps the layout
        // version.
        const changed = Math.abs(idx.heightOf(current) - h) > 0.5;
        // The other half of the collapse round trip: the declaration above put
        // the row at an estimate, and THIS is the reading that corrects it. A
        // reader who is not following must come out of both changes on the same
        // words (see `holdReadingPosition`).
        if (changed && !follow) holdReadingPosition();
        idx.update(current, h, shape);
        if (changed) {
          layoutVersion += 1;
          if (follow) queueMicrotask(scrollToEnd);
        }
      }
    });
    ro.observe(node);
    return {
      update(p: { index: number; shape: string; ws: string }) {
        current = p.index;
        const movedWorkspace = p.ws !== ws;
        ws = p.ws;
        if (movedWorkspace || p.shape !== shape) {
          shape = p.shape;
          // The row's shape changed under us: drop the old shape's
          // measurement now rather than reserving it until the observer
          // catches up. A row re-used by another workspace declares its shape
          // into THAT workspace's index, never carrying the previous one's
          // recorded height across.
          declareShape(heightsFor(ws), current, shape);
        }
      },
      destroy() {
        ro.disconnect();
      },
    };
  }

  function viewport(node: HTMLElement): { destroy: () => void } {
    viewportH = node.clientHeight;
    const ro = new ResizeObserver(() => {
      viewportH = node.clientHeight;
    });
    ro.observe(node);
    return { destroy: () => ro.disconnect() };
  }

  // ── Keyboard: roving focus in causal (log) order (§2.7) ──────────────────

  /**
   * Scroll beat `index` just far enough to be wholly on screen.
   *
   * This was CALLED by `moveFocus` and never defined — an unresolved
   * identifier, which the Svelte compiler happily emits as a bare global
   * reference and `tsc` never sees (it does not typecheck component scripts),
   * so every ↑/↓ and every ▲▼ grip threw a ReferenceError at runtime and the
   * roving focus stopped at the edge of the rendered window.
   *
   * Written off the HEIGHT INDEX rather than off `scrollIntoView`: the target
   * row may not be mounted yet (that is the whole point of a virtualizer),
   * and the index already knows exactly where it will be. Nearest-edge, so
   * stepping through neighbours never jumps the reading position.
   */
  function revealIndex(index: number, smooth = false): void {
    if (container === undefined || container === null) return;
    // Index offsets → scroll pixels (see `headHeight`).
    const top = heights.offsetOf(index) + headHeight();
    const bottom = top + heights.heightOf(index);
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    let next: number | null = null;
    if (top < viewTop) next = top;
    else if (bottom > viewBottom) next = bottom - container.clientHeight;
    if (next === null) return;
    // "Butter smooth" for a SCRUB, instant for everything else — and always
    // instant under reduced motion, where travel is the thing being removed.
    const reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (smooth && !reduce) container.scrollTo({ top: next, behavior: "smooth" });
    else container.scrollTop = next;
  }

  /**
   * A scrub navigation, COALESCED TO ONE FRAME.
   *
   * The sweep can emit as the pointer drags. Each of these focuses a beat and
   * scrolls, and doing that per event would thrash layout for frames the user
   * never sees. Only the LAST request in a frame is acted on — which is also
   * the only one that is still true by the time the frame paints.
   */
  let pendingScrubIndex: number | null = null;
  let scrubFrame = 0;
  let pendingScrubPreview = false;
  function scrubTo(index: number, preview = false): void {
    pendingScrubIndex = index;
    pendingScrubPreview = preview;
    if (scrubFrame !== 0) return;
    scrubFrame = requestAnimationFrame(() => {
      scrubFrame = 0;
      const target = pendingScrubIndex;
      const asPreview = pendingScrubPreview;
      pendingScrubIndex = null;
      if (target === null || target < 0) return;
      const beat = windowSlice(target, target + 1)[0];
      if (beat === undefined) return;
      // A PREVIEW reveals without committing: a pointer merely passing over
      // the sweep shows you the moment it is over, but does not move the
      // reader's own place in the log. Only a deliberate act (click, key,
      // scrub) takes focus.
      if (!asPreview) {
        focusedId = beat.id;
        follow = false;
      }
      revealIndex(target, true);
    });
  }

  function moveFocus(delta: 1 | -1): void {
    // Bounded by the planted head, not by the log: during a past view the
    // beats after the head are not on screen, and stepping onto one would
    // focus a fact the view is claiming has not happened yet.
    const n = visibleCount;
    if (n === 0) return;
    const currentIndex = focusedId !== null ? indexOfBeat(focusedId) : n - 1;
    // A beat the flow does not DRAW cannot be focused: a hidden empty turn
    // occupies no row, so stepping onto it would read as a dead keypress
    // (beat-state.ts `rendersInFlow` is the one owner of that decision).
    let next = Math.max(0, Math.min(n - 1, currentIndex + delta));
    while (next > 0 && next < n - 1) {
      const candidate = windowSlice(next, next + 1)[0];
      if (candidate === undefined || rendersInFlow(candidate)) break;
      next += delta;
    }
    const beat = windowSlice(next, next + 1)[0];
    if (beat !== undefined && rendersInFlow(beat)) {
      focusedId = beat.id;
      follow = $asOfHead === null && next === n - 1;
      revealIndex(next);
    }
  }

  function overrideFocused(value: "expand" | "collapse"): void {
    if (focusedId === null) return;
    overrideBeat(focusedId, value);
  }

  /** The fisheye override for ONE beat — the ← → chords route here through
   * the focused id; the beat's expand/collapse grips route here directly.
   * One implementation, so the click and the chord cannot diverge. */
  function overrideBeat(id: string, value: "expand" | "collapse"): void {
    setOverride(id, value);
    layoutVersion += 1;
  }

  /**
   * ⏎ ON THE FOCUSED BEAT — "open this fact", routed to the surface that
   * kind actually opens into.
   *
   * THE USER'S RULING, VERBATIM, said three times: "when clicking on a tool,
   * it shows up on the right side on top of expanding in the chat, I just
   * want expanding in the chat", then "sometimes when clicking around the
   * tool open on the right side, I don't want that", then "scope also opens
   * on a right menu."
   *
   * So for a TOOL BEAT nothing opens a right-hand sheet — not the grip, not
   * the menu (deleted), and not this chord. The chord is not silently dropped
   * either (§ the routing law: a pressed grammar chord never does nothing):
   * it opens the same depth the body click opens, in place. Everything the
   * sheet used to add for a tool call now renders under the open card
   * (BeatDepth.svelte), so the depth is moved rather than lost.
   *
   * `opensScopeSheet` (beat-state.ts) is the ONE owner of which kinds have a
   * sheet, and the beat's own row reads it too — so the grip cannot exist for
   * a kind this branch refuses, and vice versa.
   */
  function openFocused(): void {
    if (focusedId === null) return;
    const beat = beatById(focusedId);
    if (beat === undefined) return;
    if (!opensScopeSheet(beat.kind)) {
      expandBeat(focusedId);
      return;
    }
    openBeat(focusedId);
  }

  /**
   * Focus a beat and EXPAND IT IN PLACE — the body click of a card that has
   * inline depth, and nothing else.
   *
   * THE USER'S CORRECTION, VERBATIM: "when clicking on a tool, it shows up on
   * the right side on top of expanding in the chat, I just want expanding in
   * the chat." A body click used to land in `openBeat` below, which both
   * unfolded the card AND threw the SCOPE sheet open on the right — two
   * surfaces from one gesture. The two outcomes now have two entry points and
   * neither performs the other's job.
   */
  function expandBeat(id: string): void {
    if (beatById(id) === undefined) return;
    focusedId = id;
    toggleExpandById(id);
  }

  /** FOLLOW THE CAUSAL CHAIN — focus a beat and bring it into view. One
   * implementation, used by the SCOPE sheet's causal reference and by the
   * open card's inline depth, so the two cannot behave differently. */
  function focusAndReveal(id: string): void {
    focusedId = id;
    follow = false;
    const index = indexOfBeat(id);
    if (index >= 0) revealIndex(index);
  }

  /** Focus a beat and open its SCOPE — the `scope` grip, and ⏎ for the kinds
   * that still have a sheet (`openFocused` above). Deliberately NOT the body
   * click (see `expandBeat`), and deliberately no longer a second job stapled
   * to it: asking for the sheet opens the sheet, and does not also re-fold
   * the card underneath it. */
  function openBeat(id: string): void {
    const beat = beatById(id);
    if (beat === undefined) return;
    focusedId = id;
    if (shell !== null) {
      shell.openScope({
        // The cap says WHAT THIS IS in plain words, once. It used to read
        // `turn · turn 4` — internal vocabulary, twice, above a sheet that
        // said it twice more.
        title: beatNoun(beat),
        component: BeatScope,
        props: {
          beat,
          projectPath,
          // The causal reference is a click path back into the flow, so the
          // chain can actually be followed from the sheet.
          onfocusbeat: focusAndReveal,
        },
      });
    }
    onOpen?.(beat);
  }

  /*
   * ── THE `⋯` VERB MENU IS GONE ────────────────────────────────────────────
   *
   * THE USER'S RULING, VERBATIM: "the '...' menu under the message is also
   * useless, all options already showing as buttons."
   *
   * They are right, entry by entry. The menu held five things and every one
   * of them was reachable without it:
   *
   *   focus the fact before / after this one — the mouse path for "focus a
   *     beat" is CLICKING THAT BEAT. More direct than a menu entry, already
   *     discoverable, and needing no knowledge of a grammar. (These rows were
   *     added when the ▲▼ stepper was removed from the options row; the
   *     removal was right, the menu was the wrong place to put the path.)
   *   open scope — the `scope` grip, in the options row, on every kind that
   *     still has a sheet.
   *   expand / collapse — the grip beside it, on every kind the fisheye
   *     actually compresses.
   *   the beat's verbs — the options row already renders every WIRED one; the
   *     refusing ones keep their full reason in the SCOPE sheet, and for a
   *     tool beat (which no longer has one) under the open card itself.
   *
   * Right-click therefore goes back to the browser's own menu, which is what
   * a reader selecting text out of a tool's output actually wants, and the
   * `.` chord is retired with the surface it opened rather than left pressing
   * into nothing.
   */

  function returnToNow(): void {
    focusedId = null;
    follow = true;
    scrollToEnd();
  }

  /**
   * PLANTING THE HEAD SCROLLS THE FLOW TO THE CONTAINING BEAT (§6.2).
   *
   * The bound above decides WHAT is on screen; this decides where the eye
   * lands. The containing beat is the last one whose fact had happened at
   * the planted instant — `visibleCount - 1` by construction — and it is
   * focused as well as revealed, so the fisheye expands around the moment
   * the user asked about instead of around the tail of the log.
   *
   * Following is switched OFF while a head stands: the flow must not chase
   * new beats into a view that is claiming to show an earlier instant.
   * Returning to live restores the live behaviour and the tail.
   */
  /**
   * ONLY A MOVE OF THE HEAD IS A MOVE OF THE HEAD.
   *
   * This used to re-run on any change to `visibleCount`, and returning to the
   * live view is written as "follow the tail again, scroll to the end". A
   * WORKSPACE SWITCH changes `visibleCount` (a different log, a different
   * number of beats) without touching the head at all — so every tab click
   * ran the return-to-live branch and threw the incoming tab back to the
   * bottom of its conversation, one microtask after its remembered offset had
   * been restored. Measured in the browser: 620px restored, 1691px on screen.
   *
   * The head is now compared against the last one this effect acted on, so
   * `visibleCount` is read only on the runs that need it.
   */
  let lastHead: number | null | undefined = undefined;
  $effect(() => {
    const head = $asOfHead;
    if (head === lastHead) return;
    lastHead = head;
    const n = visibleCount;
    if (head === null) {
      follow = true;
      queueMicrotask(scrollToEnd);
      return;
    }
    follow = false;
    if (n === 0) return;
    const beat = windowSlice(n - 1, n)[0];
    if (beat === undefined) return;
    focusedId = beat.id;
    queueMicrotask(() => revealIndex(n - 1));
  });

  /**
   * THE SWEEP'S SCRUB → THE FLOW FOLLOWS (§6.3).
   *
   * The sweep dispatches a bubbling `focusBeat` CustomEvent when it hands off
   * at its deepest zoom (a tick click, or Enter on the head). Nothing listened
   * for it, so the sweep moved and the chat sat still — reported by the user
   * as "timeline still not working, scrolling into it should get us back to
   * that matching chat section, should be butter smooth."
   *
   * TWO WAYS TO RESOLVE, in order, because the two id spaces do not always
   * meet. A sweep tick is addressed by a LEDGER EVENT id; a beat by its own
   * source record (`b-<messageId>`, `<toolBeat>-fx`, `cd-…`, `seam-…`). Where
   * one names the other the jump is exact, and that is tried first. Where it
   * does not, the two still share a CLOCK — every beat carries a measured
   * `at` — so the instant resolves to the beat that was happening then, which
   * is what a scrub is actually asking for.
   *
   * The detail is accepted in either shape the sweep may send: a bare id
   * string, or `{ eventId?, timeMs? }`. Building against both means this side
   * does not have to be rewritten when the sweep's contract lands.
   *
   * Navigation is coalesced to one animation frame (scrubTo) so a drag cannot
   * thrash layout, and the virtualizer is never re-measured — only scrolled.
   */
  $effect(() => {
    const host = container?.ownerDocument;
    if (host === undefined || host === null) return;
    const onFocusBeat = (ev: Event): void => {
      const detail = (ev as CustomEvent<unknown>).detail;
      // The published seam (`sweep/focus-seam.ts`, contract sweep.focusBeat/2).
      // Taking it explicitly lets the sweep retire its compatibility bridge:
      // that bridge goes quiet the moment we preventDefault, which its own
      // standing test asserts.
      if (
        detail !== null &&
        typeof detail === "object" &&
        (detail as FocusBeatDetail).contract === FOCUS_BEAT_CONTRACT
      ) {
        const f = detail as FocusBeatDetail;
        ev.preventDefault();
        // A planted head caps the answer: time travel must never scroll the
        // reader to a beat that had not happened at the instant on screen.
        const cap = f.headMs === null ? f.timeMs : Math.min(f.timeMs, f.headMs);
        const byId =
          f.eventId !== null ? (beatById(f.eventId) ?? beatById(`b-${f.eventId}`)) : undefined;
        const index =
          byId !== undefined && byId.at <= cap ? indexOfBeat(byId.id) : beatIndexAt(cap);
        if (index < 0) {
          // Silent on a preview: a pointer sweeping past empty stretches must
          // not chatter hints at the reader.
          if (!f.preview) {
            shell?.hint("nothing was recorded in this conversation at that moment");
          }
          return;
        }
        scrubTo(index, f.preview);
        return;
      }
      const eventId =
        typeof detail === "string"
          ? detail
          : typeof (detail as { eventId?: unknown })?.eventId === "string"
            ? (detail as { eventId: string }).eventId
            : null;
      const timeMs =
        typeof (detail as { timeMs?: unknown })?.timeMs === "number"
          ? (detail as { timeMs: number }).timeMs
          : null;

      if (eventId !== null) {
        const beat = beatById(eventId) ?? beatById(`b-${eventId}`);
        if (beat !== undefined) {
          scrubTo(indexOfBeat(beat.id));
          return;
        }
      }
      if (timeMs !== null) {
        const index = beatIndexAt(timeMs);
        if (index >= 0) {
          scrubTo(index);
          return;
        }
        shell?.hint("nothing was recorded in this conversation at that moment");
        return;
      }
      // An id that names nothing we hold, and no instant to fall back on.
      // Said out loud rather than scrolled to the nearest plausible beat: a
      // confident jump to the wrong place is indistinguishable, to the
      // reader, from the jump working.
      shell?.hint(
        "the sweep points at a recorded event this conversation's beats do not carry — nothing to jump to",
      );
    };
    host.addEventListener("focusBeat", onFocusBeat);
    return () => host.removeEventListener("focusBeat", onFocusBeat);
  });

  // ── THE RIGHT MENU'S ROW PATHS (flow/beat-request.ts) ──
  //
  // A turn row asks for its beat's SCOPE (the same `openBeat` the scope
  // grip and ⏎ run); a call row asks for a REVEAL (focus + scroll + the
  // inline depth unfolded — the tool beats are sheetless by the beat-state
  // ruling, so the inline depth IS the deep surface). An id that names
  // nothing we hold is said out loud, never scrolled to a guess.
  $effect(() => {
    const req = $pendingBeatRequest;
    if (req === null) return;
    consumeBeatRequest();
    const beat = beatById(req.id) ?? beatById(`b-${req.id}`);
    if (beat === undefined) {
      shell?.hint("that fact is not in this conversation's beats — nothing to jump to");
      return;
    }
    if (req.want === "scope") {
      openBeat(beat.id);
      return;
    }
    focusAndReveal(beat.id);
    // `untrack` keeps the read of `expanded` out of this effect's
    // dependencies — the write below would otherwise re-schedule the very
    // effect that performed it (the read+write self-dependency shape).
    if (!untrack(() => expanded[beat.id] ?? false)) {
      expanded = { ...expanded, [beat.id]: true };
    }
  });

  function onKeydown(e: KeyboardEvent): void {
    // Standalone-mode bindings; under the shell the same handlers arrive
    // via claimKey and the shell's global listener.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      overrideFocused("expand");
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      overrideFocused("collapse");
    } else if (e.key === "Enter") {
      e.preventDefault();
      openFocused();
    } else if (e.key === "Escape") {
      // Standalone only. The flow no longer opens a nested surface of its own
      // (the `⋯` menu is gone), so Esc has exactly one rung here.
      returnToNow();
    }
  }

  // ── Shell claims: keys + composer grammars ───────────────────────────────

  $effect(() => {
    if (shell === null) return;
    const s = shell;
    const owner = { owner: "the FLOW" };
    const unclaims = [
      s.claimKey("focus-next", () => moveFocus(1), owner),
      s.claimKey("focus-prev", () => moveFocus(-1), owner),
      s.claimKey("expand", () => overrideFocused("expand"), owner),
      s.claimKey("collapse", () => overrideFocused("collapse"), owner),
      s.claimKey("open-scope", () => openFocused(), owner),
      s.onComposerSubmit((text) => {
        // THE BOX EMPTIES WHEN THE WORDS ARE RECORDED, not when the server
        // finishes accepting the run. `onCommitted` fires from inside
        // `beginCockpitRun` the instant `sendUserMessage` has written the
        // turn — which is also the instant the beat appears in the flow, so
        // the sentence is never on screen in two places at once. Waiting on
        // the resolved promise instead left it in both for as long as
        // `startRun` took, measured at five to ten seconds.
        let emptied = false;
        const empty = (): void => {
          if (emptied) return;
          emptied = true;
          // The clear takes EXACTLY the sent snapshot, so words typed into
          // the box during the commit window survive it (they were never
          // this send's to consume).
          s.clearComposer(text);
        };
        void routeComposerSubmission(text, {
          projectId,
          chatId,
          projectPath,
          onCommitted: empty,
        }).then((outcome) => {
          // The other two accepted grammars (`?` and `/`) write nothing to the
          // transcript, so they have no commit moment to hang this on and
          // still empty the box on their outcome.
          if (outcome.kind === "finding" || outcome.kind === "command") empty();
          // A refusal keeps the user's words for correction — the contract
          // the never-touched refusals (nothing typed, no project, a planted
          // head) hold by never emptying. A refusal that had already
          // committed (the raced-start 428: the words were recorded
          // optimistically, then the server declined the run) holds the SAME
          // contract from the other side: the optimistic beat was taken back
          // at the send's own door (run-stream.ts), so nothing consumed the
          // words and they go back in the box, ahead of anything typed in
          // the window. A FAILURE after the commit is different: the send
          // genuinely left (the words are in the flow as the record of what
          // was attempted), so those stay emptied.
          if (outcome.kind === "refused" && emptied) s.restoreComposerText(text);
          if (outcome.message.length > 0) s.hint(outcome.message);
        });
      }),
      s.onComposerChange((text) => {
        composerLive = text;
      }),
    ];
    return () => {
      for (const un of unclaims) un();
    };
  });

  /*
   * THE FLOW NO LONGER PUSHES A DISMISS LAYER. It used to, for the `⋯` beat
   * menu — a nested surface Esc had to close before "return to now". The menu
   * is gone (see the note above), so the flow opens nothing nested, and the
   * shell's dismissal ladder is left with one fewer rung rather than with a
   * rung that can never be entered. `shell/ScopeHost.svelte` and the rest of
   * the ladder are untouched: the SCOPE sheet still claims and releases its
   * own layer for the kinds that still open one.
   */

  // ── The desk-line slot (§4.3): findings + the live grammar menu dock
  // INTO the desk edge under the shell; standalone mounts keep the flow's
  // own bottom edge (the template below). ──
  const grammarMenu = $derived(grammarMenuFor(composerLive));

  $effect(() => {
    if (shell === null) return;
    const s = shell;
    const finding = $deskLine?.finding ?? null;
    const menu = grammarMenu;
    if (menu.length === 0 && finding === null) {
      s.setDeskLine(null);
      return;
    }
    s.setDeskLine({
      component: DeskLine,
      props: {
        menu,
        finding,
        onDismiss: () => dismissDeskLine(),
      },
    });
    return () => s.setDeskLine(null);
  });

  // Focus and expansion reach the reload mirror through ONE observer rather
  // than a `recordView()` sprinkled at each of the six places that move them
  // — a list that would go stale the first time a seventh is added.
  $effect(() => {
    focusedId;
    expanded;
    recordView();
  });

  /**
   * A TAIL PAGE SHORTER THAN THE VIEWPORT CANNOT BE SCROLLED, so the scroll
   * trigger can never fire and the reader would be stranded at the top of a
   * conversation that has thousands of earlier messages, with nothing but the
   * head row's verb.
   *
   * Asking again while that is true is a loop only in the sense that filling
   * a screen is: it stops the moment the content is taller than the viewport,
   * the moment a page is in flight, the moment one fails, and the moment the
   * server says there is nothing older — all four checked by
   * `reachBackwards` and the reach store, not here.
   */
  $effect(() => {
    const total = win.total;
    const vh = viewportH;
    if (total > 0 && total <= vh) reachBackwards();
  });

  function toggleExpandById(id: string): void {
    expanded = { ...expanded, [id]: !(expanded[id] ?? false) };
  }

  export { toggleExpandById as toggleExpand };
</script>

<div class="flow-host">
  <div
    class="flow"
    role="listbox"
    aria-label="the run — causal block stream"
    aria-activedescendant={focusedId !== null ? `beat-${focusedId}` : undefined}
    tabindex="0"
    bind:this={container}
    onscroll={onScroll}
    onkeydown={onKeydown}
    use:viewport
  >
    {#if win.total === 0}
      <!-- AN EVICTED LOG IS NOT AN EMPTY CONVERSATION, AND NEITHER IS AN
           UNREAD ONE. Three different facts render zero beats and they mean
           opposite things, so the surface asks which one this is rather than
           inferring from the count (§1.1: absence renders as absence, in
           plain words; DESIGN-PERFORMANCE §1 L3).

           The unread case is checked FIRST because it is the only one that
           would otherwise be reported as a measured emptiness. -->
      {#if unread !== null}
        <div class="stated unread">
          <!-- THROUGH THE GRAMMAR, and it decides the announcement too: a read
               that broke while someone was looking at it is news, so `failed`
               carries `role="alert"`. This block used to carry its own
               `role="status"`, which is the politer choice — the grammar's is
               deliberate and documented at its own door, and adopting the
               owner's decision is the point of coming through it. -->
          <Answer
            answer={failed(
              `could not read ${unread.title !== null ? `“${unread.title}”` : "this conversation"} — ${unread.reason}`,
            )}
          />
          <p class="said">
            its recorded beats are not on screen. This is not an empty
            conversation; it is one this session could not reach.
          </p>
          <button
            type="button"
            class="verb"
            data-verb-id="chat.history.read-again"
            onclick={readAgain}
          >Read it again</button>
        </div>
      {:else}
        <!-- TWO DIFFERENT FACTS, and they were one class and one ink. A
             conversation being re-read is a measurement IN FLIGHT and names
             its subject; a conversation with no beats is a measurement that
             CAME BACK EMPTY. The grammar keeps them apart. -->
        <div class="stated">
          {#if reloading}
            <Answer
              answer={pending(
                "reloading this conversation — its beats were released while you worked elsewhere",
              )}
            />
          {:else}
            <div use:moves={land}>
              <Answer answer={absent("nothing recorded in this conversation yet — say something below")} />
            </div>
          {/if}
        </div>
      {/if}
    {:else}
      <!-- THE HEAD ROW — which of two opposite facts is true about the top.
           "older messages not loaded yet" and "this is the beginning of the
           conversation" render as the same pixels (the list stops) and mean
           opposite things, so the surface states which one it is rather than
           letting the reader infer (§1.1, DESIGN-PERFORMANCE §1 L3). The
           `beginning` answer comes from the SERVER — a short page cut from
           one snapshot — never from comparing counts here.

           Fixed height (HISTORY_HEAD_H), one line, no wrap: the virtualizer
           adds this constant to every beat offset, so a row that grew taller
           than its declaration would put every beat below it out of place. -->
      <div class="history-head" style:height="{HISTORY_HEAD_H}px" role="status">
        {#if headState === "loading"}
          <span class="head-said">reading earlier messages…</span>
        {:else if headState === "failed"}
          <span class="head-said"
            >could not read earlier messages — {$historyReach?.failure}</span
          >
          <button
            type="button"
            class="verb"
            data-verb-id="chat.history.read-earlier"
            onclick={readEarlier}>Try again</button
          >
        {:else if headState === "older"}
          <span class="head-said">{earlierCount} earlier not loaded yet</span>
          <button
            type="button"
            class="verb"
            data-verb-id="chat.history.read-earlier"
            onclick={readEarlier}>Read earlier</button
          >
        {:else if headState === "beginning"}
          <span class="head-said">the beginning of this conversation</span>
        {/if}
      </div>
      <div class="spacer" style:height="{win.total}px">
        <Bead target={beadTarget} />
        {#each win.items as item (item.beat.id)}
          <div
            class="item"
            style:transform="translateY({item.offset}px)"
            use:measure={{ index: item.index, shape: shapeOf(item), ws: logId }}
          >
            <BeatView
              beat={item.beat}
              fisheye={item.fisheye}
              focused={focusedId === item.beat.id}
              onChain={item.onChain}
              group={item.group ?? null}
              expanded={expanded[item.beat.id] ?? false}
              {projectPath}
              onfocusbeat={(id) => {
                focusedId = id;
                follow = indexOfBeat(id) === beatCount() - 1;
              }}
              onoverridebeat={overrideBeat}
              onopenbeat={openBeat}
              onexpandbeat={expandBeat}
              onfocuscause={focusAndReveal}
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- THE WAIT LINE. Present only while a send has been made and the reply
       has no row of its own yet; the instant that row exists, the rail
       continues in its footer from the cell it had reached (WaitLine.svelte
       states the whole arrangement). Fixed height, outside the virtualized
       spacer, so it can shift nothing and be measured by nothing. -->
  {#if showWaitLine}
    <WaitLine stage={$waitStage} startedAt={$waitStartedAt} end={$waitEnd} />
  {/if}

  {#if shell === null && $deskLine !== null}
    <!-- Standalone fallback only: under the shell the finding docks into
         the DESK's line slot (setDeskLine above), not the flow's edge. -->
    <div class="desk-line" aria-live="polite">
      <FindingNote
        sentence={$deskLine.finding.sentence}
        derivation={$deskLine.finding.derivation}
        verbs={$deskLine.finding.verbs ?? [trimVerbPlaceholder("the history strip of the context desk")]}
        onDismiss={() => dismissDeskLine()}
      />
    </div>
  {/if}
</div>

<style>
  .flow-host {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .flow {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--ground-0);
    outline: none;
    /* The wheel/trackpad is the flow's primary navigation — it must never
     * be keyboard-only paging. Two rules keep that honest under a
     * virtualizer: `contain` stops an overscroll at either end from
     * chaining to the page (a bounce that scrolls the document would move
     * the fixed shell out from under the flow), and the smooth scroll-behavior
     * the browser may inherit is left OFF so a fling never fights the
     * height-index's own scrollTop writes (scrollToEnd). */
    overscroll-behavior: contain;
    scroll-behavior: auto;
  }
  .spacer {
    position: relative;
    width: 100%;
  }
  /* THE HEAD ROW's height is DECLARED in flow-config.ts and applied inline,
   * because the virtualizer adds that exact number to every beat offset. The
   * rules here may not change it: one line, never wrapping, clipped rather
   * than grown. A row that outgrew its declaration would displace every beat
   * below it — the same defect a stale height reservation causes, arriving
   * from outside the index. */
  .history-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    box-sizing: border-box;
    padding: 0 var(--gutter-bleed);
    white-space: nowrap;
    overflow: hidden;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
  }
  .head-said {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The focus ring is the ONE global rule (tokens.css :focus-visible); the
   * head verb only pulls the offset inside its own row so the ring does not
   * clip against the head's edge. */
  .history-head .verb {
    flex: none;
  }
  .history-head .verb:focus-visible {
    outline-offset: calc(-1 * var(--sp-0));
  }
  .item {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    will-change: transform;
  }
  /* LAYOUT ONLY — the measure and the air around it. Ink, face and slant used
   * to be decided here, in two rules that disagreed with each other about
   * whether a stated absence is italic; that argument is settled centrally
   * now and this file has no opinion in it. */
  .stated {
    max-width: var(--measure);
    margin: var(--sp-7) auto;
    font-size: var(--f-ui-size);
  }
  .said {
    margin: 0 0 var(--sp-2);
  }
  /* Layout only — pull the owned verb flush with the sentence. */
  .stated > .verb {
    margin-left: calc(-1 * var(--sp-2));
  }
  .desk-line {
    flex: none;
    border-top: var(--hairline-w) solid var(--line-1);
    background: var(--ground-1);
    padding: var(--sp-0) var(--gutter-bleed);
  }
</style>
