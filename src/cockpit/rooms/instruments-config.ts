/**
 * INSTRUMENTS — tunable numeric constants (DESIGN-COCKPIT-V2 §8).
 *
 * Same discipline as switch-config/custody-config: SPEC-derived numbers and
 * feed tunables live here as named constants so no component or feed module
 * carries an inline literal. The CELL GEOMETRY does NOT live here — it is
 * visual and belongs to `src/cockpit/tokens.css` (`--instrument-w/h`),
 * where `instruments-size-owner.test.ts` pins it to the §8.2 numbers.
 *
 * @config-owner instruments room constants (feed cadence, ring buffer, spark law)
 */

/**
 * Signal sampling cadence (ms) over the EXISTING signal channel
 * (`GET /api/schema/ui/values` via client.getUiSchemaValues — the same
 * value snapshot the schema widgets always read; the old shell polled it
 * at this same cadence). Every tick is a real measurement of every
 * registered signal; the feed ingests whatever the channel delivers and
 * fabricates nothing between ticks.
 */
export const SIGNALS_POLL_MS = 5000;

/**
 * Measured points kept per signal (the §8.3 ring buffer). 64 points at the
 * 5s cadence ≈ the last 5 minutes — enough for a 96px spark where anything
 * finer than ~1.5px/point cannot be read anyway.
 */
export const SIGNAL_RING_CAPACITY = 64;

/** §8.3 — the no-broken-chart law's floor: a spark exists only from this
 * many measured points. Below it the CELL renders the absence state and
 * the Spark component throws in dev. */
export const SPARK_MIN_POINTS = 2;

/**
 * §8.3 — "no interpolation across gaps; gaps render as gaps": two adjacent
 * measured points further apart than this multiple of the sampling cadence
 * are NOT connected by a line — the silence between them renders as blank
 * time, because nothing was measured there.
 */
export const SPARK_GAP_FACTOR = 2.5;

/** Pinned HORIZON monitors — the cockpit storage convention
 * (`cockpit.<area>.<thing>.v1`, guarded localStorage, validated on load —
 * same shape as `cockpit.sweep.marks.v1`). */
export const MONITORS_STORAGE_KEY = "cockpit.instruments.monitors.v1";

// ── The exposure actions fold ────────────────────────────────────────────────
//
// The room's "act on the system" surface: each module group that declares
// exposure actions folds them under its grid, and the fold's verbs execute
// them through the single wire door (client.ts executeSchemaAction → POST
// /api/schema/ui/actions/:id). The press grammar is two-shaped — a
// destructive action needs a deliberate second press (the recycle bin's and
// the editor delete's precedent), everything else fires on one — and these
// are the windows that make the second press a DECISION rather than a
// double-click's second half.

/** How long after arming a destructive verb a confirming press is still the
 * SAME gesture settling (below it, two clicks of one double-click must not
 * fire) — the recycle confirm's settle window. */
export const ACTION_ARM_SETTLE_MS = 150;

/** How long an armed destructive verb stays armed before it reverts to its
 * rest face (press again to re-arm) — the recycle confirm's window. */
export const ACTION_ARM_WINDOW_MS = 4000;

/** Longest rendered action result on the fold's answer line — the result is
 * real JSON from the action's own execute; beyond this it truncates with an
 * ellipsis (the full value is the verb's title territory). */
export const ACTION_RESULT_TRUNCATE_CHARS = 160;
