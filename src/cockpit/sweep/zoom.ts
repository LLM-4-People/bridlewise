/**
 * Semantic zoom mapping — pure time↔pixel math and the representation
 * ladder (§6.3). One axis, always time: there is no y mapping here at all,
 * so 2D wandering is structurally impossible.
 *
 * Levels change REPRESENTATION, not geometry (§15): the same window maths
 * serves every level; `zoomLevelFor` decides what the painter draws.
 */

import type { SweepWindow } from "./types";

/** The representation ladder, coarse → fine (§6.3). */
export type ZoomLevel = "skyline" | "runs" | "causal" | "beats";

/** Level thresholds in ms-per-pixel. At a typical 1200px band:
 *  - skyline: > 30s/px (window > 10h) — runs are skyline mass
 *  - runs:    1s–30s/px — runs read as single blocks
 *  - causal:  50ms–1s/px — a run opens into turn bands + tool ticks
 *  - beats:   < 50ms/px (window < 1min) — ticks become beat previews
 */
export const ZOOM_THRESHOLDS = Object.freeze({
  runsMsPerPx: 30_000,
  causalMsPerPx: 1_000,
  beatsMsPerPx: 50,
});

/** The window may never collapse below this span — 250ms across the band. */
export const MIN_WINDOW_SPAN_MS = 250;

export function msPerPx(view: SweepWindow, widthPx: number): number {
  return (view.t1 - view.t0) / Math.max(1, widthPx);
}

export function zoomLevelFor(msPerPixel: number): ZoomLevel {
  if (msPerPixel > ZOOM_THRESHOLDS.runsMsPerPx) return "skyline";
  if (msPerPixel > ZOOM_THRESHOLDS.causalMsPerPx) return "runs";
  if (msPerPixel > ZOOM_THRESHOLDS.beatsMsPerPx) return "causal";
  return "beats";
}

/** Time at an x pixel within the band. */
export function timeAtX(view: SweepWindow, x: number, widthPx: number): number {
  return view.t0 + (x / Math.max(1, widthPx)) * (view.t1 - view.t0);
}

/** X pixel for a time within the band. */
export function xAtTime(view: SweepWindow, timeMs: number, widthPx: number): number {
  return ((timeMs - view.t0) / (view.t1 - view.t0)) * widthPx;
}

function clampWindow(view: SweepWindow, bounds: SweepWindow): SweepWindow {
  const span = Math.min(view.t1 - view.t0, bounds.t1 - bounds.t0);
  let t0 = view.t0;
  if (t0 < bounds.t0) t0 = bounds.t0;
  if (t0 + span > bounds.t1) t0 = bounds.t1 - span;
  return Object.freeze({ t0, t1: t0 + span });
}

/**
 * Zoom the view around an anchor time (the cursor), preserving the anchor's
 * position in the window (its fractional offset), clamped to the coverage
 * bounds and to MIN_WINDOW_SPAN_MS. `factor` > 1 zooms out, < 1 zooms in.
 */
export function zoomWindow(
  view: SweepWindow,
  anchorTimeMs: number,
  factor: number,
  bounds: SweepWindow,
): SweepWindow {
  const span = view.t1 - view.t0;
  const newSpan = Math.min(
    Math.max(span * factor, MIN_WINDOW_SPAN_MS),
    bounds.t1 - bounds.t0,
  );
  // Keep the anchor at the same fractional position in the window so the
  // instant under the cursor does not move (the tested invariant).
  const frac = (anchorTimeMs - view.t0) / span;
  const t0 = anchorTimeMs - frac * newSpan;
  return clampWindow(Object.freeze({ t0, t1: t0 + newSpan }), bounds);
}

/** Pan the view by a time delta, clamped to bounds. */
export function panWindow(
  view: SweepWindow,
  deltaMs: number,
  bounds: SweepWindow,
): SweepWindow {
  return clampWindow(
    Object.freeze({ t0: view.t0 + deltaMs, t1: view.t1 + deltaMs }),
    bounds,
  );
}

/**
 * The default view for a coverage span: the whole recorded window plus a
 * small right margin (2% of span) so the now edge is not glued to the
 * border. The margin is EMPTY space, painted as ground — never as data.
 */
export function defaultView(coverage: SweepWindow): SweepWindow {
  const span = Math.max(coverage.t1 - coverage.t0, MIN_WINDOW_SPAN_MS);
  return Object.freeze({ t0: coverage.t0, t1: coverage.t0 + span * 1.02 });
}

/** Scrub step for `[` `]`: one 200th of the view (≈ one bin), min 1ms. */
export function scrubStepMs(view: SweepWindow): number {
  return Math.max(1, Math.round((view.t1 - view.t0) / 200));
}
