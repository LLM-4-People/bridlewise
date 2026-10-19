/**
 * COCKPIT RENDER — the render layer's tunable numbers, in one place.
 * @config-owner
 *
 * Two kinds of number live here and nowhere else in `src/cockpit/render/**`:
 *
 *   FOLD THRESHOLDS — "how much before we fold". Every one is a FOLD, never
 *   a truncation: the renderers always report the exact remainder ("N more
 *   lines") and always keep it reachable. That is §1.1's absence law applied
 *   to length.
 *
 *   COST BUDGETS — the point past which a renderer declines and SAYS SO.
 *   They exist because the flow virtualizer measures beat heights on a 16ms
 *   frame, so an unbounded parse on a hostile or runaway input would be a
 *   dropped frame. Declining is reported to the reader, never silent.
 *
 * They live together because they are the same kind of decision — "how much
 * work is this view worth" — and a reviewer should see the whole policy at
 * once instead of hunting constants across eight files.
 */

// ── Fold thresholds ─────────────────────────────────────────────────────────

/**
 * A fenced code block inside a chat turn shows this many lines before
 * folding. Sized so a typical function or config snippet arrives whole
 * while a pasted 500-line file does not take over the turn.
 */
export const TURN_CODE_FOLD_LINES = 24;

/**
 * A tool cell (input or output) shows this many lines before folding.
 * Smaller than the turn budget: a tool beat is an instrument, and its cells
 * sit inside a card that must stay scannable.
 */
export const TOOL_CELL_FOLD_LINES = 16;

/**
 * The flow's micro-diff (§3.2 "the first hunk") shows this many body lines
 * of the first hunk before naming the remainder.
 */
export const MICRO_DIFF_LINES = 12;

/** A long string value inside a JSON tree shows this much before folding. */
export const JSON_STRING_PREVIEW_CHARS = 400;

/** Containers nested deeper than this start collapsed (a DEFAULT only). */
export const JSON_AUTO_OPEN_DEPTH = 2;

/** Containers wider than this start collapsed regardless of depth. */
export const JSON_AUTO_OPEN_MAX_CHILDREN = 30;

/** How much of a hint fits on a collapsed tool beat's one-line summary. */
export const ONE_LINE_HINT_CHARS = 120;

/**
 * The fisheye's GHOST line is tighter than the collapsed card: it shares a
 * single row with the beat's glyph and its verbs, so each side of the
 * input→output hint gets its own smaller budget.
 */
export const GHOST_ARG_CHARS = 48;
export const GHOST_OUT_CHARS = 40;

// ── Cost budgets (declined loudly, never silently) ──────────────────────────

/**
 * Markdown documents longer than this are rendered as plain text instead of
 * a parsed tree, and the reader is TOLD. The inline scanner does bounded
 * look-ahead per marker — linear on real prose, but degradable on
 * adversarial input (a megabyte of unmatched `*`). The cap keeps a hostile
 * or runaway turn from eating a frame.
 */
export const MAX_MARKDOWN_CHARS = 200_000;

/**
 * Source longer than this is not tokenized; it renders as plain text and
 * the decline is reported. Because CodeBlock folds BEFORE it highlights,
 * this is only reached by a caller that deliberately asked for the whole
 * document.
 */
export const MAX_HIGHLIGHT_CHARS = 120_000;

/**
 * An image a tool returned (a data: URI or base64 payload) is rendered
 * inline only up to this many DECODED bytes; past it the renderer declines
 * and says so, naming both numbers. The bound exists because the image
 * arrives as a string INSIDE the recorded output — a hostile or runaway
 * tool can return an arbitrarily large payload, and an <img> holding a
 * multi-hundred-megabyte data URI is a tab-killing allocation made by a
 * renderer that never asked how big it was. 10 MB comfortably clears every
 * real screenshot while refusing the pathological class.
 */
export const IMAGE_MAX_BYTES = 10_000_000;

// ── The live-stream instrument (flow/StreamPulse.svelte) ────────────────────

/** Cells in the token rail. The head wraps through them, one per arrival. */
export const STREAM_RAIL_CELLS = 14;

/**
 * The sliding window the streaming rate is measured over. Long enough that a
 * single lumpy chunk does not swing the figure, short enough that the number
 * still describes NOW rather than the whole turn.
 */
export const STREAM_RATE_WINDOW_MS = 2_000;

/**
 * Arrivals needed before a rate is reported at all. One arrival has no time
 * span, so no rate can be MEASURED from it — below this the readout says it
 * is waiting rather than showing a fabricated number.
 */
export const STREAM_RATE_MIN_SAMPLES = 2;

/**
 * How often a live elapsed numeral re-reads the clock.
 *
 * Owned here; started by `flow/elapsed-clock.ts`. Two surfaces tick: the
 * wait row (WaitLine.svelte) and a running tool beat (ToolBeat.svelte).
 *
 * This is the ONE timer those surfaces share, and it is deliberate. The
 * rail's motion law forbids a timer because a timer would claim ARRIVALS that
 * did not happen. A clock claims only that time passed, which is true whether
 * or not anything arrived — a different assertion, and the honest one to make
 * during a phase that has nothing else to report. 200ms is fast enough for a
 * tenth-of-a-second readout to look continuous and slow enough that the row
 * is not re-rendering every frame.
 */
export const WAIT_ELAPSED_TICK_MS = 200;

// ── Interaction timing ──────────────────────────────────────────────────────

/**
 * How long the copy button's confirmation stands before it returns to rest.
 * Long enough to read, short enough that the control is ready again by the
 * time a reader wants a second block.
 */
export const COPY_CONFIRM_MS = 1200;

// ── Inbound bounds (the artifact error channel) ─────────────────────────────

/**
 * Bounds on the two free-text fields an artifact's error report may carry
 * (`render/artifact-errors.ts`).
 *
 * The same kind of decision as everything above — "how much of this is this
 * view worth" — but pointed the other way: these apply to text arriving from
 * a SEALED FRAME running a document we do not control, so the bound is a
 * containment decision as much as a layout one. A page in a loop can emit an
 * unbounded error name and message, and the flow's virtualizer measures beat
 * heights on a 16ms frame.
 *
 * The name is short because an `Error` name is a word; the message carries a
 * stack-ish sentence and gets room for one.
 */
export const ARTIFACT_REPORT_MAX_NAME = 120;
export const ARTIFACT_REPORT_MAX_MESSAGE = 2000;
