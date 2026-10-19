/**
 * @config-owner — EDITOR ROOM (the room's tunable constants).
 *
 * The cockpit's token file owns every VISUAL constant (§12); this owns the
 * behavioural ones — the thresholds a sentence quotes, the windows a guard
 * measures against. Both kinds have exactly one owner so a number can never
 * drift between the rule that enforces it and the words that state it.
 */

/**
 * Past this many bytes a file is not opened on a click. The room states the
 * measured size and offers the read as a separate, deliberate act.
 *
 * The number is the point where a plain textarea stops being an editor: a
 * ~256KB source file is ~6,000 lines, which the browser edits comfortably;
 * a 5MB minified bundle on one line does not.
 */
export const LARGE_FILE_BYTES = 256 * 1024;

/**
 * How long a draft write-through may be suppressed after one has just run.
 *
 * Leading-edge: the FIRST keystroke persists immediately, then further writes
 * are coalesced for this long and always followed by a trailing write. So the
 * exposure of an unexpected process death is bounded by this window, and a
 * deliberate reload has none at all (the flush on pagehide runs first).
 */
export const DRAFT_FLUSH_MS = 300;

/**
 * How long an armed delete confirmation stays armed.
 *
 * Long enough to read the file's name and type it; short enough that a
 * confirmation left armed while you did something else has expired by the time
 * you come back to the keyboard.
 */
export const DELETE_CONFIRM_WINDOW_MS = 20_000;

/**
 * How long the confirm control must have EXISTED before a pointer arrival on
 * it can count as deliberate.
 *
 * A control that appears under a stationary pointer reports an arrival at the
 * instant it was armed. Requiring the arrival to be later than this is what
 * separates "the user moved onto this button" from "a click already travelling
 * toward whatever used to be here landed on it".
 */
export const DELETE_CONFIRM_SETTLE_MS = 350;

/** Tree page size — the entry cap asked of the server per directory read. */
export const TREE_ENTRY_LIMIT = 2000;

/** The width at which the two panes stop fitting side by side. THIS IS THE
 * SHELL'S FOLD, not an editor-private breakpoint. Re-export, never a second 1100. */
export { NARROW_FOLD_PX as EDITOR_SPLIT_MIN_PX } from "../shell/config.ts";
