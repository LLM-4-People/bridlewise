/**
 * WHICH TABS FIT — the arithmetic, kept out of the component.
 *
 * THE RULE THIS ENCODES: a tab is rendered WHOLE or not at all. The cockpit
 * already refused a clipped word once — the room rail below 1100px used to
 * be sliced by its own overflow and read "USTODY · SETTINGS" — and the
 * answer there was to FOLD, not to clip. A tab says what a workspace is;
 * half of "web-interface ▸ refactor the reader path" is not a shorter name,
 * it is a different one. So the strip shows the tabs it can show in full and
 * folds the rest behind one control, exactly as the rail does.
 *
 * THE ACTIVE TAB IS ALWAYS IN THE WINDOW when any tab is. The window slides
 * (like a terminal's) rather than reordering: a strip that re-sorted itself
 * on every click would move the tab you are aiming at, which is the one
 * thing a pointer surface may never do. `start` is carried in from the last
 * pass so the window holds still until something actually forces it.
 *
 * WHEN NOT EVEN ONE TAB FITS the honest answer is zero tabs and the fold —
 * and the shell puts the place chip back, so the active workspace is still
 * named on screen. A tab and the place chip never both state the same pair
 * (§1.4, one manifestation per fact).
 *
 * Widths come from a hidden measuring row in the component, so this function
 * never has to guess at a label's width, and a tab that has never been
 * visible is measured exactly like one that has.
 *
 * Guard: tests/cockpit/workspace-strip.test.ts § "the fit".
 */

export type FitInput = Readonly<{
  /** Natural, unclipped width of every tab, in strip order. */
  widths: readonly number[];
  /** Gap between adjacent controls. */
  gap: number;
  /** Total width the strip has to work with. */
  available: number;
  /** The `+` — always rendered, so its width always comes off the top. */
  newButton: number;
  /** The overflow control — costs width only when it is needed. */
  fold: number;
  /** Index of the active workspace (-1 when there is none). */
  activeIndex: number;
  /** The window start from the previous pass (stability). */
  start: number;
}>;

export type Fit = Readonly<{
  start: number;
  count: number;
  /** Whether the ACTIVE tab is one of the rendered ones. */
  activeVisible: boolean;
}>;

/** Width of `k` tabs starting at `from`, gaps included. */
export function span(
  widths: readonly number[],
  from: number,
  k: number,
  gap: number,
): number {
  if (k <= 0) return 0;
  let total = 0;
  for (let i = from; i < from + k && i < widths.length; i += 1) total += widths[i] ?? 0;
  return total + (k - 1) * gap;
}

/** How many tabs from `from` fit in `room`. */
function fitsFrom(widths: readonly number[], from: number, room: number, gap: number): number {
  let k = 0;
  while (from + k < widths.length && span(widths, from, k + 1, gap) <= room) k += 1;
  return k;
}

export function fitTabs(input: FitInput): Fit {
  const { widths, gap, available, newButton, fold, activeIndex } = input;
  const n = widths.length;
  if (n === 0) return { start: 0, count: 0, activeVisible: false };

  // Everything fits: no fold, no window, no decisions.
  const roomAll = available - newButton - gap;
  if (span(widths, 0, n, gap) <= roomAll) {
    return { start: 0, count: n, activeVisible: activeIndex >= 0 && activeIndex < n };
  }

  const room = available - newButton - fold - gap * 2;
  let start = Math.min(Math.max(0, input.start), n - 1);
  if (activeIndex >= 0 && activeIndex < start) start = activeIndex;

  let count = fitsFrom(widths, start, room, gap);
  // Slide the window forward until the active tab is inside it. Bounded by
  // n: each step advances `start`, and start === activeIndex ends it.
  while (count > 0 && activeIndex >= 0 && activeIndex >= start + count && start < activeIndex) {
    start += 1;
    count = fitsFrom(widths, start, room, gap);
  }

  return {
    start,
    count,
    activeVisible:
      count > 0 && activeIndex >= start && activeIndex < start + count,
  };
}
