/**
 * SWEEP core types — the flight recorder's data vocabulary (DESIGN-COCKPIT-V2
 * §6). Pure types, no DOM, no Svelte — shared by the pure binning/zoom/ribbon
 * functions, the canvas painter, and the components.
 *
 * Data honesty (§1.1, §6.6): every type here describes REAL recorded events.
 * There is no synthetic-placeholder shape anywhere in this module — absence is
 * `null` / empty arrays, never invented values.
 */

/**
 * The 8 sweep display categories (§12.3: an 8-hue wheel at equal lightness,
 * hues ≥40° apart). Errors are NOT a category — they render as the error
 * ridge on top of the stack in `--alarm` (§6.2), counted separately so no
 * event is double-counted.
 */
export type SweepCategoryId =
  | "lifecycle"   // run · agent · task · subtask
  | "user"        // message (the user's turn)
  | "llm"         // turn · provider (the model speaking / model calls)
  | "tool"        // tool · tool-input · tool-output
  | "context"     // context · memory
  | "transport"   // header · token · cost · timing · resource
  | "effect"      // file-effect · test · git · commit · … · filesystem
  | "safety";     // hallucination · steering · bias · self-healing · quality

/** A recorded ledger event, projected to what the sweep needs. Always built
 * from a real `TimelineEventRecord` (or the per-chat `TimelineRef`) — never
 * constructed from anything that was not received. */
export type SweepEvent = Readonly<{
  eventId: string;
  /** Epoch milliseconds parsed from the record's `wallTime` (ISO string). */
  timeMs: number;
  category: SweepCategoryId;
  /** True when the event IS a failure (error eventType, failed/denied
   * outcome, or a recorded errorCategory). Error events feed the ridge,
   * not the category stack. */
  isError: boolean;
  eventType: string;
  /** The ledger's own outcome word (succeeded/failed/cancelled/denied), or
   * null when the event carries none. Real columns the record holds; the
   * ARM predicate grammar binds them (event.outcome, event.errorCode). */
  outcome: string | null;
  /** The typed error code the record carries on a failure, or null. */
  errorCode: string | null;
  runId: string | null;
  turnId: string | null;
  parentEventId: string | null;
  description: string;
}>;

/** A half-open time window [t0, t1) in epoch ms; t1 > t0 always. */
export type SweepWindow = Readonly<{ t0: number; t1: number }>;

/**
 * Time-binned density counts — the ONE shape the painter consumes, whatever
 * produced it (client-side binning today, the `sweep.spectrum` block's packed
 * bins tomorrow — §6.6). `counts[bin][catIndex]` are non-error events (plus
 * error events that are DEPENDENT accounts of another error event — see
 * bins.ts's incident policy); `errors[bin]` is the ridge, counting error
 * INCIDENTS, never double-counting a paired refusal; `totals[bin]` is their
 * sum. The invariant `totals == sum(counts) + errors` is enforced by
 * `assertBinsConsistent`, so every event is counted exactly once either way.
 */
export type SweepBins = Readonly<{
  window: SweepWindow;
  binMs: number;
  categories: readonly SweepCategoryId[];
  counts: ReadonlyArray<ReadonlyArray<number>>;
  errors: readonly number[];
  totals: readonly number[];
  /** Total events represented — equals the number of in-window source
   * events for client binning; server-reported for spectrum bins. */
  eventCount: number;
  source: "client-window" | "spectrum";
}>;

/**
 * Stream connection state, rendered ON the band (§6.6): a frozen band must
 * never look live. `lastEventMs` only ever advances on a genuinely received
 * event (see now-edge.ts).
 *
 * WHO MAY CLAIM WHAT (the UIE-084 ruling — the words are transport facts, and
 * each one has exactly one honest owner):
 *  - `live`        only a genuinely received event (recordReceivedEvent —
 *                  "receiving an event IS proof of liveness"; it also
 *                  reclaims this word from every other status, which is what
 *                  makes `ending` below revisable rather than sticky);
 *  - `reconnecting` only EventSource's own error+retry (a transport fact);
 *  - `ending`      only the debounced run-boundary inference (run-stream.ts
 *                  watchRunEnd): the run's MODEL OUTPUT has stopped, the
 *                  epilogue may still deliver events, and the socket has NOT
 *                  closed — an inference may never borrow the transport's
 *                  own word for death, or every healthy epilogue reads as a
 *                  disconnect;
 *  - `closed`      only the stream's own endings — the terminal error frame,
 *                  the lost connection, and the run's natural done/cancelled
 *                  close. A status a received event can still flip back from
 *                  was never a close.
 */
export type StreamStatusKind = "idle" | "live" | "reconnecting" | "ending" | "closed";

export type StreamState = Readonly<{
  status: StreamStatusKind;
  /** Wall time of the last GENUINELY received event, or null if none. */
  lastEventMs: number | null;
  eventsReceived: number;
}>;

export const INITIAL_STREAM_STATE: StreamState = Object.freeze({
  status: "idle",
  lastEventMs: null,
  eventsReceived: 0,
});

/** A flag on the band: a user mark (`m`) or an armed-trigger firing. v1 is
 * client-stored — the `storage` field keeps that honest until `arm.flags`
 * lands (§6.6 NEEDS-BACKEND). */
export type SweepMark = Readonly<{
  id: string;
  timeMs: number;
  label: string;
  createdAtMs: number;
  origin: "user" | "arm";
  storage: "local";
}>;

/** Thrown by the honesty guards — a fabricated bin, a ticking now-edge
 * without an event, a frozen band rendered as live. These are bugs, loudly. */
export class SweepHonestyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepHonestyViolation";
  }
}
