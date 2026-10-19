/**
 * Time binning — pure functions turning recorded events into the density
 * skyline (§6.1/§6.2). Every bar traces to real events; gaps stay zero; the
 * guards below are mutation-tested (a fabricated bin count FAILS).
 *
 * No DOM, no Svelte, no Date.now() — fully deterministic from inputs.
 *
 * ── THE RIDGE COUNTS INCIDENTS, NOT ERROR EVENTS ──────────────────────────
 *
 * One failed tool call can be recorded as TWO error-flagged events by
 * design: the tool event (outcome failed) plus a dependent account parented
 * to it. Counting error EVENTS therefore double-counts a failure the reader
 * saw once — the band's own caption said "2 with errors" over one visible
 * refusal.
 *
 * WHICH EVENTS ARE ERROR-FLAGGED is the engine spectrum's predicate (the
 * preferred band source and the counting-policy owner): outcome `failed`
 * OR a recorded error code — never the event type, never a denial, never an
 * error category. `isErrorEvent` in ./categories mirrors it verbatim so the
 * fallback's ridge agrees with the spectrum's error row on the same ledger
 * rows, parented or not: a gate-block's denied inline account is not an
 * incident on either path (it lands in its residual category lane), and an
 * old UNPARENTED denied account agrees too instead of inflating the ridge.
 *
 * The folding policy lives HERE, at the choke point every error count
 * crosses (the ridge paints from it and the caption sums it, so the two can
 * never disagree): an error-flagged event whose `parentEventId` names
 * ANOTHER error-flagged event in the same list is a DEPENDENT account of an
 * incident already on the ridge, and does not feed the ridge. Its parent
 * (or whichever ancestor is the incident's root) is the one that counts.
 * Every event is still counted EXACTLY ONCE: a folded dependent lands in
 * its residual category lane — dropping it from all counts would understate
 * the events résumé, which is a different sentence on the same band.
 *
 * The pairing is DENY-BY-DEFAULT: a dependent folds ONLY on a proven parent
 * link (parentEventId naming an error-flagged event in the list). An
 * error-flagged event with no parent, with a parent that is not
 * error-flagged (a provider error parented to the run it failed), or with a
 * parent the list does not carry, is its OWN incident — proximity or shape
 * is never treated as pairing, because a guessed fold is the same
 * fabrication as a guessed count.
 */

import {
  SweepHonestyViolation,
  type SweepBins,
  type SweepEvent,
  type SweepWindow,
} from "./types";
import { SWEEP_CATEGORY_IDS } from "./categories";

/** Bin index for a time within a window — clamps the exact-right-edge event
 * (t === t1) into the last bin so the newest event is never dropped. */
export function binIndexFor(
  timeMs: number,
  window: SweepWindow,
  binCount: number,
): number | null {
  if (timeMs < window.t0 || timeMs > window.t1) return null;
  const binMs = (window.t1 - window.t0) / binCount;
  const idx = Math.floor((timeMs - window.t0) / binMs);
  return Math.min(idx, binCount - 1);
}

/**
 * Bin real events into a category-stacked density with the error ridge
 * separated. Events outside the window are excluded (they exist — the
 * coverage label owns saying so); the ridge counts error INCIDENTS — an
 * error-flagged event that is a dependent account of another error-flagged
 * event (its parent) does not feed the ridge, it feeds its residual
 * category lane, so every event is counted exactly once (see the module
 * header for the policy and its deny-by-default pairing).
 */
export function binEvents(
  events: readonly SweepEvent[],
  window: SweepWindow,
  binCount: number,
): SweepBins {
  // Degenerate geometry is a caller bug that would fabricate a band —
  // the honesty error type is the right loud failure.
  if (!(window.t1 > window.t0)) {
    throw new SweepHonestyViolation(`binEvents: window t1 (${window.t1}) must be > t0 (${window.t0})`);
  }
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new SweepHonestyViolation(`binEvents: binCount must be a positive integer, got ${binCount}`);
  }
  const catIndex = new Map<string, number>();
  SWEEP_CATEGORY_IDS.forEach((id, i) => catIndex.set(id, i));

  // The incident roots, by id: an error-flagged event is a ROOT unless its
  // parent is itself an error-flagged event in this list. The lookup is over
  // the whole input list (not just the window) — an incident belongs to the
  // event that began it, and a window edge must not split one into two.
  const errorIds = new Set<string>();
  for (const e of events) {
    if (e.isError) errorIds.add(e.eventId);
  }
  const isDependent = (e: SweepEvent): boolean =>
    e.isError && e.parentEventId !== null && errorIds.has(e.parentEventId);

  const counts: number[][] = Array.from({ length: binCount }, () =>
    new Array<number>(SWEEP_CATEGORY_IDS.length).fill(0),
  );
  const errors = new Array<number>(binCount).fill(0);
  let eventCount = 0;

  for (const e of events) {
    const bin = binIndexFor(e.timeMs, window, binCount);
    if (bin === null) continue;
    eventCount += 1;
    if (e.isError && !isDependent(e)) {
      errors[bin]! += 1;
    } else {
      counts[bin]![catIndex.get(e.category)!]! += 1;
    }
  }

  const totals = counts.map(
    (row, i) => row.reduce((a, b) => a + b, 0) + errors[i]!,
  );

  return Object.freeze({
    window,
    binMs: (window.t1 - window.t0) / binCount,
    categories: SWEEP_CATEGORY_IDS,
    counts,
    errors,
    totals,
    eventCount,
    source: "client-window" as const,
  });
}

/**
 * Internal-consistency guard — holds for EVERY SweepBins whatever its
 * source: totals must equal stack + ridge, nothing negative, geometry sane.
 * This is the only honesty check possible for server-packed spectrum bins
 * (the server owns row-level truth there).
 */
export function assertBinsConsistent(bins: SweepBins): void {
  if (bins.counts.length !== bins.errors.length || bins.counts.length !== bins.totals.length) {
    throw new SweepHonestyViolation(
      `bins arrays disagree on length: counts=${bins.counts.length} errors=${bins.errors.length} totals=${bins.totals.length}`,
    );
  }
  const span = bins.window.t1 - bins.window.t0;
  const expectedBinMs = span / bins.counts.length;
  if (Math.abs(bins.binMs - expectedBinMs) > 1e-6 * Math.max(1, expectedBinMs)) {
    throw new SweepHonestyViolation(
      `binMs ${bins.binMs} does not match window span ${span} / ${bins.counts.length} bins`,
    );
  }
  let sum = 0;
  for (let i = 0; i < bins.counts.length; i++) {
    let rowSum = 0;
    for (const c of bins.counts[i]!) {
      if (c < 0 || !Number.isFinite(c)) {
        throw new SweepHonestyViolation(`bin ${i} has an invalid category count ${c}`);
      }
      rowSum += c;
    }
    const errs = bins.errors[i]!;
    const total = bins.totals[i]!;
    if (errs < 0 || !Number.isFinite(errs)) {
      throw new SweepHonestyViolation(`bin ${i} has an invalid error count ${errs}`);
    }
    if (rowSum + errs !== total) {
      throw new SweepHonestyViolation(
        `bin ${i} total ${total} != stack ${rowSum} + errors ${errs} — a fabricated or dropped count`,
      );
    }
    sum += total;
  }
  if (sum !== bins.eventCount) {
    throw new SweepHonestyViolation(
      `bins claim ${bins.eventCount} events but sum to ${sum}`,
    );
  }
}

/**
 * Source-of-truth guard for client-binned data: every count must be
 * re-derivable from the events. A mutated (fabricated) bin fails here —
 * this is the mutation-tested "no fake pixels" contract (§6.6 honest data).
 */
export function assertBinsHonest(
  bins: SweepBins,
  events: readonly SweepEvent[],
): void {
  assertBinsConsistent(bins);
  const recount = binEvents(events, bins.window, bins.counts.length);
  for (let i = 0; i < bins.counts.length; i++) {
    if (bins.errors[i] !== recount.errors[i]) {
      throw new SweepHonestyViolation(
        `bin ${i} error ridge ${bins.errors[i]} not supported by events (recount ${recount.errors[i]})`,
      );
    }
    const row = bins.counts[i]!;
    const recountRow = recount.counts[i]!;
    for (let c = 0; c < bins.categories.length; c++) {
      if (row[c] !== recountRow[c]) {
        throw new SweepHonestyViolation(
          `bin ${i} category "${bins.categories[c]}" count ${row[c]} not supported by events (recount ${recountRow[c]})`,
        );
      }
    }
  }
}

/** The honest coverage of a set of streamed events: the span they actually
 * cover, or null when nothing is loaded. Drives the left-edge label
 * ("showing since 13:40 · full history loads when the spectrum block lands"). */
export function eventCoverage(events: readonly SweepEvent[]): SweepWindow | null {
  if (events.length === 0) return null;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const e of events) {
    if (e.timeMs < t0) t0 = e.timeMs;
    if (e.timeMs > t1) t1 = e.timeMs;
  }
  // A single event still covers an instant; give the window a minimal span
  // so it is a valid [t0, t1) — 1ms, not an invented history.
  return Object.freeze({ t0, t1: t1 > t0 ? t1 : t0 + 1 });
}
