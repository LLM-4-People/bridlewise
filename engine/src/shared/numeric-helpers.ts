import { InputError } from "../kernel/errors.ts";

export function round(n: number, d: number): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Round `n` to `d` decimal places, preserving non-finite values (NaN,
 * Infinity) AS-IS instead of returning 0.
 *
 * This is the "display" variant of {@link round}: it is used when the
 * caller needs to SHOW the value (e.g. in a delta line
 * `before → after (change)`) and hiding a `NaN` as `0` would mask the
 * signal. The conservative {@link round} returns `0` for non-finite so
 * an NaN-tainted computation does not propagate; this variant returns the
 * raw non-finite value so the display reflects reality.
 *
 * R44: this is the canonical owner for the "round but keep non-finite"
 * semantic that was previously a private near-duplicate body in
 * `src/awareness/delta.ts:197` (`round` — same name, different
 * non-finite policy, "No Scattered Helpers" violation). The display
 * variant is now named `roundKeepNonFinite` to distinguish it from the
 * conservative {@link round}.
 */
export function roundKeepNonFinite(n: number, d: number): number {
  if (!Number.isFinite(n)) return n;
  if (d === 0) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The value at `fraction` through a PRE-SORTED ascending array.
 *
 * ── THE UNIT IS THE WHOLE DEFECT ──────────────────────────────────────────
 *
 * `fraction` is 0..1, NOT 0..100. The old signature took the same `number`
 * and said nothing, so `percentile(xs, 50)` computed
 * `floor(50 * length)`, clamped it to the last index, and returned THE
 * MAXIMUM — a plausible number, in the right units, from the right array, and
 * wrong. Nothing could have caught it: a maximum looks exactly like a large
 * percentile.
 *
 * Three functions in these two repositories were called "percentile" and
 * disagreed: this one takes a fraction, `bench/lib/stats.ts` in the web tree
 * takes a PERCENT and returns NaN on empty, and `stats.ts::percentileOf` is
 * the INVERSE (a value in, a percentile out). Three contracts behind one word
 * is a defect that only shows up in the answer.
 *
 * So the unit is now enforced rather than documented: a fraction outside
 * [0, 1] is a refusal. `percentile(xs, 50)` throws, which is the loudest
 * available answer short of the type system, and the type system cannot
 * express "a real between 0 and 1".
 *
 * An EMPTY array is also a refusal. The old zero was an unmeasured quantity
 * reported as a measurement, and zero is a legitimate value for most of the
 * things this is called on, so nobody downstream could tell the difference.
 *
 * The rank rule is `floor(fraction * n)` clamped to the last index — nearest
 * rank, no interpolation, so the result is always a value that was actually
 * observed. This is the SINGLE owner: `computePercentiles` in
 * `src/performance/benchmark-runner.ts` used to carry a byte-identical
 * private copy.
 */
export function percentile(sortedAsc: readonly number[], fraction: number): number {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new InputError(
      `percentile expects a fraction between 0 and 1, received ${fraction}. ` +
      "A percent (50, 95, 99) silently returned the maximum; divide by 100.",
    );
  }
  if (sortedAsc.length === 0) {
    throw new InputError(
      "percentile has no samples: an empty distribution has no percentile, and reporting 0 " +
      "would be an unmeasured quantity presented as a measurement.",
    );
  }
  const index = Math.min(sortedAsc.length - 1, Math.floor(fraction * sortedAsc.length));
  return sortedAsc[index]!;
}
