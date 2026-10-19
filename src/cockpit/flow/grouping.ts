/**
 * COCKPIT FLOW — CONSECUTIVE TOOL CALLS READ AS ONE ACT OF WORK.
 *
 * THE USER'S REQUIREMENT, VERBATIM: "multiple tool calls in a row should be
 * batched and shown together".
 *
 * When the model reads three files and then runs a command, that is ONE thing
 * it did, with four parts. The flow rendered it as four separate cards
 * stacked down the column, which is four units in the reading rhythm for one
 * unit of meaning — and, collapsed, four rows of vertical budget where one
 * would do.
 *
 * ── WHERE A GROUP ENDS, AND WHY THAT IS THE WHOLE DESIGN ──────────────────
 *
 * A group is a maximal run of ADJACENT `tool` beats and nothing else. It ends
 * at the first beat of any other kind — a prose turn, a file effect, a check
 * delta, a finding, a harness event, an operator intervention, a seam.
 *
 * That boundary is not an implementation convenience; it is the point. Those
 * beats are exactly the ones that explain WHY the next batch of calls
 * happened: the model said what it was about to do, a file changed, a check
 * tripped, you muted a channel. Swallowing them into a group would destroy
 * the causal reading the flow exists for. So the rule is stated once, here,
 * and the renderer never re-decides it.
 *
 * ── IDENTITY IS THE FIRST MEMBER, AND THAT IS LOAD-BEARING ────────────────
 *
 * An earlier generation of this UI keyed a group by the JOINED IDS of its
 * members. Every call that arrived changed the key, which destroyed the
 * group's DOM and remounted every child — expansion state lost, timers
 * restarted, and (here) the virtualizer forced to re-measure a row that had
 * not actually changed height. A group's identity is therefore its FIRST
 * member's id, which is stable for the group's whole life: calls appending to
 * the end never change it.
 *
 * This module is PURE and index-based so it can be tested without a DOM and
 * consulted from the window projection without allocating per frame.
 */

import type { Beat } from "./types.ts";
import { beatState, type BeatState } from "./beat-state.ts";

/** Where one beat sits inside its batch of consecutive tool calls. */
export type GroupPlace = Readonly<{
  /** Stable for the group's whole life: the FIRST member's beat id. */
  groupId: string;
  /** 0-based position of this beat within the group. */
  position: number;
  /** How many calls the group holds, counted from the record. */
  size: number;
  /** True for the first member — the one that draws the group's cap. */
  first: boolean;
  /** True for the last member — the one that closes the container. */
  last: boolean;
  /**
   * The group's WORST member state, so the batch is legible at rest as a
   * batch. A mixed group must never read as clean: if any call failed the
   * group reads failed, if any is still running it reads live, and only a
   * group where every call settled reads as a success.
   */
  worst: BeatState;
  /** How many members are in the worst state — "3 calls · 1 failed". */
  worstCount: number;
  /**
   * The tool every member called, when they all called the same one.
   *
   * IDENTITY SURVIVES COMPRESSION, at the group level too. A cap reading
   * "10 tool calls · all done" names a COUNT and an OUTCOME and never says
   * what was done — the same defect as a compressed member that renders a
   * bare checkmark. When the run is ten reads of ten files, saying "10 ×
   * read file" costs one word and answers the reader's actual question.
   * Null when the members disagree, because a batch of mixed tools has no
   * single true name and inventing one would be a fabrication (§1.1).
   */
  sameTool: string | null;
}>;

/** A single tool call standing on its own is NOT a group (§: one is one). */
const MIN_GROUP = 2;

/**
 * Rank of a state for "worst wins". `alarm` beats everything because a
 * failure is the fact a reader must not miss; `working` outranks the settled
 * states because a batch still in flight is not yet a result.
 */
const SEVERITY: Readonly<Record<BeatState, number>> = Object.freeze({
  alarm: 4,
  warn: 3,
  working: 2,
  ok: 1,
  neutral: 0,
});

/** The label every member shares, or null when they do not share one. */
function sameToolOf(members: readonly Beat[]): string | null {
  const first = members[0]?.tool?.label;
  if (first === undefined || first.length === 0) return null;
  return members.every((b) => b.tool?.label === first) ? first : null;
}

function worstOf(members: readonly Beat[]): Readonly<{ worst: BeatState; worstCount: number }> {
  let worst: BeatState = "neutral";
  for (const beat of members) {
    const state = beatState(beat);
    if (SEVERITY[state] > SEVERITY[worst]) worst = state;
  }
  const worstCount = members.filter((b) => beatState(b) === worst).length;
  return { worst, worstCount };
}

/**
 * Group placements for a CONTIGUOUS slice of the log, keyed by beat id.
 *
 * The slice must be contiguous and must start at `sliceStart` in the log,
 * because a group's boundaries depend on the beats on either side of the
 * window: a caller that grouped only what is on screen would split one batch
 * into two whenever the viewport happened to cut through it. Callers pass a
 * slice already widened by their overscan, and `lookBehind`/`lookAhead` state
 * whether the run is known to continue past each edge.
 *
 * Beats that are not in a group of at least MIN_GROUP simply do not appear in
 * the map — absence means "this beat stands alone", which needs no record.
 */
export function groupPlacements(
  slice: readonly Beat[],
): ReadonlyMap<string, GroupPlace> {
  const out = new Map<string, GroupPlace>();
  let runStart = 0;
  const flush = (endExclusive: number): void => {
    const members = slice.slice(runStart, endExclusive);
    if (members.length < MIN_GROUP) return;
    const groupId = members[0]!.id;
    const { worst, worstCount } = worstOf(members);
    const sameTool = sameToolOf(members);
    members.forEach((beat, i) => {
      out.set(beat.id, {
        groupId,
        position: i,
        size: members.length,
        first: i === 0,
        last: i === members.length - 1,
        worst,
        worstCount,
        sameTool,
      });
    });
  };
  for (let i = 0; i <= slice.length; i += 1) {
    const beat = slice[i];
    if (beat !== undefined && beat.kind === "tool") continue;
    // A non-tool beat (or the end of the slice) closes whatever run was open.
    flush(i);
    runStart = i + 1;
  }
  return out;
}

/**
 * Plain-words summary of a batch — what it says at rest, as a batch.
 *
 * Zero-knowledge language (§1.1): "3 tool calls · 1 failed", never "3/1" and
 * never a bare count that hides the outcome. The worst state is named in the
 * same words the status marks use, so the group and its members cannot
 * describe the same fact differently.
 */
export function groupSummary(place: GroupPlace): string {
  // WHAT was done, not just how much of it. `10 × read file` answers the
  // reader's question; `10 tool calls` only tells them how many questions
  // they still have. A batch of mixed tools keeps the honest plural — there
  // is no single name for it and one must not be invented.
  const calls = place.sameTool === null
    ? `${place.size} tool calls`
    : `${place.size} × ${place.sameTool}`;
  switch (place.worst) {
    case "alarm":
      return `${calls} · ${place.worstCount} failed`;
    case "warn":
      return `${calls} · ${place.worstCount} to check`;
    case "working":
      return `${calls} · ${place.worstCount} working`;
    case "ok":
      return `${calls} · all done`;
    case "neutral":
      return calls;
  }
}
