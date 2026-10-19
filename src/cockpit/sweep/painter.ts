/**
 * The sweep canvas painter — one canvas, every zoom level (§6.1–§6.3).
 *
 * DOM-free: takes a minimal `CanvasLike` context so tests drive it with a
 * recording mock and assert honesty (no bar painted where no events are —
 * "gaps render as gaps"). The component owns devicePixelRatio scaling and
 * passes CSS-pixel geometry here.
 *
 * What paints where:
 *  - skyline / runs levels: stacked category density per bin, §12.3 colors,
 *    error ridge on top in `--alarm`;
 *  - causal / beats levels: run bands opening into turn bands + tool ticks
 *    (canvas carries the mass; the component adds DOM only near focus);
 *  - now edge (beam) ONLY when the stream is live — `assertHonestBandRender`
 *    is called on every frame, so a dishonest frame throws in dev AND prod;
 *  - marks/flags, head line, hover line;
 *  - non-live: a dimming veil (the status TEXT is DOM, for AT).
 */

import type { SweepBins, SweepMark, StreamState, SweepWindow } from "./types";
import type { SweepPalette } from "./categories";
import type { CausalRun } from "./causal";
import type { NowEdgeState } from "./now-edge";
import { assertHonestBandRender, bandStatusLine } from "./now-edge";
import { xAtTime, type ZoomLevel } from "./zoom";

/** The 2D-context subset the painter uses — mockable in Node tests. */
export type CanvasLike = {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
};

export type SweepFrame = Readonly<{
  widthPx: number;
  heightPx: number;
  view: SweepWindow;
  level: ZoomLevel;
  bins: SweepBins;
  causal: readonly CausalRun[] | null;
  palette: SweepPalette;
  stream: StreamState;
  nowEdge: NowEdgeState;
  /** Planted head (asOf ms) or null. */
  headMs: number | null;
  /** Hover time or null. */
  hoverMs: number | null;
  marks: readonly SweepMark[];
  reducedMotion: boolean;
}>;

const EDGE_W = 2;
/** Smallest visible causal tick, px — a real event may never round to 0px. */
const MIN_TICK_H = 2;

/** Paint one frame. Throws SweepHonestyViolation on a dishonest frame —
 * the guard is part of the paint path, not a test-only afterthought. */
export function paintSweep(ctx: CanvasLike, frame: SweepFrame): void {
  const { widthPx: w, heightPx: h, palette } = frame;
  const live = frame.stream.status === "live";

  // The frame's claim, checked BEFORE pixels — against the STREAM's own
  // record (not the frame's edge state, which would be self-consistent by
  // construction): an edge placed ahead of the last event the stream
  // received, or placed with nothing received, throws. This makes the
  // guard mutation-testable at the frame level (a fabricated nowEdge in a
  // frame fails here, in the paint path, dev and prod alike).
  assertHonestBandRender(
    frame.stream,
    { timeMs: frame.stream.lastEventMs, ticks: frame.stream.eventsReceived },
    {
      liveEdgeShown: live && frame.nowEdge.timeMs !== null,
      statusLineShown: bandStatusLine(frame.stream),
      edgeTimeMs: frame.nowEdge.timeMs,
    },
  );

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = palette.ground1;
  ctx.fillRect(0, 0, w, h);

  if (frame.level === "skyline" || frame.level === "runs") {
    paintDensity(ctx, frame);
  } else {
    paintCausalBands(ctx, frame);
  }

  paintMarks(ctx, frame);

  // Now edge — beam, live only (honesty asserted above).
  if (live && frame.nowEdge.timeMs !== null) {
    const x = xAtTime(frame.view, frame.nowEdge.timeMs, w);
    if (x >= -EDGE_W && x <= w + EDGE_W) {
      ctx.fillStyle = palette.beam;
      ctx.fillRect(Math.min(x, w - EDGE_W), 0, EDGE_W, h);
    }
  }

  // Planted head — beam line, full height.
  if (frame.headMs !== null) {
    const x = xAtTime(frame.view, frame.headMs, w);
    if (x >= 0 && x <= w) {
      ctx.fillStyle = palette.beam;
      ctx.fillRect(x - 0.5, 0, 1.5, h);
    }
  }

  // Hover ruler line (ink — the beam is reserved for live/head).
  if (frame.hoverMs !== null) {
    const x = xAtTime(frame.view, frame.hoverMs, w);
    if (x >= 0 && x <= w) {
      ctx.fillStyle = palette.ink3;
      ctx.fillRect(x, 0, 1, h);
    }
  }

  // Non-live veil: the band visibly not-live (text is DOM). Painted LAST so
  // a frozen band cannot pass for a live one at a glance.
  if (!live) {
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = palette.ground1;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

/** Stacked category skyline + error ridge. Empty bins paint NOTHING —
 * a gap in the record is a gap on the band (tested against a mock ctx). */
function paintDensity(ctx: CanvasLike, frame: SweepFrame): void {
  const { bins, palette, widthPx: w, heightPx: h } = frame;
  const n = bins.totals.length;
  if (n === 0) return;

  let maxTotal = 0;
  for (const t of bins.totals) if (t > maxTotal) maxTotal = t;
  if (maxTotal === 0) return; // nothing recorded in view — nothing painted

  const x0 = xAtTime(frame.view, bins.window.t0, w);
  const x1 = xAtTime(frame.view, bins.window.t1, w);
  const binW = (x1 - x0) / n;
  const usableH = h - 2; // 1px breathing top/bottom
  const barW = Math.max(0.5, binW - Math.min(1, binW * 0.15));

  for (let i = 0; i < n; i++) {
    if (bins.totals[i] === 0) continue; // the gap law
    const bx = x0 + i * binW;
    if (bx + binW < 0 || bx > w) continue;
    const row = bins.counts[i]!;
    let y = h - 1;
    for (let c = 0; c < bins.categories.length; c++) {
      const count = row[c]!;
      if (count === 0) continue;
      const segH = (count / maxTotal) * usableH;
      ctx.fillStyle = palette.categories[bins.categories[c]!];
      ctx.fillRect(bx, y - segH, barW, segH);
      y -= segH;
    }
    const errCount = bins.errors[i]!;
    if (errCount > 0) {
      const segH = Math.max(1, (errCount / maxTotal) * usableH);
      ctx.fillStyle = palette.alarm;
      ctx.fillRect(bx, y - segH, barW, segH);
    }
  }
}

/** Causal bands (§6.3): runs as housing bands, turns as inner bands, every
 * tick a real event at its real instant. Canvas mass only — the component
 * layers DOM previews near focus. */
function paintCausalBands(ctx: CanvasLike, frame: SweepFrame): void {
  const { palette, widthPx: w, heightPx: h } = frame;
  const runs = frame.causal ?? [];
  if (runs.length === 0) return;

  const bandTop = 2;
  const bandH = h - 4;

  for (const run of runs) {
    const rx0 = xAtTime(frame.view, run.t0, w);
    const rx1 = xAtTime(frame.view, run.t1, w);
    if (rx1 < 0 || rx0 > w) continue;
    // Run housing — a step up from the band ground, hairline edges.
    ctx.fillStyle = palette.ground2;
    ctx.fillRect(rx0, bandTop, Math.max(1, rx1 - rx0), bandH);
    ctx.fillStyle = palette.line1;
    ctx.fillRect(rx0, bandTop, 1, bandH);
    ctx.fillRect(rx1, bandTop, 1, bandH);

    // Turns: horizontal lanes inside the run band.
    const laneCount = Math.max(1, run.turns.length);
    const laneH = bandH / laneCount;
    for (let li = 0; li < run.turns.length; li++) {
      const turn = run.turns[li]!;
      const ty = bandTop + li * laneH;
      const tx0 = xAtTime(frame.view, turn.t0, w);
      const tx1 = xAtTime(frame.view, turn.t1, w);
      // Turn spine — a 1px causal baseline across the turn's real span.
      ctx.fillStyle = palette.line1;
      ctx.fillRect(tx0, ty + laneH - 1, Math.max(1, tx1 - tx0), 1);
      // Ticks — one per REAL event, category-colored, errors in alarm.
      for (const tick of turn.ticks) {
        const x = xAtTime(frame.view, tick.timeMs, w);
        if (x < -1 || x > w + 1) continue;
        ctx.fillStyle = tick.isError
          ? palette.alarm
          : palette.categories[tick.category];
        const tickH = Math.max(MIN_TICK_H, laneH * (tick.isError ? 0.9 : 0.6));
        ctx.fillRect(x, ty + laneH - tickH, frame.level === "beats" ? 2 : 1, tickH);
      }
    }
  }
}

/** Flags: user marks and armed-trigger firings — ink stems with a small
 * head; the flag TEXT lives in the a11y outline / hover, not on canvas. */
function paintMarks(ctx: CanvasLike, frame: SweepFrame): void {
  const { palette, widthPx: w, heightPx: h } = frame;
  for (const m of frame.marks) {
    const x = xAtTime(frame.view, m.timeMs, w);
    if (x < 0 || x > w) continue;
    ctx.fillStyle = m.origin === "arm" ? palette.alarm : palette.ink2;
    ctx.fillRect(x, 0, 1, h);
    ctx.fillRect(x, 0, 5, 4); // flag head, top
  }
}
