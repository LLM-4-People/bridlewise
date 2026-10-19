/**
 * COCKPIT FLOW — causal fisheye (spec §3.2).
 *
 * Beats collapse with causal distance from the focused beat:
 *   full beat → one-line ghost → tick in the gutter.
 *
 * The degree-of-interest function is EXPLAINABLE FROM THE RECORD: its three
 * terms are causal distance (turns between the beat and the focus, plus
 * chain distance through parentage), recency (how far from the newest beat),
 * and abnormality (the beat's own declared abnormal state). No geometric
 * distortion — only representation change. Every compressed beat states its
 * reason on focus; `reason` is computed here, with the DOI, from the same
 * inputs — unexplained salience is a bug (§1.5 F1).
 *
 * Manual override wins over automatic for the session (§1.5 F3): overrides
 * live in a per-session map keyed by beat id and are consulted first.
 */

import type { Beat } from "./types.ts";

/**
 * The compression ladder, coarsest last. THE ARRAY IS THE OWNER and the type
 * is derived from it, so there is no second place a level can be declared.
 *
 * This matters because the guard over the ladder listed the three levels BY
 * HAND while its own comment claimed it was "DYNAMIC over the level list, so
 * a level added tomorrow cannot quietly omit identity". It was not: a
 * hand-written `readonly FisheyeLevel[]` accepts any SUBSET of the union, so
 * a fourth level would have been added to the type, compiled silently, and
 * never once been rendered by the test that exists to prove every level still
 * names the call. Exporting the vocabulary lets that guard consume it instead
 * of restating it.
 */
export const FISHEYE_LEVELS = ["full", "ghost", "tick"] as const;

export type FisheyeLevel = typeof FISHEYE_LEVELS[number];

export type FisheyeResult = Readonly<{
  level: FisheyeLevel;
  /** Plain-words reason, stated on focus ("collapsed: 3 turns old, no effects"). */
  reason: string;
}>;

export type FisheyeInput = Readonly<{
  beat: Beat;
  /**
   * Turn index of the focused beat, or NULL when the reader has not focused
   * anything yet — which is the state every conversation opens in.
   *
   * THE DEFECT THIS NULL EXISTS TO REMOVE. The caller used to substitute the
   * LAST beat for an absent focus. That looks harmless and is not: with the
   * focus pinned to the tail, `causalDistance` and `recency` become the same
   * number, the three-term DOI degenerates into a pure age ramp, and every
   * beat more than three turns old renders as a ghost or a tick before the
   * reader has expressed any interest at all. Scroll up and the whole
   * scrollback is compressed. Reported, verbatim: "they show ultra collapsed
   * until we click on them, then they show normally, if we click on them
   * again, then they show expanded."
   *
   * The fisheye compresses AROUND A FOCUS. With no focus there is nothing to
   * compress around, and the honest answer is to compress nothing.
   */
  focusTurnIndex: number | null;
  /** True when the beat is on the focused beat's causal chain (§6.5). */
  onFocusChain: boolean;
  /** Turn index of the newest beat in the log (recency anchor). */
  latestTurnIndex: number;
  /** Session override for this beat, when the user chose manually (←/→). */
  override?: "expand" | "collapse";
}>;

/**
 * Pure DOI. Deterministic, testable, and honest: the returned reason names
 * the exact terms that produced the level.
 */
export function fisheyeLevel(input: FisheyeInput): FisheyeResult {
  const { beat, focusTurnIndex, onFocusChain, latestTurnIndex, override } = input;

  // Manual choice beats computed choice, and says so.
  if (override === "expand") {
    return { level: "full", reason: "expanded: you expanded it (manual choice wins for the session)" };
  }
  if (override === "collapse") {
    return { level: "tick", reason: "collapsed: you collapsed it (manual choice wins for the session)" };
  }

  // NOTHING FOCUSED, NOTHING COMPRESSED. Placed after the manual override so
  // a beat the reader deliberately collapsed stays collapsed, and before
  // every computed rule so none of the ramp is touched: the instant a beat is
  // focused, §3.2's fisheye behaves exactly as specified.
  if (focusTurnIndex === null) {
    return {
      level: "full",
      reason:
        "expanded: nothing is focused yet — the fisheye compresses around what " +
        "you are reading, and you have not said what that is",
    };
  }

  const causalDistance = Math.abs(beat.turnIndex - focusTurnIndex);
  const recency = latestTurnIndex - beat.turnIndex;

  // ABNORMALITY RESISTS COLLAPSE — urgent cannot fold.
  //
  // This used to hold an abnormal beat at GHOST once it was more than a turn
  // from the focus. That is the wrong trade and the user found it: "everything
  // else that is not a chat is not very visible except when clicking on it."
  // A failure compressed to one line among a column of one-liners is a
  // failure you have to go looking for, and the whole point of recording it
  // is that you should not have to. An abnormal fact earns its pixels by its
  // own declared state (§1.2) — the field already refuses to fold what is
  // urgent, and this is that rule applied to the flow.
  //
  // The cost is bounded by the thing itself: abnormal beats are rare, and if
  // they are not rare then a flow full of them is the honest picture.
  //
  // ── HOW THIS RECONCILES WITH SYMMETRIC DETAIL ────────────────────────────
  //
  // A sibling rule (ToolBeat.svelte) says a success and a failure must render
  // the SAME anatomy — "success and error tool call should carry the same
  // amount of details". Read carelessly the two rules collide: this one keeps
  // a failure bigger than a success.
  //
  // They do not collide, because they answer different questions:
  //
  //   THIS function decides WHICH LEVEL a beat is held at — how much of the
  //   reader's attention the fact is worth. That is PROMINENCE, and it is
  //   allowed to depend on outcome. Abnormality is exactly the kind of fact a
  //   degree-of-interest function exists to raise.
  //
  //   The RENDERER decides what a level SHOWS. That is ANATOMY, and it may
  //   never depend on outcome: whatever `full` shows for a success it shows
  //   for a failure, and the same for `ghost` and for `tick`, with the failing
  //   content in place of the succeeding content.
  //
  // So a failure may sit at `full` beside a success that ghosted — and if the
  // reader collapses it (the manual override above, which still wins), it
  // becomes a ghost with a ghost's exact anatomy, its state still legible in
  // the status mark every ghost carries. Prominence differs; shape does not.
  if (beat.abnormal) {
    if (causalDistance === 0 || onFocusChain) {
      return { level: "full", reason: "expanded: abnormal state in the focused turn" };
    }
    return {
      level: "full",
      reason: `expanded: abnormal state ${turnsAway(causalDistance)} from your focus — abnormality is never compressed`,
    };
  }

  // The focused turn and everything on its causal chain render full.
  if (causalDistance === 0) {
    return { level: "full", reason: "expanded: it is in the turn you are focused on" };
  }
  if (onFocusChain) {
    return { level: "full", reason: "expanded: it is on the causal chain of the beat you are focused on" };
  }

  // ONE TURN AWAY IS STILL THE THING YOU ARE READING.
  //
  // This band used to hold prose full and compress INSTRUMENTS to a ghost,
  // and it was the single most-felt defect in the fisheye: a reader looking
  // at a turn saw the model's words but only a one-line trace of the tool
  // calls that turn actually made — reported as "tool calls no longer show
  // properly". Two facts settle it:
  //
  //   - the DOI's job is to compress with causal DISTANCE, and one turn is
  //     not distance. The immediately adjacent turn is inside the reading
  //     window, not in the periphery;
  //   - the fisheye's saving here is small. A ghost costs about one line
  //     (--beat-ghost-h), so ghosting an adjacent tool call buys tens of
  //     pixels and costs the reader the whole input→output transformation
  //     the recording exists to show. Compression has to pay for itself.
  //
  // Compression therefore starts at distance 2, where the reader has
  // genuinely moved on. Nothing else about the ramp changes.
  if (causalDistance === 1) {
    return { level: "full", reason: "expanded: one turn from your focus" };
  }

  // Recent-but-far: ghosts; old-and-far: ticks.
  if (causalDistance <= 3 || recency <= 1) {
    return {
      level: "ghost",
      reason: `ghost: ${turnsAway(causalDistance)} from your focus, no abnormal state`,
    };
  }

  // ── A TOOL CALL NEVER FALLS BELOW ONE FULL LINE ──────────────────────────
  //
  // THE USER'S REPORT, VERBATIM: "tool call still shows as ultra collapsed,
  // like this, until I click on them."
  //
  // `tick` is not a compressed representation of a tool call — it is the
  // ABSENCE of one. The row it draws is a 12px mark and a status glyph: it
  // states that something happened and that it went well, and throws away
  // every fact the recording exists to hold — which tool, on what target,
  // what came back, how long it took. A reader who has to click to learn any
  // of that is reading a surface that has failed both "we don't care about
  // data if we cannot act on it" and "the user should not fear missing out".
  //
  // The saving does not pay for itself either. A ghosted tool call costs
  // --beat-ghost-h; a ticked one costs --beat-tick-h. Ten pixels a row, for
  // the whole transformation. Compression has to buy something.
  //
  // `tick` is NOT removed — it stays reachable by the MANUAL override at the
  // top of this function, because a reader who deliberately collapses a call
  // has said what they want and manual choice wins for the session (§1.5 F3).
  // What is removed is the AUTOMATIC descent into it: distance may quiet a
  // tool call, it may not silence one.
  //
  // Other kinds keep the tick, and honestly: a check delta, an effect and a
  // harness event are each a SINGLE fact, and their status mark is a fair
  // (if terse) rendering of that one fact. A tool call is a transformation
  // with two sides, and a mark is not a rendering of it at all.
  if (beat.kind === "tool") {
    return {
      level: "ghost",
      reason:
        `ghost: ${turnsAway(causalDistance)} from your focus — a tool call never compresses ` +
        "below one full line",
    };
  }

  return {
    level: "tick",
    reason: `collapsed: ${turnsAway(causalDistance)} from your focus, no abnormal state`,
  };
}

function turnsAway(n: number): string {
  return n === 1 ? "1 turn" : `${n} turns`;
}

/**
 * THE rendered level of a beat — the ONE owner of the "which beats does the
 * fisheye actually compress" rule.
 *
 * Findings and seams are already one line, and TURNS render as bubbles (§3.2:
 * a bubble always shows its full text — no click-to-unwrap). So the fisheye
 * compresses INSTRUMENTAL beats only, keeping the terminal stream dense where
 * chat is not.
 *
 * Both the beat's renderer and the beat MENU (whose expand/collapse row must
 * offer the move the beat is actually able to make) read this function, so
 * the rule cannot be stated twice and drift.
 */
export function renderedLevel(
  kind: string,
  fisheye: FisheyeLevel,
): FisheyeLevel {
  return kind === "seam" || kind === "finding" || kind === "turn" ? "full" : fisheye;
}

/**
 * CAN A COMPRESSION CONTROL DO ANYTHING TO THIS KIND? Derived from
 * `renderedLevel` itself, never restated — if the pin above ever lets a kind
 * through, this answer changes with it and cannot drift.
 *
 * ── WHY THIS FUNCTION EXISTS ──────────────────────────────────────────────
 *
 * THE USER'S REPORT, VERBATIM: "we have collapse under every chat message,
 * but the button does not do anything, so just remove it."
 *
 * They are describing a control that was inert BY CONSTRUCTION, not by
 * accident. `COLLAPSE` on a prose turn wrote a session override, the fisheye
 * honoured it and returned `tick` — and then `renderedLevel` above pinned the
 * turn back to `full`, because a bubble always shows its whole text (§3.2: no
 * click-to-unwrap). Every layer did its job; the outcome was nothing. The
 * grip did not even flip its own label afterwards, so it advertised a second
 * press that would also do nothing.
 *
 * The honest fix is not to special-case "turn" at the call site — that is the
 * same hand-maintained list with a different owner. It is to ask the pin
 * whether it leaves the control any room: a kind whose rendered level is the
 * same at both ends of the ladder has no compression to control, so no
 * control is drawn. Turns, seams and findings answer no today; the moment one
 * of them stops being pinned, its grip returns without anyone remembering to
 * bring it back.
 */
export function compressesInFlow(kind: string): boolean {
  return renderedLevel(kind, "tick") !== renderedLevel(kind, "full");
}

/**
 * The session override map — manual wins for the session (§3.2). Plain module
 * state; consumers re-render off the flow's focus/version signals.
 */
const overrides = new Map<string, "expand" | "collapse">();

export function overrideFor(beatId: string): "expand" | "collapse" | undefined {
  return overrides.get(beatId);
}

/** Cycle: → expands (ghost/tick → full), ← collapses (full → tick). */
export function setOverride(beatId: string, value: "expand" | "collapse"): void {
  overrides.set(beatId, value);
}

export function clearOverride(beatId: string): void {
  overrides.delete(beatId);
}

export function clearAllOverrides(): void {
  overrides.clear();
}
