/**
 * EXP454 — exposure signals for the dedup-compression lower layer. Uses the
 * shared exposure system pattern (registerSignal/registerAction) per EXP425.
 * Reports: dedup rate, compression ratio, space saved, CPU, RAM, per-module.
 */

import type { DedupCompressionStore } from "./lower-layer.ts";
import type { ModuleId } from "./config.ts";
import { round } from "../../shared/numeric-helpers.ts";

export interface LayerSignals {
  // global
  entries: number;
  storedBytes: number;
  originalBytes: number;
  spaceSavedBytes: number;
  spaceSavedPct: number;
  dedupHitRate: number;
  avgCompressionRatio: number;
  avgCharSavingsPct: number;
  rssDeltaBytes: number;
  // per-module
  perModule: Record<string, { entries: number; storedBytes: number; originalBytes: number; avgRatio: number; avgDedupPct: number }>;
}

/** Compute the layer's signals from a store. */
export function computeSignals(store: DedupCompressionStore): LayerSignals {
  const entries = store.entriesList();
  const perModule: LayerSignals["perModule"] = {};
  let storedBytes = 0, originalBytes = 0, totalRatio = 0, totalDedupPct = 0;
  // `dedupHits` reflects cross-call dedup (a `store*` call that hit an
  // already-stored content hash). It is read from the store's counter —
  // NOT computed from the entries list (which only contains UNIQUE
  // stored blobs; a dedup hit does NOT create a new entry). R44 fix for
  // the R31-V9 wired-but-inert bug where this was a local `let dedupHits
  // = 0` that was NEVER incremented → `dedupHitRate` was always 0.
  const dedupHits = store.dedupHitCount();
  // The total store-call count is the number of UNIQUE entries plus the
  // number of dedup hits (each hit was a call that did NOT create a new
  // entry). This is the denominator for the dedup-hit rate.
  const totalStoreCalls = entries.length + dedupHits;
  for (const e of entries) {
    storedBytes += e.blob.length;
    originalBytes += e.dedupReport.originalChars;
    totalRatio += e.compressionReport.compressionRatio;
    totalDedupPct += e.dedupReport.charReductionPct;
    const m = e.moduleId;
    if (!perModule[m]) perModule[m] = { entries: 0, storedBytes: 0, originalBytes: 0, avgRatio: 0, avgDedupPct: 0 };
    const pm = perModule[m]!;
    pm.entries++;
    pm.storedBytes += e.blob.length;
    pm.originalBytes += e.dedupReport.originalChars;
    pm.avgRatio += e.compressionReport.compressionRatio;
    pm.avgDedupPct += e.dedupReport.charReductionPct;
  }
  for (const m of Object.keys(perModule)) {
    const pm = perModule[m]!;
    if (pm.entries > 0) {
      pm.avgRatio /= pm.entries;
      pm.avgDedupPct /= pm.entries;
    }
  }
  const spaceSavedBytes = Math.max(0, originalBytes - storedBytes);
  return {
    entries: entries.length,
    storedBytes,
    originalBytes,
    spaceSavedBytes,
    spaceSavedPct: originalBytes > 0 ? round((spaceSavedBytes / originalBytes) * 100, 2) : 0,
    dedupHitRate: totalStoreCalls > 0 ? round((dedupHits / totalStoreCalls) * 100, 2) : 0,
    avgCompressionRatio: entries.length > 0 ? round(totalRatio / entries.length, 4) : 1,
    avgCharSavingsPct: entries.length > 0 ? round(totalDedupPct / entries.length, 2) : 0,
    rssDeltaBytes: store.rssDelta(),
    perModule,
  };
}

export interface LayerAction {
  type: "reset" | "set-module-mode" | "evict-oldest" | "evict-largest";
  moduleId?: ModuleId;
  count?: number;
}
