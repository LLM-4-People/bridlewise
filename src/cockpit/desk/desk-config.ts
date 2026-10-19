/**
 * @config-owner — DESK (spec §3.4–3.5 values).
 *
 * The single owner of the open desk's tunable constants, following the
 * cockpit pattern (custody-config.ts, switch-config.ts, computer-config.ts):
 * numbers live here, behavior lives in the modules that import them.
 */

/** Broker TTL for the two desk reads — matches the blocks' declared 5s. */
export const DESK_READ_TTL_MS = 5_000;

/** Run-boundary debounce: the streaming flag flickers false BETWEEN model
 * turns of one run (same idiom as flow/ingest.ts and flow/run-stream.ts);
 * only a false that survives this window is the run actually ending — the
 * moment the desk re-measures the next turn's composition. */
export const DESK_RUN_END_DEBOUNCE_MS = 250;

/** How many recorded permission events the [why] scope walks back looking
 * for the tool's trip record. A trip older than this window renders as an
 * honest "not found in the last N records", never a guess. */
export const TRIP_EVENT_SEARCH_LIMIT = 200;

/** Default auto-trip threshold offered by the `,` setting sheet (the armed
 * value always wins once one is recorded). */
export const DEFAULT_TRIP_AFTER_FAILURES = 3;

/**
 * Lines of a composed body the SCOPE shows before folding. The fold always
 * NAMES what it is holding back ("N more lines"), so this is a reading
 * budget, never a truncation: a whole system prompt in one scroll is not
 * reading, it is drowning.
 */
export const SCOPE_BODY_FOLD_LINES = 30;

/** Bounds of the arm input — mirror of the server action's declared schema
 * (z.number().int().min(1).max(20)); the sheet clamps to what the verb
 * accepts instead of letting a refused value round-trip. */
export const TRIP_AFTER_MIN = 1;
export const TRIP_AFTER_MAX = 20;
