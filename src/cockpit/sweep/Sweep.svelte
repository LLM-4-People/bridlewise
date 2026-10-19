<script lang="ts">
  /**
   * THE SWEEP (§6) — flight recorder v1. One canvas band: time-binned
   * density skyline of the in-scope ledger, stacked §12.3 category colors,
   * error ridge in `--alarm`, now edge ticking ONLY on genuinely received
   * events, reconnect state rendered ON the band, head + semantic zoom.
   *
   * Standalone-mountable: props in (events/stream/source), documented
   * events out —
   *   headChange(asOf: number | null)     — epoch ms when planted, null = live
   *   focusBeat(detail: FocusBeatDetail)  — NAVIGATE THE CHAT to an instant
   * both fired as callback props (`onHeadChange`/`onFocusBeat`) AND as
   * DOM CustomEvents (`headChange`/`focusBeat`, bubbling) on the root, so
   * shell wiring can use either. The shared store seam (sweep-store.ts)
   * mirrors the head for asOf-reactive consumers.
   *
   * `focusBeat` IS the band→chat navigation seam and its contract — what the
   * flow must do with each field, and the one-liner that does it — is
   * published in `focus-seam.ts`. Hovering, scrubbing and clicking all emit
   * it; hover/scrub emit PREVIEWS (a look, not a commitment) coalesced to one
   * per animation frame, so a full-width sweep across a 1200-bin band is ~60
   * navigations per second and not 1200 in a burst. Previews never plant the
   * head, so they never issue a read — reads fire on settle (the click).
   *
   * A11y: the canvas is NEVER the only access — a parallel DOM outline
   * (status, coverage, runs, marks, head) renders alongside, and all
   * keyboard interaction ([ ] scrub · ⇧[ ⇧] by run · m mark · Esc live ·
   * Enter focus beat) works on the focused band.
   *
   * Reduced motion: there are no sweep animations at all — every paint is
   * a discrete state render (repaint-on-change, no rAF loops, no easing),
   * so `prefers-reduced-motion` is satisfied structurally; head moves are
   * discrete always.
   */
  import { onMount } from "svelte";
  import { currentChatId } from "../../state/chats.ts";
  import { currentProject } from "../../state/projects.ts";
  import { currentRun, isRunActive } from "../../state/run-state.ts";
  import { timelineScope } from "../../state/timeline-query.ts";

  import type { ShellApi } from "../shell/contract";
  import type { StreamState, SweepEvent, SweepWindow } from "./types";
  import { clientWindowSource, spectrumSource, type BinSource } from "./bin-source";
  import { resolveSweepPalette, type SweepPalette } from "./categories";
  import {
    designConditions,
    watchDesignConditions,
    withPaintTokens,
  } from "../paint/design-tokens.ts";
  import { buildCausalBands, nearestEvent } from "./causal";
  import { bandBounds } from "./band-scope";
  import {
    dispatchFocusBeat,
    eventAtOrBefore,
    focusBeatDetail,
    frameCoalesced,
    type FocusBeatDetail,
    type FocusVia,
  } from "./focus-seam";
  import { bandStatusLine, formatClock } from "./now-edge";
  import { spectrumProvKey, spectrumScopeKind, spectrumWire, startSpectrumFeed } from "./spectrum-load";
  import { whileFlowVisible } from "../shell/room-visibility.ts";
  import { paintSweep, type SweepFrame } from "./painter";
  import {
    defaultView,
    msPerPx,
    panWindow,
    scrubStepMs,
    timeAtX,
    xAtTime,
    zoomLevelFor,
    zoomWindow,
  } from "./zoom";
  import {
    dropMarkAtNow,
    nowEdge as nowEdgeStore,
    plantHead,
    removeMark,
    returnToLive as storeReturnToLive,
    scrubHead,
    setArmCaptureWindow,
    streamState as streamStateStore,
    sweepHead,
    sweepMarks,
  } from "./sweep-store";
  import { sweepWindowEvents } from "./sweep-data";
  // THE BAND TEACHES ITS OWN CHORDS. The scrub keys have no on-screen grip
  // any more; the band itself is their mouse path (shell/mouse-paths.ts), and
  // reading the registry here is what makes that declaration real rather than
  // a comment — assistive technology is told the keys without spending a
  // pixel on a control the user asked us to remove.
  import { gestureKeysFor } from "../shell/mouse-paths.ts";
  // THE ARM CHORD BRIDGES TO THE SHELL'S RIGHT MENU. ⌘⇧A stays claimed HERE
  // (the band is the surface the triggers cock on, and a permanent claim is
  // a load-bearing fact), but under the shell the arm menu is the
  // right-menu column (shell/right-menu.ts) — so the claim and the band's
  // own `a` key toggle THE HOST's state, not a local popover. The store is
  // the seam: the shell mounts the column, this surface asks for it, and
  // neither restates the other's state. A standalone mount (no shell) has
  // no host to ask, and keeps the local Popover below.
  import { toggleRightMenu } from "../shell/right-menu.ts";
  // The right menu's capture rows ask the band to plant the head through
  // the one-shot seam (sweep/band-request.ts) — the menu has no handle
  // into the band, and the band answers with its own `setHead`, so a
  // visited capture and a clicked mark cannot behave differently.
  import { consumeBandGoRequest, pendingBandGo } from "./band-request.ts";
  import SweepHead from "./SweepHead.svelte";
  import ArmMenu from "./ArmMenu.svelte";


  let {
    /** Shell seam (§2 contract): the shell mounts this outlet with its
     * ShellApi; standalone mounts (harness, tests) may omit it. */
    shell = undefined,
    /** In-scope events. Default: the streamed window (timeline store). */
    events = undefined,
    /** Stream liveness. Default: the shared sweep stream store. */
    stream = undefined,
    /** Bin source override — the seam where `sweep.spectrum` drops in. */
    source = undefined,
    /** Band height in px — 48 per §2.2, 28 folded (§2.7 <1100). */
    height = 48,
    folded = false,
    onHeadChange = undefined,
    onFocusBeat = undefined,
  }: {
    shell?: ShellApi;
    events?: readonly SweepEvent[];
    stream?: StreamState;
    source?: BinSource;
    height?: number;
    folded?: boolean;
    onHeadChange?: (asOf: number | null) => void;
    onFocusBeat?: (detail: FocusBeatDetail) => void;
  } = $props();

  // ── Data resolution (props win; stores are the standalone default) ──
  const resolvedEvents = $derived(events ?? $sweepWindowEvents);
  const resolvedStream = $derived(stream ?? $streamStateStore);
  /** Shell mounts (no data props) run the full-history spectrum feed; a
   * mount that brings its own events/source owns its own data. */
  const ownsData = $derived(source === undefined && events === undefined);
  const resolvedWire = $derived(ownsData ? $spectrumWire : null);
  /** LENS stamp for the band — present ONLY when the bars are actually the
   * spectrum read's. On the client-window fallback (or a props-fed mount)
   * there is no record to name, and the band stays honestly unstamped. */
  const provKey = $derived(resolvedWire !== null ? $spectrumProvKey : null);
  const binSource: BinSource = $derived(
    source ??
      (resolvedWire !== null
        ? spectrumSource(resolvedWire, resolvedEvents)
        : clientWindowSource(resolvedEvents)),
  );

  /**
   * THE BAND PAINTS TO THE BOX THE SHELL GAVE IT.
   *
   * §2.7 folds the sweep from 48px to 28px below the narrow breakpoint, and
   * `--sweep-h` in tokens.css is the ONE owner of both numbers — the shell's
   * own slot is `height: var(--sweep-h)`. This used to be a `folded` PROP,
   * which the shell never passed (outlets receive exactly `{ shell }` by
   * contract), so on a narrow viewport the shell's slot folded to 28px while
   * the band went on drawing 48: the sweep overflowed its slot and painted
   * over the desk beneath it — the scrub grips half-covered and the desk's
   * gauge sliced through.
   *
   * So the number is READ from the shell's own token, the same way the
   * palette is (`getComputedStyle` below), and re-read whenever the box
   * changes. The props remain the standalone-harness fallback: with no
   * tokens.css above it there is nothing to read, and `height`/`folded` are
   * the honest answer.
   */
  let slotH = $state<number | null>(null);
  /** What this element's own borders take out of the band (measured). */
  let bezelH = $state(0);
  const bandH = $derived(slotH ?? (folded ? 28 : height));
  /** The canvas's box: the band, less its own bezel. Never negative. */
  const canvasH = $derived(Math.max(1, bandH - bezelH));

  /**
   * The band height the shell actually gave us, or null where there is no
   * shell. The SLOT's content box is the answer — not the token — because the
   * slot spends part of `--sweep-h` on its own hairline, and a band drawn to
   * the token would sit one pixel proud of the box it lives in. Measuring the
   * PARENT is not circular: the parent is sized by the token, this element by
   * `bandH`.
   */
  function readSlotHeight(): void {
    const slot = host?.parentElement ?? null;
    if (slot === null || typeof getComputedStyle !== "function") return;
    // A slot with no declared height of its own (a standalone harness) is
    // sized BY the band — there is nothing to read, so the props stand.
    const declared = getComputedStyle(slot).getPropertyValue("height");
    if (declared === "" || declared === "auto") {
      slotH = null;
      return;
    }
    const inner = slot.clientHeight;
    slotH = Number.isFinite(inner) && inner > 0 ? inner : null;
    // …AND THE BAND'S OWN BEZEL, separately. The band FILLS the slot's
    // content box; the CANVAS then fills what is left after this element
    // spends a hairline on each of its own borders. Drawing the canvas to
    // the band's full height put the density bars ~2px past the housing they
    // live in — over the band's own bottom rule and into the row beneath.
    // (That row was the findings row when this was found; the findings row
    // has since moved ABOVE the band and the DESK is the neighbour now. The
    // bleed is a fact about this element's own two boxes, so it is the same
    // defect whoever is underneath.) Two numbers, because there are two
    // boxes; one number is what produced the bleed.
    const cs = getComputedStyle(host!);
    bezelH =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  }

  // ── Geometry ──
  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let widthPx = $state(0);

  // ── View window (semantic zoom, one axis: time) ──
  /** null = follow the live coverage (default view). */
  let pinnedView: SweepWindow | null = $state(null);
  const coverage = $derived(binSource.coverage());
  /**
   * THE BAND'S DOMAIN (§6.2 + the scoping rule in band-scope.ts).
   *
   * It starts at the first event of whatever the read covers — with a
   * conversation open that read IS the conversation's, so the band's first
   * bar is that chat's first recorded event — and it runs to now: the
   * recorded span, extended to the now edge when a genuinely received event
   * is newer than the loaded snapshot (empty ground, never an invented bin).
   */
  const bounds: SweepWindow | null = $derived.by(() => {
    const domain = bandBounds(coverage, $nowEdgeStore.timeMs);
    return domain === null ? null : defaultView(domain);
  });
  const view: SweepWindow | null = $derived(pinnedView ?? bounds);
  const level = $derived(
    view === null ? "skyline" : zoomLevelFor(msPerPx(view, Math.max(1, widthPx))),
  );

  // ── Interaction state ──
  let hoverMs: number | null = $state(null);
  /** The STANDALONE arm popover's open state. Under the shell this is never
   * set: the arm chord, the band's `a` key and every other open path toggle
   * the shell's right menu (see the right-menu import's note), and the
   * Popover below is not mounted at all. */
  let armOpen = $state(false);

  /**
   * THE BAND IS INERT UNTIL YOU ACTIVATE IT (the wheel contract).
   *
   * `onwheel` used to be bound unconditionally, so merely moving the pointer
   * ACROSS the band handed it your scroll: a stray wheel tick panned the
   * window or zoomed by 1.25×. That is scroll hijacking — the page feels
   * broken when you are only passing through — and the user reported it as
   * exactly that. The band now owns the wheel only after a deliberate act:
   *
   *   inert   the wheel is not ours. We do not read it, we do not
   *           preventDefault it; it goes wherever it would have gone with no
   *           sweep on the page at all.
   *   active  a CLICK on the band, or FOCUS on it (keyboard parity — a
   *           mouse-only capability is a defect, MOUSE-FIRST's converse),
   *           and the wheel zooms/pans as it always did.
   *
   * Giving it back reuses the shell's own machinery rather than a second
   * one: while active the band pushes a DISMISSAL LAYER (shell/routing.ts),
   * so Esc releases it in the correct order — the wheel first, then the room,
   * then the past view on the floor — and a press outside releases it too,
   * the same web-native contract the shared Popover keeps.
   *
   * DISCOVERABILITY IS THE OTHER HALF. A band that silently ignores your
   * wheel is worse than one that steals it, because nothing says why. So the
   * inert band states, on hover, exactly what a click will do; the active
   * band states what it now has and how to give it back; and the active
   * state wears the cockpit's own focus ring, inset, so you can tell at a
   * glance who owns your wheel without experimenting.
   */
  let bandActive = $state(false);
  let focusWithin = $state(false);

  /** The affordance's words — one owner for the chip, the tooltip and the
   * canvas's AT label, so the three can never teach different gestures. */
  const activationNote = $derived(
    bandActive
      ? "wheel zooms · ⇧ wheel pans · Esc releases"
      : "click to zoom time with the wheel",
  );

  function activateBand(): void {
    bandActive = true;
  }

  function releaseBand(): void {
    bandActive = false;
  }
  const headMs = $derived($sweepHead);
  const statusLine = $derived(bandStatusLine(resolvedStream));

  // ── Full-history feed (§6.6): shell mounts follow the scoped spectrum.
  // The feed fills silently — canvas repaint + overlay text only, never a
  // mount or geometry change (one-reveal law, §10.3).
  //
  // QUIET WHEN HIDDEN. A room covers the whole shell, sweep included, so
  // while one is open this band's scope subscriptions are work nobody can
  // see — they are released and re-taken when the room closes, which also
  // re-reads the spectrum for whatever scope the room may have changed.
  // Releasing does NOT clear `spectrumWire`: the bins on screen when the room
  // opened are still on screen when it closes, and the fresh ones arrive
  // underneath them (shell/room-visibility.ts). ──
  $effect(() => {
    if (!ownsData) return;
    return whileFlowVisible(startSpectrumFeed);
  });

  // THE CAPTURE-WINDOW MIRROR (sweep-store `armCaptureWindow`). What "the
  // band" spans is a fact only this mounted band derives; the arm menu's
  // body reads it from the store whether its host is the standalone Popover
  // beside this band or the shell's right-menu column with no band in its
  // tree. Cleared on unmount so no host ever reads a span no live band is
  // showing — the honest "nothing recorded yet" belongs to a cockpit with
  // no band, not to one whose band went away.
  $effect(() => {
    const win = coverage ?? view;
    setArmCaptureWindow(win);
    return () => setArmCaptureWindow(null);
  });

  // ── Bins + causal bands for the current view ──
  // One bin per ~4px, clamped: enough bins for a sharp skyline, few enough
  // that a rebin stays far under the 100ms budget.
  const MIN_BIN_COUNT = 48;
  const MAX_BIN_COUNT = 600;
  const PX_PER_BIN = 4;
  const binCount = $derived(
    Math.max(MIN_BIN_COUNT, Math.min(MAX_BIN_COUNT, Math.floor(Math.max(1, widthPx) / PX_PER_BIN))),
  );
  const bins = $derived(
    view === null ? null : binSource.bins(view, binCount),
  );
  /**
   * WHAT IS IN THE WINDOW — the head's résumé, read off the SAME bins the
   * painter draws. Both numbers therefore describe the same scope: on a
   * spectrum read `eventCount` is the server's count for this window and
   * `errors` is the ridge summed over the same bins. Nothing here is derived
   * from the locally streamed events, which cover a narrower span — two
   * scopes in one sentence is a quiet lie, and since the band's coverage
   * caption was retired this résumé is the ONLY sentence the band has left.
   */
  const viewContents = $derived(
    bins === null
      ? null
      : {
          events: bins.eventCount,
          errors: bins.errors.reduce((a, b) => a + b, 0),
        },
  );
  const causal = $derived(
    view !== null && (level === "causal" || level === "beats")
      ? buildCausalBands(binSource.eventsIn(view))
      : null,
  );
  /** DOM beat previews near focus — beats level only, hard-capped so DOM
   * stays sparse (canvas carries the mass, §6.3). */
  const domTicks = $derived.by(() => {
    if (view === null || level !== "beats" || causal === null) return [];
    const out: { eventId: string; timeMs: number; x: number; label: string; isError: boolean }[] = [];
    for (const run of causal) {
      for (const turn of run.turns) {
        for (const t of turn.ticks) {
          const x = xAtTime(view, t.timeMs, widthPx);
          if (x < 0 || x > widthPx) continue;
          out.push({
            eventId: t.eventId,
            timeMs: t.timeMs,
            x,
            label: `${t.eventType}${t.description ? ` — ${t.description}` : ""} · ${formatClock(t.timeMs)}`,
            isError: t.isError,
          });
          if (out.length >= 80) return out;
        }
      }
    }
    return out;
  });

  /**
   * THE PALETTE IS RESOLVED IN THE PAINT, NEVER BEFORE IT.
   *
   * It used to be a `$state` filled once in `onMount`, which meant the band
   * kept painting whatever theme happened to be active the moment it mounted:
   * every one of the fifteen values below — eight category hues, `--alarm`,
   * `--beam`, two grounds, the hairline and two inks — is re-declared by
   * `:root[data-cockpit-theme="light"]`, so switching to the logbook left a
   * carbon band on a paper page. A token read once is not a token.
   *
   * `withPaintTokens` hands the reader in as a parameter and revokes it on the
   * way out, so there is no binding here for a future paint to close over.
   * `categories.ts` still owns the fallbacks — this only decides WHEN.
   */
  function readPalette(): SweepPalette {
    return withPaintTokens(host, (read) => resolveSweepPalette((name) => read(name, "")));
  }

  $effect(() => {
    if (quietEmpty || host === undefined) return;
    const cleanups: (() => void)[] = [];
    // THE SIGNAL THE REPAINT IS BOUND TO. Fresh values are only half the fix:
    // a paint nobody re-runs is a paint that never asks. This is one
    // subscription over the one element every theme and density change lands
    // on, so the band answers a change made by the settings sheet, by a test,
    // or by anything written later, without knowing which.
    cleanups.push(watchDesignConditions());
    readSlotHeight();
    if (host !== undefined && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (host === undefined) return;
        widthPx = host.clientWidth;
        // Crossing the §2.7 breakpoint remaps `--sweep-h`; the width change
        // is the same gesture, so one observer answers both.
        readSlotHeight();
      });
      ro.observe(host);
      if (host.parentElement !== null) ro.observe(host.parentElement);
      cleanups.push(() => ro.disconnect());
    }
    if (host !== undefined) widthPx = host.clientWidth;
    return () => { for (const cleanup of cleanups) cleanup(); };
  });

  onMount(() => {
    const cleanups: (() => void)[] = [];
    // Shell keyboard grammar (§2.7): claim the sweep's chords so `[` `]`
    // (⇧: by run), ⌘⇧A and the Esc remainder work cockpit-wide, not only
    // with the band focused. Standalone mounts keep the local bindings.
    if (shell !== undefined) {
      const owner = { owner: "the SWEEP" };
      cleanups.push(shell.claimKey("scrub-back", ({ shift }) => scrub(-1, shift), owner));
      cleanups.push(shell.claimKey("scrub-forward", ({ shift }) => scrub(1, shift), owner));
      cleanups.push(shell.claimKey("arm", () => {
        toggleRightMenu("arm");
      }, owner));
      // `escape` is NOT claimed any more — it never was the sweep's to own,
      // it simply mounted last and took it, which is exactly why the FLOW's
      // own escape claim never fired. The two things Esc did here are
      // DECLARED instead, at the depth each belongs to: the ARM MENU is a
      // nested surface and registers itself through the shared Popover, and
      // the PLANTED HEAD is a floor layer (the effect below).
    }
    return () => {
      // A pending preview outlives the band otherwise — it would fire into a
      // detached host on the frame after unmount.
      navEmitter.cancel();
      if (paintFrame !== null) cancelAnimationFrame(paintFrame);
      for (const c of cleanups) c();
    };
  });

  /**
   * THE PLANTED HEAD IS A FLOOR LAYER (§6.2 + shell/routing.ts).
   *
   * A past view is not a surface nested inside whatever room happens to be
   * open — it is a condition the whole cockpit is in. So it is registered on
   * the ladder's FLOOR: Esc closes what is on screen first (the innermost
   * menu, then the room, then the scope) and only then comes back to now.
   * That is the same order the shell used to reach by accident and now
   * reaches on purpose, and `goLive` is still the sweep's own return — it
   * unpins the band's view and publishes the head change, which a bare
   * `returnToLive()` from the shell would not.
   */
  $effect(() => {
    if (shell === undefined || headMs === null) return;
    return shell.pushDismiss({ label: "the past view", floor: true, dismiss: goLive });
  });

  /**
   * WHILE THE BAND HOLDS THE WHEEL it is an open surface, so it declares
   * itself on the shell's dismissal ladder like every other open surface.
   * Not a floor layer: a floor layer is a global CONDITION (the planted
   * head), and this is a thing on screen you can close — Esc must give the
   * wheel back before it closes the room you are standing in.
   */
  $effect(() => {
    if (shell === undefined || !bandActive) return;
    return shell.pushDismiss({
      label: "the timeline's hold on your wheel",
      dismiss: releaseBand,
    });
  });

  // ── THE RIGHT MENU'S CAPTURE ROWS (sweep/band-request.ts) ──
  //
  // A capture row's "go" asks for the band's own composite verb: plant the
  // head at the bookmarked instant AND take the reader there. That is
  // `setHead` — the same function a mark click runs — so a capture visited
  // from the menu and a mark clicked on the band cannot behave
  // differently. The consume clears the request inside the effect, so the
  // re-run (the clear itself) reads null and returns: one ask, one trip.
  // No view gate: the instant is real (the capture recorded it), so the
  // ask is absolute — the flow navigates to what was happening then even
  // while the band itself is still reading its coverage.
  $effect(() => {
    const at = $pendingBandGo;
    if (at === null) return;
    consumeBandGoRequest();
    setHead(at, "key");
  });

  /** A press outside the band gives the wheel back — the same web-native
   * contract the shared Popover keeps, and the reason no modal state is
   * needed: you leave by doing the next thing you were going to do. */
  $effect(() => {
    if (!bandActive || host === undefined || typeof window === "undefined") return;
    const node = host;
    const onDown = (ev: PointerEvent): void => {
      if (ev.target instanceof Node && node.contains(ev.target)) return;
      releaseBand();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  });

  // ── Painting: discrete repaint on state change (no loops, no easing) ──
  let paintFrame: number | null = null;
  function schedulePaint(): void {
    if (quietEmpty || paintFrame !== null) return;
    const run = () => {
      paintFrame = null;
      paintNow();
    };
    if (typeof requestAnimationFrame === "function") paintFrame = requestAnimationFrame(run);
    else run();
  }

  function paintNow(): void {
    if (quietEmpty || canvas === undefined || view === null || bins === null || widthPx === 0) return;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const w = widthPx;
    const h = canvasH;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) return; // jsdom / test env — the DOM outline still renders
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const frame: SweepFrame = {
      widthPx: w,
      heightPx: h,
      view,
      level,
      bins,
      causal,
      palette: readPalette(),
      stream: resolvedStream,
      nowEdge: $nowEdgeStore,
      headMs,
      hoverMs,
      marks: $sweepMarks,
      reducedMotion: prefersReducedMotion(),
    };
    paintSweep(ctx, frame);
  }

  function prefersReducedMotion(): boolean {
    return typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // Repaint whenever any rendered fact changes — a discrete state render.
  $effect(() => {
    if (quietEmpty) {
      if (paintFrame !== null) cancelAnimationFrame(paintFrame);
      paintFrame = null;
      return;
    }
    // dependency taps (all real state, no timers):
    void bins; void causal; void headMs; void hoverMs; void $sweepMarks;
    void resolvedStream; void $nowEdgeStore; void widthPx; void canvasH;
    void level;
    // The design conditions are a rendered fact like any other: when the
    // theme or density changes, what this band should look like changes, so
    // it repaints. NAMED, not implied — that is the whole difference between
    // motion that carries information and motion that happens to occur.
    void $designConditions;
    schedulePaint();
  });

  // ── Live follow: when unpinned, the view derives from coverage, so a
  // received event (coverage grows) extends the band — the tick. This is
  // data-driven: no event, no change, no motion. ──

  // ── Emit seam ──
  function emit(name: "headChange", detail: unknown): void {
    host?.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  /**
   * Plant the head AND take the reader there. The two were separate before,
   * which is how the band came to change every breaker row and instrument on
   * the page while the conversation itself sat exactly where it was.
   */
  function setHead(asOfMs: number, via: FocusVia = "click"): void {
    plantHead(asOfMs);
    onHeadChange?.(asOfMs);
    emit("headChange", asOfMs);
    commitAt(asOfMs, via, asOfMs);
  }

  function goLive(): void {
    storeReturnToLive();
    pinnedView = null;
    onHeadChange?.(null);
    emit("headChange", null);
  }

  // ── THE NAVIGATE SEAM (focus-seam.ts owns the contract) ──
  //
  // Every band position the reader points at becomes a `focusBeat` with the
  // INSTANT (always) and the ledger event id at-or-before it (when the client
  // holds one). Two rates, deliberately:
  //   · previews (hover/scrub) go through `offer` — COALESCED TO THE FRAME,
  //     so a full-width sweep emits once per frame no matter how many
  //     pointermoves the OS delivers, and never plants the head (no head, no
  //     `until`, no read — reads fire on settle);
  //   · commitments (click, Enter, `[`/`]`) go through `now` — immediate,
  //     because a click that waited for the next frame would feel dropped.
  type NavRequest = Readonly<{
    timeMs: number;
    via: FocusVia;
    preview: boolean;
    /** The head AS OF THIS REQUEST — passed rather than read at emit time
     * because a plant and its navigation happen in the same tick, and the
     * derived `headMs` has not caught up yet. */
    capMs: number | null;
  }>;

  const navEmitter = frameCoalesced<NavRequest>((req) => {
    // Resolution happens HERE, inside the frame — one binary search per
    // emitted navigation rather than one per pointer tick.
    const events = view === null ? [] : binSource.eventsIn(view);
    const near = eventAtOrBefore(events, req.timeMs, req.capMs);
    const detail = focusBeatDetail({
      eventId: near?.eventId ?? null,
      timeMs: req.timeMs,
      via: req.via,
      preview: req.preview,
      headMs: req.capMs,
    });
    onFocusBeat?.(detail);
    if (host !== undefined) dispatchFocusBeat(host, detail);
  });

  /**
   * A transient look — hover and scrub. Coalesced, never commits.
   *
   * AND GATED ON ACTIVATION, because this is the SECOND channel from the band
   * into the flow and it is not a wheel at all. A preview dispatches
   * `sweep.focusBeat` with `preview: true`, and the flow answers it by
   * SCROLLING to the beat at that instant (Flow.svelte's `scrubTo`). So
   * merely moving the pointer across an inert band threw the reader's place
   * in the conversation away — reported as "moving the mouse onto the
   * timeline still makes the chat scroll sometimes", and "sometimes" is
   * exactly right: it only moves when the instant under the pointer belongs
   * to a beat that is off screen.
   *
   * The rule is one rule, not one per channel: AN INERT BAND HAS NO EFFECT ON
   * THE FLOW, THROUGH ANY CHANNEL. Wheel, hover preview, drag-scrub preview —
   * all silent until the reader has asked. The preview behaviour itself is
   * kept exactly as it was for the activated band, because scrubbing the
   * timeline to move the flow is the thing the user asked for; it just may
   * not happen before they have taken hold of the instrument.
   *
   * COMMITMENTS are deliberate by construction and stay ungated: a click
   * IS the activating gesture, and the scrub grips, the `[`/`]` chords and
   * the a11y outline's jumps are all controls someone chose to operate.
   */
  function previewAt(timeMs: number, via: FocusVia): void {
    if (!bandActive) return;
    navEmitter.offer({ timeMs, via, preview: true, capMs: headMs });
  }

  /** A commitment — click, Enter, a scrub step, an outline jump. Immediate. */
  function commitAt(timeMs: number, via: FocusVia, capMs: number | null = headMs): void {
    navEmitter.now({ timeMs, via, preview: false, capMs });
  }

  /** The deepest-zoom handoff: a named tick commits at the tick's instant. */
  function focusBeatAt(timeMs: number): void {
    commitAt(timeMs, "click");
  }

  // ── Pointer interaction ──
  let dragStartX: number | null = null;
  let dragged = false;

  function onPointerDown(e: PointerEvent): void {
    // THE DELIBERATE ACT. A press on the band is the click that takes the
    // wheel; it happens alongside everything the press already did (scrub,
    // plant, focus a tick), so nothing about the existing gesture changes.
    activateBand();
    dragStartX = e.offsetX;
    dragged = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  /** KEYBOARD PARITY. Focus is the keyboard's click: reaching the band by
   * Tab hands it the wheel exactly as a press does, so a keyboard user is
   * not locked out of a capability the mouse has. */
  function onBandFocus(): void {
    activateBand();
  }

  /** …and leaving gives it back. Only when focus actually LEAVES the band —
   * stepping from the canvas onto the band's own scrub grip is still being
   * on the band, and would otherwise drop the wheel mid-gesture. */
  function onBandBlur(e: FocusEvent): void {
    const to = e.relatedTarget;
    if (to instanceof Node && host !== undefined && host.contains(to)) return;
    releaseBand();
  }

  function onPointerMove(e: PointerEvent): void {
    if (view === null) return;
    // Read nothing from layout here: `offsetX` comes with the event and the
    // band's width is kept by the ResizeObserver, so a pointermove never
    // touches getBoundingClientRect and never forces a reflow.
    const at = timeAtX(view, e.offsetX, widthPx);
    hoverMs = at;
    if (dragStartX !== null && Math.abs(e.offsetX - dragStartX) > 3 && bounds !== null) {
      dragged = true;
      const deltaMs = (dragStartX - e.offsetX) * msPerPx(view, widthPx);
      pinnedView = panWindow(view, deltaMs, bounds);
      dragStartX = e.offsetX;
    }
    previewAt(at, dragged ? "scrub" : "hover");
  }

  function onPointerUp(e: PointerEvent): void {
    const wasDrag = dragged;
    dragStartX = null;
    dragged = false;
    if (wasDrag || view === null) return;
    const t = timeAtX(view, e.offsetX, widthPx);
    // Clicking the now edge returns to live (§6.2).
    const edge = $nowEdgeStore.timeMs;
    if (edge !== null) {
      const edgeX = xAtTime(view, edge, widthPx);
      if (Math.abs(e.offsetX - edgeX) <= 5 && resolvedStream.status === "live") {
        goLive();
        return;
      }
    }
    // At beats level a click near a tick focuses the beat (deepest zoom
    // hands off, §6.3); otherwise the click plants the head.
    if (level === "beats" && view !== null) {
      const near = nearestEvent(binSource.eventsIn(view), t);
      if (near !== null && Math.abs(xAtTime(view, near.timeMs, widthPx) - e.offsetX) <= 4) {
        focusBeatAt(near.timeMs);
        return;
      }
    }
    setHead(t);
  }

  function onPointerLeave(): void {
    hoverMs = null;
    dragStartX = null;
    dragged = false;
    // A pointer that left the band has no position to navigate to; a pending
    // preview from the last frame would land after the reader looked away.
    navEmitter.cancel();
  }

  function onWheel(e: WheelEvent): void {
    // INERT MEANS INERT. Not "pans less", not "needs a modifier": we read
    // nothing off this event and we do not preventDefault it, so it is
    // delivered exactly as it would be if this band were not here.
    if (!bandActive) return;
    if (view === null || bounds === null) return;
    e.preventDefault();
    if (e.shiftKey && !e.ctrlKey) {
      pinnedView = panWindow(view, e.deltaY * msPerPx(view, widthPx), bounds);
      return;
    }
    const anchor = timeAtX(view, e.offsetX, widthPx);
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    const next = zoomWindow(view, anchor, factor, bounds);
    // Fully zoomed out = follow live again (unpin).
    pinnedView =
      next.t0 <= bounds.t0 && next.t1 >= bounds.t1 ? null : next;
  }

  // ── Keyboard grammar (band-focused; the shell mirrors these globally) ──
  function onKeyDown(e: KeyboardEvent): void {
    if (view === null) return;
    switch (e.key) {
      case "[": {
        e.preventDefault();
        scrub(-1, e.shiftKey);
        break;
      }
      case "]": {
        e.preventDefault();
        scrub(1, e.shiftKey);
        break;
      }
      case "m": {
        e.preventDefault();
        dropMarkAtNow();
        break;
      }
      case "a": {
        e.preventDefault();
        // THE SAME VERB THE CHORD FIRES (one path, one mechanism): under
        // the shell both open the right-menu column; standalone (the dev
        // harness, tests) there is no host, and the local Popover carries
        // it — the same grammar either way, never two surfaces.
        if (shell !== undefined) toggleRightMenu("arm");
        else armOpen = !armOpen;
        break;
      }
      case "Escape": {
        // THE LADDER PROTOCOL, JOINED: a layer that CONSUMED the press
        // stops it, or the shell's dismissal ladder pops the NEXT layer
        // with the same keystroke (one Esc released the wheel AND closed
        // the run pane — the band acted, then handed the same press on).
        // The band acts on its own innermost layer first, exactly as
        // before; what changes is that an ACTED press is not also the
        // ladder's. A press with nothing band-owned to dismiss falls
        // through untouched, so the ladder still answers it honestly
        // (the ground hint belongs to the shell, not to the band).
        // `armOpen` is the STANDALONE popover (this band's own nested
        // surface); under the shell the arm menu is the right-menu column
        // — a SHELL layer, which the ladder takes in its own order.
        e.preventDefault();
        if (armOpen) {
          armOpen = false;
          e.stopPropagation();
        } else if (bandActive) {
          releaseBand();
          e.stopPropagation();
        } else if (headMs !== null) {
          goLive();
          e.stopPropagation();
        } else {
          goLive();
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        if (headMs !== null) commitAt(headMs, "key");
        break;
      }
    }
  }

  /**
   * THE one scrub entry point — the keydown handler, the shell's chord
   * claims and the scrub GRIPS all route through it, so the visible control
   * and the chord can never drift apart. `byRun` is the ⇧-variant (⇧[ / ⇧]
   * from the keyboard, shift-click from the mouse).
   */
  function scrub(dir: -1 | 1, byRun: boolean): void {
    // A scrub with nothing to scrub FROM used to return in silence — on a
    // key that is forgivable, on a visible button it is not: a control that
    // does nothing and says nothing reads as broken. Both paths now state
    // the gap (§2.7 routing law: never silently nothing).
    if (view === null) {
      shell?.hint("nothing recorded on the band yet — no time to scrub to");
      return;
    }
    if (headMs === null && $nowEdgeStore.timeMs === null) {
      shell?.hint("no event received yet — the head has no time to scrub from");
      return;
    }
    if (byRun) scrubByRun(dir);
    else emitAfterScrub(scrubHead(dir * scrubStepMs(view)));
  }

  function emitAfterScrub(result: number | null): void {
    onHeadChange?.(result);
    emit("headChange", result);
    // A keyboard/grip scrub is a deliberate step, so it navigates the chat
    // too — one commitment per press, which is already "on settle".
    if (result !== null) commitAt(result, "key", result);
  }

  /** ⇧[ / ⇧]: head jumps run starts (§2.7 "by run"). */
  function scrubByRun(dir: -1 | 1): void {
    if (view === null) return;
    const runs = buildCausalBands(binSource.eventsIn(
      coverage ?? view,
    ));
    if (runs.length === 0) return;
    const from = headMs ?? $nowEdgeStore.timeMs;
    if (from === null) return;
    const starts = runs.map((r) => r.t0).sort((a, b) => a - b);
    const target = dir === -1
      ? [...starts].reverse().find((t) => t < from)
      : starts.find((t) => t > from);
    if (target !== undefined) {
      setHead(target, "key");
    } else if (dir === 1) {
      goLive();
    }
  }

  // ── A11y outline content ──
  const outlineRuns = $derived(
    view === null ? [] : buildCausalBands(binSource.eventsIn(coverage ?? view)),
  );

  /**
   * THE ONE MEASURED EMPTINESS THE BAND MAY NAME (UIE-048): the spectrum read
   * for THE OPEN CONVERSATION has landed, its payload honestly decodes to no
   * window (t0/t1 null — the server measured the record and it is empty),
   * and nothing streamed locally either. Every other viewless state — read
   * in flight, failed, no scope, a wider project/trace scope — stays silent
   * as it always has: an unmeasured emptiness must not wear a sentence
   * (band-scope.ts states the law). The source already decoded the payload;
   * its coverage supplies the same emptiness without decoding it again.
   */
  const measuredEmpty = $derived(
    ownsData &&
      resolvedWire !== null &&
      $spectrumScopeKind === "chat" &&
      resolvedEvents.length === 0 &&
      coverage === null,
  );
  // currentRun is retired on chat change by the existing context owner. An
  // explicit timeline scope may still name another chat, so match it too.
  const scopedRunActive = $derived($currentChatId !== null && $isRunActive &&
    $currentRun?.projectId === $currentProject?.id &&
    ($timelineScope.kind === "global" ||
      ($timelineScope.kind === "chat" && $timelineScope.chatId === $currentChatId)));
  // Keep the existing event/read signal alive to reveal the first real event;
  // release painting and layout observation while the measured band is quiet.
  // Focus retains the band through Escape until the keyboard actually leaves.
  const quietEmpty = $derived(shell !== undefined && measuredEmpty && !scopedRunActive &&
    headMs === null && !bandActive && !focusWithin && hoverMs === null && $sweepMarks.length === 0);
</script>

<div
  class="sweep"
  data-empty={measuredEmpty}
  data-quiet-empty={quietEmpty}
  inert={quietEmpty}
  onfocusin={() => { focusWithin = true; }}
  onfocusout={(event) => { if (!(event.relatedTarget instanceof Node) || !host?.contains(event.relatedTarget)) focusWithin = false; }}
  bind:this={host}
  style:height={`${bandH}px`}
  data-prov={provKey}
  data-active={bandActive ? "active" : "inert"}
  role="group"
  aria-label="flight recorder"
>
  <canvas
    bind:this={canvas}
    style:width={`${widthPx}px`}
    style:height={`${canvasH}px`}
    aria-label={`${
      statusLine ??
      (bins === null || bins.eventCount === 0
        ? "flight recorder — nothing recorded yet"
        : `flight recorder — ${bins.eventCount} events on the band`)
    } · ${activationNote}`}
    title={activationNote}
    tabindex="0"
    data-scrub-band="true"
    aria-keyshortcuts={gestureKeysFor("scrub-back", "scrub-forward")}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointerleave={onPointerLeave}
    onwheel={onWheel}
    onkeydown={onKeyDown}
    onfocus={onBandFocus}
    onblur={onBandBlur}
  ></canvas>

  <!-- WHO OWNS YOUR WHEEL — said in plain words, at the moment the question
       arises. Inert and hovered: what a click will do. Active: what the band
       now has and how to give it back. The standing product rule is that no
       knowledge at all may be required, and an instrument that quietly
       ignores a gesture teaches nothing. -->
  {#if bandActive || hoverMs !== null}
    <!-- aria-hidden on purpose: the canvas's own label already carries these
         words, and a live region that re-announced them on every hover would
         be chatter, not access. -->
    <div class="activation-note" class:live={bandActive} aria-hidden="true">{activationNote}</div>
  {/if}

  <!-- The head is reserved geometry, so it mounts with the band and not with
       the data: a header that appeared when the spectrum landed would be a
       post-reveal mount (§10.3). With nothing on the band it renders an empty
       row and says nothing it cannot measure — except the one MEASURED
       emptiness (the conversation's own record, read back empty), which the
       head states in words (UIE-048). -->
  <SweepHead
    {view}
    widthPx={widthPx}
    hoverMs={hoverMs}
    headMs={headMs}
    contents={viewContents}
    measuredEmpty={measuredEmpty}
    standalone={shell === undefined}
    onReturnLive={goLive}
  />

  <!-- NO STATUS CHIP IN THE MIDDLE OF THE BAND. A bordered chip sat dead
       centre (top/left 50%) saying "not live — no stream open" or "stream
       reconnecting — last event 14:32:05", yellow when a stream should exist
       and did not. The user asked for it to go.

       THE SENTENCE IS NOT LOST — `statusLine` still feeds the parallel a11y
       outline below, which is the band's non-visual access path (§6.6), so
       assistive technology still reads the stream's real state. What was
       removed is the visual chip, not the fact.

       Reachability of the same truth elsewhere: an unreachable API is stated
       by the connection instrument (src/data/connection.ts) across the
       whole shell, and a reconnecting RUN stream is visible in the flow. The
       chip's unique case was "a conversation is open and no stream exists"
       while the API is perfectly healthy — if that turns out to be worth
       saying, it belongs in the head résumé beside the other measured facts,
       not as a second instrument floating over the data. -->


  <!-- NO COVERAGE CAPTION HERE, on purpose. A second sentence about the band
       ("this conversation · since Jul 25 13:40") sat in this corner and said a
       weaker version of what the head résumé above the band already states
       from measured values — the window on screen, how much of the record it
       is, and what is in it. The user asked for the duplicate to go, and it is
       a REMOVAL, not a relocation: nothing inherited the claim. See
       band-scope.ts for the note on what would have to come back with it. -->

  <!-- Beats-level DOM previews near focus (canvas carries the mass) -->
  {#each domTicks as tick (tick.eventId)}
    <button
      type="button"
      class="tick"
      class:error={tick.isError}
      style:left={`${tick.x - 3}px`}
      title={tick.label}
      aria-label={tick.label}
      data-action="client-nav:sweep.focus-beat"
      onclick={() => focusBeatAt(tick.timeMs)}
    ></button>
  {/each}

  <!-- NO SCRUB ARROWS IN THE BOTTOM-LEFT CORNER. Two grips (‹ ›) sat there
       as the visible half of [ and ]. The user asked for them to go.

       THE CHORDS SURVIVE and so does their mouse path: clicking the band
       itself scrubs (commitAt via "click"), which is a more direct gesture
       than a corner button and needs no prior knowledge — the same reasoning
       that retired the beat menu. cockpit-mouse-path-owner accepts any
       genuinely reachable path, not a specific element. -->

  <!-- THE ARM MENU, STANDALONE ONLY. Under the cockpit shell the arm menu is
       the right-menu column the rail's `arm` word, ⌘⇧A and this band's own
       `a` key toggle (shell/right-menu.ts) — mounting a second surface here
       would put two arm menus on one screen. A standalone mount (the dev
       harness, tests) has no shell and no host, so the shared Popover over
       the band keeps the same grammar it always had. -->
  {#if shell === undefined}
    <ArmMenu open={armOpen} onClose={() => (armOpen = false)} />
  {/if}

  <!-- Parallel a11y outline (§6.6): the canvas is never the only access -->
  <div class="outline" data-testid="sweep-outline">
    <p>
      {#if statusLine !== null}{statusLine}.{:else}stream live{#if $nowEdgeStore.timeMs !== null}
        — last event {formatClock($nowEdgeStore.timeMs)}{/if}.{/if}
      {#if headMs !== null}
        viewing {formatClock(headMs)} — time travel planted.
      {/if}
    </p>
    <ul aria-label="recorded runs">
      {#each outlineRuns as run (run.runId ?? "∅")}
        <li>
          <button
            type="button"
            data-action="client-nav:sweep.head"
            onclick={() => setHead(run.t0)}
          >
            {run.runId === null ? "not part of a run" : `run ${run.runId}`}
            · {run.eventCount} events
            · {formatClock(run.t0)}–{formatClock(run.t1)}
          </button>
        </li>
      {/each}
    </ul>
    {#if $sweepMarks.length > 0}
      <ul aria-label="marks (stored in this browser only)">
        {#each $sweepMarks as m (m.id)}
          <li>
            <button type="button" data-action="client-nav:sweep.head"
              onclick={() => setHead(m.timeMs)}>
              {m.label} · {formatClock(m.timeMs)}
            </button>
            <button type="button" data-action="client-nav:sweep.mark-remove"
              onclick={() => removeMark(m.id)}>
              Remove mark
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .sweep {
    position: relative;
    width: 100%;
    background: var(--ground-1);
    border-top: var(--hairline-w) solid var(--line-1);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  canvas {
    display: block;
    cursor: crosshair;
    touch-action: none;
  }
  /* WHO OWNS THE WHEEL, at a glance. The cockpit's own focus ring, drawn
   * INSET so it costs no layout and cannot push the band a pixel (activating
   * must move nothing). It is the right mark: the band having your wheel is
   * the same fact as the band having your keyboard, and focusing it is one of
   * the two ways to get here. No transition — the global focus rule is
   * zero-transition (§12.2), so there is nothing for reduced motion to undo. */
  .sweep[data-active="active"] {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }
  /* The affordance chip. Same chrome as the status chip so it reads as the
   * band talking, not as a new species of tooltip; bottom-right, the one
   * corner both the scrub grips and the status chip leave alone. */
  .activation-note {
    position: absolute;
    right: var(--sp-2);
    bottom: var(--sp-0);
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-3);
    background: var(--ground-2);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: 0 var(--sp-1);
    pointer-events: none;
    white-space: nowrap;
    z-index: 3;
  }
  .activation-note.live {
    color: var(--ink-1);
    border-color: var(--line-2);
  }
  .tick {
    position: absolute;
    top: 0;
    width: var(--tick-hit-w);
    height: 100%;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    z-index: 1;
  }
  .tick:hover {
    background: var(--layer-hover);
  }
  .tick:focus-visible {
    background: var(--layer-select);
  }
  /* Visually hidden, AT-readable — the parallel outline. */
  .outline {
    position: absolute;
    width: var(--hairline-w);
    height: var(--hairline-w);
    padding: 0;
    margin: calc(-1 * var(--hairline-w));
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
