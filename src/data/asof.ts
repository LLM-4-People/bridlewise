/**
 * THE GLOBAL `asOf` — one owner for "which instant am I looking at".
 *
 * DESIGN-COCKPIT-V2.md §6.2: clicking the sweep's head "plants the head and
 * sets global `asOf` — every asOf-reactive surface renders its state at that
 * instant". Before this module the head existed and the server's ranged-read
 * `until` parameter existed, and NOTHING joined them: the banner said
 * `viewing 16:00:53` while every surface kept showing now. A flight recorder
 * you can move that the world ignores is decoration, and — worse — a screen
 * that says one time and shows another is the fabrication this project bans.
 *
 * WHY THE OWNER LIVES IN THE DATA LAYER AND NOT IN THE SWEEP
 *
 * The head is planted by the SWEEP, but it is consumed by every read. The
 * Broker is the one door client I/O goes through, so the Broker must be able
 * to read the head SYNCHRONOUSLY on every call; that makes the head a
 * data-layer fact that a cockpit surface happens to write, not a sweep fact
 * the data layer borrows. Owning it here also keeps the dependency arrow
 * pointing one way (`src/cockpit/**` → `src/lib/**`, never back), which is
 * what lets a NEW surface become time-travel-capable without wiring anything:
 * it reads through the Broker, so it already carries `until`.
 *
 * `src/cockpit/sweep/sweep-store.ts` re-exports `sweepHead` from here rather
 * than declaring a second atom. There is exactly ONE atom; two would be two
 * opinions about what time it is, and the day they disagreed the screen would
 * be lying with a straight face.
 *
 * WHAT A PLANTED HEAD MEANS, MECHANICALLY
 *
 *   1. every Broker read carries `until=<head>` — bounding what is READ;
 *   2. a block that cannot answer for a past instant REFUSES, loudly, so no
 *      surface can dress live data as past data (§ the three-way split
 *      below);
 *   3. no write is possible: `broker.action()` refuses while a head stands.
 *
 * Returning to live (`Esc`, or the sweep's `back to now`) clears the head;
 * because `until` is part of every cache key, the live entries were never
 * overwritten and the prior state is simply on screen again.
 *
 * @see src/data/broker.ts — the choke point that applies all three
 * @see server/blocks/define.ts — the `until` convention this mirrors
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { ClientError } from "./errors.ts";

// ── The head ───────────────────────────────────────────────────────────────

/**
 * The planted head, epoch ms, or null for live. THE global `asOf`.
 *
 * Written only through `plantHead`/`returnToLive` (and the sweep's scrub,
 * which goes through them). Read by the Broker on every call and by every
 * surface that renders the past-view grammar.
 */
export const asOfHead = atom<number | null>(null);

/** True while a head is planted — the past-view predicate every surface reads. */
export const isPastView: ReadableAtom<boolean> = computed(
  asOfHead,
  (head) => head !== null,
);

/** Plant the head at an instant (epoch ms). */
export function plantHead(asOfMs: number): void {
  asOfHead.set(asOfMs);
}

/** Return to live. */
export function returnToLive(): void {
  asOfHead.set(null);
}

// ── The three-way block split (§ honest degradation) ───────────────────────

/**
 * Blocks that IMPLEMENT the `until` read parameter (server/blocks/define.ts).
 *
 * Kept as data rather than discovered at runtime because the Broker must
 * decide BEFORE it issues the request: a read that would silently drop
 * `until` must never reach the wire. Drift is impossible to introduce
 * quietly — `tests/prevention/asof-block-split-owner.test.ts` registers the
 * real server blocks and asserts this set is exactly the set whose read
 * input schema declares `until`.
 */
export const RANGED_BLOCKS: ReadonlySet<string> = new Set([
  "sweep.spectrum",
  "tools.breaker",
  "arm.flags",
]);

/**
 * Blocks whose answer CANNOT depend on `asOf`, so serving them unchanged
 * during a past view is honest rather than a silent lie.
 *
 * This list is deliberately tiny and deliberately hard to join. A block
 * qualifies only when its answer is addressed by an IMMUTABLE identity, so
 * "the answer at 16:00:53" and "the answer now" are the same bytes by
 * construction — not merely "unlikely to have changed".
 *
 *   - `lens.ancestry`: entered by a ledger event id or trace id and walked
 *     backwards through `parent_event_id`. Ledger rows are append-only and
 *     immutable once written (the block's own TTL comment says so), so a
 *     chain that has been walked cannot change. Bounding it by `until` would
 *     TRUNCATE a real chain and present the stump as the whole cause — which
 *     would be the fabrication, not the pass-through.
 *
 * Anything not in this set and not in `RANGED_BLOCKS` refuses.
 */
export const TIME_INVARIANT_BLOCKS: ReadonlySet<string> = new Set([
  "lens.ancestry",
]);

/** Typed code for a read a block cannot answer at a past instant. */
export const PAST_VIEW_UNSUPPORTED_CODE = "past_view_unsupported";

/** Typed code for a write attempted while a head is planted. */
export const PAST_VIEW_READ_ONLY_CODE = "past_view_read_only";

/**
 * The sentence a surface shows in place of an instrument that cannot answer
 * for a past instant. One owner (No Scattered Helpers) so twelve surfaces
 * cannot invent twelve stories about the same gap.
 */
export const PAST_VIEW_UNSUPPORTED_SENTENCE =
  "this instrument cannot show a past state";

/** The reason ON every disabled action verb while a head is planted. */
export const PAST_VIEW_ACT_REASON =
  "this is a past view — return to now to act";

/** Whether a block can be read at a past instant at all (ranged or invariant). */
export function blockAnswersInPast(block: string): boolean {
  return RANGED_BLOCKS.has(block) || TIME_INVARIANT_BLOCKS.has(block);
}

/**
 * The read parameters for `block` under the ambient head.
 *
 * Three outcomes, and they are the whole honesty contract:
 *   - live (no head): the caller's params, untouched;
 *   - ranged block: the caller's params PLUS `until` — which lands in the
 *     cache key too, so a past answer can never be served as a live one;
 *   - anything else: THROW. A block that would ignore `until` must not be
 *     asked, because its answer would be now wearing a past timestamp.
 *
 * @throws ClientError `past_view_unsupported`
 */
export function paramsWithAsOf(
  block: string,
  params?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const head = asOfHead.get();
  if (head === null) return params;
  if (RANGED_BLOCKS.has(block)) return { ...params, until: String(head) };
  if (TIME_INVARIANT_BLOCKS.has(block)) return params;
  throw new ClientError(
    PAST_VIEW_UNSUPPORTED_CODE,
    PAST_VIEW_UNSUPPORTED_SENTENCE,
  );
}

/**
 * Refuse a write while a head is planted — called at the Broker's action
 * door, so a surface that forgets to disable its button still cannot write.
 * The UI disabling is the courtesy; this is the guarantee.
 *
 * @throws ClientError `past_view_read_only`
 */
export function assertLiveForWrite(): void {
  if (asOfHead.get() === null) return;
  throw new ClientError(PAST_VIEW_READ_ONLY_CODE, PAST_VIEW_ACT_REASON);
}
