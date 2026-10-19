/**
 * The now edge + band status — the honesty core of the flight recorder.
 *
 * §6.2/§6.6: "the now edge ticks only on received events; a paused stream
 * renders a visible `stream reconnecting — last event 14:02:31` state on the
 * sweep itself, never a frozen fake-live band."
 *
 * Mechanics: `advanceNowEdge` is the ONLY way the edge moves, and it demands
 * a real event. `bandStatusLine` is the ONLY source of the band's status
 * text. `assertHonestBandRender` is the mutation-tested guard: a render that
 * shows a live tick without live status, or a non-live band without its
 * status line, throws.
 */

import {
  SweepHonestyViolation,
  type StreamState,
  type SweepEvent,
} from "./types";

export type NowEdgeState = Readonly<{
  /** Wall time of the newest genuinely received event; null before any. */
  timeMs: number | null;
  /** How many events have advanced the edge — the tick count. */
  ticks: number;
}>;

export const INITIAL_NOW_EDGE: NowEdgeState = Object.freeze({
  timeMs: null,
  ticks: 0,
});

/**
 * Advance the edge on a received event. The edge never moves backwards
 * (an out-of-order historical event ticks the count — it WAS received —
 * but cannot pull "now" into the past), and there is deliberately no
 * overload that advances on a timer or on Date.now().
 */
export function advanceNowEdge(
  state: NowEdgeState,
  received: SweepEvent,
): NowEdgeState {
  return Object.freeze({
    timeMs: state.timeMs === null
      ? received.timeMs
      : Math.max(state.timeMs, received.timeMs),
    ticks: state.ticks + 1,
  });
}

/** hh:mm:ss for band labels (local time — the band is an operator surface). */
export function formatClock(timeMs: number): string {
  const d = new Date(timeMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Full-precision ruler label (§6.2 hover = full precision). */
export function formatFullPrecision(timeMs: number): string {
  return `${formatClock(timeMs)}.${String(Math.floor(timeMs % 1000)).padStart(3, "0")}`;
}

/* `formatDayClock` (day + clock, "Jul 22 14:02") lived here for the band's
 * span caption, which was its only consumer. The caption is retired
 * (band-scope.ts states why), and a formatter nothing formats with is dead
 * code, so it went with it rather than being kept alive by its own test. */

/**
 * HOW MUCH TIME A WINDOW COVERS, in the words a person would use.
 *
 * Two units, largest first, and no more — `2m 55s`, `1h 12m`, `3d 4h`. The
 * exact endpoints are always stated beside it (`showing 18:21:07 →
 * 18:24:02`), so this is a restatement for the eye, not the only record of
 * the number: nothing here is the sole source of a measured value, and no
 * value is rounded up. Under a second the answer is the milliseconds
 * themselves, because at that zoom the milliseconds ARE the story.
 */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  if (total < 1000) return `${total}ms`;
  const s = Math.floor(total / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/**
 * The band's status line. `null` means the band may render as live —
 * anything else MUST be shown on the band (§6.6). Wording per spec.
 */
export function bandStatusLine(stream: StreamState): string | null {
  switch (stream.status) {
    case "live":
      return null;
    case "idle":
      // Idle = no live stream (history may still be on the band from the
      // query — that is the coverage label's story, not this line's).
      return stream.lastEventMs === null
        ? "not live — no stream open"
        : `not live — last event ${formatClock(stream.lastEventMs)}`;
    case "reconnecting":
      return stream.lastEventMs === null
        ? "stream reconnecting — no events received yet"
        : `stream reconnecting — last event ${formatClock(stream.lastEventMs)}`;
    case "ending":
      // The debounced run-boundary inference: the model's output has ended
      // and the run is finishing, but the socket has not closed — events may
      // still tick (the epilogue's findings, the terminal frame), so the band
      // must say the run is ENDING rather than claim the transport died. The
      // r72-class window (a slow epilogue holding this face for seconds) is
      // exactly the reader this line exists for.
      return stream.lastEventMs === null
        ? "stream ending — no events received yet"
        : `stream ending — last event ${formatClock(stream.lastEventMs)}`;
    case "closed":
      return stream.lastEventMs === null
        ? "stream closed — no events received"
        : `stream closed — last event ${formatClock(stream.lastEventMs)}`;
  }
}

/**
 * The status chip's TONE — the dark-cockpit law (§1.3): color is spent on
 * ACTIONABLE abnormality only. With no conversation open there is nothing a
 * stream could carry, so "no stream" is the NORMAL resting state → quiet
 * ink. The chip alerts only when a stream should exist and doesn't: a
 * conversation is open and the band is not live. A run FINISHING is not an
 * abnormality (`ending`: the stream still exists, the run is ending by
 * design) → quiet, exactly like live.
 */
export function bandStatusTone(
  stream: StreamState,
  conversationOpen: boolean,
): "quiet" | "alert" {
  if (stream.status === "live" || stream.status === "ending") return "quiet";
  return conversationOpen ? "alert" : "quiet";
}

/** What a render claims about the band — checked against the stream truth. */
export type BandRenderClaim = Readonly<{
  /** The render shows the live now-edge treatment (beam edge, live tick). */
  liveEdgeShown: boolean;
  /** The status line the render displays, or null if none. */
  statusLineShown: string | null;
  /** The now-edge time the render places the edge at, or null. */
  edgeTimeMs: number | null;
}>;

/**
 * Mutation-tested guard: a frozen band must never look live.
 *  - live treatment with a non-live stream → violation;
 *  - non-live stream without its status line → violation (frozen-fake-live);
 *  - a status line that contradicts `bandStatusLine` → violation;
 *  - an edge placed at a time no event reached → violation (ticking
 *    without an event).
 */
export function assertHonestBandRender(
  stream: StreamState,
  edge: NowEdgeState,
  claim: BandRenderClaim,
): void {
  const truth = bandStatusLine(stream);
  if (claim.liveEdgeShown && stream.status !== "live") {
    throw new SweepHonestyViolation(
      `band rendered a live now-edge while the stream is "${stream.status}" — a frozen band must never look live`,
    );
  }
  if (truth !== null && claim.statusLineShown !== truth) {
    throw new SweepHonestyViolation(
      `band status line must read "${truth}" but the render shows ${claim.statusLineShown === null ? "nothing" : `"${claim.statusLineShown}"`}`,
    );
  }
  if (claim.edgeTimeMs !== null) {
    if (edge.timeMs === null) {
      throw new SweepHonestyViolation(
        "band placed a now edge but no event was ever received — the edge may not tick without an event",
      );
    }
    if (claim.edgeTimeMs > edge.timeMs) {
      throw new SweepHonestyViolation(
        `band placed the now edge at ${claim.edgeTimeMs} ahead of the last received event ${edge.timeMs} — the edge may not advance without an event`,
      );
    }
  }
}
