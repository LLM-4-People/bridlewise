/**
 * @config-owner — cockpit FLOW (the multi-workspace memory budget).
 *
 * A page holds N workspaces and each one keeps its beats warm so that
 * clicking its tab is an assignment rather than a rebuild (log.ts states the
 * whole arrangement). Warm data with no bound is a leak, so the bound lives
 * here, in one place, where an operator can see both halves of it at once.
 *
 * These are OPERATING numbers, not spec values: they trade memory against how
 * often a tab has to reload, and the honest way to change them is to change
 * them here rather than to argue with a literal buried in a cache.
 */

/**
 * How many workspaces may hold beats at once, least-recently-active evicted
 * first. Six is a working set, not a cache size: a person cycling tabs works
 * in three or four and reaches back to one or two more. The seventh has by
 * construction not been looked at in the longest time, and rebuilding it
 * costs one history read that the surface announces.
 */
export const MAX_WARM_LOGS = 6;

/**
 * How many beats every BACKGROUND workspace may hold between them. The count
 * above is the wrong bound on its own — three workspaces on very long
 * conversations are three warm logs and a great deal of memory. The workspace
 * ON SCREEN is exempt: it is what the reader is reading.
 */
export const BACKGROUND_BEAT_BUDGET = 20_000;

/**
 * How long the flow waits before mirroring the reading position into
 * `sessionStorage`.
 *
 * The in-memory hand-off on a tab switch is exact and synchronous, so this
 * delay costs nothing there; it exists only so surviving a browser RELOAD
 * does not put a storage round-trip inside the scroll handler.
 */
export const FLOW_VIEW_MIRROR_MS = 400;

/**
 * How close to the top the reader must be before the next page of OLDER
 * beats is asked for (DESIGN-PERFORMANCE §4).
 *
 * Not zero, and not a viewport-height: a page has to be requested, fetched,
 * ingested and measured before the reader arrives at the edge, and 800px is
 * roughly a screen of scrollback at `work` density — far enough ahead that a
 * page has landed by the time the reader reaches where it goes, close enough
 * that a reader who never scrolls back never fetches anything.
 *
 * The consequence of getting it wrong is not a defect either way: too small
 * and the reader briefly sees the honest "older messages not loaded yet"
 * line; too large and pages are fetched that nobody reads.
 */
export const OLDER_PAGE_TRIGGER_PX = 800;

/**
 * The height of the flow's HEAD ROW — the line above the oldest loaded beat
 * that says which of two very different things is true: "older messages are
 * not loaded yet", or "this is the beginning of the conversation".
 *
 * A DECLARED height, not a measured one, and it is the same discipline the
 * height index applies to every beat (`SHAPE_HEIGHT` in heights.ts): the row
 * is outside the Fenwick index — it is not a beat and has no index position —
 * so the virtualizer adds this constant to every offset and to the scroll
 * height. If the rendered row were taller than this number, every beat below
 * it would be positioned that many pixels wrong, which is why the row is one
 * line that cannot wrap and `flow-rest-geometry.spec.ts` measures it.
 */
export const HISTORY_HEAD_H = 34;

/**
 * How many languages the run pane's codebase section names before folding
 * the rest into the read. The pane is an inspector, not the repository
 * map's own surface — a project with a dozen languages shows its dominant
 * few and the full list stays one gesture away (the code.map block).
 */
export const RUN_PANE_LANGUAGE_CAP = 4;

/** A detail page bounds inspector DOM independently of conversation size. */
export const RUN_PANE_PAGE_SIZE = 24;

/**
 * How often the run pane re-asks for the repository map while the server is
 * still indexing (the block's 202 answer). Bounded by the pane being open:
 * the interval lives and dies with the component. Long enough that the
 * worker pool is never raced, short enough that "this view will fill in
 * when that finishes" is true on a human timescale.
 */
export const RUN_PANE_INDEXING_POLL_MS = 5_000;

/**
 * How long a rewind's FIRST press stays armed waiting for its confirm —
 * the two-press window every destructive verb in this product uses (the
 * custody undo's shape, the recycle verb's shape). A rewind withdraws the
 * named turn AND everything after it, which on the first beat of a loaded
 * page is the whole conversation, so it confirms like every other
 * irreversible-sounding act: first press states what will go, second press
 * inside this window takes it back. The withdrawal itself is reversible
 * (`restore from here` on the region's own beat), but the reader cannot
 * know that until the honest surface renders — the confirm is what makes
 * the one-press whole-conversation void unreachable.
 */
export const REWIND_CONFIRM_WINDOW_MS = 10_000;
