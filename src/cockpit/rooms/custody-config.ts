/**
 * @config-owner — CUSTODY (spec §7.2 values).
 *
 * The single owner of the Custody surfaces' tunable constants, following
 * the cockpit pattern (switch-config.ts, computer-config.ts): numbers live
 * here, behavior lives in the modules that import them.
 */

/**
 * The narrowest room that holds the PARCELS COLUMN and a readable DIFFERENCE
 * side by side (px, measured on the room's own box). THIS IS THE SHELL'S
 * FOLD, not a custody-private breakpoint. Re-export, never a second 1100.
 */
export { NARROW_FOLD_PX as CUSTODY_SPLIT_MIN_PX } from "../shell/config.ts";

/** Broker TTL for the custody.state / custody.history reads — short: the
 * working tree moves under us, and `custody:changed` invalidates sooner. */
export const CUSTODY_READ_TTL_MS = 5_000;

/** Second-press window for the flow's inline undo confirmation (ms). */
export const UNDO_CONFIRM_WINDOW_MS = 10_000;

/**
 * How long a freshly armed undo REFUSES to execute, however it is pressed
 * (ms).
 *
 * `undo` discards work that nothing in this product can bring back, and a
 * two-press arm/confirm is not a guard when the first press can be an
 * accident: a control that arrives under a moving pointer takes the click
 * that was aimed at whatever used to be there, and the confirmation then
 * sits one press away. Reported from live verification: a mis-click landed
 * in an armed undo confirmation nobody intended to open.
 *
 * So the destructive control is inert for this window and only becomes
 * pressable once a pointer (or keyboard focus) ARRIVES ON IT afterwards —
 * see `undoConfirmReady`. Long enough that no click already in flight can
 * carry through, short enough to be one deliberate gesture.
 */
export const UNDO_CONFIRM_SETTLE_MS = 400;
