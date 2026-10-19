/**
 * Shared exposure registrations — `dedup` module.
 *
 * EVERY SIGNAL HERE IS DERIVED FROM THE LIVE LOWER LAYER, NOT AUTHORED. The
 * counts come from `layerSignalsOrNull()` — the process-wide dedup store's own
 * measurements (entries held, bytes saved, cross-call dedup-hit rate) — read
 * at value time, never a stored constant and never a fabricated number.
 *
 * THE HONEST-EMPTY CONTRACT: dedup is opt-in (`memory.dedupCompression`).
 * Until the lower layer is initialized, `layerSignalsOrNull()` is `null` and
 * every signal reads the EMPTY reading — all zeros, because a layer that has
 * not run has genuinely stored nothing. That is not a fabricated zero standing
 * in for a live producer: the producer (`layerSignalsOrNull`) reads the real
 * process-wide store, and an absent store means zero stores have occurred. The
 * moment dedup runs, the same signals read the real, non-zero counts. This
 * module is registered unconditionally so the signal surface is stable; the
 * value — not the registration — carries the enabled/disabled truth.
 *
 * THE ADJUSTABLE HALF: the three `memory.dedupCompression` facts the config
 * owns (the opt-in switches and the recognition mode) are registered here as
 * config-bound customizations, so the settings category this module declares
 * carries its real rows instead of rendering "nothing to adjust". The knobs
 * are projection-less by design: every runtime consumer
 * (`server/awareness/dedup-bridge.ts`) reads the config document at each call,
 * so `current` reads the document and `set` writes it through the config
 * gate — a saved change is read by the very next turn, which is what the
 * declared `immediate` effect states.
 */

import {
  registerCustomization,
  registerExposureModule,
  registerSignal,
  readBooleanCustomization,
  readStringCustomization,
  writeConfigCustomization,
} from "../index.ts";
import {
  layerSignalsOrNull,
  type LayerSignals,
} from "../../dedup-compression/index.ts";

/**
 * The empty-store reading: every count zero, because an uninitialized layer
 * has genuinely processed nothing. This is NOT a fabricated zero standing in
 * for a live producer — the producer (`layerSignalsOrNull`) reads the real
 * process-wide store, and an absent store means zero stores have occurred.
 * When dedup runs the same signals read the real, non-zero counts.
 */
const EMPTY: LayerSignals = {
  entries: 0,
  storedBytes: 0,
  originalBytes: 0,
  spaceSavedBytes: 0,
  spaceSavedPct: 0,
  dedupHitRate: 0,
  avgCompressionRatio: 1,
  avgCharSavingsPct: 0,
  rssDeltaBytes: 0,
  perModule: {},
};

/** Read the live layer signals, or the honest empty reading when dedup is off. */
function live(): LayerSignals {
  return layerSignalsOrNull() ?? EMPTY;
}

let dedupRegistered = false;
export function registerDedupExposure(): void {
  if (dedupRegistered) return;
  dedupRegistered = true;

  registerExposureModule({
    id: "dedup",
    title: "Duplicate and compression savings",
    purpose:
      "How much repeated content the dedup layer has folded into a single stored copy, and how much smaller the stored form is than what was sent.",
  });

  registerSignal({
    id: "dedup.entries",
    module: "dedup",
    name: "Stored Entries",
    description:
      "How many unique content blobs the dedup layer currently holds. Identical content shares one blob.",
    type: "gauge",
    unit: "count",
    value: () => live().entries,
  });
  registerSignal({
    id: "dedup.spaceSavedBytes",
    module: "dedup",
    name: "Space Saved",
    description:
      "Bytes no longer stored because duplicates were folded and the kept copy was compressed.",
    type: "gauge",
    unit: "bytes",
    value: () => live().spaceSavedBytes,
  });
  registerSignal({
    id: "dedup.spaceSavedPct",
    module: "dedup",
    name: "Space Saved Percent",
    description:
      "The share of the original bytes the dedup layer no longer stores, as a percentage.",
    type: "gauge",
    unit: "percent",
    value: () => live().spaceSavedPct,
  });
  registerSignal({
    id: "dedup.dedupHitRate",
    module: "dedup",
    name: "Repeat Hit Rate",
    description:
      "The share of store calls that matched content already held — a real cross-call duplicate — as a percentage.",
    type: "gauge",
    unit: "percent",
    value: () => live().dedupHitRate,
  });
  registerSignal({
    id: "dedup.avgCompressionRatio",
    module: "dedup",
    name: "Average Compression Ratio",
    description:
      "How much smaller the average stored blob is than its original, as a ratio (lower is smaller).",
    type: "gauge",
    unit: "ratio",
    value: () => live().avgCompressionRatio,
  });
  registerSignal({
    id: "dedup.avgCharSavingsPct",
    module: "dedup",
    name: "Average Character Savings",
    description:
      "The average share of characters removed from each piece of content before it was stored, as a percentage.",
    type: "gauge",
    unit: "percent",
    value: () => live().avgCharSavingsPct,
  });

  // --- Customizations (3) — the `memory.dedupCompression` config facts ---
  // The section's own declared defaults, in one place: these are the values
  // the config document schema's `.default()`s carry, so the registration and
  // the schema answer "what is this knob when untouched" identically. Both
  // switches ship OFF (opt-in by design); 'block' is the shipped recognition
  // mode (fast and effective for repeated passages in prose and code).
  const DEDUP_DEFAULTS = {
    enabled: false,
    llmInputDedup: false,
    dedupMode: "block",
  } as const;

  registerCustomization({
    id: "dedup.enabled",
    module: "dedup",
    name: "Keep one stored copy of repeated content",
    description:
      "On: each turn's content is stored so repeated passages are recognized against it, which is also what makes shrinking the model's input available. Off: nothing is stored, every savings reading in this area stays zero, and the model's input is sent unchanged.",
    type: "boolean",
    default: DEDUP_DEFAULTS.enabled,
    current: () =>
      readBooleanCustomization("memory.dedupCompression.enabled", DEDUP_DEFAULTS.enabled),
    set: (v) => writeConfigCustomization("memory.dedupCompression.enabled", v),
    contract: { effect: "immediate" },
    measuredBy: "dedup.entries",
    configPath: "memory.dedupCompression.enabled",
  });
  registerCustomization({
    id: "dedup.llmInputDedup",
    module: "dedup",
    name: "Send each repeated passage to the model once",
    description:
      "On: before each request, passages already sent to the model in this conversation are removed from its input, so the same words are not paid for twice. Off: the model is sent the full history every time.",
    type: "boolean",
    default: DEDUP_DEFAULTS.llmInputDedup,
    current: () =>
      readBooleanCustomization("memory.dedupCompression.llmInputDedup", DEDUP_DEFAULTS.llmInputDedup),
    set: (v) => writeConfigCustomization("memory.dedupCompression.llmInputDedup", v),
    contract: { effect: "immediate" },
    configPath: "memory.dedupCompression.llmInputDedup",
  });
  registerCustomization({
    id: "dedup.dedupMode",
    module: "dedup",
    name: "How repeats in the model's input are recognized",
    description:
      "Which closeness test decides two passages are the same when input is shrunk: 'none' never removes anything, 'line' matches whole lines, 'block' matches multi-line chunks (the shipped default), 'semantic' compares meaning using the code's structure and costs the most to run.",
    type: "enum",
    default: DEDUP_DEFAULTS.dedupMode,
    enum: ["none", "line", "block", "semantic"],
    current: () =>
      readStringCustomization("memory.dedupCompression.dedupMode", DEDUP_DEFAULTS.dedupMode),
    set: (v) => writeConfigCustomization("memory.dedupCompression.dedupMode", v),
    contract: { effect: "immediate" },
    configPath: "memory.dedupCompression.dedupMode",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetDedupRegistration(): void {
  dedupRegistered = false;
}
