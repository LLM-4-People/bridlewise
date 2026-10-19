/**
 * HOLDING THE READER'S PLACE WHEN THE SHELL CHANGES HEIGHT.
 *
 * The tab strip appears the moment a second workspace exists and disappears
 * when the second one closes. Either way the FLOW's box gets shorter or
 * taller by the strip's height — and a browser keeps `scrollTop` across a
 * viewport resize, which means the content the user was reading moves by
 * exactly that many pixels. In a conversation, where the interesting end is
 * the BOTTOM, that reads as the transcript jumping.
 *
 * So the distance from the bottom is captured before the change and restored
 * after it. Bottom rather than top because that is what a conversation is
 * anchored to; a reader at the newest beat stays at the newest beat, and a
 * reader parked in the middle keeps the same beat under the same pixel row
 * as long as nothing above them changed height (nothing does — only the
 * viewport moved).
 *
 * FOUND BY SHAPE, NOT BY NAME. The scroller is located as "the scrollable
 * element inside the flow region", never by a class the flow owns. The flow
 * is another agent's surface; a shell that reached in by class name would
 * break the first time they renamed one, silently, and in a way no type
 * checker would notice.
 *
 * Guard: tests/cockpit/workspace-strip.test.ts § "the flow keeps its place".
 */

/** The scrollable descendant of `root` (depth-first, first match), or null. */
export function findScroller(root: Element | null): HTMLElement | null {
  if (root === null) return null;
  const queue: Element[] = [root];
  while (queue.length > 0) {
    const el = queue.shift()!;
    if (el instanceof HTMLElement && isScrollable(el)) return el;
    queue.push(...Array.from(el.children));
  }
  return null;
}

function isScrollable(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight) return false;
  // jsdom reports no computed overflow; the height difference alone is the
  // evidence there, and in a browser it is the overflow that makes it real.
  const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  if (style === null) return true;
  return style.overflowY === "auto" || style.overflowY === "scroll" || style.overflow === "auto";
}

/**
 * Capture the flow's distance from the bottom; the returned function puts it
 * back. Safe to call when there is no scroller (boot, a failed outlet): it
 * returns a no-op rather than guessing at a position.
 */
export function holdFlowAnchor(region: Element | null): () => void {
  const el = findScroller(region);
  if (el === null) return () => undefined;
  const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  return () => {
    const next = el.scrollHeight - el.clientHeight - fromBottom;
    el.scrollTop = Math.max(0, next);
  };
}
