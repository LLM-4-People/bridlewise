/**
 * THE FOCUS SEAM — how the SWEEP navigates the FLOW.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  THE `focusBeat` CONTRACT — v2. PUBLISHED HERE, CONSUMED BY `flow/`.
 * ════════════════════════════════════════════════════════════════════════
 *
 * The band knows two things about a position: the INSTANT under the pointer
 * and, when the client happens to hold the beat-level events for that
 * instant, the ledger EVENT ID at-or-before it. The flow knows beats and
 * their measured `at`. Neither can resolve the other's address alone, so the
 * seam carries BOTH and says which one is authoritative.
 *
 *   name     "focusBeat"
 *   target   dispatched on the sweep's root element, `bubbles: true`,
 *            `cancelable: true` — it reaches `document`, so the flow listens
 *            on `container.ownerDocument`.
 *   detail   FocusBeatDetail (below). NEVER a bare string in v2.
 *
 * WHAT THE FLOW MUST DO, precisely:
 *
 *  1. Resolve a target beat, in this order:
 *       a. `detail.eventId !== null` → the beat whose source record IS that
 *          ledger event (`beatById(eventId) ?? beatById("b-" + eventId)`).
 *          An exact hit is the authoritative answer — take it.
 *       b. otherwise, OR when (a) finds nothing → the LAST beat with
 *          `beat.at <= detail.timeMs`. This is the "nearest beat at-or-before
 *          an instant" rule: the reader asked "what was happening then", and
 *          the answer is the last fact that had happened by then — never the
 *          absolute-nearest beat, which can be in the future of the instant.
 *       c. no beat satisfies (b) — the instant precedes every loaded beat →
 *          do NOT scroll. Report it (`shell.hint`) ONLY when
 *          `detail.preview === false`; a preview that lands before the log
 *          is a normal consequence of moving a pointer and must stay silent.
 *
 *  2. Clamp to the head. When `detail.headMs !== null` the view is a past
 *     view: the flow must not resolve a beat with `at > detail.headMs`,
 *     whichever branch of (1) produced it. A navigation that jumped past the
 *     planted head would show the reader a fact their own banner says they
 *     are not looking at.
 *
 *  3. Reveal it:
 *       - `detail.preview === true`  (hover / scrub — a transient look):
 *         scroll the beat into view and mark it as the previewed beat.
 *         Do NOT move DOM focus, do NOT switch `follow` off permanently, do
 *         NOT open or expand anything, and do NOT issue a read. A preview is
 *         a look, not a commitment; releasing the pointer without a click
 *         must leave the flow's own focus where it was.
 *       - `detail.preview === false` (click / key — a commitment):
 *         set the flow's focused beat to it AND scroll it into view AND stop
 *         following the tail.
 *
 *  4. Scroll smoothly and interruptibly, and honour reduced motion. The
 *     flow's own `revealIndex(index, smooth)` already does exactly this —
 *     it scrolls by the height index (so an unmounted virtualized row is
 *     still reachable), uses `scrollTo({ behavior: "smooth" })`, and drops
 *     to an instant jump under `prefers-reduced-motion: reduce`. Pass
 *     `smooth = true` for this seam and do NOT hand-roll a rAF tween: two
 *     tweens racing is the jank this seam exists to avoid, and a native
 *     smooth scroll is interruptible — a second call retargets an in-flight
 *     one instead of queueing behind it, which is what a stream of coalesced
 *     previews needs.
 *
 *  5. Call `ev.preventDefault()` once handled — INCLUDING when the honest
 *     answer was "nothing to jump to". See LEGACY BRIDGE below.
 *
 * THE ONE-LINER THE FLOW NEEDS. `Flow.svelte`'s landed handler already
 * accepts `{ eventId?, timeMs? }` and routes it through `beatIndexAt` +
 * `scrubTo`, so band→chat navigation works the moment this ships. What it
 * still owes the contract is the HEAD CLAMP and the PREVIEW distinction —
 * add this as the first two statements of `onFocusBeat`:
 *
 *   const d = (ev as CustomEvent).detail; if (d !== null && typeof d === "object" && (d as FocusBeatDetail).contract === FOCUS_BEAT_CONTRACT) { const f = d as FocusBeatDetail; ev.preventDefault(); const cap = f.headMs === null ? f.timeMs : Math.min(f.timeMs, f.headMs); const byId = f.eventId !== null ? (beatById(f.eventId) ?? beatById(`b-${f.eventId}`)) : undefined; const index = byId !== undefined && byId.at <= cap ? indexOfBeat(byId.id) : beatIndexAt(cap); if (index < 0) { if (!f.preview) shell?.hint("nothing was recorded in this conversation at that moment"); return; } scrubTo(index, f.preview); return; }
 *
 * …with `scrubTo(index, preview)` gaining one line: when `preview` is true
 * it reveals WITHOUT writing `focusedId`/`follow`, so a pointer merely
 * passing over the band does not move the reader's own place in the log.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  LEGACY BRIDGE (temporary, delete-on-sight)
 * ════════════════════════════════════════════════════════════════════════
 *
 * v1 of this seam dispatched a bare `string` event id. Until the flow
 * acknowledges v2 by calling `preventDefault()`, `dispatchFocusBeat` watches
 * the `cancelable` return and re-dispatches the v1 string form behind an
 * unacknowledged COMMITMENT that carries an event id. It is idempotent
 * against the flow's own frame-coalesced `scrubTo` (both resolutions name
 * the same beat, and two calls in a frame are one scroll), so the belt and
 * the braces cannot fight.
 *
 * Previews are deliberately NOT bridged: the v1 path moves focus and
 * `shell.hint()`s on an unresolvable id, and doing either per hover frame
 * would be worse than doing nothing.
 *
 * DELETE the bridge (the `!handled` branch of `dispatchFocusBeat`) the moment
 * `flow/Flow.svelte` calls `preventDefault()` on this event —
 * `tests/cockpit/sweep-focus-seam.test.ts` ("THE DELETION CHECK") is the
 * standing check that it goes quiet on its own first.
 */

import { SweepHonestyViolation, type SweepEvent } from "./types";

/** The DOM event name — one spelling, imported by both sides. */
export const FOCUS_BEAT_EVENT = "focusBeat" as const;

/** Bumped when the detail shape changes. A receiver that does not recognise
 * the tag must ignore the event rather than guess at the fields. */
export const FOCUS_BEAT_CONTRACT = "sweep.focusBeat/2" as const;

/** How the reader arrived at this instant. */
export type FocusVia = "hover" | "scrub" | "click" | "key";

export type FocusBeatDetail = Readonly<{
  /** Always `FOCUS_BEAT_CONTRACT`. */
  contract: typeof FOCUS_BEAT_CONTRACT;
  /**
   * The ledger event id at-or-before `timeMs`, or null. Null is COMMON and is
   * not a failure: the band's density comes from the server spectrum, which
   * carries counts and no ids, so away from the streamed window there is
   * genuinely no id to name. The flow falls back to `timeMs`.
   */
  eventId: string | null;
  /** The instant under the pointer, epoch ms. ALWAYS present, always real
   * (it is `timeAtX` of a real view window — never a wall-clock stand-in). */
  timeMs: number;
  via: FocusVia;
  /** True for a transient look (hover/scrub), false for a commitment. */
  preview: boolean;
  /** The planted head at emit time, or null when live. The flow must not
   * resolve a beat later than this. */
  headMs: number | null;
  /** Monotonic emission counter — lets a receiver drop a stale async
   * resolution, and lets a test count emissions without timing games. */
  seq: number;
}>;

let seqCounter = 0;

/** Build a detail. The only constructor — `seq` is owned here. */
export function focusBeatDetail(
  args: Omit<FocusBeatDetail, "contract" | "seq">,
): FocusBeatDetail {
  seqCounter += 1;
  return Object.freeze({ contract: FOCUS_BEAT_CONTRACT, seq: seqCounter, ...args });
}

/** Reset for tests. */
export function resetFocusSeam(): void {
  seqCounter = 0;
  bridgeFires = 0;
}

let bridgeFires = 0;

/** How many times the legacy string bridge has fired since the last reset —
 * 0 once the flow handles v2. Test seam. */
export function legacyBridgeFireCount(): number {
  return bridgeFires;
}

/**
 * Dispatch the seam event (and, for a committed navigation the receiver did
 * not claim, the v1 string form behind it — see LEGACY BRIDGE).
 *
 * Returns true when a receiver called `preventDefault()` — i.e. the v2
 * contract is live on the other side.
 */
export function dispatchFocusBeat(
  host: EventTarget,
  detail: FocusBeatDetail,
): boolean {
  const ev = new CustomEvent(FOCUS_BEAT_EVENT, {
    detail,
    bubbles: true,
    cancelable: true,
  });
  const notCancelled = host.dispatchEvent(ev);
  const handled = !notCancelled;
  if (!handled && !detail.preview && detail.eventId !== null) {
    bridgeFires += 1;
    host.dispatchEvent(
      new CustomEvent(FOCUS_BEAT_EVENT, {
        detail: detail.eventId,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  return handled;
}

// ── Resolution: the band's half of "nearest beat at-or-before" ─────────────

/**
 * The last event at-or-before `timeMs` within `events`, capped by a planted
 * head. Returns null when nothing was recorded that early — absence, never
 * the nearest event in the future of the instant.
 *
 * `events` is assumed sorted by `timeMs` (every BinSource sorts); a binary
 * search keeps a 1200-bin drag off the O(n) path.
 */
export function eventAtOrBefore(
  events: readonly SweepEvent[],
  timeMs: number,
  headMs: number | null = null,
): SweepEvent | null {
  const cap = headMs === null ? timeMs : Math.min(timeMs, headMs);
  let lo = 0;
  let hi = events.length - 1;
  let best: SweepEvent | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = events[mid]!;
    if (e.timeMs <= cap) {
      best = e;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// ── Frame coalescing: one navigation per animation frame, never more ───────

export type FrameEmitterStats = Readonly<{
  /** How many values were offered (one per pointer tick). */
  offered: number;
  /** How many were actually emitted (one per frame, at most). */
  emitted: number;
  /** How many frames the emitter scheduled. `emitted <= frames` always. */
  frames: number;
}>;

export type FrameEmitter<T> = Readonly<{
  /** Offer a value. The LAST value offered before the frame runs wins —
   * an intermediate pointer position nobody ever saw is not a navigation. */
  offer(value: T): void;
  /** Emit immediately (a commitment: a click must not wait for a frame). */
  now(value: T): void;
  /** Drop a pending value without emitting (pointer left the band). */
  cancel(): void;
  stats(): FrameEmitterStats;
}>;

type RafLike = (cb: () => void) => number;
type CancelRafLike = (handle: number) => void;

/**
 * Rate-limit `emit` to one call per animation frame.
 *
 * THE POINT: a full-width drag across a 1200-bin band fires a `pointermove`
 * per pixel — up to ~1500 on a wide display — and every one of them would
 * otherwise be a navigation, i.e. a scroll retarget in the flow. Coalescing
 * to the frame turns that into ~60/second, which is the most a screen can
 * show. `stats()` makes the ratio measurable rather than asserted.
 */
export function frameCoalesced<T>(
  emit: (value: T) => void,
  raf: RafLike | undefined = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : undefined,
  cancelRaf: CancelRafLike | undefined = typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame
    : undefined,
): FrameEmitter<T> {
  let pending: { value: T } | null = null;
  let handle: number | null = null;
  let offered = 0;
  let emitted = 0;
  let frames = 0;

  const flush = (): void => {
    handle = null;
    const p = pending;
    pending = null;
    if (p === null) return;
    emitted += 1;
    emit(p.value);
  };

  return Object.freeze({
    offer(value: T): void {
      offered += 1;
      pending = { value };
      if (handle !== null) return;
      frames += 1;
      if (raf === undefined) {
        // No rAF (node/jsdom without one): emit synchronously. Still ONE
        // emission per offer batch because `pending` is cleared in flush.
        flush();
        return;
      }
      handle = raf(flush);
    },
    now(value: T): void {
      if (handle !== null && cancelRaf !== undefined) cancelRaf(handle);
      handle = null;
      pending = null;
      offered += 1;
      frames += 1;
      emitted += 1;
      emit(value);
    },
    cancel(): void {
      if (handle !== null && cancelRaf !== undefined) cancelRaf(handle);
      handle = null;
      pending = null;
    },
    stats(): FrameEmitterStats {
      return Object.freeze({ offered, emitted, frames });
    },
  });
}

/**
 * MUTATION-TESTED GUARD: navigations may never outnumber frames.
 *
 * A scrub that emits per pointer tick instead of per frame is the exact
 * regression this seam was built to prevent, and it is invisible in a
 * screenshot — it shows up as a flow that stutters under the pointer. So it
 * gets an assertion with a number in it rather than a comment.
 */
export function assertNavigationCoalesced(stats: FrameEmitterStats): void {
  if (stats.emitted > stats.frames) {
    throw new SweepHonestyViolation(
      `navigation emitted ${stats.emitted} times across ${stats.frames} frames — ` +
        `the scrub→navigate signal must be coalesced to the animation frame ` +
        `(${stats.offered} pointer ticks were offered)`,
    );
  }
}
