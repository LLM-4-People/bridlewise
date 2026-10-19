/**
 * Sweep data adapter — maps the EXISTING streamed window (the timeline
 * store, src/state/timeline-query.ts) into SweepEvents. This is the v1
 * bin feed (§6.6 BUILD-NOW: "client-binned fallback over the already-
 * streamed window"); the honest coverage label comes from what this
 * actually holds.
 *
 * Allowlist: shared/*, src/state/* only. No old-component imports.
 *
 * Live ticking: the cockpit's run-stream owner (src/cockpit/flow/
 * run-stream.ts — the ONE `openRunStream` call) forwards each received
 * `TimelineEventRecord` to `ingestLiveSweepEvent` from its
 * `onTimelineEvent` handler, and ticks the edge per received model event
 * via `recordReceivedEvent` (edge + liveness only, no band point). The
 * edge advances ONLY through `recordReceivedEvent`, so it cannot tick
 * without a genuinely received event. `markStreamReconnecting` /
 * `markStreamClosed` are for the stream's error/close paths so a frozen
 * band shows its state (§6.6).
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { scopedTimelineEvents } from "../../state/timeline-query";
import { toSweepEvent, type SweepSourceRecord } from "./categories";
import type { SweepEvent } from "./types";
import { registerContextReset } from "../../state/store-registry";
import {
  recordReceivedEvent,
  setStreamStatus,
} from "./sweep-store";

/**
 * The in-scope streamed window as SweepEvents, deduplicated by eventId and
 * merged with live-received events (the query snapshot lags the stream;
 * the union is exactly what the client has genuinely received).
 * Unparseable wallTimes are dropped (never plotted at an invented time) and
 * counted in `sweepDroppedCount`.
 */

let dropped = 0;

// Live events received via SSE since the last query snapshot — merged so a
// ticking edge always has its event on the band even before refreshTimeline.
const liveBuffer = atom<readonly SweepEvent[]>([]);

export const sweepWindowEvents: ReadableAtom<readonly SweepEvent[]> = computed(
  [scopedTimelineEvents, liveBuffer],
  (records, live) => {
    dropped = 0;
    const out: SweepEvent[] = [];
    const seen = new Set<string>();
    for (const r of records) {
      const e = toSweepEvent(r as SweepSourceRecord);
      if (e === null) {
        dropped += 1;
        continue;
      }
      if (!seen.has(e.eventId)) {
        seen.add(e.eventId);
        out.push(e);
      }
    }
    for (const e of live) {
      if (!seen.has(e.eventId)) {
        seen.add(e.eventId);
        out.push(e);
      }
    }
    out.sort((a, b) => a.timeMs - b.timeMs);
    return Object.freeze(out);
  },
);

/** Events dropped for unparseable wallTime since the last recompute —
 * surfaced by the a11y outline as an honest count, never hidden. */
export function sweepDroppedCount(): number {
  return dropped;
}

/**
 * Forward a genuinely received stream record. Advances the now edge,
 * evaluates armed triggers, and buffers the event so the band shows it
 * before the next query refresh. Returns the projected event, or null when
 * the record's wallTime is unparseable (dropped honestly — the edge does
 * NOT advance on an unplottable record).
 */
export function ingestLiveSweepEvent(record: SweepSourceRecord): SweepEvent | null {
  const e = toSweepEvent(record);
  if (e === null) return null;
  recordReceivedEvent(e);
  liveBuffer.set(Object.freeze([...liveBuffer.get(), e]));
  return e;
}

/** The stream transport degraded — the band must say so (§6.6). */
export function markStreamReconnecting(): void {
  setStreamStatus("reconnecting");
}

/**
 * The debounced run-boundary INFERENCE — the run's model output has ended
 * and the run is finishing; the socket has NOT closed (the epilogue may still
 * deliver events, each of which reclaims "live"). Owned by run-stream.ts's
 * boundary watcher alone: an inference may not borrow "closed", the word the
 * stream's own terminal facts own (UIE-084 — a "closed" that flips back to
 * "live" was never a socket death, and wearing alarm ink it sent every
 * healthy epilogue's reader reaching for remedies).
 */
export function markStreamEnding(): void {
  setStreamStatus("ending");
}

/** The stream ended (run done / stream closed). */
export function markStreamClosed(): void {
  setStreamStatus("closed");
}

/** A fresh scope/stream: clear the live buffer (query owns history). */
export function resetLiveSweepBuffer(): void {
  liveBuffer.set(Object.freeze([]));
}

registerContextReset("sweepLiveBuffer", resetLiveSweepBuffer);
