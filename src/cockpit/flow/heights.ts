/**
 * COCKPIT FLOW — the height index (spec §3.8, the Warp SumTree approach).
 *
 * The virtualizer indexes beats by MEASURED height and treats their contents
 * as opaque. This is a Fenwick (binary indexed) tree over per-beat heights:
 *
 *   - update(i, h)        O(log n) — record a measurement
 *   - offsetOf(i)         O(log n) — pixel offset of beat i's top
 *   - indexAtOffset(y)    O(log n) — which beat contains pixel y
 *   - totalHeight()       O(1)
 *
 * Un-measured beats carry an ESTIMATE height until their DOM measures once;
 * the estimate is replaced by the measurement (never averaged, never faked as
 * final — it exists only so scrollbar geometry is defined before first paint,
 * and the measured value overwrites it within one frame of mounting).
 *
 * ── A MEASUREMENT IS ONLY VALID FOR THE SHAPE IT MEASURED ─────────────────
 *
 * A beat does not have "a height". It has a height AT A RENDERED LEVEL: the
 * same tool call is a 613px card at `full`, a 26px line at `ghost`, a 16px
 * mark at `tick`, and 0px when the flow draws it at all (a hidden empty
 * turn). The index is therefore keyed by height AND by a STAMP naming the
 * shape that height was measured for.
 *
 * Without the stamp the index cannot tell a stale measurement from a current
 * one, and the flow reserves the height of a level it is no longer drawing —
 * which is exactly the defect this file's caller shipped: 56px of empty space
 * reserved under every beat that had folded away to nothing. The stamp makes
 * "the level changed" a fact the index can act on rather than a fact only the
 * DOM knows.
 *
 * The stamp's VALUES are the renderer's business (Flow.svelte owns them);
 * this class only requires that two different shapes never share one.
 */

/**
 * THE HEIGHT A SHAPE DECLARES, before anything measures it.
 *
 * Same pattern the artifact frame already uses (render/artifact.ts): a frame
 * declares its height from the artifact's KIND and never derives it from the
 * content, so the flow's height index cannot be corrupted after measurement.
 * Here the "kind" is the beat's rendered SHAPE.
 *
 *   none  — EXACT, not an estimate. A beat the flow does not draw emits no
 *           element, occupies no row and has no height. This is the one entry
 *           that is a fact rather than a starting point.
 *   tick  — --beat-tick-h (12) + 2 × --beat-pad-collapsed (2).
 *   ghost — --beat-ghost-h (22) + 2 × --beat-pad-collapsed (2).
 *   full  — a full beat's height IS its content, so there is nothing to
 *           declare; this is the same generic estimate the index has always
 *           used, and the ResizeObserver replaces it within a frame.
 *
 * The three collapsed numbers restate tokens.css, which is a real (small)
 * duplication: CSS cannot be imported into TypeScript, and the alternative —
 * reading getComputedStyle at module load — would make the index depend on a
 * document that does not exist under test. They are STARTING POINTS that the
 * measurement overwrites, so a drift costs one frame of scrollbar error and
 * nothing else; `flow-height-geometry.spec.ts` measures the real numbers in a
 * real browser and fails if reserved and rendered ever disagree.
 */
export const SHAPE_HEIGHT: Readonly<Record<string, number>> = Object.freeze({
  none: 0,
  tick: 16,
  ghost: 26,
  full: 56,
});

/** The default estimate for an un-measured, un-stamped beat. */
export const DEFAULT_ESTIMATE = SHAPE_HEIGHT["full"]!;

export class HeightIndex {
  /** Smallest tree worth allocating. */
  private static readonly MIN_CAPACITY = 16;
  /** Fenwick tree, 1-based. tree[i] holds a partial sum. */
  private tree: Float64Array;
  /** Current per-index height (estimate or measured). */
  private heights: Float64Array;
  private measured: Uint8Array;
  /** The shape each recorded height was recorded FOR; null = never stamped.
   * A plain array: it is read once per mounted row, never in the O(log n)
   * hot paths, and it holds strings the renderer owns. */
  private stamps: (string | null)[] = [];
  private size = 0;
  private capacity: number;
  private searchBit: number;
  private total = 0;
  private readonly estimate: number;

  constructor(estimate = 40, initialCapacity = HeightIndex.MIN_CAPACITY * 64) {
    this.estimate = estimate;
    this.capacity = Math.max(HeightIndex.MIN_CAPACITY, initialCapacity);
    this.searchBit = 2 ** Math.floor(Math.log2(this.capacity));
    this.tree = new Float64Array(this.capacity + 1);
    this.heights = new Float64Array(this.capacity);
    this.measured = new Uint8Array(this.capacity);
  }

  get length(): number {
    return this.size;
  }

  /** Append n new items at the estimate height. */
  append(n = 1): void {
    if (n > this.size) {
      const end = this.size + n;
      this.reserve(end);
      this.heights.fill(this.estimate, this.size, end);
      this.measured.fill(0, this.size, end);
      this.stamps.length = end;
      this.stamps.fill(null, this.size, end);
      this.size = end;
      this.rebuild();
      return;
    }
    for (let k = 0; k < n; k += 1) {
      if (this.size === this.capacity) this.grow();
      const i = this.size;
      this.size += 1;
      this.heights[i] = this.estimate;
      this.measured[i] = 0;
      this.stamps[i] = null;
      this.add(i, this.estimate);
    }
  }

  /**
   * Record a height for item i, for the shape named by `stamp`.
   *
   * ZERO IS A HEIGHT. This used to be rejected by its caller ("h > 0"), on
   * the reasonable-sounding view that a 0 reading means "not laid out yet".
   * It does not: a beat the flow deliberately draws as nothing — a hidden
   * empty turn — measures 0 and IS 0, and refusing the reading left the
   * index reserving the un-measured estimate for a row that paints no
   * pixels. That reservation is the empty vertical space the user reported.
   * A caller that wants to ignore a reading must decide that itself; this
   * class records what it is told.
   *
   * Returns the delta applied.
   */
  update(i: number, height: number, stamp: string | null = null): number {
    if (i < 0 || i >= this.size) return 0;
    if (stamp !== null) this.stamps[i] = stamp;
    const delta = height - this.heights[i]!;
    if (delta === 0) {
      this.measured[i] = 1;
      return 0;
    }
    this.heights[i] = height;
    this.measured[i] = 1;
    this.add(i, delta);
    return delta;
  }

  isMeasured(i: number): boolean {
    return this.measured[i] === 1;
  }

  /** The shape item i's recorded height was recorded for, or null. */
  stampOf(i: number): string | null {
    return i >= 0 && i < this.size ? (this.stamps[i] ?? null) : null;
  }

  heightOf(i: number): number {
    return i >= 0 && i < this.size ? this.heights[i]! : 0;
  }

  /** Pixel offset of item i's top edge. */
  offsetOf(i: number): number {
    if (i <= 0) return 0;
    if (i >= this.size) return this.total;
    const n = Math.min(i, this.size);
    // prefix sum of [0, n)
    let sum = 0;
    for (let j = n; j > 0; j -= j & -j) sum += this.tree[j]!;
    return sum;
  }

  totalHeight(): number {
    return this.total;
  }

  /**
   * Index of the item containing pixel offset y (0 ≤ result < length).
   * y below 0 clamps to 0; y past the end clamps to the last item.
   */
  indexAtOffset(y: number): number {
    if (this.size === 0) return 0;
    if (y <= 0) return 0;
    // Standard Fenwick binary search for the smallest index whose prefix sum
    // exceeds y.
    let pos = 0;
    let rem = y;
    let pw = this.searchBit;
    for (; pw > 0; pw >>= 1) {
      const next = pos + pw;
      if (next <= this.capacity && this.tree[next]! <= rem) {
        pos = next;
        rem -= this.tree[next]!;
      }
    }
    // pos = count of items fully above y
    return Math.min(pos, this.size - 1);
  }

  /**
   * INSERT n UN-MEASURED ITEMS AT THE FRONT — a page of older beats arrived.
   *
   * The index is measurements BY POSITION, and a conversation that opens at
   * its tail grows at BOTH ends: new beats append, older pages prepend. Every
   * measurement already taken belongs to a row that has just moved down by
   * exactly n, so this is a shift, not an append at the other end.
   *
   * THE MEASUREMENTS ARE CARRIED, NOT DISCARDED, and that is the whole point:
   * dropping them would put every already-drawn row back at the estimate, the
   * document would change height under the reader by the difference, and the
   * scroll compensation the caller applies would be computed against a
   * geometry that no longer exists. What the reader has already looked at must
   * still be exactly as tall as it was.
   *
   * Shift the measured values in place, then build partial sums in one
   * linear pass. Replaying every retained point through update would walk
   * the same ancestor paths repeatedly.
   */
  prepend(n: number): void {
    if (n <= 0) return;
    const end = this.size + n;
    this.reserve(end);
    this.heights.copyWithin(n, 0, this.size);
    this.measured.copyWithin(n, 0, this.size);
    this.stamps.length = end;
    this.stamps.copyWithin(n, 0, this.size);
    this.heights.fill(this.estimate, 0, n);
    this.measured.fill(0, 0, n);
    this.stamps.fill(null, 0, n);
    this.size = end;
    this.rebuild();
  }

  /** Truncate to n items (log cleared / re-synced). */
  truncate(n: number): void {
    if (n >= this.size) return;
    this.heights.fill(0, n, this.size);
    this.measured.fill(0, n, this.size);
    this.size = n;
    this.stamps.length = n;
    // Release capacity after a large conversation is retired. A small
    // truncation retains the allocation to avoid resize churn.
    if (n < this.capacity / 4) {
      this.resize(Math.max(HeightIndex.MIN_CAPACITY, 2 ** Math.ceil(Math.log2(Math.max(1, n)))));
    }
    this.rebuild();
  }

  private add(i: number, delta: number): void {
    this.total += delta;
    for (let j = i + 1; j <= this.capacity; j += j & -j) {
      this.tree[j] = this.tree[j]! + delta;
    }
  }

  private grow(): void {
    this.resize(this.capacity * 2);
    this.rebuild();
  }

  private reserve(size: number): void {
    if (size <= this.capacity) return;
    let next = this.capacity;
    while (next < size) next *= 2;
    this.resize(next);
  }

  private resize(nextCapacity: number): void {
    const nextHeights = new Float64Array(nextCapacity);
    nextHeights.set(this.heights.subarray(0, this.size));
    const nextMeasured = new Uint8Array(nextCapacity);
    nextMeasured.set(this.measured.subarray(0, this.size));
    this.capacity = nextCapacity;
    this.searchBit = 2 ** Math.floor(Math.log2(nextCapacity));
    this.heights = nextHeights;
    this.measured = nextMeasured;
    this.tree = new Float64Array(nextCapacity + 1);
  }

  /** Each partial sum contributes to its parent once, including allocated
   * ancestors above length: later append operations need those sums. */
  private rebuild(): void {
    this.tree.fill(0);
    this.total = 0;
    for (let i = 1; i <= this.capacity; i += 1) {
      const height = i <= this.size ? this.heights[i - 1]! : 0;
      this.total += height;
      this.tree[i] = this.tree[i]! + height;
      const parent = i + (i & -i);
      if (parent <= this.capacity) this.tree[parent] = this.tree[parent]! + this.tree[i]!;
    }
  }
}
