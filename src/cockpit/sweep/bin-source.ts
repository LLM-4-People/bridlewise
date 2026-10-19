/**
 * The bin-source seam — the ONE interface the painter consumes, so the
 * `sweep.spectrum` block drops in WITHOUT painter rework (§6.6).
 *
 * Two implementations:
 *  - `clientWindowSource(events)` — v1: bins the already-streamed window
 *    client-side. Honest about its window: `partial: true` + `coverage()`
 *    drive the band's left-edge label.
 *  - `spectrumSource(read, localEvents)` — decodes the LANDED
 *    `sweep.spectrum` block's wire shape (server/blocks/spectrum.ts):
 *
 *      { header: { categories, errorRow, rows, bins, binMs, t0, t1,
 *                  events, unbinnable, attributedOnly, clamped },
 *        packed: string }   // base64 little-endian Int16Array, ROW-MAJOR BY
 *                           // CATEGORY: one row of `bins` cells per category,
 *                           // then the error-ridge row LAST (errorRow index).
 *
 *    The server's 8-category vocabulary (lifecycle/transport/agent/tool/
 *    outcome/effect/context/system) differs from the sweep's ledger stack
 *    (see categories.ts); `SERVER_CATEGORY_TO_SWEEP` merges server rows into
 *    sweep categories — merging is aggregation of real counts, never
 *    fabrication, and the decoder rejects rows it cannot map.
 *
 *    KNOWN SERVER SEMANTIC — CANONICAL, AND DECLARED ON THE WIRE: the
 *    server bins an error event BOTH in its event-type category row AND in
 *    the error row — the ridge is an OVERLAY redraw of events already
 *    counted in their category rows (§6.2 "error ridge on top"), never a
 *    ninth additive row. The response header states this as
 *    `errorRowIsOverlay: true` (server/blocks/spectrum.ts), and the decoder
 *    below REFUSES a payload that does not declare it — a decoder assuming
 *    additive rows fails loudly against the field, not silently against
 *    the math. Consequences: spectrum `totals` (stack + ridge) count error
 *    events twice; `header.events` remains the true matched-event count
 *    and is what honest labels should cite. Client-window bins do NOT
 *    double count (error events feed the ridge only). The drift test
 *    (tests/cockpit/sweep-spectrum.test.ts) pins the field on both ends.
 */

import {
  SweepHonestyViolation,
  type SweepBins,
  type SweepEvent,
  type SweepWindow,
} from "./types";
import { binEvents, eventCoverage } from "./bins";
import { SWEEP_CATEGORY_IDS } from "./categories";
import type { SweepCategoryId } from "./types";

export type BinSource = Readonly<{
  kind: "client-window" | "spectrum";
  /** True when the source only covers part of the ledger (client window).
   * Drives the honest left-edge coverage label. */
  partial: boolean;
  /** The real span of the underlying data, or null when nothing loaded. */
  coverage(): SweepWindow | null;
  /** Bin the source's data over `window` into `binCount` bins. */
  bins(window: SweepWindow, binCount: number): SweepBins;
  /** The events backing a time range (for zoomed-in causal rendering and
   * head/beat resolution). Spectrum sources return only what they have
   * locally (the streamed window) — never invented beats. */
  eventsIn(window: SweepWindow): readonly SweepEvent[];
}>;

/** v1: client-side binning over the already-streamed window. */
export function clientWindowSource(events: readonly SweepEvent[]): BinSource {
  // Sort once; binning and eventsIn both benefit. Copy — never mutate input.
  const sorted = [...events].sort((a, b) => a.timeMs - b.timeMs);
  return Object.freeze({
    kind: "client-window" as const,
    partial: true,
    coverage: () => eventCoverage(sorted),
    bins: (window: SweepWindow, binCount: number) =>
      binEvents(sorted, window, binCount),
    eventsIn: (window: SweepWindow) =>
      sorted.filter((e) => e.timeMs >= window.t0 && e.timeMs <= window.t1),
  });
}

// ── Spectrum wire shapes (mirror server/blocks/spectrum.ts, structurally) ──

export type SpectrumHeaderWire = Readonly<{
  categories: readonly string[];
  errorRow: number;
  /** CANONICAL wire declaration: the error row is an overlay of events
   * already counted in their category rows — never additive. The decoder
   * refuses a payload without it. */
  errorRowIsOverlay: true;
  rows: number;
  bins: number;
  binMs: number;
  t0: number | null;
  t1: number | null;
  events: number;
  unbinnable: number;
  /** True: run-attributed counts of the caller's own runs (chat/project
   * scope). False: a trace scope — one request's causal chain, including
   * its unattributed rows. Mirrors the block's header claim. */
  attributedOnly: boolean;
  clamped: boolean;
}>;

export type SpectrumReadWire = Readonly<{
  header: SpectrumHeaderWire;
  packed: string;
}>;

/**
 * Server spectrum category → sweep stack category. Same-named rows map to
 * themselves; the server's extra vocabulary merges into the nearest sweep
 * lane (agent work is run lifecycle; outcome/system events are the safety &
 * quality lane). Sweep-native ids are accepted too, so a future server
 * vocabulary alignment needs no client change.
 */
export const SERVER_CATEGORY_TO_SWEEP: Readonly<Record<string, SweepCategoryId>> =
  Object.freeze({
    lifecycle: "lifecycle",
    transport: "transport",
    agent: "lifecycle",
    tool: "tool",
    outcome: "safety",
    effect: "effect",
    context: "context",
    system: "safety",
    // sweep-native ids (forward-compat)
    user: "user",
    llm: "llm",
    safety: "safety",
  });

/** base64 → bytes, browser (atob) or node (Buffer). */
function bytesFromBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** bytes → base64 (test/reference encoder counterpart). */
function base64FromBytes(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * Reference encoder matching the SERVER's packing exactly (category-major
 * rows, error row last, little-endian Int16). Used by the round-trip tests;
 * also the executable definition of the layout for anyone reading.
 */
export function encodeSpectrumPacked(
  categoryRows: ReadonlyArray<ReadonlyArray<number>>,
  errorRow: readonly number[],
): string {
  const bins = errorRow.length;
  const rows = categoryRows.length + 1;
  const buf = new ArrayBuffer(rows * bins * 2);
  const view = new DataView(buf);
  for (let r = 0; r < categoryRows.length; r++) {
    const row = categoryRows[r]!;
    for (let b = 0; b < bins; b++) {
      view.setInt16((r * bins + b) * 2, row[b] ?? 0, true);
    }
  }
  for (let b = 0; b < bins; b++) {
    view.setInt16(((rows - 1) * bins + b) * 2, errorRow[b]!, true);
  }
  return base64FromBytes(new Uint8Array(buf));
}

/**
 * Decode a `sweep.spectrum` read into the ONE painter shape. Deny-by-
 * default: a payload with a wrong packed length, negative (wrapped) cells,
 * an unmappable category, a mis-declared error row, or a category-cell sum
 * that contradicts `header.events` (when not clamped) throws
 * SweepHonestyViolation — a lying payload never reaches pixels.
 *
 * Returns null for an honestly-empty scope (t0/t1 null): absence renders
 * as absence, not as a zero-width fabricated band.
 */
export function decodeSpectrumRead(read: SpectrumReadWire): SweepBins | null {
  const h = read.header;
  // The overlay semantics this decoder assumes must be DECLARED by the
  // payload (`errorRowIsOverlay: true` — see the module header). A payload
  // without the field could carry additive error rows; decoding it under
  // overlay math would misstate every total.
  if ((h as { errorRowIsOverlay?: unknown }).errorRowIsOverlay !== true) {
    throw new SweepHonestyViolation(
      "spectrum header does not declare errorRowIsOverlay: true — this decoder assumes the canonical overlay ridge and refuses a payload that will not say so",
    );
  }
  if (h.t0 === null || h.t1 === null || h.bins === 0 || h.binMs === 0) {
    if (h.events > 0) {
      throw new SweepHonestyViolation(
        `spectrum header claims ${h.events} events but carries no window/bins`,
      );
    }
    return null;
  }
  if (!Number.isInteger(h.bins) || h.bins < 1) {
    throw new SweepHonestyViolation(`spectrum bins must be a positive integer, got ${h.bins}`);
  }
  if (h.rows !== h.categories.length + 1 || h.errorRow !== h.categories.length) {
    throw new SweepHonestyViolation(
      `spectrum header geometry lies: rows=${h.rows} errorRow=${h.errorRow} for ${h.categories.length} categories`,
    );
  }
  const mapped: SweepCategoryId[] = [];
  for (const c of h.categories) {
    const m = SERVER_CATEGORY_TO_SWEEP[c];
    if (m === undefined) {
      throw new SweepHonestyViolation(`spectrum payload names unmappable category "${c}"`);
    }
    mapped.push(m);
  }
  const bytes: Uint8Array = bytesFromBase64(read.packed);
  const expectedBytes = h.rows * h.bins * 2;
  if (bytes.byteLength !== expectedBytes) {
    throw new SweepHonestyViolation(
      `spectrum packed length ${bytes.byteLength} bytes != expected ${expectedBytes} (${h.rows} rows × ${h.bins} bins × Int16)`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cell = (row: number, bin: number): number => {
    const v = view.getInt16((row * h.bins + bin) * 2, true);
    if (v < 0) {
      throw new SweepHonestyViolation(
        `spectrum cell [row ${row}, bin ${bin}] is negative (${v}) — Int16 overflow or corruption`,
      );
    }
    return v;
  };

  const sweepIndex = new Map<SweepCategoryId, number>();
  SWEEP_CATEGORY_IDS.forEach((id, i) => sweepIndex.set(id, i));

  const counts: number[][] = [];
  const errors: number[] = [];
  const totals: number[] = [];
  let categorySum = 0;
  let eventCount = 0;
  for (let b = 0; b < h.bins; b++) {
    const row = new Array<number>(SWEEP_CATEGORY_IDS.length).fill(0);
    for (let r = 0; r < h.categories.length; r++) {
      const v = cell(r, b);
      row[sweepIndex.get(mapped[r]!)!]! += v;
      categorySum += v;
    }
    const err = cell(h.errorRow, b);
    const stackSum = row.reduce((a, x) => a + x, 0);
    counts.push(row);
    errors.push(err);
    totals.push(stackSum + err);
    eventCount += stackSum + err;
  }
  // The category rows carry every matched event exactly once — check the
  // header's claim against the cells (exact unless the server clamped).
  if (!h.clamped && categorySum !== h.events) {
    throw new SweepHonestyViolation(
      `spectrum header claims ${h.events} events but category cells sum to ${categorySum}`,
    );
  }
  return Object.freeze({
    window: Object.freeze({ t0: h.t0, t1: h.t0 + h.bins * h.binMs }),
    binMs: h.binMs,
    categories: SWEEP_CATEGORY_IDS,
    counts,
    errors,
    totals,
    eventCount,
    source: "spectrum" as const,
  });
}

/**
 * A BinSource over a decoded spectrum plus the locally-streamed events (for
 * zoomed-in causal rendering — the spectrum carries density, not beats).
 * Re-binning to a sub-window aggregates the server bins that overlap it; a
 * server bin partially inside is included whole (counts are integers of
 * real events — splitting one would invent fractional events), so the
 * output window is snapped to server-bin edges and density stays honest at
 * every zoom.
 */
export function spectrumSource(
  read: SpectrumReadWire,
  localEvents: readonly SweepEvent[] = [],
): BinSource {
  const decoded = decodeSpectrumRead(read);
  const local = clientWindowSource(localEvents);
  if (decoded === null) {
    // Honestly empty server scope: fall back to the streamed window alone.
    return local;
  }
  const serverBinMs = decoded.binMs;

  const snap = (window: SweepWindow): SweepWindow => {
    const start = decoded.window.t0 +
      Math.floor((window.t0 - decoded.window.t0) / serverBinMs) * serverBinMs;
    const end = decoded.window.t0 +
      Math.ceil((window.t1 - decoded.window.t0) / serverBinMs) * serverBinMs;
    return Object.freeze({
      t0: Math.max(decoded.window.t0, start),
      t1: Math.min(decoded.window.t1, Math.max(end, start + serverBinMs)),
    });
  };

  return Object.freeze({
    kind: "spectrum" as const,
    partial: false,
    coverage: () => decoded.window,
    bins: (window: SweepWindow, binCount: number): SweepBins => {
      const snapped = snap(window);
      const firstServer = Math.round((snapped.t0 - decoded.window.t0) / serverBinMs);
      const serverSpan = Math.round((snapped.t1 - snapped.t0) / serverBinMs);
      const out = Math.min(binCount, Math.max(1, serverSpan));
      const perOut = serverSpan / out;
      const counts: number[][] = [];
      const errors: number[] = [];
      const totals: number[] = [];
      let eventCount = 0;
      for (let i = 0; i < out; i++) {
        const from = firstServer + Math.round(i * perOut);
        const to = firstServer + Math.round((i + 1) * perOut);
        const row = new Array<number>(decoded.categories.length).fill(0);
        let err = 0;
        for (let s = from; s < to && s < decoded.counts.length; s++) {
          const srcRow = decoded.counts[s]!;
          for (let c = 0; c < row.length; c++) row[c]! += srcRow[c]!;
          err += decoded.errors[s]!;
        }
        const total = row.reduce((a, b) => a + b, 0) + err;
        counts.push(row);
        errors.push(err);
        totals.push(total);
        eventCount += total;
      }
      return Object.freeze({
        window: snapped,
        binMs: (snapped.t1 - snapped.t0) / out,
        categories: decoded.categories,
        counts,
        errors,
        totals,
        eventCount,
        source: "spectrum" as const,
      });
    },
    eventsIn: (window: SweepWindow) => local.eventsIn(window),
  });
}
