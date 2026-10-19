/**
 * Causal structure from the recorded window (§6.3): runs open into causal
 * bands — turns as bands, tool calls as nested ticks — computed from real
 * event parentage (`runId` / `turnId` / `parentEventId`), never laid out by
 * the user, never invented.
 */

import type { SweepEvent } from "./types";

export type CausalTick = Readonly<{
  eventId: string;
  timeMs: number;
  category: SweepEvent["category"];
  isError: boolean;
  eventType: string;
  description: string;
}>;

export type CausalTurn = Readonly<{
  /** The turnId, or `"∅"` for run-level events with no turn attribution
   * (rendered as their own honest band, not merged into a real turn). */
  id: string;
  t0: number;
  t1: number;
  ticks: readonly CausalTick[];
}>;

export type CausalRun = Readonly<{
  /** The runId, or null for events not attributed to any run — the honest
   * "not part of a run" band (§3.7: unattributed renders as its own mark,
   * never hidden). */
  runId: string | null;
  t0: number;
  t1: number;
  eventCount: number;
  turns: readonly CausalTurn[];
}>;

/**
 * Group a window's events into run → turn → tick bands. Order is by first
 * event time (runs and turns both). Every event lands in exactly one tick —
 * counts are conserved (tested).
 */
export function buildCausalBands(
  events: readonly SweepEvent[],
): readonly CausalRun[] {
  const byRun = new Map<string | null, SweepEvent[]>();
  for (const e of events) {
    const key = e.runId;
    const list = byRun.get(key);
    if (list === undefined) byRun.set(key, [e]);
    else list.push(e);
  }

  const runs: CausalRun[] = [];
  for (const [runId, runEvents] of byRun) {
    runEvents.sort((a, b) => a.timeMs - b.timeMs);
    const byTurn = new Map<string, SweepEvent[]>();
    for (const e of runEvents) {
      const key = e.turnId ?? "∅";
      const list = byTurn.get(key);
      if (list === undefined) byTurn.set(key, [e]);
      else list.push(e);
    }
    const turns: CausalTurn[] = [];
    for (const [turnId, turnEvents] of byTurn) {
      turns.push(Object.freeze({
        id: turnId,
        t0: turnEvents[0]!.timeMs,
        t1: turnEvents[turnEvents.length - 1]!.timeMs,
        ticks: Object.freeze(turnEvents.map((e) => Object.freeze({
          eventId: e.eventId,
          timeMs: e.timeMs,
          category: e.category,
          isError: e.isError,
          eventType: e.eventType,
          description: e.description,
        }))),
      }));
    }
    turns.sort((a, b) => a.t0 - b.t0);
    runs.push(Object.freeze({
      runId,
      t0: runEvents[0]!.timeMs,
      t1: runEvents[runEvents.length - 1]!.timeMs,
      eventCount: runEvents.length,
      turns: Object.freeze(turns),
    }));
  }
  runs.sort((a, b) => a.t0 - b.t0);
  return Object.freeze(runs);
}

/** The nearest event to a time within a set — head/Enter resolution
 * (planting the head then pressing Enter focuses the containing beat). */
export function nearestEvent(
  events: readonly SweepEvent[],
  timeMs: number,
): SweepEvent | null {
  let best: SweepEvent | null = null;
  let bestDist = Infinity;
  for (const e of events) {
    const d = Math.abs(e.timeMs - timeMs);
    if (d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}
