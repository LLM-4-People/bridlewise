/**
 * THE ELAPSED CLOCK — one timer, every live duration that is a wall-clock
 * reading rather than an arrival.
 *
 * THREE SURFACES TICK, ONE INTERVAL. The wait row (WaitLine.svelte), a
 * running tool beat (ToolBeat.svelte), and StreamPulse while it is still
 * waiting for the first character all need to re-read `Date.now()` so an
 * elapsed numeral stays honest. Duplicating the `setInterval` is how two
 * clocks would drift onto different cadences; this module is the one
 * interval, driven at the cadence `WAIT_ELAPSED_TICK_MS` owns.
 *
 * A CLOCK IS NOT AN ARRIVAL. StreamPulse still forbids a timer that claims
 * characters landed. This claims only that time passed, which is true
 * whether or not anything arrived — WaitLine's law, extended to a tool
 * that is still executing and to the pre-first-token window on the rail.
 *
 * The caller owns the `$state` and the `$effect` that decides WHETHER to
 * tick (a wait with a start timestamp; a tool whose status is `running`).
 * This owns HOW the tick is taken.
 */
import { WAIT_ELAPSED_TICK_MS } from "../render/render-config.ts";

/** Start the shared elapsed tick. Returns the disposer for the effect. */
export function startElapsedTick(onTick: (now: number) => void): () => void {
  const id = setInterval(() => {
    onTick(Date.now());
  }, WAIT_ELAPSED_TICK_MS);
  return () => clearInterval(id);
}

/** One decimal second, never negative — the wait row and the rail share it. */
export function fmtElapsedSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}
