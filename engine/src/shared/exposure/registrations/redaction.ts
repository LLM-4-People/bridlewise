/**
 * Shared exposure registrations — `redaction` module.
 *
 * The web server's redaction owner (server/llm/redaction.ts) hides
 * sensitive values in tool-call arguments before anything leaves the
 * machine, and it keeps a bounded store of already-hidden results so an
 * identical replay (a retry, a loop, a parallel batch) is answered from
 * the saved copy instead of paying detection all over again. That store's
 * bound is the section's one config fact,
 * `redaction.toolCallArgumentsCacheEntries`, and this registration
 * publishes it as the section's one row: `current` reads the document
 * through the config store and `set` writes through the config write
 * gate, never a second source of truth.
 *
 * The store's own live count is served as a signal through an
 * installable source — the redaction owner installs it at boot, the same
 * shape the performance module's metrics source uses. With no source
 * installed the count reads zero, which is the honest statement that
 * nothing was measured in this process.
 */

import {
  registerCustomization,
  registerExposureModule,
  registerSignal,
} from "../index.ts";
import { readNumberCustomization, writeConfigCustomization } from "../config-binding.ts";
import { DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES } from "../../../kernel/config-contracts.ts";

/**
 * The measured re-hiding facts the signal serves. Every number is MEASURED
 * by the redaction owner's own memo counters (`toolCallArgumentsMemoStats`) —
 * nothing here is synthesized, and a store that has held nothing reads zero.
 */
export type RedactionMemoState = Readonly<{
  /** Distinct tool-request payloads the store currently holds. */
  entries: number;
}>;

export type RedactionMemoStateSource = () => RedactionMemoState;

let memoSource: RedactionMemoStateSource | null = null;

/**
 * Install the live re-hiding store source (the web redaction owner installs
 * this once at boot). Replaces any previous source — the owner is singular.
 */
export function installRedactionMemoSource(source: RedactionMemoStateSource): void {
  memoSource = source;
}

/** Remove the live store source (test/reset hook). */
export function clearRedactionMemoSource(): void {
  memoSource = null;
}

/** The honest fallback when no source is installed: nothing was measured. */
const NO_MEASUREMENTS: RedactionMemoState = Object.freeze({ entries: 0 });

function memoState(): RedactionMemoState {
  return memoSource?.() ?? NO_MEASUREMENTS;
}

/** Register the redaction module's settings. Idempotent. */
let redactionRegistered = false;
export function registerRedactionExposure(): void {
  if (redactionRegistered) return;
  redactionRegistered = true;

  registerExposureModule({
    id: "redaction",
    title: "Hiding sensitive values a second time",
    purpose:
      "When a tool request repeats, its sensitive values are hidden again from a saved copy instead of being detected all over again. This area decides how much that saved copy holds and shows how full it currently is.",
  });

  // --- Signals (1) ---
  // The store's own live occupancy — the knob below declares this signal as
  // its measurement, so the row's instrument cell gains its read verb
  // mechanically (the timeline mirror-signal pattern).
  registerSignal({
    id: "redaction.memoEntries",
    module: "redaction",
    name: "Saved hidden requests held",
    description:
      "How many distinct tool requests the saved-copy store currently holds. It never rises above the configured bound, and it empties whenever this machine learns or forgets a secret.",
    type: "gauge",
    unit: "requests",
    value: () => memoState().entries,
  });

  // --- Customizations (1) ---
  // The consumer sizes the store once at module evaluation
  // (server/llm/redaction.ts constructs it from
  // `getToolCallArgumentsCacheEntries`, which reads this leaf from the
  // config file), so a write lands in the document and the row's `current`
  // reads it back immediately, but the running process keeps its store size
  // until a restart — which is what the declared `restart` timing states.
  registerCustomization({
    id: "redaction.toolCallArgumentsCacheEntries",
    module: "redaction",
    name: "Distinct tool requests kept for instant re-hiding",
    description:
      "How many distinct tool requests the hiding step keeps an already-hidden copy of, so a request that repeats (a retry, a loop, a parallel batch) is answered from the saved copy instead of detecting its sensitive values all over again. Higher = more repeats answered instantly and more memory held, because each saved copy keeps the request's original text until it is dropped. Lower = less memory held but more repeats pay the full detection cost again. Takes effect after a restart.",
    type: "number",
    default: DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES,
    min: 1,
    unit: "requests",
    current: () => readNumberCustomization("redaction.toolCallArgumentsCacheEntries", DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES),
    set: (v) => writeConfigCustomization("redaction.toolCallArgumentsCacheEntries", v),
    contract: { effect: "restart" },
    measuredBy: "redaction.memoEntries",
    configPath: "redaction.toolCallArgumentsCacheEntries",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetRedactionRegistration(): void {
  redactionRegistered = false;
}
