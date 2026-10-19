/**
 * THE THINKING BLOCK'S OPEN/CLOSED STATE — one owner, one rule.
 *
 * ── THE USER'S RULING, VERBATIM ────────────────────────────────────────────
 *
 *   "when chatting with a thinking model, its thinking block is collapsed, i
 *    want its thinking to be expanded from the moment it starts thinking until
 *    it starts producing the real answer"
 *
 * So the default is inverted, and the inversion is TIME-BOUND rather than
 * permanent: while the model is thinking, the thinking is the most interesting
 * thing on screen and it is open; the instant the answer begins, the answer is
 * the most interesting thing and the thinking folds away to make room. It stays
 * reachable afterwards exactly as it was.
 *
 * ── THE THREE STATES, ALL READ FROM THE RECORD ─────────────────────────────
 *
 *   absent  — this beat has no thinking to show. A model that produced no
 *             reasoning gets NO BLOCK AT ALL, not an empty one (§1.1: a
 *             surface never shows a fold for content nobody sent).
 *   live    — thinking has arrived, the turn is still streaming, and no answer
 *             token has been received yet. THIS is the auto-open window.
 *   settled — thinking has arrived and either the answer has begun or the turn
 *             is over. Auto-closed.
 *
 * `settled` covers the turn that ended without ever answering (the model
 * thought, then called tools). Nothing here claims "thinking ended" — it
 * claims the TURN ended, which the stream did say (its finish frame is what
 * clears `streaming`). The distinction matters: the fold closes because the
 * live window is over, not because anyone decided the thoughts were complete.
 *
 * ── THE BOUNDARY IS OBSERVED, NEVER INFERRED ───────────────────────────────
 *
 * "The answer began" is `turn.answerStarted`, set by flow/turn-timing.ts on a
 * received `text_delta` frame and by nothing else. The fallback for a turn
 * whose frames this session never saw (a conversation re-read from the
 * database) is `turn.text.length > 0` — which is not a guess either: committed
 * answer text is the answer, recorded. No heuristic on content shape, no
 * timeout, no "it has been quiet for a while". A guessed boundary would be
 * fabricated data.
 *
 * ── AN EXPLICIT USER ACTION ALWAYS WINS, PER BEAT ──────────────────────────
 *
 * The auto rule applies to ONE beat only while the reader has expressed no
 * preference about THAT beat. Collapse the block mid-think and it stays
 * collapsed — the answer starting must not then "un-collapse" it, and nothing
 * may re-expand it. Expand it after the answer arrives and it stays expanded.
 * The preference is keyed by beat id and is never cleared by a state change;
 * only a new conversation clears it.
 *
 * WHY A MODULE MAP AND NOT COMPONENT STATE. The flow is virtualized: a beat's
 * row is destroyed the moment it scrolls out of the window and rebuilt when it
 * comes back. A preference held in the component would be forgotten by
 * scrolling, which the reader would experience as the surface undoing their
 * decision. `fisheye.ts` keeps its manual overrides in a module map for
 * exactly this reason, and this is the same shape.
 *
 * ── THIS AXIS IS NOT THE FISHEYE AXIS ──────────────────────────────────────
 *
 * Deliberately separate, and stated here because conflating them is how the
 * earlier "one click, one outcome" defects happened. The FISHEYE (fisheye.ts)
 * decides a BEAT's manifestation level — full / ghost / tick — from causal
 * distance, and it compresses nothing until the reader focuses a beat. THIS
 * module decides whether one SECTION INSIDE a model turn's bubble is open. The
 * two never read each other and never write each other:
 *
 *   - the fisheye pins every turn to `full` (`renderedLevel`), so a turn has
 *     no compression control at all (`compressesInFlow("turn") === false`) —
 *     there is no grip for this fold to be confused with;
 *   - `setThinkingFold` never calls `setOverride`, and `← →` (the fisheye
 *     chords) never reach this state.
 *
 * The only place they meet is the height index's shape stamp, which must name
 * BOTH (Flow.svelte `shapeOf`) because both change how many pixels the row
 * paints — and a stamp that named only one would let the virtualizer reserve
 * the height of a shape it is no longer drawing.
 */

import { atom } from "nanostores";

import { registerReset } from "../../state/store-registry.ts";
import type { Beat, TurnBody } from "./types.ts";

export type ThinkingState = "absent" | "live" | "settled";

/** The thinking text this turn carries, or "" — never a stand-in. */
export function thinkingTextOf(beat: Beat): string {
  if (beat.kind !== "turn") return "";
  return beat.turn?.reasoning ?? "";
}

/**
 * HAS THE ANSWER BEGUN? The observed frame first, the committed record second.
 * Both are facts; there is no third, guessing branch.
 */
export function answerBegun(turn: TurnBody): boolean {
  return turn.answerStarted === true || turn.text.length > 0;
}

/** Where this beat's thinking is in its life, from the beat's own fields. */
export function thinkingState(beat: Beat): ThinkingState {
  if (beat.kind !== "turn") return "absent";
  const turn = beat.turn;
  if (turn === undefined || turn.who !== "model") return "absent";
  if ((turn.reasoning ?? "").length === 0) return "absent";
  if (answerBegun(turn)) return "settled";
  return turn.streaming ? "live" : "settled";
}

/** What the block does when the reader has said nothing about it. */
export function autoOpen(beat: Beat): boolean {
  return thinkingState(beat) === "live";
}

// ── The reader's own decision ──────────────────────────────────────────────

const preferences = new Map<string, boolean>();

/**
 * Bumped whenever a preference changes, so Svelte consumers re-derive. The
 * MAP is the state; this atom is only its change signal — the same split the
 * flow log uses (a plain module array plus `logVersion`), and for the same
 * reason: the map must not become a reactive proxy.
 */
export const thinkingFoldVersion = atom<number>(0);

/** The reader's decision about ONE beat's block, or undefined if they have
 * expressed none. */
export function thinkingFoldPreference(beatId: string): boolean | undefined {
  return preferences.get(beatId);
}

/** Record the reader's decision. It outlives every automatic transition. */
export function setThinkingFold(beatId: string, open: boolean): void {
  if (preferences.get(beatId) === open) return;
  preferences.set(beatId, open);
  thinkingFoldVersion.set(thinkingFoldVersion.get() + 1);
}

/** IS THIS BEAT'S THINKING BLOCK OPEN? Preference wins; otherwise the auto
 * rule. One implementation, so the renderer and the height index cannot
 * disagree about what is on screen. */
export function thinkingOpen(beat: Beat): boolean {
  const stated = preferences.get(beat.id);
  return stated ?? autoOpen(beat);
}

/** Forget every preference (a chat switch, a test). */
export function resetThinkingFolds(): void {
  if (preferences.size === 0) return;
  preferences.clear();
  thinkingFoldVersion.set(thinkingFoldVersion.get() + 1);
}

registerReset("flow-thinking-fold", resetThinkingFolds);
