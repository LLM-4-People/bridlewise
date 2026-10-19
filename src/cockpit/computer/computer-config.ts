/**
 * @config-owner — cockpit computer (spec-fixed §4.6 values).
 *
 * The admission controller's damping constants, owned here so the
 * config-owner law has one place to point at. These are SPEC values
 * (DESIGN-COCKPIT-V2 §4.6), not tuning knobs: dwell ≥8s, dismissal
 * learning at 3 per session.
 */

/** Dwell: a desk-line finding stays at least this long (§4.6). */
export const DWELL_MS = 8_000;

/** Dismissals in one session that retire a kind to ask-only (§4.6). */
export const DISMISSALS_TO_RETIRE = 3;
